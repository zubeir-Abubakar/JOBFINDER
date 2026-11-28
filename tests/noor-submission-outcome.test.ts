import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-noor-outcome-"));
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.GMAIL_ENABLED = "false";

const db = await import("../lib/db.ts");
const status = await import("../lib/application-status.ts");
const reconciliation = await import("../lib/submission-reconciliation.ts");
const agents = await import("../lib/agents.ts");

db.getDb();

const BASE = {
  status: "human_intervention_required",
  submission_status: "blocked",
  submitted_at: null,
  confirmation: null,
  evidence: JSON.stringify({ outcomeClass: "blocked_external", externalRequirement: "CAPTCHA" }),
};

test("CAPTCHA is blocked_external, not a technical failure", () => {
  assert.equal(status.canonicalSubmissionOutcome(BASE), "blocked_external");
});

test("all five outcomes stay distinguishable and a blocked/prepared/uncertain record is never verified", () => {
  assert.equal(
    status.canonicalSubmissionOutcome({ ...BASE, status: "submitted", submission_status: "verified", submitted_at: "2026-11-20T10:00:00Z", confirmation: "REF-1" }),
    "submitted_verified",
  );
  assert.equal(
    status.canonicalSubmissionOutcome({ ...BASE, status: "ready_to_submit", submission_status: "simulated", evidence: JSON.stringify({ outcomeClass: "prepared_not_submitted" }) }),
    "prepared_not_submitted",
  );
  assert.equal(
    status.canonicalSubmissionOutcome({ ...BASE, status: "submission_failed", submission_status: "failed", evidence: null }),
    "failed_technical",
  );
  assert.equal(
    status.canonicalSubmissionOutcome({ ...BASE, status: "submission_unverified", submission_status: "unverified", evidence: null }),
    "outcome_uncertain",
  );
  for (const outcome of ["blocked_external", "prepared_not_submitted", "failed_technical", "outcome_uncertain"] as const) {
    assert.notEqual(outcome, "submitted_verified");
  }
});

test("a blocked application is not counted as submitted", () => {
  assert.equal(status.isApplicationSubmitted({ ...BASE }), false);
  assert.equal(status.hasVerifiedSubmissionEvidence({ submitted_at: null, confirmation: null }), false);
  assert.equal(status.submissionEvidenceLabel(BASE), "No verified submission evidence");
});

test("an uncertain submission cannot be retried through another transport", () => {
  const decision = reconciliation.reconciliationDecision({
    status: "unverified",
    httpStatus: null,
    reference: null,
    error: "timeout after submit",
  });
  assert.equal(decision.action, "blocked");
  assert.match(decision.reason, /ambiguous|confirm/i);
});

test("the blocked task state is truthful and is not counted as an agent failure", () => {
  const before = db.one<{ failure_count: number; success_count: number }>(
    "SELECT failure_count, success_count FROM agents WHERE key = 'application'",
  );
  assert.ok(before);

  const now = new Date().toISOString();
  const taskId = "task_noor_captcha_block";
  db.run(
    `INSERT INTO tasks (id, agent_key, title, status, detail, created_at, started_at)
     VALUES (?, 'application', 'Submit fixture at Bank Julius Bär', 'running', 'fixture', ?, ?)`,
    [taskId, now, now],
  );
  agents.blockTask(
    taskId,
    "application",
    "Submission blocked by an external requirement: The application form contains a CAPTCHA, which is never bypassed.",
    { errorClass: "blocked", recoveryState: "blocked_external" },
  );

  const task = db.one<{ status: string; error_class: string; recovery_state: string; requires_input: number }>(
    "SELECT status, error_class, recovery_state, requires_input FROM tasks WHERE id = ?",
    [taskId],
  );
  assert.equal(task?.status, "blocked");
  assert.equal(task?.error_class, "blocked");
  assert.equal(task?.recovery_state, "blocked_external");
  assert.equal(task?.requires_input, 1);

  const after = db.one<{ failure_count: number; success_count: number; status: string }>(
    "SELECT failure_count, success_count, status FROM agents WHERE key = 'application'",
  );
  assert.equal(after?.failure_count, before.failure_count, "an external blocker is not an agent failure");
  assert.equal(after?.success_count, before.success_count, "it is not inflated into a success either");
  assert.equal(after?.status, "waiting");
});

test("blockTask refuses another agent's task", () => {
  assert.throws(
    () => agents.blockTask("task_noor_captcha_block", "research", "wrong owner"),
    /cannot block another agent's task|not active/i,
  );
});

test("the two Bank Julius Bär records remain unsubmitted and externally blocked", () => {
  const now = new Date().toISOString();
  for (const [index, id] of ["app_473408240ffbfbe2dd0f79fb", "app_1a9451a555a294ab73f5771d"].entries()) {
    db.run(
      `INSERT INTO jobs (id, source, title, company, url, status, qualified, remote, discovered_at)
       VALUES (?, 'fixture', 'Senior Test Manager', 'Bank Julius Bär & Co. AG', ?, 'open', 0, 0, ?)`,
      [`job_noor_fixture_${index}`, `https://example.test/job/${index}`, now],
    );
    db.run(
      `INSERT INTO applications (id, job_id, status, submission_status, submission_evidence, submitted_at, approved_at, confirmation, applied_channel, last_update, created_at)
       VALUES (?, ?, 'human_intervention_required', 'blocked', ?, NULL, NULL, NULL, NULL, ?, ?)`,
      [id, `job_noor_fixture_${index}`, JSON.stringify({ outcomeClass: "blocked_external", externalRequirement: "CAPTCHA" }), now, now],
    );
    const row = db.one<{ status: string; submitted_at: string | null; confirmation: string | null; submission_status: string | null; submission_evidence: string | null }>(
      "SELECT status, submitted_at, confirmation, submission_status, submission_evidence FROM applications WHERE id = ?",
      [id],
    );
    assert.equal(row?.status, "human_intervention_required");
    assert.equal(row?.submitted_at, null);
    assert.equal(row?.confirmation, null);
    assert.equal(row?.submission_status, "blocked");
    assert.equal(status.canonicalSubmissionOutcome(row!), "blocked_external");
    assert.equal(status.isApplicationSubmitted(row!), false);
  }
});
