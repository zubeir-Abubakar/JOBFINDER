import { test, expect, gotoReady } from "./support/fixtures";

test.setTimeout(150_000);

async function resetToChief(page: import("@playwright/test").Page) {
  const response = await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
  expect(response.ok()).toBe(true);
}

test("a transient network loss reconnects the live session and resumes microphone frames", async ({ page, context, diagnostics }, testInfo) => {
  testInfo.annotations.push({ type: "SIMULATED", description: "Browser-level offline emulation; real Gemini Live provider." });
  const sockets: Array<{ frames: string[] }> = [];
  page.on("websocket", (socket) => {
    const record = { frames: [] as string[] };
    sockets.push(record);
    socket.on("framesent", (event) => record.frames.push(String(event.payload)));
  });

  await resetToChief(page);
  await gotoReady(page, "/assistant");
  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();
  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();
  await expect.poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 35_000 }).toMatch(/Listening|Speaking/);
  await expect(panel.locator(".lv-presence")).toContainText("Connected");
  await expect.poll(() => sockets.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);

  const diagnosticEvents = async () =>
    page.evaluate(() => (window as unknown as { __atwVoiceDiagnostics?: { events: Array<{ event: string }> } }).__atwVoiceDiagnostics?.events.map((entry) => entry.event) ?? []);
  const connectedBefore = (await diagnosticEvents()).filter((event) => event === "LIVE_SESSION_CONNECTED").length;

  await context.setOffline(true);
  await expect.poll(async () => (await diagnosticEvents()).includes("LIVE_SESSION_CLOSED"), { timeout: 20_000 }).toBe(true);
  await page.waitForTimeout(2_000);
  await context.setOffline(false);

  await expect
    .poll(async () => (await diagnosticEvents()).filter((event) => event === "LIVE_SESSION_CONNECTED").length, { timeout: 55_000 })
    .toBeGreaterThan(connectedBefore);
  await expect.poll(() => sockets.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 35_000 }).toMatch(/Listening|Speaking/);
  await expect(panel.locator(".lv-presence")).toContainText("Connected");

  const latest = sockets.at(-1)!;
  await expect
    .poll(() => latest.frames.filter((frame) => frame.includes('"realtimeInput"') && frame.includes('"audio"')).length, { timeout: 25_000 })
    .toBeGreaterThan(0);

  // Network failures are the scenario under test. Page and console errors,
  // however, must still be clean.
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.consoleErrors.filter((message) => !/net::ERR_INTERNET_DISCONNECTED/i.test(message))).toEqual([]);
  await panel.getByRole("button", { name: "End", exact: true }).click();
  await expect(panel.locator(".lv-status")).toContainText("Disconnected");
});

test("mocked microphone denial shows an actionable error and never claims a live mic", async ({ page, diagnostics }, testInfo) => {
  testInfo.annotations.push({ type: "MOCKED", description: "Chromium getUserMedia rejection; not a physical device test." });
  await page.addInitScript(() => {
    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          throw new DOMException("Permission denied by the test harness", "NotAllowedError");
        },
      });
    }
  });

  await resetToChief(page);
  await gotoReady(page, "/assistant");
  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();
  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();
  await expect.poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 35_000 }).toMatch(/Unavailable/i);
  const alert = await panel.locator(".lv-alert").innerText();
  if (/not configured|quota|billing|timed out|free-tier/i.test(alert)) {
    testInfo.annotations.push({ type: "BLOCKED", description: alert.slice(0, 220) });
    test.skip(true, "The live provider was unavailable before microphone permission was evaluated.");
  }
  await expect(panel.locator(".lv-alert")).toContainText(/Permission denied|microphone|not allowed/i);
  await expect(panel.locator(".lv-mic")).toContainText(/Mic idle/i);
  const events = await page.evaluate(() =>
    (window as unknown as { __atwVoiceDiagnostics?: { events: Array<{ event: string; detail?: { errorName?: string } }> } }).__atwVoiceDiagnostics?.events ?? [],
  );
  expect(events.some((entry) => entry.event === "MIC_ERROR" && entry.detail?.errorName === "NotAllowedError")).toBe(true);
  expect(events.some((entry) => entry.event === "MIC_STREAM_ACTIVE")).toBe(false);
  diagnostics.assertClean();
});
