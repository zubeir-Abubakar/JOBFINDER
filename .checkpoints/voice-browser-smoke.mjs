import { chromium } from "@playwright/test";

const base = "http://127.0.0.1:3213";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  permissions: ["microphone"],
});
const page = await context.newPage();
const consoleErrors = [];
const pageErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => pageErrors.push(error.message));

try {
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", "identity-owner@example.test");
  await page.fill("#password", "Identity!2026Alpha");
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.getByRole("button", { name: /Sign in/i }).click(),
  ]);
  await page.goto(`${base}/assistant`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Open AT Voice Assistant" }).click();
  await page.locator(".lv-panel").waitFor({ state: "visible", timeout: 10000 });

  let status = "";
  let mic = "";
  let alert = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    status = await page.locator(".lv-status").innerText().catch(() => "");
    mic = await page.locator(".lv-mic").innerText().catch(() => "");
    alert = await page.locator(".lv-alert").innerText().catch(() => "");
    if (/Listening|Speaking|Unavailable/i.test(status) || alert) break;
    await page.waitForTimeout(500);
  }
  const panel = await page.locator(".lv-panel").innerText();
  const controls = await page.locator(".lv-controls button").allTextContents();
  await page.screenshot({ path: "artifacts/identity-voice-smoke.png", fullPage: true });

  console.log(
    JSON.stringify(
      {
        status,
        mic,
        alert,
        hasNoor: panel.includes("Noor"),
        hasNoorTitle: panel.toLowerCase().includes("application agent / submission"),
        controls,
        consoleErrors,
        pageErrors,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        consoleErrors,
        pageErrors,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
