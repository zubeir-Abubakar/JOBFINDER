import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReachRunner } from "../lib/agent-reach.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-discovery-research-"));
process.env.APP_SECRET_KEY = "discovery-research-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const discovery = await import("../lib/recruitment-discovery.ts");

db.getDb();

const description =
  "We are hiring a senior quality engineer with 5+ years of software testing experience. " +
  "You will own Playwright and API test automation, test planning and release readiness.";

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    source: "greenhouse:research-fixture",
    sourcePlatform: "Greenhouse · research-fixture",
    externalId: "research-fixture-1",
    title: "Senior QA Automation Engineer",
    company: "Research Fixture AG",
    companyDomain: "research-fixture.test",
    location: "Zürich, Switzerland",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://research-fixture.test/jobs/1",
    applicationUrl: "https://research-fixture.test/jobs/1",
    description,
    publishedAt: "2026-11-24T07:00:00.000Z",
    updatedAt: "2026-11-24T07:00:00.000Z",
    raw: { synthetic: true },
    ...overrides,
  };
}

function seed(tag: string, overrides: Record<string, unknown> = {}): string {
  const row = discovery.reconcileDiscovered(
    discovered({
      externalId: `research-fixture-${tag}`,
      title: `Senior QA Automation Engineer ${tag}`,
      url: `https://research-fixture.test/jobs/${tag}`,
      applicationUrl: `https://research-fixture.test/jobs/${tag}`,
      ...overrides,
    }),
    "run_research_fixture",
  );
  assert.equal(row.outcome, "new", `seed ${tag}`);
  assert.ok(row.id);
  return row.id!;
}

function runner(seen: string[], mode: "ok" | "timeout" = "ok"): ReachRunner {
  return async (argv) => {
    const url = argv[argv.length - 1];
    seen.push(url);
    if (mode === "timeout") return { stdout: "", stderr: "", code: null, timedOut: true, overflow: false };
    return {
      stdout: JSON.stringify({
        ok: true,
        channel: "web",
        action: "read",
        backend: "jina",
        items: [
          {
            title: "Senior QA Automation Engineer",
            url,
            text: "Senior QA Automation Engineer — Research Fixture AG. Applications are open.",
          },
        ],
      }),
      stderr: "",
      code: 0,
      timedOut: false,
      overflow: false,
    };
  };
}

test("enrichment reads at most three newly stored vacancies and never writes to the vacancy pipeline", async () => {
  const ids = [seed("cap-1"), seed("cap-2"), seed("cap-3"), seed("cap-4"), seed("cap-5")];
  const before = db.all<{ id: string; status: string; eligibility: string | null; qualified: number; match_score: number | null }>(
    "SELECT id, status, eligibility, qualified, match_score FROM jobs ORDER BY id",
  );
  const seen: string[] = [];
  const summary = await discovery.enrichDiscoveredVacancies({
    jobIds: ids,
    cap: 99,
    installed: true,
    runner: runner(seen),
  });

  assert.equal(summary.cap, 3, "the hard ceiling is three regardless of the requested cap");
  assert.equal(summary.attempted, 3);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.skipped, 2);
  assert.equal(seen.length, 3, "only three external reads were performed");
  assert.equal(summary.evidence.length, 3);
  assert.ok(summary.evidence.every((item) => item.ok && item.channel === "web_read"));
  assert.match(summary.reason ?? "", /Bounded to 3/);

  const after = db.all<{ id: string; status: string; eligibility: string | null; qualified: number; match_score: number | null }>(
    "SELECT id, status, eligibility, qualified, match_score FROM jobs ORDER BY id",
  );
  assert.deepEqual(after, before, "evidence enrichment cannot change a stored vacancy");
});

test("an aggregator stays the source URL and is never promoted to the employer application route", async () => {
  const id = seed("aggregator", {
    source: "jobs_ch",
    sourcePlatform: "jobs.ch · QA Engineer",
    url: "https://www.jobs.ch/en/vacancies/detail/777",
    applicationUrl: "https://www.jobs.ch/en/vacancies/detail/777",
  });
  const seen: string[] = [];
  const summary = await discovery.enrichDiscoveredVacancies({
    jobIds: [id],
    installed: true,
    runner: runner(seen),
  });
  assert.equal(seen.length, 1);
  assert.equal(summary.evidence[0].sourceUrl, "https://www.jobs.ch/en/vacancies/detail/777");
  assert.equal(summary.evidence[0].employerUrl, null);
});

test("a missing install or a failed read is recorded and never breaks discovery", async () => {
  const id = seed("offline");
  const skippedRunner = runner([]);
  const notInstalled = await discovery.enrichDiscoveredVacancies({
    jobIds: [id],
    installed: false,
    runner: skippedRunner,
  });
  assert.equal(notInstalled.enabled, false);
  assert.equal(notInstalled.attempted, 0);
  assert.match(notInstalled.reason ?? "", /not installed/i);

  const seen: string[] = [];
  const timedOut = await discovery.enrichDiscoveredVacancies({
    jobIds: [id, "job_missing_row"],
    installed: true,
    runner: runner(seen, "timeout"),
  });
  assert.equal(timedOut.succeeded, 0);
  assert.equal(timedOut.attempted, 1, "a missing row is skipped, not invented");
  assert.equal(timedOut.skipped, 1);
  assert.match(timedOut.evidence[0].reason ?? "", /time limit|timed out|timeout/i);

  const check = db.one<{ postings: number; relevant: number; ok: number }>(
    "SELECT postings, relevant, ok FROM discovery_source_status WHERE source_key = 'agent_reach'",
  );
  assert.ok(check, "the bounded external read is auditable");
  assert.equal(check!.postings, 1);
  assert.equal(check!.relevant, 0);
  assert.equal(check!.ok, 0);
});

test("the read model exposes persisted evidence without re-running any research", () => {
  const report = discovery.discoveryResearchReport("run_research_fixture");
  assert.ok(report);
  assert.equal(report!.cap, discovery.DISCOVERY_RESEARCH_CAP);
  assert.ok(report!.attempted >= 1);
  assert.equal(report!.succeeded, 0);
  assert.equal(report!.ok, false);
  assert.match(report!.error ?? "", /time limit|timed out|timeout/i);
});

test("both recruitment views surface the bounded evidence and its limits", () => {
  const index = readFileSync("app/(app)/recruitment/page.tsx", "utf8");
  assert.match(index, /discoveryResearchReport/);
  assert.match(index, /Read-only external evidence/);
  assert.match(index, /cannot add a vacancy, change a score/);
  const runPage = readFileSync("app/(app)/recruitment/runs/[id]/page.tsx", "utf8");
  assert.match(runPage, /Read-only external evidence/);
  assert.match(runPage, /cannot insert a vacancy, change a match score/);
});

test("zero stored vacancies makes no external request", async () => {
  const seen: string[] = [];
  const summary = await discovery.enrichDiscoveredVacancies({ jobIds: [], installed: true, runner: runner(seen) });
  assert.equal(summary.attempted, 0);
  assert.equal(seen.length, 0);
  assert.match(summary.reason ?? "", /stored no vacancy/i);
});
