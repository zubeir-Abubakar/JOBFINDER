import { test, expect, gotoReady } from "./support/fixtures";
import { E2E } from "./support/constants";
import { expectDashboard, login } from "./support/auth";
import { LIVE_VOICE_SESSION_KEY } from "../lib/voice-session";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

async function switchTextAgent(page: import("@playwright/test").Page, agent: string) {
  const response = await page.request.post("/api/assistant/message", {
    data: { message: `Connect me to ${agent}.` },
  });
  expect(response.ok()).toBe(true);
}

type SessionPost = { agentKey?: string; sessionId?: string; greet?: boolean };

test("the global launcher starts Chief after a specialist chat, reload and navigation", async ({ page }) => {
  await switchTextAgent(page, "Noor");
  await gotoReady(page, "/dashboard");

  // A stored specialist session must not be presented or resumed as Chief.
  await page.evaluate(
    (key) => sessionStorage.setItem(key, JSON.stringify({ sessionId: "voice_specialist123", agentKey: "application" })),
    LIVE_VOICE_SESSION_KEY,
  );

  const posts: SessionPost[] = [];
  await page.route("**/api/voice/live/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posts.push(route.request().postDataJSON() as SessionPost);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic Coordinator start failure", code: "LIVE_UNAVAILABLE" }),
    });
  });

  const trigger = page.getByRole("button", { name: "Open AT Voice Assistant" });
  await trigger.click();
  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-agent-key", "coordinator");
  await expect(panel.locator("h2")).toHaveText("Chief");
  await expect(panel.locator(".lv-meta")).toContainText("Charon");

  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(1);
  expect(posts[0].agentKey).toBe("coordinator");
  expect(posts[0].sessionId).not.toBe("voice_specialist123");
  expect(posts[0].sessionId).toMatch(/^voice_[A-Za-z0-9_-]{6,80}$/);

  // The failure is reported honestly, with a retry, and identity stays Chief.
  await expect(panel.locator(".lv-alert")).toContainText("Synthetic Coordinator start failure");
  await expect(panel.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(panel).toHaveAttribute("data-agent-key", "coordinator");
  await panel.getByRole("button", { name: "Close live voice and end session" }).click();
  await expect(panel).toHaveCount(0);

  // Refresh must not change the default.
  await page.reload({ waitUntil: "domcontentloaded" });
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Chief");
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(2);
  expect(posts[1].agentKey).toBe("coordinator");
  await panel.getByRole("button", { name: "Close live voice and end session" }).click();

  // Navigating between owner pages must not change the default.
  await page.getByRole("link", { name: "Agents", exact: true }).click();
  await page.waitForURL("**/agents");
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Chief");
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(3);
  expect(posts[2].agentKey).toBe("coordinator");
  await panel.getByRole("button", { name: "Close live voice and end session" }).click();

  // Direct specialist conversations remain exactly as before.
  await gotoReady(page, "/assistant");
  await expect(page.locator(".assistant-chat-card h2")).toHaveText("Noor");
  await expect(page.locator(".assistant-chat-card")).toContainText("direct specialist conversation");

  await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
});

test("logging out and back in still starts Chief, not the last text specialist", async ({ page }) => {
  await switchTextAgent(page, "Kora");
  await gotoReady(page, "/dashboard");

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
  await login(page, E2E.owner.email, E2E.owner.password);
  await expectDashboard(page);

  const posts: SessionPost[] = [];
  await page.route("**/api/voice/live/session", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    posts.push(route.request().postDataJSON() as SessionPost);
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic Coordinator start failure", code: "LIVE_UNAVAILABLE" }),
    });
  });

  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();
  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText("Chief");
  await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(1);
  expect(posts[0].agentKey).toBe("coordinator");

  await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });

  // This test signed out the shared setup session, then created a replacement.
  // Persist that replacement so later serial projects do not reuse a dead token.
  await page.context().storageState({ path: E2E.ownerState });
});
