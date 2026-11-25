import { test, expect, gotoReady } from "./support/fixtures";
import { execute, query } from "./support/db";
import { AGENT_IDENTITIES } from "./support/constants";

test.describe.configure({ mode: "serial" });

const WORKFLOW = "wf_e2e_topology";
const RUN = "run_e2e_topology";
const RUN_KEY = "e2e-topology-run";
const START = Date.now();
const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

type PriorAgent = { key: string; status: string; current_task: string | null };
let priorAgents: PriorAgent[] = [];

function insertEvent(type: string, agentKey: string | null, message: string, createdAt: string) {
  execute(
    "INSERT INTO workflow_events (workflow_id, agent_key, type, message, meta, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
    WORKFLOW,
    agentKey,
    type,
    message,
    createdAt,
  );
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test.beforeAll(() => {
  priorAgents = query<PriorAgent>("SELECT key, status, current_task FROM agents ORDER BY sort");
  const owner = query<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1")[0];
  if (!owner) throw new Error("E2E topology fixture requires the provisioned owner account.");

  execute("DELETE FROM workflow_events WHERE workflow_id = ?", WORKFLOW);
  execute("DELETE FROM tasks WHERE workflow_id = ?", WORKFLOW);
  execute("DELETE FROM recruitment_run_agents WHERE run_id = ?", RUN);
  execute("DELETE FROM recruitment_runs WHERE id = ?", RUN);
  execute("DELETE FROM workflows WHERE id = ?", WORKFLOW);

  execute(
    "INSERT INTO workflows (id, kind, label, status, summary, started_by, created_at) VALUES (?, 'autonomous_recruitment', 'E2E persisted topology run', 'running', 'Synthetic E2E fixture for the live topology.', ?, ?)",
    WORKFLOW,
    owner.id,
    at(0),
  );
  execute(
    `INSERT INTO recruitment_runs
       (id, run_key, workflow_id, scheduled_for, trigger, status, started_at, jobs_discovered, jobs_updated, discovery_scope, created_at)
     VALUES (?, ?, ?, ?, 'schedule', 'searching', ?, 14, 3, 'full', ?)`,
    RUN,
    RUN_KEY,
    WORKFLOW,
    at(-60_000),
    at(-60_000),
    at(0),
  );

  // Timestamps are relative to this test process. A fixed morning timestamp
  // becomes a genuinely stale task when the suite runs later in the day, which
  // would correctly trigger lease-aware recovery and end the fixture workflow.
  const tasks = [
    ["task_e2e_topology_coord", "coordinator", "Create the persisted E2E run", "completed", "Assigned discovery and matching.", at(-60_000), at(-58_000)],
    ["task_e2e_topology_research", "research", "Monitor configured recruitment sources", "running", "Reading every enabled source and reconciling new vacancies.", at(-57_000), null],
    ["task_e2e_topology_analysis", "analysis", "Score the new vacancies", "queued", "Waiting for Saffa's discovery result.", at(-56_500), null],
    ["task_e2e_topology_cv", "cv", "Tailor CV for the strongest vacancy", "completed", "CV generated from verified profile facts.", at(-120_000), at(-56_000)],
    ["task_e2e_topology_ats", "ats", "Audit generated documents", "failed", "Quality audit could not verify the employer field.", at(-180_000), at(-55_000)],
  ] as const;
  for (const [id, agentKey, title, status, detail, startedAt, finishedAt] of tasks) {
    execute(
      `INSERT INTO tasks (id, workflow_id, agent_key, title, status, detail, output, error, requires_input, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      id,
      WORKFLOW,
      agentKey,
      title,
      status,
      detail,
      status === "completed" ? `${title} completed from persisted evidence.` : null,
      status === "failed" ? "Quality audit could not verify the employer field." : null,
      startedAt,
      startedAt,
      finishedAt,
    );
  }

  const assignments = [
    ["coordinator", "Create and supervise the run", "completed"],
    ["research", "Discover vacancies across configured sources", "running"],
    ["analysis", "Score and rank discovered vacancies", "queued"],
    ["cv", "Prepare tailored CV", "completed"],
    ["ats", "Audit documents", "failed"],
    ["cover", "Prepare cover letter", "skipped"],
    ["application", "Prepare submission package", "queued"],
  ] as const;
  for (const [agentKey, assignment, status] of assignments) {
    execute(
      `INSERT INTO recruitment_run_agents (run_id, agent_key, assignment, status, output, error, started_at, finished_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      RUN,
      agentKey,
      assignment,
      status,
      status === "completed" ? "Recorded from the persisted assignment." : null,
      status === "failed" ? "Document audit failed." : null,
      at(-60_000),
      status === "completed" || status === "failed" ? at(-30_000) : null,
      at(-60_000),
    );
  }

  execute("UPDATE agents SET status = 'working', current_task = 'Create the persisted E2E run' WHERE key = 'coordinator'");
  execute("UPDATE agents SET status = 'working', current_task = 'Monitor configured recruitment sources' WHERE key = 'research'");
  execute("UPDATE agents SET status = 'idle', current_task = NULL WHERE key = 'analysis'");
  execute("UPDATE agents SET status = 'completed', current_task = NULL WHERE key = 'cv'");
  execute("UPDATE agents SET status = 'failed', current_task = NULL WHERE key = 'ats'");
  for (const key of ["cover", "application", "email"]) {
    execute("UPDATE agents SET status = 'idle', current_task = NULL WHERE key = ?", key);
  }

  insertEvent("workflow.started", "coordinator", "Chief started the E2E topology run.", at(-50_000));
  insertEvent("agent.started", "research", "Saffa started: Monitor configured recruitment sources", at(-40_000));
  insertEvent("agent.queued", "analysis", "Ali queued: Score the new vacancies", at(-30_000));
  insertEvent("agent.completed", "cv", "Kora completed its step: CV generated from verified profile facts.", at(-20_000));
  insertEvent("agent.failed", "ats", "Kali failed: Quality audit could not verify the employer field.", at(-10_000));
});

test.afterAll(() => {
  execute("DELETE FROM workflow_events WHERE workflow_id = ?", WORKFLOW);
  execute("DELETE FROM tasks WHERE workflow_id = ?", WORKFLOW);
  execute("DELETE FROM recruitment_run_agents WHERE run_id = ?", RUN);
  execute("DELETE FROM recruitment_runs WHERE id = ?", RUN);
  execute("DELETE FROM workflows WHERE id = ?", WORKFLOW);
  for (const agent of priorAgents) {
    execute("UPDATE agents SET status = ?, current_task = ? WHERE key = ?", agent.status, agent.current_task, agent.key);
  }
});

test("canonical /agents opens topology, the legacy URL redirects and List view opens the roster", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "Live agent topology" })).toBeVisible();
  await expect(page.getByTestId("agent-topology")).toBeVisible();

  const views = page.getByRole("navigation", { name: "Agents views" });
  await expect(views.getByRole("link", { name: "Live topology" })).toHaveAttribute("href", "/agents");
  await expect(views.getByRole("link", { name: "Live topology" })).toHaveAttribute("aria-current", "page");
  await expect(views.getByRole("link", { name: "List view" })).toHaveAttribute("href", "/agents/list");

  await gotoReady(page, "/agents/topology");
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByTestId("agent-topology")).toBeVisible();

  await views.getByRole("link", { name: "List view" }).click();
  await expect(page).toHaveURL(/\/agents\/list$/);
  await expect(page.getByRole("heading", { name: "AI agents" })).toBeVisible();
  await expect(page.locator(".agent-card")).toHaveCount(8);
  await expect(views.getByRole("link", { name: "List view" })).toHaveAttribute("aria-current", "page");
  await expect(views.getByRole("link", { name: "Live topology" })).toHaveAttribute("href", "/agents");
  diagnostics.assertClean();
});

test("renders exactly the eight real agents, real portraits, real states and one genuine animated assignment", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");

  const topology = page.getByTestId("agent-topology");
  await expect(topology).toBeVisible();
  await expect(page.getByRole("heading", { name: "Live agent topology" })).toBeVisible();
  await expect(topology).toHaveAttribute("data-stream-state", "live");

  await expect(page.locator('[data-testid^="topology-agent-"]')).toHaveCount(8);
  for (const identity of AGENT_IDENTITIES) {
    const node = page.getByTestId(`topology-agent-${identity.key}`);
    await expect(node, `${identity.name} must be present`).toBeVisible();
    await expect(node).toContainText(identity.name);
  }

  await expect(page.locator(".topology-portrait img")).toHaveCount(8);
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll<HTMLImageElement>(".topology-portrait img")).every(
      (image) => image.complete && image.naturalWidth > 0,
    ),
  );
  const portraitSources = await page.locator(".topology-portrait img").evaluateAll((images) =>
    images.map((image) => (image as HTMLImageElement).getAttribute("src") ?? ""),
  );
  expect(new Set(portraitSources).size).toBe(8);
  expect(portraitSources.every((source) => source.startsWith("/assets/agents/"))).toBe(true);

  const chief = page.getByTestId("topology-agent-coordinator");
  await expect(chief).toHaveAttribute("data-state", "working");
  await expect(chief).toContainText("Chief");
  await expect(chief).toContainText("Orchestrating");
  await expect(chief).toContainText(RUN_KEY);
  await expect(chief.locator(".topology-chief-voice")).not.toBeEmpty();

  const research = page.getByTestId("topology-agent-research");
  await expect(research).toHaveAttribute("data-state", "working");
  await expect(research.locator(".topology-pulse")).toBeVisible();
  const researchRingAnimation = await research
    .locator(".topology-portrait-ring")
    .evaluate((element) => getComputedStyle(element).animationName);
  expect(researchRingAnimation).toContain("topology-ring");

  const waiting = page.getByTestId("topology-agent-analysis");
  await expect(waiting).toHaveAttribute("data-state", "waiting");
  await expect(waiting.locator(".topology-pulse")).toHaveCount(0);
  await expect(waiting.locator(".topology-portrait-ring")).toHaveCSS("animation-name", "none");

  const completed = page.getByTestId("topology-agent-cv");
  await expect(completed).toHaveAttribute("data-state", "completed");
  await expect(completed.locator(".topology-pulse")).toHaveCount(0);
  await expect(completed.locator(".topology-portrait-ring")).toHaveCSS("animation-name", "none");

  const failed = page.getByTestId("topology-agent-ats");
  await expect(failed).toHaveAttribute("data-state", "failed");
  await expect(failed).toContainText(/could not verify the employer field/i);
  await expect(failed.locator(".topology-pulse")).toHaveCount(0);
  await expect(failed.locator(".topology-portrait-ring")).toHaveCSS("animation-name", "none");

  await expect(page.locator(".topology-edge")).toHaveCount(7);
  const activeEdges = page.locator('.topology-edge[data-active="true"]');
  await expect(activeEdges).toHaveCount(1);
  await expect(activeEdges).toHaveAttribute("data-agent-key", "research");
  await expect(activeEdges).toHaveCSS("animation-name", "topology-flow");
  await expect(page.locator('.topology-edge[data-active="false"]')).toHaveCount(6);
  const inactiveAnimations = await page
    .locator('.topology-edge[data-active="false"]')
    .evaluateAll((edges) => edges.map((edge) => getComputedStyle(edge).animationName));
  expect(inactiveAnimations.every((name) => name === "none")).toBe(true);

  const runPanel = page.getByTestId("topology-run-panel");
  await expect(runPanel).toContainText("Full discovery");
  await expect(runPanel).toContainText(RUN_KEY);
  await expect(runPanel).toContainText(/searching/i);
  await expect(runPanel).toContainText("14");
  await expect(runPanel).toContainText("3");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "Assigned" }).locator("strong")).toHaveText("5");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "Completed" }).locator("strong")).toHaveText("2");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "In progress" }).locator("strong")).toHaveText("1");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "Waiting" }).locator("strong")).toHaveText("1");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "Recovering" }).locator("strong")).toHaveText("0");
  await expect(runPanel.locator(".topology-run-counts > div").filter({ hasText: "Failed" }).locator("strong")).toHaveText("1");
  expect(await runPanel.innerText()).not.toMatch(/%/);

  await expect(page.locator('.topology-edge[data-agent-key="research"]')).toHaveAttribute("data-connection-phase", "assignment");
  await expect(page.locator('.topology-edge[data-agent-key="research"]')).toHaveAttribute(
    "marker-end",
    "url(#topology-arrow-live)",
  );
  await expect(page.locator('.topology-edge[data-agent-key="cv"]')).toHaveAttribute("data-connection-phase", "result");
  await expect(page.locator('.topology-edge[data-agent-key="cv"]')).toHaveAttribute("data-direction", "agent-to-chief");
  await expect(page.locator('.topology-edge[data-agent-key="analysis"]')).toHaveAttribute("data-connection-phase", "waiting");
  await expect(page.locator('.topology-edge[data-agent-key="ats"]')).toHaveAttribute("data-connection-phase", "failed");
  await expect(page.locator('.topology-edge[data-agent-key="cover"]')).toHaveAttribute("data-connection-phase", "none");

  await expect(page.locator(".topology-event")).toHaveCount(5);
  const timeline = page.getByRole("region", { name: "Live activity timeline" });
  await expect(timeline.getByText("Chief started the E2E topology run.", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Saffa started: Monitor configured recruitment sources", { exact: true })).toBeVisible();
  await expect(timeline.getByText("Kali failed: Quality audit could not verify the employer field.", { exact: true })).toBeVisible();
  const eventIds = await page.locator(".topology-event").evaluateAll((events) =>
    events.map((event) => event.getAttribute("data-event-id")),
  );
  expect(new Set(eventIds).size).toBe(eventIds.length);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("agent-topology")).toBeVisible();
  await expect(page.getByTestId("topology-agent-research")).toHaveAttribute("data-state", "working");
  await expect(page.locator(".topology-event")).toHaveCount(5);
  diagnostics.assertClean();
});

test("filters by real states and opens the persisted agent detail drawer", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");

  await page.locator('[data-filter="working"]').click();
  await expect(page.getByTestId("topology-agent-research")).toBeVisible();
  await expect(page.locator('[data-testid^="topology-agent-"]')).toHaveCount(2);
  await expect(page.locator('.topology-edge[data-active="true"]')).toHaveCount(1);

  await page.locator('[data-filter="waiting"]').click();
  await expect(page.getByTestId("topology-agent-analysis")).toBeVisible();
  await expect(page.getByTestId("topology-agent-research")).toHaveCount(0);

  await page.locator('[data-filter="completed"]').click();
  await expect(page.getByTestId("topology-agent-cv")).toBeVisible();

  await page.locator('[data-filter="recovering"]').click();
  await expect(page.locator('.topology-specialists [data-testid^="topology-agent-"]')).toHaveCount(0);
  await expect(page.getByTestId("topology-agent-coordinator")).toBeVisible();

  await page.locator('[data-filter="failed"]').click();
  await expect(page.getByTestId("topology-agent-ats")).toBeVisible();

  await page.locator('[data-filter="all"]').click();
  await expect(page.locator('[data-testid^="topology-agent-"]')).toHaveCount(8);

  await page.getByTestId("topology-agent-research").click();
  const drawer = page.getByTestId("topology-agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Saffa" })).toBeVisible();
  await expect(drawer).toContainText("Monitor configured recruitment sources");
  await expect(drawer).toContainText("Saffa started: Monitor configured recruitment sources");
  await expect(drawer.getByRole("link", { name: "Full task history" })).toHaveAttribute(
    "href",
    "/agents/list?agent=research#activity",
  );
  await expect(drawer.getByRole("button", { name: "Open conversation" })).toBeVisible();

  await page.getByRole("button", { name: "Close agent details" }).click();
  await expect(drawer).toHaveCount(0);

  await page.getByTestId("topology-agent-research").click();
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  diagnostics.assertClean();
});

test("a newly persisted event appears without a page reload and refresh keeps event ids unique", async ({ page, diagnostics }) => {
  await gotoReady(page, "/agents");
  await expect(page.locator(".topology-event")).toHaveCount(5);

  insertEvent("agent.progress", "research", "Saffa persisted a new configured-source result.", at(1_000));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

  await expect(page.getByText("Saffa persisted a new configured-source result.", { exact: true })).toBeVisible();
  await expect(page.locator(".topology-event")).toHaveCount(6);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".topology-event")).toHaveCount(6);
  await expect(page.getByText("Saffa persisted a new configured-source result.", { exact: true })).toHaveCount(1);
  const eventIds = await page.locator(".topology-event").evaluateAll((events) =>
    events.map((event) => event.getAttribute("data-event-id")),
  );
  expect(new Set(eventIds).size).toBe(eventIds.length);
  diagnostics.assertClean();
});

test("missing portraits fall back to initials for all eight agents", async ({ page, diagnostics }) => {
  await page.route("**/assets/agents/**", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "missing portrait" }),
  );
  await gotoReady(page, "/agents");
  await expect(page.getByTestId("agent-topology")).toBeVisible();

  await expect(page.locator(".topology-portrait-fallback")).toHaveCount(8);
  await expect(page.getByRole("img", { name: /portrait unavailable; initials/ })).toHaveCount(8);
  await expect(page.getByRole("img", { name: "Chief portrait unavailable; initials C" })).toBeVisible();
  await expect(page.locator(".topology-portrait img")).toHaveCount(0);
  expect(diagnostics.pageErrors).toEqual([]);
});

test("desktop topology stays inside its stage while tablet and mobile use a readable, overflow-free layout", async ({ page, diagnostics }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await gotoReady(page, "/agents");
  await expect(page.getByTestId("agent-topology")).toBeVisible();

  const desktopGeometry = await page.evaluate(() => {
    const stage = document.querySelector(".topology-stage")?.getBoundingClientRect();
    const nodes = Array.from(document.querySelectorAll(".topology-node")).map((node) =>
      node.getBoundingClientRect(),
    );
    return {
      stage: stage ? { left: stage.left, right: stage.right, top: stage.top, bottom: stage.bottom } : null,
      nodes: nodes.map((node) => ({ left: node.left, right: node.right, top: node.top, bottom: node.bottom })),
    };
  });
  expect(desktopGeometry.stage).not.toBeNull();
  expect(desktopGeometry.nodes).toHaveLength(7);
  for (const node of desktopGeometry.nodes) {
    expect(node.left).toBeGreaterThanOrEqual(desktopGeometry.stage!.left - 1);
    expect(node.right).toBeLessThanOrEqual(desktopGeometry.stage!.right + 1);
    expect(node.top).toBeGreaterThanOrEqual(desktopGeometry.stage!.top - 1);
    expect(node.bottom).toBeLessThanOrEqual(desktopGeometry.stage!.bottom + 1);
  }
  await expect(page.getByTestId("topology-run-panel")).toBeVisible();

  for (const viewport of [
    { width: 768, height: 1024, label: "tablet" },
    { width: 390, height: 844, label: "mobile" },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await expect(page.getByTestId("topology-agent-coordinator")).toBeVisible();
    await expect(page.locator('[data-testid^="topology-agent-"]')).toHaveCount(8);
    await expect(page.getByTestId("topology-run-panel")).toBeVisible();
    await expect(page.getByRole("region", { name: "Live activity timeline" })).toBeVisible();

    const geometry = await page.evaluate(() => {
      const chief = document.querySelector(".topology-chief");
      const node = document.querySelector(".topology-node");
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        chiefPosition: chief ? getComputedStyle(chief).position : null,
        nodePosition: node ? getComputedStyle(node).position : null,
        nodeRight: node?.getBoundingClientRect().right ?? null,
        width: window.innerWidth,
      };
    });
    expect(geometry.overflow, `${viewport.label} must not overflow horizontally`).toBeLessThanOrEqual(1);
    expect(geometry.chiefPosition, `${viewport.label} chief must be in normal flow`).toBe("relative");
    expect(geometry.nodePosition, `${viewport.label} agents must be in normal flow`).toBe("relative");
    expect(geometry.nodeRight ?? geometry.width + 1, `${viewport.label} agent card must fit`).toBeLessThanOrEqual(
      geometry.width + 1,
    );
  }
  diagnostics.assertClean();
});

test("reduced-motion preference removes working and connection animation", async ({ page, diagnostics }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await gotoReady(page, "/agents");
  await expect(page.getByTestId("topology-agent-research")).toHaveAttribute("data-state", "working");

  await expect(page.getByTestId("topology-agent-research").locator(".topology-portrait-ring")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(page.locator('.topology-edge[data-active="true"]')).toHaveCSS("animation-name", "none");
  const animated = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".topology-shell, .topology-shell *"))
      .map((element) => getComputedStyle(element).animationName)
      .filter((name) => name !== "none"),
  );
  expect(animated).toEqual([]);
  diagnostics.assertClean();
});
