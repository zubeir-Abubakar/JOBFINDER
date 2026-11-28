import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 regression coverage: persistent qualified queue, destination
 * preflight, bounded retries and the explicit submission lifecycle.
 *
 * No job board, employer, provider or browser is contacted. A fresh DATA_DIR is
 * used for each run of this file.
 */

const dataDir = mkdtempSync(join(tmpdir(), "atw-phase1-queue-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET_KEY = "phase1-persistent-queue-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;

const db = await import("../lib/db.ts");
const queue = await import("../lib/recruitment-queue.ts");
const { applyMigrations, migrationStatus } = await import("../lib/migrations.ts");

const NOW = new Date("2026-11-27T09:00:00.000Z");
const at = NOW.toISOString();

type JobOverrides = {
  id: string;
  score?: number;
  eligibility?: string;
  qualified?: number;
  applicationUrl?: string | null;
  urlConfidence?: string | null;
  description?: string | null;
  vacancyStatus?: string | null;
  expiryStatus?: string | null;
  expiryAt?: string | null;
  germanRequirement?: string | null;
  canonicalKey?: string | null;
};

let sequence = 0;
function insertJob(overrides: JobOverrides): string {
  sequence += 1;
  const id = overrides.id;
  db.run(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, url, description, discovered_at, status, match_score,
        eligibility, qualified, application_url, url_confidence, employer_url, vacancy_status, expiry_status,
        expiry_at, german_requirement, canonical_key)
     VALUES (?, 'fixture', ?, ?, 'Example AG', 'Zurich', ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      `ext-${sequence}`,
      `QA Engineer ${sequence}`,
      `https://www.jobs.ch/en/vacancies/detail/${sequence}`,
      overrides.description ?? "Playwright, API testing and test automation.",
      at,
      overrides.score ?? 92,
      overrides.eligibility ?? "eligible",
      overrides.qualified ?? 1,
      overrides.applicationUrl === undefined ? `https://careers.example.com/apply/${sequence}` : overrides.applicationUrl,
      overrides.urlConfidence === undefined ? "direct" : overrides.urlConfidence,
      null,
      overrides.vacancyStatus ?? "open",
      overrides.expiryStatus ?? null,
      overrides.expiryAt ?? null,
      overrides.germanRequirement ?? "none",
      overrides.canonicalKey ?? `example|qa-engineer-${sequence}`,
    ],
  );
  return id;
}

function insertApplication(input: {
  id: string;
  jobId: string;
  status?: string;
  submissionStatus?: string | null;
  submissionState?: string | null;
  evidence?: string | null;
  retryCount?: number;
  nextRetryAt?: string | null;
  blockSignature?: string | null;
  confirmation?: string | null;
}): void {
  db.run(
    `INSERT INTO applications (id, job_id, status, submission_status, submission_state, submission_evidence,
       retry_count, next_retry_at, block_signature, confirmation, last_update, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id,
      input.jobId,
      input.status ?? "ready_to_submit",
      input.submissionStatus ?? null,
      input.submissionState ?? null,
      input.evidence ?? null,
      input.retryCount ?? 0,
      input.nextRetryAt ?? null,
      input.blockSignature ?? null,
      input.confirmation ?? null,
      at,
      at,
    ],
  );
}

const queueRow = (jobId: string) =>
  db.one<{ state: string; reason: string | null; attempts: number; lease_owner: string | null }>(
    "SELECT state, reason, attempts, lease_owner FROM recruitment_queue WHERE job_id = ?",
    [jobId],
  );

const applicationRow = (id: string) =>
  db.one<{ status: string; submission_status: string | null; submission_state: string | null; retry_count: number }>(
    "SELECT status, submission_status, submission_state, retry_count FROM applications WHERE id = ?",
    [id],
  );

test("migration ledger is versioned, idempotent and backs up before schema changes", () => {
  const status = migrationStatus(db.getDb());
  assert.ok(status.version >= 1, "the Phase 1 migration is recorded");
  const backupDir = join(dataDir, "backups");
  assert.ok(existsSync(backupDir), "a backup directory exists");
  assert.ok(readdirSync(backupDir).some((name) => name.endsWith(".db")), "a pre-migration backup was written");
  const second = applyMigrations(db.getDb(), { dataDir, now: NOW });
  assert.deepEqual(second.applied, [], "a second invocation applies nothing");
});

test("a vacancy qualified on an earlier run is still claimed when today's discovery omits it", () => {
  const jobId = insertJob({ id: "job_standing_1", score: 94 });
  const sync = queue.syncQualifiedQueue({ runId: "run_old", now: NOW });
  assert.ok(sync.queued >= 1);
  assert.equal(queueRow(jobId)?.state, "ready_for_preparation");
  const claimed = queue.claimQueueWork({ runId: "run_today", limit: 50, now: NOW });
  assert.ok(claimed.some((item) => item.jobId === jobId), "the standing vacancy is workable without rediscovery");
});

test("a newly discovered qualified vacancy enters the persistent queue", () => {
  const jobId = insertJob({ id: "job_new_1", score: 88 });
  assert.equal(queueRow(jobId), null);
  queue.syncQualifiedQueue({ runId: "run_new", now: NOW });
  const row = queueRow(jobId);
  assert.equal(row?.state, "ready_for_preparation");
  assert.equal(row?.attempts, 0);
});

test("a vacancy below the 85% threshold cannot enter the qualified queue", () => {
  const jobId = insertJob({ id: "job_low_1", score: 71, qualified: 0 });
  queue.syncQualifiedQueue({ runId: "run_low", now: NOW });
  assert.equal(queueRow(jobId), null);
});

test("a German-required vacancy stays ineligible and is not queued", () => {
  const jobId = insertJob({
    id: "job_german_1",
    score: 96,
    eligibility: "ineligible",
    qualified: 0,
    germanRequirement: "required",
    description: "Sie sprechen fliessend Deutsch. QA Automation mit Playwright.",
  });
  queue.syncQualifiedQueue({ runId: "run_german", now: NOW });
  assert.equal(queueRow(jobId), null);
  const counts = queue.pipelineReconciliation(85).counts;
  assert.ok(counts.score_at_or_above_threshold >= 1);
  assert.ok(counts.eligibility_eligible < counts.discovered, "score and eligibility are counted separately");
});

test("an expired vacancy is closed in the queue and cannot be requeued", () => {
  const jobId = insertJob({
    id: "job_expired_1",
    score: 93,
    vacancyStatus: "expired",
    expiryStatus: "expired",
    expiryAt: "2026-11-01T00:00:00.000Z",
  });
  insertApplication({
    id: "app_expired_1",
    jobId,
    submissionStatus: "blocked",
    submissionState: "waiting_destination",
    evidence: JSON.stringify({ reason: "employer destination unresolved" }),
  });
  queue.syncQualifiedQueue({ runId: "run_expired", now: NOW });
  assert.equal(queueRow(jobId)?.state, "ineligible_closed");
  const result = queue.requeueBlockedApplications({ now: NOW });
  assert.ok(result.closed >= 1);
  assert.equal(applicationRow("app_expired_1")?.submission_state, "ineligible_closed");
  assert.equal(queueRow(jobId)?.state, "ineligible_closed");
});

test("an unresolved employer URL prevents preparation instead of generating documents", async () => {
  const jobId = insertJob({
    id: "job_unresolved_1",
    applicationUrl: null,
    urlConfidence: "unresolved",
  });
  const noEmail = async () => ({
    ok: false as const,
    email: null,
    employerSite: null,
    employerVacancyUrl: null,
    employerHost: null,
    reason: "No email was published.",
    evidence: {},
  });
  const preflight = await queue.preflightDestination(
    jobId,
    async () => ({
      requestedUrl: "https://www.jobs.ch/en/vacancies/detail/1",
      finalUrl: "https://www.jobs.ch/en/vacancies/detail/1",
      employerUrl: null,
      atsVendor: null,
      requisitionId: null,
      confidence: "unresolved",
      reason: "The board hosts the quick-apply form itself.",
      hops: 0,
      httpStatus: 200,
      method: "unresolved" as const,
    }),
    noEmail,
  );
  assert.equal(preflight.state, "waiting_destination");
  assert.match(preflight.reason, /not resolved|employer application URL|aggregator/i);
  assert.equal(queue.validPackageFor(jobId), null, "no package exists or is reused");
  assert.equal(queueRow(jobId)?.state, "waiting_destination");
});

test("preflight resolves a newly eligible vacancy to a verified employer email and hands it to the owner", async () => {
  const jobId = insertJob({
    id: "job_preflight_email_1",
    applicationUrl: null,
    urlConfidence: "unresolved",
  });
  queue.syncQualifiedQueue({ runId: "run_preflight_email", now: NOW });
  const preflight = await queue.preflightDestination(
    jobId,
    async () => ({
      requestedUrl: "https://www.jobs.ch/en/vacancies/detail/email-1",
      finalUrl: "https://www.jobs.ch/en/vacancies/detail/email-1",
      employerUrl: null,
      atsVendor: null,
      requisitionId: null,
      confidence: "unresolved" as const,
      reason: "The board hosts the quick-apply form itself.",
      hops: 0,
      httpStatus: 200,
      method: "unresolved" as const,
    }),
    async () => ({
      ok: true as const,
      email: "careers@preflight-employer.ch",
      employerSite: "https://preflight-employer.ch/",
      employerVacancyUrl: "https://preflight-employer.ch/jobs/qa",
      employerHost: "preflight-employer.ch",
      reason: "The employer's own page publishes the address.",
      evidence: { emailMethod: "joomla_hidden_mail" },
    }),
  );
  assert.equal(preflight.state, "awaiting_human");
  assert.equal(preflight.destination?.status, "email");
  assert.match(preflight.reason, /careers@preflight-employer\.ch/);
  assert.equal(queueRow(jobId)?.state, "awaiting_human");
  assert.equal(queue.validPackageFor(jobId), null, "no documents were generated for the email handoff");
  const job = db.one<{ application_email: string; url_confidence: string }>(
    "SELECT application_email, url_confidence FROM jobs WHERE id = ?",
    [jobId],
  );
  assert.equal(job?.application_email, "careers@preflight-employer.ch");
  assert.equal(job?.url_confidence, "email");
});

test("email resolution is attempted only after an ineligible vacancy becomes eligible again", async () => {
  const jobId = insertJob({
    id: "job_preflight_email_requalify_1",
    applicationUrl: null,
    urlConfidence: "unresolved",
    eligibility: "ineligible",
    qualified: 0,
  });
  let emailLookups = 0;
  const emailResolver = async () => {
    emailLookups += 1;
    return {
      ok: true as const,
      email: "jobs@requalified-employer.ch",
      employerSite: "https://requalified-employer.ch/",
      employerVacancyUrl: "https://requalified-employer.ch/jobs/qa",
      employerHost: "requalified-employer.ch",
      reason: "The employer page publishes the address.",
      evidence: {},
    };
  };
  const urlResolver = async () => ({
    requestedUrl: "https://www.jobs.ch/en/vacancies/detail/requalify-1",
    finalUrl: "https://www.jobs.ch/en/vacancies/detail/requalify-1",
    employerUrl: null,
    atsVendor: null,
    requisitionId: null,
    confidence: "unresolved" as const,
    reason: "The board hosts the quick-apply form itself.",
    hops: 0,
    httpStatus: 200,
    method: "unresolved" as const,
  });

  queue.syncQualifiedQueue({ runId: "run_requalify_before", now: NOW });
  const before = await queue.preflightDestination(jobId, urlResolver, emailResolver);
  assert.equal(before.state, "ineligible_closed");
  assert.equal(emailLookups, 0, "an ineligible vacancy must not trigger email resolution");

  db.run("UPDATE jobs SET eligibility = 'eligible', qualified = 1, match_score = 92 WHERE id = ?", [jobId]);
  queue.syncQualifiedQueue({ runId: "run_requalify_after", now: NOW });
  const after = await queue.preflightDestination(jobId, urlResolver, emailResolver);
  assert.equal(emailLookups, 1, "the requalified vacancy triggers exactly one bounded email lookup");
  assert.equal(after.state, "awaiting_human");
  assert.equal(after.destination?.status, "email");
  assert.equal(queueRow(jobId)?.state, "awaiting_human");
  assert.equal(
    db.one<{ application_email: string | null }>("SELECT application_email FROM jobs WHERE id = ?", [jobId])
      ?.application_email,
    "jobs@requalified-employer.ch",
  );
});

test("a newly resolved employer URL reactivates an eligible blocked vacancy", () => {
  const jobId = insertJob({
    id: "job_resolve_1",
    applicationUrl: null,
    urlConfidence: "unresolved",
  });
  insertApplication({
    id: "app_resolve_1",
    jobId,
    status: "human_intervention_required",
    submissionStatus: "blocked",
    submissionState: "waiting_destination",
    evidence: JSON.stringify({ reason: "employer application URL unresolved" }),
    blockSignature: "unresolved||unresolved|eligible|none|open",
  });
  db.run(
    "UPDATE jobs SET application_url = ?, url_confidence = 'direct' WHERE id = ?",
    ["https://careers.example.com/apply/resolved", jobId],
  );
  const result = queue.requeueBlockedApplications({ now: NOW, runId: "run_resolve" });
  assert.ok(result.requeued >= 1);
  const application = applicationRow("app_resolve_1");
  assert.equal(application?.submission_status, null);
  assert.equal(application?.submission_state, "ready_for_submission");
  assert.equal(application?.status, "ready_to_submit");
});

test("an aggregator URL is never treated as a verified employer destination", () => {
  const jobId = insertJob({
    id: "job_aggregator_1",
    applicationUrl: "https://www.jobs.ch/en/vacancies/detail/aggregator-1/",
    urlConfidence: "direct",
  });
  const assessment = queue.assessStoredDestination({
    application_url: "https://www.jobs.ch/en/vacancies/detail/aggregator-1/",
    url: "https://www.jobs.ch/en/vacancies/detail/aggregator-1/",
    url_confidence: "direct",
  });
  assert.equal(assessment.status, "aggregator");
  queue.syncQualifiedQueue({ runId: "run_aggregator", now: NOW });
  assert.equal(queueRow(jobId)?.state, "waiting_destination");
});

test("a transient technical block is retried within the bounded budget", () => {
  const jobId = insertJob({ id: "job_technical_1" });
  insertApplication({
    id: "app_technical_1",
    jobId,
    submissionStatus: "blocked",
    submissionState: "blocked_technical",
    evidence: JSON.stringify({ outcomeClass: "failed_technical", reason: "form timed out" }),
    retryCount: 0,
    nextRetryAt: null,
  });
  const result = queue.requeueBlockedApplications({ now: NOW });
  assert.ok(result.requeued >= 1);
  const application = applicationRow("app_technical_1");
  assert.equal(application?.submission_state, "ready_for_submission");
  assert.equal(application?.retry_count, 1);
  const again = queue.requeueBlockedApplications({ now: NOW });
  assert.equal(again.requeued, 0, "the same block is not requeued twice");
});

test("an ATS login URL is held for a human instead of being automated", async () => {
  const jobId = insertJob({
    id: "job_login_1",
    applicationUrl: "https://jsafrasarasin.umantis.com/Vacancies/553/Application/CheckLogin/2?lang=eng",
    urlConfidence: "direct",
  });
  queue.syncQualifiedQueue({ runId: "run_login", now: NOW });
  assert.equal(queueRow(jobId)?.state, "awaiting_human");
  const preflight = await queue.preflightDestination(jobId);
  assert.equal(preflight.state, "awaiting_human");
  assert.match(preflight.reason, /account login/i);
  assert.equal(queue.validPackageFor(jobId), null, "no documents are generated behind a login wall");
});

test("a CAPTCHA or employer security challenge stays blocked for human intervention", () => {
  const jobId = insertJob({
    id: "job_captcha_1",
    description: "Apply through our portal. This form is protected by reCAPTCHA.",
  });
  insertApplication({
    id: "app_captcha_1",
    jobId,
    status: "human_intervention_required",
    submissionStatus: "blocked",
    submissionState: "blocked_security",
    evidence: JSON.stringify({ externalRequirement: "security_challenge" }),
  });
  const result = queue.requeueBlockedApplications({ now: NOW });
  assert.equal(result.requeued, 0);
  assert.equal(applicationRow("app_captcha_1")?.submission_state, "blocked_security");
  assert.equal(applicationRow("app_captcha_1")?.submission_status, "blocked");
});

test("a submission lifecycle records security separately from a technical failure", () => {
  const securityJob = insertJob({ id: "job_lifecycle_security" });
  insertApplication({ id: "app_lifecycle_security", jobId: securityJob, submissionStatus: "blocked" });
  const securityState = queue.recordSubmissionLifecycle({
    applicationId: "app_lifecycle_security",
    jobId: securityJob,
    status: "blocked",
    outcomeClass: "blocked_external",
    detail: "The employer requires a security challenge.",
    externalRequirement: "security_challenge",
    now: NOW,
  });
  assert.equal(securityState, "blocked_security");

  const technicalJob = insertJob({ id: "job_lifecycle_technical" });
  insertApplication({ id: "app_lifecycle_technical", jobId: technicalJob, submissionStatus: "blocked" });
  const technicalState = queue.recordSubmissionLifecycle({
    applicationId: "app_lifecycle_technical",
    jobId: technicalJob,
    status: "failed",
    outcomeClass: "failed_technical",
    detail: "The local form runner crashed.",
    now: NOW,
  });
  assert.equal(technicalState, "blocked_technical");
  assert.equal(applicationRow("app_lifecycle_technical")?.submission_state, "blocked_technical");
});

test("two workers cannot claim the same application concurrently", () => {
  const jobId = insertJob({ id: "job_concurrent_1", canonicalKey: "concurrent|qa" });
  queue.syncQualifiedQueue({ runId: "run_concurrent", now: NOW });
  const first = queue.claimQueueWork({ runId: "worker_a", limit: 50, now: NOW });
  assert.ok(first.some((item) => item.jobId === jobId));
  const second = queue.claimQueueWork({ runId: "worker_b", limit: 50, now: NOW });
  assert.equal(second.some((item) => item.jobId === jobId), false);
  assert.equal(queueRow(jobId)?.lease_owner, "worker_a");
});

test("an expired worker lease lets a restarted worker recover the unfinished task", () => {
  const jobId = insertJob({ id: "job_restart_1", canonicalKey: "restart|qa" });
  queue.syncQualifiedQueue({ runId: "run_restart", now: NOW });
  const first = queue.claimQueueWork({ runId: "worker_crash", limit: 50, now: NOW });
  assert.ok(first.some((item) => item.jobId === jobId));
  db.run("UPDATE recruitment_queue SET lease_expires_at = ? WHERE job_id = ?", [
    "2026-11-27T08:00:00.000Z",
    jobId,
  ]);
  const recovered = queue.claimQueueWork({ runId: "worker_restart", limit: 50, now: NOW });
  assert.ok(recovered.some((item) => item.jobId === jobId), "the stale lease was reclaimed");
  assert.equal(queueRow(jobId)?.state, "preparing");

  const released = queue.releaseQueueLeases("worker_restart");
  assert.ok(released >= 1);
  assert.equal(queueRow(jobId)?.state, "ready_for_preparation", "an interrupted preparation returns to the queue");
});

test("a retry cannot create a second package or a second verified submission", () => {
  const jobId = insertJob({ id: "job_dup_1", canonicalKey: "duplicate|qa" });
  insertApplication({
    id: "app_dup_1",
    jobId,
    status: "submission_unverified",
    submissionStatus: "blocked",
    submissionState: "blocked_technical",
    evidence: JSON.stringify({ outcomeClass: "failed_technical" }),
  });
  db.run(
         "INSERT INTO submission_attempts (id, application_id, job_id, channel, status, reference, evidence, attempted_at) VALUES (?, ?, ?, 'candidate_form', 'verified', 'REF-1', 'verified', ?)",
    ["attempt_dup_1", "app_dup_1", jobId, at],
  );
  const before = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n;
  queue.requeueBlockedApplications({ now: NOW });
  assert.equal(queue.validPackageFor(jobId), null, "no documents were invented by the retry");
  const after = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n;
  assert.equal(after, before, "a retry does not create a submission attempt");
});

test("reconciliation distinguishes a high match score from an eligible vacancy", () => {
  db.run("DELETE FROM jobs");
  db.run("DELETE FROM recruitment_queue");
  insertJob({ id: "job_count_high_ineligible", score: 95, eligibility: "ineligible", qualified: 0 });
  insertJob({ id: "job_count_high_eligible", score: 90, eligibility: "eligible", qualified: 1 });
  insertJob({ id: "job_count_low_eligible", score: 60, eligibility: "eligible", qualified: 0 });
  const { counts, definitions } = queue.pipelineReconciliation(85);
  assert.equal(counts.discovered, 3);
  assert.equal(counts.score_at_or_above_threshold, 2, "score count includes ineligible jobs");
  assert.equal(counts.eligibility_eligible, 2);
  assert.equal(counts.qualified_pool, 1);
  assert.ok(definitions.qualified_pool.includes("qualified = 1"));
  assert.ok(definitions.score_at_or_above_threshold.includes("not an eligibility"));
});
