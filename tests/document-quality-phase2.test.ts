import test from "node:test";
import assert from "node:assert/strict";

import type { MasterCv } from "../lib/master-cv.ts";
import type { JobAnalysis } from "../lib/scoring.ts";
import type { ProfileData } from "../lib/profile.ts";
import { assessAts } from "../lib/ats.ts";
import { deterministicCoverLetter } from "../lib/document-ai.ts";
import { validateCoverQuality, validateCvQuality } from "../lib/document-quality.ts";
import { buildCoverLetterModel, buildCvModel, modelToText } from "../lib/docgen.ts";
import { evaluateReadiness } from "../lib/application-readiness.ts";
import { extractCoverLetterRequirements } from "../lib/cover-letter-requirements.ts";

const JOB = {
  title: "Senior QA Automation Engineer",
  company: "Swiss Payments AG",
  location: "Zürich, Switzerland",
  description: [
    "We are hiring a Senior QA Automation Engineer for our fintech payments platform.",
    "You will own Playwright test automation, API testing, release readiness and TypeScript test code.",
    "You will work with engineering and product teams on regression testing and quality gates.",
    "Swiss work authorisation is required; sponsorship is not offered.",
    "English is required.",
  ].join(" "),
};

const ANALYSIS: JobAnalysis = {
  score: 95,
  flag: "strong",
  breakdown: { technical: 0.95, experience: 0.9, seniority: 0.95, language: 1, location: 1, salary: 0.7 },
  weights: { technical: 35, experience: 25, seniority: 15, language: 10, location: 10, salary: 5 },
  matched: ["Playwright", "API testing", "Release readiness", "TypeScript"],
  missing: [],
  preferred: [],
  evidence: { technical: "Playwright, API testing and TypeScript", experience: "Five years in QA", seniority: "Senior", language: "English C1", location: "Swiss Permit B", salary: "Not stated" },
  concerns: [],
  recommendation: "Strong match.",
  seniority: "senior",
  yearsRequired: 5,
  languages: ["English"],
  workPermitNote: "Swiss Permit B is recorded.",
  criteria: [
    { key: "industry", label: "Industry/domain relevance", score: 85, weight: 0, evidence: "Fintech payments detected.", mandatory: false },
    { key: "mandatory", label: "Missing mandatory qualifications", score: 100, weight: 0, evidence: "No gap.", mandatory: true },
  ],
  mandatoryBlockers: [],
  preferences: [],
  classification: { category: "test_automation", label: "Test automation", isQa: true, testingIntensity: 1, responsibilities: ["Own test automation and release quality"] },
  engine: "scoring-v1",
  generatedAt: new Date().toISOString(),
};

const MASTER: MasterCv = {
  sourceId: "doc_master",
  sourceName: "master-cv.pdf",
  sourceText: [
    "Ada Lovelace — Senior QA Automation Engineer",
    "Zürich | ada@example.com | +41 79 000 00 00",
    "Swiss Permit B — authorised to work without employer sponsorship",
    "Senior QA engineer with fintech payments, mobile and API test automation experience.",
    "Playwright, Cypress, Selenium, TypeScript, API testing, release readiness, regression testing, CI/CD, Jira.",
    "Senior QA Engineer, Swiss Payments AG, Jan 2020 – Present",
    "Built Playwright suites that covered 120 payment scenarios and reduced release defects by 30%.",
    "Led API regression testing across 4 releases and cut feedback time from 3 days to 1 day.",
    "Introduced release-readiness evidence that gave engineering and product teams a clear go/no-go decision.",
    "QA Engineer, Mobile Money Ltd, Mar 2017 – Dec 2019",
    "Automated 80 mobile regression cases with Cypress and reduced manual test time by 25%.",
    "Worked with engineering teams on defect triage and quality gates for 6 releases.",
    "QA Engineer, Cloud Retail AG, Jun 2014 – Feb 2017",
    "Built Selenium regression suites for 70 checkout flows and reduced escaped defects by 18%.",
    "Coordinated release testing across web and mobile teams for 8 releases.",
    "Documented risk-based test plans and kept evidence available for product sign-off.",
    "Certifications",
    "ISTQB Certified Tester",
    "Education",
    "BSc Computer Science — University of Example 2016",
    "Languages",
    "English (C1) | French (B2)",
  ].join("\n"),
  name: "Ada Lovelace",
  headline: "Senior QA Automation Engineer",
  contact: ["Zürich", "ada@example.com", "+41 79 000 00 00"],
  permit: "Swiss Permit B — authorised to work without employer sponsorship",
  summary: "Senior QA engineer with fintech payments, mobile and API test automation experience. I combine hands-on Playwright and TypeScript delivery with release-risk analysis, evidence-based quality gates and clear reporting for engineering and product stakeholders.",
  skillGroups: [
    { label: "Automation", values: ["Playwright", "Cypress", "Selenium"] },
    { label: "Testing", values: ["API testing", "Regression testing", "Release readiness"] },
    { label: "Technical", values: ["TypeScript", "CI/CD", "Jira"] },
  ],
  roles: [
    {
      key: "swiss-payments|senior-qa|2020",
      title: "Senior QA Engineer",
      company: "Swiss Payments AG",
      location: "Zürich",
      dates: "Jan 2020 – Present",
      bullets: [
        "Built Playwright suites that covered 120 payment scenarios and reduced release defects by 30%.",
        "Led API regression testing across 4 releases and cut feedback time from 3 days to 1 day.",
        "Introduced release-readiness evidence that gave engineering and product teams a clear go/no-go decision.",
      ],
      note: null,
    },
    {
      key: "mobile-money|qa|2017",
      title: "QA Engineer",
      company: "Mobile Money Ltd",
      location: "Zürich",
      dates: "Mar 2017 – Dec 2019",
      bullets: [
        "Automated 80 mobile regression cases with Cypress and reduced manual test time by 25%.",
        "Worked with engineering teams on defect triage and quality gates for 6 releases.",
        "Documented risk-based test plans and kept evidence available for product sign-off.",
      ],
      note: null,
    },
    {
      key: "cloud-retail|qa|2014",
      title: "QA Engineer",
      company: "Cloud Retail AG",
      location: "Zürich",
      dates: "Jun 2014 – Feb 2017",
      bullets: [
        "Built Selenium regression suites for 70 checkout flows and reduced escaped defects by 18%.",
        "Coordinated release testing across web and mobile teams for 8 releases.",
        "Documented risk-based test plans and kept evidence available for product sign-off.",
      ],
      note: null,
    },
  ],
  certifications: ["ISTQB Certified Tester"],
  education: [{ title: "BSc Computer Science", date: "2016", institution: "University of Example" }],
  languages: "English (C1) | French (B2)",
  wordCount: 280,
  parsedFrom: "original",
};

const PROFILE = {
  profile: {
    id: 1,
    full_name: "Ada Lovelace",
    headline: "Senior QA Automation Engineer",
    email: "ada@example.com",
    phone: "+41 79 000 00 00",
    location: "Zürich",
    work_authorisation: "Swiss Permit B — authorised to work without employer sponsorship",
    permit_valid_until: null,
    summary: MASTER.summary,
    linkedin: null,
    website: null,
    languages: "English (C1)",
    languages_synced_at: null,
    cv_synced_source: null,
    preferences: null,
    source_cv_id: "doc_master",
    updated_at: null,
  },
  skills: [
    { id: 1, name: "Playwright", category: "Automation", level: "advanced", years: 4, verified: 1, source: "cv", sort: 0, deleted_at: null },
    { id: 2, name: "API testing", category: "Testing", level: "advanced", years: 5, verified: 1, source: "cv", sort: 1, deleted_at: null },
    { id: 3, name: "TypeScript", category: "Language", level: "working", years: 4, verified: 1, source: "cv", sort: 2, deleted_at: null },
  ],
  experiences: [],
  deletedExperiences: [],
  items: [],
  preferences: { titles: [], locations: [], min_salary: null, employment_types: [], remote_preference: "any", industries: [], languages: [], german_required: "avoid", french: "evaluate" },
  languages: ["English"],
  languageEntries: [{ name: "English", level: "C1" }],
} as unknown as ProfileData;

function tailoredCv(): string {
  const model = buildCvModel({
    master: MASTER,
    tailored: {
      summary: deterministicSummaryForTest(),
      roles: MASTER.roles,
      tailoredWithAi: false,
      provider: null,
      model: null,
      warnings: [],
    },
    job: JOB,
  });
  return modelToText(model);
}

function deterministicSummaryForTest(): string {
  return "Senior QA automation engineer with fintech payments experience, Playwright, API testing, release readiness and TypeScript. Built measurable regression improvements and led release-quality decisions across web and mobile products. I also maintain clear evidence for audit and stakeholder review.";
}

function coverText(): { content: ReturnType<typeof deterministicCoverLetter>; rendered: string } {
  const content = deterministicCoverLetter(MASTER, JOB, ANALYSIS);
  const rendered = modelToText(buildCoverLetterModel({ master: MASTER, cover: content, job: JOB }));
  return { content, rendered };
}

test("CV ATS compatibility is strong for a grounded CV and weak for an empty one", () => {
  const strong = assessAts({
    text: tailoredCv(),
    jobDescription: JOB.description,
    jobTitle: JOB.title,
    jobCompany: JOB.company,
    profile: PROFILE,
    sourceText: MASTER.sourceText,
    sourceRoleCount: MASTER.roles.length,
    analysis: ANALYSIS,
  });
  const weak = assessAts({
    text: "QA tester. Manual testing. I am available.",
    jobDescription: JOB.description,
    jobTitle: JOB.title,
    jobCompany: JOB.company,
    profile: PROFILE,
    sourceText: "Manual testing only.",
    sourceRoleCount: 1,
    analysis: ANALYSIS,
  });

  assert.equal(strong.measurement, "cv_ats_compatibility");
  assert.ok(strong.score >= 90, `expected a strong grounded CV to reach 90, got ${strong.score}`);
  assert.ok(weak.score < strong.score);
  assert.ok(weak.checks.some((check) => check.key === "required_skills" && !check.ok));
  assert.ok(weak.missingRequirements.length >= 0);
  assert.match(strong.disclaimer, /not a guarantee/i);
});

test("the cover letter is vacancy-specific, evidence-led and states the verified Permit B", () => {
  const { content, rendered } = coverText();
  const words = content.paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 180 && words <= 320, `cover letter was ${words} words`);
  assert.match(content.paragraphs.join(" "), /Swiss Permit B/);
  assert.match(content.paragraphs.join(" "), /do not require employer sponsorship/);
  assert.match(rendered, /Swiss Payments AG/);
  assert.doesNotMatch(content.paragraphs.join(" "), /salary|compensation|remuneration/i);

  const other = deterministicCoverLetter(MASTER, { ...JOB, title: "SDET", company: "Another Employer AG" }, ANALYSIS);
  assert.notDeepEqual(other.paragraphs, content.paragraphs);
  assert.match(other.paragraphs.join(" "), /Another Employer AG/);

  const quality = validateCoverQuality(MASTER, content, rendered, 1, { ...JOB, analysis: ANALYSIS });
  assert.equal(quality.status, "passed", quality.issues.map((issue) => issue.message).join(" "));
  assert.ok(quality.checks.some((check) => check.label === "Addresses vacancy requirements" && check.passed));
  assert.equal(quality.coverLetter?.requirements.source, "professional_default");
  assert.equal(quality.coverLetter?.renderedBodyVerified, true);
  assert.ok(quality.checks.some((check) => check.label === "Letter length matches the professional default" && check.passed));
});

test("recruiter-specific cover-letter limits override the professional default and are measured on the rendered body", () => {
  const { content, rendered } = coverText();
  const recruiterMaximum = extractCoverLetterRequirements(
    "Please attach a cover letter of no more than 120 words for this Senior QA Automation Engineer role.",
  );
  const tooLong = validateCoverQuality(MASTER, content, rendered, 1, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: recruiterMaximum,
  });
  assert.equal(tooLong.status, "failed");
  assert.ok(tooLong.issues.some((issue) => issue.code === "too_long"));
  assert.match(tooLong.issues.find((issue) => issue.code === "too_long")?.message ?? "", /recruiter requires at most 120 words/i);
  assert.equal(tooLong.coverLetter?.requirements.explicit, true);
  assert.ok((tooLong.coverLetter?.actualWords ?? 0) > 120);

  const recruiterMinimum = extractCoverLetterRequirements(
    "Your cover letter must contain at least 500 words and address the role in detail.",
  );
  const tooShort = validateCoverQuality(MASTER, content, rendered, 1, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: recruiterMinimum,
  });
  assert.equal(tooShort.status, "failed");
  assert.ok(tooShort.issues.some((issue) => issue.code === "too_short"));
  assert.match(tooShort.issues.find((issue) => issue.code === "too_short")?.message ?? "", /at least 500 words/i);

  const recruiterCharacters = extractCoverLetterRequirements(
    "Please keep your cover letter under 1,000 characters.",
  );
  const tooManyCharacters = validateCoverQuality(MASTER, content, rendered, 1, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: recruiterCharacters,
  });
  assert.equal(tooManyCharacters.status, "failed");
  assert.ok(tooManyCharacters.issues.some((issue) => issue.code === "characters_above_maximum"));
});

test("explicit page limits and requested supporting documents block readiness", () => {
  const { content, rendered } = coverText();
  const requirements = extractCoverLetterRequirements(
    "Please submit a cover letter of no more than one page in PDF format. Portfolio required.",
  );
  assert.equal(requirements.maxPages, 1);
  assert.ok(requirements.supportingDocuments.includes("portfolio"));
  const quality = validateCoverQuality(MASTER, content, rendered, 2, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: requirements,
  });
  assert.equal(quality.status, "failed");
  assert.ok(quality.issues.some((item) => item.code === "page_limit_exceeded"));
  assert.ok(quality.issues.some((item) => item.code === "missing_supporting_documents"));
  assert.match(quality.issues.find((item) => item.code === "missing_supporting_documents")?.message ?? "", /portfolio/i);
});

test("the quality gate verifies every rendered letter segment rather than trusting the intended model", () => {
  const { content, rendered } = coverText();
  const clipped = rendered.replace(content.paragraphs[2], "");
  const quality = validateCoverQuality(MASTER, content, clipped, 1, { ...JOB, analysis: ANALYSIS });
  assert.equal(quality.status, "failed");
  assert.ok(quality.issues.some((issue) => issue.code === "rendered_body_incomplete"));
  assert.equal(quality.coverLetter?.renderedBodyVerified, false);
});

test("a generic, salary-led cover letter is rejected and unsupported claims are detected", () => {
  const generic = {
    salutation: "Dear Hiring Team,",
    paragraphs: [
      "I am writing to apply for this role.",
      "I am excited to apply because I would be a great fit for your team.",
      "My background is a direct match and I would welcome the opportunity to discuss it.",
      "I expect a salary of CHF 140,000 and require employer sponsorship.",
    ],
    closing: "Sincerely,",
    tailoredWithAi: true,
    provider: "test",
    model: "fixture",
    warnings: [],
  };
  const rendered = [
    MASTER.name,
    MASTER.contact.join(" | "),
    JOB.company,
    JOB.title,
    "18 November 2026",
    ...generic.paragraphs,
    generic.closing,
  ].join("\n");
  const quality = validateCoverQuality(MASTER, generic, rendered, 1, { ...JOB, analysis: ANALYSIS });
  assert.equal(quality.status, "failed");
  assert.ok(quality.issues.some((issue) => issue.code === "generic_opening"));
  assert.ok(quality.issues.some((issue) => issue.code === "salary_mentioned"));
  assert.ok(quality.issues.some((issue) => issue.code === "authorisation_conflict"));
  assert.ok(quality.issues.some((issue) => issue.code === "no_evidence"));

  const withUnsupportedTech = {
    ...generic,
    paragraphs: [
      "The Senior QA Automation Engineer role at Swiss Payments AG needs reliable release evidence.",
      "As Senior QA Engineer at Swiss Payments AG, I built Playwright suites covering 120 payment scenarios and reduced release defects by 30%.",
      "I also used Kubernetes and Terraform for API testing and release readiness.",
      "I would value the chance to discuss the role.",
    ],
  };
  const unsupportedRendered = [
    MASTER.name,
    MASTER.contact.join(" | "),
    JOB.company,
    JOB.title,
    "18 November 2026",
    ...withUnsupportedTech.paragraphs,
    withUnsupportedTech.closing,
  ].join("\n");
  const unsupported = validateCoverQuality(MASTER, withUnsupportedTech, unsupportedRendered, 1, { ...JOB, analysis: ANALYSIS });
  assert.ok(unsupported.issues.some((issue) => issue.code === "unsupported_technology"));
});

test("the CV gate preserves roles, dates and facts and rejects invented technology", () => {
  const rendered = tailoredCv();
  const output = {
    summary: deterministicSummaryForTest(),
    roles: MASTER.roles,
    tailoredWithAi: false,
    provider: null,
    model: null,
    warnings: [],
  };
  const clean = validateCvQuality(MASTER, output, rendered, 2, JOB);
  assert.equal(clean.status, "passed", clean.issues.map((issue) => issue.message).join(" "));

  const missingRole = validateCvQuality(MASTER, output, rendered.replace("Mobile Money Ltd", ""), 2, JOB);
  assert.equal(missingRole.status, "failed");
  assert.ok(missingRole.issues.some((issue) => issue.code === "missing_roles"));

  const missingDate = validateCvQuality(MASTER, output, rendered.replace(/2017/g, ""), 2, JOB);
  assert.equal(missingDate.status, "failed");
  assert.ok(missingDate.issues.some((issue) => issue.code === "missing_dates"));

  const inventedTech = validateCvQuality(MASTER, output, `${rendered}\nKubernetes and Terraform`, 2, JOB);
  assert.equal(inventedTech.status, "failed");
  assert.ok(inventedTech.issues.some((issue) => issue.code === "unsupported_technology"));
});

function readinessInput(overrides: Record<string, unknown> = {}) {
  const { rendered } = coverText();
  return {
    job: {
      title: JOB.title,
      company: JOB.company,
      location: JOB.location,
      application_url: "https://swisspayments.example/jobs/42",
      url: "https://swisspayments.example/jobs/42",
      published_at: "2026-11-18T08:00:00.000Z",
      description: JOB.description,
      eligibility: "eligible",
      eligibilityNotes: JSON.stringify({ blockers: [] }),
      matchScore: 95,
      analysis: ANALYSIS,
    },
    application: { id: "app_1", status: "quality_check", submittedAt: null },
    profile: {
      fullName: MASTER.name,
      email: "ada@example.com",
      phone: "+41 79 000 00 00",
      workAuthorisation: MASTER.permit,
      skills: PROFILE.skills.map((skill) => skill.name),
      certifications: MASTER.certifications,
      languages: ["English C1", "French B2"],
      sourceText: MASTER.sourceText,
    },
    cv: {
      id: "doc_cv",
      text: tailoredCv(),
      qualityStatus: "passed",
      qualityScore: 96,
      fileExists: true,
    },
    cover: {
      id: "doc_cover",
      text: rendered,
      qualityStatus: "passed",
      qualityScore: 95,
      fileExists: true,
    },
    threshold: 85,
    submissionPolicy: { active: true, autonomousSubmission: true, approvalRequired: false, dailyRemaining: 5 },
    now: new Date("2026-11-18T10:00:00.000Z"),
    ...overrides,
  };
}

test("readiness requires document quality and policy, and distinguishes review from blocking", () => {
  const ready = evaluateReadiness(readinessInput());
  assert.equal(ready.ready, true, ready.reasons.join(" "));
  assert.equal(ready.state, "ready_for_submission");

  const missingCover = evaluateReadiness(readinessInput({ cover: null }));
  assert.equal(missingCover.ready, false);
  assert.equal(missingCover.state, "documents_pending");

  const base = readinessInput();
  const warning = evaluateReadiness(readinessInput({
    cover: { ...base.cover, qualityStatus: "warning", qualityScore: 88 },
  }));
  assert.equal(warning.ready, false);
  assert.equal(warning.state, "quality_review_required");

  const failed = evaluateReadiness(readinessInput({
    cover: { ...base.cover, qualityStatus: "failed", qualityScore: 60 },
  }));
  assert.equal(failed.ready, false);
  assert.equal(failed.state, "blocked");

  const duplicate = evaluateReadiness(readinessInput({ duplicateApplication: true }));
  assert.equal(duplicate.ready, false);
  assert.equal(duplicate.state, "blocked");

  // Per-application approval no longer blocks readiness. Only the owner-level
  // automatic-submission switch does, and that leaves the documents ready.
  const approved = evaluateReadiness(readinessInput({
    submissionPolicy: { active: true, autonomousSubmission: true, approvalRequired: true, dailyRemaining: 5 },
  }));
  assert.equal(approved.ready, true);
  assert.equal(approved.state, "ready_for_submission");

  const paused = evaluateReadiness(readinessInput({
    submissionPolicy: { active: false, autonomousSubmission: false, approvalRequired: false, dailyRemaining: 5 },
  }));
  assert.equal(paused.ready, false);
  assert.equal(paused.state, "documents_ready");
});

test("readiness independently blocks a stored letter that violates an explicit recruiter limit", () => {
  const base = readinessInput();
  const recruiterMaximum = extractCoverLetterRequirements(
    "Please attach a cover letter of no more than 120 words.",
  );
  const result = evaluateReadiness({
    ...base,
    job: { ...base.job, coverLetterRequirements: recruiterMaximum },
  });
  assert.equal(result.ready, false);
  assert.equal(result.state, "blocked");
  const lengthItem = result.items.find((item) => item.key === "cover_length");
  assert.equal(lengthItem?.passed, false);
  assert.match(lengthItem?.detail ?? "", /recruiter requires at most 120 words/i);
});
