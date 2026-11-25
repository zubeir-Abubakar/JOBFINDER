import { readFileSync } from "node:fs";
import path from "node:path";
import { all, getDb, nowIso, one, run, UPLOAD_DIR } from "./db";
import { randomId } from "./security";
import { audit } from "./audit";
import { recordApplicationEvent } from "./application-events";
import { atsCredential, atsTargetFor, submitViaAts } from "./submission-ats";
import { reconciliationDecision } from "./submission-reconciliation";
import { prepareCandidateForm, submitCandidateForm, type CandidateDocuments, type CandidateFormResult, type CandidateProfile } from "./candidate-forms";
import { runBrowserCandidateForm } from "./browser-form";
import { authorisedAnswers, dailySubmissionUsage, getRecruitmentPolicy } from "./recruitment-policy";
import { readinessAllowsSubmission } from "./application-status";
import {
  analyseVacancyGermanRequirement,
  germanRequirementBlocksSubmission,
  GERMAN_REQUIREMENT_UNRESOLVED,
  MANDATORY_GERMAN_REQUIREMENT,
  type GermanRequirementAssessment,
} from "./language-requirements";
import { getSetting } from "./settings";
import { notify } from "./notify";
import { assertPublicHttpUrl } from "./outbound-url";
import { readLimitedText, safeFetch } from "./safe-http";

const outboundTransport = (url: string, init: RequestInit = {}) =>
  process.env.NODE_ENV === "production" || process.env.ATW_SAFE_OUTBOUND === "true"
    ? safeFetch(url, init)
    : fetch(url, init);

/**
 * Application submission with evidence.
 *
 * Two rules shape this module:
 *
 * 1. A submission is only "verified" when the employer's endpoint returned a
 *    success response *and* a reference we can store. A 200 with no reference is
 *    recorded as unverified, never as submitted.
 * 2. A channel that needs a login, CAPTCHA, MFA or payment is never automated.
 *    The application is queued for human intervention instead.
 *
 * The transport is an explicitly configured HTTP form endpoint
 * (`RECRUITMENT_SUBMISSION_ENDPOINT`, with `{job_id}`, `{application_url}` and
 * `{company}` placeholders). Nothing is posted to an arbitrary employer portal
 * that has not published a form endpoint.
 */

export type SubmissionChannel = "http_form" | "candidate_form" | "greenhouse" | "lever" | "ashby" | "manual";
export type SubmissionStatus = "verified" | "unverified" | "failed" | "blocked";

export type SubmissionOutcome = {
  status: SubmissionStatus;
  channel: SubmissionChannel;
  detail: string;
  httpStatus: number | null;
  reference: string | null;
  endpoint: string | null;
  evidence: Record<string, unknown> | null;
};

/**
 * The five operating states the owner must be able to tell apart. These are
 * stored in `submission_evidence.outcomeClass` next to the legacy application
 * status, so a technical failure is never presented as a routine approval.
 */
export type SubmissionOutcomeClass =
  | "submitted_verified"
  | "prepared_not_submitted"
  | "blocked_external"
  | "failed_technical"
  | "outcome_uncertain";

export function submissionOutcomeClass(
  outcome: Pick<SubmissionOutcome, "status" | "httpStatus" | "evidence">,
): SubmissionOutcomeClass {
  if (outcome.status === "verified") return "submitted_verified";
  if (outcome.status === "unverified") return "outcome_uncertain";
  if (outcome.status === "failed") {
    const ambiguous =
      outcome.httpStatus === 408 ||
      outcome.httpStatus === 429 ||
      (outcome.httpStatus !== null && outcome.httpStatus >= 500);
    return ambiguous ? "outcome_uncertain" : "failed_technical";
  }
  const declared = outcome.evidence?.outcomeClass;
  if (
    declared === "submitted_verified" ||
    declared === "prepared_not_submitted" ||
    declared === "blocked_external" ||
    declared === "failed_technical" ||
    declared === "outcome_uncertain"
  ) {
    return declared;
  }
  return outcome.evidence?.externalRequirement ? "blocked_external" : "prepared_not_submitted";
}

export type SubmissionJob = {
  id: string;
  title: string;
  company: string;
  url: string | null;
  application_url: string | null;
  /** Provenance recorded by discovery: direct, ats, aggregator, unresolved. */
  url_confidence?: string | null;
  employer_url?: string | null;
  description: string | null;
  /** ATS identity when the vacancy came from a supported connector. */
  source?: string | null;
  external_id?: string | null;
  /** Persisted discovery evidence for the hard German exclusion. */
  german_requirement?: string | null;
};

export type SubmissionDocuments = {
  cvPath: string | null;
  cvName: string | null;
  coverPath: string | null;
  coverName: string | null;
  coverText: string | null;
  coverDocumentId: string | null;
  cvDocumentId: string | null;
};

export type SubmissionInput = {
  applicationId: string;
  job: SubmissionJob;
  documents: SubmissionDocuments;
  runId?: string | null;
  profile: {
    full_name: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
    work_authorisation: string | null;
    headline: string | null;
    linkedin: string | null;
    website: string | null;
    summary?: string | null;
    skills?: string[];
    spokenLanguages?: string[];
    experienceText?: string | null;
    educationText?: string | null;
  };
  /** Values the owner has explicitly authorised for consequential questions. */
  authorisedAnswers?: Record<string, string>;
  now?: Date;
};

export function submissionEndpointConfigured(): string | null {
  const value = process.env.RECRUITMENT_SUBMISSION_ENDPOINT?.trim();
  return value ? value : null;
}

export function submissionEnabled(): boolean {
  return process.env.RECRUITMENT_SUBMISSION_ENABLED !== "false";
}

/**
 * Final safety gate. A dry run must stop before the atomic claim and before any
 * network call, even when an operator accidentally reactivates the policy.
 */
export function submissionDryRun(): boolean {
  return process.env.RECRUITMENT_DRY_RUN === "true" || getSetting<boolean>("recruitment_dry_run", false) === true;
}

/** Candidate-facing forms are on unless explicitly disabled. Activation is enforced separately. */
export function candidateFormsEnabled(): boolean {
  return process.env.RECRUITMENT_CANDIDATE_FORMS !== "false";
}

/** The local Playwright executor handles dynamic forms unless explicitly disabled. */
export function browserFormsEnabled(): boolean {
  return candidateFormsEnabled() && process.env.RECRUITMENT_BROWSER_FORMS !== "false";
}

import { canonicalUrl, isAggregatorUrl } from "./job-identity";

export function endpointFor(job: SubmissionJob): string | null {
  const template = submissionEndpointConfigured();
  if (!template) return null;
  return template
    .replace(/\{job_id\}/g, encodeURIComponent(job.id))
    .replace(/\{application_url\}/g, encodeURIComponent(job.application_url ?? job.url ?? ""))
    .replace(/\{company\}/g, encodeURIComponent(job.company));
}

/**
 * The application destination must be an employer-controlled page.
 *
 * A board listing is a discovery source, not an application endpoint: posting
 * an application to an aggregator is neither a real application nor evidence
 * that the employer received anything. Until the employer URL is resolved the
 * vacancy stays queued for a human, and it is never counted as submitted.
 */
export function applicationProvenanceBlocker(job: SubmissionJob): string | null {
  const application = canonicalUrl(job.application_url);
  if (application && isAggregatorUrl(application)) {
    return "The stored application URL is an aggregator page; it is not the employer's application endpoint.";
  }
  if (!application) {
    const confidence = job.url_confidence ?? null;
    if (confidence === "aggregator" || confidence === "unresolved" || confidence === "missing") {
      return `The employer application URL is ${confidence}; the listing URL is not submitted as an application.`;
    }
    if (isAggregatorUrl(job.url)) {
      return "Only an aggregator listing is recorded; the employer application URL has not been resolved.";
    }
  }
  return null;
}

export function applicationProvenance(job: SubmissionJob): Record<string, unknown> {
  return {
    listingUrl: job.url,
    applicationUrl: job.application_url,
    employerUrl: job.employer_url ?? null,
    urlConfidence: job.url_confidence ?? (canonicalUrl(job.application_url) ? "unclassified" : "missing"),
  };
}

/** Channels that require a human step are never automated. */
/**
 * Final pre-send language gate. A mandatory German requirement is not a channel
 * problem: the vacancy is ineligible and must never reach the employer. An
 * unresolved mention blocks the send without pretending German is optional.
 */
export function germanSubmissionAssessment(job: SubmissionJob): GermanRequirementAssessment {
  const detected = analyseVacancyGermanRequirement(job.title, job.description);
  if (job.german_requirement === "required" && detected.status !== "required") {
    return {
      ...detected,
      status: "required",
      evidence: detected.evidence.length > 0 ? detected.evidence : ["Persisted discovery language evidence: German required."],
      detail: "A persisted discovery record marks German as mandatory.",
      reasonCode: MANDATORY_GERMAN_REQUIREMENT,
    };
  }
  return detected;
}

export function germanRequirementForSubmission(job: SubmissionJob): GermanRequirementAssessment | null {
  const german = germanSubmissionAssessment(job);
  return germanRequirementBlocksSubmission(german) ? german : null;
}

export function blockerForChannel(job: SubmissionJob): string | null {
  const text = `${job.description ?? ""}`;
  if (/captcha|i am not a robot|recaptcha|hcaptcha/i.test(text)) return "The employer's form uses a CAPTCHA, which is never bypassed.";
  if (/multi[- ]factor|two[- ]factor|2fa|verification code/i.test(text)) return "The employer's process requires multi-factor authentication.";
  if (/application fee|pay to apply|paid application/i.test(text)) return "The employer charges a fee; paid applications are not submitted.";
  if (/\b(create an account|sign in to apply|login to apply)\b/i.test(text) && !submissionEndpointConfigured()) {
    return "The employer requires an account login before applying.";
  }
  return null;
}

/** Pre-channel blockers that a human must satisfy externally, never by automation. */
export function manualExternalRequirement(reason: string): string | null {
  if (/captcha/i.test(reason)) return "captcha";
  if (/multi[- ]factor|verification code/i.test(reason)) return "mfa";
  if (/account login/i.test(reason)) return "account_login";
  if (/fee|pay to apply|paid application/i.test(reason)) return "payment";
  return null;
}

export function channelFor(job: SubmissionJob): { channel: SubmissionChannel; reason: string } {
  const blocker = blockerForChannel(job);
  if (blocker) return { channel: "manual", reason: blocker };
  const provenanceBlocker = applicationProvenanceBlocker(job);
  if (provenanceBlocker) return { channel: "manual", reason: provenanceBlocker };
  if (!job.application_url && !job.url) {
    return { channel: "manual", reason: "No application URL was captured for this vacancy." };
  }
  if (!submissionEndpointConfigured()) {
    if (candidateFormsEnabled()) {
      return {
        channel: "candidate_form",
        reason: "A normal candidate-facing application form will be read and completed from verified profile data.",
      };
    }
    return {
      channel: "manual",
      reason: "No automated application channel is configured for this deployment. The package is complete and queued for a human submission.",
    };
  }
  return { channel: "http_form", reason: "Configured HTTP form endpoint." };
}

export function existingVerifiedSubmission(jobId: string): { id: string; reference: string | null } | null {
  // The same vacancy can arrive from another board under a different local id.
  // The discovery layer stores a stable employer+title dedupe key; a verified
  // application on any record sharing it blocks a second submission.
  return one<{ id: string; reference: string | null }>(
    `SELECT sa.id, sa.reference FROM submission_attempts sa
     LEFT JOIN jobs j ON j.id = sa.job_id
     WHERE sa.status = 'verified'
       AND (sa.job_id = ? OR (j.dedupe_key IS NOT NULL AND j.dedupe_key = (SELECT dedupe_key FROM jobs WHERE id = ?)))
     ORDER BY sa.attempted_at DESC LIMIT 1`,
    [jobId, jobId],
  );
}

const STALE_CLAIM_MS = 5 * 60_000;

type SubmissionGate =
  | { ok: true }
  | { ok: false; detail: string; evidence: Record<string, unknown> };

/**
 * The persisted status is not enough. A ready flag must also still be the one
 * produced by the readiness engine; this is the last local gate before a send.
 */
function submissionGate(applicationId: string): SubmissionGate {
  const app = one<{ status: string; readiness: string | null }>(
    "SELECT status, readiness FROM applications WHERE id = ?",
    [applicationId],
  );
  if (!app) {
    return { ok: false, detail: "The application record does not exist.", evidence: { applicationId } };
  }
  let readinessState: string | null = null;
  try {
    const parsed = JSON.parse(app.readiness ?? "{}") as { state?: unknown; ready?: unknown };
    readinessState = typeof parsed.state === "string" ? parsed.state : null;
  } catch {
    readinessState = "unparseable";
  }
  if (app.status !== "ready_to_submit") {
    return {
      ok: false,
      detail: `Application status is ${app.status}; only ready_to_submit can be sent automatically.`,
      evidence: { applicationStatus: app.status, readinessState },
    };
  }
  if (!readinessAllowsSubmission(app.readiness)) {
    return {
      ok: false,
      detail: `The persisted readiness checklist is ${readinessState ?? "missing"}, not ready_for_submission. Re-run the quality check before sending.`,
      evidence: { applicationStatus: app.status, readinessState },
    };
  }
  return { ok: true };
}

/**
 * A worker that dies mid-send leaves a `submitting` claim. It is deliberately
 * treated as ambiguous (not failed and not successful) because the POST may have
 * reached the employer. A later worker must confirm externally before retrying.
 */
export function recoverStaleSubmissionClaims(now: Date = new Date()): number {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const stale = all<{ id: string; application_id: string; job_id: string }>(
    "SELECT id, application_id, job_id FROM submission_attempts WHERE status = 'submitting' AND attempted_at < ?",
    [cutoff],
  );
  for (const claim of stale) {
    const evidence = JSON.stringify({
      staleClaim: true,
      claimId: claim.id,
      recoveredAt: now.toISOString(),
      reason: "The submission worker did not finish before its lease expired; delivery is unknown.",
    }).slice(0, 12000);
    run(
      "UPDATE submission_attempts SET status = 'unverified', error = ? WHERE id = ? AND status = 'submitting'",
      ["The submission worker did not finish before its lease expired; delivery is unknown.", claim.id],
    );
    run(
      "UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified', submission_evidence = ?, last_update = ? WHERE id = ? AND status = 'submitting'",
      [evidence, now.toISOString(), claim.application_id],
    );
    recordApplicationEvent({
      applicationId: claim.application_id,
      type: "submission.recovery",
      message: "A stale submission claim was recovered as unverified; nothing is counted as submitted.",
      meta: { claimId: claim.id, jobId: claim.job_id },
    });
  }
  return stale.length;
}

type ClaimBlockKind = "not_ready" | "duplicate" | "prior" | "daily_limit" | "concurrent" | "storage_error";

type ClaimResult =
  | { claimed: true; attemptId: string }
  | { claimed: false; kind: ClaimBlockKind; detail: string; evidence: Record<string, unknown> };

/**
 * Atomic claim. BEGIN IMMEDIATE serialises the duplicate, readiness, daily-cap
 * and prior-attempt checks with the `submitting` insert. The partial unique
 * index on submission_attempts(job_id) is the final race guard.
 */
function claimSubmission(input: SubmissionInput, at: string): ClaimResult {
  const db = getDb();
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const gate = submissionGate(input.applicationId);
    if (!gate.ok) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { claimed: false, kind: "not_ready", detail: gate.detail, evidence: gate.evidence };
    }

    const duplicate = existingVerifiedSubmission(input.job.id);
    if (duplicate) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        claimed: false,
        kind: "duplicate",
        detail: `A verified submission already exists for this vacancy (${duplicate.reference ?? duplicate.id}). It will not be sent twice.`,
        evidence: { duplicateOf: duplicate.id, reference: duplicate.reference },
      };
    }

    const usage = dailySubmissionUsage(input.now ?? new Date(at), input.job.id);
    if (usage.remaining <= 0) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        claimed: false,
        kind: "daily_limit",
        detail: `The daily limit of ${usage.limit} verified submission(s) has been reached. Nothing was sent.`,
        evidence: { dailyLimit: usage.limit, verifiedToday: usage.verified, dayStart: usage.dayStart },
      };
    }

    const prior = one<{ status: string; http_status: number | null; reference: string | null; error: string | null }>(
      "SELECT status, http_status, reference, error FROM submission_attempts WHERE job_id = ? AND status != 'submitting' ORDER BY attempted_at DESC LIMIT 1",
      [input.job.id],
    );
    const reconciliation = reconciliationDecision(
      prior ? { status: prior.status, httpStatus: prior.http_status, reference: prior.reference, error: prior.error } : null,
    );
    if (reconciliation.action === "blocked") {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return { claimed: false, kind: "prior", detail: reconciliation.reason, evidence: reconciliation.evidence };
    }

    const active = one<{ id: string }>(
      "SELECT id FROM submission_attempts WHERE job_id = ? AND status = 'submitting' LIMIT 1",
      [input.job.id],
    );
    if (active) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        claimed: false,
        kind: "concurrent",
        detail: `Another worker already holds the active submission claim for this vacancy (${active.id}). This worker sent nothing.`,
        evidence: { activeClaim: active.id },
      };
    }

    const attemptId = `sub_${randomId()}`;
    const channel = channelFor(input.job).channel;
    db.prepare(
      `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, endpoint, status, http_status, reference, evidence, error, attempted_at)
       VALUES (?, ?, ?, ?, ?, NULL, 'submitting', NULL, NULL, ?, NULL, ?)`,
    ).run(
      attemptId,
      input.applicationId,
      input.job.id,
      input.runId ?? null,
      channel,
      JSON.stringify({ phase: "claimed", at, channel }).slice(0, 12000),
      at,
    );
    const updated = db
      .prepare("UPDATE applications SET status = 'submitting', submission_status = 'submitting', last_update = ? WHERE id = ? AND status = 'ready_to_submit'")
      .run(at, input.applicationId);
    if (Number(updated.changes) !== 1) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return {
        claimed: false,
        kind: "concurrent",
        detail: "The application stopped being ready while the claim was being taken; nothing was sent.",
        evidence: { applicationId: input.applicationId },
      };
    }
    db.exec("COMMIT");
    transactionOpen = false;
    return { claimed: true, attemptId };
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The original error is more useful than a rollback failure.
      }
    }
    const message = error instanceof Error ? error.message : "Unknown claim error";
    if (/unique constraint/i.test(message)) {
      return {
        claimed: false,
        kind: "concurrent",
        detail: "Another worker won the atomic submission claim. This worker sent nothing.",
        evidence: { uniqueConstraint: true },
      };
    }
    return {
      claimed: false,
      kind: "storage_error",
      detail: `The submission claim could not be persisted, so nothing was sent: ${message}`,
      evidence: { error: message },
    };
  }
}

function fileFor(relativePath: string | null): { buffer: Buffer; name: string } | null {
  if (!relativePath) return null;
  const name = path.basename(relativePath);
  try {
    const buffer = readFileSync(path.join(UPLOAD_DIR, name));
    return { buffer, name };
  } catch {
    return null;
  }
}

function extractReference(payload: unknown, headers: Headers): string | null {
  const headerRef = headers.get("x-application-reference") ?? headers.get("x-confirmation-id") ?? headers.get("location");
  if (headerRef) return headerRef.slice(0, 300);
  const candidates: unknown[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 3 || value === null || value === undefined) return;
    if (typeof value === "string") {
      candidates.push(value);
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    for (const key of ["reference", "confirmation", "confirmationId", "applicationId", "application_id", "id", "receipt"]) {
      if (record[key] !== undefined) candidates.push(record[key]);
    }
    for (const item of Object.values(record)) walk(item, depth + 1);
  };
  walk(payload, 0);
  const reference = candidates.find((item) => typeof item === "string" && item.trim().length > 0) as string | undefined;
  if (reference) return reference.slice(0, 300);
  if (typeof payload === "string") {
    const match = payload.match(/(?:reference|confirmation|application(?:\s*id)?)[^A-Za-z0-9]{0,12}([A-Za-z0-9._-]{4,40})/i);
    if (match) return match[1];
  }
  return null;
}

function recordAttempt(input: {
  applicationId: string;
  jobId: string;
  runId: string | null;
  channel: SubmissionChannel;
  endpoint: string | null;
  outcome: SubmissionOutcome;
  error: string | null;
  at: string;
  /** When present, finalise the atomic `submitting` row instead of adding a second row. */
  attemptId?: string | null;
}): void {
  if (input.attemptId) {
    run(
      `UPDATE submission_attempts SET channel = ?, endpoint = ?, status = ?, http_status = ?, reference = ?, evidence = ?, error = ?
       WHERE id = ?`,
      [
        input.channel,
        input.endpoint,
        input.outcome.status,
        input.outcome.httpStatus,
        input.outcome.reference,
        input.outcome.evidence ? JSON.stringify(input.outcome.evidence).slice(0, 12000) : null,
        input.error,
        input.attemptId,
      ],
    );
    return;
  }
  run(
    `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, endpoint, status, http_status, reference, evidence, error, attempted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `sub_${randomId()}`,
      input.applicationId,
      input.jobId,
      input.runId,
      input.channel,
      input.endpoint,
      input.outcome.status,
      input.outcome.httpStatus,
      input.outcome.reference,
      input.outcome.evidence ? JSON.stringify(input.outcome.evidence).slice(0, 12000) : null,
      input.error,
      input.at,
    ],
  );
}

function recordCandidateInterventions(input: {
  applicationId: string;
  jobId: string;
  plan: { status: string; detail: string; questions: Array<{ name: string; label: string; category: string; action: string; reason: string }> };
  at: string;
}): void {
  const questions = input.plan.questions.filter((question) => question.action === "intervention");
  const items = questions.length
    ? questions.map((question) => ({
        field: question.name,
        question: question.label || question.name,
        reason: question.reason,
        kind: question.category,
      }))
    : input.plan.status === "ready"
      ? []
      : [{ field: null, question: input.plan.detail, reason: input.plan.detail, kind: input.plan.status }];
  for (const item of items) {
    const existing = one<{ id: string }>(
      "SELECT id FROM application_interventions WHERE application_id = ? AND status = 'open' AND reason = ? LIMIT 1",
      [input.applicationId, item.reason],
    );
    if (existing) continue;
    run(
      `INSERT INTO application_interventions (id, application_id, job_id, field, question, reason, kind, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      [`int_${randomId()}`, input.applicationId, input.jobId, item.field, item.question.slice(0, 1000), item.reason.slice(0, 2000), item.kind, input.at],
    );
  }
  if (items.length > 0) {
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: "question.intervention",
      message: items.map((item) => `${item.question}: ${item.reason}`).join(" ").slice(0, 2000),
      meta: { questions: items },
    });
  }
}

function applyOutcome(input: {
  applicationId: string;
  job: SubmissionJob;
  outcome: SubmissionOutcome;
  at: string;
  cvDocumentId: string | null;
  coverDocumentId: string | null;
  runId: string | null;
}): void {
  const { outcome, at } = input;
  const jobId = input.job.id;
  const evidence = {
    ...(outcome.evidence ?? {}),
    outcomeClass: submissionOutcomeClass(outcome),
  };
  if (outcome.status === "verified") {
    const followUp = new Date(Date.parse(at) + 14 * 86400_000).toISOString();
    run(
      `UPDATE applications SET status = 'submitted', submission_status = 'verified', submitted_at = ?, confirmation = ?,
         confirmation_ref = ?, submission_evidence = ?, method = ?, applied_channel = ?, follow_up_at = ?,
         run_id = COALESCE(run_id, ?), last_update = ? WHERE id = ?`,
      [
        at,
        outcome.reference ?? "Verified by employer endpoint",
        outcome.reference,
        JSON.stringify(evidence).slice(0, 12000),
        outcome.channel,
        outcome.channel,
        followUp,
        input.runId,
        at,
        input.applicationId,
      ],
    );
    run("UPDATE jobs SET status = 'applied' WHERE id = ?", [jobId]);
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: "submission.verified",
      message: `Employer endpoint accepted the application (${outcome.channel}). Reference: ${outcome.reference ?? "not returned"}.`,
      meta: { endpoint: outcome.endpoint, httpStatus: outcome.httpStatus },
    });
    notify({
      kind: "application_submitted",
      dedupeKey: `submission_verified:${input.applicationId}:${at}`,
      subject: `Application submitted: ${input.job.title} at ${input.job.company}`,
      body: `Employer evidence recorded via ${outcome.channel}. Reference: ${outcome.reference ?? "recorded"}.`,
      email: false,
    });
    return;
  }

  const ambiguousFailure =
    outcome.status === "failed" &&
    (outcome.httpStatus === 408 ||
      outcome.httpStatus === 429 ||
      (outcome.httpStatus !== null && outcome.httpStatus >= 500) ||
      (outcome.httpStatus === null && !/nothing was sent|could not be read|missing files?/i.test(outcome.detail)));
  if (outcome.status === "unverified" || ambiguousFailure) {
    run(
      `UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified',
         submission_evidence = ?, method = ?, applied_channel = ?, run_id = COALESCE(run_id, ?), last_update = ? WHERE id = ?`,
      [JSON.stringify(evidence).slice(0, 12000), outcome.channel, outcome.channel, input.runId, at, input.applicationId],
    );
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: ambiguousFailure ? "submission.unknown" : "submission.unverified",
      message: outcome.detail,
      meta: { endpoint: outcome.endpoint, httpStatus: outcome.httpStatus, retryBlocked: true, outcomeClass: evidence.outcomeClass },
    });
    notify({
      kind: "application_submission_unverified",
      dedupeKey: `submission_unverified:${input.applicationId}:${at}`,
      subject: `Submission ${ambiguousFailure ? "unknown" : "unverified"}: ${input.job.title}`,
      body: `${input.job.company} did not produce a verified reference. ${outcome.detail} It is not counted as submitted and will not be retried blindly.`,
    });
    return;
  }

  const safeFailure = outcome.status === "failed";
  run(
    `UPDATE applications SET status = ?, submission_status = ?, method = ?,
       submission_evidence = ?, run_id = COALESCE(run_id, ?), last_update = ? WHERE id = ?`,
    [
      safeFailure ? "submission_failed" : "human_intervention_required",
      safeFailure ? "failed" : "blocked",
      outcome.channel,
      JSON.stringify(evidence).slice(0, 12000),
      input.runId,
      at,
      input.applicationId,
    ],
  );
  recordApplicationEvent({
    applicationId: input.applicationId,
    type: `submission.${outcome.status}`,
    message: outcome.detail,
    meta: { endpoint: outcome.endpoint, httpStatus: outcome.httpStatus, outcomeClass: evidence.outcomeClass },
  });
  if (safeFailure) {
    notify({
      kind: "application_failed",
      dedupeKey: `submission_failed:${input.applicationId}:${at}`,
      subject: `Submission failed: ${input.job.title}`,
      body: `${input.job.company} was not contacted successfully. ${outcome.detail}`,
    });
  }
}

/**
 * Submits one application. Every path is recorded, including the blocked ones,
 * so the daily report can distinguish prepared, submitted and verified.
 */
export async function submitApplication(input: SubmissionInput): Promise<SubmissionOutcome> {
  const at = (input.now ?? new Date()).toISOString();
  // Defence in depth: the run checks this too, but a direct call must never be
  // able to send an application before the owner has activated the policy.
  recoverStaleSubmissionClaims(input.now ?? new Date(at));
  const policy = getRecruitmentPolicy();
  if (!policy.active) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail:
        "The standing authorisation is not activated. No application was sent; the package can be prepared and reviewed in simulation mode.",
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { activationRequired: true, policyEngine: policy.engine },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: null,
      at,
    });
    return outcome;
  }
  if (submissionDryRun()) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: "Dry run is enabled. The package was not sent and no employer was contacted.",
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { dryRun: true, policyEngine: policy.engine },
    };
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: "submission.dry_run",
      message: outcome.detail,
      meta: { jobId: input.job.id, policyEngine: policy.engine },
    });
    audit({
      action: "application.submission_dry_run",
      entity: "application",
      entityId: input.applicationId,
      detail: `${input.job.title} at ${input.job.company} — no employer contacted.`,
    });
    return outcome;
  }

  // This runs before the duplicate/readiness claim and before any browser or
  // HTTP channel, so a newly mandatory German wording cannot be submitted even
  // if an older eligibility row still says eligible.
  const german = germanRequirementForSubmission(input.job);
  if (german) {
    const required = german.status === "required";
    const evidence = {
      germanRequirement: german.status,
      germanReasonCode: german.reasonCode,
      germanEvidence: german.evidence,
      eligibility: required ? "ineligible" : "needs_review",
      outcomeClass: "blocked_external",
    };
    run(
      `UPDATE jobs SET german_requirement = ?, language_evidence = ?, eligibility = ?, qualified = 0,
         qualification_status = ?, eligibility_checked_at = ? WHERE id = ?`,
      [
        german.status,
        JSON.stringify(german).slice(0, 8000),
        required ? "ineligible" : "needs_review",
        required ? "ineligible" : "needs_review",
        at,
        input.job.id,
      ],
    );
    run(
      "UPDATE applications SET status = ?, submission_status = 'blocked', submission_evidence = ?, last_update = ? WHERE id = ?",
      [required ? "rejected" : "human_intervention_required", JSON.stringify(evidence).slice(0, 12000), at, input.applicationId],
    );
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: "submission.language_exclusion",
      message: german.detail,
      meta: { ...evidence, reasonCode: german.reasonCode ?? (required ? MANDATORY_GERMAN_REQUIREMENT : GERMAN_REQUIREMENT_UNRESOLVED) },
    });
    return {
      status: "blocked",
      channel: "manual",
      detail: required
        ? `${MANDATORY_GERMAN_REQUIREMENT}: ${german.detail} The vacancy is ineligible and no employer was contacted.`
        : `${GERMAN_REQUIREMENT_UNRESOLVED}: ${german.detail} The application was not sent.`,
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence,
    };
  }

  const duplicate = existingVerifiedSubmission(input.job.id);
  if (duplicate) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: "manual",
      detail: `A verified submission already exists for this vacancy (${duplicate.reference ?? duplicate.id}). It will not be sent twice.`,
      httpStatus: null,
      reference: duplicate.reference,
      endpoint: null,
      evidence: { duplicateOf: duplicate.id },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: null,
      at,
    });
    return outcome;
  }

  const gate = submissionGate(input.applicationId);
  if (!gate.ok) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: gate.detail,
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: gate.evidence,
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: gate.detail,
      at,
    });
    return outcome;
  }

  // Retry safety: a timeout or missing reference means delivery is unknown. It is
  // never sent again blindly, even if the next run regenerates the package.
  const prior = one<{ status: string; http_status: number | null; reference: string | null; error: string | null }>(
    "SELECT status, http_status, reference, error FROM submission_attempts WHERE job_id = ? ORDER BY attempted_at DESC LIMIT 1",
    [input.job.id],
  );
  const reconciliation = reconciliationDecision(
    prior ? { status: prior.status, httpStatus: prior.http_status, reference: prior.reference, error: prior.error } : null,
  );
  if (reconciliation.action === "blocked") {
    const ambiguousPrior = reconciliation.evidence.reconciliation === "ambiguous";
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: reconciliation.reason,
      httpStatus: prior?.http_status ?? null,
      reference: prior?.reference ?? null,
      endpoint: null,
      evidence: {
        ...reconciliation.evidence,
        outcomeClass: ambiguousPrior ? "outcome_uncertain" : "prepared_not_submitted",
      },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: reconciliation.reason,
      at,
    });
    // A refused blind retry must not overwrite an uncertain prior delivery with
    // a human-intervention status: that would erase the only evidence of what
    // may already have reached the employer.
    if (!ambiguousPrior) {
      applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    } else {
      run(
        `UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified', last_update = ?
         WHERE id = ? AND status != 'submitted'`,
        [at, input.applicationId],
      );
      recordApplicationEvent({
        applicationId: input.applicationId,
        type: "submission.retry_blocked",
        message: reconciliation.reason,
        meta: { ...reconciliation.evidence, retryBlocked: true, outcomeClass: "outcome_uncertain" },
      });
    }
    return outcome;
  }

  const usage = dailySubmissionUsage(input.now ?? new Date(at), input.job.id);
  if (usage.remaining <= 0) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: `The daily limit of ${usage.limit} verified submission(s) has been reached. Nothing was sent.`,
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { dailyLimit: usage.limit, verifiedToday: usage.verified, dayStart: usage.dayStart },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: null,
      at,
    });
    return outcome;
  }

  const claim = claimSubmission(input, at);
  if (!claim.claimed) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: claim.detail,
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { ...(claim.evidence ?? {}), provenance: applicationProvenance(input.job) },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: null,
      outcome,
      error: claim.detail,
      at,
    });
    return outcome;
  }
  const claimAttemptId = claim.attemptId;
  recordApplicationEvent({
    applicationId: input.applicationId,
    type: "submission.submitting",
    message: "An atomic submission claim was recorded; the employer has not yet been contacted.",
    meta: { attemptId: claimAttemptId, jobId: input.job.id },
  });

  // A supported ATS is used only when its employer-issued credential exists.
  // Without it the generic proxy endpoint (if configured) still applies.
  const atsTarget = atsTargetFor(input.job);
  const atsKey = atsTarget ? atsCredential(atsTarget.ats) : null;
  if (atsTarget && atsKey && !blockerForChannel(input.job)) {
    const result = await submitViaAts(
      {
        target: atsTarget,
        job: {
          title: input.job.title,
          company: input.job.company,
          url: input.job.url,
          application_url: input.job.application_url,
        },
        profile: input.profile,
        documents: {
          cvPath: input.documents.cvPath,
          cvName: input.documents.cvName,
          coverPath: input.documents.coverPath,
          coverName: input.documents.coverName,
          coverText: input.documents.coverText,
        },
        at,
      },
      atsKey,
    );
    const outcome: SubmissionOutcome = {
      status: result.status,
      channel: atsTarget.ats,
      detail: result.detail,
      httpStatus: result.httpStatus,
      reference: result.reference,
      endpoint: result.endpoint,
      evidence: { ...result.evidence, provenance: applicationProvenance(input.job) },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: outcome.endpoint,
      outcome,
      error: outcome.status === "failed" ? outcome.detail : null,
      at,
      attemptId: claimAttemptId,
    });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    if (outcome.status === "verified") {
      audit({
        action: "application.submitted_automatically",
        entity: "application",
        entityId: input.applicationId,
        detail: `${input.job.title} at ${input.job.company} — ${outcome.detail}`,
      });
    }
    return outcome;
  }

  const channelChoice = channelFor(input.job);
  const { channel, reason } = channelChoice;
  if (channel === "candidate_form") {
    const cv = fileFor(input.documents.cvPath);
    const cover = fileFor(input.documents.coverPath);
    const candidateDocuments: CandidateDocuments = { cv, cover, coverText: input.documents.coverText };
    const profile: CandidateProfile = {
      fullName: input.profile.full_name,
      email: input.profile.email,
      phone: input.profile.phone,
      location: input.profile.location,
      linkedin: input.profile.linkedin,
      website: input.profile.website,
      workAuthorisation: input.profile.work_authorisation,
      summary: input.profile.summary ?? null,
      skills: input.profile.skills ?? [],
      languages: input.profile.spokenLanguages ?? [],
      experienceText: input.profile.experienceText ?? null,
      educationText: input.profile.educationText ?? null,
      sponsorshipAnswer: /authori[sz]ed|permit [bc]\b|no sponsorship|without .*sponsorship/i.test(
        input.profile.work_authorisation ?? "",
      )
        ? "No"
        : null,
    };
    const pageUrl = input.job.application_url ?? input.job.url ?? "";
    const formInput = {
      pageUrl,
      jobTitle: input.job.title,
      company: input.job.company,
      profile,
      documents: candidateDocuments,
      authorised: input.authorisedAnswers ?? authorisedAnswers(),
    };
    // Server-rendered HTML is cheapest and keeps the existing CSRF/cookie
    // handling. Only a page with no static form (or a failed static read) is
    // handed to the local browser, so a POST is never repeated across channels.
    let plan = await prepareCandidateForm(formInput);
    let result: CandidateFormResult;
    let executor: "http" | "playwright" = "http";
    if (plan.status === "ready") {
      result = await submitCandidateForm({ plan, documents: candidateDocuments });
    } else if ((plan.status === "unsupported" || plan.status === "failed") && browserFormsEnabled()) {
      const browserRun = await runBrowserCandidateForm(formInput);
      plan = browserRun.plan;
      result = browserRun.result;
      executor = "playwright";
    } else {
      result = {
        status: "blocked",
        detail: plan.detail,
        httpStatus: null,
        reference: null,
        endpoint: plan.action,
        finalUrl: plan.pageUrl,
        evidence: { sent: false, blockers: plan.blockers, questions: plan.questions },
      };
    }
    recordCandidateInterventions({ applicationId: input.applicationId, jobId: input.job.id, plan, at });
    const status: SubmissionStatus =
      result.status === "verified"
        ? "verified"
        : result.status === "unverified"
          ? "unverified"
          : result.status === "failed"
            ? "failed"
            : "blocked";
    const externalRequirement =
      (typeof result.evidence.externalRequirement === "string" ? result.evidence.externalRequirement : null) ??
      (plan.status === "security" ? "security_challenge" : null) ??
      (plan.questions.some((question) => question.action === "intervention" && question.category === "legal")
        ? "legal_declaration"
        : null);
    const outcome: SubmissionOutcome = {
      status,
      channel: "candidate_form",
      detail: result.detail,
      httpStatus: result.httpStatus,
      reference: result.reference,
      endpoint: result.endpoint,
      evidence: {
        ...result.evidence,
        executor,
        externalRequirement,
        formStatus: plan.status,
        finalUrl: result.finalUrl,
        policyEngine: policy.engine,
      },
    };
    outcome.evidence = { ...outcome.evidence, outcomeClass: submissionOutcomeClass(outcome) };
    const stoppedBeforeSend = plan.status !== "ready";
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel: outcome.channel,
      endpoint: outcome.endpoint,
      outcome,
      // A pre-send intervention is a safe non-attempt: after the owner answers,
      // the next run may re-evaluate it. A challenge after the POST could have
      // delivered the application, so it keeps its error and stays ambiguous.
      error: stoppedBeforeSend ? null : outcome.status === "failed" || outcome.status === "blocked" ? outcome.detail : null,
      at,
      attemptId: claimAttemptId,
    });
    applyOutcome({
      ...input,
      outcome,
      at,
      cvDocumentId: input.documents.cvDocumentId,
      coverDocumentId: input.documents.coverDocumentId,
      runId: input.runId ?? null,
    });
    audit({
      action: outcome.status === "verified" ? "application.submitted_automatically" : "application.candidate_form_stopped",
      entity: "application",
      entityId: input.applicationId,
      detail: `${input.job.title} at ${input.job.company} — ${outcome.detail}`,
    });
    return outcome;
  }

  if (channel === "manual") {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel,
      detail: reason,
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { reason, instant: at, externalRequirement: manualExternalRequirement(reason) },
    };
    outcome.evidence = { ...outcome.evidence, outcomeClass: submissionOutcomeClass(outcome) };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel,
      endpoint: null,
      outcome,
      error: null,
      at,
      attemptId: claimAttemptId,
    });
    applyOutcome({ ...input, outcome, at: at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

  const endpoint = endpointFor(input.job);
  if (!endpoint) {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel,
      detail: "The configured submission endpoint produced no URL for this vacancy.",
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { instant: at },
    };
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint: null, outcome, error: null, at, attemptId: claimAttemptId });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

  try {
    assertPublicHttpUrl(endpoint);
  } catch {
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel,
      detail: "The configured submission endpoint is not an allowed public HTTP(S) address; nothing was sent.",
      httpStatus: null,
      reference: null,
      endpoint,
      evidence: { instant: at, blockedEndpoint: true },
    };
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: outcome.detail, at, attemptId: claimAttemptId });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

  const form = new FormData();
  form.set("job_id", input.job.id);
  form.set("job_title", input.job.title);
  form.set("company", input.job.company);
  form.set("application_url", input.job.application_url ?? input.job.url ?? "");
  form.set("full_name", input.profile.full_name ?? "");
  form.set("email", input.profile.email ?? "");
  form.set("phone", input.profile.phone ?? "");
  form.set("location", input.profile.location ?? "");
  form.set("headline", input.profile.headline ?? "");
  form.set("work_authorisation", input.profile.work_authorisation ?? "");
  form.set("linkedin", input.profile.linkedin ?? "");
  form.set("website", input.profile.website ?? "");
  form.set("cover_letter", input.documents.coverText ?? "");
  form.set("requires_sponsorship", "no");
  if (input.documents.cvDocumentId) form.set("cv_document_id", input.documents.cvDocumentId);
  if (input.documents.coverDocumentId) form.set("cover_letter_document_id", input.documents.coverDocumentId);

  const cv = fileFor(input.documents.cvPath);
  const cover = fileFor(input.documents.coverPath);
  if (cv) form.set("cv", new Blob([new Uint8Array(cv.buffer)], { type: "application/pdf" }), cv.name);
  if (cover) form.set("cover_letter_file", new Blob([new Uint8Array(cover.buffer)], { type: "application/pdf" }), cover.name);

  const missingFiles: string[] = [];
  if (input.documents.cvPath && !cv) missingFiles.push("tailored CV");
  if (input.documents.coverPath && !cover) missingFiles.push("cover letter");
  if (missingFiles.length > 0) {
    const outcome: SubmissionOutcome = {
      status: "failed",
      channel,
      detail: `The stored ${missingFiles.join(" and ")} file could not be read, so nothing was sent.`,
      httpStatus: null,
      reference: null,
      endpoint,
      evidence: { instant: at, missingFiles },
    };
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: outcome.detail, at, attemptId: claimAttemptId });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

  let httpStatus: number | null = null;
  let bodyText = "";
  let headers = new Headers();
  try {
    const response = await outboundTransport(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(45_000),
      headers: { "User-Agent": "AT-AI-Workforce/2.0 (authorised application submission)" },
      cache: "no-store",
      redirect: "manual",
    });
    httpStatus = response.status;
    headers = response.headers;
    bodyText = await readLimitedText(response, 4000);

    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const outcome: SubmissionOutcome = {
        status: retryable ? "failed" : "blocked",
        channel,
        detail: `The employer endpoint rejected the submission with HTTP ${response.status}. Nothing was recorded as submitted.`,
        httpStatus,
        reference: null,
        endpoint,
        evidence: { instant: at, httpStatus, responseSnippet: bodyText.slice(0, 600) },
      };
      recordAttempt({
        applicationId: input.applicationId,
        jobId: input.job.id,
        runId: input.runId ?? null,
        channel,
        endpoint,
        outcome,
        error: outcome.detail,
        at,
        attemptId: claimAttemptId,
      });
      applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
      return outcome;
    }

    let payload: unknown = bodyText;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      // Non-JSON acknowledgements are still inspected for a reference string.
    }
    const reference = extractReference(payload, headers);
    const outcome: SubmissionOutcome = {
      status: reference ? "verified" : "unverified",
      channel,
      detail: reference
        ? `The employer endpoint accepted the application and returned reference ${reference}.`
        : "The employer endpoint returned success but no confirmation reference, so the submission is unverified.",
      httpStatus,
      reference,
      endpoint,
      evidence: {
        instant: at,
        httpStatus,
        reference,
        responseSnippet: bodyText.slice(0, 1200),
        files: [cv?.name, cover?.name].filter(Boolean),
      },
    };
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: null, at, attemptId: claimAttemptId });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    audit({
      action: outcome.status === "verified" ? "application.submitted_automatically" : "application.submission_unverified",
      entity: "application",
      entityId: input.applicationId,
      detail: `${input.job.title} at ${input.job.company} — ${outcome.detail}`,
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown submission transport error";
    const outcome: SubmissionOutcome = {
      status: "failed",
      channel,
      detail: `The submission could not be delivered: ${message}`,
      httpStatus,
      reference: null,
      endpoint,
      evidence: { instant: at, error: message, responseSnippet: bodyText.slice(0, 600) },
    };
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: message, at, attemptId: claimAttemptId });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }
}

export function submissionEvidence(applicationId: string) {
  return one<{ submission_evidence: string | null; submission_status: string | null; confirmation_ref: string | null }>(
    "SELECT submission_evidence, submission_status, confirmation_ref FROM applications WHERE id = ?",
    [applicationId],
  );
}
