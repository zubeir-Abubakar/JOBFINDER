import { test, expect, gotoReady } from "./support/fixtures";

test.setTimeout(150_000);

const diagnosticEvents = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    (window as unknown as { __atwVoiceDiagnostics?: { events: Array<{ event: string }> } }).__atwVoiceDiagnostics?.events.map(
      (entry) => entry.event,
    ) ?? [],
  );

test("a live voice walkthrough collapses to a floating companion and survives navigation", async ({ page, diagnostics }, testInfo) => {
  await page.request.post("/api/assistant/message", { data: { message: "Take me back to Chief." } });
  await gotoReady(page, "/assistant");
  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();

  const panel = page.locator(".lv-panel");
  await expect(panel).toBeVisible();
  await expect.poll(async () => await panel.locator(".lv-status").innerText(), { timeout: 35_000 }).toMatch(/Listening|Speaking/);
  const alert = page.locator(".lv-alert");
  if (await alert.count()) {
    const detail = (await alert.innerText()).slice(0, 220);
    testInfo.annotations.push({ type: "BLOCKED", description: detail });
    test.skip(true, "The live provider was unavailable before Visual Companion Mode could be exercised.");
  }
  await expect(panel.locator(".lv-presence")).toContainText("Connected");
  const connectsBefore = (await diagnosticEvents(page)).filter((event) => event === "LIVE_SESSION_CONNECTED").length;

  await panel.getByTestId("visual-start").click();
  const float = page.getByTestId("voice-companion-float");
  await expect(float).toBeVisible();
  await expect(panel).toHaveCount(0);
  await expect(float).toContainText("Chief");
  await expect(float.locator(".lv-presence")).toContainText("Connected");
  await expect
    .poll(async () => await float.locator(".lv-mic").innerText(), { timeout: 20_000 })
    .toMatch(/Mic live|Mic muted/);
  testInfo.annotations.push({ type: "SIMULATED", description: "Browser fake microphone; real Gemini Live provider." });

  await page.getByRole("link", { name: "Documents", exact: true }).click();
  await page.waitForURL("**/documents");
  await expect(float).toBeVisible();
  await expect(float.locator(".lv-presence")).toContainText("Connected");

  // Ordinary navigation must not rebuild the live session.
  const connectsAfter = (await diagnosticEvents(page)).filter((event) => event === "LIVE_SESSION_CONNECTED").length;
  expect(connectsAfter).toBe(connectsBefore);

  await page.getByTestId("voice-companion-expand").click();
  const expanded = page.locator(".lv-panel");
  await expect(expanded).toBeVisible();
  await expect.poll(async () => await expanded.locator(".lv-status").innerText(), { timeout: 20_000 }).toMatch(/Listening|Speaking|Interrupted/);

  diagnostics.assertClean();
  await expanded.getByRole("button", { name: "End", exact: true }).click();
  await expect(expanded.locator(".lv-status")).toContainText("Disconnected");
  await expect.poll(async () => (await diagnosticEvents(page)).includes("MIC_STOPPED"), { timeout: 15_000 }).toBe(true);
});
