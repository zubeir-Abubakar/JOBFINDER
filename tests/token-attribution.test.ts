import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-attribution-"));
process.env.APP_SECRET_KEY = "token-attribution-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const dashboard = await import("../lib/dashboard-live.ts");

db.getDb();
db.run("DELETE FROM provider_usage");
db.run("DELETE FROM tasks");

const now = "2026-11-23T12:00:00.000Z";
const older = "2026-11-20T09:00:00.000Z";

for (const [key, name, role, sort] of [
  ["coordinator", "Chief", "Orchestrator", 0],
  ["research", "Saffa", "Discovery", 1],
  ["analysis", "Ali", "Matching", 2],
] as const) {
  db.run(
    `INSERT INTO agents (key, name, role, description, enabled, status, run_count, success_count, failure_count, config, sort)
     VALUES (?, ?, ?, ?, 1, 'idle', 0, 0, 0, '{}', ?)
     ON CONFLICT(key) DO UPDATE SET enabled = 1, status = 'idle'`,
    [key, name, role, `${name} attribution test agent`, sort],
  );
}

const insertTask = (input: {
  id: string;
  agentKey: string;
  title: string;
  status: string;
  executionMode: string;
  at: string;
}) => {
  db.run(
    `INSERT INTO tasks
       (id, workflow_id, agent_key, title, status, created_at, heartbeat_at, started_at, finished_at, execution_mode)
     VALUES (?, 'wf_attribution', ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      input.id,
      input.agentKey,
      input.title,
      input.status,
      input.at,
      input.at,
      input.status === "completed" || input.status === "failed" ? input.at : null,
      input.executionMode,
    ],
  );
};

insertTask({
  id: "task_analysis_ai",
  agentKey: "analysis",
  title: "Score vacancies with the configured model",
  status: "completed",
  executionMode: "ai",
  at: now,
});
insertTask({
  id: "task_research_det",
  agentKey: "research",
  title: "Search configured sources",
  status: "completed",
  executionMode: "deterministic",
  at: now,
});
insertTask({
  id: "task_coord_ai",
  agentKey: "coordinator",
  title: "Review the run",
  status: "completed",
  executionMode: "ai",
  at: now,
});

let usageId = 0;
const insertUsage = (input: {
  provider: string;
  model: string;
  agentKey: string;
  taskId?: string | null;
  sessionId?: string | null;
  source: string;
  prompt: number;
  completion: number;
  at?: string;
  status?: string;
}) => {
  usageId += 1;
  db.run(
    `INSERT INTO provider_usage
       (id, provider, model, agent_key, workflow_id, task_id, session_id, source,
        prompt_tokens, completion_tokens, total_tokens, usage_source, cost_chf,
        cost_status, latency_ms, status, created_at)
     VALUES (?, ?, ?, ?, 'wf_attribution', ?, ?, ?, ?, ?, ?, 'provider', 0, 'unverified', 25, ?, ?)`,
    [
      usageId,
      input.provider,
      input.model,
      input.agentKey,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.source,
      input.prompt,
      input.completion,
      input.prompt + input.completion,
      input.status ?? "ok",
      input.at ?? now,
    ],
  );
};

// 1. A real task-linked inference.
insertUsage({
  provider: "freellmapi",
  model: "gpt-oss-20b",
  agentKey: "analysis",
  taskId: "task_analysis_ai",
  source: "task",
  prompt: 100,
  completion: 20,
});
// 2. Background inference attributed to the Coordinator, not a specialist.
insertUsage({
  provider: "freellmapi",
  model: "gpt-oss-20b",
  agentKey: "coordinator",
  source: "assistant",
  prompt: 30,
  completion: 10,
});
// 3. Older background inference, retained in the all-time totals.
insertUsage({
  provider: "freellmapi",
  model: "gpt-oss-20b",
  agentKey: "coordinator",
  source: "assistant",
  prompt: 5,
  completion: 5,
  at: older,
});
// 4. A call with no registered agent must remain unassigned.
insertUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "ghost_agent",
  source: "assistant",
  prompt: 4,
  completion: 6,
});
// 5. A historical row claiming a task but carrying no task id is unresolved.
insertUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "analysis",
  source: "task",
  prompt: 3,
  completion: 4,
});
// 6. Exact duplicate of the first record: one event, recorded twice on disk.
insertUsage({
  provider: "freellmapi",
  model: "gpt-oss-20b",
  agentKey: "analysis",
  taskId: "task_analysis_ai",
  source: "task",
  prompt: 100,
  completion: 20,
});

const snapshot = dashboard.getDashboardSnapshot(new Date(now));

test("an agent can complete a task and consume task-linked tokens", () => {
  const analysis = snapshot.agents.find((agent) => agent.key === "analysis");
  assert.ok(analysis);
  assert.equal(analysis.taskCompletion.completed, 1);
  assert.equal(analysis.taskCompletion.total, 1);
  assert.equal(analysis.tokens.taskCalls, 1);
  assert.equal(analysis.tokens.taskTokens, 120);
  assert.equal(analysis.tokens.total, 127, "task-linked plus unresolved inference is retained");
  assert.equal(analysis.execution.ai, 1);
});

test("a deterministic task without inference shows zero tokens, not missing instrumentation", () => {
  const research = snapshot.agents.find((agent) => agent.key === "research");
  assert.ok(research);
  assert.equal(research.taskCompletion.completed, 1);
  assert.equal(research.tokens.calls, 0);
  assert.equal(research.tokens.total, 0);
  assert.equal(research.tokens.unmeasuredCalls, 0);
  assert.equal(research.execution.deterministic, 1);
  assert.equal(research.execution.ai, 0);
});

test("background inference consumes tokens without creating a task execution", () => {
  const coordinator = snapshot.agents.find((agent) => agent.key === "coordinator");
  assert.ok(coordinator);
  assert.equal(coordinator.taskCompletion.total, 1);
  assert.equal(coordinator.tokens.calls, 2);
  assert.equal(coordinator.tokens.taskCalls, 0);
  assert.equal(coordinator.tokens.backgroundCalls, 2);
  assert.equal(coordinator.tokens.backgroundTokens, 50);
  assert.equal(snapshot.tokens.background.calls, 2);
  assert.equal(snapshot.tokens.background.total, 50);
});

test("coordinator inference is attributed to the coordinator, not a specialist", () => {
  const coordinator = snapshot.tokens.byAgent.find((row) => row.key === "coordinator");
  assert.ok(coordinator);
  assert.equal(coordinator.total, 50);
  const specialists = snapshot.tokens.byAgent.filter(
    (row) => row.key === "research" && row.total > 0,
  );
  assert.deepEqual(specialists, []);
  assert.equal(snapshot.agents.find((agent) => agent.key === "research")?.tokens.total, 0);
});

test("specialist inference is attributed to the specialist that made the call", () => {
  const analysis = snapshot.tokens.byAgent.find((row) => row.key === "analysis");
  assert.ok(analysis);
  assert.equal(analysis.total, 127);
  assert.equal(analysis.calls, 2);
  assert.equal(snapshot.agents.find((agent) => agent.key === "analysis")?.tokens.taskCalls, 1);
});

test("usage with a missing or unknown agent id remains explicitly unassigned", () => {
  const unassigned = snapshot.tokens.byAgent.find((row) => row.key === "unassigned");
  assert.ok(unassigned, "the unassigned bucket must be visible in the by-agent breakdown");
  assert.equal(unassigned.calls, 1);
  assert.equal(unassigned.total, 10);
  assert.equal(unassigned.label, "Unassigned (no registered agent)");
  assert.equal(snapshot.agents.some((agent) => agent.key === "ghost_agent"), false);
  assert.equal(snapshot.tokens.unresolved.calls, 2, "unknown agent plus missing task link");
});

test("duplicate inference records are counted once without deleting history", () => {
  assert.equal(snapshot.tokens.calls, 5);
  assert.equal(snapshot.tokens.total, 187);
  const analysis = snapshot.agents.find((agent) => agent.key === "analysis");
  assert.ok(analysis);
  assert.equal(analysis.tokens.taskCalls, 1);
  assert.equal(analysis.tokens.taskTokens, 120);
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage")?.n, 6);
});

test("historical totals remain intact and reproducible", () => {
  assert.equal(snapshot.tokens.taskLinked.total, 120);
  assert.equal(snapshot.tokens.background.total, 50);
  assert.equal(snapshot.tokens.unresolved.total, 17);
  assert.equal(
    snapshot.tokens.taskLinked.total +
      snapshot.tokens.background.total +
      snapshot.tokens.unresolved.total,
    snapshot.tokens.total,
  );
  assert.equal(snapshot.tokens.reporting.firstRecordedAt, older);
  assert.equal(snapshot.tokens.reporting.lastRecordedAt, now);
  assert.match(snapshot.tokens.reporting.totals, /all time/i);

  const again = dashboard.getDashboardSnapshot(new Date(now));
  assert.deepEqual(again.tokens, snapshot.tokens);
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage")?.n, 6);
});
