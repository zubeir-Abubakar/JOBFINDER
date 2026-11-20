import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Execution truth fixtures. All employers, jobs and providers are fictional;
 * no network call is made.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-execution-truth-"));
process.env.APP_SECRET_KEY = "execution-truth-test-secret";
process.env.APP_BASE_URL = "https://workforce.test";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const { buildExecutionManifest } = await import("../lib/execution-manifest.ts");
const { buildRecruitmentExecutionEmail } = await import("../lib/email-template.ts");
const { AGENT_DEFINITIONS } = await import("../lib/agent-definitions.ts");

db.getDb();

const now = "2026-11-20T08:00:00.000Z";
const finished = "2026-11-20T08:04:00.000Z";
const runId = "run_execution_truth";
const workflowId = "wf_execution_truth";

db.run(
  "INSERT INTO workflows (id, kind, label, status, created_at) VALUES (?, 'autonomous_recruitment', 'Execution truth fixture', 'completed', ?)",
  [workflowId, now],
);
db.run(
  `INSERT INTO recruitment_runs (
     id, run_key, workflow_id, trigger, status, started_at, finished_at,
     jobs_discovered, jobs_duplicates, jobs_filtered, jobs_eligible, jobs_qualified,
     sources_checked, sources_succeeded, sources_failed, sources_partial, discovery_state,
     packages_prepared, applications_submitted, applications_unverified, applications_intervention,
     failures, warnings, warnings_json, failures_json, source_metrics, mode, created_at
   ) VALUES (?, ?, ?, 'manual', 'completed_with_warnings', ?, ?,
     0, 2, 180, 0, 0,
     2, 1, 1, 0, 'partial',
     0, 0, 0, 0,
     0, 1, ?, '[]', ?, 'full', ?)`,
  [
    runId,
    "2026-11-20#execution-truth",
    workflowId,
    now,
    finished,
    JSON.stringify(["jobs.ch returned two relevant listings, but both were already stored."]),
    JSON.stringify([
      {
        key: "jobs_ch",
        label: "jobs.ch",
        requests: 5,
        responses: 5,
        postings: 100,
        fresh: 80,
        relevant: 2,
        duplicates: 2,
        inserted: 0,
        errors: 0,
        eligible: 0,
        qualified: 0,
        status: "empty",
      },
      {
        key: "ashby",
        label: "Ashby",
        requests: 1,
        responses: 0,
        postings: 0,
        fresh: 0,
        relevant: 0,
        duplicates: 0,
        inserted: 0,
        errors: 1,
        eligible: 0,
        qualified: 0,
        status: "failed",
      },
    ]),
    now,
  ],
);

for (const [key, status, assignment, output] of [
  ["coordinator", "completed", "Coordinate the run", "Run assigned."],
  ["research", "completed", "Search every source", "100 screened, two relevant, both duplicates."],
  ["analysis", "completed", "Assess imported vacancies", "No new vacancy required assessment."],
  ["email", "completed", "Prepare the administrator report", "Report generated."],
  ["cv", "skipped", "Create CV documents", "No qualifying vacancy."],
  ["ats", "skipped", "Run quality control", "No package was prepared."],
  ["application", "skipped", "Submit applications", "No package was ready."],
] as const) {
  db.run(
    `INSERT INTO recruitment_run_agents
      (run_id, agent_key, assignment, status, attempt, output, coordinator_decision, execution_mode, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'deterministic', ?, ?, ?)`,
    [runId, key, assignment, status, output, status === "skipped" ? "Not dispatched; recorded explicitly." : "Evidence recorded.", now, finished, now],
  );
}

test("the manifest reports all eight agents and never infers missing executions", () => {
  const manifest = buildExecutionManifest(runId);
  assert.ok(manifest);
  assert.equal(manifest.expectedAgents, 8);
  assert.equal(manifest.agents.length, 8);
  assert.equal(manifest.dispatchedAgents, 4);
  assert.equal(manifest.executedAgents, 4);
  assert.equal(manifest.succeededAgents, 4);
  assert.equal(manifest.skippedAgents, 3);
  assert.equal(manifest.notExecutedAgents, 1);

  const states = Object.fromEntries(manifest.agents.map((agent) => [agent.key, agent.state]));
  assert.equal(states.coordinator, "COMPLETED");
  assert.equal(states.research, "COMPLETED_WITH_ZERO_RESULTS");
  assert.equal(states.analysis, "COMPLETED_WITH_ZERO_RESULTS");
  assert.equal(states.cv, "SKIPPED");
  assert.equal(states.cover, "NOT_EXECUTED");
  assert.equal(states.ats, "SKIPPED");
  assert.equal(states.application, "SKIPPED");
  assert.equal(states.email, "COMPLETED");

  const cover = manifest.agents.find((agent) => agent.key === "cover");
  assert.equal(cover?.executed, false);
  assert.match(cover?.reason ?? "", /No assignment or task/);
  assert.equal(manifest.handoffsCompleted, 3, "only the coordinator→research→analysis chain plus the coordinator's own completed step travelled");
});

test("the manifest distinguishes a no-input skip from an orchestration failure", () => {
  const manifest = buildExecutionManifest(runId);
  assert.ok(manifest);
  const cv = manifest.agents.find((agent) => agent.key === "cv");
  const cover = manifest.agents.find((agent) => agent.key === "cover");
  assert.equal(cv?.skipCategory, "NO_INPUT");
  assert.equal(cv?.stateLabel, "SKIPPED — NO INPUT");
  assert.match(cv?.reason ?? "", /No qualifying vacancy/);
  assert.equal(cover?.skipCategory, "ORCHESTRATION_FAILURE");
  assert.equal(cover?.stateLabel, "NOT EXECUTED — ORCHESTRATION FAILURE");
});

test("a loopback APP_BASE_URL never produces a broken email link", () => {
  const previous = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://localhost:3000";
  try {
    const content = buildRecruitmentExecutionEmail(runId);
    assert.ok(content);
    assert.doesNotMatch(content.text, /https:\/\/localhost:3000/);
    assert.doesNotMatch(content.html, /localhost:3000/);
    assert.match(content.text, /Dashboard link unavailable/);
    assert.match(content.html, /Link unavailable/);
  } finally {
    if (previous === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previous;
  }
});

test("the manifest keeps screened, relevant, duplicate and source-failure states separate", () => {
  const manifest = buildExecutionManifest(runId);
  assert.ok(manifest);
  assert.equal(manifest.counts.postingsScreened, 100);
  assert.equal(manifest.counts.relevant, 2);
  assert.equal(manifest.counts.duplicates, 2);
  assert.equal(manifest.counts.newJobs, 0);
  assert.equal(manifest.sources.find((source) => source.key === "jobs_ch")?.status, "empty");
  assert.equal(manifest.sources.find((source) => source.key === "ashby")?.status, "failed");
  assert.equal(manifest.warnings.length, 1);
  assert.match(manifest.warnings[0], /both were already stored/);
  assert.equal(manifest.failures.length, 0);
});

test("the execution email is run-scoped, branded and reports every agent and the exact warning", () => {
  const content = buildRecruitmentExecutionEmail(runId);
  assert.ok(content);
  assert.match(content.subject, /Recruitment execution report/);
  assert.match(content.subject, /2026|20 November 2026/);
  assert.match(content.text, new RegExp(runId));
  assert.match(content.text, /WORKFORCE ACTIVITY/);
  assert.match(content.text, /4 of 8 agents succeeded/);
  assert.match(content.text, /COMPLETED_WITH_ZERO_RESULTS|Completed with zero results/);
  for (const agent of AGENT_DEFINITIONS) assert.match(content.text, new RegExp(agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(content.text, /jobs\.ch returned two relevant listings/);
  assert.match(content.text, /No application was confirmed as submitted/);
  assert.match(content.text, /No administrator action is currently required|At least one configured job source failed/);
  assert.match(content.html, /src="cid:atw-logo"/);
  assert.match(content.html, /@media only screen and \(max-width:600px\)/);
  assert.match(content.html, new RegExp(runId));
  assert.match(content.html, /Execution at a glance/);
  assert.match(content.html, /https:\/\/workforce\.test\/recruitment\/runs\/run_execution_truth/);
  assert.doesNotMatch(content.html, /Your Recruitment Activity Report/);
  assert.doesNotMatch(content.text, /##/);
});

test("historical warning text is read from the stored report without rewriting it", () => {
  db.run(
    `INSERT INTO recruitment_runs (id, run_key, trigger, status, warnings, report, created_at)
     VALUES ('run_historical_warning', '2026-11-19#historical', 'manual', 'completed_with_warnings', 1, ?, ?)`,
    [
      "# Daily recruitment report\n\n## 9. Agent failures and recovery actions\nNo agent failed or was skipped.\n- Warning: Legacy source warning must remain visible.\n\n## 10. Next scheduled run\n21 Nov 2026.",
      "2026-11-19T08:00:00.000Z",
    ],
  );
  const manifest = buildExecutionManifest("run_historical_warning");
  assert.ok(manifest);
  assert.equal(manifest.warnings.length, 1);
  assert.match(manifest.warnings[0], /Legacy source warning/);
  const row = db.one<{ report: string }>("SELECT report FROM recruitment_runs WHERE id = 'run_historical_warning'");
  assert.match(row?.report ?? "", /Legacy source warning/);
});
