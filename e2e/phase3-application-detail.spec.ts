import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { test, expect, gotoReady } from "./support/fixtures";
import { execute, one, query } from "./support/db";

/**
 * Browser receipt test for the Phase 3 application lifecycle.
 *
 * The rows mirror the isolated orchestration result: a synthetic employer
 * reference, a verified attempt, passed documents, a confirmed queue entry and
 * persisted events. Nothing here contacts an employer or sends an application.
 */
test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const jobId = `job_e2e_phase3_receipt_${suffix}`;
const applicationId = `app_e2e_phase3_receipt_${suffix}`;
const cvId = `doc_e2e_phase3_cv_${suffix}`;
const coverId = `doc_e2e_phase3_cover_${suffix}`;
const attemptId = `attempt_e2e_phase3_${suffix}`;
const reference = "ATS-2026-1001";
const title = "Senior QA Automation Engineer";
const company = "Synthetic Phase 3 AG";
const preparedMessage = `Tailored CV and cover letter prepared for ${reference}.`;
const verifiedMessage = `Submission verified by employer reference ${reference}.`;
const now = new Date().toISOString();
const uploadDir = path.join(process.cwd(), ".e2e-runtime/data/uploads");
const uploadFiles = [cvId, coverId].map((id) => `${id}.pdf`);

function copyFixturePdf(fileName: string): void {
  copyFileSync(path.join(process.cwd(), "e2e/fixtures/synthetic-cv.pdf"), path.join(uploadDir, fileName));
}

test.beforeAll(() => {
  const owner = query<{ id: string }>(
    "SELECT id FROM users WHERE role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1",
  )[0];
  if (!owner) throw new Error("Phase 3 receipt fixture requires the provisioned owner account.");
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  for (const fileName of uploadFiles) copyFixturePdf(fileName);

  execute(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, remote, url, application_url, application_email,
        url_confidence, description, discovered_at, status, dedupe_key, match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'fixture', ?, ?, ?, 'Zürich, Switzerland', 0,
             'https://synthetic-phase3.invalid/jobs/senior-qa', 'https://synthetic-phase3.invalid/ats/apply', NULL,
             'verified', 'Playwright, API testing and release readiness.', ?, 'documents', ?, 96, 'eligible', 1, 'open')`,
    jobId,
    `phase3-${suffix}`,
    title,
    company,
    now,
    `phase3-receipt-${suffix}`,
  );

  for (const [id, kind, displayName] of [
    [cvId, "tailored_cv", "Synthetic Phase 3 — Tailored CV"],
    [coverId, "cover_letter", "Synthetic Phase 3 — Cover Letter"],
  ] as const) {
    execute(
      `INSERT INTO documents
         (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version,
          status, created_at, quality_status, quality_score, text_content)
       VALUES (?, ?, ?, ?, ?, 'application/pdf', ?, 2048, ?, '1', 'ready', ?, 'passed', 96, ?)`,
      id,
      owner.id,
      kind,
      displayName,
      `${id}.pdf`,
      `${id}.pdf`,
      jobId,
      now,
      kind === "tailored_cv" ? "Synthetic Phase 3 CV evidence." : "Synthetic Phase 3 cover-letter evidence.",
    );
  }

  execute(
    `INSERT INTO applications
       (id, job_id, status, cv_document_id, cover_letter_id, method, confirmation, submitted_at,
        last_update, created_at, submission_status, submission_state, submission_evidence,
        confirmation_ref, match_score_at_submit, readiness, readiness_checked_at)
     VALUES (?, ?, 'submitted', ?, ?, 'browser_form', ?, ?, ?, ?, 'verified', 'submitted_reference', ?, ?, 96, ?, ?)`,
    applicationId,
    jobId,
    cvId,
    coverId,
    reference,
    now,
    now,
    now,
    JSON.stringify({ outcomeClass: "submitted_verified", reference, reconciliationState: "confirmed" }),
    reference,
    JSON.stringify({ ready: true, state: "ready_for_submission", reasons: [] }),
    now,
  );

  execute(
    `INSERT INTO submission_attempts
       (id, application_id, job_id, channel, endpoint, destination, status, http_status, reference, evidence,
        error, attempted_at, idempotency_key, started_at, reconciliation_state, reconciliation_evidence, reconciled_at)
     VALUES (?, ?, ?, 'candidate_form', 'https://synthetic-phase3.invalid/ats/apply',
             'https://synthetic-phase3.invalid/ats/apply', 'verified', 200, ?, ?, NULL, ?, ?, ?, 'confirmed', ?, ?)`,
    attemptId,
    applicationId,
    jobId,
    reference,
    JSON.stringify({ confirmation: reference, status: "verified" }),
    now,
    `phase3-idempotency-${suffix}`,
    now,
    JSON.stringify({ reference, decision: "confirmed" }),
    now,
  );

  execute(
    `INSERT INTO recruitment_queue
       (job_id, canonical_key, state, reason, destination_confidence, destination_url, attempts,
        entered_at, last_checked_at, updated_at)
     VALUES (?, ?, 'confirmed', ?, 'verified', 'https://synthetic-phase3.invalid/ats/apply', 1, ?, ?, ?)`,
    jobId,
    `phase3-receipt-${suffix}`,
    `Submission verified by employer reference ${reference}.`,
    now,
    now,
    now,
  );

  execute(
    `INSERT INTO application_events (application_id, type, message, meta, created_at)
     VALUES (?, 'documents.prepared', ?, ?, ?)`,
    applicationId,
    preparedMessage,
    JSON.stringify({ cvDocumentId: cvId, coverDocumentId: coverId }),
    now,
  );
  execute(
    `INSERT INTO application_events (application_id, type, message, meta, created_at)
     VALUES (?, 'submission.verified', ?, ?, ?)`,
    applicationId,
    verifiedMessage,
    JSON.stringify({ reference, attemptId }),
    now,
  );
});

test.afterAll(() => {
  execute("DELETE FROM application_events WHERE application_id = ?", applicationId);
  execute("DELETE FROM submission_attempts WHERE job_id = ?", jobId);
  execute("DELETE FROM recruitment_queue WHERE job_id = ?", jobId);
  execute("DELETE FROM applications WHERE id = ?", applicationId);
  execute("DELETE FROM documents WHERE job_id = ?", jobId);
  execute("DELETE FROM jobs WHERE id = ?", jobId);
  for (const fileName of uploadFiles) rmSync(path.join(uploadDir, fileName), { force: true });
});

test("the Phase 3 receipt and verified history survive a detail-page reload", async ({ page, diagnostics }) => {
  await gotoReady(page, `/applications/${applicationId}`);

  await expect(page.getByRole("heading", { name: `${title} — ${company}`, level: 1 })).toBeVisible();
  await expect(page.getByText("Employer confirmation", { exact: true })).toBeVisible();
  await expect(page.getByText(reference, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/employer-confirmed/).first()).toBeVisible();

  // Both linked documents render from the persisted application row.
  await expect(
    page.getByText(new RegExp(`${company} — ${title} · Tailored CV · v1`)).first(),
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`${company} — ${title} · Cover letter · v1`)).first(),
  ).toBeVisible();
  await expect(page.getByText(/quality passed/).first()).toBeVisible();
  await expect(page.getByText("This document could not be loaded.")).toHaveCount(0);

  // No manual receipt form remains once the submission is verified.
  await expect(page.getByRole("button", { name: /Record confirmed submission/i })).toHaveCount(0);

  const history = page.locator("section.card", { hasText: "History" });
  await expect(history.getByText(preparedMessage, { exact: true })).toBeVisible();
  await expect(history.getByText(verifiedMessage, { exact: true })).toBeVisible();
  await expect(history.getByText(/documents\.prepared/)).toBeVisible();
  await expect(history.getByText(/submission\.verified/)).toBeVisible();

  const attemptsBefore = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?",
    jobId,
  )?.c;
  expect(attemptsBefore).toBe(1);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("heading", { name: `${title} — ${company}`, level: 1 })).toBeVisible();
  await expect(page.getByText(reference, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/employer-confirmed/).first()).toBeVisible();
  await expect(
    page.getByText(new RegExp(`${company} — ${title} · Tailored CV · v1`)).first(),
  ).toBeVisible();
  await expect(
    page.getByText(new RegExp(`${company} — ${title} · Cover letter · v1`)).first(),
  ).toBeVisible();
  await expect(page.getByText("This document could not be loaded.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Record confirmed submission/i })).toHaveCount(0);

  const reloadedHistory = page.locator("section.card", { hasText: "History" });
  await expect(reloadedHistory.getByText(preparedMessage, { exact: true })).toBeVisible();
  await expect(reloadedHistory.getByText(verifiedMessage, { exact: true })).toBeVisible();
  await expect(reloadedHistory.getByText(/documents\.prepared/)).toBeVisible();
  await expect(reloadedHistory.getByText(/submission\.verified/)).toBeVisible();

  // A read-only page load must not create a second attempt or receipt event.
  expect(
    one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", jobId)?.c,
  ).toBe(1);
  expect(
    one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM application_events WHERE application_id = ? AND type = 'submission.verified'",
      applicationId,
    )?.c,
  ).toBe(1);
  expect(
    one<{ status: string; submission_status: string; submission_state: string; confirmation_ref: string }>(
      "SELECT status, submission_status, submission_state, confirmation_ref FROM applications WHERE id = ?",
      applicationId,
    ),
  ).toEqual({
    status: "submitted",
    submission_status: "verified",
    submission_state: "submitted_reference",
    confirmation_ref: reference,
  });
  expect(one<{ state: string }>("SELECT state FROM recruitment_queue WHERE job_id = ?", jobId)?.state).toBe(
    "confirmed",
  );

  diagnostics.assertClean();
});
