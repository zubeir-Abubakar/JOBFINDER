import type { CoverLetterContent, TailoredCv } from "./document-ai";
import type { MasterCv } from "./master-cv";

export type QualitySeverity = "error" | "warning";

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

function finalise(checks: QualityCheck[], issues: QualityIssue[], metrics: DocumentQuality["metrics"]): DocumentQuality {
  const errors = issues.filter((item) => item.severity === "error").length;
  const warnings = issues.length - errors;
  const score = Math.max(0, Math.min(100, 100 - errors * 20 - warnings * 5));
  const status: DocumentQuality["status"] = errors > 0 || score < 70 ? "failed" : warnings > 0 || score < 90 ? "warning" : "passed";
  return { status, score, checks, issues, metrics, checkedAt: new Date().toISOString() };
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

  const keyMismatch = output.roles.filter((role) => !master.roles.some((item) => item.key === role.key));
  checks.push(check("No invented employment entries", keyMismatch.length === 0, keyMismatch.length ? `${keyMismatch.length} unrecognised roles` : "Every output role maps to the master CV"));
  if (keyMismatch.length > 0) issues.push(issue("error", "invented_roles", `Unrecognised roles: ${keyMismatch.map((role) => role.title).join("; ")}`));

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

  const certsMissing = master.certifications.filter((cert) => !text.includes(normalise(cert)));
  if (certsMissing.length > 0) issues.push(issue("error", "missing_certifications", `Missing certifications: ${certsMissing.join("; ")}`));
  const educationMissing = master.education.filter((item) => !text.includes(normalise(item.title)));
  if (educationMissing.length > 0) issues.push(issue("error", "missing_education", `Missing education: ${educationMissing.map((item) => item.title).join("; ")}`));

  if (output.warnings.length > 0) {
    for (const warning of output.warnings) issues.push(issue("warning", "ai_fallback", warning));
  }
  if (!output.tailoredWithAi) {
    issues.push(issue("warning", "deterministic_tailoring", "AI revision was unavailable or rejected; the complete master CV was used with deterministic prioritisation."));
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
  job: { title: string; company: string },
): DocumentQuality {
  const text = normalise(extractedText);
  const letter = output.paragraphs.join(" ");
  const checks: QualityCheck[] = [];
  const issues: QualityIssue[] = [];
  const outputWords = words(letter);

  const hasName = text.includes(normalise(master.name));
  const hasRole = text.includes(normalise(job.title)) || text.includes(normalise(job.company));
  checks.push(check("Header and target role present", hasName && hasRole, hasName ? "Candidate header and target role are extractable" : "Candidate header is missing"));
  if (!hasName) issues.push(issue("error", "missing_header", "The cover letter header is missing the candidate name."));
  if (!hasRole) issues.push(issue("error", "missing_target", "The cover letter does not identify the target role or employer."));

  checks.push(check("Letter length", outputWords >= 150 && outputWords <= 380, `${outputWords} words`));
  if (outputWords < 150) issues.push(issue("error", "too_short", "The cover letter is too short to present evidence."));
  if (outputWords > 380) issues.push(issue("error", "too_long", "The cover letter is too long for a concise application."));

  const generic = /^(i am writing to (?:apply|express)|i am excited to apply|as a (?:seasoned|passionate|results-driven) professional)/i.test(
    output.paragraphs[0] ?? "",
  );
  checks.push(check("No generic opening", !generic, generic ? "Generic opening detected" : "Opens with a role-specific argument"));
  if (generic) issues.push(issue("error", "generic_opening", "The opening is generic."));

  const sourceMetrics = new Set(metricTokens(master.sourceText));
  const titleMetrics = new Set(metricTokens(`${job.title} ${job.company}`));
  const outputMetrics = [...new Set(metricTokens(letter))];
  const inventedMetrics = outputMetrics.filter((metric) => !sourceMetrics.has(metric) && !titleMetrics.has(metric));
  checks.push(check("Achievements are verified", outputMetrics.length > 0 && inventedMetrics.length === 0, outputMetrics.length ? `${outputMetrics.length} verified metric(s): ${outputMetrics.join(", ")}` : "No measurable achievement cited"));
  if (outputMetrics.length === 0) issues.push(issue("error", "no_evidence", "No measurable, verified achievement is cited."));
  if (inventedMetrics.length > 0) issues.push(issue("error", "invented_metrics", `Unsupported metrics: ${inventedMetrics.join(", ")}`));

  const contactMissing = master.contact.filter((value) => {
    if (!value.includes("@")) return false;
    return !text.includes(normalise(value));
  });
  checks.push(check("Contact identity matches CV", contactMissing.length === 0, contactMissing.length ? "Email missing" : "Email matches the CV header"));
  if (contactMissing.length > 0) issues.push(issue("error", "missing_contact", "The cover letter header is missing the CV email."));

  checks.push(check("Cover letter fits its page budget", pages >= 1 && pages <= 2, `${pages} page(s)`));
  if (pages === 0) issues.push(issue("error", "empty_pdf", "No rendered page was produced."));
  if (pages > 2) issues.push(issue("warning", "cover_too_long", "The cover letter exceeds two pages."));

  if (!output.tailoredWithAi) {
    issues.push(issue("warning", "deterministic_cover", "AI cover-letter revision was unavailable or rejected; the deterministic evidence-led letter was used."));
  }
  if (output.warnings.length > 0) {
    for (const warning of output.warnings) issues.push(issue("warning", "ai_fallback", warning));
  }

  return finalise(checks, issues, {
    originalRoles: master.roles.length,
    outputRoles: master.roles.length,
    originalBullets: master.roles.reduce((sum, role) => sum + role.bullets.length, 0),
    outputBullets: master.roles.reduce((sum, role) => sum + role.bullets.length, 0),
    outputWords,
    pages,
  });
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
