import { readFileSync } from "node:fs";
import path from "node:path";
import { nowIso, one, run, UPLOAD_DIR } from "./db";
import { randomId } from "./security";
import { audit } from "./audit";
import { recordApplicationEvent } from "./application-events";
import { atsCredential, atsTargetFor, submitViaAts } from "./submission-ats";
import { reconciliationDecision } from "./submission-reconciliation";
import { prepareCandidateForm, submitCandidateForm, type CandidateDocuments, type CandidateProfile } from "./candidate-forms";
import { authorisedAnswers, getRecruitmentPolicy } from "./recruitment-policy";

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

export type SubmissionJob = {
  id: string;
  title: string;
  company: string;
  url: string | null;
  application_url: string | null;
  description: string | null;
  /** ATS identity when the vacancy came from a supported connector. */
  source?: string | null;
  external_id?: string | null;
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

/** Candidate-facing forms are on unless explicitly disabled. Activation is enforced separately. */
export function candidateFormsEnabled(): boolean {
  return process.env.RECRUITMENT_CANDIDATE_FORMS !== "false";
}

export function endpointFor(job: SubmissionJob): string | null {
  const template = submissionEndpointConfigured();
  if (!template) return null;
  return template
    .replace(/\{job_id\}/g, encodeURIComponent(job.id))
    .replace(/\{application_url\}/g, encodeURIComponent(job.application_url ?? job.url ?? ""))
    .replace(/\{company\}/g, encodeURIComponent(job.company));
}

/** Channels that require a human step are never automated. */
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

export function channelFor(job: SubmissionJob): { channel: SubmissionChannel; reason: string } {
  const blocker = blockerForChannel(job);
  if (blocker) return { channel: "manual", reason: blocker };
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
}): void {
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
        JSON.stringify(outcome.evidence ?? {}).slice(0, 12000),
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
    return;
  }

  if (outcome.status === "unverified") {
    run(
      `UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified',
         submission_evidence = ?, method = ?, applied_channel = ?, run_id = COALESCE(run_id, ?), last_update = ? WHERE id = ?`,
      [JSON.stringify(outcome.evidence ?? {}).slice(0, 12000), outcome.channel, outcome.channel, input.runId, at, input.applicationId],
    );
    recordApplicationEvent({
      applicationId: input.applicationId,
      type: "submission.unverified",
      message: outcome.detail,
      meta: { endpoint: outcome.endpoint, httpStatus: outcome.httpStatus },
    });
    return;
  }

  run(
    `UPDATE applications SET status = 'human_intervention_required', submission_status = ?, method = ?,
       submission_evidence = ?, run_id = COALESCE(run_id, ?), last_update = ? WHERE id = ?`,
    [outcome.status, outcome.channel, JSON.stringify(outcome.evidence ?? {}).slice(0, 12000), input.runId, at, input.applicationId],
  );
  recordApplicationEvent({
    applicationId: input.applicationId,
    type: `submission.${outcome.status}`,
    message: outcome.detail,
    meta: { endpoint: outcome.endpoint, httpStatus: outcome.httpStatus },
  });
}

/**
 * Submits one application. Every path is recorded, including the blocked ones,
 * so the daily report can distinguish prepared, submitted and verified.
 */
export async function submitApplication(input: SubmissionInput): Promise<SubmissionOutcome> {
  const at = (input.now ?? new Date()).toISOString();
  // Defence in depth: the run checks this too, but a direct call must never be
  // able to send an application before the owner has activated the policy.
  const policy = getRecruitmentPolicy();
  if (!policy.active) {
    return {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail:
        "The standing authorisation is not activated. No application was sent; the package can be prepared and reviewed in simulation mode.",
      httpStatus: null,
      reference: null,
      endpoint: null,
      evidence: { activationRequired: true, policyEngine: policy.engine },
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
    const outcome: SubmissionOutcome = {
      status: "blocked",
      channel: channelFor(input.job).channel,
      detail: reconciliation.reason,
      httpStatus: prior?.http_status ?? null,
      reference: prior?.reference ?? null,
      endpoint: null,
      evidence: reconciliation.evidence,
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
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

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
      evidence: result.evidence,
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
    const plan = await prepareCandidateForm({
      pageUrl: input.job.application_url ?? input.job.url ?? "",
      jobTitle: input.job.title,
      company: input.job.company,
      profile,
      documents: candidateDocuments,
      authorised: input.authorisedAnswers ?? authorisedAnswers(),
    });
    const result = plan.status === "ready"
      ? await submitCandidateForm({ plan, documents: candidateDocuments })
      : {
          status: "blocked" as const,
          detail: plan.detail,
          httpStatus: null,
          reference: null,
          endpoint: plan.action,
          finalUrl: plan.pageUrl,
          evidence: { sent: false, blockers: plan.blockers, questions: plan.questions },
        };
    recordCandidateInterventions({ applicationId: input.applicationId, jobId: input.job.id, plan, at });
    const status: SubmissionStatus =
      result.status === "verified"
        ? "verified"
        : result.status === "unverified"
          ? "unverified"
          : result.status === "failed"
            ? "failed"
            : "blocked";
    const outcome: SubmissionOutcome = {
      status,
      channel: "candidate_form",
      detail: result.detail,
      httpStatus: result.httpStatus,
      reference: result.reference,
      endpoint: result.endpoint,
      evidence: {
        ...result.evidence,
        formStatus: plan.status,
        finalUrl: result.finalUrl,
        policyEngine: policy.engine,
      },
    };
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
      evidence: { reason, instant: at },
    };
    recordAttempt({
      applicationId: input.applicationId,
      jobId: input.job.id,
      runId: input.runId ?? null,
      channel,
      endpoint: null,
      outcome,
      error: null,
      at,
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
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint: null, outcome, error: null, at });
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
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: outcome.detail, at });
    applyOutcome({ ...input, outcome, at, cvDocumentId: input.documents.cvDocumentId, coverDocumentId: input.documents.coverDocumentId, runId: input.runId ?? null });
    return outcome;
  }

  let httpStatus: number | null = null;
  let bodyText = "";
  let headers = new Headers();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(45_000),
      headers: { "User-Agent": "AT-AI-Workforce/2.0 (authorised application submission)" },
      cache: "no-store",
    });
    httpStatus = response.status;
    headers = response.headers;
    bodyText = (await response.text()).slice(0, 4000);

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
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: null, at });
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
    recordAttempt({ applicationId: input.applicationId, jobId: input.job.id, runId: input.runId ?? null, channel, endpoint, outcome, error: message, at });
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
