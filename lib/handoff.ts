import { all } from "./db";
import type { JobAnalysis } from "./scoring";

/**
 * Human Intervention Queue.
 *
 * The queue is not a separate copy of the application: it is a read model over
 * the persisted application, job, document and intervention rows. That is what
 * makes it survive a restart, and it means a blocked application never
 * disappears from tracking. Documents are joined with `user_id = ?` so another
 * account's file can never appear in the package.
 */

export type HandoffStatus =
  | "preparing"
  | "ready_for_manual_completion"
  | "waiting_for_user_action"
  | "manually_completed"
  | "submitted"
  | "rejected_or_expired"
  | "cancelled";

export type HandoffBlockerKind =
  | "captcha"
  | "mfa"
  | "unsupported_portal"
  | "missing_information"
  | "declaration"
  | "eligibility"
  | "security"
  | "quality_review"
  | "unknown";

export type HandoffDocument = {
  id: string;
  name: string;
  previewHref: string;
  downloadHref: string;
} | null;

export type HandoffItem = {
  applicationId: string;
  jobId: string;
  employer: string;
  jobTitle: string;
  applicationUrl: string | null;
  postingUrl: string | null;
  matchScore: number | null;
  matchExplanation: string;
  vacancyVerification: {
    status: string | null;
    evidence: string | null;
    verifiedAt: string | null;
    eligibility: string | null;
  };
  blocker: {
    kind: HandoffBlockerKind;
    reason: string;
    classification: string;
  };
  stopExplanation: string;
  cv: HandoffDocument;
  coverLetter: HandoffDocument;
  supportingDocuments: HandoffDocument[];
  preparedAnswers: Array<{ question: string; answer: string; answeredAt: string | null }>;
  remainingSteps: string[];
  discoveredAt: string | null;
  preparedAt: string | null;
  applicationStatus: string;
  queueStatus: HandoffStatus;
  queueStatusLabel: string;
  updatedAt: string;
};

type Row = {
  application_id: string;
  job_id: string;
  status: string;
  submission_status: string | null;
  method: string | null;
  confirmation_ref: string | null;
  submitted_at: string | null;
  created_at: string;
  last_update: string;
  readiness: string | null;
  notes: string | null;
  title: string;
  company: string;
  url: string | null;
  application_url: string | null;
  match_score: number | null;
  analysis: string | null;
  description: string | null;
  eligibility: string | null;
  eligibility_notes: string | null;
  vacancy_status: string | null;
  vacancy_verification: string | null;
  vacancy_verified_at: string | null;
  discovered_at: string | null;
  cv_id: string | null;
  cv_name: string | null;
  cover_id: string | null;
  cover_name: string | null;
};

const QUEUE_LABEL: Record<HandoffStatus, string> = {
  preparing: "Preparing",
  ready_for_manual_completion: "Ready for manual completion",
  waiting_for_user_action: "Waiting for your action",
  manually_completed: "Manually completed",
  submitted: "Submitted",
  rejected_or_expired: "Rejected or expired",
  cancelled: "Cancelled",
};

function blockerKind(text: string): HandoffBlockerKind {
  const value = text.toLowerCase();
  if (/captcha|not a robot|recaptcha|hcaptcha/.test(value)) return "captcha";
  if (/multi[- ]?factor|two[- ]?factor|2fa|mfa|verification code|one[- ]time/.test(value)) return "mfa";
  if (/unsupported|portal|login|sign in|create an account|payment|fee/.test(value)) return "unsupported_portal";
  if (/declaration|legal|consent|attest|authori[sz]/.test(value)) return "declaration";
  if (/eligib|permit|authori[sz]ation|sponsor/.test(value)) return "eligibility";
  if (/quality|review|document|cover letter|cv/.test(value)) return "quality_review";
  if (/security|challenge|blocked/.test(value)) return "security";
  if (/answer|question|information|missing|profile/.test(value)) return "missing_information";
  return "unknown";
}

function remainingSteps(kind: HandoffBlockerKind, applicationUrl: string | null): string[] {
  const open = applicationUrl
    ? "Open the employer application page from the link on this package."
    : "Open the original posting and locate the employer's application link.";
  switch (kind) {
    case "captcha":
      return [open, "Complete the CAPTCHA yourself. The platform never solves or bypasses it.", "Upload or attach the prepared CV and cover letter, then submit.", "Record the employer confirmation reference here."];
    case "mfa":
      return [open, "Complete the employer's sign-in or multi-factor verification yourself.", "Attach the prepared documents and submit.", "Record the confirmation reference here."];
    case "unsupported_portal":
      return [open, "Complete the employer's supported form manually; this portal is not automated.", "Attach the prepared CV and cover letter.", "Record the confirmation reference here."];
    case "missing_information":
      return ["Answer the open questions shown on this application.", "Re-run the readiness check; the next recruitment run may submit it automatically.", "If the employer still requires a manual step, complete it and record the confirmation."];
    case "declaration":
      return [open, "Read and personally confirm the legal declaration. It is never auto-answered.", "Attach the prepared documents and submit.", "Record the confirmation reference here."];
    case "quality_review":
      return ["Review the document-quality findings on this application.", "Regenerate the CV or cover letter after correcting the findings.", "Re-run the quality check before any submission."];
    case "eligibility":
      return ["Review the recorded eligibility evidence for this vacancy.", "Confirm the requirement against your verified profile.", "If you are eligible, complete the employer form manually and record the confirmation."];
    case "security":
      return [open, "Complete the security step yourself; the platform never bypasses it.", "Submit the prepared documents.", "Record the employer confirmation."];
    default:
      return [open, "Complete the remaining employer step manually.", "Attach the prepared CV and cover letter.", "Record the employer confirmation reference here."];
  }
}

function queueStatus(row: Row, openInterventions: number): HandoffStatus {
  if (["submitted", "acknowledged", "interview", "interview_invited", "interview_completed", "offer_received"].includes(row.status)) return "submitted";
  if (["rejected", "rejected_by_employer", "withdrawn", "rejected_ineligible", "rejected_below_threshold"].includes(row.status)) return "rejected_or_expired";
  if (row.status === "cancelled") return "cancelled";
  if (row.method === "manual" && row.submission_status === "verified") return "manually_completed";
  if (row.status === "human_intervention_required" || row.submission_status === "blocked" || openInterventions > 0) return "waiting_for_user_action";
  if (row.status === "ready_to_submit") return "ready_for_manual_completion";
  return "preparing";
}

function matchExplanation(raw: string | null, score: number | null, flag: string | null): string {
  if (!raw) return score === null ? "No match analysis is stored." : `Deterministic match score ${score}% (${flag ?? "unclassified"}); no narrative analysis is stored.`;
  try {
    const analysis = JSON.parse(raw) as JobAnalysis;
    const parts = [
      `Score ${analysis.score ?? score ?? "—"}% (${analysis.flag ?? flag ?? "unclassified"}).`,
      analysis.matched?.length ? `Matched: ${analysis.matched.slice(0, 8).join(", ")}.` : "",
      analysis.missing?.length ? `Missing: ${analysis.missing.slice(0, 8).join(", ")}.` : "",
      analysis.concerns?.length ? `Concerns: ${analysis.concerns.slice(0, 4).join(" ")}` : "",
    ];
    return parts.filter(Boolean).join(" ");
  } catch {
    return score === null ? "No match analysis is stored." : `Deterministic match score ${score}% (${flag ?? "unclassified"}).`;
  }
}

function doc(id: string | null, name: string | null): HandoffDocument {
  if (!id) return null;
  return {
    id,
    name: name ?? "Document",
    previewHref: `/documents/${id}`,
    downloadHref: `/api/documents/${id}`,
  };
}

export function handoffQueue(userId: string, limit = 50): HandoffItem[] {
  const rows = all<Row>(
    `SELECT a.id AS application_id, a.job_id, a.status, a.submission_status, a.method, a.confirmation_ref,
            a.submitted_at, a.created_at, a.last_update, a.readiness, a.notes,
            j.title, j.company, j.url, j.application_url, j.match_score, j.analysis, j.description,
            j.eligibility, j.eligibility_notes, j.vacancy_status, j.vacancy_verification, j.vacancy_verified_at,
            j.discovered_at,
            cv.id AS cv_id, cv.display_name AS cv_name,
            cover.id AS cover_id, cover.display_name AS cover_name
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN documents cv ON cv.id = a.cv_document_id AND cv.user_id = ? AND cv.deleted_at IS NULL
     LEFT JOIN documents cover ON cover.id = a.cover_letter_id AND cover.user_id = ? AND cover.deleted_at IS NULL
     WHERE a.status IN ('human_intervention_required','submission_unverified','submission_failed',
                        'quality_review_required','ready_to_submit','documents_preparing','preparing_documents',
                        'quality_check','awaiting_documents')
     ORDER BY CASE WHEN a.status = 'human_intervention_required' THEN 0 ELSE 1 END, a.last_update DESC
     LIMIT ?`,
    [userId, userId, Math.max(1, Math.min(100, limit))],
  );

  return rows.map((row) => {
    const interventions = all<{ question: string; reason: string; kind: string; status: string; answer: string | null; resolved_at: string | null }>(
      "SELECT question, reason, kind, status, answer, resolved_at FROM application_interventions WHERE application_id = ? ORDER BY created_at",
      [row.application_id],
    );
    const open = interventions.filter((item) => item.status === "open");
    const latestBlocked = all<{ message: string | null; type: string }>(
      "SELECT message, type FROM application_events WHERE application_id = ? AND (type LIKE '%blocked%' OR type LIKE '%intervention%' OR type LIKE '%failed%') ORDER BY id DESC LIMIT 1",
      [row.application_id],
    )[0];
    const reason =
      open[0]?.reason ||
      latestBlocked?.message ||
      (row.readiness ? (() => {
        try {
          const parsed = JSON.parse(row.readiness) as { reasons?: string[] };
          return parsed.reasons?.[0] ?? null;
        } catch {
          return null;
        }
      })() : null) ||
      (row.status === "submission_unverified"
        ? "The employer did not provide a verifiable confirmation reference; delivery is unknown and the application was not counted as submitted."
        : `The application is at status ${row.status}; automatic completion is not available.`);
    const kind = blockerKind(`${open[0]?.kind ?? ""} ${reason}`);
    const applicationUrl = row.application_url ?? row.url;
    const status = queueStatus(row, open.length);
    const supporting = all<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM documents
       WHERE user_id = ? AND job_id = ? AND deleted_at IS NULL AND id NOT IN (?, ?) ORDER BY created_at DESC`,
      [userId, row.job_id, row.cv_id ?? "", row.cover_id ?? ""],
    );
    return {
      applicationId: row.application_id,
      jobId: row.job_id,
      employer: row.company,
      jobTitle: row.title,
      applicationUrl,
      postingUrl: row.url,
      matchScore: row.match_score,
      matchExplanation: matchExplanation(row.analysis, row.match_score, null),
      vacancyVerification: {
        status: row.vacancy_status,
        evidence: row.vacancy_verification,
        verifiedAt: row.vacancy_verified_at,
        eligibility: row.eligibility,
      },
      blocker: { kind, reason, classification: open[0]?.kind ?? kind },
      stopExplanation:
        row.submission_status === "unverified"
          ? reason
          : `Automatic submission stopped because ${reason.replace(/^the /i, "the ")} No application was sent to the employer.`,
      cv: doc(row.cv_id, row.cv_name),
      coverLetter: doc(row.cover_id, row.cover_name),
      supportingDocuments: supporting.map((item) => doc(item.id, item.display_name) as HandoffDocument).filter(Boolean) as HandoffDocument[],
      preparedAnswers: interventions
        .filter((item) => item.answer)
        .map((item) => ({ question: item.question, answer: item.answer as string, answeredAt: item.resolved_at })),
      remainingSteps: remainingSteps(kind, applicationUrl),
      discoveredAt: row.discovered_at,
      preparedAt: row.cv_id || row.cover_id ? row.last_update : null,
      applicationStatus: row.status,
      queueStatus: status,
      queueStatusLabel: QUEUE_LABEL[status],
      updatedAt: row.last_update,
    };
  });
}

export function handoffForApplication(userId: string, applicationId: string): HandoffItem | null {
  return handoffQueue(userId, 100).find((item) => item.applicationId === applicationId) ?? null;
}
