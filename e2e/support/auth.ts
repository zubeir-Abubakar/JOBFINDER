import { expect, type Page } from "@playwright/test";

export async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login", { waitUntil: "domcontentloaded" });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /^Sign in$/i }).click();
}

export async function expectDashboard(page: Page): Promise<void> {
  await page.waitForURL("**/dashboard", { timeout: 45_000 });
  await expect(page.getByText("Recruitment pipeline")).toBeVisible();
}
