import type { JobAnalysis } from "./scoring";
import {
  hasSwissPermitB,
  normaliseClaimText,
  unsupportedMetricClaims,
  unsupportedTechClaims,
  workAuthorisationRequired,
} from "./claim-validation";

/**
 * Evidence-based application readiness.
 *
 * Documents existing is not enough. A package is ready only when the CV and
 * cover letter are present, each passed its own quality gate, the claims are
 * grounded, no duplicate submission exists and the stored submission policy is
 * satisfied. A warning is not silently promoted to ready: it produces
 * quality_review_required so the coordinator can explain the exact evidence.
 */

export type ReadinessState =
  | "documents_pending"
  | "documents_generating"
  | "documents_ready"
  | "quality_review_required"
  | "blocked"
  | "ready_for_submission";

export type ReadinessItem = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type ReadinessResult = {
  ready: boolean;
  state: ReadinessState;
  reasons: string[];
  items: ReadinessItem[];
  checkedAt: string;
  engine: string;
};

export type ReadinessDocument = {
  id: string | null;
  text: string | null;
  qualityStatus: string | null;
  qualityScore: number | null;
  fileExists: boolean;
} | null;

export type ReadinessInput = {
  job: {
    title: string;
    company: string;
    location: string | null;
    application_url: string | null;
    url: string | null;
    published_at: string | null;
    description: string | null;
    eligibility: string | null;
    eligibilityNotes: string | null;
    matchScore: number | null;
    analysis: JobAnalysis | null;
  };
  application: {
    id: string;
    status: string;
    submittedAt: string | null;
  };
  profile: {
    fullName: string | null;
    email: string | null;
    phone: string | null;
    workAuthorisation: string | null;
    skills: string[];
    certifications: string[];
    languages: string[];
    sourceText: string;
  };
  cv: ReadinessDocument;
  cover: ReadinessDocument;
  threshold: number;
  duplicateApplication?: boolean;
  submissionPolicy?: {
    active: boolean;
    autonomousSubmission: boolean;
    approvalRequired: boolean;
    dailyRemaining: number | null;
  };
  now: Date;
};

const PLACEHOLDER_COMPANY =
  /^(company\s+[a-z]|company\s+\d+|employer\s+[a-z]|example(\s+(company|employer|inc|ltd))?|sample(\s+company)?|test\s+company|acme(\s+corp(oration)?)?|placeholder|not specified|unknown)$/i;

function item(key: string, label: string, passed: boolean, detail: string): ReadinessItem {
  return { key, label, passed, detail };
}

function titleReferenced(coverText: string, title: string): boolean {
  const text = normaliseClaimText(coverText);
  if (text.includes(normaliseClaimText(title))) return true;
  const tokens = normaliseClaimText(title)
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 2 && !/^(the|and|for|with|senior|junior|m|f|d|w)$/.test(token));
  if (tokens.length === 0) return false;
  const hits = tokens.filter((token) => text.includes(token)).length;
  return hits / tokens.length >= 0.6;
}

function freshness(publishedAt: string | null, now: Date): { passed: boolean; detail: string } {
  if (!publishedAt) return { passed: false, detail: "No publication date is recorded, so the seven-day rule cannot be verified." };
  const time = Date.parse(publishedAt);
  if (!Number.isFinite(time)) return { passed: false, detail: `Publication date "${publishedAt}" could not be parsed.` };
  const days = Math.floor((now.getTime() - time) / 86_400_000);
  if (days > 7) return { passed: false, detail: `The vacancy was published ${days} day(s) ago; the limit is seven.` };
  return { passed: true, detail: `Published ${Math.max(0, days)} day(s) ago.` };
}

function qualityDetail(document: ReadinessDocument, label: string): string {
  if (!document) return `${label} is not attached.`;
  if (!document.fileExists) return `${label} is missing from storage.`;
  if (!document.qualityStatus) return `${label} has not passed a quality gate.`;
  return `${label} quality is ${document.qualityStatus}${document.qualityScore !== null ? ` (${document.qualityScore}/100)` : ""}.`;
}

export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const items: ReadinessItem[] = [];
  const job = input.job;

  const closedText = /\b(applications? (?:are )?closed|position (?:has been )?filled|no longer accepting applications)\b/i.test(
    job.description ?? "",
  );
  items.push(
    item(
      "vacancy_open",
      "Vacancy is still open",
      !closedText && job.eligibility !== "ineligible",
      closedText ? "The posting states it is no longer accepting applications." : `Eligibility is ${job.eligibility ?? "not assessed"}.`,
    ),
  );

  const fresh = freshness(job.published_at, input.now);
  items.push(item("freshness", "No older than seven days", fresh.passed, fresh.detail));

  let employerOk = false;
  let employerDetail = "The employer name is missing or a placeholder.";
  if (job.company.trim().length >= 2 && !PLACEHOLDER_COMPANY.test(job.company.trim())) {
    const url = job.application_url ?? job.url;
    try {
      const parsed = new URL(url ?? "");
      employerOk = /^https?:$/.test(parsed.protocol) && parsed.hostname.includes(".");
      employerDetail = employerOk ? `Employer ${job.company} and application URL ${parsed.hostname} are present.` : "The application URL is not a usable http(s) address.";
    } catch {
      employerDetail = "No valid application URL is recorded for this vacancy.";
    }
  }
  items.push(item("employer_url", "Employer and application URL verified", employerOk, employerDetail));

  const scoreOk = job.matchScore !== null && job.matchScore >= input.threshold;
  items.push(
    item(
      "threshold",
      `Match score at least ${input.threshold}%`,
      scoreOk,
      job.matchScore === null ? "No match score is stored." : `Stored score is ${job.matchScore}%. This is suitability, not document quality.`,
    ),
  );

  let eligibilityBlockers: string[] = [];
  try {
    const parsed = JSON.parse(job.eligibilityNotes ?? "{}") as { blockers?: string[] };
    eligibilityBlockers = Array.isArray(parsed.blockers) ? parsed.blockers : [];
  } catch {
    eligibilityBlockers = [];
  }
  const mandatory = [...eligibilityBlockers, ...(job.analysis?.mandatoryBlockers ?? [])];
  items.push(
    item(
      "mandatory_blockers",
      "No mandatory eligibility blocker",
      job.eligibility === "eligible" && mandatory.length === 0,
      mandatory.length > 0 ? mandatory.slice(0, 3).join(" ") : `Eligibility is ${job.eligibility ?? "not assessed"} with no recorded blocker.`,
    ),
  );

  const cvText = input.cv?.text ?? "";
  const cvPresent = Boolean(input.profile.fullName?.trim() && input.profile.email?.trim() && cvText.trim().length >= 200 && input.cv?.fileExists);
  items.push(
    item(
      "cv_present",
      "Tailored CV is present and complete",
      cvPresent,
      !input.cv
        ? "No tailored CV document is attached."
        : !input.cv.fileExists
          ? "The tailored CV file is missing from storage."
          : !input.profile.fullName?.trim() || !input.profile.email?.trim()
            ? "The verified profile is missing the name or email."
            : cvText.trim().length < 200
              ? "The tailored CV text is too short to be a complete document."
              : "Candidate identity, contact details and CV text are present.",
    ),
  );

  const cvQualityOk = input.cv?.qualityStatus === "passed";
  items.push(
    item(
      "cv_quality",
      "CV passed its document-quality gate",
      cvQualityOk,
      qualityDetail(input.cv, "CV"),
    ),
  );

  const unsupportedCv = unsupportedTechClaims(
    cvText,
    input.profile.sourceText,
    input.profile.skills,
  );
  const inventedCvMetrics = unsupportedMetricClaims(cvText, input.profile.sourceText, `${job.title} ${job.company}`);
  const cvClaimsOk = unsupportedCv.length === 0 && inventedCvMetrics.length === 0;
  items.push(
    item(
      "cv_claims",
      "Every CV claim is supported",
      cvClaimsOk,
      !cvClaimsOk
        ? [
            unsupportedCv.length ? `Unsupported technologies: ${unsupportedCv.join(", ")}.` : "",
            inventedCvMetrics.length ? `Unsupported metrics: ${inventedCvMetrics.join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : "Technologies and metrics in the CV are evidenced by the verified profile/master CV.",
    ),
  );

  const coverText = input.cover?.text ?? "";
  const coverPresent = Boolean(coverText.trim() && input.cover?.fileExists);
  items.push(
    item(
      "cover_present",
      "Cover letter is present",
      coverPresent,
      !input.cover
        ? "No cover letter is attached."
        : !input.cover.fileExists
          ? "The cover letter file is missing from storage."
          : coverText.trim().length > 0
            ? "Cover letter text and file are present."
            : "The cover letter text is empty.",
    ),
  );

  const coverQualityOk = input.cover?.qualityStatus === "passed";
  items.push(
    item(
      "cover_quality",
      "Cover letter passed its document-quality gate",
      coverQualityOk,
      qualityDetail(input.cover, "Cover letter"),
    ),
  );

  const coverTargetOk = Boolean(coverText.trim() && titleReferenced(coverText, job.title) && normaliseClaimText(coverText).includes(normaliseClaimText(job.company)));
  items.push(
    item(
      "cover_target",
      "Cover letter names the actual role and employer",
      coverTargetOk,
      coverTargetOk ? "Role and employer are both referenced." : "The cover letter does not reference both the role title and the employer.",
    ),
  );

  const unsupportedCover = unsupportedTechClaims(coverText, input.profile.sourceText, input.profile.skills);
  const inventedCoverMetrics = unsupportedMetricClaims(coverText, input.profile.sourceText, `${job.title} ${job.company}`);
  const coverClaimsOk = unsupportedCover.length === 0 && inventedCoverMetrics.length === 0;
  items.push(
    item(
      "cover_claims",
      "No unsupported claims in the cover letter",
      coverClaimsOk,
      unsupportedCover.length
        ? `Unsupported technologies: ${unsupportedCover.join(", ")}.`
        : inventedCoverMetrics.length
          ? `Unsupported metrics: ${inventedCoverMetrics.join(", ")}.`
          : "No unsupported technology or metric was introduced.",
    ),
  );

  const authorisationRequired = workAuthorisationRequired(job.description ?? "");
  const verifiedPermit = hasSwissPermitB(input.profile.workAuthorisation);
  items.push(
    item(
      "work_authorisation",
      "Work authorisation requirement is satisfied",
      !authorisationRequired || verifiedPermit,
      authorisationRequired
        ? verifiedPermit
          ? "The vacancy asks about work authorisation; a verified Swiss Permit B is recorded."
          : "The vacancy asks about work authorisation, but no verified Swiss Permit B is recorded."
        : "The vacancy does not ask about work authorisation or sponsorship.",
    ),
  );

  const languagesRecorded = input.profile.languages.length > 0;
  items.push(
    item(
      "language_record",
      "Language proficiency is recorded",
      languagesRecorded,
      languagesRecorded ? `Recorded languages: ${input.profile.languages.join(", ")}.` : "No language proficiency is recorded in the verified profile.",
    ),
  );

  if (input.duplicateApplication) {
    items.push(item("duplicate_application", "No duplicate application", false, "A verified submission already exists for this vacancy."));
  } else {
    items.push(item("duplicate_application", "No duplicate application", true, "No prior verified submission is recorded."));
  }

  if (input.submissionPolicy) {
    const policy = input.submissionPolicy;
    const policyOk =
      policy.active &&
      policy.autonomousSubmission &&
      (policy.dailyRemaining === null || policy.dailyRemaining > 0);
    const detail = !policy.active
      ? "Automatic submission is paused."
      : !policy.autonomousSubmission
        ? "Autonomous submission is disabled."
        : policy.dailyRemaining !== null && policy.dailyRemaining <= 0
          ? "Today's submission limit has been reached."
          : "Automatic submission and the daily limit are satisfied; no per-application approval is required.";
    items.push(item("submission_policy", "Submission policy is satisfied", policyOk, detail));
  }

  const reasons = items.filter((entry) => !entry.passed).map((entry) => `${entry.label}: ${entry.detail}`);
  const failed = new Set(items.filter((entry) => !entry.passed).map((entry) => entry.key));
  const cvQualityWarning = input.cv?.qualityStatus === "warning";
  const coverQualityWarning = input.cover?.qualityStatus === "warning";
  const qualityReview = cvQualityWarning || coverQualityWarning;
  const missingDocuments = !input.cv || !input.cover;
  const policyOnlyFailure = failed.size > 0 && [...failed].every((key) => key === "submission_policy");
  const qualityKeys = new Set(["cv_quality", "cover_quality"]);
  const nonQualityCritical = [...failed].some((key) => key !== "submission_policy" && !qualityKeys.has(key));

  let state: ReadinessState;
  if (reasons.length === 0) {
    state = "ready_for_submission";
  } else if (missingDocuments) {
    state = ["documents_preparing", "preparing_documents"].includes(input.application.status)
      ? "documents_generating"
      : "documents_pending";
  } else if (policyOnlyFailure) {
    state = "documents_ready";
  } else if (qualityReview && !nonQualityCritical) {
    state = "quality_review_required";
  } else {
    state = "blocked";
  }

  return {
    ready: reasons.length === 0,
    state,
    reasons,
    items,
    checkedAt: input.now.toISOString(),
    engine: "application-readiness-v2",
  };
}
