import fs from "node:fs";
import { test, expect, gotoReady } from "./support/fixtures";
import { execute, one, query } from "./support/db";

/**
 * Populated synthetic Applications board for the remediation acceptance checks.
 * Every record is created in the isolated E2E runtime and removed afterwards.
 * No employer, mailbox or external service is contacted.
 */

test.describe.configure({ mode: "serial" });
test.setTimeout(150_000);

const PREFIX = "e2e_board_";
const VERIFIED_REF = "BOARD-REF";
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

const seeds: Array<{ n: number; status: string; evidence: boolean }> = [
  { n: 1, status: "discovered", evidence: false },
  { n: 2, status: "ready_to_submit", evidence: false },
  { n: 3, status: "submitted", evidence: true },
  { n: 4, status: "interview_invited", evidence: true },
  { n: 5, status: "interview_invited", evidence: false },
  { n: 6, status: "submitted", evidence: false },
  { n: 7, status: "submission_unverified", evidence: false },
  { n: 8, status: "ready_to_submit", evidence: false },
  { n: 9, status: "offer_received", evidence: true },
  { n: 10, status: "acknowledged", evidence: false },
  { n: 11, status: "rejected", evidence: false },
  { n: 12, status: "documents_preparing", evidence: false },
];

const appId = (n: number) => `${PREFIX}app_${String(n).padStart(2, "0")}`;
const jobId = (n: number) => `${PREFIX}job_${String(n).padStart(2, "0")}`;

function cleanup(): void {
  execute(`DELETE FROM documents WHERE job_id LIKE '${PREFIX}%'`);
  execute(`DELETE FROM applications WHERE id LIKE '${PREFIX}%' OR job_id LIKE '${PREFIX}%'`);
  execute(`DELETE FROM jobs WHERE id LIKE '${PREFIX}%'`);
  execute(`DELETE FROM audit_logs WHERE entity_id LIKE '${PREFIX}%'`);
  execute(`DELETE FROM notifications WHERE dedupe_key LIKE '${PREFIX}%'`);
}

test.beforeAll(() => {
  fs.mkdirSync("artifacts/remediation", { recursive: true });
  cleanup();
  for (const seed of seeds) {
    const created = iso(seed.n * 10);
    execute(
      `INSERT INTO jobs (id, source, external_id, title, company, location, remote, url, description, discovered_at, status, match_score, match_flag)
       VALUES (?, 'e2e_board', ?, ?, 'Board Fixture Labs', 'Zurich, Switzerland', 1, ?, ?, ?, 'documents', ?, 'strong')`,
      jobId(seed.n),
      `board-${seed.n}`,
      `Synthetic QA Role ${String(seed.n).padStart(2, "0")}`,
      `https://careers.board-fixture.example/jobs/${seed.n}`,
      "Synthetic vacancy used only for board acceptance checks. Build Playwright suites and own release quality.",
      created,
      90 - seed.n,
    );
    execute(
      `INSERT INTO applications (id, job_id, status, submitted_at, confirmation, method, last_update, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      appId(seed.n),
      jobId(seed.n),
      seed.status,
      seed.evidence ? created : null,
      seed.evidence ? `${VERIFIED_REF}-${String(seed.n).padStart(2, "0")}` : null,
      seed.evidence ? "employer_portal" : null,
      created,
      created,
    );
  }

  // Version-labelled files let the detail page prove its accurate wording.
  const owner = one<{ id: string }>("SELECT id FROM users ORDER BY created_at LIMIT 1");
  if (owner) {
    for (const version of ["1.0", "2.0", "3.0"]) {
      execute(
        `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, created_at)
         VALUES (?, ?, 'tailored_cv', 'Board Fixture CV', 'board-fixture.pdf', 'application/pdf', 'board-fixture.pdf', 1024, ?, ?, 'draft', ?)`,
        `${PREFIX}doc_${version}`,
        owner.id,
        jobId(3),
        version,
        iso(5),
      );
    }
  }
});

test.afterAll(() => {
  cleanup();
});

async function dragCard(page: Parameters<typeof gotoReady>[0], cardId: string, column: string): Promise<void> {
  await page.evaluate(
    ({ cardId, column }) => {
      const card = document.querySelector(`[data-card-id="${cardId}"]`);
      const target = document.querySelector(`.kanban-col[data-column="${column}"]`);
      if (!card || !target) throw new Error("Drag nodes were not rendered");
      const dataTransfer = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
      target.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
    },
    { cardId, column },
  );
}

test("populated board classifies every record and reconciles headers with cards", async ({ page, diagnostics }) => {
  await gotoReady(page, "/applications?q=Board+Fixture+Labs");
  await expect(page.locator(".kanban-col")).toHaveCount(4);
  await expect(page.getByText(/12 matching application records in the board\./)).toBeVisible();

  const expected: Record<string, number> = { considering: 1, to_apply: 3, applied: 3, needs_attention: 4 };
  for (const [column, count] of Object.entries(expected)) {
    const region = page.locator(`.kanban-col[data-column="${column}"]`);
    await expect(region.locator(".kanban-col-head .num")).toHaveText(String(count));
    await expect(region.locator(".kanban-card")).toHaveCount(count);
  }

  // Legacy and unverified records must never appear as employer-confirmed.
  const appliedIds = await page.locator('.kanban-col[data-column="applied"] .kanban-card').evaluateAll((cards) =>
    cards.map((card) => card.getAttribute("data-card-id")),
  );
  expect(appliedIds.sort()).toEqual([appId(3), appId(4), appId(9)].sort());
  for (const hidden of [appId(5), appId(6), appId(10)]) {
    expect(appliedIds).not.toContain(hidden);
  }

  await page.screenshot({ path: "artifacts/remediation/applications-desktop.png", fullPage: true });
  diagnostics.assertClean();
});

test("application detail language matches the actual submission evidence", async ({ page, diagnostics }) => {
  await gotoReady(page, `/applications/${appId(3)}`);
  await expect(page.getByText("Employer-confirmed").first()).toBeVisible();
  await expect(page.locator(`.badge`, { hasText: "Submitted" }).first()).toBeVisible();
  await page.screenshot({ path: "artifacts/remediation/application-detail-verified.png", fullPage: true });

  await gotoReady(page, `/applications/${appId(5)}`);
  await expect(page.locator(".alert-warn").first()).toContainText(/no employer confirmation is stored/i);
  await expect(page.getByText("No verified submission evidence").first()).toBeVisible();
  await expect(page.getByText("Employer-confirmed")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/remediation/application-detail-unverified-interview.png", fullPage: true });

  await gotoReady(page, `/applications/${appId(7)}`);
  await expect(page.locator(".alert-warn").first()).toContainText(/submission was attempted/i);
  await expect(page.getByText("Employer-confirmed")).toHaveCount(0);
  await page.screenshot({ path: "artifacts/remediation/application-detail-submission-unverified.png", fullPage: true });

  // Version-labelled files are described as files, not as a version-history view.
  await gotoReady(page, `/applications/${appId(3)}`);
  await expect(page.getByText(/version-labelled files for this vacancy/)).toHaveCount(1);
  diagnostics.assertClean();
});

test("overview metrics reconcile with the board's own counts", async ({ page, diagnostics }) => {
  const rows = query<{ status: string; submitted_at: string | null; confirmation: string | null }>(
    "SELECT status, submitted_at, confirmation FROM applications",
  );
  const verified = (row: { submitted_at: string | null; confirmation: string | null }) =>
    Boolean(row.submitted_at) && Boolean(row.confirmation);
  const appliedStatuses = ["submitted", "acknowledged", "interview", "interview_invited", "interview_completed", "offer_received"];
  const expectedSubmitted = rows.filter((row) => appliedStatuses.includes(row.status) && verified(row)).length;
  const expectedInterviews = rows.filter(
    (row) => verified(row) && ["interview_invited", "interview_completed"].includes(row.status),
  ).length;
  const expectedAttention = rows.filter((row) => {
    if (appliedStatuses.includes(row.status)) return !verified(row);
    return ["human_intervention_required", "submission_unverified", "submission_unknown", "submission_failed"].includes(row.status);
  }).length;

  await gotoReady(page, "/dashboard");
  const kpi = async (label: RegExp) => {
    const text = (await page.getByLabel(label).getAttribute("aria-label")) ?? "";
    return Number(text.match(/: (\d+)/)?.[1] ?? NaN);
  };
  expect(await kpi(/Applications submitted: \d+/)).toBe(expectedSubmitted);
  expect(await kpi(/Interviews: \d+/)).toBe(expectedInterviews);
  expect(await kpi(/Needs attention: \d+/)).toBe(expectedAttention);
  await expect(page.locator(".responsive-cards tbody tr")).toHaveCount(Math.min(expectedAttention, 4));
  await page.screenshot({ path: "artifacts/remediation/overview-desktop.png", fullPage: true });
  diagnostics.assertClean();
});

test("mobile pages stay usable and the voice control never covers content", async ({ page, diagnostics }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await gotoReady(page, "/dashboard");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator('.responsive-cards tbody td[data-label="Last update"]').first()).toBeVisible();
  await expect(page.locator(".responsive-cards").getByRole("link", { name: "Resolve" }).first()).toBeVisible();
  await page.screenshot({ path: "artifacts/remediation/dashboard-mobile-390.png", fullPage: true });

  await gotoReady(page, "/applications?q=Board+Fixture+Labs");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".kanban-col")).toHaveCount(4);
  await page.screenshot({ path: "artifacts/remediation/applications-mobile-390.png", fullPage: true });

  await gotoReady(page, "/agents/list");
  await page.screenshot({ path: "artifacts/remediation/agents-mobile-390.png", fullPage: true });

  const overlaps = await page.evaluate(() => {
    const launcher = document.querySelector(".voice-trigger")?.getBoundingClientRect();
    if (!launcher) return ["launcher missing"];
    const targets = Array.from(
      document.querySelectorAll(".page button, .page a, .page input, .page select, .page textarea, .page summary"),
    );
    return targets
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;
        return !(
          rect.right <= launcher.left ||
          rect.left >= launcher.right ||
          rect.bottom <= launcher.top ||
          rect.top >= launcher.bottom
        );
      })
      .map((element) => (element.textContent ?? "").trim().slice(0, 40));
  });
  expect(overlaps).toEqual([]);
  await expect(page.getByRole("button", { name: "Open AT Voice Assistant" })).toBeInViewport();

  // Wider mobile viewport as well.
  await page.setViewportSize({ width: 430, height: 932 });
  await gotoReady(page, "/dashboard");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await expect(page.locator(".responsive-cards").getByRole("link", { name: "Resolve" }).first()).toBeVisible();
  diagnostics.assertClean();
});

test("drag and drop uses the server rule, rejects invalid drops and has an accessible alternative", async ({ page, diagnostics }) => {
  await gotoReady(page, "/applications?q=Board+Fixture+Labs");

  // Valid move: Considering -> To be applied.
  await dragCard(page, appId(1), "to_apply");
  await expect(page.locator(".kanban-notice")).toContainText(/Moved to To be applied/i);
  const moved = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      const row = one<{ status: string }>("SELECT status FROM applications WHERE id = ?", appId(1));
      if (row?.status === "documents_preparing") return row;
      await page.waitForTimeout(150);
    }
    return one<{ status: string }>("SELECT status FROM applications WHERE id = ?", appId(1));
  })();
  expect(moved?.status).toBe("documents_preparing");
  await expect(page.locator(`.kanban-col[data-column="to_apply"] [data-card-id="${appId(1)}"]`)).toBeVisible();

  // Invalid drop: an evidence-free submission cannot be forced into Applied.
  await dragCard(page, appId(6), "applied");
  await expect(page.locator(".kanban-notice")).toContainText(/verified employer confirmation/i);
  const unchanged = one<{ status: string; submitted_at: string | null; confirmation: string | null }>(
    "SELECT status, submitted_at, confirmation FROM applications WHERE id = ?",
    appId(6),
  );
  expect(unchanged).toEqual({ status: "submitted", submitted_at: null, confirmation: null });
  await expect(page.locator(`.kanban-col[data-column="needs_attention"] [data-card-id="${appId(6)}"]`)).toBeVisible();
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'application.transition_rejected'")?.c ?? 0,
  ).toBeGreaterThan(0);

  // Accessible alternative: the same action behind a normal button.
  const card = page.locator(`[data-card-id="${appId(2)}"]`);
  await card.locator("summary.kanban-move-summary").click();
  await card.getByRole("button", { name: /Move to Considering/ }).click();
  await expect(page.locator(".kanban-notice")).toContainText(/Moved to Considering/i);
  let alternative: { status: string } | null = null;
  for (let i = 0; i < 40; i += 1) {
    alternative = one<{ status: string }>("SELECT status FROM applications WHERE id = ?", appId(2));
    if (alternative?.status === "under_review") break;
    await page.waitForTimeout(150);
  }
  expect(alternative?.status).toBe("under_review");
  diagnostics.assertClean();
});
