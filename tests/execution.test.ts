import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countsAsAiSuccess, taskExecutionMeta } from "../lib/agent-status.ts";
import { isApplicationSubmitted, submissionBlockedReason } from "../lib/application-status.ts";

test("deterministic and failed model calls are not counted as AI successes", () => {
  assert.equal(countsAsAiSuccess("ai", "ok"), true);
  assert.equal(countsAsAiSuccess("ai", "failed"), false);
  assert.equal(countsAsAiSuccess("deterministic", null), false);
  assert.equal(countsAsAiSuccess(null, null), false);
});

test("historical tasks are labelled historical, not AI-backed", () => {
  const meta = taskExecutionMeta({ execution_mode: null, ai_outcome: null, provider: null, model: null });
  assert.equal(meta.mode, "historical");
  assert.equal(meta.aiBacked, false);
  assert.equal(meta.aiFailed, false);
  assert.match(meta.label, /Historical/);
});

test("deterministic work is visibly distinguishable from model work", () => {
  const deterministic = taskExecutionMeta({ execution_mode: "deterministic" });
  assert.equal(deterministic.aiBacked, false);
  assert.match(deterministic.label, /No model/i);

  const ai = taskExecutionMeta({ execution_mode: "ai", ai_outcome: "ok", provider: "freellmapi", model: "qwen/qwen3.8-27b" });
  assert.equal(ai.aiBacked, true);
  assert.match(ai.label, /freellmapi/);
  assert.match(ai.label, /qwen\/qwen3\.8-27b/);

  const failed = taskExecutionMeta({ execution_mode: "ai", ai_outcome: "failed" });
  assert.equal(failed.aiFailed, true);
  assert.match(failed.label, /AI failed/);
});

test("a completed agent task never implies a submitted application", () => {
  // The live record after the last workflow: acknowledged, no confirmation.
  const realRecord = { status: "acknowledged", submitted_at: null, confirmation: null };
  assert.equal(isApplicationSubmitted(realRecord), false);

  assert.equal(isApplicationSubmitted({ status: "submitted", submitted_at: "2026-11-17T16:00:00.000Z", confirmation: "REF-1" }), true);
  assert.equal(isApplicationSubmitted({ status: "submitted", submitted_at: "2026-11-17T16:00:00.000Z", confirmation: null }), false);
});

test("submission needs an employer reference but never a per-application approval", () => {
  // Approval is retired: the same record is no longer blocked merely because
  // approvedAt is null. An employer reference is still mandatory evidence.
  assert.equal(
    submissionBlockedReason({ found: true, approvalMode: true, approvedAt: null, confirmation: "REF", status: "ready_to_submit" }),
    null,
  );
  assert.match(
    submissionBlockedReason({ found: true, approvalMode: true, approvedAt: null, confirmation: "", status: "ready_to_submit" }) ?? "",
    /confirmation reference/,
  );
  assert.match(
    submissionBlockedReason({ found: true, approvalMode: false, approvedAt: null, confirmation: "REF", status: "submitted" }) ?? "",
    /already recorded/,
  );
  assert.match(
    submissionBlockedReason({ found: true, approvalMode: false, approvedAt: null, confirmation: "REF", status: "acknowledged" }) ?? "",
    /already recorded/,
  );
  assert.equal(
    submissionBlockedReason({ found: true, approvalMode: true, approvedAt: "2026-11-17T16:00:00.000Z", confirmation: "REF", status: "ready_to_submit" }),
    null,
  );
  assert.match(
    submissionBlockedReason({ found: false, approvalMode: true, approvedAt: null, confirmation: "", status: "" }) ?? "",
    /not found/,
  );
});

// --- additive migration on a database that predates execution metadata ---

const dataDir = mkdtempSync(join(tmpdir(), "atw-migrate-"));
process.env.DATA_DIR = dataDir;
const legacyFile = join(dataDir, "at-ai-workforce.db");
const legacy = new DatabaseSync(legacyFile);
legacy.exec(`
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    workflow_id TEXT,
    agent_key TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    detail TEXT,
    output TEXT,
    error TEXT,
    requires_input INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
`);
legacy
  .prepare("INSERT INTO tasks (id, workflow_id, agent_key, title, status, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
  .run("task_legacy", "wf_legacy", "cv", "Tailored CV", "completed", "historic output preserved", "2026-11-01T10:00:00.000Z");
legacy.close();

const { getDb, one } = await import("../lib/db.ts");
const { recordUsage, aiCounterReconciliation } = await import("../lib/providers.ts");

test("migration adds execution metadata without rewriting historical rows", () => {
  const db = getDb();
  const taskColumns = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(taskColumns.includes("execution_mode"));
  assert.ok(taskColumns.includes("ai_outcome"));

  const agentColumns = (db.prepare("PRAGMA table_info(agents)").all() as Array<{ name: string }>).map((row) => row.name);
  assert.ok(agentColumns.includes("ai_success_count"));
  assert.ok(agentColumns.includes("ai_failure_count"));

  const row = one<{ status: string; output: string; execution_mode: string | null; ai_outcome: string | null }>(
    "SELECT status, output, execution_mode, ai_outcome FROM tasks WHERE id = 'task_legacy'",
  );
  assert.equal(row?.status, "completed");
  assert.equal(row?.output, "historic output preserved");
  // Historical rows stay NULL (unknown origin) rather than being relabelled.
  assert.equal(row?.execution_mode, null);
  assert.equal(row?.ai_outcome, null);
});

test("provider usage cost/routing metadata migrates", async () => {
  const { SCHEMA_VERSION } = await import("../lib/db.ts");
  const db = getDb();
  const usageColumns = (db.prepare("PRAGMA table_info(provider_usage)").all() as Array<{ name: string }>).map((row) => row.name);
  for (const column of ["cost_status", "routed_platform", "routed_model", "task_id", "source"]) {
    assert.ok(usageColumns.includes(column), `provider_usage.${column} missing`);
  }
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
});

test("dashboard, agents and admin queries run against the migrated schema", () => {
  const db = getDb();
  assert.doesNotThrow(() => {
    db.prepare(
      "SELECT key, name, role, status, current_task, last_run_at, run_count, failure_count, ai_success_count, ai_failure_count, enabled FROM agents ORDER BY sort",
    ).all();
    db.prepare("SELECT agent_key, execution_mode, ai_outcome, provider, model FROM tasks ORDER BY created_at DESC LIMIT 80").all();
    db.prepare(
      "SELECT provider, model, agent_key, total_tokens, latency_ms, status, error, created_at, cost_status, routed_platform, routed_model FROM provider_usage ORDER BY id DESC LIMIT 5",
    ).all();
    db.prepare("SELECT COALESCE(SUM(ai_success_count), 0) AS ok, COALESCE(SUM(ai_failure_count), 0) AS failed FROM agents").get();
  });
});

test("task-bound calls are linked to their task and the roster reconciles with usage", () => {
  const db = getDb();
  db.prepare(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at) VALUES ('task_ai_attribution', 'wf_ai', 'analysis', 'Score', 'running', ?)",
  ).run(new Date().toISOString());
  const before = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'analysis'",
  );
  assert.ok(before);

  const base = {
    provider: "freellmapi",
    model: "audit-model",
    agentKey: "analysis",
    workflowId: "wf_ai",
    taskId: "task_ai_attribution",
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    latencyMs: 5,
  };
  recordUsage({ ...base, source: "task", status: "ok" });
  recordUsage({ ...base, source: "task", status: "error", error: "timeout" });
  // A conversational call must be visible in usage but must not move the
  // task counters.
  recordUsage({ ...base, taskId: null, source: "assistant", status: "ok" });

  const after = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'analysis'",
  );
  assert.equal(after?.ai_success_count, before.ai_success_count + 1);
  assert.equal(after?.ai_failure_count, before.ai_failure_count + 1);

  const linked = one<{ task_id: string | null; source: string | null }>(
    "SELECT task_id, source FROM provider_usage WHERE agent_key = 'analysis' AND source = 'task' AND status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(linked?.task_id, "task_ai_attribution");
  assert.equal(linked?.source, "task");
  assert.equal(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM provider_usage WHERE source = 'task' AND task_id IS NULL")?.c,
    0,
  );

  for (const row of aiCounterReconciliation()) {
    assert.equal(row.driftOk, 0, `${row.key} success counter drifted`);
    assert.equal(row.driftFailed, 0, `${row.key} failure counter drifted`);
  }
});

test("repeated migration is idempotent and preserves data", () => {
  const first = getDb();
  const second = getDb();
  assert.equal(first, second);
  const row = one<{ output: string; status: string }>("SELECT output, status FROM tasks WHERE id = 'task_legacy'");
  assert.equal(row?.output, "historic output preserved");
  assert.equal(row?.status, "completed");
});

test("a handle cached before the migration is upgraded instead of crashing", async () => {
  const { SCHEMA_VERSION } = await import("../lib/db.ts");
  const dir = mkdtempSync(join(tmpdir(), "atw-stale-handle-"));
  const dbFile = join(dir, "at-ai-workforce.db");
  const scriptFile = join(dir, "stale.mjs");
  writeFileSync(
    scriptFile,
    `import { DatabaseSync } from "node:sqlite";
const handle = new DatabaseSync(process.env.STALE_DB);
handle.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY, workflow_id TEXT, agent_key TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'planned', detail TEXT, output TEXT, error TEXT, requires_input INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT)");
handle.prepare("INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('t1', 'cv', 'CV', 'completed', '2026-11-01T00:00:00.000Z')").run();
globalThis.__atwDb = handle;
const mod = await import(process.env.DB_MODULE_URL);
const db = mod.getDb();
const tasks = db.prepare("PRAGMA table_info(tasks)").all().map((row) => row.name);
const agents = db.prepare("PRAGMA table_info(agents)").all().map((row) => row.name);
console.log(JSON.stringify({
  sameHandle: db === handle,
  executionMode: tasks.includes("execution_mode"),
  aiOutcome: tasks.includes("ai_outcome"),
  aiSuccess: agents.includes("ai_success_count"),
  aiFailure: agents.includes("ai_failure_count"),
  version: db.prepare("PRAGMA user_version").get().user_version,
}));
`,
  );
  const result = spawnSync(process.execPath, [...process.execArgv, scriptFile], {
    encoding: "utf8",
    env: { ...process.env, STALE_DB: dbFile, DB_MODULE_URL: pathToFileURL(join(process.cwd(), "lib", "db.ts")).href },
  });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim().split("\n").pop() as string);
  assert.deepEqual(payload, { sameHandle: true, executionMode: true, aiOutcome: true, aiSuccess: true, aiFailure: true, version: SCHEMA_VERSION });
});
