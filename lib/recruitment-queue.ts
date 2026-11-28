import { all, one, run } from "./db.ts";
import { canonicalUrl, isAggregatorUrl } from "./job-identity.ts";
import { resolveEmployerEmailDestination } from "./employer-contact.ts";
import { persistEmployerEmailDestination } from "./jobs-ch-resolution.ts";
import {
  blockerForChannel,
  ensureEmployerDestination,
  type SubmissionJob,
} from "./submission.ts";

/**
 * Persistent qualified-vacancy queue and explicit submission lifecycle.
 *
 * The daily run used to prepare and submit only vacancies returned by that
 * day's discovery. A vacancy qualified yesterday was invisible today, and a
 * blocked application had no state that could change. This module keeps the
 * backlog in the database, records why each vacancy is waiting, and only
 * requeues a blocked application when the blocking evidence itself changed.
 */

export const QUEUE_STATES = [
  "waiting_destination",
  "ready_for_preparation",
  "preparing",
  "package_ready",
  "ready_for_submission",
  "submitting",
  "submitted_unverified",
  "blocked_technical",
  "blocked_security",
  "awaiting_human",
  "submitted_reference",
  "sent_by_owner",
  "confirmed",
  "ineligible_closed",
] as const;

export type QueueState = (typeof QUEUE_STATES)[number];

const TERMINAL: ReadonlySet<QueueState> = new Set<QueueState>([
  "submitted_reference",
  "confirmed",
  "ineligible_closed",
]);

const WORKABLE: ReadonlySet<QueueState> = new Set<QueueState>([
  "ready_for_preparation",
  "package_ready",
  "ready_for_submission",
]);

export const MAX_TECHNICAL_RETRIES = 2;

type JobRow = {
  id: string;
  title: string;
  company: string;
  url: string | null;
  application_url: string | null;
  url_confidence: string | null;
  employer_url: string | null;
  description: string | null;
  application_email: string | null;
  source: string | null;
  external_id: string | null;
  german_requirement: string | null;
  match_score: number | null;
  eligibility: string | null;
  qualified: number;
  status: string;
  canonical_key: string | null;
  vacancy_status: string | null;
  expiry_status: string | null;
  expiry_at: string | null;
  document_state: string | null;
};

type ApplicationRow = {
  id: string;
  status: string;
  submission_status: string | null;
  submission_state: string | null;
  submission_evidence: string | null;
  cv_document_id: string | null;
  cover_letter_id: string | null;
  retry_count: number;
  next_retry_at: string | null;
  block_signature: string | null;
  confirmation: string | null;
};

type QueueRow = {
  job_id: string;
  state: QueueState;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  entered_at: string;
};

export type DestinationAssessment = {
  status: "verified" | "email" | "aggregator" | "unresolved" | "missing" | "unverified";
  confidence: string;
  url: string | null;
  reason: string;
};

/** Classification only: never contacts the employer and never invents a URL. */
export function assessStoredDestination(
  job: Pick<JobRow, "application_url" | "url" | "url_confidence"> & { application_email?: string | null },
): DestinationAssessment {
  if (job.application_email) {
    return {
      status: "email",
      confidence: "email",
      url: null,
      reason: `The employer accepts applications by email at ${job.application_email}; this is a human handoff, not a web form.`,
    };
  }
  const applicationUrl = canonicalUrl(job.application_url ?? null);
  if (applicationUrl && isAggregatorUrl(applicationUrl)) {
    return {
      status: "aggregator",
      confidence: "aggregator",
      url: null,
      reason: "The stored application URL is a job-board listing, not an employer destination.",
    };
  }
  if (!applicationUrl) {
    const confidence = job.url_confidence ?? "missing";
    if (confidence === "aggregator") {
      return { status: "aggregator", confidence, url: null, reason: "The listing links to an aggregator page." };
    }
    if (isAggregatorUrl(job.url ?? null)) {
      return {
        status: "unresolved",
        confidence: "unresolved",
        url: null,
        reason: "Only an aggregator listing is stored; the employer application URL is not resolved.",
      };
    }
    return {
      status: confidence === "unresolved" ? "unresolved" : "missing",
      confidence,
      url: null,
      reason: "No employer application URL is stored for this vacancy.",
    };
  }
  if (job.url_confidence === "unresolved" || job.url_confidence === "aggregator" || job.url_confidence === "missing") {
    return {
      status: "unverified",
      confidence: job.url_confidence,
      url: applicationUrl,
      reason: `Provenance marks the destination as ${job.url_confidence}; it is not accepted without verification.`,
    };
  }
  return { status: "verified", confidence: job.url_confidence ?? "unclassified", url: applicationUrl, reason: "Direct employer or supported ATS destination." };
}

function toSubmissionJob(job: JobRow): SubmissionJob {
  return {
    id: job.id,
    title: job.title,
    company: job.company,
    url: job.url,
    application_url: job.application_url,
    url_confidence: job.url_confidence,
    employer_url: job.employer_url,
    description: job.description,
    application_email: job.application_email,
    source: job.source,
    external_id: job.external_id,
    german_requirement: job.german_requirement,
  };
}

function isVacancyOpen(job: Pick<JobRow, "vacancy_status" | "expiry_status" | "expiry_at">, now: Date): boolean {
  const vacancy = (job.vacancy_status ?? "").toLowerCase();
  if (["expired", "closed", "withdrawn", "filled"].includes(vacancy)) return false;
  if ((job.expiry_status ?? "").toLowerCase() === "expired") return false;
  if (job.expiry_at && Number.isFinite(Date.parse(job.expiry_at)) && Date.parse(job.expiry_at) <= now.getTime()) return false;
  return true;
}

export function queueEvent(input: {
  jobId: string;
  from: string | null;
  to: string;
  reason: string | null;
  actor: string;
  at: Date;
}): void {
  run(
    "INSERT INTO recruitment_queue_events (job_id, from_state, to_state, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [input.jobId, input.from, input.to, input.reason, input.actor, input.at.toISOString()],
  );
}

function applicationFor(jobId: string): ApplicationRow | null {
  return one<ApplicationRow>(
    `SELECT id, status, submission_status, submission_state, submission_evidence, cv_document_id, cover_letter_id,
            COALESCE(retry_count, 0) AS retry_count, next_retry_at, block_signature, confirmation
     FROM applications WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
}

/** Both documents exist, are live, passed the quality gate and carry bytes. */
export function validPackageFor(jobId: string): { id: string; cvDocumentId: string; coverDocumentId: string } | null {
  const application = applicationFor(jobId);
  if (!application?.cv_document_id || !application.cover_letter_id) return null;
  const valid = one<{ n: number }>(
    `SELECT COUNT(*) AS n FROM documents
     WHERE id IN (?, ?) AND job_id = ? AND deleted_at IS NULL AND quality_status = 'passed' AND size_bytes > 0`,
    [application.cv_document_id, application.cover_letter_id, jobId],
  );
  if (Number(valid?.n ?? 0) !== 2) return null;
  return {
    id: application.id,
    cvDocumentId: application.cv_document_id,
    coverDocumentId: application.cover_letter_id,
  };
}

function deriveState(job: JobRow, application: ApplicationRow | null, now: Date): { state: QueueState; reason: string | null } {
  if (application?.submission_state === "submitted_reference" || application?.submission_state === "confirmed") {
    return { state: application.submission_state, reason: null };
  }
  if (application?.submission_state === "submitting" || application?.status === "submitting") {
    return { state: "submitting", reason: "Browser execution is in progress." };
  }
  if (application?.submission_state === "submitted_unverified") {
    return {
      state: "submitted_unverified",
      reason: "The employer may have received the application; reconciliation is required before any retry.",
    };
  }
  if (application?.submission_state === "sent_by_owner") {
    return { state: "sent_by_owner", reason: "The owner sent this application by email; employer confirmation is pending." };
  }
  if (application?.submission_state === "blocked_security") {
    return { state: "blocked_security", reason: "An employer security challenge requires the owner." };
  }
  if (application?.submission_state === "awaiting_human") {
    return { state: "awaiting_human", reason: "The application needs an answer or decision only the owner can give." };
  }
  if (!isVacancyOpen(job, now)) {
    return { state: "ineligible_closed", reason: "The vacancy is expired, closed or withdrawn." };
  }
  if (job.eligibility !== "eligible" || Number(job.qualified) !== 1) {
    return { state: "ineligible_closed", reason: "The vacancy no longer meets eligibility or the 85% threshold." };
  }
  const blocker = blockerForChannel(toSubmissionJob(job));
  if (blocker) {
    return { state: "awaiting_human", reason: blocker };
  }
  if (job.application_email) {
    return {
      state: "awaiting_human",
      reason: `The employer accepts applications by email at ${job.application_email}; the owner must send it.`,
    };
  }
  const destination = assessStoredDestination(job);
  if (destination.status !== "verified") {
    return { state: "waiting_destination", reason: destination.reason };
  }
  if (application?.submission_state === "blocked_technical") {
    return { state: "blocked_technical", reason: application.submission_evidence ? "A recoverable technical block is recorded." : null };
  }
  if (validPackageFor(job.id)) {
    const ready =
      application?.submission_state === "ready_for_submission" ||
      application?.status === "ready_to_submit" ||
      application?.status === "awaiting_approval";
    return ready
      ? { state: "ready_for_submission", reason: null }
      : { state: "package_ready", reason: "The package is created; the readiness gate has not marked it ready." };
  }
  return { state: "ready_for_preparation", reason: "Qualified and the employer destination is verified." };
}

/**
 * Reconciles the queue with the live jobs table. Idempotent: a state that has
 * not changed is left alone, and `entered_at` is preserved across runs.
 */
export function syncQualifiedQueue(input: { runId?: string | null; actor?: string; now?: Date } = {}): {
  queued: number;
  changed: number;
  byState: Record<string, number>;
} {
  const now = input.now ?? new Date();
  const actor = input.actor ?? input.runId ?? "run";
  const at = now.toISOString();
  const jobs = all<JobRow>(
         `SELECT id, title, company, url, application_url, url_confidence, employer_url, description, application_email,
            source, external_id, german_requirement, match_score, eligibility, qualified, status, canonical_key,
            vacancy_status, expiry_status, expiry_at, document_state
     FROM jobs WHERE qualified = 1 AND eligibility = 'eligible'
     ORDER BY match_score DESC NULLS LAST`,
  );
  const seen = new Set<string>();
  let changed = 0;
  for (const job of jobs) {
    seen.add(job.id);
    const application = applicationFor(job.id);
    const { state, reason } = deriveState(job, application, now);
    const destination = assessStoredDestination(job);
    const existing = one<QueueRow>(
      "SELECT job_id, state, attempts, lease_owner, lease_expires_at, entered_at FROM recruitment_queue WHERE job_id = ?",
      [job.id],
    );
    if (!existing) {
      run(
        `INSERT INTO recruitment_queue
           (job_id, canonical_key, origin_run_id, state, reason, destination_confidence, destination_url, attempts,
            entered_at, last_checked_at, next_check_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?)`,
        [job.id, job.canonical_key, input.runId ?? null, state, reason, destination.confidence, destination.url, at, at, at],
      );
      queueEvent({ jobId: job.id, from: null, to: state, reason, actor, at: now });
      changed += 1;
      continue;
    }
    // A live lease belongs to work in progress; do not overwrite its state.
    if (existing.lease_owner && existing.lease_expires_at && Date.parse(existing.lease_expires_at) > now.getTime()) continue;
    if (existing.state !== state || TERMINAL.has(existing.state)) {
      run(
        `UPDATE recruitment_queue SET state = ?, reason = ?, destination_confidence = ?, destination_url = ?,
           last_checked_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE job_id = ?`,
        [state, reason, destination.confidence, destination.url, at, at, job.id],
      );
      if (existing.state !== state) {
        queueEvent({ jobId: job.id, from: existing.state, to: state, reason, actor, at: now });
        changed += 1;
      }
    } else {
      run(
        "UPDATE recruitment_queue SET reason = COALESCE(?, reason), destination_confidence = ?, destination_url = ?, last_checked_at = ?, updated_at = ? WHERE job_id = ?",
        [reason, destination.confidence, destination.url, at, at, job.id],
      );
    }
  }
  // Vacancies that lost qualification or eligibility leave the active pool.
  for (const row of all<{ job_id: string; state: QueueState }>(
    "SELECT job_id, state FROM recruitment_queue WHERE state NOT IN ('submitted_reference','confirmed','ineligible_closed')",
  )) {
    if (seen.has(row.job_id)) continue;
    run("UPDATE recruitment_queue SET state = 'ineligible_closed', reason = ?, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE job_id = ?", [
      "The vacancy is no longer qualified, eligible or open.",
      at,
      row.job_id,
    ]);
    queueEvent({ jobId: row.job_id, from: row.state, to: "ineligible_closed", reason: "No longer qualified or open.", actor, at: now });
    changed += 1;
  }
  const byState: Record<string, number> = {};
  for (const row of all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM recruitment_queue GROUP BY state")) {
    byState[row.state] = Number(row.n);
  }
  return { queued: jobs.length, changed, byState };
}

export type QueueWorkItem = {
  jobId: string;
  score: number;
  state: QueueState;
  canonicalKey: string | null;
};

/**
 * Claims work with a lease. Two processes cannot claim the same row within the
 * lease window; an expired lease is reclaimable after a crash.
 */
export function claimQueueWork(input: { runId: string; limit: number; now?: Date; leaseMs?: number }): QueueWorkItem[] {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const leaseExpires = new Date(now.getTime() + (input.leaseMs ?? 30 * 60_000)).toISOString();
  const rows = all<QueueRow & { match_score: number | null; canonical_key: string | null; title: string }>(
    `SELECT q.job_id, q.state, q.attempts, q.lease_owner, q.lease_expires_at, q.entered_at, q.canonical_key,
            j.match_score, j.title
     FROM recruitment_queue q JOIN jobs j ON j.id = q.job_id
     WHERE q.state IN ('ready_for_preparation','package_ready','ready_for_submission','preparing')
       AND (q.lease_owner IS NULL OR q.lease_expires_at IS NULL OR q.lease_expires_at <= ?)
       AND j.qualified = 1 AND j.eligibility = 'eligible'
     ORDER BY j.match_score DESC NULLS LAST, q.entered_at
     LIMIT ?`,
    [at, Math.max(1, input.limit * 3)],
  );
  const seenCanonical = new Set<string>();
  const claimed: QueueWorkItem[] = [];
  for (const row of rows) {
    const canonical = row.canonical_key ?? row.job_id;
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);
    if (claimed.length >= input.limit) break;
    run(
      `UPDATE recruitment_queue SET lease_owner = ?, lease_expires_at = ?, last_checked_at = ?, updated_at = ?,
         state = CASE WHEN state = 'ready_for_preparation' THEN 'preparing' ELSE state END,
         attempts = attempts + CASE WHEN state = 'ready_for_preparation' THEN 1 ELSE 0 END
       WHERE job_id = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
      [input.runId, leaseExpires, at, at, row.job_id, at],
    );
    claimed.push({
      jobId: row.job_id,
      score: Number(row.match_score ?? 0),
      state: row.state === "ready_for_preparation" ? "preparing" : row.state,
      canonicalKey: row.canonical_key,
    });
  }
  return claimed;
}

export function finishQueueEntry(input: {
  jobId: string;
  state: QueueState;
  reason?: string | null;
  actor?: string;
  now?: Date;
  nextCheckAt?: string | null;
}): void {
  const now = input.now ?? new Date();
  const existing = one<{ state: QueueState }>("SELECT state FROM recruitment_queue WHERE job_id = ?", [input.jobId]);
  run(
    `UPDATE recruitment_queue SET state = ?, reason = ?, lease_owner = NULL, lease_expires_at = NULL,
       last_checked_at = ?, next_check_at = ?, updated_at = ? WHERE job_id = ?`,
    [input.state, input.reason ?? null, now.toISOString(), input.nextCheckAt ?? null, now.toISOString(), input.jobId],
  );
  if (existing?.state !== input.state) {
    queueEvent({
      jobId: input.jobId,
      from: existing?.state ?? null,
      to: input.state,
      reason: input.reason ?? null,
      actor: input.actor ?? "run",
      at: now,
    });
  }
}

/** Releases every lease held by a finished or crashed run. */
export function releaseQueueLeases(runId: string): number {
  const rows = all<{ job_id: string; state: QueueState }>(
    "SELECT job_id, state FROM recruitment_queue WHERE lease_owner = ?",
    [runId],
  );
  for (const row of rows) {
    const fallback: QueueState = row.state === "preparing" ? "ready_for_preparation" : row.state;
    run(
      "UPDATE recruitment_queue SET state = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE job_id = ?",
      [fallback, new Date().toISOString(), row.job_id],
    );
    if (fallback !== row.state) {
      queueEvent({
        jobId: row.job_id,
        from: row.state,
        to: fallback,
        reason: "The run ended before this work was completed; the lease was released.",
        actor: runId,
        at: new Date(),
      });
    }
  }
  return rows.length;
}

function blockerSignature(job: JobRow, destination: DestinationAssessment): string {
  return [
    destination.status,
    destination.url ?? "",
    job.url_confidence ?? "",
    job.eligibility ?? "",
    job.german_requirement ?? "",
    job.vacancy_status ?? "",
  ].join("|");
}

/**
 * Requeues a blocked application only when the evidence behind the block has
 * changed and the vacancy is still eligible. Security challenges are never
 * retried automatically; an expired or newly ineligible vacancy is closed.
 */
export function requeueBlockedApplications(input: { now?: Date; runId?: string | null } = {}): {
  inspected: number;
  requeued: number;
  held: number;
  closed: number;
} {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const rows = all<{
    application_id: string;
    job_id: string;
    status: string;
    submission_status: string | null;
    submission_state: string | null;
    submission_evidence: string | null;
    retry_count: number;
    next_retry_at: string | null;
    block_signature: string | null;
    confirmation: string | null;
    title: string;
    company: string;
    url: string | null;
    application_url: string | null;
    url_confidence: string | null;
    employer_url: string | null;
    description: string | null;
    application_email: string | null;
    source: string | null;
    external_id: string | null;
    german_requirement: string | null;
    match_score: number | null;
    eligibility: string | null;
    qualified: number;
    vacancy_status: string | null;
    expiry_status: string | null;
    expiry_at: string | null;
  }>(
    `SELECT a.id AS application_id, a.job_id, a.status, a.submission_status, a.submission_state, a.submission_evidence,
            COALESCE(a.retry_count, 0) AS retry_count, a.next_retry_at, a.block_signature, a.confirmation,
            j.title, j.company, j.url, j.application_url, j.url_confidence, j.employer_url, j.description,
            j.application_email, j.source, j.external_id, j.german_requirement, j.match_score, j.eligibility, j.qualified,
            j.vacancy_status, j.expiry_status, j.expiry_at
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.submission_status = 'blocked' OR a.submission_state IN ('waiting_destination','blocked_technical')
     ORDER BY j.match_score DESC NULLS LAST`,
  );
  let requeued = 0;
  let held = 0;
  let closed = 0;
  for (const row of rows) {
    const job: JobRow = {
      id: row.job_id,
      title: row.title,
      company: row.company,
      url: row.url,
      application_url: row.application_url,
      url_confidence: row.url_confidence,
      employer_url: row.employer_url,
      description: row.description,
      application_email: row.application_email,
      source: row.source,
      external_id: row.external_id,
      german_requirement: row.german_requirement,
      match_score: row.match_score,
      eligibility: row.eligibility,
      qualified: row.qualified,
      status: row.status,
      canonical_key: null,
      vacancy_status: row.vacancy_status,
      expiry_status: row.expiry_status,
      expiry_at: row.expiry_at,
      document_state: null,
    };
    const destination = assessStoredDestination(job);
    const signature = blockerSignature(job, destination);
    const evidence = row.submission_evidence ?? "";
    const security =
      row.submission_state === "blocked_security" ||
      /security_challenge|captcha|multi[- ]factor|account login/i.test(evidence);
    if (security) {
      run(
        "UPDATE applications SET submission_state = 'blocked_security', blocked_at = COALESCE(blocked_at, ?), last_block_reason = COALESCE(last_block_reason, ?), block_signature = ?, last_update = ? WHERE id = ?",
        [at, "Employer security challenge retained for human intervention.", signature, at, row.application_id],
      );
      held += 1;
      continue;
    }
    if (!isVacancyOpen(job, now) || job.eligibility !== "eligible" || Number(job.qualified) !== 1) {
      run(
        "UPDATE applications SET submission_state = 'ineligible_closed', last_block_reason = ?, last_update = ? WHERE id = ?",
        ["The vacancy is no longer open, eligible or above the 85% threshold.", at, row.application_id],
      );
      finishQueueEntry({ jobId: row.job_id, state: "ineligible_closed", reason: "No longer removable by retry.", actor: input.runId ?? "retry", now });
      closed += 1;
      continue;
    }
    if (destination.status === "email") {
      // A verified email channel is a human handoff. It must not be retried as
      // if it were a broken web form.
      run(
        "UPDATE applications SET submission_state = 'awaiting_human', last_block_reason = ?, block_signature = ?, last_update = ? WHERE id = ?",
        [destination.reason, signature, at, row.application_id],
      );
      finishQueueEntry({ jobId: row.job_id, state: "awaiting_human", reason: destination.reason, actor: input.runId ?? "retry", now });
      held += 1;
      continue;
    }
    const conditionChanged = row.block_signature === null || row.block_signature !== signature;
    const destinationNowValid = destination.status === "verified";
    const technical = row.submission_state === "blocked_technical" || (!row.submission_state && !/unresolved|aggregator|No application URL/i.test(evidence));
    const backoffReady = !row.next_retry_at || Date.parse(row.next_retry_at) <= now.getTime();
    const retryBudget = row.retry_count < MAX_TECHNICAL_RETRIES;
    // A blocked rows whose destination is still unresolved is not a technical
    // failure of the form runner: it belongs in the visible destination queue.
    if (!destinationNowValid && (row.submission_state === "waiting_destination" || technical)) {
      run(
        "UPDATE applications SET submission_state = 'waiting_destination', block_signature = ?, last_block_reason = ?, last_update = ? WHERE id = ?",
        [signature, destination.reason, at, row.application_id],
      );
      finishQueueEntry({ jobId: row.job_id, state: "waiting_destination", reason: destination.reason, actor: input.runId ?? "retry", now });
      held += 1;
      continue;
    }
    const retryable = destinationNowValid && retryBudget && backoffReady && (conditionChanged || technical);
    if (!retryable) {
      held += 1;
      continue;
    }
    const retryCount = row.retry_count + 1;
    const nextRetry = new Date(now.getTime() + Math.min(24 * 60, 15 * 2 ** retryCount) * 60_000).toISOString();
    run(
      `UPDATE applications SET status = 'ready_to_submit', submission_status = NULL, submission_state = 'ready_for_submission',
         block_signature = ?, retry_count = ?, last_retry_at = ?, next_retry_at = ?, last_update = ?
       WHERE id = ?`,
      [signature, retryCount, at, nextRetry, at, row.application_id],
    );
    queueEvent({
      jobId: row.job_id,
      from: "blocked",
      to: "ready_for_submission",
      reason: conditionChanged
        ? "The blocking evidence changed (employer destination or vacancy evidence)."
        : "A bounded technical retry is due.",
      actor: input.runId ?? "retry",
      at: now,
    });
    finishQueueEntry({ jobId: row.job_id, state: "ready_for_submission", reason: "Requeued after the blocking evidence changed.", actor: input.runId ?? "retry", now });
    requeued += 1;
  }
  return { inspected: rows.length, requeued, held, closed };
}

export type SubmissionLifecycleInput = {
  applicationId: string;
  jobId: string;
  status: "verified" | "unverified" | "failed" | "blocked";
  outcomeClass: string;
  detail: string;
  externalRequirement?: string | null;
  now?: Date;
};

/** Records the explicit lifecycle state next to the legacy status. */
export function recordSubmissionLifecycle(input: SubmissionLifecycleInput): QueueState {
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const application = one<{ retry_count: number; confirmation: string | null }>(
    "SELECT COALESCE(retry_count, 0) AS retry_count, confirmation FROM applications WHERE id = ?",
    [input.applicationId],
  );
  const security = /security_challenge|captcha|multi[- ]factor|account_login/i.test(
    `${input.externalRequirement ?? ""} ${input.detail}`,
  );
  let state: QueueState;
  if (input.status === "verified") {
    state = application?.confirmation ? "confirmed" : "submitted_reference";
  } else if (input.status === "unverified") {
    state = "submitted_unverified";
  } else if (security) {
    state = "blocked_security";
  } else if (/unresolved|aggregator|No application URL|employer destination/i.test(input.detail)) {
    state = "waiting_destination";
  } else if (input.outcomeClass === "failed_technical") {
    state = "blocked_technical";
  } else if (input.outcomeClass === "blocked_external") {
    state = "awaiting_human";
  } else {
    state = "awaiting_human";
  }

  const retryIncrement = state === "blocked_technical" ? 1 : 0;
  const retryCount = Number(application?.retry_count ?? 0) + retryIncrement;
  const nextRetry =
    state === "blocked_technical"
      ? new Date(now.getTime() + Math.min(24 * 60, 15 * 2 ** retryCount) * 60_000).toISOString()
      : null;

  let queue = one<{ state: QueueState }>("SELECT state FROM recruitment_queue WHERE job_id = ?", [input.jobId]);
  if (!queue) {
    const job = one<JobRow>(
      `SELECT id, title, company, url, application_url, url_confidence, employer_url, description, application_email,
              source, external_id, german_requirement, match_score, eligibility, qualified, status, canonical_key,
              vacancy_status, expiry_status, expiry_at, document_state
       FROM jobs WHERE id = ?`,
      [input.jobId],
    );
    if (job) {
      syncQualifiedQueue({ actor: "submission", now });
      queue = one<{ state: QueueState }>("SELECT state FROM recruitment_queue WHERE job_id = ?", [input.jobId]);
    }
  }

  run(
    `UPDATE applications SET submission_state = ?, blocked_at = ?, last_block_reason = ?,
       retry_count = ?, next_retry_at = ?, last_update = ? WHERE id = ?`,
    [
      state,
      state === "blocked_security" || state === "blocked_technical" || state === "waiting_destination" ? at : null,
      state === "blocked_security" || state === "blocked_technical" || state === "waiting_destination" ? input.detail.slice(0, 2000) : null,
      retryCount,
      nextRetry,
      at,
      input.applicationId,
    ],
  );

  if (queue && queue.state !== state) {
    run(
      "UPDATE recruitment_queue SET state = ?, reason = ?, lease_owner = NULL, lease_expires_at = NULL, last_checked_at = ?, updated_at = ? WHERE job_id = ?",
      [state, input.detail.slice(0, 500), at, at, input.jobId],
    );
    queueEvent({ jobId: input.jobId, from: queue.state, to: state, reason: input.detail.slice(0, 500), actor: "submission", at: now });
  }
  return state;
}

/**
 * Runs the bounded destination check before any document is generated.
 * Persists the outcome, including a failure, so the vacancy is visibly waiting
 * rather than silently consuming generation work.
 */
export async function preflightDestination(
  jobId: string,
  resolver?: Parameters<typeof ensureEmployerDestination>[1],
  emailResolver: typeof resolveEmployerEmailDestination = resolveEmployerEmailDestination,
): Promise<{ state: QueueState; reason: string; job: JobRow | null; destination: DestinationAssessment | null }> {
  const job = one<JobRow>(
    `SELECT id, title, company, url, application_url, url_confidence, employer_url, description, source, external_id,
            german_requirement, match_score, eligibility, qualified, status, canonical_key, vacancy_status,
            expiry_status, expiry_at, document_state
     FROM jobs WHERE id = ?`,
    [jobId],
  );
  if (!job) {
    return { state: "ineligible_closed", reason: "The vacancy no longer exists.", job: null, destination: null };
  }
  // A preflight can be the first touch after an upgrade; make the queue row
  // visible before its outcome is recorded.
  if (!one<{ x: number }>("SELECT 1 AS x FROM recruitment_queue WHERE job_id = ?", [jobId])) {
    const at = new Date().toISOString();
    run(
      `INSERT OR IGNORE INTO recruitment_queue
         (job_id, canonical_key, state, reason, attempts, entered_at, last_checked_at, updated_at)
       SELECT id, canonical_key, 'ready_for_preparation', NULL, 0, ?, ?, ? FROM jobs WHERE id = ?`,
      [at, at, at, jobId],
    );
  }
  if (job.eligibility !== "eligible" || Number(job.qualified) !== 1) {
    finishQueueEntry({ jobId, state: "ineligible_closed", reason: "Not eligible or below the 85% threshold.", actor: "preflight" });
    return { state: "ineligible_closed", reason: "Not eligible or below the 85% threshold.", job, destination: null };
  }
  const blocker = blockerForChannel(toSubmissionJob(job));
  if (blocker) {
    finishQueueEntry({ jobId, state: "awaiting_human", reason: blocker, actor: "preflight" });
    return { state: "awaiting_human", reason: blocker, job, destination: null };
  }
  if (job.application_email) {
    const reason = `The employer accepts applications by email at ${job.application_email}; the owner must send it.`;
    finishQueueEntry({ jobId, state: "awaiting_human", reason, actor: "preflight" });
    return { state: "awaiting_human", reason, job, destination: assessStoredDestination(job) };
  }
  let destination = assessStoredDestination(job);
  if (destination.status !== "verified") {
    try {
      const submissionJob = toSubmissionJob(job);
      await ensureEmployerDestination(submissionJob, resolver);
      job.application_url = submissionJob.application_url;
      job.url_confidence = submissionJob.url_confidence ?? job.url_confidence;
      destination = assessStoredDestination(job);
      run(
        "UPDATE recruitment_queue SET destination_confidence = ?, destination_url = ?, last_checked_at = ?, updated_at = ? WHERE job_id = ?",
        [destination.confidence, destination.url, new Date().toISOString(), new Date().toISOString(), jobId],
      );
    } catch {
      destination = {
        status: "unresolved",
        confidence: job.url_confidence ?? "unresolved",
        url: null,
        reason: "Employer destination resolution failed; the vacancy stays visibly unresolved.",
      };
    }
  }
  // No web form was found. Some employers publish an email application
  // address instead. This runs only for an eligible, qualified vacancy at
  // preflight time (before any document work), is bounded, and persists the
  // verified address as a human handoff. It never sends mail.
  if (destination.status !== "verified" && !job.application_email && job.url) {
    try {
      const email = await emailResolver({
        listingUrl: job.url,
        title: job.title,
        company: job.company,
      });
      if (email.ok && email.email) {
        persistEmployerEmailDestination(jobId, {
          email: email.email,
          employerVacancyUrl: email.employerVacancyUrl,
          employerSite: email.employerSite,
          reason: email.reason,
          evidence: email.evidence,
        });
        job.application_email = email.email;
        destination = assessStoredDestination(job);
      }
    } catch {
      // A failed email lookup must not fail the run; the vacancy stays visibly
      // unresolved and can be retried when it is next eligible.
    }
  }

  if (destination.status === "verified") {
    const application = applicationFor(jobId);
    const packageReady = validPackageFor(jobId);
    const state: QueueState = packageReady
      ? application?.submission_state === "ready_for_submission" || application?.status === "ready_to_submit"
        ? "ready_for_submission"
        : "package_ready"
      : "ready_for_preparation";
    finishQueueEntry({ jobId, state, reason: null, actor: "preflight" });
    return { state, reason: destination.reason, job, destination };
  }
  if (destination.status === "email") {
    const reason = `The employer accepts applications by email at ${job.application_email}; the owner must send it.`;
    finishQueueEntry({ jobId, state: "awaiting_human", reason, actor: "preflight" });
    return { state: "awaiting_human", reason, job, destination };
  }
  finishQueueEntry({ jobId, state: "waiting_destination", reason: destination.reason, actor: "preflight" });
  return { state: "waiting_destination", reason: destination.reason, job, destination };
}

/** Counts used by reporting and the dashboard, each with a SQL definition. */
export function pipelineReconciliation(threshold = 85): {
  counts: Record<string, number>;
  definitions: Record<string, string>;
} {
  const scalar = (sql: string, params: unknown[] = []): number => Number(one<{ n: number }>(sql, params)?.n ?? 0);
  const counts: Record<string, number> = {
    discovered: scalar("SELECT COUNT(*) AS n FROM jobs"),
    score_at_or_above_threshold: scalar("SELECT COUNT(*) AS n FROM jobs WHERE match_score >= ?", [threshold]),
    eligibility_eligible: scalar("SELECT COUNT(*) AS n FROM jobs WHERE eligibility = 'eligible'"),
    qualified_pool: scalar("SELECT COUNT(*) AS n FROM jobs WHERE qualified = 1 AND eligibility = 'eligible'"),
    verified_destination: scalar(
      "SELECT COUNT(*) AS n FROM jobs WHERE qualified = 1 AND eligibility = 'eligible' AND application_url IS NOT NULL AND url_confidence IN ('direct','ats') AND application_url NOT LIKE '%jobs.ch%'",
    ),
    awaiting_destination: scalar(
      "SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'waiting_destination'",
    ),
    email_destination: scalar(
      "SELECT COUNT(*) AS n FROM jobs WHERE qualified = 1 AND eligibility = 'eligible' AND application_email IS NOT NULL",
    ),
    ready_for_preparation: scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state IN ('ready_for_preparation','preparing')"),
    packages_quality_validated: scalar(
      "SELECT COUNT(*) AS n FROM applications a WHERE a.cv_document_id IS NOT NULL AND a.cover_letter_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id IN (a.cv_document_id, a.cover_letter_id) AND (d.deleted_at IS NOT NULL OR d.quality_status <> 'passed'))",
    ),
    ready_for_submission: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_state = 'ready_for_submission' OR status = 'ready_to_submit'"),
    browser_execution_in_progress: scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'submitting'"),
    submitted_unverified: scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'submitted_unverified'"),
    blocked_technical: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_state = 'blocked_technical'"),
    blocked_security: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_state = 'blocked_security'"),
    awaiting_human: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_state = 'awaiting_human' OR status = 'human_intervention_required'"),
    sent_by_owner: scalar("SELECT COUNT(*) AS n FROM applications WHERE email_handoff_sent_at IS NOT NULL"),
    submitted_verified: scalar("SELECT COUNT(*) AS n FROM submission_attempts WHERE status = 'verified'"),
    employer_confirmed: scalar("SELECT COUNT(*) AS n FROM applications WHERE submission_status = 'verified' AND confirmation IS NOT NULL"),
    queue_ineligible_closed: scalar("SELECT COUNT(*) AS n FROM recruitment_queue WHERE state = 'ineligible_closed'"),
  };
  const definitions: Record<string, string> = {
    discovered: "jobs rows stored by discovery (all statuses).",
    score_at_or_above_threshold: "jobs.match_score >= 85; a match score is not an eligibility decision.",
    eligibility_eligible: "jobs.eligibility = 'eligible'.",
    qualified_pool: "jobs.qualified = 1 AND eligibility = 'eligible' (the automatic pipeline pool).",
    verified_destination: "qualified jobs with a direct/ATS application_url that is not a jobs.ch listing.",
    awaiting_destination: "recruitment_queue.state = 'waiting_destination'.",
    email_destination: "qualified jobs with a verified employer email application channel (human handoff, never auto-sent).",
    ready_for_preparation: "queue entries in ready_for_preparation or preparing.",
    packages_quality_validated: "applications with both documents linked and no deleted or failed document.",
    ready_for_submission: "applications whose lifecycle state is ready_for_submission or legacy status ready_to_submit.",
    browser_execution_in_progress: "queue entries whose atomic send claim is active; a browser may be executing.",
    submitted_unverified: "queue entries whose send outcome is unknown and must be reconciled before retry.",
    blocked_technical: "applications with submission_state = 'blocked_technical'.",
    blocked_security: "applications with submission_state = 'blocked_security'.",
    awaiting_human: "applications with submission_state = 'awaiting_human' or legacy human_intervention_required.",
    sent_by_owner: "applications with an owner email-send receipt (attestation, not employer confirmation).",
    submitted_verified: "submission_attempts.status = 'verified' (employer reference recorded).",
    employer_confirmed: "applications with submission_status verified and a stored confirmation.",
    queue_ineligible_closed: "queue entries closed because they are expired, no longer eligible or no longer qualified.",
  };
  return { counts, definitions };
}

/** Human-readable state of every queued vacancy (used by reports). */
export function queueSnapshot(limit = 20): Array<{
  jobId: string;
  title: string;
  company: string;
  score: number | null;
  state: QueueState;
  reason: string | null;
  lastCheckedAt: string;
  attempts: number;
}> {
  return all<{
    job_id: string;
    title: string;
    company: string;
    match_score: number | null;
    state: QueueState;
    reason: string | null;
    last_checked_at: string;
    attempts: number;
  }>(
    `SELECT q.job_id, j.title, j.company, j.match_score, q.state, q.reason, q.last_checked_at, q.attempts
     FROM recruitment_queue q JOIN jobs j ON j.id = q.job_id
     ORDER BY CASE q.state
       WHEN 'ready_for_submission' THEN 0 WHEN 'package_ready' THEN 1 WHEN 'ready_for_preparation' THEN 2
       WHEN 'preparing' THEN 3 WHEN 'waiting_destination' THEN 4 WHEN 'blocked_security' THEN 5
       WHEN 'awaiting_human' THEN 6 WHEN 'blocked_technical' THEN 7 ELSE 8 END,
       j.match_score DESC NULLS LAST LIMIT ?`,
    [limit],
  ).map((row) => ({
    jobId: row.job_id,
    title: row.title,
    company: row.company,
    score: row.match_score,
    state: row.state,
    reason: row.reason,
    lastCheckedAt: row.last_checked_at,
    attempts: Number(row.attempts ?? 0),
  }));
}
