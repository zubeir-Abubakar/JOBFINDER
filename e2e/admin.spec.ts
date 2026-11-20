import { test, expect, gotoReady } from "./support/fixtures";

test("admin provider page shows configuration state but never secret values", async ({ page, diagnostics }) => {
  await gotoReady(page, "/admin/ai");
  await expect(page.getByText("AI provider health")).toBeVisible();
  await expect(page.getByText("GEMINI_API_KEY")).toBeVisible();
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
