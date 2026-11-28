import { test, expect, gotoReady } from "./support/fixtures";

test.describe("Phase 6 owner outreach dashboard", () => {
  test("the main dashboard shows the outreach card and opens the inbox", async ({ page, diagnostics }) => {
    await gotoReady(page, "/dashboard");

    const card = page.getByTestId("dashboard-outreach-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Hiring Manager Outreach");
    for (const label of [
      "Prepared email drafts",
      "Verified employer contacts",
      "Drafts awaiting review",
      "Emails actually sent by you",
      "Employer replies received",
      "Drafts requiring intervention",
    ]) {
      await expect(card).toContainText(label);
    }
    // Drafted and sent are presented as different states.
    await expect(card).toContainText("A prepared draft is not a sent email");
    await expect(card).toContainText("Drafted, sent and replied are separate states");
    await expect(card).toContainText("no draft is counted as sent");

    const shortcut = page.getByTestId("dashboard-outreach-open");
    await expect(shortcut).toHaveText("View prepared emails");
    await shortcut.click();
    await page.waitForURL("**/outreach");

    await expect(page.getByTestId("outreach-inbox-counters")).toContainText("Prepared email drafts");
    await expect(page.getByTestId("outreach-inbox-counters")).toContainText("Emails sent by you");
    // This isolated environment stores no outreach draft, so the honest empty
    // state is shown instead of a sample row.
    await expect(page.getByTestId("outreach-inbox-empty")).toContainText("Zero is shown rather than a sample count");
    diagnostics.assertClean();
  });

  test("the outreach inbox is reachable from the navigation and survives a reload", async ({ page, diagnostics }) => {
    await gotoReady(page, "/outreach");
    await expect(page.getByRole("heading", { name: "Outreach inbox" })).toBeVisible();
    await expect(page.getByTestId("outreach-inbox-empty")).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Outreach inbox" })).toBeVisible();

    // Quality filtering is a real query-param view over the same ledger.
    await expect(page.getByTestId("outreach-quality-filter")).toContainText("Quality filter");
    await page.getByTestId("outreach-filter-failed").click();
    await page.waitForURL("**/outreach?quality=failed");
    await expect(page.getByTestId("outreach-filter-summary")).toContainText("Showing 0 of 0");

    await page.getByRole("link", { name: "Outreach inbox" }).first().click();
    await page.waitForURL("**/outreach");
    diagnostics.assertClean();
  });

  test("the recruitment outreach card links to the same inbox", async ({ page, diagnostics }) => {
    await gotoReady(page, "/recruitment");
    await page.getByTestId("recruitment-outreach-inbox").click();
    await page.waitForURL("**/outreach");
    await expect(page.getByTestId("outreach-inbox-empty")).toBeVisible();
    diagnostics.assertClean();
  });
});
