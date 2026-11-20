import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-dedupe-lastseen-"));
process.env.APP_SECRET_KEY = "dedupe-lastseen-test-secret";

const db = await import("../lib/db.ts");
const { findDuplicateJob, insertDiscovered } = await import("../lib/recruitment-discovery.ts");

db.getDb();

const publishedAt = new Date().toISOString();
const description =
  "We are hiring a senior quality engineer with 5+ years of software testing experience. " +
  "You will own Playwright and API test automation, test planning and release readiness.";

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    source: "greenhouse:acme",
    sourcePlatform: "Greenhouse · acme",
    externalId: "gh-100",
    title: "Senior QA Automation Engineer",
    company: "Acme Test AG",
    companyDomain: "acme.test",
    location: "Zürich, Switzerland",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://acme.test/jobs/100",
    applicationUrl: "https://acme.test/jobs/100?utm_source=greenhouse",
    description,
    publishedAt,
    raw: { fixture: true },
    ...overrides,
  };
}

test("a stable source id is authoritative and refreshes last-seen evidence without another row", () => {
  const id = insertDiscovered(discovered(), null);
  assert.ok(id);
  db.run("UPDATE jobs SET last_seen_at = '2020-01-01T00:00:00.000Z', last_seen_source = NULL WHERE id = ?", [id]);

  const duplicate = findDuplicateJob(discovered({ title: "Renamed in a feed update" }));
  assert.deepEqual(duplicate, { id, rule: "source + external_id" });
  assert.equal(insertDiscovered(discovered({ title: "Renamed in a feed update" }), null), null);

  const row = db.one<{ c: number; last_seen_at: string; last_seen_source: string; title: string }>(
    "SELECT (SELECT COUNT(*) FROM jobs) AS c, last_seen_at, last_seen_source, title FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.c, 1);
  assert.equal(row?.title, "Senior QA Automation Engineer", "the existing record is not overwritten");
  assert.equal(row?.last_seen_source, "greenhouse:acme");
  assert.notEqual(row?.last_seen_at, "2020-01-01T00:00:00.000Z");
});

test("a cross-source duplicate is matched by the normalised employer and title key", () => {
  const first = insertDiscovered(
    discovered({
      source: "greenhouse:beta",
      sourcePlatform: "Greenhouse · beta",
      externalId: "gh-200",
      title: "Staff Test Engineer",
      company: "Beta Systems AG",
      url: "https://beta.test/jobs/200",
      applicationUrl: "https://beta.test/jobs/200",
    }),
    null,
  );
  assert.ok(first);

  const second = discovered({
    source: "lever:beta",
    sourcePlatform: "Lever · beta",
    externalId: "lev-200",
    title: "Staff Test Engineer",
    company: "Beta Systems AG",
    url: "https://jobs.lever.co/beta/lev-200",
    applicationUrl: "https://jobs.lever.co/beta/lev-200",
  });
  assert.deepEqual(findDuplicateJob(second), { id: first, rule: "normalised employer + title SHA-1" });
  assert.equal(insertDiscovered(second, null), null);

  const row = db.one<{ c: number; last_seen_source: string; source: string }>(
    "SELECT (SELECT COUNT(*) FROM jobs WHERE company = 'Beta Systems AG') AS c, last_seen_source, source FROM jobs WHERE id = ?",
    [first],
  );
  assert.equal(row?.c, 1);
  assert.equal(row?.source, "greenhouse:beta", "the original source is preserved");
  assert.equal(row?.last_seen_source, "lever:beta", "the latest sighting source is recorded separately");
});
