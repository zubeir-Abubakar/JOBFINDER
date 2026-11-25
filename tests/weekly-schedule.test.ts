import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-weekly-schedule-"));
process.env.APP_SECRET_KEY = "weekly-schedule-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.RECRUITMENT_DRY_RUN;

const db = await import("../lib/db.ts");
const schedule = await import("../lib/recruitment-schedule.ts");
const brief = await import("../lib/executive-brief.ts");
const ticker = await import("../lib/recruitment-ticker.ts");

db.getDb();
brief.ensureExecutiveBriefSchedule(new Date("2026-11-20T08:00:00Z"));

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("initial state is Monday–Sunday at 12:00 with one daily slot and 16:00 for the report", () => {
  const recruitment = schedule.ensureSchedule(new Date("2026-11-20T08:00:00Z"));
  assert.equal(recruitment.time, "12:00");
  assert.equal(recruitment.timezone, "Europe/Zurich");
  assert.deepEqual(schedule.parseWeekdays(recruitment.weekdays), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(recruitment.enabled, 1);
  assert.deepEqual(schedule.recruitmentRunTimes(recruitment.time), [{ time: "12:00", mode: "full" }]);

  const report = brief.ensureExecutiveBriefSchedule(new Date("2026-11-20T08:00:00Z"));
  assert.equal(report.time, "16:00");
  assert.equal(report.timezone, "Europe/Zurich");
  assert.deepEqual(schedule.parseWeekdays(report.weekdays), [1, 2, 3, 4, 5]);
});

test("weekdays and times change independently and persist after a database reopen", () => {
  const now = new Date("2026-11-20T08:00:00Z");
  const recruitment = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [2, 4], time: "07:30", timezone: "Europe/Zurich" },
    now,
  );
  assert.equal(recruitment.ok, true);
  if (!recruitment.ok) return;
  assert.deepEqual(schedule.parseWeekdays(recruitment.schedule.weekdays), [2, 4]);
  assert.equal(recruitment.schedule.time, "07:30");

  const report = schedule.saveScheduleConfiguration(
    schedule.REPORT_SCHEDULE_KEY,
    { enabled: true, weekdays: [1, 3, 5], time: "18:00", timezone: "Europe/Zurich" },
    now,
  );
  assert.equal(report.ok, true);
  if (!report.ok) return;
  assert.deepEqual(schedule.parseWeekdays(report.schedule.weekdays), [1, 3, 5]);
  assert.equal(report.schedule.time, "18:00");

  // Recruitment changes did not leak into the report schedule.
  assert.equal(brief.ensureExecutiveBriefSchedule(now).time, "18:00");
  assert.equal(schedule.ensureSchedule(now).time, "07:30");

  db.closeDb();
  db.getDb();
  assert.equal(schedule.ensureSchedule(now).time, "07:30");
  assert.deepEqual(schedule.parseWeekdays(schedule.ensureSchedule(now).weekdays), [2, 4]);
  assert.equal(brief.ensureExecutiveBriefSchedule(now).time, "18:00");
});

test("invalid time, timezone and weekday values are rejected server-side", () => {
  const now = new Date("2026-11-20T08:00:00Z");
  const invalidTime = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [1], time: "25:99", timezone: "Europe/Zurich" },
    now,
  );
  assert.equal(invalidTime.ok, false);
  assert.match(invalidTime.error, /time/i);

  const invalidZone = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [1], time: "09:00", timezone: "Mars/Olympus" },
    now,
  );
  assert.equal(invalidZone.ok, false);
  assert.match(invalidZone.error, /timezone/i);

  const invalidDays = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [0, 9], time: "09:00", timezone: "Europe/Zurich" },
    now,
  );
  assert.equal(invalidDays.ok, false);
  assert.match(invalidDays.error, /weekday/i);

  const emptyDays = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [], time: "09:00", timezone: "Europe/Zurich" },
    now,
  );
  assert.equal(emptyDays.ok, false);
});

test("every weekday including Sunday is an operating day", () => {
  // Saturday 21 Nov 2026 at 12:00 local has just occurred; Sunday is next.
  const next = schedule.nextScheduledRun(new Date("2026-11-21T11:00:00Z"), {
    time: "12:00",
    weekdays: [1, 2, 3, 4, 5, 6, 7],
  });
  assert.equal(next.toISOString(), "2026-11-22T11:00:00.000Z");
  const sunday = schedule.nextRecruitmentOccurrence(new Date("2026-11-22T06:00:00Z"));
  assert.equal(sunday.scheduledFor, "2026-11-22T11:00:00.000Z");
  assert.equal(sunday.mode, "full");
  assert.equal(sunday.time, "12:00");
});

test("DST spring-forward shifts a nonexistent local time forward and autumn-back resolves to the earlier instant", () => {
  // Europe/Zurich 2026-03-29 02:30 does not exist (02:00 → 03:00).
  const spring = schedule.zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Zurich");
  const springParts = schedule.zonedParts(spring, "Europe/Zurich");
  assert.equal(springParts.hour, 3);
  assert.equal(springParts.minute, 0);

  // 2026-10-25 02:30 occurs twice; the earlier (CEST) instant is chosen.
  const autumn = schedule.zonedTimeToUtc(2026, 10, 25, 2, 30, "Europe/Zurich");
  assert.equal(autumn.toISOString(), "2026-10-25T00:30:00.000Z");

  // The next 12:00 occurrence keeps its wall clock across both changes. Sunday
  // is a configured day, so the spring/autumn transition day itself runs.
  assert.equal(
    schedule.nextRecruitmentOccurrence(new Date("2026-03-28T19:30:00Z")).scheduledFor,
    "2026-03-29T10:00:00.000Z",
  );
  assert.equal(
    schedule.nextRecruitmentOccurrence(new Date("2026-10-24T18:30:00Z")).scheduledFor,
    "2026-10-25T11:00:00.000Z",
  );
});

test("a rest day makes no scheduled recruitment decision and consumes no run", async () => {
  const mondayMorning = new Date("2026-11-23T08:00:00Z");
  schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [2], time: "12:00", timezone: "Europe/Zurich" },
    new Date("2026-11-20T08:00:00Z"),
  );
  db.run("UPDATE schedule_jobs SET next_run_at = ? WHERE key = ?", [
    new Date("2026-11-23T11:00:00Z").toISOString(),
    schedule.RECRUITMENT_SCHEDULE_KEY,
  ]);
  const before = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM recruitment_runs")?.c ?? 0);
  const result = await ticker.tickRecruitmentSchedule(mondayMorning);
  assert.equal(result.started, false);
  assert.match(result.reason ?? "", /not a configured recruitment day/i);
  const afterCount = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM recruitment_runs")?.c ?? 0);
  assert.equal(afterCount, before, "no recruitment run was created on a rest day");
});

test("the same scheduled occurrence cannot be executed twice", () => {
  const occurrence = "2026-11-24T08:00:00.000Z";
  schedule.recordScheduleRun({
    runId: "run_occurrence_fixture",
    status: "completed",
    scheduledFor: occurrence,
    now: new Date("2026-11-24T08:05:00Z"),
    key: schedule.RECRUITMENT_SCHEDULE_KEY,
  });
  assert.equal(schedule.occurrenceAlreadyExecuted(schedule.RECRUITMENT_SCHEDULE_KEY, occurrence), true);
  assert.equal(schedule.occurrenceAlreadyExecuted(schedule.RECRUITMENT_SCHEDULE_KEY, "2026-11-25T08:00:00.000Z"), false);
});
