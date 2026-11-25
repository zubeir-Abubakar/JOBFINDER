import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * German hard exclusion.
 *
 * The candidate does not speak German at any level. Every fixture below is a
 * local string or local SQLite row: no employer is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-german-exclusion-"));
process.env.APP_SECRET_KEY = "german-exclusion-test-secret";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.RECRUITMENT_DRY_RUN = "false";

const db = await import("../lib/db.ts");
const { assessEligibility } = await import("../lib/eligibility.ts");
const { analyseGermanRequirement } = await import("../lib/language-requirements.ts");
const { classifyVacancy } = await import("../lib/vacancy-classification.ts");
const discovery = await import("../lib/recruitment-discovery.ts");
const runs = await import("../lib/recruitment-run.ts");
const { submitApplication } = await import("../lib/submission.ts");
import type { ProfileData } from "../lib/profile.ts";

db.getDb();
db.run("UPDATE settings SET value = 'true' WHERE key = 'autonomous_submission'");
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE settings SET value = '3' WHERE key = 'max_applications_per_day'");

const profile = {
  profile: {
    work_authorisation: "Swiss Permit B — authorised to work in Switzerland",
    permit_valid_until: "2028-02",
  },
  languages: ["English", "French"],
  languageEntries: [
    { name: "English", level: "C1" },
    { name: "French", level: "B2" },
  ],
  skills: [],
  items: [],
  experiences: [],
} as unknown as ProfileData;

const STRONG = [
  "You will own Playwright and API test automation for a payments platform.",
  "Build regression suites, review release readiness and triage defects with product and engineering.",
  "English is required.",
].join(" ");

const base = {
  title: "Senior QA Automation Engineer",
  company: "Language Fixture AG",
  location: "Zürich, Switzerland",
  remote: false,
  application_url: "https://language-fixture.test/apply",
  url: "https://language-fixture.test/job",
};

function eligibilityFor(description: string | null) {
  return assessEligibility({ ...base, description }, profile);
}

test("mandatory German at every CEFR level is ineligible, regardless of the profile", () => {
  for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
    const description = `${STRONG} German ${level} is required for this role.`;
    const result = eligibilityFor(description);
    assert.equal(result.status, "ineligible", `${level} must be ineligible`);
    assert.equal(result.germanRequired, true, `${level} must record germanRequired`);
    assert.equal(result.germanStatus, "required", `${level} must record the required status`);
    assert.match(result.germanReasonCode ?? "", /MANDATORY_GERMAN_REQUIREMENT/);
    assert.ok(result.blockers.some((blocker) => /MANDATORY_GERMAN_REQUIREMENT/.test(blocker)));
  }
});

test("every mandatory German proficiency wording is rejected", () => {
  const required = [
    "Basic German is required.",
    "Elementary German is required.",
    "Conversational German is required.",
    "Intermediate German is required.",
    "Professional German is required.",
    "Business German is required.",
    "Fluent German is required.",
    "Native German is required.",
    "German mother tongue required.",
    "German language certification required.",
    "German-speaking environment where German proficiency is explicitly required.",
    "German as a mandatory written or spoken working language.",
    "German or French required.",
    "Deutschkenntnisse A2 erforderlich.",
    "Sehr gute Deutschkenntnisse.",
    "Du sprichst fließend Deutsch und sehr gut Englisch.",
  ];
  for (const phrase of required) {
    const description = `${STRONG} ${phrase}`;
    const result = eligibilityFor(description);
    assert.equal(result.status, "ineligible", `must reject: ${phrase}`);
    assert.ok(result.germanEvidence.length > 0, `must persist evidence: ${phrase}`);
  }
});

test("optional German wording does not disqualify", () => {
  const optional = [
    "German is an advantage.",
    "German optional.",
    "English required; German beneficial.",
    "German would be a plus.",
    "German is not required.",
  ];
  for (const phrase of optional) {
    const description = `${STRONG} ${phrase}`;
    const result = eligibilityFor(description);
    assert.equal(result.status, "eligible", `must not exclude: ${phrase}`);
    assert.equal(result.germanRequired, false, `must not mark mandatory: ${phrase}`);
    assert.notEqual(result.germanStatus, "required", `must not be required: ${phrase}`);
  }
});

test("ambiguous German wording needs review and is never auto-submitted", () => {
  const ambiguous = [
    "German-speaking team; English required.",
    "We are a German-speaking company.",
    "German language skills.",
    "German is the company language.",
  ];
  for (const phrase of ambiguous) {
    const result = eligibilityFor(`${STRONG} ${phrase}`);
    assert.equal(result.status, "needs_review", `must need review: ${phrase}`);
    assert.equal(result.germanStatus, "ambiguous", `must record ambiguity: ${phrase}`);
    assert.ok(result.blockers.every((blocker) => !/MANDATORY_GERMAN_REQUIREMENT/.test(blocker)));
  }

  const missing = eligibilityFor(null);
  assert.equal(missing.status, "needs_review", "a missing description cannot prove German absent");
  assert.equal(missing.germanStatus, "unknown");
});

test("classification and discovery persist the German requirement and evidence", () => {
  const description = `${STRONG} German B2 is mandatory.`;
  const classification = classifyVacancy({ ...base, description });
  assert.ok(
    classification.mandatory.some(
      (requirement) => requirement.kind === "language" && requirement.language === "German",
    ),
  );

  const id = discovery.insertDiscovered(
    {
      source: "test:german",
      sourcePlatform: "Test",
      externalId: "german-persisted",
      title: "QA Engineer",
      company: "Persisted Language AG",
      companyDomain: "persisted-language.test",
      location: "Zürich, Switzerland",
      remote: false,
      employmentType: "Full-time",
      salary: null,
      url: "https://persisted-language.test/job",
      applicationUrl: "https://persisted-language.test/apply",
      description,
      publishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    null,
  );
  assert.ok(id);
  const row = db.one<{ german_requirement: string; language_evidence: string; eligibility: string | null }>(
    "SELECT german_requirement, language_evidence, eligibility FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.german_requirement, "required");
  assert.match(row?.language_evidence ?? "", /German B2 is mandatory/);
});

test("a re-listed vacancy with newly mandatory German is reclassified", () => {
  const publishedAt = new Date(Date.now() - 3_600_000).toISOString();
  const first = discovery.insertDiscovered(
    {
      source: "test:relisted",
      sourcePlatform: "Test",
      externalId: "relisted-1",
      title: "QA Automation Engineer",
      company: "Relisted AG",
      companyDomain: "relisted.test",
      location: "Bern, Switzerland",
      remote: false,
      employmentType: "Full-time",
      salary: null,
      url: "https://relisted.test/job",
      applicationUrl: "https://relisted.test/apply",
      description: STRONG,
      publishedAt,
      updatedAt: publishedAt,
    },
    null,
  );
  assert.ok(first);

  discovery.insertDiscovered(
    {
      source: "test:relisted",
      sourcePlatform: "Test",
      externalId: "relisted-1",
      title: "QA Automation Engineer",
      company: "Relisted AG",
      companyDomain: "relisted.test",
      location: "Bern, Switzerland",
      remote: false,
      employmentType: "Full-time",
      salary: null,
      url: "https://relisted.test/job",
      applicationUrl: "https://relisted.test/apply",
      description: `${STRONG} Fluent German is required.`,
      publishedAt,
      updatedAt: new Date().toISOString(),
    },
    null,
  );

  const row = db.one<{ german_requirement: string; eligibility: string; qualified: number; description: string }>(
    "SELECT german_requirement, eligibility, qualified, description FROM jobs WHERE id = ?",
    [first],
  );
  assert.equal(row?.german_requirement, "required");
  assert.equal(row?.eligibility, "ineligible");
  assert.equal(Number(row?.qualified), 0);
  assert.match(row?.description ?? "", /Fluent German is required/);
});

test("the stored-vacancy sweep downgrades an older eligible German row", () => {
  const id = "job_stale_german_fixture";
  db.run(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, application_url, description,
       discovered_at, status, dedupe_key, match_score, eligibility, qualified)
     VALUES ('job_stale_german_fixture', 'test:stale', 'QA Engineer', 'Stale German AG', 'Zürich, Switzerland', 0,
       'https://stale.test/job', 'https://stale.test/apply', ?, ?, 'shortlisted', 'stale-german-fixture', 95, 'eligible', 1)`,
    [`${STRONG} Deutschkenntnisse sind zwingend erforderlich.`, new Date().toISOString()],
  );
  db.run(
    `INSERT INTO applications (id, job_id, status, readiness, last_update, created_at)
     VALUES ('app_stale_german_fixture', ?, 'ready_to_submit', ?, ?, ?)`,
    [id, JSON.stringify({ ready: true, state: "ready_for_submission" }), new Date().toISOString(), new Date().toISOString()],
  );
  const changed = runs.enforceStoredGermanExclusion();
  assert.ok(changed >= 1);
  const row = db.one<{ german_requirement: string; eligibility: string; qualified: number }>(
    "SELECT german_requirement, eligibility, qualified FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.german_requirement, "required");
  assert.equal(row?.eligibility, "ineligible");
  assert.equal(Number(row?.qualified), 0);
  const app = db.one<{ status: string; submission_status: string }>(
    "SELECT status, submission_status FROM applications WHERE id = 'app_stale_german_fixture'",
  );
  assert.equal(app?.status, "rejected");
  assert.equal(app?.submission_status, "blocked");
});

test("a direct submission call for a German vacancy stops before any network contact", async () => {
  const id = "job_direct_german_fixture";
  const description = `${STRONG} German A1 is required.`;
  db.run(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, application_url, description,
       discovered_at, status, dedupe_key, match_score, eligibility, qualified, german_requirement, qualification_status)
     VALUES ('job_direct_german_fixture', 'test:direct', 'QA Engineer', 'Direct German AG', 'Zürich, Switzerland', 0,
       'https://direct-german.test/job', 'https://direct-german.test/apply', ?, ?, 'shortlisted', 'direct-german-fixture',
       95, 'eligible', 1, 'required', 'qualified')`,
    [description, new Date().toISOString()],
  );
  const applicationId = "app_direct_german_fixture";
  db.run(
    `INSERT INTO applications (id, job_id, status, readiness, readiness_checked_at, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', ?, ?, ?, ?)`,
    [
      applicationId,
      id,
      JSON.stringify({ ready: true, state: "ready_for_submission", reasons: [] }),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    ],
  );

  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("The German exclusion must stop before any network contact.");
  }) as typeof fetch;

  const outcome = await submitApplication({
    applicationId,
    job: {
      id,
      title: "QA Engineer",
      company: "Direct German AG",
      url: "https://direct-german.test/job",
      application_url: "https://direct-german.test/apply",
      description,
      german_requirement: "required",
    },
    documents: {
      cvPath: null,
      cvName: null,
      coverPath: null,
      coverName: null,
      coverText: null,
      cvDocumentId: null,
      coverDocumentId: null,
    },
    profile: {
      full_name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+41 79 000 00 00",
      location: "Zürich",
      work_authorisation: "Swiss Permit B",
      headline: "Senior QA Engineer",
      linkedin: null,
      website: null,
    },
    authorisedAnswers: {},
  });

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /MANDATORY_GERMAN_REQUIREMENT/);
  assert.equal(networkCalls, 0, "no employer endpoint was contacted");
  const app = db.one<{ status: string; submission_status: string }>(
    "SELECT status, submission_status FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.equal(app?.status, "rejected");
  assert.equal(app?.submission_status, "blocked");
  const attempts = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?",
    [id],
  );
  assert.equal(Number(attempts?.c), 0, "no submission attempt was claimed");
});

test("a German mention with no description is unresolved, not optional", () => {
  const assessment = analyseGermanRequirement("German");
  assert.equal(assessment.status, "unknown");
  assert.match(assessment.reasonCode ?? "", /GERMAN_REQUIREMENT_UNRESOLVED/);
});
