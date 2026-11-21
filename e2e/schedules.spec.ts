import { test, expect, gotoReady } from "./support/fixtures";
import { execute, one } from "./support/db";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

type ScheduleRow = {
  key: string;
  time: string;
  timezone: string;
  enabled: number;
  weekdays: string | null;
  next_run_at: string | null;
  last_scheduled_for: string | null;
};

let originalRecruitment: ScheduleRow | null = null;
let originalReport: ScheduleRow | null = null;

test.beforeAll(() => {
  originalRecruitment = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  originalReport = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_executive_brief'",
  );
});

test.afterAll(() => {
  for (const row of [originalRecruitment, originalReport]) {
    if (!row) continue;
    execute(
      "UPDATE schedule_jobs SET time = ?, timezone = ?, enabled = ?, weekdays = ?, next_run_at = ?, last_scheduled_for = ? WHERE key = ?",
      row.time,
      row.timezone,
      row.enabled,
      row.weekdays,
      row.next_run_at,
      row.last_scheduled_for,
      row.key,
    );
  }
});

test("the two cards show the saved Monday–Friday defaults and change independently", async ({ page, diagnostics }) => {
  await gotoReady(page, "/settings#scheduling");
  const recruitment = page.getByTestId("recruitment-schedule-card");
  const report = page.getByTestId("report-schedule-card");
  await expect(recruitment).toBeVisible();
  await expect(report).toBeVisible();

  await expect(recruitment.getByRole("checkbox", { name: "Mon", exact: true })).toBeChecked();
  await expect(recruitment.getByRole("checkbox", { name: "Fri", exact: true })).toBeChecked();
  await expect(recruitment.getByRole("checkbox", { name: "Sat", exact: true })).not.toBeChecked();
  await expect(recruitment.getByRole("checkbox", { name: "Sun", exact: true })).not.toBeChecked();
  await expect(recruitment.locator("select[name='time']")).toHaveValue("09:00");
  await expect(report.locator("select[name='time']")).toHaveValue("16:00");

  // Change recruitment only: remove Monday, add Saturday, start at 07:30.
  await recruitment.getByRole("checkbox", { name: "Mon", exact: true }).uncheck();
  await recruitment.getByRole("checkbox", { name: "Sat", exact: true }).check();
  await recruitment.locator("select[name='time']").selectOption("07:30");
  await recruitment.getByRole("button", { name: /Save recruitment schedule/i }).click();
  await page.waitForURL(/\/settings\?saved=1/, { timeout: 30_000 });

  const savedRecruitment = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  expect(savedRecruitment?.time).toBe("07:30");
  expect(JSON.parse(savedRecruitment?.weekdays ?? "[]")).toEqual([2, 3, 4, 5, 6]);
  expect(savedRecruitment?.timezone).toBe("Europe/Zurich");

  // The report card was not touched.
  const reportAfter = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_executive_brief'",
  );
  expect(reportAfter?.time).toBe("16:00");
  expect(JSON.parse(reportAfter?.weekdays ?? "[]")).toEqual([1, 2, 3, 4, 5]);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("recruitment-schedule-card").getByRole("checkbox", { name: "Mon", exact: true })).not.toBeChecked();
  await expect(page.getByTestId("recruitment-schedule-card").getByRole("checkbox", { name: "Sat", exact: true })).toBeChecked();
  await expect(page.getByTestId("recruitment-schedule-card").locator("select[name='time']")).toHaveValue("07:30");
  await expect(page.getByTestId("report-schedule-card").locator("select[name='time']")).toHaveValue("16:00");

  // Now change the report independently: Sunday only at 18:00.
  await report.getByRole("checkbox", { name: "Mon", exact: true }).uncheck();
  await report.getByRole("checkbox", { name: "Sun", exact: true }).check();
  await report.locator("select[name='time']").selectOption("18:00");
  await report.getByRole("button", { name: /Save report schedule/i }).click();
  // The URL is already /settings?saved=1 from the previous save, so wait for
  // the persisted value instead of a URL change that has already happened.
  await expect
    .poll(
      () =>
        one<ScheduleRow>(
          "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_executive_brief'",
        )?.time,
      { timeout: 20_000 },
    )
    .toBe("18:00");

  const savedReport = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_executive_brief'",
  );
  expect(savedReport?.time).toBe("18:00");
  expect(JSON.parse(savedReport?.weekdays ?? "[]")).toContain(7);
  expect(JSON.parse(savedReport?.weekdays ?? "[]")).not.toContain(1);

  const recruitmentUnchanged = one<ScheduleRow>(
    "SELECT key, time, timezone, enabled, weekdays, next_run_at, last_scheduled_for FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  expect(recruitmentUnchanged?.time).toBe("07:30");
  expect(JSON.parse(recruitmentUnchanged?.weekdays ?? "[]")).toEqual([2, 3, 4, 5, 6]);

  diagnostics.assertClean();
});

test("the cards remain usable without horizontal overflow at desktop, tablet and mobile widths", async ({ page, diagnostics }) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 360, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await gotoReady(page, "/settings#scheduling");
    const recruitment = page.getByTestId("recruitment-schedule-card");
    const report = page.getByTestId("report-schedule-card");
    await expect(recruitment).toBeVisible();
    await expect(report).toBeVisible();
    await expect(recruitment.locator("select[name='time']")).toBeVisible();
    await expect(report.locator("select[name='time']")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow at ${viewport.width}×${viewport.height}`).toBeLessThanOrEqual(1);
  }
  diagnostics.assertClean();
});
