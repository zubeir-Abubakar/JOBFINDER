import { all, nowIso, one, run } from "./db";
import { randomId } from "./security";
import { reconciliationDecision } from "./submission-reconciliation";

/**
 * Durable stage checkpoints and recovery decisions.
 *
 * Phase 2 already persists task ownership, dependencies, heartbeats and
 * outputs. This module adds the run/vacancy checkpoint ledger needed to decide
 * which recruitment stage is safe to resume. It never sends an application and
 * never treats a task metadata field as proof that output exists.
 */

export const RECRUITMENT_STAGES = [
  "discovery",
  "vacancy_validation",
  "eligibility",
  "cv_generation",
  "cv_validation",
  "cover_generation",
  "cover_validation",
  "rendering",
  "package_assembly",
  "readiness",
  "submission_claim",
  "employer_submission",
  "confirmation_verification",
] as const;

export type RecruitmentStage = (typeof RECRUITMENT_STAGES)[number];

export type StageStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "waiting"
  | "reconciling"
  | "intervention"
  | "invalidated";

export type StageCheckpoint = {
  id: string;
  run_id: string;
  job_id: string;
  stage: RecruitmentStage;
  status: StageStatus;
  attempt: number;
  output_refs: string | null;
  evidence: string | null;
  decision: string | null;
  reason: string | null;
  next_stage: RecruitmentStage | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StageEvidenceState = "complete" | "missing" | "invalid" | "ambiguous" | "failed";

export type StageEvidence = {
  state: StageEvidenceState;
  outputRefs: Record<string, unknown>;
  evidence: Record<string, unknown>;
  reason: string | null;
};

export type RecoveryAction =
  | "complete"
  | "reuse"
  | "resume"
  | "retry"
  | "revalidate"
  | "invalidate"
  | "wait_dependency"
  | "wait_provider"
  | "wait_lease"
  | "manual_intervention"
  | "reconcile_submission"
  | "stop";

export type RecoveryDecision = {
  stage: RecruitmentStage;
  action: RecoveryAction;
  reason: string;
  retryCount: number;
  outputRefs: Record<string, unknown>;
  evidence: Record<string, unknown>;
  nextStage: RecruitmentStage | null;
};

export type StagePlanEntry = {
  stage: RecruitmentStage;
  checkpoint: StageCheckpoint | null;
  evidence: StageEvidence;
  decision: RecoveryDecision;
};

export type StagePlan = {
  runId: string;
  jobId: string;
  entries: StagePlanEntry[];
  lastCompleted: RecruitmentStage | null;
  currentStage: RecruitmentStage | null;
  failedStage: RecruitmentStage | null;
  nextAction: RecoveryAction | null;
};

export type StageResult = {
  ok: boolean;
  outputRefs?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
  reason?: string | null;
  errorClass?: string | null;
};

export type StageHandler = (context: {
  runId: string;
  jobId: string;
  stage: RecruitmentStage;
  checkpoint: StageCheckpoint | null;
  evidence: StageEvidence;
}) => Promise<StageResult>;

export type StageRunResult = {
  plan: StagePlan;
  executed: RecruitmentStage[];
  reused: RecruitmentStage[];
  stoppedAt: RecruitmentStage | null;
  finalAction: RecoveryAction;
};

function stageIndex(stage: RecruitmentStage): number {
  return RECRUITMENT_STAGES.indexOf(stage);
}

export function nextStageAfter(stage: RecruitmentStage): RecruitmentStage | null {
  return RECRUITMENT_STAGES[stageIndex(stage) + 1] ?? null;
}

export function checkpointFor(runId: string, jobId: string, stage: RecruitmentStage): StageCheckpoint | null {
  return one<StageCheckpoint>(
    "SELECT * FROM recruitment_stage_checkpoints WHERE run_id = ? AND job_id = ? AND stage = ?",
    [runId, jobId, stage],
  );
}

export function listCheckpoints(runId: string, jobId = ""): StageCheckpoint[] {
  return all<StageCheckpoint>(
    "SELECT * FROM recruitment_stage_checkpoints WHERE run_id = ? AND job_id = ? ORDER BY created_at",
    [runId, jobId],
  );
}

export function recordStage(input: {
  runId: string;
  jobId?: string;
  stage: RecruitmentStage;
  status: StageStatus;
  outputRefs?: Record<string, unknown> | null;
  evidence?: Record<string, unknown> | null;
  decision?: string | null;
  reason?: string | null;
  errorClass?: string | null;
  incrementAttempt?: boolean;
  now?: Date;
}): StageCheckpoint {
  const jobId = input.jobId ?? "";
  const at = (input.now ?? new Date()).toISOString();
  const existing = checkpointFor(input.runId, jobId, input.stage);
  const outputRefs = input.outputRefs ? JSON.stringify(input.outputRefs).slice(0, 16000) : null;
  const evidence = input.evidence
    ? JSON.stringify({ ...input.evidence, ...(input.errorClass ? { errorClass: input.errorClass } : {}) }).slice(0, 24000)
    : input.errorClass
      ? JSON.stringify({ errorClass: input.errorClass })
      : null;
  const attempt = (existing?.attempt ?? 0) + (input.incrementAttempt ? 1 : 0);
  const id = existing?.id ?? `stage_${randomId()}`;
  const next = nextStageAfter(input.stage);
  run(
    `INSERT INTO recruitment_stage_checkpoints
       (id, run_id, job_id, stage, status, attempt, output_refs, evidence, decision, reason, next_stage, heartbeat_at, completed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, job_id, stage) DO UPDATE SET
       status = excluded.status,
       attempt = excluded.attempt,
       output_refs = COALESCE(excluded.output_refs, recruitment_stage_checkpoints.output_refs),
       evidence = COALESCE(excluded.evidence, recruitment_stage_checkpoints.evidence),
       decision = COALESCE(excluded.decision, recruitment_stage_checkpoints.decision),
       reason = excluded.reason,
       next_stage = excluded.next_stage,
       heartbeat_at = excluded.heartbeat_at,
       completed_at = excluded.completed_at,
       updated_at = excluded.updated_at`,
    [
      id,
      input.runId,
      jobId,
      input.stage,
      input.status,
      attempt,
      outputRefs,
      evidence,
      input.decision ?? null,
      input.reason ?? null,
      next,
      input.status === "running" ? at : null,
      input.status === "completed" ? at : null,
      existing?.created_at ?? at,
      at,
    ],
  );
  return checkpointFor(input.runId, jobId, input.stage)!;
}

export function invalidateStageAndDescendants(input: {
  runId: string;
  jobId?: string;
  stage: RecruitmentStage;
  reason: string;
  now?: Date;
}): RecruitmentStage[] {
  const jobId = input.jobId ?? "";
  const invalidated: RecruitmentStage[] = [];
  for (const stage of RECRUITMENT_STAGES.slice(stageIndex(input.stage))) {
    const existing = checkpointFor(input.runId, jobId, stage);
    if (!existing) continue;
    recordStage({
      runId: input.runId,
      jobId,
      stage,
      status: "invalidated",
      reason: input.reason,
      decision: "invalidate",
      now: input.now,
    });
    invalidated.push(stage);
  }
  return invalidated;
}

function jobRecord(jobId: string) {
  return one<{
    id: string;
    run_id: string | null;
    vacancy_status: string | null;
    vacancy_verification: string | null;
    eligibility: string | null;
    analysis: string | null;
    match_score: number | null;
    qualified: number;
  }>(
    "SELECT id, run_id, vacancy_status, vacancy_verification, eligibility, analysis, match_score, qualified FROM jobs WHERE id = ?",
    [jobId],
  );
}

function documentsFor(jobId: string, kind: "tailored_cv" | "cover_letter") {
  return all<{
    id: string;
    mime: string;
    size_bytes: number;
    quality_status: string | null;
    text_content: string | null;
    version: string | null;
  }>(
    `SELECT id, mime, size_bytes, quality_status, text_content, version
     FROM documents WHERE job_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY created_at DESC`,
    [jobId, kind],
  );
}

function applicationFor(jobId: string) {
  return one<{
    id: string;
    status: string;
    cv_document_id: string | null;
    cover_letter_id: string | null;
    readiness: string | null;
    submission_status: string | null;
    confirmation_ref: string | null;
  }>(
    `SELECT id, status, cv_document_id, cover_letter_id, readiness, submission_status, confirmation_ref
     FROM applications WHERE job_id = ?`,
    [jobId],
  );
}

function latestSubmissionAttempt(jobId: string) {
  return one<{
    id: string;
    status: string;
    http_status: number | null;
    reference: string | null;
    error: string | null;
    evidence: string | null;
  }>(
    `SELECT id, status, http_status, reference, error, evidence
     FROM submission_attempts WHERE job_id = ? ORDER BY attempted_at DESC, rowid DESC LIMIT 1`,
    [jobId],
  );
}

function readinessState(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { state?: unknown };
    return typeof parsed.state === "string" ? parsed.state : null;
  } catch {
    return null;
  }
}

export function deriveStageEvidence(runId: string, jobId: string, stage: RecruitmentStage): StageEvidence {
  if (stage === "discovery") {
    const count = Number(
      one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ?", [runId])?.n ?? 0,
    );
    return {
      state: count > 0 ? "complete" : "missing",
      outputRefs: count > 0 ? { jobCount: count } : {},
      evidence: { persistedJobsForRun: count },
      reason: count > 0 ? null : "No persisted vacancy is linked to this run.",
    };
  }

  const job = jobRecord(jobId);
  if (!job) {
    return { state: "missing", outputRefs: {}, evidence: { jobId }, reason: "The vacancy record is missing." };
  }

  if (stage === "vacancy_validation") {
    const complete = job.vacancy_status === "open" && Boolean(job.vacancy_verification);
    return {
      state: complete ? "complete" : job.vacancy_status === "closed" ? "invalid" : "missing",
      outputRefs: complete ? { jobId, vacancyStatus: job.vacancy_status } : {},
      evidence: { vacancyStatus: job.vacancy_status },
      reason: complete ? null : `Vacancy status is ${job.vacancy_status ?? "not verified"}.`,
    };
  }

  if (stage === "eligibility") {
    const complete = Boolean(job.eligibility) && job.analysis !== null;
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete ? { jobId, eligibility: job.eligibility, matchScore: job.match_score } : {},
      evidence: { eligibility: job.eligibility, matchScore: job.match_score, qualified: job.qualified },
      reason: complete ? null : "Eligibility or scoring evidence is missing.",
    };
  }

  const cvDocs = documentsFor(jobId, "tailored_cv");
  const coverDocs = documentsFor(jobId, "cover_letter");
  const cvPdf = cvDocs.find((doc) => doc.mime === "application/pdf");
  const cvDocx = cvDocs.find((doc) => doc.mime.includes("wordprocessing"));
  const coverPdf = coverDocs.find((doc) => doc.mime === "application/pdf");
  const coverDocx = coverDocs.find((doc) => doc.mime.includes("wordprocessing"));

  if (stage === "cv_generation") {
    const complete = Boolean(cvPdf?.text_content?.trim() && cvDocx);
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete ? { cvDocumentId: cvPdf!.id, cvDocxId: cvDocx!.id, version: cvPdf!.version } : {},
      evidence: { pdf: Boolean(cvPdf), docx: Boolean(cvDocx) },
      reason: complete ? null : "Persisted CV PDF and DOCX outputs are incomplete.",
    };
  }

  if (stage === "cv_validation") {
    const complete = cvPdf?.quality_status === "passed";
    return {
      state: complete ? "complete" : cvPdf?.quality_status ? "invalid" : "missing",
      outputRefs: complete ? { cvDocumentId: cvPdf!.id, qualityStatus: cvPdf!.quality_status } : {},
      evidence: { qualityStatus: cvPdf?.quality_status ?? null },
      reason: complete ? null : `CV quality status is ${cvPdf?.quality_status ?? "missing"}.`,
    };
  }

  if (stage === "cover_generation") {
    const complete = Boolean(coverPdf?.text_content?.trim() && coverDocx);
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete ? { coverDocumentId: coverPdf!.id, coverDocxId: coverDocx!.id, version: coverPdf!.version } : {},
      evidence: { pdf: Boolean(coverPdf), docx: Boolean(coverDocx) },
      reason: complete ? null : "Persisted cover-letter PDF and DOCX outputs are incomplete.",
    };
  }

  if (stage === "cover_validation") {
    const complete = coverPdf?.quality_status === "passed";
    return {
      state: complete ? "complete" : coverPdf?.quality_status ? "invalid" : "missing",
      outputRefs: complete ? { coverDocumentId: coverPdf!.id, qualityStatus: coverPdf!.quality_status } : {},
      evidence: { qualityStatus: coverPdf?.quality_status ?? null },
      reason: complete ? null : `Cover-letter quality status is ${coverPdf?.quality_status ?? "missing"}.`,
    };
  }

  if (stage === "rendering") {
    const complete = [cvPdf, cvDocx, coverPdf, coverDocx].every(
      (doc) => Boolean(doc && doc.size_bytes > 0 && doc.text_content?.trim()),
    );
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete
        ? { cvDocumentId: cvPdf!.id, coverDocumentId: coverPdf!.id }
        : {},
      evidence: {
        cvPdfBytes: cvPdf?.size_bytes ?? 0,
        cvDocxBytes: cvDocx?.size_bytes ?? 0,
        coverPdfBytes: coverPdf?.size_bytes ?? 0,
        coverDocxBytes: coverDocx?.size_bytes ?? 0,
      },
      reason: complete ? null : "One or more rendered document files are missing or empty.",
    };
  }

  const app = applicationFor(jobId);

  if (stage === "package_assembly") {
    const complete = Boolean(app?.cv_document_id && app.cover_letter_id);
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete ? { applicationId: app!.id, cvDocumentId: app!.cv_document_id, coverDocumentId: app!.cover_letter_id } : {},
      evidence: { applicationStatus: app?.status ?? null },
      reason: complete ? null : "The application package is not linked to both persisted documents.",
    };
  }

  if (stage === "readiness") {
    const state = readinessState(app?.readiness ?? null);
    const complete = state === "ready_for_submission";
    return {
      state: complete ? "complete" : state ? "invalid" : "missing",
      outputRefs: complete ? { applicationId: app!.id, readinessState: state } : {},
      evidence: { readinessState: state, applicationStatus: app?.status ?? null },
      reason: complete ? null : `Readiness state is ${state ?? "missing"}.`,
    };
  }

  const attempt = latestSubmissionAttempt(jobId);

  if (stage === "submission_claim") {
    const complete = Boolean(attempt);
    return {
      state: complete ? "complete" : "missing",
      outputRefs: complete ? { attemptId: attempt!.id, submissionStatus: attempt!.status } : {},
      evidence: { attemptStatus: attempt?.status ?? null },
      reason: complete ? null : "No persisted submission claim exists.",
    };
  }

  if (stage === "employer_submission") {
    if (!attempt) {
      return { state: "missing", outputRefs: {}, evidence: {}, reason: "No submission attempt exists." };
    }
    if (attempt.status === "verified") {
      return {
        state: "complete",
        outputRefs: { attemptId: attempt.id, reference: attempt.reference },
        evidence: { attemptStatus: attempt.status, httpStatus: attempt.http_status },
        reason: null,
      };
    }
    if (attempt.status === "unverified" || attempt.status === "submitting") {
      return {
        state: "ambiguous",
        outputRefs: { attemptId: attempt.id },
        evidence: { attemptStatus: attempt.status, httpStatus: attempt.http_status },
        reason: "The employer may have received the application; confirmation is required before any retry.",
      };
    }
    return {
      state: "failed",
      outputRefs: { attemptId: attempt.id },
      evidence: { attemptStatus: attempt.status, httpStatus: attempt.http_status, error: attempt.error },
      reason: "The employer submission attempt has a terminal failure.",
    };
  }

  if (stage === "confirmation_verification") {
    if (app?.submission_status === "verified" && app.confirmation_ref) {
      return {
        state: "complete",
        outputRefs: { applicationId: app.id, confirmationRef: app.confirmation_ref },
        evidence: { submissionStatus: app.submission_status },
        reason: null,
      };
    }
    if (app?.submission_status === "unverified" || attempt?.status === "unverified") {
      return {
        state: "ambiguous",
        outputRefs: { applicationId: app?.id ?? null, attemptId: attempt?.id ?? null },
        evidence: { submissionStatus: app?.submission_status ?? null },
        reason: "No verified employer confirmation exists; the outcome is ambiguous.",
      };
    }
    return { state: "missing", outputRefs: {}, evidence: {}, reason: "No confirmation evidence is recorded." };
  }

  return { state: "missing", outputRefs: {}, evidence: {}, reason: "Unknown stage." };
}

function hasActiveRunLease(runId: string, now: Date): boolean {
  const row = one<{ active: number }>(
    "SELECT EXISTS(SELECT 1 FROM runtime_locks WHERE key = ? AND expires_at > ?) AS active",
    [`recruitment:run:${runId}`, now.toISOString()],
  );
  return Number(row?.active ?? 0) === 1;
}

export function decideStageRecovery(input: {
  runId: string;
  jobId?: string;
  stage: RecruitmentStage;
  now?: Date;
  checkpoint?: StageCheckpoint | null;
  evidence?: StageEvidence;
  upstreamComplete?: boolean;
  leaseActive?: boolean;
  providerUnavailable?: boolean;
  errorClass?: string | null;
  /** The current execution just created the claim and has not sent yet. */
  activeClaimJustClaimed?: boolean;
}): RecoveryDecision {
  const now = input.now ?? new Date();
  const jobId = input.jobId ?? "";
  const checkpoint = input.checkpoint === undefined ? checkpointFor(input.runId, jobId, input.stage) : input.checkpoint;
  const evidence = input.evidence ?? deriveStageEvidence(input.runId, jobId, input.stage);
  const retryCount = checkpoint?.attempt ?? 0;
  const nextStage = nextStageAfter(input.stage);
  const base = { stage: input.stage, retryCount, nextStage };

  if (evidence.state === "complete") {
    return {
      ...base,
      action: checkpoint?.status === "completed" ? "complete" : "reuse",
      reason:
        checkpoint?.status === "completed"
          ? "The stage checkpoint and its persisted output are complete."
          : "A valid persisted output exists; it is reused instead of regenerated.",
      outputRefs: evidence.outputRefs,
      evidence: evidence.evidence,
    };
  }

  if (input.upstreamComplete === false) {
    return {
      ...base,
      action: "wait_dependency",
      reason: "A prerequisite stage is not complete; this stage must not execute.",
      outputRefs: {},
      evidence: { ...evidence.evidence, prerequisite: "incomplete" },
    };
  }

  if (input.leaseActive ?? hasActiveRunLease(input.runId, now)) {
    return {
      ...base,
      action: "wait_lease",
      reason: "Another worker holds an unexpired run lease; this stage must not be raced.",
      outputRefs: evidence.outputRefs,
      evidence: { ...evidence.evidence, leaseActive: true },
    };
  }

  if (evidence.state === "ambiguous") {
    if (input.activeClaimJustClaimed && input.stage === "employer_submission") {
      return {
        ...base,
        action: "resume",
        reason: "The submission claim was created by this execution and no send boundary has been crossed yet.",
        outputRefs: evidence.outputRefs,
        evidence: { ...evidence.evidence, sameExecutionClaim: true },
      };
    }
    return {
      ...base,
      action: "reconcile_submission",
      reason: evidence.reason ?? "The persisted outcome is ambiguous and requires reconciliation.",
      outputRefs: evidence.outputRefs,
      evidence: evidence.evidence,
    };
  }

  if (checkpoint?.status === "intervention") {
    return {
      ...base,
      action: "manual_intervention",
      reason: checkpoint.reason ?? "This stage requires human intervention.",
      outputRefs: evidence.outputRefs,
      evidence: evidence.evidence,
    };
  }

  if (checkpoint?.status === "failed" || evidence.state === "failed" || evidence.state === "invalid") {
    const errorClass = input.errorClass ?? (checkpoint?.evidence ? (JSON.parse(checkpoint.evidence) as { errorClass?: string }).errorClass : null);
    if (errorClass === "authentication" || errorClass === "quota_exhausted" || errorClass === "validation") {
      return {
        ...base,
        action: errorClass === "validation" ? "revalidate" : "manual_intervention",
        reason:
          errorClass === "validation"
            ? "Persisted validation evidence is invalid; revalidate before regenerating."
            : `The stage failed with a permanent ${errorClass} error.`,
        outputRefs: evidence.outputRefs,
        evidence: evidence.evidence,
      };
    }
    if (input.providerUnavailable || ["timeout", "rate_limited", "network", "provider_unavailable"].includes(errorClass ?? "")) {
      return {
        ...base,
        action: "wait_provider",
        reason: "The persisted failure is provider-related; wait for recovery instead of invalidating upstream work.",
        outputRefs: evidence.outputRefs,
        evidence: evidence.evidence,
      };
    }
    if (input.stage === "employer_submission" && evidence.state === "failed") {
      return {
        ...base,
        action: "stop",
        reason: evidence.reason ?? "The employer rejected the submission; blind retry is unsafe.",
        outputRefs: evidence.outputRefs,
        evidence: evidence.evidence,
      };
    }
    if (checkpoint?.status === "failed" && checkpoint.decision === "retry") {
      return {
        ...base,
        action: "retry",
        reason: checkpoint.reason ?? "The previous attempt failed and may be retried from this checkpoint.",
        outputRefs: evidence.outputRefs,
        evidence: evidence.evidence,
      };
    }
    if (evidence.state === "invalid") {
      return {
        ...base,
        action: "invalidate",
        reason: evidence.reason ?? "Persisted output is invalid and must be regenerated.",
        outputRefs: evidence.outputRefs,
        evidence: evidence.evidence,
      };
    }
    return {
      ...base,
      action: "retry",
      reason: evidence.reason ?? "The stage has no usable persisted output.",
      outputRefs: evidence.outputRefs,
      evidence: evidence.evidence,
    };
  }

  if (checkpoint?.status === "running") {
    return {
      ...base,
      action: "resume",
      reason: "A running checkpoint has no active lease; resume or retry the same stage.",
      outputRefs: evidence.outputRefs,
      evidence: evidence.evidence,
    };
  }

  return {
    ...base,
    action: "retry",
    reason: evidence.reason ?? "No persisted output exists for this stage.",
    outputRefs: evidence.outputRefs,
    evidence: evidence.evidence,
  };
}

function planForStage(
  runId: string,
  jobId: string,
  stage: RecruitmentStage,
  now: Date,
  upstreamComplete: boolean,
): StagePlanEntry {
  const checkpointJobId = stage === "discovery" ? "" : jobId;
  const checkpoint = checkpointFor(runId, checkpointJobId, stage);
  const evidence = deriveStageEvidence(runId, jobId, stage);
  const decision = decideStageRecovery({
    runId,
    jobId: checkpointJobId,
    stage,
    now,
    checkpoint,
    evidence,
    upstreamComplete,
  });
  return { stage, checkpoint, evidence, decision };
}

export function buildStagePlan(input: { runId: string; jobId?: string; now?: Date }): StagePlan {
  const now = input.now ?? new Date();
  const jobId = input.jobId ?? "";
  const entries: StagePlanEntry[] = [];
  let upstreamComplete = true;
  let lastCompleted: RecruitmentStage | null = null;
  let failedStage: RecruitmentStage | null = null;
  for (const stage of RECRUITMENT_STAGES) {
    const entry = planForStage(input.runId, jobId, stage, now, upstreamComplete);
    entries.push(entry);
    if (entry.evidence.state === "complete") lastCompleted = stage;
    if (!failedStage && ["failed", "invalid", "ambiguous"].includes(entry.evidence.state)) failedStage = stage;
    if (entry.decision.action === "complete" || entry.decision.action === "reuse") {
      upstreamComplete = true;
    } else {
      upstreamComplete = false;
    }
  }
  const current = entries.find(
    (entry) => entry.decision.action !== "complete" && entry.decision.action !== "reuse",
  );
  return {
    runId: input.runId,
    jobId,
    entries,
    lastCompleted,
    currentStage: current?.stage ?? null,
    failedStage,
    nextAction: current?.decision.action ?? null,
  };
}

/**
 * Execute only the stages that are not already backed by valid persisted
 * outputs. Completed outputs are marked complete without invoking their
 * handler; a failure is recorded with its stage and never advances.
 */
export async function runStageRecovery(input: {
  runId: string;
  jobId?: string;
  handlers: Partial<Record<RecruitmentStage, StageHandler>>;
  now?: Date;
  /** Controlled stop boundary for restart and fault-injection tests. */
  stopAt?: RecruitmentStage;
  providerUnavailable?: boolean;
}): Promise<StageRunResult> {
  const now = input.now ?? new Date();
  const jobId = input.jobId ?? "";
  const plan = buildStagePlan({ runId: input.runId, jobId, now });
  const executed: RecruitmentStage[] = [];
  const reused: RecruitmentStage[] = [];
  let upstreamComplete = true;
  let stopAt: RecruitmentStage | null = null;
  let finalAction: RecoveryAction = "complete";
  let claimedThisRun = false;

  for (const entry of plan.entries) {
    const checkpointJobId = entry.stage === "discovery" ? "" : jobId;
    const checkpoint = checkpointFor(input.runId, checkpointJobId, entry.stage);
    const evidence = deriveStageEvidence(input.runId, jobId, entry.stage);
    const decision = decideStageRecovery({
      runId: input.runId,
      jobId: checkpointJobId,
      stage: entry.stage,
      now,
      checkpoint,
      evidence,
      upstreamComplete,
      providerUnavailable: input.providerUnavailable,
      activeClaimJustClaimed: claimedThisRun,
    });
    finalAction = decision.action;

    if (decision.action === "complete") {
      upstreamComplete = true;
      finalAction = "complete";
      if (input.stopAt === entry.stage) {
        stopAt = entry.stage;
        break;
      }
      continue;
    }
    if (decision.action === "reuse") {
      recordStage({
        runId: input.runId,
        jobId: checkpointJobId,
        stage: entry.stage,
        status: "completed",
        outputRefs: decision.outputRefs,
        evidence: { reusedExistingOutput: true, ...decision.evidence },
        decision: "reuse",
        reason: decision.reason,
        now,
      });
      reused.push(entry.stage);
      upstreamComplete = true;
      finalAction = "complete";
      if (input.stopAt === entry.stage) {
        stopAt = entry.stage;
        break;
      }
      continue;
    }
    if (
      ["wait_dependency", "wait_lease", "wait_provider", "manual_intervention", "reconcile_submission", "stop"].includes(
        decision.action,
      )
    ) {
      const status: StageStatus =
        decision.action === "wait_provider" || decision.action === "wait_lease" || decision.action === "wait_dependency"
          ? "waiting"
          : decision.action === "reconcile_submission"
            ? "reconciling"
            : decision.action === "stop"
              ? "failed"
              : "intervention";
      recordStage({
        runId: input.runId,
        jobId: checkpointJobId,
        stage: entry.stage,
        status,
        outputRefs: decision.outputRefs,
        evidence: decision.evidence,
        decision: decision.action,
        reason: decision.reason,
        now,
      });
      stopAt = entry.stage;
      break;
    }

    const handler = input.handlers[entry.stage];
    if (!handler) {        recordStage({
          runId: input.runId,
          jobId: checkpointJobId,
          stage: entry.stage,
          status: "failed",
          evidence: { missingHandler: true },
        decision: "stop",
        reason: `No recovery handler is registered for ${entry.stage}.`,
        now,
      });
      stopAt = entry.stage;
      finalAction = "stop";
      break;
    }

    recordStage({
      runId: input.runId,
      jobId: checkpointJobId,
      stage: entry.stage,
      status: "running",
      evidence: { previousDecision: decision.action },
      decision: decision.action,
      reason: decision.reason,
      incrementAttempt: true,
      now,
    });
    try {
      const result = await handler({
        runId: input.runId,
        jobId,
        stage: entry.stage,
        checkpoint,
        evidence,
      });
      if (!result.ok) {
        recordStage({
          runId: input.runId,
          jobId: checkpointJobId,
          stage: entry.stage,
          status: result.errorClass === "provider_unavailable" || result.errorClass === "timeout" ? "waiting" : "failed",
          outputRefs: result.outputRefs ?? null,
          evidence: result.evidence ?? null,
          decision: result.errorClass === "provider_unavailable" || result.errorClass === "timeout" ? "wait_provider" : "retry",
          reason: result.reason ?? "The stage did not produce verified output.",
          errorClass: result.errorClass ?? null,
          now,
        });
        stopAt = entry.stage;
        finalAction = result.errorClass === "provider_unavailable" || result.errorClass === "timeout" ? "wait_provider" : "retry";
        break;
      }
      recordStage({
        runId: input.runId,
        jobId: checkpointJobId,
        stage: entry.stage,
        status: "completed",
        outputRefs: result.outputRefs ?? {},
        evidence: result.evidence ?? {},
        decision: "complete",
        reason: null,
        now,
      });
      if (entry.stage === "submission_claim") claimedThisRun = true;
      executed.push(entry.stage);
      upstreamComplete = true;
      finalAction = "complete";
    } catch (error) {
      const message = error instanceof Error ? error.message : "Stage execution failed.";
      recordStage({
        runId: input.runId,
        jobId: checkpointJobId,
        stage: entry.stage,
        status: "failed",
        evidence: { exception: message },
        decision: "retry",
        reason: message,
        errorClass: "unknown",
        now,
      });
      stopAt = entry.stage;
      finalAction = "retry";
      break;
    }
    if (input.stopAt === entry.stage) {
      stopAt = entry.stage;
      break;
    }
  }

  return {
    plan: buildStagePlan({ runId: input.runId, jobId, now }),
    executed,
    reused,
    stoppedAt: stopAt,
    finalAction,
  };
}

export function recordSubmissionCheckpoints(
  runId: string,
  jobId: string,
  now: Date = new Date(),
): void {
  const attempt = latestSubmissionAttempt(jobId);
  const app = applicationFor(jobId);
  recordStage({
    runId,
    jobId,
    stage: "submission_claim",
    status: attempt ? "completed" : "failed",
    outputRefs: attempt ? { attemptId: attempt.id, attemptStatus: attempt.status } : {},
    evidence: { attemptStatus: attempt?.status ?? null },
    reason: attempt ? null : "No submission claim was persisted.",
    now,
  });
  const employer = deriveStageEvidence(runId, jobId, "employer_submission");
  recordStage({
    runId,
    jobId,
    stage: "employer_submission",
    status:
      employer.state === "complete"
        ? "completed"
        : employer.state === "ambiguous"
          ? "reconciling"
          : employer.state === "failed"
            ? "failed"
            : "pending",
    outputRefs: employer.outputRefs,
    evidence: employer.evidence,
    reason: employer.reason,
    now,
  });
  const confirmation = deriveStageEvidence(runId, jobId, "confirmation_verification");
  recordStage({
    runId,
    jobId,
    stage: "confirmation_verification",
    status:
      confirmation.state === "complete"
        ? "completed"
        : confirmation.state === "ambiguous"
          ? "reconciling"
          : "pending",
    outputRefs: confirmation.outputRefs,
    evidence: { ...confirmation.evidence, applicationStatus: app?.status ?? null },
    reason: confirmation.reason,
    now,
  });
}

/** Submission reconciliation decision for the checkpoint ledger. */
export function submissionRecoveryDecision(jobId: string) {
  const attempt = latestSubmissionAttempt(jobId);
  return reconciliationDecision(
    attempt
      ? {
          status: attempt.status,
          httpStatus: attempt.http_status,
          reference: attempt.reference,
          error: attempt.error,
        }
      : null,
  );
}

export type RunStageSummary = {
  lastCompleted: RecruitmentStage | null;
  currentStage: RecruitmentStage | null;
  failedStage: RecruitmentStage | null;
  nextAction: RecoveryAction | null;
  retryCount: number;
  checkpoints: StageCheckpoint[];
};

/** Aggregate checkpoint view for the Central Command Hub (all vacancies). */
export function runStageSummary(runId: string): RunStageSummary {
  const rows = all<StageCheckpoint>(
    "SELECT * FROM recruitment_stage_checkpoints WHERE run_id = ? ORDER BY updated_at DESC, rowid DESC",
    [runId],
  );
  const completed = rows.filter((row) => row.status === "completed");
  const lastCompleted = completed.sort((a, b) => stageIndex(b.stage) - stageIndex(a.stage))[0] ?? null;
  const active = rows.find((row) =>
    ["running", "waiting", "reconciling", "intervention", "failed", "invalidated"].includes(row.status),
  );
  const failed = rows.find((row) => ["failed", "reconciling", "intervention", "invalidated"].includes(row.status));
  return {
    lastCompleted: lastCompleted?.stage ?? null,
    currentStage: active?.stage ?? null,
    failedStage: failed?.stage ?? null,
    nextAction: (active?.decision as RecoveryAction | null) ?? null,
    retryCount: active?.attempt ?? 0,
    checkpoints: rows.slice(0, 12),
  };
}

export function stageSummary(runId: string, jobId = ""): {
  lastCompleted: RecruitmentStage | null;
  currentStage: RecruitmentStage | null;
  failedStage: RecruitmentStage | null;
  nextAction: RecoveryAction | null;
  retryCount: number;
  checkpoints: StageCheckpoint[];
} {
  const plan = buildStagePlan({ runId, jobId });
  const current = plan.currentStage ? checkpointFor(runId, jobId, plan.currentStage) : null;
  return {
    lastCompleted: plan.lastCompleted,
    currentStage: plan.currentStage,
    failedStage: plan.failedStage,
    nextAction: plan.nextAction,
    retryCount: current?.attempt ?? 0,
    checkpoints: listCheckpoints(runId, jobId),
  };
}
