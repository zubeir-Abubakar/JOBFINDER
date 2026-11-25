import { test, expect } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { seedSyntheticDocuments } from "./support/documents";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

let ids: { cvId: string; coverId: string; foreignId: string };

test.beforeAll(() => {
  ids = seedSyntheticDocuments();
});

async function sendCommand(page: Page, text: string): Promise<void> {
  await page.goto("/assistant", { waitUntil: "domcontentloaded" });
  const composer = page.getByLabel("Message the assistant");
  await composer.fill(text);
  await composer.press("Enter");
}

test("a natural-language command opens the dashboard and highlights a real element", async ({ page, diagnostics }) => {
  await sendCommand(page, "Show me the recruitment pipeline.");
  const banner = page.getByTestId("visual-companion-banner");
  await expect(banner).toBeVisible();
  await page.waitForURL("**/applications");
  await expect(banner).toContainText(/Visual companion/i);

  const card = page.getByTestId("visual-highlight");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-highlight-target", "recruitment-pipeline");
  await expect(page.locator(".vc-spotlight")).toBeVisible();

  await page.getByTestId("visual-highlight-dismiss").click();
  await expect(card).toHaveCount(0);
  await expect(page.locator(".vc-spotlight")).toHaveCount(0);

  diagnostics.assertClean();
});

test("the real synthetic CV and cover letter open through natural language", async ({ page, diagnostics }) => {
  await sendCommand(page, "Show me the latest CV.");
  await page.waitForURL(`**/documents/${ids.cvId}`);
  await expect(page.getByTestId("visual-companion-banner")).toContainText(/CV/i);
  await expect(page.locator('[data-visual-id="document-preview"]')).toBeVisible();
  const cvResponse = await page.request.get(`/api/documents/${ids.cvId}?inline=1`);
  expect(cvResponse.status()).toBe(200);
  expect(cvResponse.headers()["content-type"]).toContain("pdf");

  await sendCommand(page, "Open the latest cover letter.");
  await page.waitForURL(`**/documents/${ids.coverId}`);
  const coverResponse = await page.request.get(`/api/documents/${ids.coverId}?inline=1`);
  expect(coverResponse.status()).toBe(200);

  diagnostics.assertClean();
});

test("missing and foreign document ids are refused without substitution", async ({ page }) => {
  const missing = await page.request.post("/api/voice/live/tool", {
    data: { name: "show_document", args: { which: "specific", document_id: "doc_does_not_exist" }, agentKey: "coordinator" },
  });
  expect(missing.ok()).toBe(true);
  const missingPayload = (await missing.json()) as { response: { ok: boolean; message: string }; visual?: unknown };
  expect(missingPayload.response.ok).toBe(false);
  expect(missingPayload.visual).toBeUndefined();

  const foreign = await page.request.post("/api/voice/live/tool", {
    data: { name: "show_document", args: { which: "specific", document_id: ids.foreignId }, agentKey: "coordinator" },
  });
  const foreignPayload = (await foreign.json()) as { response: { ok: boolean }; visual?: unknown };
  expect(foreignPayload.response.ok).toBe(false);
  expect(foreignPayload.visual).toBeUndefined();

  const escape = await page.request.post("/api/voice/live/tool", {
    data: { name: "open_workspace", args: { view: "https://example.com" }, agentKey: "coordinator" },
  });
  const escapePayload = (await escape.json()) as { response: { ok: boolean }; visual?: unknown };
  expect(escapePayload.response.ok).toBe(false);
  expect(escapePayload.visual).toBeUndefined();
});

test("a declined screen-sharing permission is reported and accesses nothing", async ({ page, diagnostics }, testInfo) => {
  testInfo.annotations.push({ type: "MOCKED", description: "Chromium getDisplayMedia rejection; not a real picker test." });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async () => {
          throw new DOMException("Permission denied by the test harness", "NotAllowedError");
        },
      });
    }
  });
  await sendCommand(page, "Show me the recruitment pipeline.");
  await expect(page.getByTestId("visual-companion-banner")).toBeVisible();
  await page.getByTestId("screen-share-start").click();
  await expect(page.getByTestId("screen-share-status")).toContainText(/declined/i);
  await expect(page.getByTestId("screen-share-error")).toContainText(/permission was declined/i);
  await expect(page.getByTestId("screen-share-stop")).toHaveCount(0);
  diagnostics.assertClean();
});

test("sharing stops immediately and when Visual Companion Mode exits", async ({ page, diagnostics }, testInfo) => {
  testInfo.annotations.push({
    type: "MOCKED",
    description:
      "Synthetic canvas captureStream returned by getDisplayMedia. This exercises stop and teardown; it is not a real tab picker test.",
  });
  // Headless Chromium ends a real display capture immediately, so a synthetic
  // persistent video track is used to verify the application's stop behaviour.
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (context) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, 640, 360);
      context.fillStyle = "#111111";
      context.font = "20px sans-serif";
      context.fillText("Synthetic shared tab", 40, 80);
    }
    if (!navigator.mediaDevices) return;
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      configurable: true,
      value: async () => {
        const stream = canvas.captureStream(5);
        (window as unknown as { __atwTestShareTrack?: MediaStreamTrack }).__atwTestShareTrack = stream.getVideoTracks()[0];
        return stream;
      },
    });
  });
  await sendCommand(page, "Show me the recruitment pipeline.");
  await expect(page.getByTestId("visual-companion-banner")).toBeVisible();
  const status = page.getByTestId("screen-share-status");
  await page.getByTestId("screen-share-start").click();
  await expect(status).toContainText(/Sharing the selected tab or window/i);
  await expect(page.getByTestId("screen-share-stop")).toBeVisible();

  await page.getByTestId("screen-share-stop").click();
  await expect(status).toContainText(/stopped/i);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __atwTestShareTrack?: MediaStreamTrack }).__atwTestShareTrack?.readyState)).toBe("ended");

  await page.getByTestId("screen-share-start").click();
  await expect(status).toContainText(/Sharing/i);
  await page.getByTestId("visual-companion-exit").click();
  await expect(page.getByTestId("visual-companion-banner")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __atwTestShareTrack?: MediaStreamTrack }).__atwTestShareTrack?.readyState)).toBe("ended");
  diagnostics.assertClean();
});

test("provider status is truthful and exposes fallback state separately", async ({ page }) => {
  const response = await page.request.get("/api/ai/status");
  expect(response.ok()).toBe(true);
  const status = (await response.json()) as {
    state: string;
    label: string;
    detail: string;
    primary: { provider: string; model: string; availability: string; statusLabel: string; policyBlocked?: boolean };
    fallback: { configured: boolean; availability: string; statusLabel: string };
    lastFallback: unknown;
  };
  expect(["primary", "unknown", "fallback", "degraded", "unavailable"]).toContain(status.state);
  expect(status.primary.provider).toBe("freellmapi");
  expect(status.primary.model).toBe("e2e-model");
  expect(["available", "unknown", "not_configured"]).toContain(status.primary.availability);
  if (status.primary.availability === "not_configured") {
    // The harness does not declare FreeLLMAPI's free tier, so the policy refuses
    // it before transmission. That is a deliberate refusal, not a health result
    // or a silent fallback.
    expect(status.primary.policyBlocked).toBe(true);
    expect(status.primary.statusLabel).toBe("UNVERIFIED");
  }
  expect(status.fallback.configured).toBe(false);
  expect(status.fallback.availability).toBe("not_configured");
  expect(status.fallback.statusLabel).toBe("Not configured");
  expect(status.detail).not.toMatch(/Local fallback is ready/i);
});

test("all eight agents read structured context and explain a chart without screen sharing", async ({ page, diagnostics }) => {
  const agents = ["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"];
  for (const agentKey of agents) {
    const response = await page.request.post("/api/voice/live/tool", {
      data: { name: "get_page_context", args: { view: "dashboard" }, agentKey },
    });
    expect(response.ok(), `${agentKey} page context request`).toBe(true);
    const payload = (await response.json()) as { response: { ok: boolean; kpis?: Array<{ label: string; value: number }> } };
    expect(payload.response.ok, `${agentKey} page context`).toBe(true);
    expect(payload.response.kpis?.length ?? 0).toBeGreaterThan(0);
  }

  const charts = await page.request.post("/api/voice/live/tool", {
    data: { name: "get_chart_data", args: { range: "7" }, agentKey: "analysis" },
  });
  const chartPayload = (await charts.json()) as { response: { ok: boolean; charts?: Array<{ title: string; labels: string[]; datasets: Array<{ values: number[] }> }> } };
  expect(chartPayload.response.ok).toBe(true);
  expect(chartPayload.response.charts?.some((chart) => /Verified submissions/.test(chart.title))).toBe(true);
  const verified = chartPayload.response.charts?.find((chart) => /Verified submissions/.test(chart.title));
  expect(verified?.labels.length).toBe(verified?.datasets[0].values.length);

  const foreign = await page.request.post("/api/voice/live/tool", {
    data: { name: "read_document", args: { document_id: ids.foreignId }, agentKey: "cv" },
  });
  const foreignPayload = (await foreign.json()) as { response: { ok: boolean; text?: string } };
  expect(foreignPayload.response.ok).toBe(false);
  expect(foreignPayload.response.text).toBeUndefined();

  const explanation = await page.request.post("/api/assistant/message", {
    data: { message: "Explain this graph." },
  });
  expect(explanation.ok()).toBe(true);
  const body = (await explanation.json()) as { reply: string; agentKey: string };
  expect(body.reply).toContain("Vacancies discovered");
  expect(body.reply).toMatch(/Range/);
  expect(body.reply).not.toMatch(/can'?t see|cannot see your screen/i);

  diagnostics.assertClean();
});
