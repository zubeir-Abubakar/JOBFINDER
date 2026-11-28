import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "./support/fixtures";
import { E2E } from "./support/constants";
import { expectDashboard, login } from "./support/auth";
import { execute, one } from "./support/db";

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

test("a server-expired session is rejected and removed", async ({ browser, baseURL }) => {
  const owner = one<{ id: string }>("SELECT id FROM users WHERE lower(email) = ?", E2E.owner.email.toLowerCase());
  expect(owner?.id).toBeTruthy();
  const token = randomBytes(32).toString("base64url");
  execute(
    "INSERT OR REPLACE INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, NULL, 'e2e-expiry')",
    createHash("sha256").update(token).digest("hex"),
    owner!.id,
    new Date(Date.now() - 7_200_000).toISOString(),
    new Date(Date.now() - 3_600_000).toISOString(),
  );

  const context = await browser.newContext({ baseURL });
  await context.addCookies([
    { name: "atw_session", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" },
  ]);
  const page = await context.newPage();
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/login/);
  await context.close();

  const remaining = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM sessions WHERE token_hash = ?",
    createHash("sha256").update(token).digest("hex"),
  );
  expect(Number(remaining?.c ?? 0)).toBe(0);
});

test("cross-site state-changing API requests are refused", async ({ request }) => {
  const response = await request.post("/api/workflows/latest", {
    headers: { Origin: "https://attacker.example" },
  });
  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: "Cross-site request refused." });
});

test("document reads require a session" , async ({ request }) => {
  const response = await request.get("/api/documents/doc_e2e_unauthenticated");
  expect(response.status()).toBe(401);
});

test("another account's document is not readable", async ({ page, request }) => {
  const createdAt = new Date().toISOString();
  execute(
    `INSERT OR REPLACE INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, created_at)
     VALUES ('doc_e2e_other', 'u_e2e_other', 'original_cv', 'other.txt', 'other.txt', 'text/plain', 'other.txt', 1, 'draft', ?)`,
    createdAt,
  );
  const anonymous = await request.get("/api/documents/doc_e2e_other");
  expect(anonymous.status()).toBe(401);

  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);
  const response = await page.context().request.get("/api/documents/doc_e2e_other");
  expect(response.status()).toBe(403);
  expect(await response.text()).toBe("Forbidden");
});

test("Gmail OAuth start issues a signed state cookie without contacting Google", async ({ page }) => {
  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);

  const response = await page.context().request.get("/api/gmail/oauth/start", { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  const location = response.headers()["location"] ?? "";
  expect(location).toContain("accounts.google.com/o/oauth2/v2/auth");
  expect(new URL(location).searchParams.get("state")).toBeTruthy();
  const setCookie = response.headers()["set-cookie"] ?? "";
  expect(setCookie).toContain("atw_gmail_state=");
  expect(setCookie.toLowerCase()).toContain("httponly");
});

test("Gmail OAuth callback rejects a forged state and stays unconnected", async ({ page }) => {
  const connectedBefore = one<{ c: number }>("SELECT COUNT(*) AS c FROM gmail_accounts");
  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);

  await page.goto("/api/gmail/oauth/callback?code=synthetic-code&state=forged-state", {
    waitUntil: "domcontentloaded",
  });
  await expect(page).toHaveURL(/\/inbox\?error=/);
  await expect(page.getByText(/OAuth state validation failed/i)).toBeVisible();

  const connectedAfter = one<{ c: number }>("SELECT COUNT(*) AS c FROM gmail_accounts");
  expect(Number(connectedAfter?.c ?? 0)).toBe(Number(connectedBefore?.c ?? 0));
});

test("the Gmail OAuth callback requires a session", async ({ request }) => {
  const response = await request.get("/api/gmail/oauth/callback?code=synthetic&state=forged", {
    maxRedirects: 0,
  });
  expect(response.status()).toBe(307);
  expect(response.headers()["location"] ?? "").toContain("/login");
});
