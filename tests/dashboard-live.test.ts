import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-dashboard-"));
process.env.APP_SECRET_KEY = "dashboard-live-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const dashboard = await import("../lib/dashboard-live.ts");

db.getDb();
const now = new Date().toISOString();
const today = now.slice(0, 10);

for (const [key, name, role, sort] of [
  ["coordinator", "Chief", "Orchestrator", 0],
  ["research", "Saffa", "Discovery", 1],
  ["analysis", "Ali", "Matching", 2],
  ["email", "Rayna", "Tracking", 7],
] as const) {
  db.run(
    "INSERT OR IGNORE INTO agents (key, name, role, description, enabled, status, run_count, success_count, failure_count, config, sort) VALUES (?, ?, ?, ?, 1, 'idle', 0, 0, 0, '{}', ?)",
    [key, name, role, `${name} test agent`, sort],
  );
}

db.run("UPDATE agents SET status = 'idle', current_task = NULL, last_run_at = NULL, enabled = 1");

db.run("UPDATE agents SET status = 'working', current_task = 'Scanning configured sources', last_run_at = ? WHERE key = 'research'", [now]);
db.run("UPDATE agents SET status = 'idle', last_run_at = ? WHERE key = 'analysis'", [now]);

const insertTask = (id: string, agentKey: string, status: string, title: string) => {
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at, heartbeat_at, started_at, finished_at) VALUES (?, 'wf_test', ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      agentKey,
      title,
      status,
      now,
      status === "running" ? now : null,
      now,
      status === "completed" || status === "failed" ? now : null,
    ],
  );
};
insertTask("task_r1", "research", "completed", "Search sources");
insertTask("task_r2", "research", "completed", "Extract vacancies");
insertTask("task_r3", "research", "failed", "Read employer page");
insertTask("task_r4", "research", "running", "Verify publication date");
insertTask("task_a1", "analysis", "completed", "Score vacancies");

const insertUsage = (input: {
  provider: string;
  model: string;
  agentKey: string;
  prompt: number;
  completion: number;
  latency: number;
  source: "provider" | "estimated" | "unknown";
}) => {
  db.run(
    `INSERT INTO provider_usage
       (provider, model, agent_key, source, prompt_tokens, completion_tokens, total_tokens, usage_source, cost_chf, cost_status, latency_ms, status, created_at)
     VALUES (?, ?, ?, 'task', ?, ?, ?, ?, 0, 'unverified', ?, 'ok', ?)`,
    [
      input.provider,
      input.model,
      input.agentKey,
      input.prompt,
      input.completion,
      input.prompt + input.completion,
      input.source,
      input.latency,
      now,
    ],
  );
};

insertUsage({ provider: "freellmapi", model: "gpt-oss-20b", agentKey: "research", prompt: 100, completion: 20, latency: 40, source: "provider" });
insertUsage({ provider: "gemini", model: "gemini-3.6-flash", agentKey: "research", prompt: 60, completion: 20, latency: 20, source: "estimated" });
insertUsage({ provider: "freellmapi", model: "gpt-oss-20b", agentKey: "analysis", prompt: 50, completion: 10, latency: 60, source: "provider" });

const snapshot = dashboard.getDashboardSnapshot(new Date(now));

test("configured agents come from the roster and Chief is distinguished", () => {
  const research = snapshot.agents.find((agent) => agent.key === "research");
  const chief = snapshot.agents.find((agent) => agent.key === "coordinator");
  assert.ok(research);
  assert.ok(chief);
  assert.equal(chief.name, "Chief");
  assert.equal(chief.isChief, true);
  assert.equal(research.isChief, false);
  assert.equal(research.name, "Saffa");
  assert.equal(research.role, "Discovery");
  assert.ok(snapshot.agents.some((agent) => agent.key === "email"));
});

test("task execution counters and completion percentages are attributed per agent", () => {
  const research = snapshot.agents.find((agent) => agent.key === "research");
  assert.ok(research);
  assert.equal(research.taskCompletion.total, 4);
  assert.equal(research.taskCompletion.completed, 2);
  assert.equal(research.taskCompletion.failed, 1);
  assert.equal(research.taskCompletion.percent, 50);
  assert.equal(research.taskTrend.at(-1)?.value, 2);
  assert.deepEqual(research.upstream, ["Chief"]);
  assert.deepEqual(research.downstream, ["Ali"]);
  assert.equal(research.currentTask, "Verify publication date");
  assert.equal(research.active, true);
  assert.equal(research.health, "live");
});

test("token totals are real, per-agent and per-provider, with provenance", () => {
  const research = snapshot.agents.find((agent) => agent.key === "research");
  const analysis = snapshot.agents.find((agent) => agent.key === "analysis");
  const email = snapshot.agents.find((agent) => agent.key === "email");
  assert.ok(research && analysis && email);
  assert.equal(research.tokens.total, 200);
  assert.equal(research.tokens.input, 160);
  assert.equal(research.tokens.output, 40);
  assert.equal(research.tokens.calls, 2);
  assert.equal(research.tokens.providerReported, 120);
  assert.equal(research.tokens.estimated, 80);
  assert.equal(research.latencyMs, 30);
  assert.equal(analysis.tokens.total, 60);
  assert.equal(analysis.latencyMs, 60);

  assert.equal(snapshot.tokens.total, 260);
  assert.equal(snapshot.tokens.input, 210);
  assert.equal(snapshot.tokens.output, 50);
  assert.equal(snapshot.tokens.providerReported, 180);
  assert.equal(snapshot.tokens.estimated, 80);
  assert.equal(snapshot.tokens.byProvider.find((row) => row.key === "freellmapi")?.total, 180);
  assert.equal(snapshot.tokens.byProvider.find((row) => row.key === "gemini")?.total, 80);
  assert.equal(snapshot.tokens.byAgent.find((row) => row.key === "research")?.total, 200);

  assert.equal(snapshot.tokens.daily.length, 14);
  assert.equal(snapshot.tokens.weekly.length, 8);
  assert.equal(snapshot.tokens.daily.at(-1)?.detail, today);
  assert.equal(snapshot.tokens.daily.at(-1)?.value, 260);
});

test("missing measurements are reported as unavailable, never fabricated", () => {
  const email = snapshot.agents.find((agent) => agent.key === "email");
  assert.ok(email);
  assert.equal(email.taskCompletion.total, 0);
  assert.equal(email.taskCompletion.percent, null);
  assert.equal(email.tokens.total, 0);
  assert.equal(email.tokens.calls, 0);
  assert.equal(email.latencyMs, null);
  assert.equal(email.lastSuccessfulCallAt, null);
  assert.equal(email.health, "none");
  assert.ok(email.taskTrend.every((point) => point.value === 0));
});

test("provider health is omitted unless genuinely configured, and the CHF 0.00 policy is preserved", () => {
  assert.deepEqual(snapshot.providers, []);
  assert.equal(snapshot.policy.externalSpendChf, 0);
  assert.equal(snapshot.policy.paidFallback, "never");
  assert.match(snapshot.policy.detail, /CHF 0\.00/);
  assert.equal(JSON.stringify(snapshot).includes("API_KEY"), false, "no credential keys are exposed");
});
