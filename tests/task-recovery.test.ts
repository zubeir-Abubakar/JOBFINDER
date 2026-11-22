import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-task-recovery-"));
process.env.APP_SECRET_KEY = "task-recovery-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const recovery = await import("../lib/task-recovery.ts");

db.getDb();

test.after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const now = new Date("2026-11-22T12:00:00.000Z");
const stale = new Date(now.getTime() - 31 * 60_000).toISOString();
const fresh = new Date(now.getTime() - 2 * 60_000).toISOString();

function addWorkflow(id: string, status = "running", createdAt = stale): void {
  db.run(
    "INSERT INTO workflows (id, kind, label, status, created_at) VALUES (?, 'recruitment', ?, ?, ?)",
    [id, id, status, createdAt],
  );
}

function addRunningTask(taskId: string, workflowId: string, startedAt: string, agentKey = "research"): void {
  const title = `Recovery fixture ${taskId}`;
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, started_at, created_at) VALUES (?, ?, ?, ?, 'running', ?, ?)",
    [taskId, workflowId, agentKey, title, startedAt, startedAt],
  );
  db.run("UPDATE agents SET status = 'working', current_task = ? WHERE key = ?", [title, agentKey]);
}

test("a fresh task is not failed just because another process opens the agents page", () => {
  addWorkflow("wf_fresh", "running", fresh);
  addRunningTask("task_fresh", "wf_fresh", fresh);

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 0);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM tasks WHERE id = 'task_fresh'")?.status,
    "running",
  );
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM workflows WHERE id = 'wf_fresh'")?.status,
    "running",
  );
});

test("a workflow with no task yet is measured from its own creation time", () => {
  addWorkflow("wf_just_created", "running", fresh);

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 0);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM workflows WHERE id = 'wf_just_created'")?.status,
    "running",
  );
});

test("a stale task with no live lease is failed and its workflow is paused", () => {
  addWorkflow("wf_stale", "running", stale);
  addRunningTask("task_stale", "wf_stale", stale);

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 1);
  assert.equal(result.pausedWorkflows, 1);
  const task = db.one<{ status: string; error: string | null; state_reason: string | null }>(
    "SELECT status, error, state_reason FROM tasks WHERE id = 'task_stale'",
  );
  assert.equal(task?.status, "failed");
  assert.match(task?.error ?? "", /Stalled/);
  assert.match(task?.state_reason ?? "", /no active worker lease/);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM workflows WHERE id = 'wf_stale'")?.status,
    "paused",
  );
  assert.match(
    db.one<{ message: string }>(
      "SELECT message FROM workflow_events WHERE workflow_id = 'wf_stale' AND type = 'workflow.paused' ORDER BY id DESC LIMIT 1",
    )?.message ?? "",
    /stale-task recovery|Workflow paused/i,
  );
});

test("a stale-looking task is preserved while its recruitment run holds an unexpired lease", () => {
  addWorkflow("wf_leased", "running", stale);
  addRunningTask("task_leased", "wf_leased", stale);
  db.run(
    "INSERT INTO recruitment_runs (id, run_key, workflow_id, trigger, status, created_at) VALUES ('run_leased', 'lease#1', 'wf_leased', 'manual', 'preparing_applications', ?)",
    [stale],
  );
  db.run(
    "INSERT INTO runtime_locks (key, owner, acquired_at, heartbeat_at, expires_at, meta) VALUES ('recruitment:run:run_leased', 'other-instance', ?, ?, ?, '{}')",
    [stale, now.toISOString(), new Date(now.getTime() + 5 * 60_000).toISOString()],
  );

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 0);
  assert.ok(result.preservedActiveWorkflows >= 1);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM tasks WHERE id = 'task_leased'")?.status,
    "running",
  );
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM workflows WHERE id = 'wf_leased'")?.status,
    "running",
  );
});

test("a recent heartbeat preserves a long-running task beyond the old generic threshold", () => {
  const longStarted = new Date(now.getTime() - 60 * 60_000).toISOString();
  addWorkflow("wf_heartbeat", "running", longStarted);
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, task_type, started_at, heartbeat_at, created_at) VALUES ('task_heartbeat', 'wf_heartbeat', 'cv', 'Generate tailored CV', 'running', 'cv_generation', ?, ?, ?)",
    [longStarted, fresh, longStarted],
  );

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 0);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM tasks WHERE id = 'task_heartbeat'")?.status,
    "running",
  );
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM workflows WHERE id = 'wf_heartbeat'")?.status,
    "running",
  );
});

test("a typed task is failed only after its own execution window without a heartbeat", () => {
  const staleHeartbeat = new Date(now.getTime() - 16 * 60_000).toISOString();
  addWorkflow("wf_typed_stale", "running", staleHeartbeat);
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, task_type, started_at, heartbeat_at, created_at) VALUES ('task_typed_stale', 'wf_typed_stale', 'cv', 'Generate tailored CV', 'running', 'cv_generation', ?, ?, ?)",
    [staleHeartbeat, staleHeartbeat, staleHeartbeat],
  );

  const result = recovery.recoverStalledTasks(now);
  assert.equal(result.failedTasks, 1);
  const row = db.one<{ status: string; error_class: string | null; recovery_state: string | null }>(
    "SELECT status, error_class, recovery_state FROM tasks WHERE id = 'task_typed_stale'",
  );
  assert.equal(row?.status, "failed");
  assert.equal(row?.error_class, "timeout");
  assert.equal(row?.recovery_state, "stalled");
});

test("recovery is idempotent and does not rewrite an already failed task", () => {
  const again = recovery.recoverStalledTasks(now);
  assert.equal(again.failedTasks, 0);
  const failed = db.one<{ finished_at: string | null }>(
    "SELECT finished_at FROM tasks WHERE id = 'task_stale'",
  );
  assert.ok(failed?.finished_at);
});
