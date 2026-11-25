import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase1-isolation-"));
process.env.APP_SECRET_KEY = "phase1-isolation-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const runs = await import("../lib/recruitment-run.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("a research task failed mid-run does not abort the run or lose discovery", async () => {
  const now = new Date("2026-11-24T09:00:00Z");
  const created = runs.createRecruitmentRun({ trigger: "manual", now });
  assert.equal(created.created, true);

  let stalled = 0;
  const outcome = await runs.executeRun(created.run.id, {
    now,
    deps: {
      discover: async () => {
        // Simulate the stall sweeper failing the research task while discovery
        // is still in flight. Before isolation this made safeComplete() throw
        // and the whole run was recorded as failed.
        db.run(
          "UPDATE tasks SET status = 'failed', error = 'injected stall' WHERE agent_key = 'research' AND status IN ('running','working','thinking','planned','queued')",
        );
        stalled = Number(
          db.one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE agent_key = 'research' AND error = 'injected stall'")?.c ?? 0,
        );
        return {
          discovered: 0,
          inserted: 0,
          duplicates: 0,
          updated: 0,
          filtered: 0,
          jobIds: [],
          sources: [],
          warnings: ["Injected: research task was failed by the stall sweeper."],
        };
      },
    },
  });

  assert.equal(stalled, 1, "the research task existed and was failed");
  assert.equal(outcome.runId, created.run.id);
  const stored = runs.runById(created.run.id);
  assert.ok(stored);
  assert.ok(
    ["completed", "completed_with_warnings"].includes(stored!.status),
    `run status ${stored!.status} must not be failed: ${stored!.error ?? "no error"}`,
  );

  // The guard is intact: the task is still failed and was not resurrected by
  // the isolated completion attempt.
  const task = db.one<{ status: string; error: string | null }>(
    "SELECT status, error FROM tasks WHERE agent_key = 'research' AND error = 'injected stall' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(task?.status, "failed");
  assert.equal(task?.error, "injected stall");

  // Isolation is recorded, so the rejected completion is auditable.
  const isolated = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'recruitment.task_state_isolated'",
  );
  assert.ok(Number(isolated?.c ?? 0) >= 1, "the rejected completion is recorded in the audit log");
});

test("completeTask still refuses a task that is already failed", async () => {
  const agents = await import("../lib/agents.ts");
  const now = new Date();
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('task_guard_fixture', 'research', 'Guard', 'failed', ?)",
    [now.toISOString()],
  );
  assert.throws(() => agents.completeTask("task_guard_fixture", "research", "should not apply"), /not active|failed/i);
});
