import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-analytics-timezone-"));
process.env.APP_SECRET_KEY = "analytics-timezone-test-secret";
process.env.FREELMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.GEMINI_API_KEY;

const business = await import("../lib/business-day.ts");
const analytics = await import("../lib/analytics.ts");
const db = await import("../lib/db.ts");

db.getDb();

const HOUR = 3_600_000;

test("a Zurich day starts at local midnight, not at UTC midnight", () => {
  assert.equal(business.businessDayKey(new Date("2026-11-27T22:59:59.999Z")), "2026-11-27");
  assert.equal(business.businessDayKey(new Date("2026-11-27T23:00:00.000Z")), "2026-11-28");
  assert.equal(business.businessDayStart("2026-11-28").toISOString(), "2026-11-27T23:00:00.000Z");
  assert.equal(business.businessDayEnd("2026-11-28").toISOString(), "2026-11-28T23:00:00.000Z");
});

test("UTC and Swiss calendar dates differ either side of midnight", () => {
  const instant = new Date("2026-11-27T23:30:00.000Z");
  assert.equal(instant.toISOString().slice(0, 10), "2026-11-27", "UTC still says the 27th");
  assert.equal(business.businessDayKey(instant), "2026-11-28", "Zurich is already the 28th");

  const range = analytics.resolveAnalyticsRange({ preset: "today", today: instant });
  assert.equal(range.from, "2026-11-28");
  assert.equal(range.to, "2026-11-28");
  assert.equal(range.preset, "today");

  // The other direction: 22:30 UTC is 23:30 Zurich, still the same day.
  const beforeMidnight = new Date("2026-11-27T22:30:00.000Z");
  assert.equal(business.businessDayKey(beforeMidnight), "2026-11-27");
});

test("spring-forward day is 23 hours and autumn day is 25 hours", () => {
  const spring = business.businessDayBounds("2026-03-29", "2026-03-29");
  assert.equal(spring.startIso, "2026-03-28T23:00:00.000Z", "CET midnight before the change");
  assert.equal(spring.endIso, "2026-03-29T22:00:00.000Z", "CEST midnight after the change");
  assert.equal((spring.end.getTime() - spring.start.getTime()) / HOUR, 23);

  const autumn = business.businessDayBounds("2026-10-25", "2026-10-25");
  assert.equal(autumn.startIso, "2026-10-24T22:00:00.000Z", "CEST midnight before the change");
  assert.equal(autumn.endIso, "2026-10-25T23:00:00.000Z", "CET midnight after the change");
  assert.equal((autumn.end.getTime() - autumn.start.getTime()) / HOUR, 25);
});

test("the SQL business_day function follows Zurich across a DST change", () => {
  const row = db.one<{ early: string; late: string; before: string }>(
    "SELECT business_day(?) AS early, business_day(?) AS late, business_day(?) AS before",
    ["2026-03-29T22:30:00.000Z", "2026-03-29T21:30:00.000Z", "2026-10-25T22:30:00.000Z"],
  );
  assert.equal(row?.early, "2026-03-30", "00:30 CEST is already the next Zurich day");
  assert.equal(row?.late, "2026-03-29", "23:30 CET is still the same Zurich day");
  assert.equal(row?.before, "2026-10-25", "23:30 CET after the autumn change stays on the 25th");
});

test("analytics counts the Zurich day even when the UTC date differs", () => {
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('tz_inside', 'email', 'Inside the Zurich day', 'failed', 'blocked', 'CAPTCHA', ?)",
    ["2026-11-27T23:30:00.000Z"],
  );
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('tz_outside', 'email', 'Previous Zurich day', 'failed', 'blocked', 'CAPTCHA', ?)",
    ["2026-11-27T22:30:00.000Z"],
  );

  const range = analytics.resolveAnalyticsRange({ preset: "custom", from: "2026-11-28", to: "2026-11-28" });
  const data = analytics.getAnalytics(range, new Date("2026-11-28T10:00:00.000Z"));
  assert.equal(data.generatedAt, "2026-11-28T10:00:00.000Z", "the reporting clock is injected");
  assert.equal(data.range.from, "2026-11-28");
  // Both rows are blocked, so they land in "Other outcomes"; only the row inside
  // the Zurich day belongs to this range.
  assert.equal(data.productivity.find((row) => row.label === "Other outcomes")?.value, 1);
  assert.equal(data.productivity.find((row) => row.label === "Failed tasks")?.value, 0);
});

test("DST days are counted as single buckets, never split or double-counted", () => {
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('dst_spring_early', 'email', 'Spring early', 'completed', NULL, NULL, ?)",
    ["2026-03-28T23:30:00.000Z"], // 00:30 CET on 29 March
  );
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('dst_spring_late', 'email', 'Spring late', 'completed', NULL, NULL, ?)",
    ["2026-03-29T21:30:00.000Z"], // 23:30 CEST on 29 March
  );
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('dst_autumn_early', 'email', 'Autumn early', 'completed', NULL, NULL, ?)",
    ["2026-10-24T22:30:00.000Z"], // 00:30 CEST on 25 October
  );
  db.run(
    "INSERT INTO tasks (id, agent_key, title, status, error_class, error, created_at) VALUES ('dst_autumn_late', 'email', 'Autumn late', 'completed', NULL, NULL, ?)",
    ["2026-10-25T22:30:00.000Z"], // 23:30 CET on 25 October
  );

  const spring = analytics.getAnalytics(
    analytics.resolveAnalyticsRange({ preset: "custom", from: "2026-03-29", to: "2026-03-29" }),
    new Date("2026-03-29T12:00:00.000Z"),
  );
  assert.equal(spring.trends.tasks.at(-1)?.value, 2, "both edges of the 23-hour day count once");

  const autumn = analytics.getAnalytics(
    analytics.resolveAnalyticsRange({ preset: "custom", from: "2026-10-25", to: "2026-10-25" }),
    new Date("2026-10-25T12:00:00.000Z"),
  );
  assert.equal(autumn.trends.tasks.at(-1)?.value, 2, "both edges of the 25-hour day count once");
});
