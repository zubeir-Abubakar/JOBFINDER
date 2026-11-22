import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-incremental-discovery-"));
process.env.APP_SECRET_KEY = "incremental-discovery-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const { reconcileDiscovered } = await import("../lib/recruitment-discovery.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const publishedAt = "2026-11-22T07:00:00.000Z";
const description =
  "We are hiring a senior quality engineer with 5+ years of software testing experience. " +
  "You will own Playwright and API test automation, test planning and release readiness.";

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    source: "greenhouse:incremental-fixture",
    sourcePlatform: "Greenhouse · incremental-fixture",
    externalId: "fixture-42",
    title: "Senior QA Automation Engineer",
    company: "Fixture Quality AG",
    companyDomain: "fixture-quality.test",
    location: "Zürich, Switzerland",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://fixture-quality.test/jobs/42",
    applicationUrl: "https://fixture-quality.test/jobs/42",
    description,
    publishedAt,
    updatedAt: publishedAt,
    raw: { synthetic: true },
    ...overrides,
  };
}

test("incremental reconciliation separates new, known and updated without duplicating the vacancy", () => {
  const first = reconcileDiscovered(discovered(), "run_full_fixture");
  assert.equal(first.outcome, "new");
  assert.ok(first.id);

  const known = reconcileDiscovered(discovered(), "run_incremental_1_fixture");
  assert.deepEqual(known, {
    id: first.id,
    outcome: "known",
    rule: "source + external_id",
  });

  const updated = reconcileDiscovered(
    discovered({ updatedAt: "2026-11-22T09:30:00.000Z" }),
    "run_incremental_2_fixture",
  );
  assert.equal(updated.id, first.id);
  assert.equal(updated.outcome, "updated", "a newer source timestamp is an update, not a new vacancy");

  const stored = db.one<{ c: number; source_updated_at: string }>(
    "SELECT (SELECT COUNT(*) FROM jobs WHERE company = 'Fixture Quality AG') AS c, source_updated_at FROM jobs WHERE id = ?",
    [first.id],
  );
  assert.equal(stored?.c, 1, "one canonical vacancy row survives three observations");
  assert.equal(stored?.source_updated_at, "2026-11-22T09:30:00.000Z");
});

test("a failed source does not lose last-seen state, and recovery does not duplicate the vacancy", () => {
  const existing = db.one<{ id: string }>(
    "SELECT id FROM jobs WHERE company = 'Fixture Quality AG' AND external_id = 'fixture-42'",
  );
  assert.ok(existing);
  db.run("UPDATE jobs SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [existing!.id]);
  const before = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0);

  // The failed run made no source call and wrote no vacancy. The next successful
  // incremental read sees the same posting and reconciles it as known.
  const recovered = reconcileDiscovered(discovered(), "run_recovered_fixture");
  assert.equal(recovered.outcome, "known");
  assert.equal(recovered.id, existing!.id);
  const afterCount = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0);
  assert.equal(afterCount, before, "recovery did not create a duplicate");

  const seen = db.one<{ last_seen_at: string }>("SELECT last_seen_at FROM jobs WHERE id = ?", [existing!.id]);
  assert.notEqual(seen?.last_seen_at, "2020-01-01T00:00:00.000Z", "successful recovery refreshes last-seen evidence");
});
