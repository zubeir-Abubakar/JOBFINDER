import { test, expect, gotoReady } from "./support/fixtures";
import { one, waitForDb } from "./support/db";

test.describe.configure({ mode: "serial" });
test.setTimeout(150_000);

const syntheticTitle = "Senior QA Automation Engineer";

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
  if (createdNow) expect(application.status).toBe("awaiting_approval");
  else expect(["awaiting_approval", "interview_invited"]).toContain(application.status);
  expect(application.submitted_at).toBeNull();
  const jobStatus = one<{ status: string }>("SELECT status FROM jobs WHERE id = ?", job!.id)?.status;
  expect(jobStatus).toBe("documents");

  await page.goto(`/applications/${application.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/applications\/app_/);
  await expect(page.getByText(/not submitted/i).first()).toBeVisible();
  await expect(page.getByText("Approve application package")).toBeVisible();

  const statusForm = page.locator("form").filter({ has: page.getByRole("button", { name: "Save status" }) });
  await statusForm.locator("select[name=status]").selectOption("interview_invited");
  await statusForm.getByRole("button", { name: "Save status" }).click();
  await page.waitForURL(new RegExp(`/applications/${application.id}\\?ok=`), { timeout: 30_000 });

  const updated = await waitForDb(
    () => one<{ status: string; submitted_at: string | null }>("SELECT status, submitted_at FROM applications WHERE id = ?", application.id),
    { timeout: 15_000 },
  );
  expect(updated.status).toBe("interview_invited");
  expect(updated.submitted_at).toBeNull();
  const notification = one<{ kind: string; subject: string; delivery_status: string | null; provider_message_id: string | null }>(
    "SELECT kind, subject, delivery_status, provider_message_id FROM notifications WHERE kind = 'interview' ORDER BY id DESC LIMIT 1",
  );
  expect(notification?.subject).toContain("Interview invitation");
  expect(notification?.provider_message_id).toBeNull();
  const attempts = one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts")?.c ?? 0;
  expect(attempts).toBe(0);
  diagnostics.assertClean();
});
