import { test, expect } from "@playwright/test";
import { execute, one } from "./support/db";

/**
 * End-to-end receipt test for the owner email handoff.
 *
 * Runs against the isolated E2E database and owner storage state. The fixture
 * application exists only for this test; no employer is contacted and no email
 * is sent by the application.
 */
// A Playwright retry reuses the isolated database. Leaving a previous card
// behind made every later attempt match two employers and fail on strict mode.
test.afterEach(() => {
  execute("DELETE FROM application_events WHERE application_id LIKE 'app_e2e_handoff_%'");
  execute("DELETE FROM submission_attempts WHERE job_id LIKE 'job_e2e_handoff_%'");
  execute("DELETE FROM recruitment_queue WHERE job_id LIKE 'job_e2e_handoff_%'");
  execute("DELETE FROM applications WHERE id LIKE 'app_e2e_handoff_%'");
  execute("DELETE FROM jobs WHERE id LIKE 'job_e2e_handoff_%'");
});

test("an owner can mark an email handoff as sent and the receipt is persisted", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const jobId = `job_e2e_handoff_${suffix}`;
  const applicationId = `app_e2e_handoff_${suffix}`;
  const now = new Date().toISOString();
  const email = `careers+${suffix}@example-employer.ch`;
  const note = `Sent from the owner mailbox on ${now.slice(0, 10)} with CV and cover letter attached.`;

  execute(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, url, application_email, url_confidence,
        description, discovered_at, status, match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'jobs_ch', ?, 'QA Automation Engineer', 'Example Employer AG', 'Zug',
             'https://www.jobs.ch/en/vacancies/detail/e2e-handoff/', ?, 'email',
             'Playwright and API test automation.', ?, 'new', 93, 'eligible', 1, 'open')`,
    jobId,
    `ext-${suffix}`,
    email,
    now,
  );
  execute(
    `INSERT INTO applications (id, job_id, status, submission_state, last_update, created_at)
     VALUES (?, ?, 'human_intervention_required', 'awaiting_human', ?, ?)`,
    applicationId,
    jobId,
    now,
    now,
  );
  execute(
    `INSERT INTO recruitment_queue (job_id, canonical_key, state, reason, attempts, entered_at, last_checked_at, updated_at)
     VALUES (?, ?, 'awaiting_human', 'The employer accepts applications by email.', 0, ?, ?, ?)`,
    jobId,
    `e2e-handoff|${suffix}`,
    now,
    now,
    now,
  );

  await page.goto("/handoff", { waitUntil: "domcontentloaded" });
  const card = page.locator("section.card", { hasText: email });
  await expect(card).toBeVisible();
  await expect(card.getByText(email)).toBeVisible();
  await expect(card.getByRole("link", { name: /Open email draft/i })).toHaveAttribute(
    "href",
    new RegExp(`mailto:${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );

  await card.getByLabel(/Note/i).fill(note);
  await card.getByRole("button", { name: /Mark as sent/i }).click();

  await page.waitForURL(/\/handoff\?ok=/, { timeout: 30_000 });
  await expect(page.getByText(/Marked as sent/i)).toBeVisible();

  const updatedCard = page.locator("section.card", { hasText: email });
  await expect(updatedCard.getByText("Sent by you").first()).toBeVisible();
  await expect(updatedCard.getByText(note)).toBeVisible();
  await expect(updatedCard.getByRole("button", { name: /Mark as sent/i })).toHaveCount(0);

  const application = one<{
    status: string;
    submission_state: string;
    submission_status: string;
    email_handoff_sent_at: string | null;
    email_handoff_note: string | null;
    submitted_at: string | null;
  }>(
    "SELECT status, submission_state, submission_status, email_handoff_sent_at, email_handoff_note, submitted_at FROM applications WHERE id = ?",
    applicationId,
  );
  expect(application?.status).toBe("submitted_unverified");
  expect(application?.submission_state).toBe("sent_by_owner");
  expect(application?.submission_status).toBe("unverified");
  expect(application?.email_handoff_sent_at).toBeTruthy();
  expect(application?.email_handoff_note).toBe(note);
  expect(application?.submitted_at).toBeTruthy();

  expect(
    one<{ state: string }>("SELECT state FROM recruitment_queue WHERE job_id = ?", jobId)?.state,
  ).toBe("sent_by_owner");
  expect(
    one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'submission.owner_sent'",
      applicationId,
    )?.c,
  ).toBe(1);
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", jobId)?.c,
  ).toBe(0);

  // Reloading proves the receipt survives a fresh render and the form is gone.
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = page.locator("section.card", { hasText: email });
  await expect(reloaded.getByText("Sent by you").first()).toBeVisible();
  await expect(reloaded.getByText(note)).toBeVisible();
  await expect(reloaded.getByRole("button", { name: /Mark as sent/i })).toHaveCount(0);

  // The application detail timeline shows the owner receipt with its note.
  await page.goto(`/applications/${applicationId}`, { waitUntil: "domcontentloaded" });
  const history = page.locator("section.card", { hasText: "History" });
  await expect(history.getByText("Email application sent by you")).toBeVisible();
  await expect(history.getByText(email)).toBeVisible();
  await expect(history.getByText(note)).toBeVisible();
  await expect(history.getByText(/Owner attestation/)).toBeVisible();
  await expect(history.getByText(/not employer confirmation/)).toBeVisible();

  const beforeReload = one<{
    email_handoff_sent_at: string | null;
    email_handoff_note: string | null;
    submission_status: string | null;
    submission_state: string | null;
  }>(
    "SELECT email_handoff_sent_at, email_handoff_note, submission_status, submission_state FROM applications WHERE id = ?",
    applicationId,
  );
  const eventsBefore = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'submission.owner_sent'",
    applicationId,
  )?.c;

  // A fresh render must reconstruct the same owner receipt from SQLite.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");
  const reloadedHistory = page.locator("section.card", { hasText: "History" });
  await expect(reloadedHistory.getByText("Email application sent by you")).toBeVisible();
  await expect(reloadedHistory.getByText(email)).toBeVisible();
  await expect(reloadedHistory.getByText(note)).toBeVisible();
  await expect(reloadedHistory.getByText(/Owner attestation/)).toBeVisible();
  await expect(reloadedHistory.getByText(/not employer confirmation/)).toBeVisible();

  const afterReload = one<{
    email_handoff_sent_at: string | null;
    email_handoff_note: string | null;
    submission_status: string | null;
    submission_state: string | null;
  }>(
    "SELECT email_handoff_sent_at, email_handoff_note, submission_status, submission_state FROM applications WHERE id = ?",
    applicationId,
  );
  expect(afterReload).toEqual(beforeReload);
  expect(afterReload?.submission_status).toBe("unverified");
  expect(afterReload?.submission_state).toBe("sent_by_owner");
  expect(
    one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'submission.owner_sent'",
      applicationId,
    )?.c,
  ).toBe(eventsBefore);
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", jobId)?.c,
  ).toBe(0);
});

test("a mark-as-sent request is rejected for an application without an email destination", async ({ page }) => {
  const suffix = Date.now().toString(36);
  const emailJobId = `job_e2e_reject_donor_${suffix}`;
  const emailApplicationId = `app_e2e_reject_donor_${suffix}`;
  const formJobId = `job_e2e_reject_form_${suffix}`;
  const formApplicationId = `app_e2e_reject_form_${suffix}`;
  const now = new Date().toISOString();

  // A valid email handoff supplies the real rendered server-action form.
  execute(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, url, application_email, url_confidence,
        description, discovered_at, status, match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'jobs_ch', ?, 'QA Automation Engineer', 'Donor Employer AG', 'Bern',
             'https://www.jobs.ch/en/vacancies/detail/e2e-reject-donor/', ?, 'email',
             'Playwright and API test automation.', ?, 'new', 91, 'eligible', 1, 'open')`,
    emailJobId,
    `ext-donor-${suffix}`,
    `careers+donor-${suffix}@example-employer.ch`,
    now,
  );
  execute(
    `INSERT INTO applications (id, job_id, status, submission_state, last_update, created_at)
     VALUES (?, ?, 'human_intervention_required', 'awaiting_human', ?, ?)`,
    emailApplicationId,
    emailJobId,
    now,
    now,
  );

  // The target vacancy has a web form, not an email destination.
  execute(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, url, application_email, url_confidence,
        description, discovered_at, status, match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'jobs_ch', ?, 'QA Engineer', 'Webform Employer AG', 'Basel',
             'https://www.jobs.ch/en/vacancies/detail/e2e-reject-form/', NULL, 'verified',
             'Web form application.', ?, 'new', 90, 'eligible', 1, 'open')`,
    formJobId,
    `ext-form-${suffix}`,
    now,
  );
  execute(
    `INSERT INTO applications (id, job_id, status, last_update, created_at)
     VALUES (?, ?, 'prepared', ?, ?)`,
    formApplicationId,
    formJobId,
    now,
    now,
  );

  await page.goto("/handoff", { waitUntil: "domcontentloaded" });
  const emailForm = page.locator('form:has(button:has-text("Mark as sent"))').first();
  await expect(emailForm).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/handoff\?error=/, { timeout: 30_000 }),
    emailForm.evaluate((form, applicationId) => {
      const tampered = form.cloneNode(true) as HTMLFormElement;
      tampered.style.display = "none";
      const idInput = tampered.querySelector('input[name="applicationId"]') as HTMLInputElement;
      idInput.value = applicationId;
      const noteInput = tampered.querySelector('textarea[name="note"]') as HTMLTextAreaElement;
      noteInput.value = "This must never be recorded.";
      document.body.appendChild(tampered);
      tampered.requestSubmit();
    }, formApplicationId),
  ]);

  await expect(page.getByText(/not an email application/i).first()).toBeVisible();

  const untouched = one<{
    status: string;
    submission_state: string | null;
    submission_status: string | null;
    email_handoff_sent_at: string | null;
    email_handoff_note: string | null;
    submitted_at: string | null;
  }>(
    "SELECT status, submission_state, submission_status, email_handoff_sent_at, email_handoff_note, submitted_at FROM applications WHERE id = ?",
    formApplicationId,
  );
  expect(untouched?.status).toBe("prepared");
  expect(untouched?.submission_state).toBeNull();
  expect(untouched?.submission_status).toBeNull();
  expect(untouched?.email_handoff_sent_at).toBeNull();
  expect(untouched?.email_handoff_note).toBeNull();
  expect(untouched?.submitted_at).toBeNull();
  expect(
    one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'submission.owner_sent'",
      formApplicationId,
    )?.c,
  ).toBe(0);
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", formJobId)?.c,
  ).toBe(0);

  // The donation form itself was not marked sent by the tampered request.
  expect(
    one<{ email_handoff_sent_at: string | null }>(
      "SELECT email_handoff_sent_at FROM applications WHERE id = ?",
      emailApplicationId,
    )?.email_handoff_sent_at,
  ).toBeNull();
});
