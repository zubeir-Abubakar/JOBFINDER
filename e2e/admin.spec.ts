import fs from "node:fs";
import { test, expect, gotoReady } from "./support/fixtures";

fs.mkdirSync("artifacts/redesign", { recursive: true });

test("admin provider page shows configuration state but never secret values", async ({ page, diagnostics }) => {
  await gotoReady(page, "/admin/ai");
  await expect(page.getByText("AI provider health")).toBeVisible();
  await expect(page.getByText("GEMINI_API_KEY").first()).toBeVisible();
  await expect(page.getByText("Google OAuth")).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("e2e-fake-google-secret-must-never-render");
  expect(body).not.toContain("e2e-only-app-secret-key-not-for-production");
  expect(body).toMatch(/set|not set/);
  await expect(page.getByRole("heading", { name: "Provider usage" })).toBeVisible();
  await expect(page.getByText("Requests", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Tokens", { exact: true }).first()).toBeVisible();
  diagnostics.assertClean();
});

test("email console exposes OAuth readiness without exposing the client secret", async ({ page, diagnostics }) => {
  await gotoReady(page, "/admin/email");
  await expect(page.getByRole("heading", { name: "Email & reports" })).toBeVisible();
  await expect(page.getByText(/ready to connect|configuration missing|connected/i).first()).toBeVisible();
  const body = await page.locator("body").innerText();
  expect(body).not.toContain("e2e-fake-google-secret-must-never-render");
  expect(body).toContain("Notification log");
  diagnostics.assertClean();
});

test("changing one agent voice does not alter any other agent's voice", async ({ page, diagnostics }) => {
  await gotoReady(page, "/admin/agents");
  await expect(page.getByRole("heading", { name: "Agent voice configuration" })).toBeVisible();
  await expect(page.locator("#voices tbody tr")).toHaveCount(8);

  const saffaRow = page.locator("#voices tbody tr").filter({ hasText: "Saffa" });
  const noorRow = page.locator("#voices tbody tr").filter({ hasText: "Noor" });
  const chiefRow = page.locator("#voices tbody tr").filter({ hasText: "Chief" });

  await expect(saffaRow).toContainText("Leda");
  await expect(noorRow).toContainText("Orus");
  await expect(chiefRow).toContainText("Charon");

  await saffaRow.getByLabel("Voice for Saffa").selectOption("Kore");
  await saffaRow.getByRole("button", { name: "Save voice" }).click();
  await page.waitForURL(/\/admin\/agents\?saved=1/);

  const saffaAfter = page.locator("#voices tbody tr").filter({ hasText: "Saffa" });
  const noorAfter = page.locator("#voices tbody tr").filter({ hasText: "Noor" });
  const chiefAfter = page.locator("#voices tbody tr").filter({ hasText: "Chief" });
  await expect(saffaAfter).toContainText("Kore");
  await expect(noorAfter).toContainText("Orus");
  await expect(chiefAfter).toContainText("Charon");

  // Restore the configured default so the test leaves no voice override behind.
  await saffaAfter.getByLabel("Voice for Saffa").selectOption("");
  await saffaAfter.getByRole("button", { name: "Save voice" }).click();
  await page.waitForURL(/\/admin\/agents\?saved=1/);
  await expect(page.locator("#voices tbody tr").filter({ hasText: "Saffa" })).toContainText("Leda");

  await page.screenshot({ path: "artifacts/redesign/admin-agents-voice.png", fullPage: true });
  diagnostics.assertClean();
});

test("diagnostics and audit explorer are admin-only, filterable and paginated", async ({ page, diagnostics }) => {
  await gotoReady(page, "/admin");
  await page.screenshot({ path: "artifacts/redesign/admin-overview.png", fullPage: true });

  await gotoReady(page, "/admin/diagnostics");
  await expect(page.getByRole("heading", { name: "Diagnostics", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Application health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Background runner" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI providers & fallback" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Email delivery" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Voice service" })).toBeVisible();
  await page.screenshot({ path: "artifacts/redesign/admin-diagnostics.png", fullPage: true });

  await gotoReady(page, "/admin/audit");
  await expect(page.getByRole("heading", { name: "Audit explorer" })).toBeVisible();
  await expect(page.getByLabel("Agent", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Severity")).toBeVisible();
  await page.getByLabel("Severity").selectOption("info");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.waitForURL(/severity=info/);
  await expect(page.getByText(/matching/).first()).toBeVisible();
  await page.locator("details.audit-event summary").first().click();
  await expect(page.getByText("Event ID").first()).toBeVisible();
  await page.screenshot({ path: "artifacts/redesign/admin-audit.png", fullPage: true });

  diagnostics.assertClean();
});

test("an owner account cannot open technical admin pages by URL", async ({ page, browser }) => {
  const state = JSON.parse(fs.readFileSync(".e2e-runtime/auth/owner.json", "utf8")) as {
    cookies: Array<{ name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" }>;
    origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
  };
  const owner = await browser.newContext({ storageState: state as never });
  const ownerPage = await owner.newPage();
  await ownerPage.goto("/admin/diagnostics", { waitUntil: "domcontentloaded" });
  await ownerPage.waitForURL(/\/dashboard\?denied=admin/, { timeout: 20_000 });
  await expect(ownerPage.locator("h1").first()).toBeVisible();
  await owner.close();
  await page.goto("/login");
});
