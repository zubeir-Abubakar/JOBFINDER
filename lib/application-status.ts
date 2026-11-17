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
