import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-intel-"));
process.env.APP_SECRET_KEY = "intel-test-secret";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;
delete process.env.JOBS_CH_QUERIES;

const { classifyVacancy } = await import("../lib/vacancy-classification.ts");
const { analyseJob } = await import("../lib/scoring.ts");
const { assessEligibility } = await import("../lib/eligibility.ts");
const { evaluateReadiness } = await import("../lib/application-readiness.ts");
const { insertDiscovered, discoverFromJobsCh, sourceHealth } = await import("../lib/recruitment-discovery.ts");
const { classifySubmissionFailure, reconciliationDecision } = await import("../lib/submission-reconciliation.ts");
import type { ProfileData } from "../lib/profile";

const profile = {
  profile: {
    id: 1,
    full_name: "Ada Lovelace",
    headline: "Senior QA Automation Engineer",
    email: "ada@example.com",
    phone: "+41 79 000 00 00",
    location: "Zürich",
    work_authorisation: "Swiss Permit B — authorised to work in Switzerland",
    permit_valid_until: "2028-02",
    summary: "Senior QA engineer with fintech, mobile and API test automation experience.",
    linkedin: null,
    website: null,
    languages: "English (C1)",
    languages_synced_at: null,
    cv_synced_source: null,
    preferences: null,
    source_cv_id: null,
    updated_at: null,
  },
  skills: [
    { id: 1, name: "Playwright", category: "Automation", level: "advanced", years: 3, verified: 1, source: "cv", sort: 0, deleted_at: null },
    { id: 2, name: "Selenium", category: "Automation", level: "advanced", years: 4, verified: 1, source: "cv", sort: 1, deleted_at: null },
    { id: 3, name: "TypeScript", category: "Language", level: "working", years: 3, verified: 1, source: "cv", sort: 2, deleted_at: null },
    { id: 4, name: "API testing", category: "Testing", level: "advanced", years: 4, verified: 1, source: "cv", sort: 3, deleted_at: null },
  ],
  experiences: [],
  deletedExperiences: [],
  items: [
    { id: 1, kind: "certification", title: "ISTQB Certified Tester", subtitle: null, detail: null, start_date: null, end_date: null, sort: 0 },
  ],
  preferences: {
    titles: ["Senior QA Engineer"],
    locations: ["Zürich"],
    min_salary: null,
    employment_types: ["Full-time"],
    remote_preference: "hybrid_or_remote",
    industries: ["Fintech", "Software"],
    languages: ["English"],
    german_required: "avoid",
    french: "evaluate",
  },
  languages: ["English"],
  languageEntries: [{ name: "English", level: "C1" }],
} as unknown as ProfileData;

const AUTOMATION_DESCRIPTION = [
  "You will own the test automation strategy for our payments platform.",
  "Build and maintain Playwright and Selenium suites, extend API test coverage in TypeScript and review pull requests.",
  "Participate in release readiness reviews and defect triage with product and engineering.",
].join("\n");

test("QA classification is based on responsibilities, not a passing mention of testing", () => {
  const automation = classifyVacancy({
    title: "Senior QA Automation Engineer",
    company: "Swiss Payments AG",
    location: "Zürich",
    description: AUTOMATION_DESCRIPTION,
  });
  assert.equal(automation.category, "test_automation");
  assert.equal(automation.isQa, true);

  const sdet = classifyVacancy({
    title: "SDET — Test Infrastructure",
    company: "Acme",
    location: "Remote — Europe",
    description: "Build internal test frameworks and CI/CD pipelines used by all product engineers.\nOwn test tooling and developer productivity.",
  });
  assert.equal(sdet.category, "sdet_infrastructure");
  assert.equal(sdet.isQa, true);

  const accountManager = classifyVacancy({
    title: "Account Manager, Fintech",
    company: "Acme",
    location: "Geneva",
    description: "Manage client accounts and renewals. Coordinate testing feedback with the quality assurance team and report defects to product.",
  });
  assert.equal(accountManager.isQa, false);

  const product = classifyVacancy({
    title: "Product Manager, Developer Platform",
    company: "Acme",
    location: "Zürich",
    description: "Own the roadmap for developer tooling. Work with QA on test strategy and release testing.",
  });
  assert.equal(product.category, "product_business_analysis");
  assert.equal(product.isQa, false);

  const engineer = classifyVacancy({
    title: "Backend Software Engineer",
    company: "Acme",
    location: "Bern",
    description: "Build payment APIs in Java. Write unit tests and support integration testing with the QA team.",
  });
  assert.equal(engineer.category, "software_engineering");
  assert.equal(engineer.isQa, false);

  // A dense description must not turn a clearly non-QA title into a QA role.
  const programManager = classifyVacancy({
    title: "Principal Technical Program Manager, GTM Integration",
    company: "Clickhouse",
    location: "United States",
    description: "Own pricing, packaging and launch readiness. The quoting logic and approval rules have to be built and tested end-to-end, with test automation and CI/CD evidence.",
  });
  assert.equal(programManager.isQa, false);

  const security = classifyVacancy({
    title: "Cloud Security Engineer - APJ",
    company: "Clickhouse",
    location: "Sydney",
    description: "Drive security processes and tooling with a focus on automation and data-driven decisions. Develop automation to scale security, including CI/CD and infrastructure as code.",
  });
  assert.equal(security.category, "software_engineering");
  assert.equal(security.isQa, false);

  // Laboratory and manufacturing quality roles are not software QA.
  const laboratory = classifyVacancy({
    title: "Quality Assurance Manager, Hospital Laboratories",
    company: "Unilabs",
    location: "Bern",
    description: "Lead the clinical laboratory quality system under ISO 13485 and GMP. Oversee chromatography validation, calibration and microbiology testing across hospital sites.",
  });
  assert.equal(laboratory.isQa, false);

  const manufacturing = classifyVacancy({
    title: "Test Engineer",
    company: "Huber+Suhner",
    location: "Herisau",
    description: "Validate electronics and hardware on the production line, including PCB testing, welding inspection and calibration of measurement equipment.",
  });
  assert.equal(manufacturing.isQa, false);

  const processQuality = classifyVacancy({
    title: "Quality Engineer Process & New Product Development",
    company: "Eversys",
    location: "Sierre",
    description: "Define the controls performed in production and on incoming components for new projects. Develop test equipment with the automation, mechanical and R&D departments. Analyse quality complaints and process quality indicators.",
  });
  assert.equal(processQuality.isQa, false);

  // A software QA role in a non-software industry is still QA when the
  // responsibilities explicitly cover software, automation and API testing.
  const erpQa = classifyVacancy({
    title: "Test Engineer",
    company: "Transgourmet",
    location: "Moosseedorf",
    description: "Develop and maintain automated test suites for our ERP system. Design end-to-end, API and performance tests, integrate them into CI/CD pipelines, and identify software defects with the development team.",
  });
  assert.equal(erpQa.isQa, true);
});

test("mandatory German is extracted and remains a hard eligibility blocker", () => {
  const classification = classifyVacancy({
    title: "QA Engineer",
    company: "Zürich Versicherung",
    location: "Zürich",
    description: "Sie testen unsere Webapplikationen.\nFließend Deutsch in Wort und Schrift ist zwingend erforderlich.\nEnglisch ist von Vorteil.",
  });
  assert.ok(classification.mandatory.some((entry) => entry.kind === "language" && entry.language === "German"));

  const analysis = analyseJob(
    { title: "QA Engineer", company: "Zürich Versicherung", location: "Zürich", description: "Sie testen unsere Webapplikationen.\nFließend Deutsch in Wort und Schrift ist zwingend erforderlich.\nEnglisch ist von Vorteil.", remote: 0 },
    profile,
  );
  assert.equal(analysis.criteria.length, 8);
  assert.equal(analysis.criteria.find((entry) => entry.key === "mandatory")?.score, 0);
  assert.ok(analysis.mandatoryBlockers.some((blocker) => /German/i.test(blocker)));

  const eligibility = assessEligibility(
    {
      title: "QA Engineer",
      company: "Zürich Versicherung",
      location: "Zürich",
      description: "Wir testen Webapplikationen.\nFließend Deutsch ist zwingend erforderlich.\nSie arbeiten mit modernen Testwerkzeugen und gestalten unsere Qualitätssicherung aktiv mit.",
      remote: false,
      application_url: "https://example.ch/jobs/1",
    },
    profile,
  );
  assert.equal(eligibility.status, "ineligible");
  assert.ok(eligibility.blockers.some((blocker) => /German/i.test(blocker)));
});

test("EMEA/DACH remote scope includes Swiss residents; a foreign onsite role does not", () => {
  const emea = assessEligibility(
    {
      title: "QA Automation Engineer",
      company: "Acme",
      location: "Remote — EMEA",
      description: "We are hiring across EMEA. You will build Playwright test suites and own release quality for our payments APIs.",
      remote: true,
      application_url: "https://example.com/jobs/2",
    },
    profile,
  );
  assert.equal(emea.status, "eligible");

  const onsite = assessEligibility(
    {
      title: "QA Engineer",
      company: "Acme",
      location: "London, United Kingdom",
      description: "This is an office-based role in London. You will test payment APIs and maintain regression suites.",
      remote: false,
      application_url: "https://example.com/jobs/3",
    },
    profile,
  );
  assert.notEqual(onsite.status, "eligible");
});

test("seniority mismatch is reflected in the stored evidence and cannot reach the threshold", () => {
  const intern = analyseJob(
    { title: "QA Engineering Intern", company: "Acme", location: "Zürich", description: "Support the QA team with manual and exploratory testing of web applications.", remote: 0 },
    profile,
  );
  assert.ok((intern.criteria.find((entry) => entry.key === "seniority")?.score ?? 100) < 60);
  assert.ok(intern.score < 85);
});

function readinessInput(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-11-18T10:00:00.000Z");
  const sourceText = [
    "Ada Lovelace — Senior QA Automation Engineer",
    "Playwright, Selenium, TypeScript, API testing.",
    "Built regression suites that covered 120 payment scenarios and reduced release defects by 30%.",
  ].join("\n");
  return {
    job: {
      title: "Senior QA Automation Engineer",
      company: "Swiss Payments AG",
      location: "Zürich",
      application_url: "https://swisspayments.example/jobs/42",
      url: "https://swisspayments.example/jobs/42",
      published_at: "2026-11-16T09:00:00.000Z",
      description: AUTOMATION_DESCRIPTION,
      eligibility: "eligible",
      eligibilityNotes: JSON.stringify({ blockers: [] }),
      matchScore: 91,
      analysis: null,
    },
    application: { id: "app_1", status: "quality_check", submittedAt: null },
    profile: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+41 79 000 00 00",
      workAuthorisation: "Swiss Permit B — authorised to work without employer sponsorship",
      skills: ["Playwright", "Selenium", "TypeScript", "API testing"],
      certifications: ["ISTQB Certified Tester"],
      languages: ["English C1"],
      sourceText,
    },
    cv: {
      id: "doc_cv",
      text: `${sourceText}\nTailored for Swiss Payments AG. Playwright and Selenium automation for payment APIs.`,
      qualityStatus: "passed",
      qualityScore: 96,
      fileExists: true,
    },
    cover: {
      id: "doc_cover",
      text: "Dear Swiss Payments AG team, I am applying for the Senior QA Automation Engineer role. I built Playwright suites covering 120 payment scenarios and reduced release defects by 30%.",
      qualityStatus: "passed",
      qualityScore: 95,
      fileExists: true,
    },
    threshold: 85,
    now,
    ...overrides,
  };
}

test("a complete, evidenced package passes every readiness check", () => {
  const result = evaluateReadiness(readinessInput());
  assert.equal(result.ready, true, result.reasons.join(" "));
  assert.equal(result.state, "ready_for_submission");
  assert.equal(result.items.length, 15);
});

test("readiness refuses stale vacancies, missing CVs, unsupported claims and wrong cover targets", () => {
  const stale = evaluateReadiness(readinessInput({
    job: { ...readinessInput().job, published_at: "2026-11-01T09:00:00.000Z" },
  }));
  assert.equal(stale.ready, false);
  assert.ok(stale.reasons.some((reason) => /seven days/i.test(reason)));

  const missingCv = evaluateReadiness(readinessInput({ cv: null }));
  assert.equal(missingCv.ready, false);
  assert.ok(missingCv.reasons.some((reason) => /Tailored CV/i.test(reason)));

  const base = readinessInput();
  const unsupported = evaluateReadiness(readinessInput({
    cv: { ...base.cv, text: `${base.cv.text} Also expert in Kubernetes and Terraform.` },
  }));
  assert.equal(unsupported.ready, false);
  assert.ok(unsupported.reasons.some((reason) => /Unsupported technologies/i.test(reason)));

  const wrongTarget = evaluateReadiness(readinessInput({
    cover: { ...base.cover, text: "Dear team, I am excited to apply for this opportunity. I built Playwright suites covering 120 payment scenarios." },
  }));
  assert.equal(wrongTarget.ready, false);
  assert.ok(wrongTarget.reasons.some((reason) => /role and employer/i.test(reason)));

  const highThreshold = evaluateReadiness(readinessInput({ threshold: 95 }));
  assert.equal(highThreshold.ready, false);
  assert.ok(highThreshold.reasons.some((reason) => /Match score/i.test(reason)));

  const ineligible = evaluateReadiness(readinessInput({
    job: {
      ...base.job,
      eligibility: "ineligible",
      eligibilityNotes: JSON.stringify({ blockers: ["German C1 is mandatory."] }),
    },
  }));
  assert.equal(ineligible.ready, false);
  assert.ok(ineligible.reasons.some((reason) => /German C1/i.test(reason)));
});

test("cross-source vacancies deduplicate on employer+title and normalised URL", () => {
  const first = insertDiscovered({
    source: "ashby",
    sourcePlatform: "Ashby · acme",
    externalId: "posting-1",
    title: "Senior QA Engineer",
    company: "Acme Payments AG",
    companyDomain: "acme.example",
    location: "Zürich",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://jobs.ashbyhq.com/acme/posting-1",
    applicationUrl: "https://jobs.ashbyhq.com/acme/posting-1?utm_source=feed",
    description: AUTOMATION_DESCRIPTION,
    publishedAt: new Date().toISOString(),
  }, null);
  assert.ok(first);

  const sameRole = insertDiscovered({
    source: "jobs_ch",
    sourcePlatform: "jobs.ch",
    externalId: "jobs-99",
    title: "Senior QA Engineer",
    company: "Acme Payments AG",
    companyDomain: "acme.example",
    location: "Zürich",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://www.jobs.ch/en/vacancies/detail/jobs-99",
    applicationUrl: "https://www.jobs.ch/en/vacancies/detail/jobs-99",
    description: AUTOMATION_DESCRIPTION,
    publishedAt: new Date().toISOString(),
  }, null);
  assert.equal(sameRole, null);
});

test("jobs.ch maps verified search results and persists source health", async () => {
  const posted = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "QA Automation Engineer",
    description: "<p>Build Playwright and Selenium automation for payment APIs, maintain regression suites and own release quality gates.</p>",
    datePosted: posted,
    hiringOrganization: { name: "Swiss Payments AG" },
    jobLocation: { addressLocality: "Zürich", addressCountry: "CH" },
    url: "https://www.jobs.ch/en/vacancies/detail/abc-123",
  })}</script></head><body></body></html>`;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/v1/public/search")) {
      return new Response(JSON.stringify({
        documents: [
          {
            job_id: "abc-123",
            title: "QA Automation Engineer",
            company_name: "Swiss Payments AG",
            place: "Zürich",
            publication_date: posted,
            preview: "Build test automation for payments.",
            _links: { detail_en: { href: "https://www.jobs.ch/en/vacancies/detail/abc-123" } },
          },
          {
            job_id: "def-456",
            title: "Account Manager",
            company_name: "Other AG",
            place: "Geneva",
            publication_date: posted,
            preview: "Manage client accounts.",
            _links: { detail_en: { href: "https://www.jobs.ch/en/vacancies/detail/def-456" } },
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;

  const result = await discoverFromJobsCh(["QA Engineer"]);
  assert.equal(result.error, null);
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.source, "jobs_ch");
  assert.equal(job.externalId, "abc-123");
  assert.equal(job.company, "Swiss Payments AG");
  assert.match(job.description, /Playwright/);

  const health = sourceHealth().find((row) => row.source_key === "jobs_ch" && row.endpoint.includes("query=QA"));
  assert.ok(health);
  assert.equal(health?.ok, 1);
  assert.ok((health?.postings ?? 0) >= 2);
});

test("timeouts stay ambiguous and are never retried blindly; confirmed rejections are distinguished", () => {
  assert.equal(classifySubmissionFailure({ error: "The operation was aborted due to timeout" }).kind, "timeout");
  assert.equal(classifySubmissionFailure({ error: "fetch failed: ECONNRESET" }).ambiguous, true);
  assert.equal(classifySubmissionFailure({ httpStatus: 422 }).kind, "rejected");
  assert.equal(classifySubmissionFailure({ httpStatus: 429 }).kind, "rate_limited");

  const timeout = reconciliationDecision({ status: "failed", httpStatus: null, reference: null, error: "timeout" });
  assert.equal(timeout.action, "blocked");
  assert.match(timeout.reason, /ambiguous/i);
  assert.equal(timeout.evidence.candidateLookupAvailable, false);

  const rejected = reconciliationDecision({ status: "blocked", httpStatus: 422, reference: null, error: "rejected" });
  assert.equal(rejected.action, "blocked");
  assert.equal(rejected.kind, "rejected");

  const verified = reconciliationDecision({ status: "verified", httpStatus: 201, reference: "ref-1", error: null });
  assert.match(verified.reason, /never sent twice/i);

  const noAttempt = reconciliationDecision(null);
  assert.equal(noAttempt.action, "send");

  const channelBlock = reconciliationDecision({ status: "blocked", httpStatus: null, reference: null, error: null });
  assert.equal(channelBlock.action, "send");
});
