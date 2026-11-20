import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-workflow-auth-"));
process.env.APP_SECRET_KEY = "workflow-auth-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

const db = await import("../lib/db.ts");
const view = await import("../lib/workflow-view.ts");
const workflow = await import("../lib/workflow.ts");

after(() => {
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

db.getDb();
const now = new Date().toISOString();
for (const [id, email, role] of [
  ["u_owner_a", "owner-a@example.com", "owner"],
  ["u_owner_b", "owner-b@example.com", "owner"],
  ["u_admin", "admin@example.com", "admin"],
] as const) {
  db.run(
    "INSERT INTO users (id, email, password_hash, name, role, status, created_at) VALUES (?, ?, 'unused', ?, ?, 'active', ?)",
    [id, email, id, role, now],
  );
}
for (const [id, label, startedBy] of [
  ["wf_a", "Owner A workflow", "u_owner_a"],
  ["wf_b", "Owner B workflow", "u_owner_b"],
  ["wf_legacy", "Legacy workflow", null],
] as const) {
  db.run(
    "INSERT INTO workflows (id, kind, label, status, started_by, created_at) VALUES (?, 'recruitment', ?, 'paused', ?, ?)",
    [id, label, startedBy, now],
  );
}

const ownerA = { id: "u_owner_a", role: "owner" };
const ownerB = { id: "u_owner_b", role: "owner" };
const admin = { id: "u_admin", role: "admin" };

test("an owner cannot read another owner's workflow or events snapshot", () => {
  assert.equal(view.workflowAccessibleTo(ownerA, { started_by: "u_owner_a" }), true);
  assert.equal(view.workflowAccessibleTo(ownerA, { started_by: "u_owner_b" }), false);
  assert.equal(view.workflowAccessibleTo(admin, { started_by: "u_owner_b" }), true);
  assert.equal(view.workflowSnapshotForUser(ownerA, "wf_a")?.workflow?.id, "wf_a");
  assert.equal(view.workflowSnapshotForUser(ownerA, "wf_b"), null);
  assert.equal(view.latestWorkflowSnapshotForUser(ownerB).workflow?.id, "wf_b");
});

test("legacy null-owner workflows are limited to a sole owner, not a multi-owner deployment", () => {
  // The fixtures already contain two owners, so the legacy row is admin-only.
  assert.equal(view.workflowAccessibleTo(ownerA, { started_by: null }), false);
  db.run("UPDATE users SET status = 'disabled' WHERE id = 'u_owner_b'");
  assert.equal(view.workflowAccessibleTo(ownerA, { started_by: null }), true);
  db.run("UPDATE users SET status = 'active' WHERE id = 'u_owner_b'");
});

test("approval metadata is scoped to the workflow's recruitment run", () => {
  const at = new Date().toISOString();
  db.run("UPDATE workflows SET status = 'completed' WHERE id IN ('wf_a', 'wf_b')");
  db.run(
    "INSERT INTO jobs (id, source, external_id, title, company, discovered_at, status, match_score) VALUES ('job_b', 'manual', 'ext_job_b', 'Role B', 'Company B', ?, 'new', 95)",
    [at],
  );
  db.run(
    "INSERT INTO applications (id, job_id, status, last_update, created_at, run_id) VALUES ('app_b', 'job_b', 'awaiting_approval', ?, ?, 'run_b')",
    [at, at],
  );
  db.run(
    "INSERT INTO recruitment_runs (id, run_key, workflow_id, trigger, status, created_at) VALUES ('run_b', 'run_b_key', 'wf_b', 'manual', 'completed', ?)",
    [at],
  );
  assert.equal(view.workflowSnapshotForUser(ownerA, "wf_a")?.approval, null);
  assert.equal(view.workflowSnapshotForUser(ownerB, "wf_b")?.approval?.id, "app_b");
  assert.equal(view.workflowSnapshotForUser(admin, "wf_b")?.approval?.id, "app_b");
});

test("workflow control and retry enforce ownership before any execution", async () => {
  const denied = await workflow.retryWorkflow(ownerA, "wf_b");
  assert.equal(denied.ok, false);
  assert.match(denied.message, /not found/i);
  assert.equal(workflow.workflowActor("u_owner_a").role, "owner");
  assert.equal(workflow.workflowActor("u_admin").role, "admin");

  db.run("UPDATE workflows SET status = 'running' WHERE id = 'wf_b'");
  const message = await workflow.pauseRunningWorkflow(ownerA);
  assert.doesNotMatch(message, /requested/i, "owner A cannot pause owner B's running workflow");
  db.run("UPDATE workflows SET status = 'paused' WHERE id = 'wf_b'");
});
