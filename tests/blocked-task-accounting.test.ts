import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-blocked-accounting-"));
process.env.APP_SECRET_KEY = "blocked-task-accounting-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.GEMINI_API_KEY;

// The reporting clock is injected, not inherited from the machine: this file
// must behave identically at 00:05 and at 15:00. The instant is deliberately
// just after Zurich midnight while the UTC date is still the previous day
// (27 Nov), which is exactly the case a UTC-day filter got wrong.
const fixedNow = new Date("2026-11-28T10:00:00.000Z");

const db = await import("../lib/db.ts");
const analytics = await import("../lib/analytics.ts");
const operations = await import("../lib/operations.ts");
const runtimeHealth = await import("../lib/runtime-health.ts");

db.getDb();

// Historical rows keep `status = 'failed'` because the task history is never
// rewritten; only the read-time classification treats a blocked task as blocked.
// Daily analytics uses Europe/Zurich calendar days, so "today" is 28 Nov 2026.
// blockedAt is 00:30 Zurich on 28 Nov but still 27 Nov in UTC: if any query
// falls back to a UTC date filter, these counts become 0 and the test fails.
const blockedAt = "2026-11-27T23:30:00.000Z";
const technicalAt = "2026-11-28T09:30:00.000Z";
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('task_blocked_email', 'email', 'Send the daily notification', 'failed', 'blocked', 'CAPTCHA required by the employer portal', ?)",
  [blockedAt],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('task_blocked_application', 'application', 'Submit the Julius Baer application', 'failed', 'blocked', 'Login wall on the employer portal', ?)",
  [blockedAt],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('task_technical_analysis', 'analysis', 'Score the vacancy', 'failed', 'technical', 'Local scoring transport error', ?)",
  [technicalAt],
);

const today = analytics.dayKey(fixedNow);
const range = { from: today, to: today, preset: "today" as const, label: "Today" };
const data = analytics.getAnalytics(range, fixedNow);

test("the reporting day is the Zurich day, not the UTC day", () => {
  assert.equal(blockedAt.slice(0, 10), "2026-11-27", "the fixture sits on the previous UTC date");
  assert.equal(today, "2026-11-28", "the reporting day is the Zurich calendar day");
});

test("analytics counts only the real technical failure", () => {
  assert.equal(data.productivity.find((row) => row.label === "Failed tasks")?.value, 1);
  assert.equal(data.productivity.find((row) => row.label === "Other outcomes")?.value, 2);
  assert.equal(data.agentDistribution.find((row) => row.label === "Failed latest task")?.value, 1);
  const emailName = db.one<{ name: string }>("SELECT name FROM agents WHERE key = 'email'")?.name ?? "";
  const ranking = data.productivityRanking.find((row) => row.name === emailName);
  assert.ok(ranking);
  assert.equal(ranking!.failed, 0, "a blocked-only agent has no counted failure");
  assert.equal(ranking!.other, 1);
});

test("an agent whose last task was externally blocked is idle, not failed", () => {
  const blockedAgents = data.agentDistribution.find((row) => row.label === "Failed latest task")?.value ?? 0;
  assert.equal(blockedAgents, 1);
  const idle = data.agentDistribution.find((row) => row.label === "Idle")?.value ?? 0;
  assert.ok(idle >= 2, "the two blocked agents fall back to idle state");
});

test("operational diagnostics keep blocked work out of the failure counters", async () => {
  const snapshot = await operations.getOperationalSnapshot({ now: fixedNow });
  assert.equal(snapshot.health.failedTasksToday, 1);
  assert.deepEqual(snapshot.health.recentErrors.map((row) => row.title), ["Score the vacancy"]);

  const email = snapshot.agents.find((agent) => agent.key === "email");
  assert.ok(email);
  assert.equal(email!.lastTaskOutcome, "failed", "history is preserved, not rewritten");
  assert.equal(email!.lastTaskTitle, "Send the daily notification");
});

test("runtime health reports the same single technical failure", () => {
  const health = runtimeHealth.operationalHealthSnapshot(fixedNow);
  assert.equal(health.agents.failedTasksToday, 1);
});

test("the stored rows remain failed with the blocked error class", () => {
  const rows = db.all<{ id: string; status: string; error_class: string | null }>(
    "SELECT id, status, error_class FROM tasks WHERE error_class = 'blocked' ORDER BY id",
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.status === "failed" && row.error_class === "blocked"));
});
