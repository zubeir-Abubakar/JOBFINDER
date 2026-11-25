import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./support/fixtures";
import { one, waitForDb } from "./support/db";

/**
 * Verified free-tier Google Gemini acceptance test.
 *
 * This file uses real Google free-tier quota and is therefore opt-in. Run it
 * against the isolated E2E server with:
 *
 *   E2E_AI_PRIMARY_PROVIDER=gemini GEMINI_REAL_E2E=1 npm run test:voice
 *
 * It uses the same authenticated owner session and isolated database as the
 * rest of the E2E suite. No local speech or alternate provider is substituted.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.skip(!process.env.GEMINI_REAL_E2E, "Set GEMINI_REAL_E2E=1 to run real free-tier Gemini acceptance tests.");

type UsageRow = {
  provider: string;
  model: string;
  status: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  agent_key: string;
  created_at: string;
};

test("Gemini text generation is recorded against the configured model", async ({ page }) => {
  const statusResponse = await page.request.get("/api/ai/status");
  expect(statusResponse.ok()).toBe(true);
  const status = (await statusResponse.json()) as {
    primary: { provider: string; model: string; detail: string };
    geminiLive: { configured: boolean; authorised: boolean; model: string; freeTierState: string };
    billing: { authority: string; actualSpend: string; costStatus: string };
  };
  expect(status.primary.provider).toBe("gemini");
  expect(status.primary.model).toBe("gemini-3.6-flash");
  expect(status.geminiLive.model).toBe("gemini-3.8-live");
  expect(status.geminiLive.authorised).toBe(true);
  expect(status.geminiLive.freeTierState).toBe("available");
  expect(status.billing.authority).toBe("zero_spend");
  expect(status.billing.actualSpend).toBe("not_reported");
  expect(status.billing.costStatus).toBe("unverified");
  expect(status.primary.detail).not.toMatch(/blocked|disabled|zero-spend/i);

  const response = await page.request.post("/api/assistant/message", {
    data: { message: "In one short sentence, explain what a QA automation engineer does." },
  });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { reply: string; agentKey: string };
  expect(payload.reply.trim().length).toBeGreaterThan(20);
  expect(payload.reply).not.toMatch(/couldn't complete|blocked by/i);

  const usage = await waitForDb(
    () =>
      one<UsageRow>(
        "SELECT provider, model, status, prompt_tokens, completion_tokens, total_tokens, agent_key, created_at FROM provider_usage WHERE provider = 'gemini' AND status = 'ok' ORDER BY id DESC LIMIT 1",
      ),
    { timeout: 30_000, message: "No successful Gemini text usage row was recorded." },
  );
  expect(usage.model).toBe("gemini-3.6-flash");
  expect(Number(usage.total_tokens)).toBeGreaterThan(0);
  expect(Number(usage.prompt_tokens)).toBeGreaterThan(0);
  expect(Number(usage.completion_tokens)).toBeGreaterThan(0);
});

test("Chief hands off to Saffa and the specialist answers from Gemini", async ({ page }) => {
  const connect = await page.request.post("/api/assistant/message", {
    data: { message: "Connect me to Saffa." },
  });
  expect(connect.ok()).toBe(true);

  const response = await page.request.post("/api/assistant/message", {
    data: { message: "Saffa, in one short sentence, what does your research role cover?" },
  });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as {
    reply: string;
    agentKey: string;
    handover?: { from: string; to: string; status: string } | null;
  };
  expect(payload.agentKey).toBe("research");
  expect(payload.reply.trim().length).toBeGreaterThan(20);
  expect(payload.reply).not.toMatch(/couldn't complete|blocked by/i);

  const usage = await waitForDb(
    () =>
      one<UsageRow>(
        "SELECT provider, model, status, prompt_tokens, completion_tokens, total_tokens, agent_key, created_at FROM provider_usage WHERE provider = 'gemini' AND status = 'ok' AND agent_key = 'research' ORDER BY id DESC LIMIT 1",
      ),
    { timeout: 30_000, message: "Saffa did not record a successful Gemini call after handoff." },
  );
  expect(usage.agent_key).toBe("research");
  expect(usage.model).toBe("gemini-3.6-flash");

  await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
});

test("Gemini vision reads a real image through the authenticated API", async ({ page }) => {
  const image = readFileSync(path.join(process.cwd(), "public/icons/icon-192.png")).toString("base64");
  const response = await page.request.post("/api/vision/analyze", {
    data: {
      image: `data:image/png;base64,${image}`,
      question: "What text or logo is visibly present in this image? Answer briefly.",
    },
  });
  expect(response.ok()).toBe(true);
  const payload = (await response.json()) as { ok: boolean; provider: string; model: string; text: string };
  expect(payload.ok).toBe(true);
  expect(payload.provider).toBe("gemini");
  expect(payload.model).toBe("gemini-3.6-flash");
  expect(payload.text.trim().length).toBeGreaterThan(20);
  expect(payload.text).toMatch(/logo|blue|stylized|image|symbol/i);
  expect(payload.text).not.toMatch(/couldn't|failed|unavailable|not configured/i);

  const status = await page.request.get("/api/vision/status");
  expect(status.ok()).toBe(true);
  const capability = (await status.json()) as { verified: boolean; blockedByPolicy: boolean; model: string };
  expect(capability.blockedByPolicy).toBe(false);
  expect(capability.model).toBe("gemini-3.6-flash");
  expect(capability.verified).toBe(true);
});
