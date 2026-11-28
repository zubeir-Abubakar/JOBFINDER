import { test, expect, gotoReady } from "./support/fixtures";

test.describe("Phase 5 surfaces", () => {
  test("every agent card opens that agent's conversation without a server error", async ({ page, diagnostics }) => {
    await gotoReady(page, "/agents/list");

    await page.getByTestId("talk-to-cv").click();
    await page.waitForURL("**/assistant?agent=cv");
    await expect(page.locator(".assistant-chat-card h2")).toHaveText("Kora");
    await expect(page.locator(".assistant-chat-card")).toContainText("CV Optimisation Agent / Documents");

    await gotoReady(page, "/assistant?agent=application");
    await expect(page.locator(".assistant-chat-card h2")).toHaveText("Noor");
    await expect(page.locator(".assistant-chat-card")).toContainText("Application Agent / Submission");

    // The conversation stays usable after switching agents.
    await expect(page.getByLabel("Message the assistant")).toBeVisible();
    diagnostics.assertClean();
  });

  test("an unknown agent is reported in the page instead of crashing it", async ({ page, diagnostics }) => {
    const response = await page.goto("/assistant?agent=not-a-real-agent", { waitUntil: "domcontentloaded" });
    expect(response?.status()).toBe(200);
    await expect(page.locator(".alert-error")).toContainText("No registered agent matches");
    await expect(page.locator(".assistant-chat-card")).toBeVisible();
    diagnostics.assertClean();
  });

  test("the recruitment dashboard exposes live outreach counters and an honest empty state", async ({ page, diagnostics }) => {
    await gotoReady(page, "/recruitment");

    const card = page.getByTestId("outreach-card");
    await expect(card).toBeVisible();
    for (const label of [
      "Prepared drafts",
      "Verified contacts",
      "Awaiting your review",
      "Emails sent by you",
      "Employer replies",
      "Needs intervention",
    ]) {
      await expect(card).toContainText(label);
    }
    await expect(page.getByTestId("outreach-empty")).toContainText("Zero is shown rather than a sample count");

    // Application state and outreach state stay separate concepts on the page.
    await expect(card).toContainText("A prepared draft is not a sent email");
    diagnostics.assertClean();
  });

  test("the capability centre lists real capabilities with evidence and working links", async ({ page, diagnostics }) => {
    await gotoReady(page, "/dashboard");
    await page.getByTestId("dashboard-capabilities").click();
    await page.waitForURL("**/capabilities");

    await expect(page.getByTestId("capability-summary")).toContainText("Catalogued capabilities");
    await expect(page.getByTestId("capability-conversations")).toContainText("Direct conversations with all eight agents");
    await expect(page.getByTestId("capability-gmail-drafts")).toContainText("Personalised Gmail drafts");
    await expect(page.getByTestId("capability-scheduler")).toContainText("Daily scheduler and durable workers");

    const link = page.getByTestId("capability-link-conversations");
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL("**/assistant");
    diagnostics.assertClean();
  });
});
