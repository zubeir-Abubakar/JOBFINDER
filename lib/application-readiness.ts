import type { JobAnalysis } from "./scoring";

/**
 * Pre-document-generation readiness gate.
 *
 * Every item is mandatory. A package is never generated silently around a
 * failed check: the caller stores this checklist on the application and queues
 * it for human review with the exact reasons.
 *
 * The checks use only supplied evidence. Claims in the generated CV are compared
 * with the verified master text, so a model cannot add a technology or metric
 * that the candidate has not evidenced.
 */

export type ReadinessItem = {
  key: string;
  label: string;
  passed: boolean;
  detail: string;
};

export type ReadinessResult = {
  ready: boolean;
  reasons: string[];
  items: ReadinessItem[];
  checkedAt: string;
  engine: string;
};

export type ReadinessDocument = {
  id: string | null;
  text: string | null;
  qualityStatus: string | null;
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
    skills: string[];
    certifications: string[];
    languages: string[];
    sourceText: string;
  };
  cv: ReadinessDocument;
  cover: ReadinessDocument;
  threshold: number;
  now: Date;
};

const TECH_CLAIMS = [
  "playwright", "cypress", "selenium", "appium", "espresso", "xcuitest", "rest assured", "postman",
  "python", "javascript", "typescript", "java", "c#", ".net", "sql", "jenkins", "azure devops",
  "docker", "kubernetes", "terraform", "aws", "azure", "gcp", "ci/cd", "jmeter", "k6", "grafana",
  "jira", "xray", "testrail", "zephyr", "cucumber", "bdd", "robot framework", "testng", "junit",
  "pytest", "kotlin", "swift", "gatling", "loadrunner", "tricentis tosca", "github actions",
  "gitlab ci", "graphql", "kafka", "browserstack", "sauce labs", "maestro", "detox",
];

const PLACEHOLDER_COMPANY =
  /^(company\s+[a-z]|company\s+\d+|employer\s+[a-z]|example(\s+(company|employer|inc|ltd))?|sample(\s+company)?|test\s+company|acme(\s+corp(oration)?)?|placeholder|not specified|unknown)$/i;

function normalise(value: string): string {
  return value.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
}

function item(key: string, label: string, passed: boolean, detail: string): ReadinessItem {
  return { key, label, passed, detail };
}

function metricTokens(value: string): string[] {
  return (
    value.match(
      /\b\d+(?:\.\d+)?\+?\s*(?:%|percent|hours?|hrs?|minutes?|days?|weeks?|months?|tests?|cases?|engineers?|people?|users?|clients?|countries?|projects?|releases?)(?![A-Za-z])/gi,
    ) ?? []
  ).map((token) => token.toLowerCase().replace(/\s+/g, " "));
}

function supportedClaims(text: string, evidence: string, profileSkills: string[]): string[] {
  const haystack = normalise(evidence);
  const skills = profileSkills.map((skill) => normalise(skill));
  return TECH_CLAIMS.filter((tech) => normalise(text).includes(tech) && !haystack.includes(tech) && !skills.some((skill) => skill.includes(tech)));
}

function titleReferenced(coverText: string, title: string): boolean {
  const text = normalise(coverText);
  if (text.includes(normalise(title))) return true;
  const tokens = normalise(title)
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
      job.matchScore === null ? "No match score is stored." : `Stored score is ${job.matchScore}%.`,
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

  const masterComplete = Boolean(input.profile.fullName?.trim() && input.profile.email?.trim() && input.cv?.text && input.cv.text.trim().length >= 200);
  items.push(
    item(
      "master_cv",
      "Master CV is available and complete",
      masterComplete && input.cv?.fileExists === true,
      !input.cv
        ? "No tailored CV document is attached."
        : !input.cv.fileExists
          ? "The tailored CV file is missing from storage."
          : !masterComplete
            ? "The verified profile or master CV text is incomplete."
            : "Master identity, contact details and CV text are present.",
    ),
  );

  const cvText = input.cv?.text ?? "";
  const unsupportedCv = supportedClaims(cvText, input.profile.sourceText, input.profile.skills);
  const sourceMetrics = new Set(metricTokens(input.profile.sourceText));
  const inventedMetrics = [...new Set(metricTokens(cvText))].filter((metric) => !sourceMetrics.has(metric));
  const claimsOk = unsupportedCv.length === 0 && inventedMetrics.length === 0;
  items.push(
    item(
      "cv_claims",
      "Every CV claim is supported",
      claimsOk,
      !claimsOk
        ? [
            unsupportedCv.length ? `Unsupported technologies: ${unsupportedCv.join(", ")}.` : "",
            inventedMetrics.length ? `Unsupported metrics: ${inventedMetrics.join(", ")}.` : "",
          ]
            .filter(Boolean)
            .join(" ")
        : "Technologies and metrics in the CV are evidenced by the verified profile/master CV.",
    ),
  );

  const coverText = input.cover?.text ?? "";
  const coverOk = Boolean(coverText.trim() && titleReferenced(coverText, job.title) && normalise(coverText).includes(normalise(job.company)));
  items.push(
    item(
      "cover_target",
      "Cover letter names the actual role and employer",
      coverOk,
      coverOk ? "Role and employer are both referenced." : "The cover letter does not reference both the role title and the employer.",
    ),
  );

  const unsupportedCover = supportedClaims(coverText, input.profile.sourceText, input.profile.skills);
  const coverQualityOk = input.cover?.qualityStatus !== "failed";
  items.push(
    item(
      "cover_claims",
      "No unsupported AI claims in the cover letter",
      unsupportedCover.length === 0 && coverQualityOk,
      !coverQualityOk
        ? "The cover letter failed the document quality gate."
        : unsupportedCover.length
          ? `Unsupported technologies: ${unsupportedCover.join(", ")}.`
          : "No unsupported technology was introduced by AI.",
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

  const reasons = items.filter((entry) => !entry.passed).map((entry) => `${entry.label}: ${entry.detail}`);
  return {
    ready: reasons.length === 0,
    reasons,
    items,
    checkedAt: input.now.toISOString(),
    engine: "application-readiness-v1",
  };
}
