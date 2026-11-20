import { htmlToText } from "./scoring";
import type { JobAnalysis } from "./scoring";
import type { ProfileData } from "./profile";
import { unsupportedTechClaims } from "./claim-validation";

/**
 * CV ATS compatibility only.
 *
 * This is deliberately not a candidate suitability score and not a document
 * quality score. Suitability remains jobs.match_score (weighted profile/job
 * analysis); document quality remains the preservation gate in
 * document-quality.ts. A cover letter has no CV structure and is therefore
 * never scored with this rubric.
 */
export type AtsCheck = { key: string; label: string; ok: boolean; detail: string; weight: number };

export type AtsReport = {
  measurement: "cv_ats_compatibility";
  score: number;
  keywordCoverage: number;
  checks: AtsCheck[];
  missingKeywords: string[];
  missingRequirements: string[];
  recommendations: string[];
  warnings: string[];
  wordCount: number;
  engine: string;
  generatedAt: string;
  disclaimer: string;
};

export type AtsAssessmentInput = {
  text: string;
  jobDescription: string;
  jobTitle: string;
  jobCompany?: string;
  profile: ProfileData;
  sourceText?: string;
  sourceRoleCount?: number;
  analysis?: JobAnalysis | null;
};

const STOPWORDS = new Set(
  `the and for with you your our will are that this from have has can all not but who what their they them its it's about into over under more most other than then there here also experience work working role position team company job apply application candidate requirements responsibilities including within across using able strong good excellent knowledge years year plus etc must should would could may might ensure support develop developed develop support build built lead leading manage managing new well as at by in on of to a an is be or if while during per via such systems system software engineer engineering quality test testing qa senior`.split(
    /\s+/,
  ),
);

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z][a-z+#./-]{2,}/g) ?? [];
}

function keywords(text: string, excluded: Set<string>): string[] {
  const counts = new Map<string, number>();
  for (const raw of words(text)) {
    const word = raw.replace(/[./-]+$/, "");
    if (word.length < 3 || STOPWORDS.has(word) || excluded.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 28)
    .map(([word]) => word);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function contains(text: string, value: string): boolean {
  return text.includes(value.toLowerCase());
}

export function assessAts(input: AtsAssessmentInput): AtsReport {
  const text = input.text;
  const lower = text.toLowerCase();
  const wordList = text.split(/\s+/).filter(Boolean);
  const jobText = htmlToText(input.jobDescription);
  const companyWords = new Set(words(input.jobCompany ?? ""));
  const jobKeywords = keywords(`${input.jobTitle}\n${jobText}`, companyWords);
  const matchedKeywords = jobKeywords.filter((keyword) => contains(lower, keyword));
  const missingKeywords = jobKeywords.filter((keyword) => !contains(lower, keyword)).slice(0, 12);
  const keywordCoverage = jobKeywords.length ? Math.round((matchedKeywords.length / jobKeywords.length) * 100) : 0;

  const checks: AtsCheck[] = [];
  const push = (key: string, label: string, ok: boolean, detail: string, weight: number) => {
    checks.push({ key, label, ok, detail, weight });
  };

  const hasEmail = Boolean(input.profile.profile.email && lower.includes(input.profile.profile.email.toLowerCase()));
  const hasPhone = Boolean(input.profile.profile.phone && text.includes(input.profile.profile.phone));
  push(
    "contact",
    "Contact details",
    hasEmail || hasPhone,
    hasEmail && hasPhone
      ? "Email and phone are extractable."
      : hasEmail || hasPhone
        ? "Only one contact channel is present."
        : "No contact details were found.",
    7,
  );

  push("summary", "Professional summary", /professional summary|profile/i.test(text) && text.length > 200, "A summary section is detectable.", 6);
  push("skills", "Skills section", /core skills|technical skills|skills/i.test(text), "A skills section is detectable.", 6);
  push("experience", "Experience section", /professional experience|work experience|experience/i.test(text), "An experience section is detectable.", 7);
  const roleCount = input.sourceRoleCount ?? input.profile.experiences.length;
  push("history", "Employment history", roleCount > 0, roleCount ? `${roleCount} role(s) carried from the master CV.` : "No experience is recorded.", 7);
  push(
    "dates",
    "Employment dates",
    /(19|20)\d{2}|present|date to confirm/i.test(text),
    "Dates are rendered from the master CV; any 'Date to confirm' entry must be corrected at source.",
    7,
  );

  const titleTokens = words(input.jobTitle).filter(
    (token) => token.length > 2 && !/^(the|and|for|with|senior|junior|m|f|d|w)$/.test(token),
  );
  const titleHits = titleTokens.filter((token) => contains(lower, token)).length;
  const titleAligned = titleTokens.length > 0 && titleHits / titleTokens.length >= 0.6;
  push(
    "title",
    "Job-title alignment",
    titleAligned,
    titleTokens.length
      ? `${titleHits}/${titleTokens.length} title terms appear in the CV.`
      : "The vacancy title has no comparable terms.",
    7,
  );

  const requiredSkills = unique([
    ...(input.analysis?.matched ?? []),
    ...(input.analysis?.missing ?? []),
  ]);
  const matchedRequired = requiredSkills.filter((skill) => contains(lower, skill));
  const requiredRatio = requiredSkills.length ? matchedRequired.length / requiredSkills.length : 0;
  const requiredOk = requiredSkills.length > 0 && requiredRatio >= 0.6;
  push(
    "required_skills",
    "Required skills and technologies",
    requiredOk,
    requiredSkills.length
      ? `${matchedRequired.length}/${requiredSkills.length} analysed requirements appear in the CV.${input.analysis?.missing?.length ? ` Unverified: ${input.analysis.missing.slice(0, 4).join(", ")}.` : ""}`
      : "No skills were extracted from the vacancy analysis.",
    11,
  );

  const experienceText = /(?:19|20)\d{2}|present/i.test(text) && /experience|role|engineer|analyst|manager|lead/i.test(text);
  push(
    "relevant_experience",
    "Relevant experience evidenced",
    experienceText,
    experienceText ? "The CV contains dated role evidence." : "No dated, relevant role evidence is extractable.",
    7,
  );

  push(
    "terminology",
    "Job-specific terminology",
    keywordCoverage >= 55,
    `${keywordCoverage}% of the vacancy's most frequent terms appear in the CV.`,
    9,
  );

  const industryCriterion = input.analysis?.criteria.find((criterion) => criterion.key === "industry");
  const industryEvidence = /fintech|financial|payments?|bank|insurance|e-?commerce|health|telecom/i.test(input.sourceText ?? "");
  const industryOk = Boolean(industryCriterion && industryCriterion.score >= 70 && industryEvidence);
  push(
    "industry",
    "Relevant industry experience",
    industryOk,
    industryCriterion
      ? `${industryCriterion.label}: ${industryCriterion.score}/100. ${industryEvidence ? "Industry evidence is present in the master CV." : "No industry evidence is present in the master CV."}`
      : "No industry assessment is stored for this vacancy.",
    4,
  );

  const mandatoryBlockers = input.analysis?.mandatoryBlockers ?? [];
  push(
    "qualifications",
    "Required qualifications",
    mandatoryBlockers.length === 0,
    mandatoryBlockers.length ? mandatoryBlockers.slice(0, 3).join(" ") : "No mandatory qualification blocker is recorded.",
    4,
  );

  push(
    "readable_length",
    "ATS-readable length and layout",
    wordList.length >= 260 && wordList.length <= 1050,
    `${wordList.length} words; the internal target is 260–1050 words in a single-column layout.`,
    5,
  );

  const ownedSkills = input.profile.skills.map((skill) => skill.name);
  const unknownClaims = unsupportedTechClaims(
    text,
    `${input.sourceText ?? ""} ${input.profile.skills.map((skill) => skill.name).join(" ")}`,
    ownedSkills,
  );
  push(
    "supported_claims",
    "No unsupported technology claims",
    unknownClaims.length === 0,
    unknownClaims.length
      ? `Unverified technologies: ${unknownClaims.join(", ")}.`
      : "Every technology mentioned maps to the verified master CV or profile.",
    13,
  );

  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const earned = checks.filter((check) => check.ok).reduce((sum, check) => sum + check.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round((earned / totalWeight) * 100)));

  const warnings: string[] = [];
  if (missingKeywords.length) warnings.push(`Not present in the CV: ${missingKeywords.slice(0, 6).join(", ")}.`);
  if (!hasEmail) warnings.push("Add an email address to the master profile so every generated CV carries contact details.");
  if (!hasPhone) warnings.push("Add a phone number to the master profile.");
  if (unknownClaims.length) warnings.push(`The CV references unsupported technologies: ${unknownClaims.join(", ")}.`);
  if (mandatoryBlockers.length) warnings.push(`Mandatory requirements remain unresolved: ${mandatoryBlockers.slice(0, 3).join(" ")}`);

  const recommendations = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.label}: ${check.detail} ${recommendationFor(check.key)}`);
  if (missingKeywords.length) {
    recommendations.push(`Add genuinely evidenced vacancy terminology where it is factually accurate: ${missingKeywords.slice(0, 6).join(", ")}.`);
  }

  return {
    measurement: "cv_ats_compatibility",
    score,
    keywordCoverage,
    checks,
    missingKeywords,
    missingRequirements: unique(input.analysis?.missing ?? []),
    recommendations: unique(recommendations),
    warnings: unique(warnings),
    wordCount: wordList.length,
    engine: "ats-rules-v2",
    generatedAt: new Date().toISOString(),
    disclaimer:
      "Internal CV ATS compatibility assessment against this platform's rules. It is not a guarantee of passing any employer's applicant tracking system, and it is separate from candidate-to-job suitability and document quality.",
  };
}

function recommendationFor(key: string): string {
  switch (key) {
    case "contact":
      return "Complete the verified profile contact details and regenerate.";
    case "summary":
      return "Keep the summary section rendered; do not remove it during tailoring.";
    case "skills":
      return "Keep the skills section extracted from the master CV.";
    case "experience":
      return "Keep the professional experience section and all roles.";
    case "history":
      return "Restore the master CV roles before regenerating.";
    case "dates":
      return "Correct missing dates in the master profile; never invent them.";
    case "title":
      return "Use the vacancy title in the summary or headline only when it reflects the candidate's actual role.";
    case "required_skills":
      return "Review genuinely missing requirements; do not add unverified tools.";
    case "relevant_experience":
      return "Ensure dated role evidence is extractable from the PDF.";
    case "terminology":
      return "Use relevant, factually supported vacancy terminology without keyword stuffing.";
    case "industry":
      return "Add verified industry context only if it is present in the original CV.";
    case "qualifications":
      return "Resolve the mandatory qualification gap or do not submit this application.";
    case "readable_length":
      return "Keep the CV in a single-column, text-extractable layout within the length target.";
    case "supported_claims":
      return "Remove the unsupported technology or add verified evidence at source.";
    default:
      return "";
  }
}
