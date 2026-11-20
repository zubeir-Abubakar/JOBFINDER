import { test as setup, expect } from "@playwright/test";
import { E2E } from "./support/constants";
import { execute, one } from "./support/db";

setup.describe.configure({ mode: "serial" });
setup.setTimeout(120_000);

setup("provision synthetic accounts and save authentication state", async ({ page, context }) => {
  await page.goto("/setup", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#owner_email")).toBeVisible();

  await page.locator("#owner_name").fill(E2E.owner.name);
  await page.locator("#owner_email").fill(E2E.owner.email);
  await page.locator("#owner_password").fill(E2E.owner.password);
  await page.locator("#admin_email").fill(E2E.admin.email);
  await page.locator("#admin_password").fill(E2E.admin.password);
  if (await page.locator("#setup_token").count()) await page.locator("#setup_token").fill(E2E.setupToken);

  await page.getByRole("button", { name: /Create accounts and open workspace/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 45_000 });
  await expect(page.getByText("Recruitment pipeline")).toBeVisible();

  // Synthetic verified profile facts. The application deliberately refuses to
  // run matching/document agents when the profile only contains demo seed data.
  if (!one<{ c: number }>("SELECT COUNT(*) AS c FROM skills WHERE deleted_at IS NULL AND source <> 'seed'" )?.c) {
    execute(
      "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'cv', 100)",
      "Playwright E2E Automation",
      "Automation & testing",
      "advanced",
      6,
    );
    execute(
      "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'cv', 101)",
      "TypeScript Test Architecture",
      "Engineering",
      "advanced",
      6,
    );
  }
  if (!one<{ c: number }>("SELECT COUNT(*) AS c FROM experiences WHERE deleted_at IS NULL")?.c) {
    execute(
      "INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, achievements, sort) VALUES (?, ?, ?, ?, NULL, 1, ?, ?, 100)",
      "Synthetic Quality Labs",
      "Senior QA Automation Engineer",
      "Zurich, Switzerland",
      "2021-01",
      "Lead Playwright and TypeScript quality engineering for a Swiss SaaS platform.",
      JSON.stringify(["Built end-to-end test automation and CI quality gates."]),
    );
  }
  execute("UPDATE profiles SET full_name = COALESCE(NULLIF(full_name, ''), ?), email = COALESCE(NULLIF(email, ''), ?) WHERE id = 1", E2E.owner.name, E2E.owner.email);
  await context.storageState({ path: E2E.ownerState });

  await context.clearCookies();
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(E2E.admin.email);
  await page.locator("#password").fill(E2E.admin.password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
  await page.waitForURL("**/admin", { timeout: 45_000 });
  await expect(page.getByText("System overview").first()).toBeVisible();
  await context.storageState({ path: E2E.adminState });
});
