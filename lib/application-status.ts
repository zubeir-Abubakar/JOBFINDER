export const APPLICATION_STATUSES = [
  "discovered",
  "analysing",
  "under_review",
  "rejected_below_threshold",
  "rejected_ineligible",
  "qualified",
  "shortlisted",
  "documents_preparing",
  "preparing_documents",
  "quality_check",
  "quality_review_required",
  "ready_to_submit",
  "submitting",
  "awaiting_approval",
  "approval_required",
  "submitted",
  "submission_unverified",
  "submission_unknown",
  "human_intervention_required",
  "interview",
  "rejected_by_employer",
  "submission_failed",
  "acknowledged",
  "interview_invited",
  "interview_completed",
  "offer_received",
  "rejected",
  "withdrawn",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function statusLabel(status: string): string {
  return status
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function statusClass(status: string): string {
  if (["submitted", "acknowledged"].includes(status)) return "badge-info";
  if (["interview", "interview_invited", "interview_completed", "offer_received"].includes(status)) return "badge-good";
  if (["rejected", "rejected_by_employer", "submission_failed", "rejected_ineligible"].includes(status)) return "badge-bad";
  if ([
    "awaiting_approval",
    "approval_required",
    "submitting",
    "documents_preparing",
    "preparing_documents",
    "quality_check",
    "quality_review_required",
    "ready_to_submit",
    "shortlisted",
    "submission_unverified",
    "submission_unknown",
    "human_intervention_required",
    "rejected_below_threshold",
    "under_review",
    "qualified",
  ].includes(status)) return "badge-warn";
  return "badge-neutral";
}

/**
 * Only the readiness engine may authorise submission. A manually edited status
 * is not enough: the persisted readiness record must still say the checklist
 * passed. This closes the shortcut where answering one question or editing the
 * status could put a package back into the automatic queue.
 */
export function readinessAllowsSubmission(readiness: string | null | undefined): boolean {
  if (!readiness) return false;
  try {
    const parsed = JSON.parse(readiness) as { ready?: unknown; state?: unknown };
    return parsed.ready === true && parsed.state === "ready_for_submission";
  } catch {
    return false;
  }
}

/** The pipeline names requested for the Autonomous Recruitment dashboard. */
export const AUTONOMOUS_PIPELINE: Array<{ status: string; label: string }> = [
  { status: "discovered", label: "Discovered" },
  { status: "under_review", label: "Under review" },
  { status: "rejected_below_threshold", label: "Rejected — below 85%" },
  { status: "rejected_ineligible", label: "Rejected — ineligible" },
  { status: "qualified", label: "Qualified" },
  { status: "preparing_documents", label: "Preparing documents" },
  { status: "quality_check", label: "Quality check" },
  { status: "quality_review_required", label: "Quality review required" },
  { status: "ready_to_submit", label: "Ready to submit" },
  { status: "submitting", label: "Submitting" },
  { status: "submitted", label: "Submitted" },
  { status: "acknowledged", label: "Acknowledged" },
  { status: "submission_unverified", label: "Submission unverified" },
  { status: "submission_unknown", label: "Submission unknown" },
  { status: "submission_failed", label: "Submission failed" },
  { status: "approval_required", label: "Approval required" },
  { status: "human_intervention_required", label: "Human intervention required" },
  { status: "interview", label: "Interview" },
  { status: "rejected_by_employer", label: "Rejected by employer" },
  { status: "withdrawn", label: "Withdrawn" },
  { status: "offer_received", label: "Offer received" },
];

/**
 * A submission can only be recorded after approval (when approval mode is on)
 * and with a real employer confirmation reference. An agent finishing its task
 * is never, by itself, evidence that an application was submitted.
 */
export function submissionBlockedReason(input: {
  found: boolean;
  approvalMode: boolean;
  approvedAt: string | null;
  confirmation: string;
  status: string;
}): string | null {
  if (!input.found) return "Application not found.";
  // Per-application approval is retired. An eligible package no longer waits
  // for an approval flag; recording a submission still requires real employer
  // evidence. `approvalMode`/`approvedAt` remain accepted for old callers.
  void input.approvalMode;
  void input.approvedAt;
  if (!input.confirmation) return "Enter the confirmation reference or message shown by the employer portal.";
  if (["submitted", "acknowledged"].includes(input.status)) {
    return "This application is already recorded as submitted or acknowledged.";
  }
  return null;
}

/**
 * Statuses that describe what happens after an employer has received the
 * application. None of them may be entered from a bare status change: the
 * record must already carry verified employer evidence.
 */
export const POST_SUBMISSION_STATUSES = [
  "submitted",
  "acknowledged",
  "interview",
  "interview_invited",
  "interview_completed",
  "offer_received",
] as const;

export function statusRequiresVerifiedSubmission(status: string): boolean {
  return (POST_SUBMISSION_STATUSES as readonly string[]).includes(status);
}

/** Verified submission evidence is a stored timestamp plus an employer reference. */
export function hasVerifiedSubmissionEvidence(input: {
  submitted_at: string | null;
  confirmation: string | null;
}): boolean {
  return Boolean(input.submitted_at) && Boolean(input.confirmation);
}

/**
 * The five canonical operating outcomes. They are derived from persisted
 * evidence, never from prose or from the fact that an agent task ended.
 */
export type CanonicalSubmissionOutcome =
  | "submitted_verified"
  | "prepared_not_submitted"
  | "blocked_external"
  | "failed_technical"
  | "outcome_uncertain";

export const CANONICAL_OUTCOME_LABELS: Record<CanonicalSubmissionOutcome, string> = {
  submitted_verified: "Submitted — employer confirmed",
  prepared_not_submitted: "Prepared — not submitted",
  blocked_external: "Blocked — external requirement",
  failed_technical: "Failed — technical",
  outcome_uncertain: "Outcome uncertain",
};

function declaredOutcome(evidence: string | null | undefined): CanonicalSubmissionOutcome | null {
  if (!evidence) return null;
  try {
    const parsed = JSON.parse(evidence) as { outcomeClass?: unknown };
    const value = parsed.outcomeClass;
    if (
      value === "submitted_verified" ||
      value === "prepared_not_submitted" ||
      value === "blocked_external" ||
      value === "failed_technical" ||
      value === "outcome_uncertain"
    ) {
      return value;
    }
  } catch {
    // An unreadable evidence blob falls through to the status-based mapping.
  }
  return null;
}

/**
 * A prepared application is not a submission, a CAPTCHA block is not a
 * technical failure and an uncertain POST is never counted as submitted.
 */
export function canonicalSubmissionOutcome(input: {
  status: string;
  submission_status: string | null;
  submitted_at: string | null;
  confirmation: string | null;
  evidence?: string | null;
}): CanonicalSubmissionOutcome {
  if (hasVerifiedSubmissionEvidence(input) || input.submission_status === "verified" || input.status === "acknowledged") {
    return input.submission_status === "verified" || hasVerifiedSubmissionEvidence(input)
      ? "submitted_verified"
      : "outcome_uncertain";
  }
  if (["submission_unverified", "submission_unknown"].includes(input.status) || input.submission_status === "unverified") {
    return "outcome_uncertain";
  }
  if (input.status === "submission_failed" || input.submission_status === "failed") return "failed_technical";
  const declared = declaredOutcome(input.evidence);
  if (declared && declared !== "submitted_verified") return declared;
  if (input.status === "human_intervention_required" || input.submission_status === "blocked") return "blocked_external";
  return "prepared_not_submitted";
}

export type SubmissionEvidenceState = "verified" | "partial" | "none";

/**
 * How a verified submission was confirmed. `owner_recorded` is the owner
 * transcribing the employer's portal/email confirmation; it is never presented
 * as an automated portal verification.
 */
export type SubmissionConfirmationSource = "automated_employer" | "owner_recorded" | "unknown";

export function submissionConfirmationSource(input: {
  evidence?: string | null;
}): SubmissionConfirmationSource {
  if (!input.evidence) return "unknown";
  try {
    const parsed = JSON.parse(input.evidence) as { source?: unknown; outcomeClass?: unknown };
    if (parsed.source === "manual_record") return "owner_recorded";
    if (typeof parsed.outcomeClass === "string") return "automated_employer";
  } catch {
    // An unreadable evidence blob is reported as an unknown source, never as
    // automated portal verification.
  }
  return "unknown";
}

export function submissionConfirmationSourceLabel(input: { evidence?: string | null }): string {
  const source = submissionConfirmationSource(input);
  if (source === "owner_recorded") return "Owner-recorded from the employer's confirmation (not an automated portal response)";
  if (source === "automated_employer") return "Automated employer portal/endpoint response";
  return "Verification source not recorded";
}

/**
 * `partial` means an attempt left a timestamp or a reference behind, but not the
 * pair required for confirmation. It never counts as employer-confirmed.
 */
export function submissionEvidenceState(input: {
  submitted_at: string | null;
  confirmation: string | null;
}): SubmissionEvidenceState {
  if (hasVerifiedSubmissionEvidence(input)) return "verified";
  if (input.submitted_at || input.confirmation) return "partial";
  return "none";
}

/** Owner-facing label. Never infers confirmation from a status or portal name. */
export function submissionEvidenceLabel(input: {
  submitted_at: string | null;
  confirmation: string | null;
  evidence?: string | null;
}): string {
  const state = submissionEvidenceState(input);
  if (state === "verified") {
    const source = submissionConfirmationSource(input);
    if (source === "owner_recorded") return "Employer-confirmed · recorded by owner";
    if (source === "automated_employer") return "Employer-confirmed · automated portal response";
    return "Employer-confirmed";
  }
  if (state === "partial") return "Attempted — not verified";
  return "No verified submission evidence";
}

/** Verified submission: submitted status, timestamp and employer reference all present. */
export function isApplicationSubmitted(input: {
  status: string;
  submitted_at: string | null;
  confirmation: string | null;
}): boolean {
  return input.status === "submitted" && hasVerifiedSubmissionEvidence(input);
}

export type StatusTransitionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * The single authoritative lifecycle rule. Every status pathway (the detail
 * dropdown, the Kanban drop target and any future caller) must use this.
 *
 * Evidence is read from the persisted record, never from the requested status,
 * a document, a note or a browser action. A failed decision leaves the stored
 * status untouched.
 */
export function validateApplicationStatusTransition(input: {
  currentStatus: string;
  nextStatus: string;
  submitted_at: string | null;
  confirmation: string | null;
  readiness?: string | null;
}): StatusTransitionDecision {
  if (!(APPLICATION_STATUSES as readonly string[]).includes(input.nextStatus)) {
    return { allowed: false, reason: "That is not a recognised application status." };
  }
  // Evidence is checked before the no-op case: a legacy `submitted` row without
  // evidence is still not allowed to be presented as an Applied record.
  if (input.nextStatus === "submitted" && !hasVerifiedSubmissionEvidence(input)) {
    return {
      allowed: false,
      reason:
        "Applied requires a verified employer confirmation. Record the employer's confirmation reference with the submission form; a status change alone cannot mark an application as submitted.",
    };
  }

  if (statusRequiresVerifiedSubmission(input.nextStatus) && !hasVerifiedSubmissionEvidence(input)) {
    return {
      allowed: false,
      reason: `${statusLabel(input.nextStatus)} requires verified employer confirmation (a stored submission time and reference). This application has none, so it stays ${statusLabel(input.currentStatus)}. Record the confirmation first or correct the record.`,
    };
  }

  if (input.nextStatus === input.currentStatus) return { allowed: true };

  if (input.nextStatus === "ready_to_submit" && !readinessAllowsSubmission(input.readiness)) {
    return {
      allowed: false,
      reason:
        "The readiness checklist has not passed. Re-run the quality check before marking this application ready to send.",
    };
  }

  return { allowed: true };
}
