import { nowIso, one, run } from "./db";
import { recordApplicationEvent } from "./application-events";
import { finishQueueEntry } from "./recruitment-queue";

/**
 * Explicit reconciliation of an uncertain submission outcome.
 *
 * A timeout, a dropped connection, a 200 without a reference or a worker crash
 * all mean the same thing: the employer may already have the application. Such
 * an attempt is never resent blindly. Reconciliation requires evidence:
 *
 * - employer evidence (a reference / confirmation page) verifies the outcome;
 * - an owner attestation records that the owner sent it, but remains
 *   `submitted_unverified` and never becomes employer confirmation;
 * - a positive `not_delivered` finding re-arms the package for a later send;
 * - without evidence the attempt stays uncertain.
 *
 * This module records decisions only. It makes no network request.
 */

export type ReconciliationEvidenceKind =
  | "employer_reference"
  | "employer_confirmation"
  | "owner_attestation"
  | "not_delivered";

export type ReconciliationResolution = {
  state: "confirmed" | "submitted_reference" | "submitted_unverified" | "ready_for_submission" | "unchanged";
  applied: boolean;
  detail: string;
};

type AttemptRow = {
  id: string;
  status: string;
  reference: string | null;
  evidence: string | null;
  reconciliation_state: string | null;
};

function mergeEvidence(existing: string | null, addition: Record<string, unknown>): string {
  let previous: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(existing ?? "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) previous = parsed as Record<string, unknown>;
  } catch {
    previous = { previousEvidence: existing };
  }
  return JSON.stringify({ ...previous, reconciliation: addition }).slice(0, 12000);
}

export function resolveUncertainSubmission(input: {
  applicationId: string;
  kind: ReconciliationEvidenceKind;
  reference?: string | null;
  note?: string | null;
  observedAt?: string;
  actor?: string;
}): ReconciliationResolution {
  const observedAt = input.observedAt ?? nowIso();
  const actor = input.actor ?? "owner";
  const app = one<{
    id: string;
    job_id: string;
    status: string;
    submission_status: string | null;
    submission_state: string | null;
    confirmation: string | null;
  }>(
    "SELECT id, job_id, status, submission_status, submission_state, confirmation FROM applications WHERE id = ?",
    [input.applicationId],
  );
  if (!app) return { state: "unchanged", applied: false, detail: "The application does not exist." };
  if (app.submission_status === "verified" && app.confirmation) {
    return {
      state: "confirmed",
      applied: false,
      detail: "The application already carries verified employer confirmation; nothing was changed.",
    };
  }

  const attempt = one<AttemptRow>(
    `SELECT id, status, reference, evidence, reconciliation_state
     FROM submission_attempts WHERE application_id = ? OR job_id = ?
     ORDER BY attempted_at DESC LIMIT 1`,
    [app.id, app.job_id],
  );
  if (!attempt) {
    return {
      state: "unchanged",
      applied: false,
      detail: "No submission attempt exists for this application, so there is nothing to reconcile.",
    };
  }

  const reference = (input.reference ?? "").trim();
  if ((input.kind === "employer_reference" || input.kind === "employer_confirmation") && !reference) {
    throw new Error("Employer reconciliation requires a reference or confirmation value. Nothing was marked verified.");
  }

  if (input.kind === "employer_reference" || input.kind === "employer_confirmation") {
    const queueState = input.kind === "employer_confirmation" ? "confirmed" : "submitted_reference";
    const evidence = mergeEvidence(attempt.evidence, {
      kind: input.kind,
      reference,
      observedAt,
      actor,
      note: input.note?.slice(0, 1000) ?? null,
      source: "employer",
    });
    run(
      `UPDATE submission_attempts SET status = 'verified', reference = ?, reconciliation_state = 'confirmed',
         reconciliation_evidence = ?, reconciled_at = ?, error = NULL WHERE id = ?`,
      [reference, evidence, observedAt, attempt.id],
    );
    run(
      `UPDATE applications SET status = 'submitted', submission_status = 'verified', submission_state = ?,
         submitted_at = COALESCE(submitted_at, ?), confirmation = ?, confirmation_ref = ?,
         last_update = ? WHERE id = ?`,
      [queueState, observedAt, reference, reference, nowIso(), app.id],
    );
    run("UPDATE jobs SET status = 'applied' WHERE id = ?", [app.job_id]);
    recordApplicationEvent({
      applicationId: app.id,
      type: "submission.reconciled",
      message: `Employer evidence resolved the uncertain outcome (${input.kind}); reference ${reference}.`,
      meta: { attemptId: attempt.id, kind: input.kind, reference, observedAt, actor },
    });
    finishQueueEntry({ jobId: app.job_id, state: queueState, reason: null, actor, now: new Date(observedAt) });
    return {
      state: queueState,
      applied: true,
      detail: `Employer evidence recorded. Application ${app.id} is verified with reference ${reference}.`,
    };
  }

  if (input.kind === "owner_attestation") {
    const note = (input.note ?? "").trim();
    if (!note) throw new Error("An owner attestation requires a note describing what the owner sent. Nothing was changed.");
    const evidence = mergeEvidence(attempt.evidence, {
      kind: "owner_attestation",
      observedAt,
      actor,
      note: note.slice(0, 1000),
      source: "owner",
      employerConfirmed: false,
    });
    // The attempt remains unverified. An owner saying "I sent it" is not an
    // employer saying "we received it".
    run(
      `UPDATE submission_attempts SET status = 'unverified', reconciliation_state = 'owner_attested',
         reconciliation_evidence = ?, reconciled_at = ? WHERE id = ?`,
      [evidence, observedAt, attempt.id],
    );
    run(
      `UPDATE applications SET status = 'submitted_unverified', submission_status = 'unverified',
         submission_state = 'sent_by_owner', submitted_at = COALESCE(submitted_at, ?),
         confirmation = NULL, confirmation_ref = NULL, email_handoff_sent_at = COALESCE(email_handoff_sent_at, ?),
         email_handoff_note = COALESCE(email_handoff_note, ?), last_update = ? WHERE id = ?`,
      [observedAt, observedAt, note.slice(0, 2000), nowIso(), app.id],
    );
    recordApplicationEvent({
      applicationId: app.id,
      type: "submission.owner_attested",
      message: "The owner attested that they sent the application. This is not employer confirmation and remains unverified.",
      meta: { attemptId: attempt.id, kind: input.kind, observedAt, actor },
    });
    finishQueueEntry({
      jobId: app.job_id,
      state: "sent_by_owner",
      reason: "The owner attested sending the application; employer confirmation is pending.",
      actor,
      now: new Date(observedAt),
    });
    return {
      state: "submitted_unverified",
      applied: true,
      detail: "Owner attestation recorded. The application remains unverified; employer confirmation was not fabricated.",
    };
  }

  const note = (input.note ?? "").trim();
  if (!note) {
    throw new Error("A not-delivered finding requires evidence or a note explaining how it was established.");
  }
  const evidence = mergeEvidence(attempt.evidence, {
    kind: "not_delivered",
    observedAt,
    actor,
    note: note.slice(0, 1000),
    source: "employer_or_local_evidence",
  });
  run(
    `UPDATE submission_attempts SET status = 'blocked', reconciliation_state = 'not_delivered',
       error = ?, reconciliation_evidence = ?, reconciled_at = ? WHERE id = ?`,
    [`Confirmed not delivered: ${note}`.slice(0, 2000), evidence, observedAt, attempt.id],
  );
  run(
    `UPDATE applications SET status = 'ready_to_submit', submission_status = NULL,
       submission_state = 'ready_for_submission', last_update = ? WHERE id = ?`,
    [nowIso(), app.id],
  );
  recordApplicationEvent({
    applicationId: app.id,
    type: "submission.not_delivered",
    message: `The prior attempt was confirmed not delivered (${note}). The package may be sent again.`,
    meta: { attemptId: attempt.id, kind: input.kind, observedAt, actor },
  });
  finishQueueEntry({
    jobId: app.job_id,
    state: "ready_for_submission",
    reason: "Reconciled as not delivered; safe to retry.",
    actor,
    now: new Date(observedAt),
  });
  return {
    state: "ready_for_submission",
    applied: true,
    detail: "The prior attempt was recorded as not delivered. A later run may send once more.",
  };
}
