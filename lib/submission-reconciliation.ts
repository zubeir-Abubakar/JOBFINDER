/**
 * Submission retry safety.
 *
 * A timeout is not a rejection: the employer may have received the application
 * even though no response arrived. This module classifies a prior attempt and
 * decides whether another send is safe. Nothing here sends anything.
 *
 * None of Greenhouse, Lever or Ashby exposes a candidate-side lookup by email
 * or job posting, so an ambiguous attempt cannot be reconciled automatically;
 * it stays blocked for a human or for an employer confirmation.
 */

export type AttemptKind = "timeout" | "network" | "rate_limited" | "server" | "rejected" | "ambiguous" | "none";

export type AttemptDisposition = "confirmed" | "rejected" | "ambiguous" | "none";

export type Reconciliation = {
  action: "send" | "blocked";
  kind: AttemptKind;
  reason: string;
  evidence: Record<string, unknown>;
};

export function classifySubmissionFailure(input: { error?: string | null; httpStatus?: number | null }): {
  kind: AttemptKind;
  retryable: boolean;
  ambiguous: boolean;
  detail: string;
} {
  const error = (input.error ?? "").toLowerCase();
  const status = input.httpStatus ?? null;
  if (/timed? ?out|timeout|etimedout|aborted|aborterror/.test(error)) {
    return {
      kind: "timeout",
      retryable: false,
      ambiguous: true,
      detail: "The request timed out after it may have reached the employer; the outcome is unknown.",
    };
  }
  if (/econnreset|econnrefused|enotfound|network|socket|fetch failed/.test(error)) {
    return {
      kind: "network",
      retryable: false,
      ambiguous: true,
      detail: "The connection failed after the request was created; delivery is unknown.",
    };
  }
  if (status === 408) {
    return { kind: "timeout", retryable: false, ambiguous: true, detail: "The employer endpoint timed out; delivery is unknown." };
  }
  if (status === 429) {
    return { kind: "rate_limited", retryable: false, ambiguous: false, detail: "The endpoint rate-limited the request before accepting it." };
  }
  if (status !== null && status >= 500) {
    return { kind: "server", retryable: false, ambiguous: true, detail: `The endpoint returned HTTP ${status}; the application may or may not have been stored.` };
  }
  if (status !== null && status >= 400) {
    return { kind: "rejected", retryable: false, ambiguous: false, detail: `The endpoint rejected the submission with HTTP ${status}.` };
  }
  return { kind: "ambiguous", retryable: false, ambiguous: true, detail: "The attempt produced no usable response." };
}

export function priorAttemptDisposition(attempt: {
  status: string | null;
  httpStatus: number | null;
  reference: string | null;
  error: string | null;
  reconciliationState?: string | null;
} | null): AttemptDisposition {
  if (!attempt) return "none";
  // Only an explicit reconciliation can authorise a second send. A recorded
  // `not_delivered` outcome is employer/local evidence that the application did
  // not arrive; an owner's unverified claim is never such evidence.
  if (attempt.reconciliationState === "not_delivered") return "none";
  if (attempt.reconciliationState === "confirmed" && attempt.reference) return "confirmed";
  // A channel block or an unread local file never left the machine; it is safe
  // to assemble and queue the package again on a later run.
  if (attempt.status === "blocked" && attempt.httpStatus === null && !attempt.error) return "none";
  if (attempt.status === "failed" && /nothing was sent|could not be read|missing files?/i.test(attempt.error ?? "")) return "none";
  if (attempt.status === "verified" && attempt.reference) return "confirmed";
  if (attempt.status === "unverified") return "ambiguous";
  if (attempt.status === "failed") {
    const classified = classifySubmissionFailure({ error: attempt.error, httpStatus: attempt.httpStatus });
    return classified.ambiguous ? "ambiguous" : "rejected";
  }
  if (attempt.status === "blocked") {
    const classified = classifySubmissionFailure({ error: attempt.error, httpStatus: attempt.httpStatus });
    return classified.kind === "rejected" || classified.kind === "rate_limited" ? "rejected" : "ambiguous";
  }
  return "ambiguous";
}

export function reconciliationDecision(attempt: {
  status: string | null;
  httpStatus: number | null;
  reference: string | null;
  error: string | null;
  reconciliationState?: string | null;
} | null): Reconciliation {
  const disposition = priorAttemptDisposition(attempt);
  if (disposition === "none") {
    return { action: "send", kind: "none", reason: "No prior submission attempt exists for this vacancy.", evidence: {} };
  }
  if (disposition === "confirmed") {
    return {
      action: "blocked",
      kind: "none",
      reason: `A verified application already exists (reference ${attempt?.reference ?? "recorded"}). It is never sent twice.`,
      evidence: { reconciliation: "confirmed", reference: attempt?.reference ?? null },
    };
  }
  if (disposition === "rejected") {
    return {
      action: "blocked",
      kind: "rejected",
      reason: "The previous attempt was rejected by the employer endpoint. It is not retried automatically; the package must be reviewed first.",
      evidence: { reconciliation: "rejected", httpStatus: attempt?.httpStatus ?? null },
    };
  }
  return {
    action: "blocked",
    kind: classifySubmissionFailure({ error: attempt?.error, httpStatus: attempt?.httpStatus }).kind,
    reason:
      "A previous attempt is ambiguous (timeout, transport error or missing reference). Blind retry is refused; confirm with the employer or the ATS before sending again.",
    evidence: {
      reconciliation: "ambiguous",
      priorStatus: attempt?.status ?? null,
      httpStatus: attempt?.httpStatus ?? null,
      error: attempt?.error ?? null,
      candidateLookupAvailable: false,
    },
  };
}
