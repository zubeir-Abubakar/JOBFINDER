import { test, expect, gotoReady } from "./support/fixtures";
import { execute, one, waitForDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.setTimeout(150_000);

const syntheticTitle = "Senior QA Automation Engineer";

// A retry reuses the isolated database. This spec ends with a verified manual
// record, so leaving it behind made later whole-database counts depend on test
// order. Cleanup keeps the leakage impossible without relaxing any assertion.
test.afterEach(() => {
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE title = ?", syntheticTitle);
  if (!job) return;
  execute("DELETE FROM application_events WHERE application_id IN (SELECT id FROM applications WHERE job_id = ?)", job.id);
  execute("DELETE FROM submission_attempts WHERE job_id = ?", job.id);
  execute("DELETE FROM applications WHERE job_id = ?", job.id);
  execute("UPDATE jobs SET status = 'documents' WHERE id = ?", job.id);
});

/**
 * SubmitButton disables until an editable field changes. If the first change
 * event lands before hydration, keep dispatching a real change until the form
 * observes it, rather than retrying an inaccessible click.
 */
async function chooseStatus(form: import("@playwright/test").Locator, option: string): Promise<void> {
  await form.page().waitForLoadState("networkidle");
  const select = form.locator("select[name=status]");
  const save = form.getByRole("button", { name: "Save status" });
  await select.selectOption(option);
  await expect
    .poll(
      async () => {
        if (await save.isEnabled()) return true;
        await select.dispatchEvent("change");
        return save.isEnabled();
      },
      { timeout: 15_000 },
    )
    .toBe(true);
}

test("browser discovery inserts only eligible synthetic vacancies and deduplicates reruns", async ({ page, diagnostics }) => {
  await gotoReady(page, "/jobs");
  await page.getByLabel("Pages to search").selectOption("1");
  await page.getByRole("button", { name: /Start research/i }).click();
  await page.waitForURL(/\/jobs\?ok=/, { timeout: 100_000 });

  const job = await waitForDb(
    () => one<{ id: string; source: string; external_id: string; title: string; company: string; match_score: number | null }>(
      "SELECT id, source, external_id, title, company, match_score FROM jobs WHERE source = 'arbeitnow' AND title = ?",
      syntheticTitle,
    ),
    { timeout: 30_000 },
  );
  expect(job.external_id).toBe("e2e-qa-automation-zurich");
  expect(job.match_score).not.toBeNull();
  const total = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE source = 'arbeitnow'")?.c ?? 0;
  expect(total).toBe(1);
  await expect(page.getByText("Marketing Campaign Manager")).toHaveCount(0);
  await expect(page.getByText(syntheticTitle).first()).toBeVisible();

  await page.getByLabel("Pages to search").selectOption("1");
  await page.getByRole("button", { name: /Start research/i }).click();
  await page.waitForURL(/\/jobs\?ok=/, { timeout: 100_000 });
  const after = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE source = 'arbeitnow'")?.c ?? 0;
  expect(after).toBe(1);
  diagnostics.assertClean();
});

test("job filters and manual duplicate prevention operate on stored records", async ({ page, diagnostics }) => {
  const manualTitle = `Staff QA Automation Engineer ${Date.now()}`;
  const manualUrl = `https://careers.alpine-synthetic.example/jobs/staff-qa-${Date.now()}`;
  await gotoReady(page, "/jobs?q=Senior+QA+Automation+Engineer");
  await expect(page.getByText(syntheticTitle).first()).toBeVisible();
  await expect(page.getByText("Marketing Campaign Manager")).toHaveCount(0);

  await gotoReady(page, "/jobs#manual");
  const form = page.locator("#manual form");
  await form.locator("#title").fill(manualTitle);
  await form.locator("#company").fill("Alpine Synthetic Labs");
  await form.locator("#location").fill("Zurich, Switzerland");
  await form.locator("#employment_type").fill("Full-time");
  await form.locator("#url").fill(manualUrl);
  await form.locator("#description").fill(
    "Own end-to-end quality engineering for a Swiss SaaS platform. Build Playwright suites, improve CI reliability and lead test automation standards across the engineering group.",
  );
  await form.getByRole("button", { name: /Add vacancy and analyse/i }).click();
  await page.waitForURL(/\/jobs\/job_/, { timeout: 45_000 });

  const manual = await waitForDb(
    () =>
      one<{ id: string; company: string; source: string; match_score: number | null }>(
        "SELECT id, company, source, match_score FROM jobs WHERE title = ?",
        manualTitle,
      ),
    { timeout: 20_000 },
  );
  expect(manual.company).toBe("Alpine Synthetic Labs");
  expect(manual.source).toBe("manual");
  expect(manual.match_score).not.toBeNull();
  await expect(page.getByText("Match analysis")).toBeVisible();

  await page.goto("/jobs#manual", { waitUntil: "domcontentloaded" });
  const duplicate = page.locator("#manual form");
  await duplicate.locator("#title").fill(manualTitle);
  await duplicate.locator("#company").fill("Alpine Synthetic Labs");
  await duplicate.locator("#location").fill("Zurich, Switzerland");
  await duplicate.locator("#url").fill(manualUrl);
  await duplicate.locator("#description").fill(
    "Own end-to-end quality engineering for a Swiss SaaS platform. Build Playwright suites, improve CI reliability and lead test automation standards across the engineering group.",
  );
  await duplicate.getByRole("button", { name: /Add vacancy and analyse/i }).click();
  await expect(page.getByText(/already exists/i)).toBeVisible();
  const count = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE title = ?", manualTitle)?.c ?? 0;
  expect(count).toBe(1);
  diagnostics.assertClean();
});

test("application creation, status update and in-app notification are persisted without submission", async ({ page, diagnostics }) => {
  const job = one<{ id: string }>("SELECT id FROM jobs WHERE title = ?", syntheticTitle);
  expect(job).toBeTruthy();

  // A Playwright retry reuses the isolated runtime. Reset only this synthetic
  // application so the pre-submission assertions run against a clean record.
  const stale = one<{ id: string; submitted_at: string | null }>(
    "SELECT id, submitted_at FROM applications WHERE job_id = ?",
    job!.id,
  );
  if (stale?.submitted_at) {
    execute("DELETE FROM submission_attempts WHERE job_id = ?", job!.id);
    execute("DELETE FROM applications WHERE id = ?", stale.id);
    execute("UPDATE jobs SET status = 'documents' WHERE id = ?", job!.id);
  }

  await gotoReady(page, `/jobs/${job!.id}`);
  let app = one<{ id: string; status: string; submitted_at: string | null }>(
    "SELECT id, status, submitted_at FROM applications WHERE job_id = ?",
    job!.id,
  );
  let createdNow = false;
  if (!app) {
    await page.getByRole("button", { name: /Create application record/i }).click();
    await page.waitForURL(/\/applications\?ok=/, { timeout: 45_000 });
    app = await waitForDb(
      () => one<{ id: string; status: string; submitted_at: string | null }>("SELECT id, status, submitted_at FROM applications WHERE job_id = ?", job!.id),
      { timeout: 15_000 },
    );
    createdNow = true;
  }
  const application = app!;
  if (createdNow) expect(["documents_preparing", "quality_check", "ready_to_submit"]).toContain(application.status);
  else expect(["documents_preparing", "quality_check", "ready_to_submit", "awaiting_approval", "interview_invited", "submitted"]).toContain(application.status);
  expect(application.submitted_at).toBeNull();
  const jobStatus = one<{ status: string }>("SELECT status FROM jobs WHERE id = ?", job!.id)?.status;
  expect(jobStatus).toBe("documents");

  await page.goto(`/applications/${application.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/applications\/app_/);
  await expect(page.getByText(/automatic submission/i).first()).toBeVisible();
  await expect(page.getByText("Approve application package")).toHaveCount(0);

  // The old UI allowed this. The server must now reject an interview stage when
  // no verified employer evidence exists, and leave the record untouched.
  const beforeReject = one<{ status: string; submitted_at: string | null; confirmation: string | null; last_update: string }>(
    "SELECT status, submitted_at, confirmation, last_update FROM applications WHERE id = ?",
    application.id,
  );
  expect(beforeReject).toBeTruthy();
  const interviewsBefore = one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'interview'")?.c ?? 0;

  const statusForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save status" }) });
  await chooseStatus(statusForm, "interview_invited");
  await statusForm.getByRole("button", { name: "Save status" }).click();
  await page.waitForURL(new RegExp(`/applications/${application.id}\\?error=`), { timeout: 30_000 });
  await expect(page.locator(".alert-error").first()).toContainText(/verified employer confirmation/i);

  const afterReject = one<{ status: string; submitted_at: string | null; confirmation: string | null; last_update: string }>(
    "SELECT status, submitted_at, confirmation, last_update FROM applications WHERE id = ?",
    application.id,
  );
  expect(afterReject).toEqual(beforeReject);
  expect(one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'interview'")?.c ?? 0).toBe(interviewsBefore);
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'application.transition_rejected'")?.c ?? 0,
  ).toBeGreaterThan(0);

  // The Kanban drop target uses the same rule; a rejected drop leaves the card
  // where it was and explains why.
  await gotoReady(page, "/applications");
  const boardCard = page.locator(`.kanban-card[data-card-id="${application.id}"]`);
  await expect(boardCard).toBeVisible();
  await boardCard.locator("summary.kanban-move-summary").click();
  await boardCard.getByRole("button", { name: /Move to Applied/ }).click();
  await expect(page.locator(".kanban-notice")).toContainText(/verified employer confirmation/i);
  expect(one<{ status: string }>("SELECT status FROM applications WHERE id = ?", application.id)?.status).toBe(
    beforeReject!.status,
  );

  // Recording real employer evidence is the supported path. Afterwards the
  // interview transition is allowed and the board counts it as Applied.
  await page.goto(`/applications/${application.id}`, { waitUntil: "domcontentloaded" });
  const confirmation = `E2E-${Date.now()}`;
  const submissionForm = page.locator("form").filter({ has: page.getByRole("button", { name: /Record confirmed submission/i }) });
  const confirmationInput = submissionForm.locator("#confirmation");
  const recordSubmission = submissionForm.getByRole("button", { name: /Record confirmed submission/i });
  await confirmationInput.fill(confirmation);
  // SubmitButton enables itself from a React change event. If fill landed
  // before hydration, dispatch the event until the form observes the change.
  await expect
    .poll(
      async () => {
        if (await recordSubmission.isEnabled()) return true;
        await confirmationInput.dispatchEvent("input");
        await confirmationInput.dispatchEvent("change");
        return recordSubmission.isEnabled();
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await recordSubmission.click();
  const verifiedRow = await waitForDb(
    () => {
      const row = one<{ status: string; submitted_at: string | null; confirmation: string | null }>(
        "SELECT status, submitted_at, confirmation FROM applications WHERE id = ?",
        application.id,
      );
      return row?.status === "submitted" ? row : null;
    },
    { timeout: 20_000 },
  );
  expect(verifiedRow.status).toBe("submitted");
  expect(verifiedRow.confirmation).toBe(confirmation);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const verifiedStatusForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save status" }) });
  await chooseStatus(verifiedStatusForm, "interview_invited");
  await verifiedStatusForm.getByRole("button", { name: "Save status" }).click();
  await page.waitForURL(new RegExp(`/applications/${application.id}\\?ok=`), { timeout: 30_000 });
  const updated = await waitForDb(
    () => one<{ status: string; submitted_at: string | null }>("SELECT status, submitted_at FROM applications WHERE id = ?", application.id),
    { timeout: 15_000 },
  );
  expect(updated.status).toBe("interview_invited");
  expect(updated.submitted_at).not.toBeNull();
  const notification = one<{ kind: string; subject: string; delivery_status: string | null; provider_message_id: string | null }>(
    "SELECT kind, subject, delivery_status, provider_message_id FROM notifications WHERE kind = 'interview' ORDER BY id DESC LIMIT 1",
  );
  expect(notification?.subject).toContain("Interview invitation");
  expect(notification?.provider_message_id).toBeNull();

  // Column headers must equal the cards actually rendered.
  await gotoReady(page, "/applications");
  for (const column of ["considering", "to_apply", "applied", "needs_attention"]) {
    const region = page.locator(`.kanban-col[data-column="${column}"]`);
    const header = Number((await region.locator(".kanban-col-head .num").innerText()).trim());
    const cards = await region.locator(".kanban-card").count();
    const viewAll = await region.getByRole("link", { name: /View all/ }).count();
    if (!viewAll) expect(cards, `${column} header/card mismatch`).toBe(header);
  }
  const attempts = one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", job!.id)?.c ?? 0;
  expect(attempts).toBeGreaterThanOrEqual(1);
  diagnostics.assertClean();
});
