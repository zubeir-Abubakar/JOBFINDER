import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Regression fixtures for the zero-application investigation.
 *
 * These cover the three defects the live evidence exposed: Swiss vacancies
 * rejected as foreign, an anti-bot HTTP 429 page reported as a form CAPTCHA,
 * and a run that stored nothing new being described as "no vacancy passes 85%".
 * No network request leaves the process.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-recruitment-diagnosis-"));
process.env.APP_SECRET_KEY = "recruitment-diagnosis-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const { assessEligibility } = await import("../lib/eligibility.ts");
const { prepareCandidateForm } = await import("../lib/candidate-forms.ts");
const { buildRunReport } = await import("../lib/recruitment-run.ts");
const db = await import("../lib/db.ts");

const profile = {
  profile: {
    work_authorisation: "Swiss Permit B — authorised to work in Switzerland",
    permit_valid_until: "2028-02",
    headline: "Senior QA Engineer",
  },
  languageEntries: [],
  skills: [],
  items: [],
  experiences: [],
} as never;

const ENGLISH_DESCRIPTION =
  "We are hiring a senior QA automation engineer to own Playwright and API test suites, " +
  "run regression testing and support release readiness for a payments platform. " +
  "English is required for this role.";

const job = (overrides: Record<string, unknown>) =>
  ({
    title: "Senior QA Automation Engineer",
    company: "Swiss Payments AG",
    location: "Zürich",
    description: ENGLISH_DESCRIPTION,
    remote: false,
    application_url: "https://careers.swisspayments.test/jobs/1",
    ...overrides,
  }) as never;

test("a vacancy labelled CH is treated as a Swiss location, not a foreign one", () => {
  const result = assessEligibility(job({ location: "CH" }), profile);
  assert.equal(result.swissResidency, "yes");
  assert.ok(
    !result.blockers.some((blocker) => /outside Switzerland/i.test(blocker)),
    `unexpected location blocker: ${result.blockers.join(" | ")}`,
  );
  assert.equal(result.status, "eligible");
});

test("explicit foreign on-site evidence still overrides a Swiss location label", () => {
  // Live evidence: an aggregator labelled these Airapps roles "Zurich" while the
  // body states "fully onsite, based at our office in Lisbon". The label must not
  // make a foreign on-site role eligible.
  const description =
    `${ENGLISH_DESCRIPTION} This is a fully onsite position, based at our office in Lisbon, ` +
    "where you will collaborate closely with cross-functional teams in person.";
  const assessment = assessEligibility(job({ location: "Zurich", description }), profile);
  assert.equal(assessment.swissResidency, "no");
  assert.equal(assessment.status, "ineligible");
  assert.ok(assessment.blockers.some((blocker) => /on-site role outside Switzerland/i.test(blocker)));
});

test("HTTP 429 with a challenge-looking body is reported as rate limiting", async () => {
  const plan = await prepareCandidateForm({
    pageUrl: "https://employer.test/apply",
    jobTitle: "QA Engineer",
    company: "Employer",
    profile: null as never,
    documents: null as never,
    fetchImpl: (async () =>
      new Response("<html><body>Request blocked. reCAPTCHA challenge</body></html>", {
        status: 429,
      })) as never,
  });
  assert.equal(plan.status, "security");
  assert.equal(plan.externalRequirement, "rate_limited");
  assert.match(plan.detail, /rate-limited/i);
  assert.match(plan.detail, /HTTP 429/);
  assert.doesNotMatch(plan.detail, /application form contains a CAPTCHA/i);
});

test("a served form containing a CAPTCHA keeps the CAPTCHA classification", async () => {
  const plan = await prepareCandidateForm({
    pageUrl: "https://employer.test/apply",
    jobTitle: "QA Engineer",
    company: "Employer",
    profile: null as never,
    documents: null as never,
    fetchImpl: (async () =>
      new Response('<html><body><div class="g-recaptcha" data-sitekey="x"></div></body></html>', {
        status: 200,
      })) as never,
  });
  assert.equal(plan.status, "security");
  assert.equal(plan.externalRequirement, "security_challenge");
  assert.match(plan.detail, /CAPTCHA/i);
});

test("a plain server error is unsupported, never a security challenge", async () => {
  const plan = await prepareCandidateForm({
    pageUrl: "https://employer.test/apply",
    jobTitle: "QA Engineer",
    company: "Employer",
    profile: null as never,
    documents: null as never,
    fetchImpl: (async () => new Response("upstream unavailable", { status: 500 })) as never,
  });
  assert.equal(plan.status, "unsupported");
  assert.equal(plan.externalRequirement, undefined);
  assert.match(plan.detail, /HTTP 500/);
});

test("a run that stored nothing new does not claim no vacancy passes 85%", () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO recruitment_runs
       (id, run_key, trigger, status, started_at, finished_at, jobs_discovered, jobs_duplicates,
        jobs_filtered, jobs_eligible, jobs_qualified, sources_checked, sources_succeeded, sources_failed,
        source_metrics, created_at)
     VALUES ('run_diag', '2026-11-27#diag', 'manual', 'completed_with_warnings', ?, ?, 0, 79,
             2220, 0, 0, 6, 6, 0, ?, ?)`,
    [
      now,
      now,
      JSON.stringify([
        { key: "jobs_ch", label: "jobs.ch", requests: 2, responses: 2, postings: 400, fresh: 20, relevant: 9, duplicates: 8, inserted: 0, errors: 0, eligible: 0, qualified: 0 },
      ]),
      now,
    ],
  );
  // A standing vacancy from an earlier run, already eligible and prepared.
  db.run(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, application_url, description,
                       discovered_at, status, match_score, match_flag, eligibility, qualified)
     VALUES ('job_diag', 'jobs_ch', 'Senior QA Automation Engineer', 'Bank Example AG', 'Zürich', 0,
             'https://jobs.ch/x', 'https://bank.example/apply', 'Playwright and API testing.',
             '2026-11-25T10:00:00.000Z', 'documents', 94, 'strong', 'eligible', 1)`,
  );

  const report = buildRunReport("run_diag");
  assert.match(report, /## Pipeline breakdown \(this run and standing\)/);
  assert.match(report, /0 eligible in this run, 0 newly qualified at 85% or higher/);
  assert.match(report, /Match scoring therefore had no new vacancy to assess in this run/);
  assert.match(report, /not evidence that no vacancy passes the 85% threshold/);
  assert.match(report, /The standing pipeline holds 1 vacancy\(ies\) at or above 85% and 1 eligible/);
  assert.match(report, /Scoring was not skipped because of an error/);
});
