export const APPLICATION_STATUSES = [
  "discovered",
  "analysing",
  "shortlisted",
  "documents_preparing",
  "awaiting_approval",
  "submitted",
  "acknowledged",
  "interview_invited",
  "interview_completed",
  "offer_received",
  "rejected",
  "withdrawn",
  "submission_failed",
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
  if (["interview_invited", "interview_completed", "offer_received"].includes(status)) return "badge-good";
  if (["rejected", "submission_failed"].includes(status)) return "badge-bad";
  if (["awaiting_approval", "documents_preparing", "shortlisted"].includes(status)) return "badge-warn";
  return "badge-neutral";
}

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
  if (input.approvalMode && !input.approvedAt) {
    return "Approval mode is on. Approve the package before recording a submission.";
  }
  if (!input.confirmation) return "Enter the confirmation reference or message shown by the employer portal.";
  if (input.status === "submitted") return "This application is already recorded as submitted.";
  return null;
}

/** Verified submission: submitted status, timestamp and employer reference all present. */
export function isApplicationSubmitted(input: {
  status: string;
  submitted_at: string | null;
  confirmation: string | null;
}): boolean {
  return input.status === "submitted" && Boolean(input.submitted_at) && Boolean(input.confirmation);
}
