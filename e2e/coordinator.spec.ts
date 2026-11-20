import { test, expect, gotoReady } from "./support/fixtures";
import { one } from "./support/db";
import { E2E } from "./support/constants";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

async function ensureChief(page: import("@playwright/test").Page) {
  // Keep this spec independent of tests that leave a specialist active.
  const response = await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
  expect(response.ok()).toBe(true);
  await gotoReady(page, "/assistant");
}

async function ask(page: import("@playwright/test").Page, message: string) {
  const composer = page.getByLabel("Message the assistant");
  await composer.fill(message);
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible({ timeout: 45_000 });
  return page.locator(".msg-bot").last();
}

test("Coordinator returns a real answer about agent ownership and persists the turn", async ({ page, diagnostics }) => {
  await ensureChief(page);
  const reply = await ask(page, "Which agent handles application submission?");
  await expect(reply).toContainText("Noor", { timeout: 30_000 });
  await expect(reply).toContainText("application submission");
  await expect(reply).toContainText("confirmation verification");

  const rows = await import("./support/db").then(({ query }) =>
    query<{ role: string; content: string }>("SELECT role, content FROM chat_messages ORDER BY id DESC LIMIT 2"),
  );
  expect(rows).toHaveLength(2);
  expect(rows.some((row) => row.role === "user" && row.content.includes("application submission"))).toBeTruthy();
  expect(rows.some((row) => row.role === "assistant" && row.content.includes("Noor"))).toBeTruthy();

  const owner = one<{ id: string }>("SELECT id FROM users WHERE email = ?", E2E.owner.email);
  expect(owner).toBeTruthy();
  diagnostics.assertClean();
});

test("Coordinator reports zero submissions from SQLite rather than inventing work", async ({ page, diagnostics }) => {
  await ensureChief(page);
  const reply = await ask(page, "How many applications have been submitted in the last 7 days?");
  await expect(reply).toContainText(/0 prepared.*0 attempted.*0 verified submissions/is);
  await expect(reply).not.toContainText(/1 (verified submission|application submitted)/i);
  const submitted = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at IS NOT NULL")?.c ?? 0;
  expect(submitted).toBe(0);
  const attempts = one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts")?.c ?? 0;
  expect(attempts).toBe(0);
  diagnostics.assertClean();
});

test("conversation history survives reload and remains ordered", async ({ page, diagnostics }) => {
  await ensureChief(page);
  const before = await page.locator(".msg").count();
  await ask(page, "What can you do?");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".msg").nth(before + 1)).toBeVisible();
  const transcripts = await import("./support/db").then(({ query }) =>
    query<{ role: string; content: string }>("SELECT role, content FROM chat_messages ORDER BY id"),
  );
  expect(transcripts.length).toBeGreaterThanOrEqual(before + 2);
  diagnostics.assertClean();
});
