import fs from "node:fs";
import { test, expect, gotoReady } from "./support/fixtures";

fs.mkdirSync("artifacts/redesign", { recursive: true });

test("command dashboard shows real agents, provider health and token analytics", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");

  await expect(page.getByRole("heading", { name: "Your Agents", exact: true })).toBeVisible();
  await expect(page.locator(".cmd-agent-card")).toHaveCount(8);
  await expect(page.locator(".cmd-agent-card.is-chief")).toHaveCount(1);
  await expect(page.locator(".cmd-agent-card.is-chief")).toContainText("Chief");
  await expect(page.locator(".cmd-agent-card.is-chief")).toContainText("Central authority");
  await expect(page.getByRole("heading", { name: "System Health & APIs" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Token analytics" })).toBeVisible();
  await expect(page.getByText("CHF 0.00 external spend.")).toBeVisible();

  // Inference attribution is a separate ledger from task execution, with an
  // explicit reporting period and a visible unresolved bucket.
  await expect(page.getByText("Task-linked inference", { exact: true })).toBeVisible();
  await expect(page.getByText("Background & conversational", { exact: true })).toBeVisible();
  await expect(page.getByText("Attribution unresolved", { exact: true })).toBeVisible();
  await expect(page.getByText(/Reporting period:/)).toBeVisible();
  const firstCard = page.locator(".cmd-agent-card").first();
  await expect(firstCard).toContainText("Task execs");
  await expect(firstCard).toContainText("AI calls");
  await expect(firstCard).toContainText("Task-linked");
  await expect(firstCard).toContainText("Background");

  const tokenPanel = page.getByRole("heading", { name: "Token analytics" });
  const notifications = page.getByRole("heading", { name: "Unread notifications" });
  if (await notifications.count()) {
    const tokenBox = await tokenPanel.boundingBox();
    const notificationBox = await notifications.boundingBox();
    expect(tokenBox && notificationBox && tokenBox.y < notificationBox.y).toBeTruthy();
  }

  // The client refreshes from the authenticated snapshot route; trigger the
  // visibility path instead of waiting for the full polling interval.
  const liveResponse = page.waitForResponse((response) => response.url().includes("/api/dashboard/live"));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await liveResponse).status()).toBe(200);

  await page.screenshot({ path: "artifacts/redesign/command-dashboard.png", fullPage: true });

  const details = page.locator(".cmd-agent-card").first().getByRole("button", { name: /Details/ });
  await details.click();
  await expect(page.locator(".cmd-agent-details")).toBeVisible();
  await expect(page.locator(".cmd-agent-details")).toContainText(/No task history|Recent task records/);
  await expect(page.locator(".cmd-agent-details")).toContainText("Hands off to");
  diagnostics.assertClean();
});

test("sidebar collapses to icons, persists the preference and expands again", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");
  const shell = page.locator(".shell");
  const sidebar = page.locator("#app-navigation");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });

  const expanded = await sidebar.boundingBox();
  expect(expanded?.width ?? 0).toBeGreaterThan(200);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(shell).toHaveClass(/sidebar-collapsed/);
  // The width animates for 200ms; poll the settled layout instead of sampling
  // the first frame of the transition.
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 999, { timeout: 5_000 })
    .toBeLessThan(100);
  await expect(nav.getByText("Overview")).toBeHidden();
  await expect(nav.locator('a[href="/dashboard"]')).toHaveAttribute("title", "Overview");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".shell")).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("#app-navigation")).toHaveCSS("width", /(7[0-9]|8[0-9])px/);

  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.locator(".shell")).not.toHaveClass(/sidebar-collapsed/);
  await expect(nav.getByText("Overview")).toBeVisible();

  await page.locator('a[href="/jobs"]').first().click();
  await expect(page).toHaveURL(/\/jobs/);
  diagnostics.assertClean();
});
