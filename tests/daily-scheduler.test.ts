import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-daily-scheduler-"));
process.env.APP_SECRET_KEY = "daily-scheduler-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.RECRUITMENT_DRY_RUN;

const db = await import("../lib/db.ts");
const schedule = await import("../lib/recruitment-schedule.ts");
const ticker = await import("../lib/recruitment-ticker.ts");
const runtime = await import("../lib/runtime-state.ts");
const scoring = await import("../lib/scoring.ts");
const runs = await import("../lib/recruitment-run.ts");

db.getDb();

const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
const KEY = schedule.RECRUITMENT_SCHEDULE_KEY;
const runCount = () => Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM recruitment_runs")?.c ?? 0);
const applicationCount = () => Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0);
const settingsSnapshot = () =>
  db.all<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN ('min_match_score','autonomous_submission','recruitment_dry_run','max_applications_per_day','approval_mode') ORDER BY key",
  );

/** Force the persisted row into a known state without going through the UI. */
function setScheduleRow(input: { time?: string; weekdays?: number[]; nextRunAt: string | null; enabled?: number; lastScheduledFor?: string | null; lastRunId?: string | null }) {
  db.run(
    `UPDATE schedule_jobs SET time = ?, timezone = 'Europe/Zurich', enabled = ?, weekdays = ?, next_run_at = ?,
       last_scheduled_for = ?, last_run_id = ? WHERE key = ?`,
    [
      input.time ?? "12:00",
      input.enabled ?? 1,
      JSON.stringify(input.weekdays ?? ALL_DAYS),
      input.nextRunAt,
      input.lastScheduledFor ?? null,
      input.lastRunId ?? null,
      KEY,
    ],
  );
}

after(() => {
  ticker.stopRecruitmentScheduler();
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("the persisted schedule is one run per day at 12:00 Europe/Zurich on Monday–Sunday", () => {
  const now = new Date("2026-11-24T06:00:00Z");
  const row = schedule.ensureSchedule(now);
  assert.equal(row.time, "12:00");
  assert.equal(row.timezone, "Europe/Zurich");
  assert.equal(row.enabled, 1);
  assert.deepEqual(schedule.parseWeekdays(row.weekdays), ALL_DAYS);
  assert.equal(row.next_run_at, "2026-11-24T11:00:00.000Z");

  // Exactly one slot: no 10:00 legacy slot and no +2h incremental slots.
  assert.deepEqual(schedule.recruitmentRunTimes(row.time), [{ time: "12:00", mode: "full" }]);
  const snapshot = schedule.scheduleSnapshot(now);
  assert.deepEqual(snapshot.slotTimes, ["12:00"]);
  assert.deepEqual(snapshot.incrementalTimes, []);
  assert.equal(snapshot.nextRunTime, "12:00");
  assert.equal(snapshot.nextRunMode, "full");
  assert.equal(snapshot.due, false);
});

test("a legacy 10:00 Monday–Saturday row is corrected to 12:00 every day, once", () => {
  setScheduleRow({ time: "10:00", weekdays: [1, 2, 3, 4, 5, 6], nextRunAt: "2026-11-24T09:00:00.000Z" });
  const corrected = schedule.ensureSchedule(new Date("2026-11-24T06:00:00Z"));
  assert.equal(corrected.time, "12:00");
  assert.deepEqual(schedule.parseWeekdays(corrected.weekdays), ALL_DAYS);
  assert.equal(corrected.next_run_at, "2026-11-24T11:00:00.000Z");

  // An owner-edited clock is preserved: the correction is not a permanent override.
  const edited = schedule.saveScheduleConfiguration(
    KEY,
    { enabled: true, weekdays: [2, 4], time: "07:30", timezone: "Europe/Zurich" },
    new Date("2026-11-24T06:00:00Z"),
  );
  assert.equal(edited.ok, true);
  const afterEdit = schedule.ensureSchedule(new Date("2026-11-24T06:00:00Z"));
  assert.equal(afterEdit.time, "07:30");
  assert.deepEqual(schedule.parseWeekdays(afterEdit.weekdays), [2, 4]);

  // Restore the production configuration for the remaining tests.
  schedule.saveScheduleConfiguration(
    KEY,
    { enabled: true, weekdays: ALL_DAYS, time: "12:00", timezone: "Europe/Zurich" },
    new Date("2026-11-24T06:00:00Z"),
  );
});

test("every calendar day has exactly one 12:00 occurrence", () => {
  for (let offset = 0; offset < 7; offset += 1) {
    // 01:30 local on each day, before the 12:00 run.
    const day = new Date(Date.UTC(2026, 10, 23 + offset, 0, 30));
    const next = schedule.nextRecruitmentOccurrence(day);
    assert.equal(schedule.localDateKey(new Date(next.scheduledFor)), schedule.localDateKey(day));
    assert.equal(schedule.localClockTime(next.scheduledFor), "12:00");
    assert.equal(next.time, "12:00");
    assert.equal(next.mode, "full");
    // Never a second occurrence later on the same local day.
    const following = schedule.nextRecruitmentOccurrence(new Date(next.scheduledFor));
    assert.notEqual(schedule.localDateKey(new Date(following.scheduledFor)), schedule.localDateKey(day));
  }
});

test("12:00 local time is preserved across both DST transitions", () => {
  // Spring forward: Sunday 29 March 2026 is a scheduled day (CEST, UTC+2).
  const spring = schedule.nextRecruitmentOccurrence(new Date("2026-03-28T12:00:00Z"));
  assert.equal(spring.scheduledFor, "2026-03-29T10:00:00.000Z");
  assert.equal(schedule.localClockTime(spring.scheduledFor), "12:00");
  assert.equal(schedule.localWeekday(new Date(spring.scheduledFor)), 7);

  // Autumn back: Sunday 25 October 2026 is a scheduled day (CET, UTC+1).
  const autumn = schedule.nextRecruitmentOccurrence(new Date("2026-10-24T12:00:00Z"));
  assert.equal(autumn.scheduledFor, "2026-10-25T11:00:00.000Z");
  assert.equal(schedule.localClockTime(autumn.scheduledFor), "12:00");
  assert.equal(schedule.localWeekday(new Date(autumn.scheduledFor)), 7);
});

test("a restart after the run does not trigger an immediate extra run", async () => {
  const now = new Date("2026-11-24T12:30:00Z"); // 13:30 local, after today's run
  const occurrence = "2026-11-24T11:00:00.000Z";
  setScheduleRow({ nextRunAt: occurrence, lastScheduledFor: occurrence, lastRunId: "run_already_executed" });
  const before = runCount();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await ticker.tickRecruitmentSchedule(now);
    assert.equal(result.started, false);
    assert.match(result.reason ?? "", /already ran|cannot be executed twice|not due/i);
  }
  assert.equal(runCount(), before, "no extra recruitment run was created by restarts");
});

test("repeated scheduler initialisation registers one timer and one worker", () => {
  // Keep the persisted slot in the future so starting the scheduler cannot
  // create a run that leaks into the next test as date-relative time advances.
  setScheduleRow({ nextRunAt: new Date(Date.now() + 48 * 3600_000).toISOString() });
  process.env.RECRUITMENT_SCHEDULER = "true";
  ticker.startRecruitmentScheduler();
  ticker.startRecruitmentScheduler();
  ticker.startRecruitmentScheduler();
  assert.equal(ticker.recruitmentSchedulerStatus().running, true);
  const workers = runtime.runtimeWorkerSnapshot().filter((worker) => worker.name === "recruitment_scheduler");
  assert.equal(workers.length, 1, "the scheduler registers exactly one worker row");
  ticker.stopRecruitmentScheduler();
  assert.equal(ticker.recruitmentSchedulerStatus().running, false);
  process.env.RECRUITMENT_SCHEDULER = "false";
});

test("a late start records the occurrence as missed at its scheduled timestamp and never executes it", async () => {
  const occurrence = "2026-11-24T11:00:00.000Z"; // 12:00 Europe/Zurich, Tuesday
  setScheduleRow({ nextRunAt: occurrence });
  const before = runCount();
  // 12:40 local: the process was not running at 12:00. This is a missed slot,
  // not a late start to be compensated.
  const first = await ticker.tickRecruitmentSchedule(new Date("2026-11-24T11:40:00.000Z"));
  assert.equal(first.started, false);
  assert.match(first.reason ?? "", /missed/i);
  assert.equal(runCount(), before + 1, "exactly one missed occurrence record is added");

  const missed = runs.runById(first.runId ?? "");
  assert.ok(missed, "the missed occurrence is persisted as a run record");
  assert.equal(missed!.status, "missed");
  assert.equal(missed!.trigger, "missed");
  assert.equal(missed!.scheduled_for, occurrence, "the scheduled timestamp is preserved");
  assert.equal(missed!.started_at, null, "the missed occurrence was never started");
  assert.match(missed!.error ?? "", /12:00/);
  assert.match(missed!.error ?? "", /not executed late/i);

  const executed = db.all<{ id: string }>(
    "SELECT id FROM recruitment_runs WHERE scheduled_for = ? AND status != 'missed'",
    [occurrence],
  );
  assert.equal(executed.length, 0, "no recruitment execution was created for the missed slot");

  const row = schedule.getSchedule(new Date("2026-11-24T11:40:00.000Z"));
  assert.equal(row.last_status, "missed");
  assert.equal(row.last_scheduled_for, occurrence);
  assert.equal(row.next_run_at, "2026-11-25T11:00:00.000Z", "the schedule moves to the next day's single occurrence");
});

test("duplicate ticks after a missed occurrence add nothing and never start a run", async () => {
  const occurrence = "2026-11-24T11:00:00.000Z";
  setScheduleRow({ nextRunAt: occurrence });
  const before = runCount();
  await ticker.tickRecruitmentSchedule(new Date("2026-11-24T11:40:00.000Z"));
  assert.equal(runCount(), before + 1);
  for (const late of ["2026-11-24T11:41:00.000Z", "2026-11-24T12:30:00.000Z", "2026-11-25T09:00:00.000Z"]) {
    const again = await ticker.tickRecruitmentSchedule(new Date(late));
    assert.equal(again.started, false);
    assert.doesNotMatch(again.reason ?? "", /already in progress/i);
  }
  assert.equal(runCount(), before + 1, "further ticks do not add catch-up or duplicate runs");
  const scheduledRuns = db.all<{ id: string }>("SELECT id FROM recruitment_runs WHERE trigger = 'schedule' AND scheduled_for = ?", [occurrence]);
  assert.equal(scheduledRuns.length, 0);
});

test("the 60-second ticker starts the occurrence only inside its short tolerance", () => {
  const occurrence = "2026-11-24T11:00:00.000Z";
  setScheduleRow({ nextRunAt: occurrence });
  const early = schedule.scheduleSnapshot(new Date("2026-11-24T10:59:30.000Z"));
  assert.equal(early.due, false);
  assert.equal(early.missed, false);
  const onTime = schedule.scheduleSnapshot(new Date("2026-11-24T11:00:45.000Z"));
  assert.equal(onTime.due, true);
  assert.equal(onTime.missed, false);
  const tooLate = schedule.scheduleSnapshot(new Date("2026-11-24T11:03:00.000Z"));
  assert.equal(tooLate.due, false);
  assert.equal(tooLate.missed, true);
});

test("a stopped scheduler worker misses the slot and reports itself stopped until the process returns", async () => {
  ticker.stopRecruitmentScheduler();
  assert.equal(ticker.recruitmentSchedulerStatus().running, false);
  const workerBefore = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "recruitment_scheduler");
  assert.ok(workerBefore, "the stopped worker is still observable for health");
  assert.equal(workerBefore!.effectiveStatus, "stopped");

  const occurrence = "2026-11-25T11:00:00.000Z";
  setScheduleRow({ nextRunAt: occurrence });
  const before = runCount();
  const result = await ticker.tickRecruitmentSchedule(new Date("2026-11-25T12:10:00.000Z"));
  assert.equal(result.started, false, "a missed occurrence never starts discovery");
  assert.equal(runCount(), before + 1);
  assert.equal(runs.runById(result.runId ?? "")?.status, "missed");
  const workerAfter = runtime.runtimeWorkerSnapshot().find((worker) => worker.name === "recruitment_scheduler");
  assert.equal(workerAfter?.effectiveStatus, "running", "the returning process heartbeats the worker again");
});

test("missed detection uses the Zurich wall clock across both DST transitions", () => {
  // Spring forward: 12:00 Zurich is 10:00Z on Sunday 29 March 2026.
  const spring = "2026-03-29T10:00:00.000Z";
  assert.equal(schedule.localClockTime(spring), "12:00");
  setScheduleRow({ nextRunAt: spring });
  assert.equal(schedule.scheduleSnapshot(new Date("2026-03-29T09:59:30.000Z")).due, false);
  const springOnTime = schedule.scheduleSnapshot(new Date("2026-03-29T10:00:30.000Z"));
  assert.equal(springOnTime.due, true);
  assert.equal(springOnTime.missed, false);
  const springLate = schedule.scheduleSnapshot(new Date("2026-03-29T10:05:00.000Z"));
  assert.equal(springLate.due, false);
  assert.equal(springLate.missed, true);
  assert.equal(springLate.nextRunAt, spring);

  // Autumn back: 12:00 Zurich is 11:00Z on Sunday 25 October 2026.
  const autumn = "2026-10-25T11:00:00.000Z";
  assert.equal(schedule.localClockTime(autumn), "12:00");
  setScheduleRow({ nextRunAt: autumn });
  const autumnOnTime = schedule.scheduleSnapshot(new Date("2026-10-25T11:00:30.000Z"));
  assert.equal(autumnOnTime.due, true);
  assert.equal(autumnOnTime.missed, false);
  const autumnLate = schedule.scheduleSnapshot(new Date("2026-10-25T11:05:00.000Z"));
  assert.equal(autumnLate.due, false);
  assert.equal(autumnLate.missed, true);
  assert.equal(autumnLate.nextRunAt, autumn);
});

test("an in-progress recruitment run prevents overlapping execution", async () => {
  const now = new Date();
  const scheduledFor = new Date(now.getTime() - 5 * 60_000).toISOString();
  setScheduleRow({ nextRunAt: scheduledFor });
  db.run(
    `INSERT INTO recruitment_runs (id, run_key, scheduled_for, trigger, status, state_history, created_at)
     VALUES ('run_overlap_fixture', 'overlap-fixture', ?, 'schedule', 'discovering', '[]', ?)`,
    [scheduledFor, now.toISOString()],
  );
  // A live lease marks the run as genuinely in progress, so startup recovery
  // must not convert it into an interrupted run and free the slot. The lease is
  // written on the test clock, because acquireRuntimeLock() always uses the
  // host clock for its expiry.
  db.run(
    `INSERT OR REPLACE INTO runtime_locks (key, owner, acquired_at, heartbeat_at, expires_at, meta)
     VALUES ('recruitment:run:run_overlap_fixture', 'test-owner', ?, ?, ?, NULL)`,
    [now.toISOString(), now.toISOString(), new Date(now.getTime() + 300_000).toISOString()],
  );
  const before = runCount();
  const result = await ticker.tickRecruitmentSchedule(now);
  assert.equal(result.started, false);
  assert.match(result.reason ?? "", /already in progress/i);
  assert.equal(result.runId, "run_overlap_fixture");
  assert.equal(runCount(), before, "no overlapping run was created");
  db.run("DELETE FROM runtime_locks WHERE key = 'recruitment:run:run_overlap_fixture'");
  db.run("UPDATE recruitment_runs SET status = 'failed', finished_at = ? WHERE id = 'run_overlap_fixture'", [now.toISOString()]);
});

test("the scheduling change leaves qualification, submission and provider safeguards untouched", async () => {
  setScheduleRow({ nextRunAt: new Date(Date.now() - 24 * 3600_000).toISOString() });
  const settingsBefore = settingsSnapshot();
  const applicationsBefore = applicationCount();
  await ticker.tickRecruitmentSchedule(new Date());
  assert.deepEqual(settingsSnapshot(), settingsBefore, "no policy setting was rewritten by the scheduler");
  assert.equal(applicationCount(), applicationsBefore, "no application was created or submitted by scheduling");
  assert.equal(scoring.effectiveMinMatchScore(60), 85);
  assert.equal(scoring.effectiveMinMatchScore(80), 85);
  assert.equal(scoring.qualifiesForAutoApply({ score: 84, concerns: [] }), false);
  assert.equal(scoring.qualifiesForAutoApply({ score: 85, concerns: [] }), true);
});
