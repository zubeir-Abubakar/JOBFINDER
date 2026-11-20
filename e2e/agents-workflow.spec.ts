import { test, expect, gotoReady } from "./support/fixtures";
import { one, waitForDb } from "./support/db";
import { AGENT_IDENTITIES, E2E } from "./support/constants";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test("all eight registered agents and their operational roles are shown", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");
  const cards = page.locator(".agent-card");
  await expect(cards).toHaveCount(8);
  for (const identity of AGENT_IDENTITIES) {
    const card = cards.filter({ has: page.locator(".name", { hasText: new RegExp(`^${identity.name}$`) }) });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(identity.title);
    await expect(card).toContainText("Current task");
  }
  const dbAgents = await import("./support/db").then(({ query }) =>
    query<{ key: string }>("SELECT key FROM agents ORDER BY key"),
  );
  expect(dbAgents.map((row) => row.key).sort()).toEqual(AGENT_IDENTITIES.map((row) => row.key).sort());
  diagnostics.assertClean();
});

test("source failure is surfaced truthfully without fabricating completed work", async ({ page, request, diagnostics }) => {
  await request.post(E2E.jobControlURL, { data: { mode: "fail" } });
  try {
    await gotoReady(page, "/agents");
    await page.getByRole("button", { name: /Quick discovery only/i }).click();
    await page.waitForURL(/\/agents\?error=/, { timeout: 90_000 });

    const workflow = await waitForDb(
      () =>
        one<{ id: string; status: string; summary: string | null; finished_at: string | null }>(
          "SELECT id, status, summary, finished_at FROM workflows WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1",
        ),
      { timeout: 20_000 },
    );
    expect(workflow.status).toBe("failed");
    expect(workflow.finished_at).toBeTruthy();
    await expect(page.getByText(/Arbeitnow|source|unavailable|failed/i).first()).toBeVisible();

    const failedTasks = await import("./support/db").then(({ query }) =>
      query<{ agent_key: string; status: string; error: string | null }>(
        "SELECT agent_key, status, error FROM tasks WHERE workflow_id = ?",
        workflow.id,
      ),
    );
    const researchTasks = failedTasks.filter((task) => task.agent_key === "research");
    expect(researchTasks.some((task) => task.status === "failed" && task.error)).toBeTruthy();
    expect(researchTasks.every((task) => task.status !== "completed")).toBeTruthy();
    await expect(page.getByRole("button", { name: /Retry safely/i })).toBeVisible();
    diagnostics.assertClean();
  } finally {
    await request.post(E2E.jobControlURL, { data: { mode: "normal" } });
  }
});

test("successful discovery creates completed task records and updates agent activity", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");
  await page.getByRole("button", { name: /Quick discovery only/i }).click();
  await page.waitForURL(/\/agents\?ok=/, { timeout: 90_000 });

  const workflow = await waitForDb(
    () =>
      one<{ id: string; status: string; summary: string | null }>(
        "SELECT id, status, summary FROM workflows WHERE kind = 'discovery' ORDER BY created_at DESC LIMIT 1",
      ),
    { timeout: 20_000 },
  );
  expect(workflow.status).toBe("completed");

  const tasks = await import("./support/db").then(({ query }) =>
    query<{ agent_key: string; title: string; status: string; started_at: string | null; finished_at: string | null }>(
      "SELECT agent_key, title, status, started_at, finished_at FROM tasks WHERE workflow_id = ? ORDER BY created_at",
      workflow.id,
    ),
  );
  expect(tasks.length).toBeGreaterThanOrEqual(2);
  expect(tasks.some((task) => task.agent_key === "research")).toBeTruthy();
  expect(tasks.filter((task) => task.finished_at).length).toBeGreaterThanOrEqual(2);
  expect(tasks.every((task) => task.status === "completed")).toBeTruthy();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByText(tasks[tasks.length - 1].title).first()).toBeVisible();
  await expect(page.getByText(workflow.summary ?? "").first()).toBeVisible();
  diagnostics.assertClean();
});
