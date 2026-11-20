import { test, expect, gotoReady } from "./support/fixtures";
import { one, query } from "./support/db";
import { AGENT_IDENTITIES } from "./support/constants";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

type Reply = {
  reply: string;
  agentKey: string;
  agentKeys: string[];
  handover?: { from: string; to: string; status: string } | null;
};

async function ask(page: import("@playwright/test").Page, message: string): Promise<Reply> {
  const response = await page.request.post("/api/assistant/message", { data: { message } });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as Reply;
}

test("all eight agents are reachable by ordinary language and local routing stays under 500 ms", async ({ page, diagnostics }) => {
  await gotoReady(page, "/assistant");

  const timings: Array<{ target: string; ms: number }> = [];
  async function connect(message: string, target: string): Promise<void> {
    const started = Date.now();
    const result = await ask(page, message);
    const elapsed = Date.now() - started;
    timings.push({ target, ms: elapsed });
    expect(result.agentKey).toBe(target);
    expect(result.handover?.status, `${message} should resolve without a provider call`).not.toBe("unavailable");
    expect(result.reply).not.toMatch(/couldn't complete|did not switch|provider is unavailable/i);
    expect(elapsed, `${message} local route took ${elapsed}ms`).toBeLessThan(500);
  }

  await connect("Take me back to Chief.", "coordinator");
  await connect("Connect me to Saffa.", "research");
  await connect("I want to speak to Ali.", "analysis");
  await connect("Let me ask Kora something.", "cv");
  await connect("Connect me to Kali.", "ats");
  await connect("I want to speak to Amira.", "cover");
  await connect("Connect me to Noor.", "application");
  await connect("I want to speak to Rayna.", "email");
  await connect("Take me back to Chief.", "coordinator");

  const active = one<{ agent_key: string }>(
    "SELECT agent_key FROM agent_sessions WHERE status = 'active' ORDER BY last_active_at DESC LIMIT 1",
  );
  expect(active?.agent_key).toBe("coordinator");
  const sessions = query<{ agent_key: string }>("SELECT DISTINCT agent_key FROM agent_sessions");
  expect(new Set(sessions.map((row) => row.agent_key))).toEqual(
    new Set(AGENT_IDENTITIES.map((row) => row.key)),
  );
  const messages = query<{ role: string }>(
    "SELECT role FROM chat_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 9",
  );
  expect(messages.length).toBe(9);
  test.info().annotations.push({ type: "routing-latency", description: JSON.stringify(timings) });
  diagnostics.assertClean();
});

test("ordinary profile, CV and token questions are answered from live records without invented facts", async ({ page, diagnostics }) => {
  await gotoReady(page, "/assistant");

  const profile = await ask(page, "What do you know about me from my profile?");
  expect(profile.agentKey).toBe("coordinator");
  expect(profile.reply).toMatch(/Stored profile fields/);
  const storedName = one<{ full_name: string | null }>("SELECT full_name FROM profiles WHERE id = 1")?.full_name;
  expect(storedName).toBeTruthy();
  expect(profile.reply).toContain(storedName!);
  expect(profile.reply).toMatch(/not independently verified/);
  expect(profile.reply).toMatch(/I have not inferred/);

  const cv = await ask(page, "Show me what is in my CV.");
  expect(cv.reply).toMatch(/CV document:/);
  expect(cv.reply).toMatch(/Missing information:/);
  // The isolated account has no uploaded original CV; the answer must say so
  // rather than inventing a document or employment history.
  expect(cv.reply).toMatch(/no original CV is stored|CV extract/);

  const tokens = await ask(page, "How many tokens have we used?");
  expect(tokens.reply).toMatch(/tokens across \d+ requests/);
  expect(tokens.reply).toMatch(/provider-reported/i);
  expect(tokens.reply).toMatch(/estimated/i);
  expect(tokens.reply).toMatch(/unverified/i);
  expect(tokens.reply).not.toMatch(/unlimited/i);

  diagnostics.assertClean();
});

test("switching in the text UI keeps the thread and updates the active agent", async ({ page, diagnostics }) => {
  await gotoReady(page, "/assistant");
  const before = await page.locator(".msg").count();

  const composer = page.getByLabel("Message the assistant");
  await composer.fill("Connect me to Noor.");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".assistant-chat-card")).toContainText("Application Agent / Submission", { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Open AT Voice Assistant" })).toBeVisible();
  expect(await page.locator(".msg").count()).toBeGreaterThanOrEqual(before + 2);

  await composer.fill("Take me back to Chief.");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await expect(page.getByRole("button", { name: /^Send$/ })).toBeVisible({ timeout: 45_000 });
  await expect(page.locator(".assistant-chat-card")).toContainText("Chief Coordinator / Orchestrator", { timeout: 20_000 });
  diagnostics.assertClean();
});
