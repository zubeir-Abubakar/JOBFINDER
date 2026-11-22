import type { CoverLetterContent, TailoredCv } from "./document-ai";
import type { MasterCv } from "./master-cv";
import type { JobAnalysis } from "./scoring";
import {
  coverLetterBody,
  coverLetterLengthIssues,
  letterBodyFromRenderedText,
  measureCoverLetterText,
  resolveCoverLetterRequirements,
  type CoverLetterRequirements,
} from "./cover-letter-requirements";
import {
  claimsNoSponsorship,
  claimsRequiresSponsorship,
  hasGenericCoverLanguage,
  hasKeywordStuffing,
  hasSwissPermitB,
  mentionsSalaryExpectation,
  unsupportedTechClaims,
  workAuthorisationRequired,
} from "./claim-validation";

export type QualitySeverity = "error" | "warning" | "info";

export type QualityIssue = {
  severity: QualitySeverity;
  code: string;
  message: string;
};

export type QualityCheck = {
  label: string;
  passed: boolean;
  detail: string;
};

export type DocumentQuality = {
  status: "passed" | "warning" | "failed";
  score: number;
  checks: QualityCheck[];
  issues: QualityIssue[];
  metrics: {
    originalRoles: number;
    outputRoles: number;
    originalBullets: number;
    outputBullets: number;
    outputWords: number;
    pages: number;
  };
  /** Persisted with the cover-letter quality report for audit and readiness. */
  coverLetter?: {
    requirements: CoverLetterRequirements;
    actualWords: number;
    actualCharacters: number;
    renderedBodyVerified: boolean;
  };
  checkedAt: string;
};

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

function metricTokens(value: string): string[] {
  return (
    value.match(
      /\b\d+(?:\.\d+)?\+?\s*(?:%|percent|hours?|hrs?|minutes?|days?|weeks?|months?|tests?|cases?|engineers?|people?|users?|clients?|countries?|projects?|releases?)(?![A-Za-z])/gi,
    ) ?? []
  ).map((token) => token.toLowerCase().replace(/\s+/g, " "));
}

function check(label: string, passed: boolean, detail: string): QualityCheck {
  return { label, passed, detail };
}

function issue(severity: QualitySeverity, code: string, message: string): QualityIssue {
  return { severity, code, message };
}

function finalise(
  checks: QualityCheck[],
  issues: QualityIssue[],
  metrics: DocumentQuality["metrics"],
  coverLetter?: DocumentQuality["coverLetter"],
): DocumentQuality {
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.filter((item) => item.severity === "warning").length;
  const score = Math.max(0, Math.min(100, 100 - errors * 20 - warnings * 5));
  const status: DocumentQuality["status"] = errors > 0 || score < 70 ? "failed" : warnings > 0 || score < 90 ? "warning" : "passed";
  return { status, score, checks, issues, metrics, coverLetter, checkedAt: new Date().toISOString() };
}

/**
 * The quality gate refuses an output that drops roles, sections, contact data
 * or verified achievements, introduces unsupported metrics, or breaks pagination.
 * It deliberately checks the PDF-extracted text, not the model object, so clipped
 * or missing text cannot pass on the strength of the intended model.
 */
export function validateCvQuality(
  master: MasterCv,
  output: TailoredCv,
  extractedText: string,
  pages: number,
  target?: { title: string; company: string },
): DocumentQuality {
  const text = normalise(extractedText);
  const originalBullets = master.roles.reduce((sum, role) => sum + role.bullets.length, 0);
  const outputBullets = output.roles.reduce((sum, role) => sum + role.bullets.length, 0);
  const checks: QualityCheck[] = [];
  const issues: QualityIssue[] = [];

  const missingRoles = master.roles.filter((role) => {
    const title = normalise(role.title);
    const company = normalise(role.company);
    return !(text.includes(title) && text.includes(company));
  });
  checks.push(check("All employment entries retained", missingRoles.length === 0, `${master.roles.length - missingRoles.length}/${master.roles.length} roles found in extracted PDF text`));
  if (missingRoles.length > 0) issues.push(issue("error", "missing_roles", `Missing roles: ${missingRoles.map((role) => `${role.title} at ${role.company}`).join("; ")}`));

  const duplicateRoles = output.roles.filter((role, index) =>
    output.roles.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        normalise(other.title) === normalise(role.title) &&
        normalise(other.company) === normalise(role.company),
    ),
  );
  checks.push(
    check(
      "No duplicated experience",
      duplicateRoles.length === 0,
      duplicateRoles.length ? `${duplicateRoles.length} repeated role(s)` : "Every role appears once",
    ),
  );
  if (duplicateRoles.length > 0) {
    issues.push(issue("error", "duplicate_roles", `Repeated employment entries: ${duplicateRoles.map((role) => `${role.title} at ${role.company}`).join("; ")}`));
  }

  const keyMismatch = output.roles.filter((role) => !master.roles.some((item) => item.key === role.key));
  checks.push(check("No invented employment entries", keyMismatch.length === 0, keyMismatch.length ? `${keyMismatch.length} unrecognised roles` : "Every output role maps to the master CV"));
  if (keyMismatch.length > 0) issues.push(issue("error", "invented_roles", `Unrecognised roles: ${keyMismatch.map((role) => role.title).join("; ")}`));

  const namePresent = Boolean(master.name.trim()) && text.includes(normalise(master.name));
  checks.push(check("Candidate identity preserved", namePresent, namePresent ? "The master CV name is extractable" : "The master CV name is missing"));
  if (!namePresent) issues.push(issue("error", "missing_name", "The generated CV does not carry the candidate name from the master CV."));

  const missingDates = master.roles.filter((role) => {
    const years = role.dates.match(/\b(?:19|20)\d{2}\b/g) ?? [];
    return years.some((year) => !text.includes(year));
  });
  checks.push(check("Employment dates preserved", missingDates.length === 0, missingDates.length ? `Missing dates: ${missingDates.map((role) => role.title).join("; ")}` : "Every master-CV employment year is extractable"));
  if (missingDates.length > 0) issues.push(issue("error", "missing_dates", `Employment dates were lost for: ${missingDates.map((role) => role.title).join("; ")}`));

  const unsupportedTech = unsupportedTechClaims(
    extractedText,
    master.sourceText,
    master.skillGroups.flatMap((group) => group.values),
  );
  checks.push(check("No unsupported technology claims", unsupportedTech.length === 0, unsupportedTech.length ? `Unsupported: ${unsupportedTech.join(", ")}` : "Every technology maps to the master CV"));
  if (unsupportedTech.length > 0) issues.push(issue("error", "unsupported_technology", `The generated CV mentions technologies absent from the master CV: ${unsupportedTech.join(", ")}.`));

  checks.push(check("Bullet-level history preserved", outputBullets >= originalBullets, `${outputBullets}/${originalBullets} bullets retained`));
  if (outputBullets < originalBullets) issues.push(issue("error", "lost_bullets", `${originalBullets - outputBullets} original achievement bullets are missing.`));

  const sectionLabels = [
    ...master.skillGroups.map((group) => group.label),
    "Professional Summary",
    "Professional Experience",
  ];
  if (master.certifications.length) sectionLabels.push("Certifications");
  if (master.education.length) sectionLabels.push("Education");
  if (master.languages) sectionLabels.push("Languages");
  const missingSections = sectionLabels.filter((label) => !text.includes(normalise(label)));
  checks.push(check("Sections preserved", missingSections.length === 0, missingSections.length ? `Missing: ${missingSections.join(", ")}` : `${sectionLabels.length} sections found`));
  if (missingSections.length > 0) issues.push(issue("error", "missing_sections", `Missing sections: ${missingSections.join(", ")}`));

  const contactMissing = master.contact.filter((value) => {
    const clean = normalise(value);
    if (!clean) return false;
    if (clean.includes("@")) return !text.includes(clean);
    const digits = clean.replace(/\D/g, "");
    return digits.length >= 7 ? !text.replace(/\D/g, "").includes(digits.slice(-7)) : !text.includes(clean);
  });
  checks.push(check("Contact information present", contactMissing.length === 0, contactMissing.length ? `Missing: ${contactMissing.join(", ")}` : "Email, phone and profile links are extractable"));
  if (contactMissing.length > 0) issues.push(issue("error", "missing_contact", `Missing contact details: ${contactMissing.join(", ")}`));

  const sourceMetrics = new Set(metricTokens(master.sourceText));
  const titleMetrics = new Set(metricTokens(`${target?.title ?? ""} ${target?.company ?? ""}`));
  const outputMetrics = [...new Set(metricTokens(extractedText))];
  const inventedMetrics = outputMetrics.filter((metric) => !sourceMetrics.has(metric) && !titleMetrics.has(metric));
  const metricsOk = inventedMetrics.length === 0 && (sourceMetrics.size === 0 || outputMetrics.length > 0);
  checks.push(check("No invented metrics", metricsOk, inventedMetrics.length ? `Unsupported: ${inventedMetrics.join(", ")}` : `${outputMetrics.length} metric tokens match the master CV`));
  if (inventedMetrics.length > 0) issues.push(issue("error", "invented_metrics", `Unsupported metrics in the PDF: ${inventedMetrics.join(", ")}`));
  if (sourceMetrics.size > 0 && outputMetrics.length === 0) issues.push(issue("error", "metrics_lost", "The master CV contains measurable achievements, but none are extractable from the generated PDF."));

  const originalWords = Math.max(words(master.sourceText), master.wordCount);
  const outputWords = words(extractedText);
  const minimumWords = Math.max(250, Math.floor(originalWords * 0.7));
  checks.push(check("Substantive detail retained", outputWords >= minimumWords, `${outputWords} words vs ${originalWords} in the master; minimum ${minimumWords}`));
  if (outputWords < minimumWords) issues.push(issue("error", "too_short", `The generated CV is materially shorter (${outputWords} words) than the master (${originalWords} words).`));

  const expectedPages = originalWords > 500 ? 2 : 1;
  checks.push(check("Multi-page layout retained", pages >= expectedPages, `${pages} page(s); expected at least ${expectedPages}`));
  if (pages < expectedPages) issues.push(issue("error", "page_loss", `The master needs at least ${expectedPages} pages; the generated PDF has ${pages}.`));

  if (master.languages) {
    const languageNames = master.languages.split(/[,;|]/).map((entry) => normalise(entry.replace(/[()\[\]]/g, " "))).filter(Boolean);
    const languagesMissing = languageNames.filter((entry) => entry.split(/[^a-z]+/).filter((word) => word.length > 2).some((word) => !text.includes(word)));
    checks.push(check("Language proficiency retained", languagesMissing.length === 0, languagesMissing.length ? `Missing: ${languagesMissing.join(", ")}` : "Recorded language levels are extractable"));
    if (languagesMissing.length > 0) issues.push(issue("warning", "missing_languages", `Language evidence is missing from the PDF: ${languagesMissing.join("; ")}`));
  }

  const certsMissing = master.certifications.filter((cert) => !text.includes(normalise(cert)));
  if (certsMissing.length > 0) issues.push(issue("error", "missing_certifications", `Missing certifications: ${certsMissing.join("; ")}`));
  const educationMissing = master.education.filter((item) => !text.includes(normalise(item.title)));
  if (educationMissing.length > 0) issues.push(issue("error", "missing_education", `Missing education: ${educationMissing.map((item) => item.title).join("; ")}`));

  if (output.warnings.length > 0) {
    for (const warning of output.warnings) issues.push(issue("info", "ai_provenance", warning));
  }
  if (!output.tailoredWithAi) {
    issues.push(issue("info", "deterministic_tailoring", "AI revision was unavailable or rejected; the complete master CV was used with deterministic prioritisation. Provenance is recorded, but it does not lower factual document quality."));
  }

  return finalise(checks, issues, {
    originalRoles: master.roles.length,
    outputRoles: output.roles.length,
    originalBullets,
    outputBullets,
    outputWords,
    pages,
  });
}

export function validateCoverQuality(
  master: MasterCv,
  output: CoverLetterContent,
  extractedText: string,
  pages: number,
  job: {
    title: string;
    company: string;
    description?: string;
    analysis?: JobAnalysis | null;
    coverLetterRequirements?: CoverLetterRequirements;
  },
): DocumentQuality {
  const text = normalise(extractedText);
  const letter = output.paragraphs.join(" ");
  const checks: QualityCheck[] = [];
  const issues: QualityIssue[] = [];
  const requirements =
    job.coverLetterRequirements ?? resolveCoverLetterRequirements({ description: job.description });
  const expectedBodySegments = [output.salutation, ...output.paragraphs, output.closing]
    .map((segment) => normalise(segment))
    .filter(Boolean);
  const missingBodySegments = expectedBodySegments.filter((segment) => !text.includes(segment));
  const renderedBodyVerified = missingBodySegments.length === 0;
  const renderedBody = letterBodyFromRenderedText(extractedText);
  const measurement = measureCoverLetterText(renderedBodyVerified ? renderedBody : coverLetterBody(output));
  const outputWords = measurement.words;
  checks.push(
    check(
      "Rendered letter body is complete",
      renderedBodyVerified,
      renderedBodyVerified
        ? "Salutation, every paragraph and the closing are extractable from the rendered document"
        : `${missingBodySegments.length} letter segment(s) are missing or clipped in the rendered document`,
    ),
  );
  if (!renderedBodyVerified) {
    issues.push(
      issue(
        "error",
        "rendered_body_incomplete",
        "The rendered cover letter is missing or clipping part of its salutation, body or closing.",
      ),
    );
  }

  const hasName = text.includes(normalise(master.name));
  const roleTokens = normalise(job.title)
    .split(/[^a-z0-9+#.]+/)
    .filter((token) => token.length > 2 && !/^(the|and|for|with|senior|junior|m|f|d|w)$/.test(token));
  const roleHits = roleTokens.filter((token) => text.includes(token)).length;
  const hasRole =
    text.includes(normalise(job.company)) &&
    (text.includes(normalise(job.title)) || (roleTokens.length > 0 && roleHits / roleTokens.length >= 0.6));
  const hasDate = /\b(?:19|20)\d{2}\b/.test(extractedText);
  checks.push(check("Header and target role present", hasName && hasRole, hasName ? "Candidate header and target role are extractable" : "Candidate header is missing"));
  if (!hasName) issues.push(issue("error", "missing_header", "The cover letter header is missing the candidate name."));
  if (!hasRole) issues.push(issue("error", "missing_target", "The cover letter does not identify both the target role and the employer."));
  checks.push(check("Dated letter", hasDate, hasDate ? "A four-digit year is present" : "No letter date is extractable"));
  if (!hasDate) issues.push(issue("warning", "missing_date", "The cover letter has no extractable date."));

  const lengthIssues = coverLetterLengthIssues(measurement, requirements);
  const lengthLabel = requirements.source === "recruiter"
    ? "Letter length matches the recruiter requirement"
    : "Letter length matches the professional default";
  const limitParts = [
    requirements.minWords !== null ? `min ${requirements.minWords} words` : "",
    requirements.maxWords !== null ? `max ${requirements.maxWords} words` : "",
    requirements.minCharacters !== null ? `min ${requirements.minCharacters} characters` : "",
    requirements.maxCharacters !== null ? `max ${requirements.maxCharacters} characters` : "",
  ].filter(Boolean);
  checks.push(
    check(
      lengthLabel,
      lengthIssues.length === 0,
      `${outputWords} words / ${measurement.characters} characters; ${limitParts.join(", ") || "no limit"}; ${
        requirements.source === "recruiter"
          ? `explicit recruiter instruction${requirements.evidence.length ? `: ${requirements.evidence[0]}` : ""}`
          : "internal professional default — not a recruiter requirement"
      }`,
    ),
  );
  for (const lengthIssue of lengthIssues) {
    issues.push(issue("error", lengthIssue.code, lengthIssue.message));
  }

  const genericOpening = hasGenericCoverLanguage(output.paragraphs[0] ?? "");
  checks.push(check("No generic opening", !genericOpening, genericOpening ? "Generic opening detected" : "Opens with a role-specific argument"));
  if (genericOpening) issues.push(issue("error", "generic_opening", "The opening uses generic application language."));

  const genericFiller = output.paragraphs.slice(1).some((paragraph) => hasGenericCoverLanguage(paragraph));
  checks.push(check("No generic AI phrasing", !genericFiller, genericFiller ? "Generic filler was detected in the body" : "Body paragraphs use vacancy-specific evidence"));
  if (genericFiller) issues.push(issue("warning", "generic_phrasing", "The body contains generic or repetitive AI-style phrasing."));

  const stuffed = hasKeywordStuffing(letter, 6);
  checks.push(check("No keyword stuffing", !stuffed, stuffed ? "A long comma-separated keyword run was detected" : "Skills are integrated into sentences"));
  if (stuffed) issues.push(issue("error", "keyword_stuffing", "The cover letter contains a keyword list rather than integrated evidence."));

  const requirementTerms = [...new Set((job.analysis?.matched ?? []).map((item) => normalise(item)).filter(Boolean))].slice(0, 6);
  const requirementHits = requirementTerms.filter((term) => text.includes(term)).length;
  const requiredHits = Math.min(2, requirementTerms.length);
  const requirementsAddressed = requirementTerms.length === 0 || requirementHits >= requiredHits;
  checks.push(
    check(
      "Addresses vacancy requirements",
      requirementsAddressed,
      requirementTerms.length
        ? `${requirementHits}/${requirementTerms.length} analysed requirements are referenced${requiredHits ? `; at least ${requiredHits} required` : ""}`
        : "No analysed requirement terms were supplied",
    ),
  );
  if (!requirementsAddressed) issues.push(issue("warning", "requirements_not_addressed", "The letter does not address enough of the vacancy's analysed requirements."));

  const sourceMetrics = new Set(metricTokens(master.sourceText));
  const titleMetrics = new Set(metricTokens(`${job.title} ${job.company}`));
  const outputMetrics = [...new Set(metricTokens(letter))];
  const inventedMetrics = outputMetrics.filter((metric) => !sourceMetrics.has(metric) && !titleMetrics.has(metric));
  checks.push(check("Achievements are verified", outputMetrics.length > 0 && inventedMetrics.length === 0, outputMetrics.length ? `${outputMetrics.length} verified metric(s): ${outputMetrics.join(", ")}` : "No measurable achievement cited"));
  if (outputMetrics.length === 0) issues.push(issue("error", "no_evidence", "No measurable, verified achievement is cited."));
  if (inventedMetrics.length > 0) issues.push(issue("error", "invented_metrics", `Unsupported metrics: ${inventedMetrics.join(", ")}`));

  const unsupportedTech = unsupportedTechClaims(
    letter,
    master.sourceText,
    master.skillGroups.flatMap((group) => group.values),
  );
  checks.push(check("No unsupported technology claims", unsupportedTech.length === 0, unsupportedTech.length ? `Unsupported: ${unsupportedTech.join(", ")}` : "Every technology maps to the master CV"));
  if (unsupportedTech.length > 0) issues.push(issue("error", "unsupported_technology", `The cover letter mentions technologies absent from the master CV: ${unsupportedTech.join(", ")}.`));

  const permitB = hasSwissPermitB(master.permit);
  const authorisationRequired = workAuthorisationRequired(job.description ?? "");
  const sponsorshipClaim = claimsRequiresSponsorship(letter);
  const noSponsorshipClaim = claimsNoSponsorship(letter);
  const authorisationMentioned = /\b(?:permit\s*b|work\s+authoris|work\s+authoriz|right\s+to\s+work|sponsorship)\b/i.test(letter);
  const authorisationOk = !sponsorshipClaim && (!authorisationRequired || !permitB || authorisationMentioned);
  checks.push(
    check(
      "Work authorisation is accurate",
      authorisationOk,
      sponsorshipClaim && permitB
        ? "A sponsorship requirement conflicts with the verified Permit B"
        : authorisationRequired && permitB && !authorisationMentioned
          ? "The vacancy asks about work authorisation; the verified Permit B is not stated"
          : noSponsorshipClaim
            ? "The letter states that no employer sponsorship is required"
            : "No inaccurate authorisation claim was found",
    ),
  );
  if (sponsorshipClaim && permitB) issues.push(issue("error", "authorisation_conflict", "The letter says employer sponsorship is required, but the verified profile holds a Swiss Permit B with work authorisation."));
  if (authorisationRequired && permitB && !authorisationMentioned) issues.push(issue("warning", "authorisation_omitted", "The vacancy asks about work authorisation; state the verified Swiss Permit B and that no employer sponsorship is required."));
  if (authorisationRequired && !permitB) issues.push(issue("warning", "authorisation_unverified", "The vacancy asks about work authorisation, but no verified permit is recorded in the profile."));

  const salaryMentioned = mentionsSalaryExpectation(letter);
  checks.push(check("No unauthorised salary statement", !salaryMentioned, salaryMentioned ? "Salary or compensation is mentioned" : "No salary expectation is stated"));
  if (salaryMentioned) issues.push(issue("error", "salary_mentioned", "The cover letter mentions salary or compensation without explicit authorisation."));

  const contactMissing = master.contact.filter((value) => {
    if (!value.includes("@")) return false;
    return !text.includes(normalise(value));
  });
  checks.push(check("Contact identity matches CV", contactMissing.length === 0, contactMissing.length ? "Email missing" : "Email matches the CV header"));
  if (contactMissing.length > 0) issues.push(issue("error", "missing_contact", "The cover letter header is missing the CV email."));

  const explicitPageLimit = requirements.maxPages;
  const pageLimitPassed = pages >= 1 && (explicitPageLimit === null ? pages <= 2 : pages <= explicitPageLimit);
  checks.push(
    check(
      explicitPageLimit === null ? "Cover letter fits its page budget" : "Cover letter meets the recruiter page limit",
      pageLimitPassed,
      explicitPageLimit === null ? `${pages} page(s)` : `${pages} page(s) against an explicit maximum of ${explicitPageLimit}`,
    ),
  );
  if (pages === 0) issues.push(issue("error", "empty_pdf", "No rendered page was produced."));
  if (explicitPageLimit !== null && pages > explicitPageLimit) {
    issues.push(issue("error", "page_limit_exceeded", `The recruiter allows at most ${explicitPageLimit} page(s); the rendered letter has ${pages}.`));
  } else if (explicitPageLimit === null && pages > 2) {
    issues.push(issue("warning", "cover_too_long", "The cover letter exceeds two pages."));
  }
  if (requirements.supportingDocuments.length > 0) {
    issues.push(
      issue(
        "error",
        "missing_supporting_documents",
        `The recruiter requests supporting document(s) that this package does not create: ${requirements.supportingDocuments.join(", ")}. A human must verify and attach them before any submission.`,
      ),
    );
  }
  if (requirements.uncertain.length > 0) {
    issues.push(issue("warning", "uncertain_requirements", `Recruiter instructions need verification: ${requirements.uncertain.join(" ")}`));
  }

  if (!output.tailoredWithAi) {
    issues.push(issue("info", "deterministic_cover", "AI cover-letter revision was unavailable or rejected; the deterministic evidence-led letter was used. Provenance is recorded without lowering factual quality."));
  }
  if (output.warnings.length > 0) {
    for (const warning of output.warnings) issues.push(issue("info", "ai_provenance", warning));
  }

  return finalise(
    checks,
    issues,
    {
      originalRoles: master.roles.length,
      outputRoles: master.roles.length,
      originalBullets: master.roles.reduce((sum, role) => sum + role.bullets.length, 0),
      outputBullets: master.roles.reduce((sum, role) => sum + role.bullets.length, 0),
      outputWords,
      pages,
    },
    {
      requirements,
      actualWords: measurement.words,
      actualCharacters: measurement.characters,
      renderedBodyVerified,
    },
  );
}

export function combinePackageQuality(cv: DocumentQuality, cover: DocumentQuality): DocumentQuality {
  const status =
    cv.status === "failed" || cover.status === "failed"
      ? "failed"
      : cv.status === "warning" || cover.status === "warning"
        ? "warning"
        : "passed";
  return {
    status,
    score: Math.min(cv.score, cover.score),
    checks: [...cv.checks.map((item) => ({ ...item, label: `CV: ${item.label}` })), ...cover.checks.map((item) => ({ ...item, label: `Cover: ${item.label}` }))],
    issues: [...cv.issues.map((item) => ({ ...item, code: `cv_${item.code}`, message: `CV: ${item.message}` })), ...cover.issues.map((item) => ({ ...item, code: `cover_${item.code}`, message: `Cover letter: ${item.message}` }))],
    metrics: {
      originalRoles: cv.metrics.originalRoles,
      outputRoles: cv.metrics.outputRoles,
      originalBullets: cv.metrics.originalBullets,
      outputBullets: cv.metrics.outputBullets,
      outputWords: cv.metrics.outputWords + cover.metrics.outputWords,
      pages: cv.metrics.pages + cover.metrics.pages,
    },
    checkedAt: new Date().toISOString(),
  };
}

export async function extractPdfForQuality(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const result = await extractText(pdf, { mergePages: false });
  const pageTexts = Array.isArray(result.text) ? result.text : [result.text];
  return { text: pageTexts.join("\n"), pages: pageTexts.length };
}

export function qualityReportMarkdown(quality: DocumentQuality, label: string): string {
  return [
    `# ${label}`,
    "",
    `Status: **${quality.status}**`,
    `Score: **${quality.score}/100**`,
    `Pages: ${quality.metrics.pages}`,
    `Roles: ${quality.metrics.outputRoles}/${quality.metrics.originalRoles}`,
    `Bullets: ${quality.metrics.outputBullets}/${quality.metrics.originalBullets}`,
    "",
    "## Checks",
    ...quality.checks.map((item) => `- [${item.passed ? "x" : " "}] ${item.label}: ${item.detail}`),
    "",
    "## Issues",
    ...(quality.issues.length
      ? quality.issues.map((item) => `- **${item.severity}** (${item.code}): ${item.message}`)
      : ["- None"]),
  ].join("\n");
}
