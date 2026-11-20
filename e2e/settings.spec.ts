import { test, expect, gotoReady } from "./support/fixtures";
import { execute, one } from "./support/db";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

let originalPreferences = "{}";
let originalApproval = "true";
let originalAutonomous = "false";
let originalMinScore = "85";
let originalMaxApps = "5";
let originalFrequency = "daily";
let originalRecipient: string | null = null;

test.beforeAll(() => {
  originalPreferences = one<{ preferences: string }>("SELECT preferences FROM profiles WHERE id = 1")?.preferences ?? "{}";
  originalApproval = one<{ value: string }>("SELECT value FROM settings WHERE key = 'approval_mode'")?.value ?? "true";
  originalAutonomous = one<{ value: string }>("SELECT value FROM settings WHERE key = 'autonomous_submission'")?.value ?? "false";
  originalMinScore = one<{ value: string }>("SELECT value FROM settings WHERE key = 'min_match_score'")?.value ?? "85";
  originalMaxApps = one<{ value: string }>("SELECT value FROM settings WHERE key = 'max_applications_per_day'")?.value ?? "5";
  originalFrequency = one<{ value: string }>("SELECT value FROM settings WHERE key = 'search_frequency'")?.value ?? "daily";
  originalRecipient = one<{ email: string | null }>("SELECT email FROM profiles WHERE id = 1")?.email ?? null;
});

test.afterAll(() => {
  execute("UPDATE profiles SET preferences = ? WHERE id = 1", originalPreferences);
  execute("UPDATE profiles SET email = ? WHERE id = 1", originalRecipient);
  for (const [key, value] of [
    ["approval_mode", originalApproval],
    ["autonomous_submission", originalAutonomous],
    ["min_match_score", originalMinScore],
    ["max_applications_per_day", originalMaxApps],
    ["search_frequency", originalFrequency],
  ]) {
    execute("UPDATE settings SET value = ? WHERE key = ?", value, key);
  }
});

test("professional preferences are saved, readable after reload and stored in SQLite", async ({ page, diagnostics }) => {
  await gotoReady(page, "/settings#professional");
  const form = page.locator("#professional form");
  await form.locator("#titles").fill("Senior QA Automation Engineer, QA Lead");
  await form.locator("#locations").fill("Zurich, Lausanne");
  await form.locator("#industries").fill("SaaS, Fintech");
  await form.locator("#languages").fill("English, German");
  await form.locator("#min_salary").fill("120000");
  await form.locator("#employment_types").fill("Full-time");
  await form.locator("#remote_preference").selectOption("hybrid_or_remote");
  await form.getByRole("button", { name: /Save preferences/i }).click();
  await page.waitForURL(/\/settings\?saved=1/, { timeout: 30_000 });

  const stored = await import("./support/db").then(({ one }) =>
    one<{ preferences: string }>("SELECT preferences FROM profiles WHERE id = 1"),
  );
  const preferences = JSON.parse(stored!.preferences) as Record<string, unknown>;
  expect(preferences.titles).toEqual(["Senior QA Automation Engineer", "QA Lead"]);
  expect(preferences.locations).toEqual(["Zurich", "Lausanne"]);
  expect(preferences.min_salary).toBe(120000);
  expect(preferences.remote_preference).toBe("hybrid_or_remote");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#professional #titles")).toHaveValue("Senior QA Automation Engineer, QA Lead");
  await expect(page.locator("#professional #locations")).toHaveValue("Zurich, Lausanne");
  diagnostics.assertClean();
});

test("automation save enforces the 85 percent floor and five-application limit remains configurable", async ({ page, diagnostics }) => {
  await gotoReady(page, "/settings#automation");
  const form = page.locator("#automation form");
  await form.locator("#min_match_score").fill("40");
  await form.locator("#max_applications_per_day").fill("5");
  await form.locator("#search_frequency").selectOption("manual");
  // The UI correctly advertises min=85. Remove only the browser-native gate so
  // this test can prove the server independently enforces the same floor.
  await form.evaluate((element) => element.setAttribute("novalidate", ""));
  await form.getByRole("button", { name: /Save automation/i }).click();
  await page.waitForURL(/\/settings\?saved=1/, { timeout: 30_000 });

  const minScore = one<{ value: string }>("SELECT value FROM settings WHERE key = 'min_match_score'")?.value;
  const maxApps = one<{ value: string }>("SELECT value FROM settings WHERE key = 'max_applications_per_day'")?.value;
  const frequency = one<{ value: string }>("SELECT value FROM settings WHERE key = 'search_frequency'")?.value;
  expect(Number(minScore)).toBe(85);
  expect(Number(maxApps)).toBe(5);
  expect(frequency?.replace(/^"|"$/g, "")).toBe("manual");
  await expect(page.locator("#automation #min_match_score")).toHaveValue("85");
  diagnostics.assertClean();
});

test("test email reports missing provider evidence and never claims delivery", async ({ page, diagnostics }) => {
  await gotoReady(page, "/settings#notifications");
  await page.locator("#notifications #email").fill("e2e-notifications@example.test");
  await page.locator("#notifications").getByRole("button", { name: /Save notifications/i }).click();
  await page.waitForURL(/\/settings\?saved=1/, { timeout: 30_000 });

  const before = one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications")?.c ?? 0;
  await page.getByRole("button", { name: /Send test email/i }).click();
  await page.waitForURL(/\/settings\?email_test=/, { timeout: 45_000 });
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("Gmail accepted the test message.");
  expect(body).toMatch(/not configured|authentication failed|API error|not connected|permission/i);
  const after = one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications")?.c ?? 0;
  expect(after).toBe(before);
  const result = one<{ value: string }>("SELECT value FROM settings WHERE key = 'email_test_last'")?.value;
  expect(result ?? "").not.toContain('"accepted"');
  diagnostics.assertClean();
});
