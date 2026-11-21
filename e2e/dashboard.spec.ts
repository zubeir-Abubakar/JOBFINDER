import { test, expect, gotoReady } from "./support/fixtures";
import { one } from "./support/db";
import { AGENT_IDENTITIES } from "./support/constants";

test("dashboard navigation works and every workspace page renders", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav).toBeVisible();

  const hrefs = await nav.locator("a").evaluateAll((links) =>
    [...new Set(links.map((link) => (link as HTMLAnchorElement).getAttribute("href")).filter((href): href is string => Boolean(href)))],
  );
  expect(hrefs.length).toBeGreaterThanOrEqual(8);

  for (const href of hrefs) {
    const response = await page.goto(href, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${href} HTTP status`).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("h1").first(), `${href} heading`).toBeVisible();
  }

  diagnostics.assertClean();
});

test("dashboard figures match the isolated database and identities are present", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");

  const jobCount = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0;
  const applicationCount = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0;

  await expect(page.getByLabel(/Jobs discovered: \d+/)).toBeVisible();
  await expect(page.locator(".kpi-value")).toHaveCount(4);
  await expect(page.locator(".kpi-value").first()).toHaveText(String(jobCount));
  await expect(page.getByText("Recruitment pipeline")).toBeVisible();
  await expect(page.getByText("Needs attention", { exact: false }).first()).toBeVisible();

  const body = await page.locator("body").innerText();
  for (const identity of AGENT_IDENTITIES) {
    expect(body, `${identity.name} must be visible in the workspace`).toContain(identity.name);
  }

  const dbApplicationCount = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0;
  expect(applicationCount).toBe(dbApplicationCount);
  diagnostics.assertClean();
});
