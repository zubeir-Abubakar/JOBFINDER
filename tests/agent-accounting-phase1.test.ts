import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase1-accounting-"));
process.env.APP_SECRET_KEY = "phase1-accounting-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");
const providers = await import("../lib/providers.ts");
const dashboard = await import("../lib/dashboard-live.ts");
const chat = await import("../lib/agent-chat.ts");

db.getDb();
const now = "2026-11-23T16:00:00.000Z";
const workflowId = "wf_phase1_accounting";
db.run("INSERT INTO workflows (id, kind, label, status, created_at) VALUES (?, 'test', 'Phase 1 accounting', 'running', ?)", [
  workflowId,
  now,
]);
db.run(
  "INSERT OR IGNORE INTO users (id, email, password_hash, name, role, status, created_at) VALUES ('user_phase1', 'phase1@example.test', 'fixture', 'Phase One', 'owner', 'active', ?)",
  [now],
);

function insertTask(input: {
  id: string;
  agentKey: string;
  title: string;
  status: "running" | "completed";
  executionMode: "ai" | "deterministic";
}) {
  db.run(
    `INSERT INTO tasks
       (id, workflow_id, agent_key, title, status, execution_mode, created_at, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      workflowId,
      input.agentKey,
      input.title,
      input.status,
      input.executionMode,
      now,
      now,
      input.status === "completed" ? now : null,
    ],
  );
}

// Deterministic specialist work: no model call, no token row.
for (const [key, title] of [
  ["research", "Search configured sources"],
  ["ats", "Validate package readiness"],
  ["email", "Prepare the tracking report"],
] as const) {
  insertTask({ id: `task_det_${key}`, agentKey: key, title, status: "completed", executionMode: "deterministic" });
}

// Real provider calls for each specialist that can use optional inference.
for (const [key, title] of [
  ["research", "Summarise discovered sources"],
  ["ats", "Explain the quality verdict"],
  ["email", "Classify recruiter correspondence"],
  ["cv", "Tailor the CV wording"],
  ["analysis", "Explain the match evidence"],
  ["cover", "Draft the cover letter"],
] as const) {
  insertTask({ id: `task_ai_${key}`, agentKey: key, title, status: "running", executionMode: "deterministic" });
  providers.recordUsage({
    provider: "freellmapi",
    model: "openai/gpt-oss-20b",
    agentKey: key,
    workflowId,
    taskId: `task_ai_${key}`,
    source: "task",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    usageSource: "provider",
    latencyMs: 12,
    status: "ok",
  });
  agents.completeTask(`task_ai_${key}`, key, "Fixture task completed with recorded inference.");
}

// Chief's task-bound work is attributed to Chief, not to a specialist.
insertTask({ id: "task_ai_coordinator", agentKey: "coordinator", title: "Review the run", status: "running", executionMode: "deterministic" });
providers.recordUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "coordinator",
  workflowId,
  taskId: "task_ai_coordinator",
  source: "task",
  usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
  usageSource: "provider",
  latencyMs: 10,
  status: "ok",
});
agents.completeTask("task_ai_coordinator", "coordinator", "Chief completed its orchestration task.");

// Noor's two voice turns are background inference. They do not create tasks.
providers.recordUsage({
  provider: "gemini-live",
  model: "gemini-3.8-live",
  agentKey: "application",
  sessionId: "voice_phase1",
  source: "assistant",
  usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
  usageSource: "provider",
  latencyMs: 0,
  status: "ok",
});
providers.recordUsage({
  provider: "gemini-live",
  model: "gemini-3.8-live",
  agentKey: "application",
  sessionId: "voice_phase1",
  source: "assistant",
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  usageSource: "provider",
  latencyMs: 0,
  status: "ok",
});

// A genuine Noor task receives a full lifecycle and one task-linked call.
const noorTask = agents.startTask("application", workflowId, "Prepare a verified application package", "Fixture package");
providers.recordUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "application",
  workflowId,
  taskId: noorTask,
  source: "task",
  usage: { promptTokens: 60, completionTokens: 30, totalTokens: 90 },
  usageSource: "provider",
  latencyMs: 18,
  status: "ok",
});
agents.completeTask(noorTask, "application", "Package prepared; no application was submitted.");

// Chief conversation is background, never a specialist task.
providers.recordUsage({
  provider: "freellmapi",
  model: "openai/gpt-oss-20b",
  agentKey: "coordinator",
  sessionId: "assistant_phase1",
  source: "assistant",
  usage: { promptTokens: 25, completionTokens: 5, totalTokens: 30 },
  usageSource: "provider",
  latencyMs: 9,
  status: "ok",
});

// A successful call with no token metadata must remain visible as unmeasured.
providers.recordUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "email",
  source: "assistant",
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  usageSource: "unknown",
  latencyMs: 4,
  status: "ok",
});

// Two deliberately bad links: a missing task and a task owned by another agent.
providers.recordUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "ats",
  source: "task",
  taskId: "task_missing_phase1",
  usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  usageSource: "provider",
  latencyMs: 3,
  status: "ok",
});
providers.recordUsage({
  provider: "gemini",
  model: "gemini-3.6-flash",
  agentKey: "ats",
  source: "task",
  taskId: "task_ai_research",
  usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
  usageSource: "provider",
  latencyMs: 3,
  status: "ok",
});

// An exact duplicate row must be counted once by the dashboard.
db.run(
  `INSERT INTO provider_usage
     (provider, model, agent_key, workflow_id, task_id, session_id, source,
      prompt_tokens, completion_tokens, total_tokens, cached_tokens, usage_source,
      cost_chf, cost_status, latency_ms, status, created_at)
   SELECT provider, model, agent_key, workflow_id, task_id, session_id, source,
          prompt_tokens, completion_tokens, total_tokens, cached_tokens, usage_source,
          cost_chf, cost_status, latency_ms, status, created_at
   FROM provider_usage WHERE agent_key = 'application' AND source = 'assistant' ORDER BY id LIMIT 1`,
);

function snap() {
  return dashboard.getDashboardSnapshot(new Date(now));
}

test("Saffa, Kali and Rayna complete deterministic work without fabricated inference", () => {
  const snapshot = snap();
  for (const key of ["research", "ats", "email"] as const) {
    const task = db.one<{ status: string; execution_mode: string; attempts: number }>(
      "SELECT status, execution_mode, attempts FROM tasks WHERE id = ?",
      [`task_det_${key}`],
    );
    assert.equal(task?.status, "completed");
    assert.equal(task?.execution_mode, "deterministic");
    assert.equal(task?.attempts, 0);
    assert.equal(
      db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE task_id = ?", [`task_det_${key}`])?.n,
      0,
    );
    const agent = snapshot.agents.find((row) => row.key === key);
    assert.ok(agent);
    assert.ok(agent.execution.deterministic >= 1);
    assert.equal(
      agent.execution.ai + agent.execution.deterministic + agent.execution.unrecorded,
      agent.taskCompletion.total,
      "every execution is classified exactly once",
    );
  }
});

test("every specialist's real provider call is task-linked and upgrades the task to AI", () => {
  const snapshot = snap();
  for (const key of ["research", "ats", "email", "cv", "analysis", "cover"] as const) {
    const task = db.one<{ execution_mode: string; attempts: number; provider: string | null; model: string | null }>(
      "SELECT execution_mode, attempts, provider, model FROM tasks WHERE id = ?",
      [`task_ai_${key}`],
    );
    assert.equal(task?.execution_mode, "ai");
    assert.equal(task?.attempts, 1);
    assert.equal(task?.provider, "freellmapi");
    assert.equal(task?.model, "openai/gpt-oss-20b");
    const agent = snapshot.agents.find((row) => row.key === key);
    assert.ok(agent);
    assert.ok(agent.execution.ai >= 1);
  }
});

test("a conversational instruction to Noor does not create a task", async () => {
  const before = db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tasks WHERE agent_key = 'application'",
  )?.n;
  const result = await chat.handleSpecialistMessage(
    "user_phase1",
    "application",
    "Please submit every application automatically right now.",
  );
  const after = db.one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM tasks WHERE agent_key = 'application'",
  )?.n;
  assert.deepEqual(result.taskIds, []);
  assert.equal(after, before, "conversation must not become a task execution");
});

test("Noor's genuine task records ownership, execution, completion and task-linked inference", () => {
  const task = db.one<{
    agent_key: string;
    status: string;
    execution_mode: string;
    attempts: number;
    provider: string | null;
    model: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
  }>(
    "SELECT agent_key, status, execution_mode, attempts, provider, model, created_at, started_at, finished_at FROM tasks WHERE id = ?",
    [noorTask],
  );
  assert.equal(task?.agent_key, "application");
  assert.equal(task?.status, "completed");
  assert.equal(task?.execution_mode, "ai");
  assert.equal(task?.attempts, 1);
  assert.equal(task?.provider, "gemini");
  assert.equal(task?.model, "gemini-3.6-flash");
  assert.ok(task?.started_at);
  assert.ok(task?.finished_at);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE task_id = ? AND source = 'task'", [noorTask])?.n,
    1,
  );
});

test("Noor's voice inference stays background while the subsequent task is task-linked", () => {
  const application = snap().agents.find((agent) => agent.key === "application");
  assert.ok(application);
  assert.equal(application.taskCompletion.completed, 1);
  assert.equal(application.tokens.calls, 3, "two voice turns plus one task call");
  assert.equal(application.tokens.backgroundCalls, 2);
  assert.equal(application.tokens.taskCalls, 1);
  assert.equal(application.tokens.total, 255);
  assert.equal(application.tokens.input, 170);
  assert.equal(application.tokens.output, 85);
  assert.equal(application.tokens.unresolvedCalls, 0);
});

test("Chief's background inference is not attributed to a specialist", () => {
  const snapshot = snap();
  const chief = snapshot.agents.find((agent) => agent.key === "coordinator");
  const research = snapshot.agents.find((agent) => agent.key === "research");
  assert.ok(chief && research);
  assert.equal(chief.tokens.backgroundCalls, 1);
  assert.equal(chief.tokens.taskCalls, 1);
  assert.equal(chief.taskCompletion.completed, 1);
  assert.equal(chief.execution.ai, 1);
  assert.equal(research.tokens.taskCalls, 1);
  assert.equal(snapshot.tokens.byAgent.find((row) => row.key === "coordinator")?.calls, 2);
});

test("provider usage persists the full attribution record", () => {
  const row = db.one<{
    provider: string;
    model: string;
    agent_key: string;
    workflow_id: string;
    task_id: string;
    source: string;
    usage_source: string;
    total_tokens: number;
    created_at: string;
  }>(
    "SELECT provider, model, agent_key, workflow_id, task_id, source, usage_source, total_tokens, created_at FROM provider_usage WHERE task_id = 'task_ai_research'",
  );
  assert.deepEqual({ ...row }, {
    provider: "freellmapi",
    model: "openai/gpt-oss-20b",
    agent_key: "research",
    workflow_id: workflowId,
    task_id: "task_ai_research",
    source: "task",
    usage_source: "provider",
    total_tokens: 15,
    created_at: row?.created_at,
  });
  assert.ok(row?.created_at);
});

test("missing token metadata is reported as unmeasured, never invented", () => {
  const snapshot = snap();
  assert.ok(snapshot.tokens.unmeasuredCalls >= 1);
  const row = db.one<{ total_tokens: number; usage_source: string }>(
    "SELECT total_tokens, usage_source FROM provider_usage WHERE agent_key = 'email' AND source = 'assistant' AND usage_source = 'unknown'",
  );
  assert.equal(row?.total_tokens, 0);
  assert.equal(row?.usage_source, "unknown");
});

test("missing and mismatched task links remain unresolved and are never reassigned", () => {
  const ats = snap().agents.find((agent) => agent.key === "ats");
  assert.ok(ats);
  assert.equal(ats.tokens.unresolvedCalls, 2);
  assert.equal(
    db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM provider_usage WHERE agent_key = 'ats' AND source = 'task' AND task_id IS NULL",
    )?.n,
    2,
  );
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE task_id = 'task_ai_research' AND agent_key = 'ats'")?.n,
    0,
    "the mismatched call must not be written onto another agent's task",
  );
});

test("exact duplicate usage rows are counted once without deleting history", () => {
  const raw = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage")?.n ?? 0;
  const snapshot = snap();
  assert.equal(snapshot.tokens.calls, raw - 1);
  assert.equal(
    db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM provider_usage WHERE agent_key = 'application' AND source = 'assistant'",
    )?.n,
    3,
    "raw duplicate is retained on disk",
  );
});

test("the CHF 0.00 policy and no-paid-fallback rule remain intact", () => {
  const snapshot = snap();
  assert.equal(snapshot.policy.externalSpendChf, 0);
  assert.equal(snapshot.policy.paidFallback, "never");
  assert.match(snapshot.policy.detail, /CHF 0\.00/);
  assert.match(snapshot.policy.detail, /paid fallbacks are never used/i);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE provider IN ('openrouter','paid')")?.n,
    0,
  );
});
