import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-task-contract-"));
process.env.APP_SECRET_KEY = "task-contract-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");
const contract = await import("../lib/task-contract.ts");

db.getDb();

test.after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("task types and error classes are derived deterministically", () => {
  assert.equal(contract.taskTypeFor("research", "Search job sources"), "retrieval");
  assert.equal(contract.taskTypeFor("cover", "Generate cover letter"), "cover_letter_generation");
  assert.equal(contract.taskTypeFor("ats", "Quality control audit"), "document_validation");
  assert.equal(contract.taskTypeFor("application", "Submit application"), "submission");
  assert.equal(contract.taskTimeoutMs("submission", "application", ""), 5 * 60_000);
  assert.ok(contract.taskTimeoutMs("cv_generation", "cv", "") > contract.taskTimeoutMs("submission", "application", ""));
  assert.equal(contract.classifyTaskError("HTTP 429: too many requests"), "rate_limited");
  assert.equal(contract.classifyTaskError("Invalid API key supplied"), "authentication");
  assert.equal(contract.classifyTaskError("The operation timed out"), "timeout");
  assert.equal(contract.classifyTaskError("quality gate rejected the output"), "validation");
});

test("a task persists ownership, run, dependency, input and idempotency metadata", () => {
  const workflowId = agents.createWorkflow("documents", "Contract fixture", null);
  db.run(
    "INSERT INTO recruitment_runs (id, run_key, workflow_id, trigger, status, created_at) VALUES ('run_contract', 'contract#1', ?, 'manual', 'preparing_applications', ?)",
    [workflowId, new Date().toISOString()],
  );
  const prerequisite = agents.startTask("application", workflowId, "Prepare verified facts", "Fixture", {
    taskType: "orchestration",
  });
  agents.completeTask(prerequisite, "application", "Facts persisted.", false, {
    outputRefs: { factSet: "facts_1" },
  });
  const child = agents.startTask("application", workflowId, "Build package", "Fixture", {
    taskType: "orchestration",
    dependsOn: [prerequisite],
    inputRefs: { jobId: "job_1" },
    idempotencyKey: `fixture:${workflowId}:package`,
  });
  agents.heartbeatTask(child);

  const row = db.one<{
    run_id: string | null;
    task_type: string | null;
    depends_on: string | null;
    input_refs: string | null;
    heartbeat_at: string | null;
    idempotency_key: string | null;
    retry_count: number;
  }>(
    "SELECT run_id, task_type, depends_on, input_refs, heartbeat_at, idempotency_key, retry_count FROM tasks WHERE id = ?",
    [child],
  );
  assert.equal(row?.run_id, "run_contract");
  assert.equal(row?.task_type, "orchestration");
  assert.deepEqual(JSON.parse(row?.depends_on ?? "[]"), [prerequisite]);
  assert.deepEqual(JSON.parse(row?.input_refs ?? "{}"), { jobId: "job_1" });
  assert.ok(row?.heartbeat_at);
  assert.equal(row?.idempotency_key, `fixture:${workflowId}:package`);
  assert.equal(row?.retry_count, 0);
  assert.ok(db.one("SELECT output_refs FROM tasks WHERE id = ?", [prerequisite]));
});

test("an unmet prerequisite creates a durable blocked task and never starts the dependent work", () => {
  const workflowId = agents.createWorkflow("documents", "Blocked fixture", null);
  const prerequisite = agents.startTask("application", workflowId, "Generate CV fixture", "Fixture", {
    taskType: "cv_generation",
  });
  agents.failTask(prerequisite, "application", "The CV quality gate rejected the rendered output.", "validation");

  let blockedTaskId = "";
  assert.throws(
    () =>
      agents.startTask("application", workflowId, "Generate cover letter fixture", "Fixture", {
        taskType: "cover_letter_generation",
        dependsOn: [prerequisite],
      }),
    (error: unknown) => {
      assert.ok(error instanceof agents.TaskBlockedError);
      blockedTaskId = error.taskId;
      assert.match(error.message, /failed prerequisite/i);
      return true;
    },
  );
  const row = db.one<{ status: string; error_class: string | null; state_reason: string | null; depends_on: string | null }>(
    "SELECT status, error_class, state_reason, depends_on FROM tasks WHERE id = ?",
    [blockedTaskId],
  );
  assert.equal(row?.status, "blocked");
  assert.equal(row?.error_class, "dependency");
  assert.match(row?.state_reason ?? "", /failed prerequisite/i);
  assert.deepEqual(JSON.parse(row?.depends_on ?? "[]"), [prerequisite]);
});

test("resume records a retry and failed tasks carry a classified error", () => {
  const workflowId = agents.createWorkflow("documents", "Retry fixture", null);
  const task = agents.startTask("application", workflowId, "Retry fixture task", "Fixture");
  agents.resumeTask(task, "application");
  agents.failTask(task, "application", "HTTP 429: too many requests", "rate_limited");
  const row = db.one<{ retry_count: number; recovery_state: string | null; error_class: string | null; heartbeat_at: string | null }>(
    "SELECT retry_count, recovery_state, error_class, heartbeat_at FROM tasks WHERE id = ?",
    [task],
  );
  assert.equal(row?.retry_count, 1);
  assert.equal(row?.recovery_state, "failed");
  assert.equal(row?.error_class, "rate_limited");
  assert.equal(row?.heartbeat_at, null);
});
