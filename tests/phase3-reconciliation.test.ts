import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 3 — uncertain submission outcomes.
 *
 * Every fixture is local. No employer, ATS, browser or AI provider is
 * contacted. The tests prove that a send which may have reached the employer is
 * never retried blindly and that owner attestation never becomes employer
 * confirmation.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase3-reconciliation-"));
process.env.APP_SECRET_KEY = "phase3-reconciliation-test";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

const db = await import("../lib/db.ts");
const queue = await import("../lib/recruitment-queue.ts");
const reconciliation = await import("../lib/submission-reconciliation.ts");
const resolution = await import("../lib/submission-resolution.ts");

db.getDb();

const NOW = new Date("2026-11-27T09:00:00.000Z");
const at = NOW.toISOString();

function insertApplication(id: string, index: number): { applicationId: string; jobId: string } {
  const jobId = `job_phase3_${index}`;
  db.run(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, remote, url, application_url, description,
        discovered_at, status, dedupe_key, match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'fixture', ?, 'Senior QA Automation Engineer', 'Synthetic Phase 3 AG', 'Zürich, Switzerland', 0,
       ?, ?, 'Playwright, API testing and release readiness.', ?, 'shortlisted', ?, 95, 'eligible', 1, 'open')`,
    [jobId, `phase3-${index}`, `https://example.test/job/${index}`, `https://example.test/apply/${index}`, at, `phase3-${index}`],
  );
  const applicationId = id;
  db.run(
    `INSERT INTO applications
       (id, job_id, status, submission_status, submission_state, readiness, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', NULL, 'ready_for_submission', ?, ?, ?)`,
    [applicationId, jobId, JSON.stringify({ ready: true, state: "ready_for_submission", reasons: [] }), at, at],
  );
  queue.syncQualifiedQueue({ runId: "phase3", now: NOW });
  return { applicationId, jobId };
}

function insertAttempt(input: {
  id: string;
  applicationId: string;
  jobId: string;
  status: string;
  reference?: string | null;
  error?: string | null;
  httpStatus?: number | null;
  reconciliationState?: string | null;
}): void {
  db.run(
    `INSERT INTO submission_attempts
       (id, application_id, job_id, channel, endpoint, destination, status, http_status, reference, evidence,
        error, reconciliation_state, attempted_at, started_at)
     VALUES (?, ?, ?, 'candidate_form', 'https://example.test/apply', 'https://example.test/apply', ?, ?, ?, '{}', ?, ?, ?, ?)`,
    [
      input.id,
      input.applicationId,
      input.jobId,
      input.status,
      input.httpStatus ?? null,
      input.reference ?? null,
      input.error ?? null,
      input.reconciliationState ?? null,
      at,
      at,
    ],
  );
}

test("timeout, network loss and a 200 without a reference are all ambiguous", () => {
  for (const attempt of [
    { status: "failed", httpStatus: null, reference: null, error: "The operation timed out after 45s" },
    { status: "failed", httpStatus: null, reference: null, error: "fetch failed: ECONNRESET" },
    { status: "unverified", httpStatus: 200, reference: null, error: null },
    { status: "failed", httpStatus: 503, reference: null, error: "server unavailable" },
  ]) {
    const decision = reconciliation.reconciliationDecision(attempt);
    assert.equal(decision.action, "blocked", `prior ${attempt.status}/${attempt.httpStatus} must not be resent`);
    assert.match(decision.reason, /ambiguous|confirm|previous attempt/i);
  }
});

test("a rejection or rate limit is not retried automatically either", () => {
  for (const attempt of [
    { status: "failed", httpStatus: 422, reference: null, error: "rejected" },
    { status: "blocked", httpStatus: 429, reference: null, error: "rate limited" },
  ]) {
    const decision = reconciliation.reconciliationDecision(attempt);
    assert.equal(decision.action, "blocked");
  }
});

test("only explicit evidence of non-delivery authorises a later send", () => {
  const decision = reconciliation.reconciliationDecision({
    status: "blocked",
    httpStatus: null,
    reference: null,
    error: "Confirmed not delivered: the employer's form rejected the upload before accepting the application.",
    reconciliationState: "not_delivered",
  });
  assert.equal(decision.action, "send");
  assert.equal(reconciliation.priorAttemptDisposition({
    status: "blocked",
    httpStatus: null,
    reference: null,
    error: "owner says they sent it",
    reconciliationState: "owner_attested",
  }), "ambiguous");
});

test("an owner attestation stays unverified and is not employer confirmation", () => {
  const { applicationId, jobId } = insertApplication("app_phase3_owner", 1);
  insertAttempt({
    id: "att_phase3_owner",
    applicationId,
    jobId,
    status: "unverified",
    error: "worker stopped",
    reconciliationState: "ambiguous",
  });

  const result = resolution.resolveUncertainSubmission({
    applicationId,
    kind: "owner_attestation",
    note: "Owner forwarded the application from their Gmail account.",
    observedAt: at,
    actor: "owner",
  });
  assert.equal(result.applied, true);
  assert.equal(result.state, "submitted_unverified");

  const app = db.one<{
    status: string;
    submission_status: string;
    submission_state: string;
    confirmation: string | null;
    confirmation_ref: string | null;
    submitted_at: string | null;
    email_handoff_note: string | null;
  }>("SELECT status, submission_status, submission_state, confirmation, confirmation_ref, submitted_at, email_handoff_note FROM applications WHERE id = ?", [applicationId]);
  assert.equal(app?.status, "submitted_unverified");
  assert.equal(app?.submission_status, "unverified");
  assert.equal(app?.submission_state, "sent_by_owner");
  assert.equal(app?.confirmation, null, "owner attestation must not create employer confirmation");
  assert.equal(app?.confirmation_ref, null);
  assert.match(app?.email_handoff_note ?? "", /Gmail/);

  const attempt = db.one<{ status: string; reference: string | null; reconciliation_state: string }>(
    "SELECT status, reference, reconciliation_state FROM submission_attempts WHERE id = 'att_phase3_owner'",
  );
  assert.equal(attempt?.status, "unverified");
  assert.equal(attempt?.reference, null);
  assert.equal(attempt?.reconciliation_state, "owner_attested");
  assert.equal(queue.queueSnapshot().find((row) => row.jobId === jobId)?.state, "sent_by_owner");
});

test("employer evidence resolves an uncertain attempt without resending", () => {
  const { applicationId, jobId } = insertApplication("app_phase3_employer", 2);
  insertAttempt({
    id: "att_phase3_employer",
    applicationId,
    jobId,
    status: "unverified",
    httpStatus: 200,
    reference: null,
    error: "confirmation page was unavailable",
  });
  const postsBefore = Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts")?.n);

  const result = resolution.resolveUncertainSubmission({
    applicationId,
    kind: "employer_confirmation",
    reference: "ATS-2026-9001",
    note: "Employer confirmation page supplied the reference.",
    observedAt: at,
    actor: "owner",
  });
  assert.equal(result.applied, true);
  assert.equal(result.state, "confirmed");

  const app = db.one<{ status: string; submission_status: string; confirmation: string | null; confirmation_ref: string | null }>(
    "SELECT status, submission_status, confirmation, confirmation_ref FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.equal(app?.status, "submitted");
  assert.equal(app?.submission_status, "verified");
  assert.equal(app?.confirmation, "ATS-2026-9001");
  assert.equal(app?.confirmation_ref, "ATS-2026-9001");

  const attempt = db.one<{ status: string; reference: string | null; reconciliation_state: string }>(
    "SELECT status, reference, reconciliation_state FROM submission_attempts WHERE id = 'att_phase3_employer'",
  );
  assert.equal(attempt?.status, "verified");
  assert.equal(attempt?.reference, "ATS-2026-9001");
  assert.equal(attempt?.reconciliation_state, "confirmed");
  assert.equal(
    Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts")?.n),
    postsBefore,
    "reconciliation records evidence; it does not create another attempt",
  );
  assert.equal(queue.queueSnapshot().find((row) => row.jobId === jobId)?.state, "confirmed");
});

test("employer verification cannot be claimed without a reference", () => {
  const { applicationId, jobId } = insertApplication("app_phase3_noref", 3);
  insertAttempt({ id: "att_phase3_noref", applicationId, jobId, status: "unverified" });
  assert.throws(
    () => resolution.resolveUncertainSubmission({ applicationId, kind: "employer_reference", reference: "  " }),
    /requires a reference/i,
  );
  const app = db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [applicationId]);
  assert.equal(app?.status, "ready_to_submit");
});

test("a positive not-delivered finding re-arms the package without inventing a success", () => {
  const { applicationId, jobId } = insertApplication("app_phase3_notdelivered", 4);
  insertAttempt({
    id: "att_phase3_notdelivered",
    applicationId,
    jobId,
    status: "unverified",
    error: "firewall closed the connection before upload",
  });
  const result = resolution.resolveUncertainSubmission({
    applicationId,
    kind: "not_delivered",
    note: "Network capture shows the multipart upload never left the host.",
    observedAt: at,
    actor: "owner",
  });
  assert.equal(result.applied, true);
  assert.equal(result.state, "ready_for_submission");
  const app = db.one<{ status: string; submission_status: string | null; confirmation: string | null }>(
    "SELECT status, submission_status, confirmation FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.equal(app?.status, "ready_to_submit");
  assert.equal(app?.submission_status, null);
  assert.equal(app?.confirmation, null);
  const decision = reconciliation.reconciliationDecision({
    status: "blocked",
    httpStatus: null,
    reference: null,
    error: `Confirmed not delivered: Network capture shows the multipart upload never left the host.`,
    reconciliationState: "not_delivered",
  });
  assert.equal(decision.action, "send");
});

test("a package cannot be valid when its documents belong to another vacancy", () => {
  const { applicationId, jobId } = insertApplication("app_phase3_foreign_docs", 7);
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, url, application_url, description, discovered_at, status, dedupe_key)
     VALUES ('job_phase3_foreign', 'fixture', 'foreign', 'Other Role', 'Other AG', 'Zürich, Switzerland', 0,
       'https://example.test/foreign', 'https://example.test/foreign/apply', 'Other role.', ?, 'new', 'phase3-foreign')`,
    [at],
  );
  for (const [id, kind] of [
    ["doc_phase3_foreign_cv", "tailored_cv"],
    ["doc_phase3_foreign_cover", "cover_letter"],
  ] as const) {
    db.run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, status, quality_status, quality_score, created_at)
       VALUES (?, 'system', ?, ?, ?, 'application/pdf', ?, 120, 'job_phase3_foreign', 'ready', 'passed', 100, ?)`,
      [id, kind, id, `${id}.pdf`, `${id}.pdf`, at],
    );
  }
  db.run(
    "UPDATE applications SET cv_document_id = 'doc_phase3_foreign_cv', cover_letter_id = 'doc_phase3_foreign_cover' WHERE id = ?",
    [applicationId],
  );
  assert.equal(queue.validPackageFor(jobId), null, "foreign documents cannot authorise this vacancy's package");

  db.run(
    "UPDATE documents SET job_id = ? WHERE id IN ('doc_phase3_foreign_cv', 'doc_phase3_foreign_cover')",
    [jobId],
  );
  assert.ok(queue.validPackageFor(jobId), "the same documents become valid only when linked to the correct vacancy");
});

test("a database write failure at the claim sends nothing and leaves the package ready", async () => {
  const { applicationId, jobId } = insertApplication("app_phase3_dbfail", 6);
  const policy = await import("../lib/recruitment-policy.ts");
  policy.activateStandingAuthorisation("phase3-owner");
  const submission = await import("../lib/submission.ts");
  const job = db.one<{ id: string; title: string; company: string; url: string; application_url: string; description: string }>(
    "SELECT id, title, company, url, application_url, description FROM jobs WHERE id = ?",
    [jobId],
  );
  db.run(
    "CREATE TRIGGER phase3_claim_failure BEFORE INSERT ON submission_attempts BEGIN SELECT RAISE(ABORT, 'database temporarily unavailable'); END",
  );
  try {
    const outcome = await submission.submitApplication({
      applicationId,
      job: {
        id: job!.id,
        title: job!.title,
        company: job!.company,
        url: job!.url,
        application_url: job!.application_url,
        description: job!.description,
      },
      documents: {
        cvPath: null,
        cvName: null,
        coverPath: null,
        coverName: null,
        coverText: null,
        cvDocumentId: null,
        coverDocumentId: null,
      },
      profile: {
        full_name: "Ada Lovelace",
        email: "ada@example.com",
        phone: "+41 79 000 00 00",
        location: "Zürich, Switzerland",
        work_authorisation: "Swiss Permit B",
        headline: "Senior QA Automation Engineer",
        linkedin: null,
        website: null,
      },
    });
    assert.equal(outcome.status, "blocked");
    assert.match(outcome.detail, /could not be persisted|nothing was sent/i);
  } finally {
    db.run("DROP TRIGGER IF EXISTS phase3_claim_failure");
  }
  assert.equal(
    Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n),
    0,
    "a claim that could not be persisted leaves no attempt record",
  );
  const app = db.one<{ status: string; submitted_at: string | null }>("SELECT status, submitted_at FROM applications WHERE id = ?", [applicationId]);
  assert.equal(app?.status, "ready_to_submit");
  assert.equal(app?.submitted_at, null);
});

test("a stale in-flight claim recovers as unverified and is never counted as sent", async () => {
  const { applicationId, jobId } = insertApplication("app_phase3_stale", 5);
  db.run(
    `INSERT INTO submission_attempts
       (id, application_id, job_id, channel, endpoint, destination, status, evidence, reconciliation_state, attempted_at, started_at)
     VALUES ('att_phase3_stale', ?, ?, 'candidate_form', 'https://example.test/apply', 'https://example.test/apply',
       'submitting', '{"phase":"claimed"}', 'in_flight', ?, ?)`,
    [applicationId, jobId, "2026-11-27T08:00:00.000Z", "2026-11-27T08:00:00.000Z"],
  );
  db.run("UPDATE applications SET status = 'submitting', submission_status = 'submitting', submission_state = 'submitting' WHERE id = ?", [applicationId]);
  db.run("UPDATE recruitment_queue SET state = 'submitting', lease_owner = 'crashed-worker' WHERE job_id = ?", [jobId]);

  const recovered = (await import("../lib/submission.ts")).recoverStaleSubmissionClaims(NOW);
  assert.ok(recovered >= 1);
  const attempt = db.one<{ status: string; reconciliation_state: string }>(
    "SELECT status, reconciliation_state FROM submission_attempts WHERE id = 'att_phase3_stale'",
  );
  assert.equal(attempt?.status, "unverified");
  assert.equal(attempt?.reconciliation_state, "ambiguous");
  const app = db.one<{ status: string; confirmation: string | null }>(
    "SELECT status, confirmation FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.equal(app?.status, "submission_unverified");
  assert.equal(app?.confirmation, null);
  assert.equal(queue.queueSnapshot().find((row) => row.jobId === jobId)?.state, "submitted_unverified");
});
