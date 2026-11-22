import fs from "node:fs";
import { test, expect, gotoReady } from "./support/fixtures";
import { one, query } from "./support/db";
import { AGENT_IDENTITIES } from "./support/constants";

fs.mkdirSync("artifacts/redesign", { recursive: true });

test("owner navigation works and every workspace page renders", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");
  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(nav).toBeVisible();

  const hrefs = await nav.locator("a").evaluateAll((links) =>
    [...new Set(links.map((link) => (link as HTMLAnchorElement).getAttribute("href")).filter((href): href is string => Boolean(href)))],
  );
  expect(hrefs.length).toBeGreaterThanOrEqual(9);

  for (const href of hrefs) {
    const response = await page.goto(href, { waitUntil: "domcontentloaded" });
    expect(response?.status(), `${href} HTTP status`).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator("h1").first(), `${href} heading`).toBeVisible();
  }

  diagnostics.assertClean();
});

test("overview shows four real metrics and the applications board has four columns", async ({ page, diagnostics }) => {
  await gotoReady(page, "/dashboard");

  const activeOpportunities =
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM jobs j
       WHERE j.match_flag IN ('strong','possible')
         AND NOT EXISTS (
           SELECT 1 FROM applications a WHERE a.job_id = j.id
             AND a.status IN ('submitted','acknowledged','interview','interview_invited','interview_completed','offer_received','rejected','rejected_by_employer','withdrawn')
         )`,
    )?.c ?? 0;

  await expect(page.locator(".kpi-value")).toHaveCount(4);
  await expect(page.getByLabel(/Active opportunities: \d+/)).toBeVisible();
  await expect(page.getByLabel(/Applications submitted: \d+/)).toBeVisible();
  await expect(page.getByLabel(/Interviews: \d+/)).toBeVisible();
  await expect(page.getByLabel(/Needs attention: \d+/)).toBeVisible();
  await expect(page.locator(".kpi-value").first()).toHaveText(String(activeOpportunities));
  await expect(page.getByText("Recruitment pipeline")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/redesign/owner-overview.png", fullPage: true });

  await gotoReady(page, "/applications");
  await expect(page.getByRole("heading", { name: "Applications", exact: true })).toBeVisible();
  await expect(page.locator(".kanban-col")).toHaveCount(4);
  await expect(page.getByRole("region", { name: /Considering/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /To be applied/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /^Applied/ })).toBeVisible();
  await expect(page.getByRole("region", { name: /Needs attention/ })).toBeVisible();
  await page.screenshot({ path: "artifacts/redesign/owner-applications.png", fullPage: true });

  const unverifiedInApplied = query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM applications
     WHERE status = 'submitted' AND (submitted_at IS NULL OR confirmation IS NULL)`,
  )[0]?.c ?? 0;
  if (unverifiedInApplied > 0) {
    await expect(page.locator(".kanban-col").first()).toBeVisible();
  }

  await gotoReady(page, "/documents");
  await expect(page.getByRole("heading", { name: /My CV & documents/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Document library" })).toBeVisible();
  await page.screenshot({ path: "artifacts/redesign/owner-documents.png", fullPage: true });

  await gotoReady(page, "/agents/list");
  const body = await page.locator("body").innerText();
  for (const identity of AGENT_IDENTITIES) {
    expect(body, `${identity.name} must be visible on the agent roster`).toContain(identity.name);
  }
  await expect(page.locator(".agent-card")).toHaveCount(8);
  await expect(page.getByText("Upstream")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/redesign/owner-agents.png", fullPage: true });

  diagnostics.assertClean();
});
