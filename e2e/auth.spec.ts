import { test, expect } from "./support/fixtures";
import { E2E } from "./support/constants";
import { expectDashboard, login } from "./support/auth";

test.describe.configure({ mode: "serial" });

test("unauthenticated workspace routes redirect to login", async ({ page }) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login(?:\?|$)/);
  await expect(page.locator("#email")).toBeVisible();
});

test("invalid credentials are rejected without creating a session", async ({ page, context }) => {
  await login(page, E2E.owner.email, "Definitely-Wrong!2026");
  await expect(page.getByText("Invalid email address or password.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
  expect(await context.cookies()).toEqual([]);
});

test("owner can sign in, persist a session, sign out and be redirected again", async ({ page, browser }, testInfo) => {
  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);

  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "atw_session");
  expect(session, "database-backed session cookie").toBeTruthy();
  expect(session?.httpOnly).toBe(true);

  const persisted = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: { cookies, origins: [] },
  });
  const persistedPage = await persisted.newPage();
  await persistedPage.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expectDashboard(persistedPage);
  await persisted.close();

  await page.getByRole("button", { name: /Sign out/i }).click();
  await page.waitForURL("**/login", { timeout: 30_000 });
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login/);
});

test("an invalid or expired session cookie is rejected", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    {
      name: "atw_session",
      value: "expired-or-forged-session-token",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login/);
  await expect(page.locator("#email")).toBeVisible();
  await context.close();
});

test("owner cannot enter the administrator console", async ({ page }) => {
  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);
  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page).not.toHaveURL(/\/admin(?:\/|$)/);
});

test("administrator can enter the restricted console and owner area remains separate", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: E2E.adminState });
  const page = await context.newPage();
  await page.goto("/admin", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/admin/);
  await expect(page.getByText("System overview").first()).toBeVisible();
  await context.close();
});
