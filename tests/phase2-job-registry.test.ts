import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase2-registry-"));
process.env.APP_SECRET_KEY = "phase2-registry-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const { insertDiscovered } = await import("../lib/recruitment-discovery.ts");
const identity = await import("../lib/job-identity.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const DESCRIPTION =
  "We are looking for a Senior QA Automation Engineer to own Playwright and API testing for a Swiss fintech platform. " +
  "You will build regression suites, work with product and engineering on release readiness and report defects in Jira.";

function listing(overrides: Record<string, unknown> = {}) {
  return {
    source: "jobs_ch",
    sourcePlatform: "jobs.ch · fixture",
    externalId: "jc-1001",
    title: "Senior QA Automation Engineer",
    company: "Fixture Fintech AG",
    companyDomain: null,
    location: "Zürich, Switzerland",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://www.jobs.ch/en/vacancies/detail/jc-1001",
    applicationUrl: "https://www.jobs.ch/en/vacancies/detail/jc-1001",
    description: DESCRIPTION,
    publishedAt: "2026-11-20T00:00:00.000Z",
    raw: { fixture: true },
    ...overrides,
  } as Parameters<typeof insertDiscovered>[0];
}

test("identity precedence uses requisition, then employer URL, then source id", () => {
  const requisition = identity.vacancyIdentity({
    source: "greenhouse",
    externalId: "4567",
    company: "Acme AG",
    title: "QA Engineer",
    location: "Zürich",
    listingUrl: "https://boards.greenhouse.io/acme/jobs/4567",
    applicationUrl: "https://boards.greenhouse.io/acme/jobs/4567?gh_jid=4567",
  });
  assert.equal(requisition.atsVendor, "greenhouse");
  assert.equal(requisition.requisitionId, "4567");
  assert.equal(requisition.canonicalKey, "req:acme:4567");
  assert.equal(requisition.urlConfidence, "ats");

  const sourceOnly = identity.vacancyIdentity({
    source: "arbeitnow",
    externalId: "slug-1",
    company: "Acme AG",
    title: "QA Engineer",
    location: "Bern",
    listingUrl: "https://www.arbeitnow.com/view/slug-1",
    applicationUrl: null,
  });
  assert.equal(sourceOnly.urlConfidence, "missing");
  assert.equal(sourceOnly.canonicalKey, "src:arbeitnow:slug-1");
  assert.equal(sourceOnly.applicationUrl, null);
});

test("an aggregator detail page is stored as the source URL, never as the employer application URL", () => {
  const id = insertDiscovered(listing(), null);
  assert.ok(id);
  const row = db.one<{ url: string; application_url: string | null; url_confidence: string; canonical_key: string; vacancy_status: string; qualification_status: string }>(
    "SELECT url, application_url, url_confidence, canonical_key, vacancy_status, qualification_status FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.url, "https://www.jobs.ch/en/vacancies/detail/jc-1001");
  assert.equal(row?.application_url, null, "the aggregator page is not an employer application endpoint");
  assert.equal(row?.url_confidence, "aggregator");
  assert.equal(row?.canonical_key, "src:jobs_ch:jc-1001");
  assert.equal(row?.vacancy_status, "new");
  assert.equal(row?.qualification_status, "pending");
});

test("two discovery passes do not create another copy, including across sources", () => {
  const first = insertDiscovered(
    listing({
      externalId: "jc-2002",
      title: "QA Automation Engineer (Platform)",
      location: "Zug, Switzerland",
      url: "https://www.jobs.ch/en/vacancies/detail/jc-2002",
      applicationUrl: null,
    }),
    null,
  );
  assert.ok(first);
  const second = insertDiscovered(
    listing({
      externalId: "jc-2002",
      title: "QA Automation Engineer (Platform)",
      location: "Zug, Switzerland",
      url: "https://www.jobs.ch/en/vacancies/detail/jc-2002",
      applicationUrl: null,
    }),
    null,
  );
  assert.equal(second, null, "the same listing is not stored twice");
  const count = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM jobs WHERE lower(company) = lower('Fixture Fintech AG') AND lower(title) = lower('QA Automation Engineer (Platform)')",
  );
  assert.equal(Number(count?.c), 1);
});

test("distinct locations and distinct requisitions remain distinct vacancies", () => {
  const zurich = insertDiscovered(
    listing({
      externalId: "jc-3003",
      title: "SDET Mobile",
      location: "Zürich, Switzerland",
      url: "https://www.jobs.ch/en/vacancies/detail/jc-3003",
      applicationUrl: null,
    }),
    null,
  );
  const bern = insertDiscovered(
    listing({
      externalId: "jc-3004",
      title: "SDET Mobile",
      location: "Bern, Switzerland",
      url: "https://www.jobs.ch/en/vacancies/detail/jc-3004",
      applicationUrl: null,
    }),
    null,
  );
  assert.ok(zurich && bern);
  assert.notEqual(zurich, bern);
  const rows = db.all<{ dedupe_key: string }>("SELECT dedupe_key FROM jobs WHERE id IN (?, ?)", [zurich, bern]);
  assert.equal(new Set(rows.map((row) => row.dedupe_key)).size, 2);
});

test("the backfill gives legacy rejected rows an identity and an internal qualification status", () => {
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, discovered_at, status, match_score, eligibility, qualified)
     VALUES ('job_legacy_ineligible', 'arbeitnow', 'legacy-slug', 'QA Lead', 'Legacy Employer GmbH', 'Basel', 'https://www.arbeitnow.com/view/legacy-slug', ?, 'rejected', 77, 'ineligible', 0)`,
    [new Date().toISOString()],
  );
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, discovered_at, status, match_score, eligibility, qualified)
     VALUES ('job_legacy_below', 'arbeitnow', 'legacy-below', 'Test Engineer', 'Legacy Employer GmbH', 'Bern', 'https://www.arbeitnow.com/view/legacy-below', ?, 'rejected', 81, 'eligible', 0)`,
    [new Date().toISOString()],
  );
  db.backfillJobRegistry(db.getDb());

  const ineligible = db.one<{ dedupe_key: string; canonical_key: string; qualification_status: string; vacancy_status: string }>(
    "SELECT dedupe_key, canonical_key, qualification_status, vacancy_status FROM jobs WHERE id = 'job_legacy_ineligible'",
  );
  assert.ok(ineligible?.dedupe_key, "a legacy row without a dedupe key receives one");
  assert.ok(ineligible?.canonical_key);
  assert.equal(ineligible?.qualification_status, "ineligible");
  assert.equal(ineligible?.vacancy_status, "verification_unknown");

  const below = db.one<{ qualification_status: string }>(
    "SELECT qualification_status FROM jobs WHERE id = 'job_legacy_below'",
  );
  assert.equal(below?.qualification_status, "below_threshold");

  // No employer rejection is invented anywhere.
  const employerRejections = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected'");
  assert.equal(Number(employerRejections?.c ?? 0), 0);
});

test("qualification status separates ineligibility, review and the threshold", () => {
  assert.equal(identity.qualificationStatusFor({ eligible: "ineligible", score: 95, threshold: 85, qualified: false }), "ineligible");
  assert.equal(identity.qualificationStatusFor({ eligible: "needs_review", score: 92, threshold: 85, qualified: false }), "needs_review");
  assert.equal(identity.qualificationStatusFor({ eligible: "eligible", score: 81, threshold: 85, qualified: false }), "below_threshold");
  assert.equal(identity.qualificationStatusFor({ eligible: "eligible", score: 92, threshold: 85, qualified: false, hardBlocker: true }), "ineligible");
  assert.equal(identity.qualificationStatusFor({ eligible: "eligible", score: 92, threshold: 85, qualified: true }), "qualified");
});
