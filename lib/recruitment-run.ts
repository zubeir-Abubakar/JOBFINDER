import { all, nowIso, one, run, UPLOAD_DIR } from "./db";
import path from "node:path";
import { existsSync } from "node:fs";
import { randomId } from "./security";
import {
  analyseSingleJob,
  completeTask,
  createWorkflow,
  failTask,
  finishWorkflow,
  generateApplicationPackage,
  startTask,
  type PackageOutcome,
} from "./agents";
import { assessEligibility, type EligibilityAssessment } from "./eligibility";
import {
  analyseVacancyGermanRequirement,
  MANDATORY_GERMAN_REQUIREMENT,
  GERMAN_REQUIREMENT_UNRESOLVED,
} from "./language-requirements";
import { discoverJobSources, sourceHealth, type DiscoveryResult, type SourceMetrics } from "./recruitment-discovery";
import { evaluateReadiness, type ReadinessItem } from "./application-readiness";
import { submitApplication, existingVerifiedSubmission, recoverStaleSubmissionClaims, submissionOutcomeClass, type SubmissionInput, type SubmissionOutcome } from "./submission";
import { QUALIFYING_MATCH_SCORE, effectiveMinMatchScore, qualifiesForAutoApply, autoApplyBlockers, type JobAnalysis } from "./scoring";
import { getSetting } from "./settings";
import { getProfileData } from "./profile";
import {
  authorisedAnswers,
  dailySubmissionUsage,
  getRecruitmentPolicy,
  recordPolicySimulation,
} from "./recruitment-policy";
import { notify } from "./notify";
import { enqueueDocumentRecovery } from "./recruitment-recovery";
import { audit } from "./audit";
import { catchUpWindowHours, localClockTime, localDateKey, nextRecruitmentOccurrence, recordScheduleRun, scheduleSnapshot, RECRUITMENT_TIMEZONE, RECRUITMENT_WEEKDAYS, formatInZone } from "./recruitment-schedule";
import { qualificationStatusFor } from "./job-identity";
import { acquireRuntimeLock, refreshRuntimeLock, releaseRuntimeLock, runtimeLockActive } from "./runtime-state";
import { recordApplicationEvent } from "./application-events";
import { generateText, providerConfigured, scrubProviderError } from "./providers";
import { AiSpendingPolicyError, zeroSpendSummary } from "./ai-spending-policy";
import { buildExecutionManifest } from "./execution-manifest";
import { verifyAndPersistVacancy, type VacancyVerification } from "./vacancy-verification";
import { agentIdentity } from "./agent-identity";
import { resolveCoverLetterRequirements } from "./cover-letter-requirements";
import {
  buildStagePlan,
  checkpointFor,
  decideStageRecovery,
  deriveStageEvidence,
  recordStage,
  recordSubmissionCheckpoints,
  type RecruitmentStage,
} from "./recruitment-stages";

/**
 * Chief Coordinator for the autonomous daily recruitment run.
 *
 * The Coordinator owns the run from creation to report: it assigns work to the
 * existing specialist roster, records every assignment, retries recoverable
 * steps, isolates a failed vacancy so the run continues, and only counts an
 * application as submitted when the submission carried employer evidence.
 *
 * Model output is advisory. Discovery, eligibility, scoring, thresholding and
 * submission decisions are deterministic, so a model outage cannot invent a
 * vacancy or an application result.
 */

export const RUN_STATES = [
  "scheduled",
  "starting",
  "searching",
  "analysing",
  "preparing_applications",
  "quality_checking",
  "submitting",
  "verifying_submissions",
  "completed",
  "completed_with_warnings",
  "failed",
  "interrupted",
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type RunTrigger = "schedule" | "manual" | "catch_up";

export type RunRow = {
  id: string;
  run_key: string;
  workflow_id: string | null;
  scheduled_for: string | null;
  trigger: RunTrigger;
  status: RunState;
  state_history: string | null;
  started_at: string | null;
  finished_at: string | null;
  jobs_discovered: number;
  jobs_duplicates: number;
  jobs_filtered: number;
  jobs_updated: number;
  discovery_scope: string | null;
  discovery_since: string | null;
  jobs_eligible: number;
  jobs_qualified: number;
  sources_checked: number;
  sources_succeeded: number;
  sources_failed: number;
  sources_partial: number;
  discovery_state: string | null;
  packages_prepared: number;
  applications_submitted: number;
  applications_unverified: number;
  applications_intervention: number;
  applications_simulated: number;
  failures: number;
  warnings: number;
  warnings_json?: string | null;
  failures_json?: string | null;
  report: string | null;
  source_metrics: string | null;
  mode: string | null;
  error: string | null;
  created_at: string;
};

let memoryRunning: string | null = null;

export function qualifyingThreshold(): number {
  // The threshold can be raised by the owner but never lowered at runtime. The
  // UI reads this same function, so it cannot display a lower number.
  return effectiveMinMatchScore(getSetting<number>("min_match_score", QUALIFYING_MATCH_SCORE));
}

export function activeRun(): RunRow | null {
  return one<RunRow>(
    "SELECT * FROM recruitment_runs WHERE status NOT IN ('completed','completed_with_warnings','failed','interrupted') ORDER BY created_at DESC LIMIT 1",
  );
}

export function runById(id: string): RunRow | null {
  return one<RunRow>("SELECT * FROM recruitment_runs WHERE id = ?", [id]);
}

export function recentRuns(limit = 20): RunRow[] {
  return all<RunRow>("SELECT * FROM recruitment_runs ORDER BY created_at DESC LIMIT ?", [Math.min(200, Math.max(1, limit))]);
}

export function runStateHistory(run: RunRow): Array<{ state: string; at: string; message?: string }> {
  try {
    const parsed = JSON.parse(run.state_history ?? "[]") as Array<{ state: string; at: string; message?: string }>;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * A restart or crashed worker must not leave a run permanently "running".
 * A scheduled run that is still inside the catch-up window is safe to resume;
 * a run that had already started is marked interrupted rather than blindly
 * replayed. Phase 3's submission claim and duplicate evidence remain the final
 * guards against a second send.
 */
export function recoverInterruptedRecruitmentRuns(now: Date = new Date()): {
  resumed: string[];
  interrupted: string[];
} {
  const rows = all<RunRow>(
    "SELECT * FROM recruitment_runs WHERE status NOT IN ('completed','completed_with_warnings','failed','interrupted') ORDER BY created_at",
  );
  const resumed: string[] = [];
  const interrupted: string[] = [];
  for (const runRow of rows) {
    const lockKey = `recruitment:run:${runRow.id}`;
    if (runtimeLockActive(lockKey, now)) continue;
    const scheduled = Date.parse(runRow.scheduled_for ?? runRow.created_at);
    const withinCatchup =
      Number.isFinite(scheduled) && now.getTime() - scheduled <= catchUpWindowHours() * 3600_000;
    if (runRow.status === "scheduled" && withinCatchup) {
      resumed.push(runRow.id);
      continue;
    }
    const message = `Run was ${runRow.status} without an active worker lease after a restart. It was marked interrupted; completed work was preserved and no submission was retried blindly.`;
    const history = [
      ...runStateHistory(runRow),
      { state: "interrupted", at: now.toISOString(), message },
    ];
    run(
      "UPDATE recruitment_runs SET status = 'interrupted', state_history = ?, error = ?, finished_at = ? WHERE id = ? AND status = ?",
      [JSON.stringify(history).slice(0, 20000), message, now.toISOString(), runRow.id, runRow.status],
    );
    closeOpenAssignments(runRow.id, "failed", message, runRow.workflow_id);
    if (runRow.workflow_id) finishWorkflow(runRow.workflow_id, "failed", message);
    if (runRow.trigger !== "manual") {
      recordScheduleRun({ runId: runRow.id, status: "interrupted", error: message, now });
    }
    notify({
      kind: "scheduler_failure",
      dedupeKey: `run_interrupted:${runRow.id}`,
      subject: "Recruitment run interrupted",
      body: message,
    });
    audit({ action: "recruitment.run_interrupted", entity: "recruitment_run", entityId: runRow.id, detail: message });
    interrupted.push(runRow.id);
  }
  return { resumed, interrupted };
}

function pushState(runId: string, state: RunState, message?: string): void {
  const current = runById(runId);
  if (!current) return;
  const history = [...runStateHistory(current), { state, at: nowIso(), message }];
  run("UPDATE recruitment_runs SET status = ?, state_history = ? WHERE id = ?", [state, JSON.stringify(history).slice(0, 20000), runId]);
  audit({ action: `recruitment.${state}`, entity: "recruitment_run", entityId: runId, detail: message ?? null });
}

function logAgent(input: {
  runId: string;
  agentKey: string;
  assignment: string;
  status: "running" | "completed" | "failed" | "blocked" | "retried" | "reassigned" | "skipped";
  attempt?: number;
  output?: string | null;
  error?: string | null;
  decision?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  /** "ai" only when a model actually returned output for this assignment. */
  executionMode?: "deterministic" | "ai";
  provider?: string | null;
  model?: string | null;
}): void {
  const assignment = input.assignment.slice(0, 500);
  // Close the matching running row instead of leaving stale "running" rows
  // beside their own completion. Per-vacancy assignments remain separate.
  const open = input.status === "running"
    ? null
    : one<{ id: number }>(
        "SELECT id FROM recruitment_run_agents WHERE run_id = ? AND agent_key = ? AND assignment = ? AND status = 'running' ORDER BY id DESC LIMIT 1",
        [input.runId, input.agentKey, assignment],
      );
  if (open) {
    run(
      `UPDATE recruitment_run_agents SET status = ?, attempt = ?, output = ?, error = ?, coordinator_decision = ?,
         execution_mode = ?, provider = ?, model = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?`,
      [
        input.status,
        input.attempt ?? 1,
        input.output ? input.output.slice(0, 4000) : null,
        input.error ? input.error.slice(0, 2000) : null,
        input.decision ? input.decision.slice(0, 1000) : null,
        input.executionMode ?? "deterministic",
        input.provider ?? null,
        input.model ?? null,
        input.startedAt ?? nowIso(),
        input.finishedAt ?? nowIso(),
        open.id,
      ],
    );
    return;
  }
  run(
    `INSERT INTO recruitment_run_agents (run_id, agent_key, assignment, status, attempt, output, error, coordinator_decision, execution_mode, provider, model, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.runId,
      input.agentKey,
      assignment,
      input.status,
      input.attempt ?? 1,
      input.output ? input.output.slice(0, 4000) : null,
      input.error ? input.error.slice(0, 2000) : null,
      input.decision ? input.decision.slice(0, 1000) : null,
      input.executionMode ?? "deterministic",
      input.provider ?? null,
      input.model ?? null,
      input.startedAt ?? nowIso(),
      input.finishedAt ?? null,
      nowIso(),
    ],
  );
}

/** Close assignments left non-terminal by an interrupted or advisory-only stage. */
/**
 * Persist an explicit skipped assignment for a specialist that was never
 * required. Without this, an absent row and a crashed agent both look like
 * silence; the manifest must be able to distinguish the two.
 */
function recordSkippedAgent(input: {
  runId: string;
  workflowId: string | null;
  agentKey: string;
  assignment: string;
  reason: string;
}): void {
  const existing = one<{ id: number }>(
    "SELECT id FROM recruitment_run_agents WHERE run_id = ? AND agent_key = ? LIMIT 1",
    [input.runId, input.agentKey],
  );
  if (existing) return;
  if (input.workflowId) {
    const task = one<{ id: string }>(
      "SELECT id FROM tasks WHERE workflow_id = ? AND agent_key = ? LIMIT 1",
      [input.workflowId, input.agentKey],
    );
    if (task) return;
  }
  logAgent({
    runId: input.runId,
    agentKey: input.agentKey,
    assignment: input.assignment,
    status: "skipped",
    output: input.reason,
    decision: input.reason,
    finishedAt: nowIso(),
  });
}

/** Close assignments left non-terminal by an interrupted or advisory-only stage. */
function closeOpenAssignments(runId: string, status: "completed" | "failed", note: string, workflowId: string | null = null): void {
  const at = nowIso();
  run(
    "UPDATE recruitment_run_agents SET status = ?, coordinator_decision = COALESCE(coordinator_decision, ?), finished_at = COALESCE(finished_at, ?) WHERE run_id = ? AND status IN ('running','queued') AND finished_at IS NULL",
    [status, note, at, runId],
  );
  if (!workflowId) return;
  // The task table is a second execution ledger. A stage that never emitted a
  // terminal task state must not remain "running" after the run has ended.
  const openAgents = all<{ agent_key: string }>(
    "SELECT DISTINCT agent_key FROM tasks WHERE workflow_id = ? AND status IN ('queued','running','waiting_provider','retry_scheduled')",
    [workflowId],
  );
  run(
    "UPDATE tasks SET status = ?, state_reason = ?, finished_at = COALESCE(finished_at, ?) WHERE workflow_id = ? AND status IN ('queued','running','waiting_provider','retry_scheduled')",
    [status, note.slice(0, 1200), at, workflowId],
  );
  for (const row of openAgents) {
    run("UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'idle' END, current_task = NULL WHERE key = ?", [row.agent_key]);
  }
}

/** An unavailable or paused agent is recorded; deterministic work still runs. */
function attemptTask(
  agentKey: string,
  workflowId: string,
  title: string,
  detail: string,
  options: { dependsOn?: string[] } = {},
): { taskId: string | null; warning: string | null } {
  try {
    return { taskId: startTask(agentKey, workflowId, title, detail, options), warning: null };
  } catch (error) {
    return { taskId: null, warning: error instanceof Error ? error.message : "The assigned agent is unavailable." };
  }
}

/**
 * A stage must never take the whole run down.
 *
 * `completeTask()` deliberately refuses a task that is already failed or owned
 * by another agent; that guard is correct and stays. What was missing is
 * isolation: a stalled task recovered by the sweeper made this throw and the
 * discovery results already stored were lost with the run. The rejection is
 * recorded against the task and reported as a warning, while the run continues.
 */
function safeComplete(taskId: string | null, agentKey: string, output: string): void {
  if (!taskId) return;
  try {
    completeTask(taskId, agentKey, output);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Task completion was rejected.";
    audit({
      action: "recruitment.task_state_isolated",
      entity: "task",
      entityId: taskId,
      detail: `${agentKey}: ${message}`,
    });
  }
}

function safeFail(taskId: string | null, agentKey: string, error: string): void {
  if (!taskId) return;
  try {
    failTask(taskId, agentKey, error);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : "Task failure was rejected.";
    audit({
      action: "recruitment.task_state_isolated",
      entity: "task",
      entityId: taskId,
      detail: `${agentKey}: ${message}`,
    });
  }
}

const COORDINATOR_SYSTEM =
  `You are ${agentIdentity("coordinator").name}, the ${agentIdentity("coordinator").title} of an autonomous recruitment team. Reason only from the evidence supplied. ` +
  "You may never change a match score, an eligibility result or the 85% threshold, invent candidate experience " +
  "or claim contact with an employer. Deterministic rules retain decision authority; your output is an advisory " +
  "assessment recorded on the run.";

type AiStepOutcome = {
  ok: boolean;
  blocked: boolean;
  provider: string | null;
  model: string | null;
  text: string | null;
  error: string | null;
};

/**
 * One real inference request for a run assignment.
 *
 * A run step is only marked `ai` after a model returned text. Without a
 * configured provider the step is reported as deterministic rather than being
 * recorded as if an agent had executed model work.
 */
async function aiStep(input: {
  agentKey: string;
  workflowId: string;
  taskId: string | null;
  system: string;
  prompt: string;
  maxTokens: number;
}): Promise<AiStepOutcome> {
  if (!providerConfigured()) {
    return {
      ok: false,
      blocked: true,
      provider: null,
      model: null,
      text: null,
      error: zeroSpendSummary(),
    };
  }
  try {
    const result = await generateText({
      agentKey: input.agentKey,
      workflowId: input.workflowId,
      taskId: input.taskId,
      source: input.taskId ? "task" : "manual",
      system: input.system,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      temperature: 0.15,
      priority: 1,
      maxWaitMs: 120_000,
    });
    // recordUsage() owns the task link, attempts, provider/model and AI mode.
    return { ok: true, blocked: false, provider: result.provider, model: result.model, text: result.text.trim(), error: null };
  } catch (error) {
    const blocked = error instanceof AiSpendingPolicyError;
    const message = scrubProviderError(error instanceof Error ? error.message : "AI inference failed.");
    if (input.taskId) {
      run(
        `UPDATE tasks SET ai_outcome = ?, state_reason = ?,
           execution_mode = CASE WHEN EXISTS (
             SELECT 1 FROM provider_usage WHERE task_id = ? AND agent_key = ? AND source = 'task'
           ) THEN 'ai' ELSE 'deterministic' END
         WHERE id = ?`,
        [blocked ? "blocked" : "failed", message, input.taskId, input.agentKey, input.taskId],
      );
    }
    return { ok: false, blocked, provider: null, model: null, text: null, error: message };
  }
}

/**
 * The model must never invent vacancies. A run supplies titles, employers and
 * scores but no internal ids, so any "Vacancy ID: 12345" is fabricated and the
 * whole advisory is withheld instead of being published as run evidence.
 */
export function coordinatorOutputSupported(text: string, vacanciesSupplied: number): boolean {
  // No run supplies internal vacancy ids, so any id-shaped reference is invented.
  if (/\bvacanc(?:y|ies)\s*(?:id|#)/i.test(text)) return false;
  if (vacanciesSupplied === 0 && /\b(?:job|vacancy)\b[^.\n]{0,30}\b\d{3,}\b/i.test(text)) return false;
  return true;
}

function ownerUserId(explicit?: string): string {
  if (explicit) return explicit;
  return (
    one<{ id: string }>("SELECT id FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC LIMIT 1")?.id ??
    "system"
  );
}

type JobRowLite = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  remote: number;
  url: string | null;
  application_url: string | null;
  description: string | null;
  employment_type: string | null;
  published_at: string | null;
  match_score: number | null;
  analysis: string | null;
  eligibility: string | null;
  eligibility_notes: string | null;
  run_id: string | null;
  qualified: number;
  source: string | null;
  external_id: string | null;
  company_domain: string | null;
  expiry_at: string | null;
  requirements: string | null;
  vacancy_status: string | null;
  vacancy_verified_at: string | null;
  url_confidence: string | null;
  employer_url: string | null;
  german_requirement: string | null;
  language_evidence: string | null;
};

function jobLite(id: string): JobRowLite | null {
  return one<JobRowLite>(     `SELECT id, title, company, location, remote, url, application_url, description, employment_type, published_at,
            match_score, analysis, eligibility, eligibility_notes, run_id, qualified, source, external_id, company_domain, expiry_at,
            requirements, vacancy_status, vacancy_verified_at, url_confidence, employer_url,
            german_requirement, language_evidence
     FROM jobs WHERE id = ?`,
    [id],
  );
}

/**
 * Re-apply the hard German exclusion to every stored vacancy. Discovery and
 * re-listing enforce it at insertion; this sweep covers rows created before the
 * rule existed and survives restarts and requalification. It also resolves an
 * ambiguous mention to `needs_review`, so a stale eligible row is downgraded.
 */
export function enforceStoredGermanExclusion(now: Date = new Date()): number {
  const rows = all<{
    id: string;
    title: string;
    description: string | null;
    eligibility: string | null;
    german_requirement: string | null;
  }>("SELECT id, title, description, eligibility, german_requirement FROM jobs");
  let changed = 0;
  for (const row of rows) {
    const german = analyseVacancyGermanRequirement(row.title, row.description);
    if (german.status === "required") {
      run(
        `UPDATE jobs SET german_requirement = 'required', language_evidence = ?,
           eligibility = 'ineligible', qualified = 0, qualification_status = 'ineligible',
           eligibility_notes = ?, eligibility_checked_at = ?,
           status = CASE WHEN status = 'applied' THEN status ELSE 'rejected' END
         WHERE id = ?`,
        [
          JSON.stringify(german).slice(0, 8000),
          JSON.stringify({
            status: "ineligible",
            blockers: [`${MANDATORY_GERMAN_REQUIREMENT}: ${german.detail}`],
            germanStatus: german.status,
            germanEvidence: german.evidence,
            reasonCode: german.reasonCode,
            checkedAt: now.toISOString(),
          }).slice(0, 12000),
          now.toISOString(),
          row.id,
        ],
      );
      // A dependent application may have been prepared by an earlier run. It is
      // no longer eligible, so it must not remain ready for submission or in a
      // manual-approval queue. Historical submitted outcomes are never
      // overwritten.
      run(
        `UPDATE applications SET status = 'rejected', submission_status = 'blocked',
           submission_evidence = ?, last_update = ?
         WHERE job_id = ? AND status NOT IN ('submitted','acknowledged','interview_invited')`,
        [
          JSON.stringify({
            outcomeClass: "blocked_external",
            reasonCode: MANDATORY_GERMAN_REQUIREMENT,
            germanStatus: german.status,
            germanEvidence: german.evidence,
            detail: german.detail,
          }).slice(0, 12000),
          now.toISOString(),
          row.id,
        ],
      );
      changed += 1;
      continue;
    }
    if (german.status === "ambiguous" || german.status === "unknown") {
      run(
        `UPDATE jobs SET german_requirement = ?, language_evidence = ?,
           eligibility = CASE WHEN eligibility = 'eligible' THEN 'needs_review' ELSE eligibility END,
           qualified = 0,
           qualification_status = CASE WHEN qualification_status = 'qualified' THEN 'needs_review' ELSE qualification_status END,
           eligibility_notes = ?, eligibility_checked_at = ?
         WHERE id = ?`,
        [
          german.status,
          JSON.stringify(german).slice(0, 8000),
          JSON.stringify({
            status: "needs_review",
            reasons: [german.detail],
            germanStatus: german.status,
            germanEvidence: german.evidence,
            reasonCode: GERMAN_REQUIREMENT_UNRESOLVED,
            checkedAt: now.toISOString(),
          }).slice(0, 12000),
          now.toISOString(),
          row.id,
        ],
      );
      changed += 1;
      continue;
    }
    if (row.german_requirement !== german.status) {
      run("UPDATE jobs SET german_requirement = ?, language_evidence = ? WHERE id = ?", [
        german.status,
        JSON.stringify(german).slice(0, 8000),
        row.id,
      ]);
    }
  }
  return changed;
}

function parseAnalysis(value: string | null): JobAnalysis | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as JobAnalysis;
  } catch {
    return null;
  }
}

/* ------------------------------ run creation ------------------------------ */

export function createRecruitmentRun(input: {
  trigger: RunTrigger;
  userId?: string;
  now?: Date;
  scheduledFor?: string | null;
  discoveryScope?: "full" | "incremental";
  /** Discovery + eligibility + scoring only: no documents, no submissions. */
  discoveryOnly?: boolean;
}): { run: RunRow; created: boolean; message: string } {
  const now = input.now ?? new Date();
  const running = activeRun();
  if (running) {
    return {
      run: running,
      created: false,
      message: `A recruitment run is already in progress (${running.status.replace(/_/g, " ")}). It will finish before another starts.`,
    };
  }
  if (memoryRunning) {
    const active = runById(memoryRunning);
    if (active) {
      return { run: active, created: false, message: "A recruitment run is already executing in this process." };
    }
  }

  const scope = input.discoveryScope === "incremental" ? "incremental" : "full";
  const scheduledFor =
    input.scheduledFor ??
    (input.trigger === "manual"
      ? now.toISOString()
      : nextRecruitmentOccurrence(now, { weekdays: RECRUITMENT_WEEKDAYS }).scheduledFor);
  const scheduledDate = new Date(scheduledFor);
  const dateKey = localDateKey(scheduledDate);
  // Each durable occurrence has its own key. The old once-per-day key would
  // collapse the 10:00 and every incremental run into a single record.
  const slotClock = (localClockTime(scheduledFor) ?? "scheduled").replace(":", "");
  const runKey =
    input.trigger === "manual"
      ? `${localDateKey(now)}#manual-${randomId().slice(0, 8)}`
      : `${dateKey}#${scope}-${slotClock}`;
  const existing = one<RunRow>("SELECT * FROM recruitment_runs WHERE run_key = ?", [runKey]);
  if (existing) {
    return { run: existing, created: false, message: `The ${scope} run for ${dateKey} at ${slotClock} already exists; it will not be duplicated.` };
  }

  const id = `run_${randomId()}`;
  try {
    run(
      `INSERT INTO recruitment_runs (id, run_key, scheduled_for, trigger, status, state_history, jobs_discovered, jobs_eligible, jobs_qualified,
        packages_prepared, applications_submitted, applications_unverified, applications_intervention, applications_simulated, failures, warnings, mode, discovery_scope, created_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
      [
        id,
        runKey,
        scheduledFor,
        input.trigger,
        JSON.stringify([{ state: "scheduled", at: now.toISOString() }]),
        input.discoveryOnly ? "discovery" : "full",
        scope,
        now.toISOString(),
      ],
    );
  } catch (error) {
    const raced = one<RunRow>("SELECT * FROM recruitment_runs WHERE run_key = ?", [runKey]);
    if (raced) return { run: raced, created: false, message: "Another process created this run first." };
    throw error;
  }
  const created = runById(id);
  if (!created) throw new Error("The recruitment run was inserted but could not be read back.");
  return { run: created, created: true, message: `Recruitment ${scope} run ${dateKey} ${slotClock} created.` };
}

export async function startDailyRun(input: {
  trigger: RunTrigger;
  userId?: string;
  now?: Date;
  scheduledFor?: string | null;
  discoveryScope?: "full" | "incremental";
  discoveryOnly?: boolean;
}): Promise<{ ok: boolean; runId?: string; message: string }> {
  const created = createRecruitmentRun(input);
  if (!created.created) {
    return { ok: created.run.status === "completed" || created.run.status === "completed_with_warnings", runId: created.run.id, message: created.message };
  }
  void executeRun(created.run.id, {
    userId: input.userId,
    now: input.now,
    discoveryOnly: input.discoveryOnly,
    discoveryScope: input.discoveryScope,
  }).catch((error) => {
    const message = error instanceof Error ? error.message : "The recruitment run crashed.";
    run("UPDATE recruitment_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [message, nowIso(), created.run.id]);
    recordScheduleRun({ runId: created.run.id, status: "failed", error: message, scheduledFor: created.run.scheduled_for });
  });
  return { ok: true, runId: created.run.id, message: "Recruitment run started." };
}

/* ------------------------------ submission QA ----------------------------- */

export type Readiness = { ready: boolean; state: string; reasons: string[]; items?: ReadinessItem[] };

type ApplicationRowLite = {
  id: string;
  job_id: string;
  status: string;
  cv_document_id: string | null;
  cover_letter_id: string | null;
  submitted_at: string | null;
  confirmation: string | null;
};

/**
 * Evidence text the candidate has actually verified: the uploaded master CV
 * plus structured profile facts. Readiness compares generated claims with this
 * text, never with model output.
 */
function verifiedEvidenceText(profile: ReturnType<typeof getProfileData>): string {
  const original = profile.profile.source_cv_id
    ? one<{ text_content: string | null }>("SELECT text_content FROM documents WHERE id = ?", [profile.profile.source_cv_id])
    : null;
  return [
    original?.text_content ?? "",
    profile.profile.full_name ?? "",
    profile.profile.headline ?? "",
    profile.profile.summary ?? "",
    ...profile.skills.map((skill) => skill.name),
    ...profile.experiences.flatMap((entry) => [entry.title, entry.company, entry.summary ?? "", entry.achievements ?? "", entry.projects ?? ""]),
    ...profile.items.flatMap((item) => [item.title, item.subtitle ?? "", item.detail ?? ""]),
    ...profile.languageEntries.map((entry) => `${entry.name} ${entry.level}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export function assessSubmissionReadiness(applicationId: string): Readiness {
  const app = one<ApplicationRowLite>(
    "SELECT id, job_id, status, cv_document_id, cover_letter_id, submitted_at, confirmation FROM applications WHERE id = ?",
    [applicationId],
  );
  if (!app) return { ready: false, state: "blocked", reasons: ["The application record does not exist."] };
  if (app.submitted_at || ["submitted", "acknowledged", "interview_invited"].includes(app.status)) {
    return { ready: false, state: "blocked", reasons: ["The application is already recorded as submitted."] };
  }
  const duplicate = Boolean(existingVerifiedSubmission(app.job_id));
  const job = jobLite(app.job_id);
  if (!job) return { ready: false, state: "blocked", reasons: ["The linked vacancy does not exist."] };

  const profile = getProfileData();
  const sourceText = verifiedEvidenceText(profile);
  const documentFor = (id: string | null) => {
    // (unchanged helper body follows)
    if (!id) return null;
    const row = one<{ text_content: string | null; quality_status: string | null; quality_score: number | null; relative_path: string }>(
      "SELECT text_content, quality_status, quality_score, relative_path FROM documents WHERE id = ? AND deleted_at IS NULL",
      [id],
    );
    if (!row) return null;
    return {
      id,
      text: row.text_content,
      qualityStatus: row.quality_status,
      qualityScore: row.quality_score,
      fileExists: existsSync(path.join(UPLOAD_DIR, path.basename(row.relative_path))),
    };
  };

  const policy = getRecruitmentPolicy();

  const result = evaluateReadiness({
    job: {
      title: job.title,
      company: job.company,
      location: job.location,
      application_url: job.application_url,
      url: job.url,
      published_at: job.published_at,
      description: job.description,
      eligibility: job.eligibility,
      eligibilityNotes: job.eligibility_notes,
      vacancyStatus: job.vacancy_status,
      vacancyVerifiedAt: job.vacancy_verified_at,
      urlConfidence: job.url_confidence,
      matchScore: job.match_score,
      analysis: parseAnalysis(job.analysis),
      coverLetterRequirements: resolveCoverLetterRequirements({
        description: job.description,
        requirementsJson: job.requirements,
        sourceUrl: job.application_url ?? job.url,
      }),
    },
    application: { id: app.id, status: app.status, submittedAt: app.submitted_at },
    profile: {
      fullName: profile.profile.full_name,
      email: profile.profile.email,
      phone: profile.profile.phone,
      workAuthorisation: profile.profile.work_authorisation,
      skills: profile.skills.map((skill) => skill.name),
      certifications: profile.items.filter((item) => /cert/i.test(item.kind)).map((item) => item.title),
      languages: profile.languageEntries.map((entry) => `${entry.name} ${entry.level}`),
      sourceText,
    },
    cv: documentFor(app.cv_document_id),
    cover: documentFor(app.cover_letter_id),
    threshold: qualifyingThreshold(),
    duplicateApplication: duplicate,
    submissionPolicy: {
      active: policy.active,
      autonomousSubmission: policy.autonomousSubmission,
      approvalRequired: policy.requirePerApplicationApproval,
      // The rolling daily cap is enforced immediately before each submission;
      // readiness records document/policy eligibility, not the hour of sending.
      dailyRemaining: null,
    },
    now: new Date(),
  });

  run("UPDATE applications SET readiness = ?, readiness_checked_at = ? WHERE id = ?", [
    JSON.stringify(result).slice(0, 16000),
    result.checkedAt,
    applicationId,
  ]);
  return { ready: result.ready, state: result.state, reasons: result.reasons, items: result.items };
}

/**
 * Checks that must pass before a document package is generated. The full
 * document/claim audit runs after generation; this gate stops known-ineligible
 * or stale vacancies before any model or PDF work is spent on them.
 */
function generationPreflight(jobId: string): { ok: boolean; reasons: string[] } {
  const job = jobLite(jobId);
  if (!job) return { ok: false, reasons: ["The vacancy no longer exists."] };
  const reasons: string[] = [];
  if (job.german_requirement === "required") {
    reasons.push(`${MANDATORY_GERMAN_REQUIREMENT}: the vacancy requires German.`);
  } else if (job.german_requirement === "ambiguous" || job.german_requirement === "unknown") {
    reasons.push(`${GERMAN_REQUIREMENT_UNRESOLVED}: the German requirement is unresolved.`);
  }
  if (job.eligibility !== "eligible") reasons.push(`Eligibility is ${job.eligibility ?? "not assessed"}.`);
  if (job.match_score === null || job.match_score < qualifyingThreshold()) {
    reasons.push(`Match score ${job.match_score ?? "unknown"}% is below ${qualifyingThreshold()}%.`);
  }
  if (!job.application_url && !job.url) reasons.push("No application URL is recorded.");
  const coverLetter = resolveCoverLetterRequirements({
    description: job.description,
    requirementsJson: job.requirements,
    sourceUrl: job.application_url ?? job.url,
  });
  if (coverLetter.conflicts.length > 0) {
    reasons.push(`Cover-letter instructions conflict: ${coverLetter.conflicts.join(" ")}`);
  }
  if (coverLetter.supportingDocuments.length > 0) {
    reasons.push(`The vacancy requests supporting document(s) that the package does not create: ${coverLetter.supportingDocuments.join(", ")}.`);
  }
  // Publication age is not evidence that a vacancy is closed. Currentness is
  // decided by the live vacancy verification that runs before this preflight.
  if (job.vacancy_status && job.vacancy_status !== "open") {
    reasons.push(`The live vacancy check recorded ${job.vacancy_status}.`);
  }
  const profile = getProfileData();
  if (!profile.profile.full_name?.trim() || !profile.profile.email?.trim()) reasons.push("The verified profile is incomplete.");
  const master = profile.profile.source_cv_id
    ? one<{ id: string }>("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL", [profile.profile.source_cv_id])
    : null;
  if (!master) reasons.push("No uploaded master CV is available.");
  return { ok: reasons.length === 0, reasons };
}

/* -------------------------------- execution ------------------------------- */

export type RunDeps = {
  discover?: (context: { runId: string; pages: number; scope: "full" | "incremental" }) => Promise<DiscoveryResult>;
  prepare?: (jobId: string, workflowId: string) => Promise<PackageOutcome>;
  submit?: (input: SubmissionInput) => Promise<SubmissionOutcome>;
  analyse?: (jobId: string) => JobAnalysis | null;
  /** Test fixtures may inject a local-page verifier; production uses the real fetch gate. */
  verifyVacancy?: (jobId: string) => Promise<VacancyVerification>;
  now?: Date;
};

export type RunOutcome = {
  runId: string;
  status: RunState;
  discovered: number;
  eligible: number;
  qualified: number;
  prepared: number;
  submitted: number;
  unverified: number;
  intervention: number;
  simulated: number;
  warnings: string[];
  failures: string[];
  report: string;
};

function updateCounts(runId: string, counts: Partial<Record<
  "jobs_discovered" | "jobs_duplicates" | "jobs_filtered" | "jobs_updated" | "jobs_eligible" | "jobs_qualified" |
  "sources_checked" | "sources_succeeded" | "sources_failed" | "sources_partial" |
  "packages_prepared" | "applications_submitted" |
  "applications_unverified" | "applications_intervention" | "applications_simulated" | "failures" | "warnings", number>>): void {
  const keys = Object.keys(counts) as Array<keyof typeof counts>;
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(", ");
  run(`UPDATE recruitment_runs SET ${assignments} WHERE id = ?`, [...keys.map((key) => counts[key] ?? 0), runId]);
}

export async function executeRun(
  runId: string,
  options: {
    userId?: string;
    pageBudget?: number;
    maxApplications?: number;
    now?: Date;
    deps?: RunDeps;
    /** A caller may force the discovery scope; persisted run scope wins otherwise. */
    discoveryScope?: "full" | "incremental";
    /** Scoring and reporting only; documents and submissions are skipped. */
    discoveryOnly?: boolean;
    /** Reconstruct from persisted checkpoints and reuse completed outputs. */
    resume?: boolean;
  } = {},
): Promise<RunOutcome> {
  const runRow = runById(runId);
  if (!runRow) throw new Error("Recruitment run not found.");
  if (runRow.status === "completed" || runRow.status === "completed_with_warnings") {
    return {
      runId,
      status: runRow.status,
      discovered: runRow.jobs_discovered,
      eligible: runRow.jobs_eligible,
      qualified: runRow.jobs_qualified,
      prepared: runRow.packages_prepared,
      submitted: runRow.applications_submitted,
      unverified: runRow.applications_unverified,
      intervention: runRow.applications_intervention,
      simulated: runRow.applications_simulated,
      warnings: [],
      failures: [],
      report: runRow.report ?? buildRunReport(runId),
    };
  }
  if (memoryRunning && memoryRunning !== runId) {
    throw new Error("Another recruitment run is already executing.");
  }
  const runLockKey = `recruitment:run:${runId}`;
  if (!acquireRuntimeLock(runLockKey, 300_000, undefined, { runId })) {
    return {
      runId,
      status: runRow.status,
      discovered: runRow.jobs_discovered,
      eligible: runRow.jobs_eligible,
      qualified: runRow.jobs_qualified,
      prepared: runRow.packages_prepared,
      submitted: runRow.applications_submitted,
      unverified: runRow.applications_unverified,
      intervention: runRow.applications_intervention,
      simulated: runRow.applications_simulated,
      warnings: ["Another application instance holds the active run lease; this process did not execute the run."],
      failures: [],
      report: runRow.report ?? buildRunReport(runId),
    };
  }
  const runLease = setInterval(() => refreshRuntimeLock(runLockKey, 300_000), 60_000);
  runLease.unref?.();
  memoryRunning = runId;

  const discoveryOnly = options.discoveryOnly === true || runRow.mode === "discovery";
  const discoveryScope =
    options.discoveryScope ?? (runRow.discovery_scope === "incremental" ? "incremental" : "full");
  const deps = options.deps ?? {};
  const now = deps.now ?? options.deps?.now ?? new Date();
  // Recover abandoned `submitting` leases before this run reads any readiness or
  // duplicate state. The recovered outcome is unverified, never successful.
  recoverStaleSubmissionClaims(now);
  // The language rule is re-applied before any scoring, package or submission,
  // including on vacancies stored by earlier runs.
  enforceStoredGermanExclusion(now);
  const warnings: string[] = [];
  const failures: string[] = [];
  let allSourcesFailed = false;
  const userId = ownerUserId(options.userId);
  const pages = Math.min(5, Math.max(1, options.pageBudget ?? 2));
  const policy = getRecruitmentPolicy();
  // A caller can narrow the daily cap for a test, never widen it past the
  // owner's persisted policy.
  const maxApplications = Math.min(
    policy.maxSubmissionsPerDay,
    Math.max(1, options.maxApplications ?? policy.maxSubmissionsPerDay),
  );
  const threshold = qualifyingThreshold();
  const dryRun = getSetting<boolean>("recruitment_dry_run", false) || process.env.RECRUITMENT_DRY_RUN === "true";
  const submissionEnabled =
    getSetting<boolean>("recruitment_submission_enabled", true) && process.env.RECRUITMENT_SUBMISSION_ENABLED !== "false";
  const submissionAllowed = policy.active && policy.autonomousSubmission && submissionEnabled;
  const usageToday = dailySubmissionUsage(now);
  const selectionLimit = Math.min(maxApplications, usageToday.remaining);
  if (!policy.active) {
    warnings.push(
      "Automatic submission is paused in settings. This run is a non-submitting simulation: packages may be prepared, but no application is sent.",
    );
  } else if (usageToday.remaining === 0) {
    warnings.push(
      `The daily limit of ${policy.maxSubmissionsPerDay} verified submission(s) has already been reached for ${localDateKey(now)}. Qualifying vacancies are left for the next day.`,
    );
  }

  let workflowId: string | null = null;
  let runStatus: RunState = "failed";

  try {
    pushState(runId, "starting", `${agentIdentity("coordinator").name} ${options.resume ? "resumed" : "created"} the daily recruitment run.`);
    run("UPDATE recruitment_runs SET started_at = COALESCE(started_at, ?) WHERE id = ?", [now.toISOString(), runId]);
    // A restart must continue the existing workflow and task ledger. Replacing
    // it would orphan completed tasks and make the run look like new work.
    workflowId = runRow.workflow_id;
    if (workflowId) {
      run("UPDATE workflows SET status = 'running', finished_at = NULL WHERE id = ?", [workflowId]);
    } else {
      workflowId = createWorkflow("autonomous_recruitment", `Daily autonomous recruitment · ${runRow.run_key}`, userId);
      run("UPDATE recruitment_runs SET workflow_id = ? WHERE id = ?", [workflowId, runId]);
    }

    const plan = attemptTask("coordinator", workflowId, "Create the daily recruitment run", "Assign discovery, eligibility, scoring, documents, quality and submission");
    logAgent({ runId, agentKey: "coordinator", assignment: "Create the daily recruitment run and assign specialists", status: "completed", output: `Run ${runRow.run_key} started. Threshold ${threshold}%.` });
    safeComplete(plan.taskId, "coordinator", `Daily run ${runRow.run_key} assigned. Minimum match score ${threshold}%.`);
    if (plan.warning) warnings.push(plan.warning);

    /* 1. Discovery */
    pushState(runId, "searching", "Career research is searching Ashby boards, employer pages and the job feed.");
    const discoveryCheckpoint = checkpointFor(runId, "", "discovery");
    const persistedDiscoveryJobIds = all<{ id: string }>("SELECT id FROM jobs WHERE run_id = ? ORDER BY discovered_at", [runId]).map((row) => row.id);
    const reuseDiscovery = options.resume === true && discoveryCheckpoint?.status === "completed" && persistedDiscoveryJobIds.length >= 0;
    const researchTask = reuseDiscovery
      ? { taskId: null, warning: null }
      : attemptTask("research", workflowId, "Search configured sources for QA vacancies", `${pages} page(s) · Ashby · employer career pages · Arbeitnow`, {
          dependsOn: plan.taskId ? [plan.taskId] : [],
        });
    logAgent({ runId, agentKey: "research", assignment: "Discover QA vacancies across all configured sources", status: "running" });
    let discovery: DiscoveryResult;
    try {
      discovery = reuseDiscovery
        ? {
            discovered: persistedDiscoveryJobIds.length,
            inserted: persistedDiscoveryJobIds.length,
            duplicates: runRow.jobs_duplicates,
            updated: runRow.jobs_updated,
            filtered: runRow.jobs_filtered,
            jobIds: persistedDiscoveryJobIds,
            sources: [],
            warnings: ["Discovery was not repeated: the completed checkpoint and persisted vacancies were reused."],
            scope: discoveryScope,
            since: runRow.discovery_since,
            discoveryState: "ok",
          }
        : deps.discover
          ? await deps.discover({ runId, pages, scope: discoveryScope })
          : await discoverJobSources({ runId, pages, scope: discoveryScope });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Discovery failed.";
      allSourcesFailed = true;
      failures.push(`Discovery: ${message}`);
      logAgent({ runId, agentKey: "research", assignment: "Discover vacancies", status: "failed", error: message, finishedAt: nowIso() });
      safeFail(researchTask.taskId, "research", message);
      // Preserve the run and any previously qualified backlog. Do not invent a
      // vacancy and do not rerun discovery against the same failed endpoints.
      discovery = {
        discovered: 0,
        inserted: 0,
        duplicates: 0,
        updated: 0,
        filtered: 0,
        jobIds: [],
        sources: [],
        warnings: [`Discovery unavailable: ${message}`],
        scope: discoveryScope,
        since: null,
      };
    }
    for (const warning of discovery.warnings) warnings.push(warning);
    run("UPDATE recruitment_runs SET discovery_since = ? WHERE id = ?", [discovery.since ?? null, runId]);
    const sourceSummary = discovery.sources
      .map((source) => `${source.label}: ${source.fetched} fetched / ${source.inserted} new / ${source.updated ?? 0} updated${source.error ? ` (${source.error})` : ""}`)
      .join("; ");
    logAgent({
      runId,
      agentKey: "research",
      assignment: "Discover QA vacancies across all configured sources",
      status: "completed",
      output: `${discovery.inserted} new, ${discovery.updated} updated, ${discovery.duplicates} duplicates, ${discovery.filtered} rejected. ${sourceSummary}`,
      finishedAt: nowIso(),
    });
    safeComplete(
      researchTask.taskId,
      "research",
      `${discovery.inserted} new vacancies; ${discovery.updated} updated; ${discovery.duplicates} duplicate listing(s) blocked; ${discovery.filtered} posting(s) rejected. ${sourceSummary}`,
    );
    const checkedSources = discovery.sources.filter((source) => (source.requests ?? 0) > 0);
    const succeededSources = checkedSources.filter((source) => (source.responses ?? 0) > 0);
    const failedSources = checkedSources.filter((source) => (source.responses ?? 0) === 0);
    const partialSources = succeededSources.filter((source) => Boolean(source.error));
    allSourcesFailed = discovery.allSourcesFailed ?? (checkedSources.length > 0 && succeededSources.length === 0);
    recordStage({
      runId,
      stage: "discovery",
      status: allSourcesFailed ? "failed" : "completed",
      outputRefs: { jobIds: [...new Set(discovery.jobIds)] },
      evidence: { inserted: discovery.inserted, updated: discovery.updated, duplicates: discovery.duplicates, filtered: discovery.filtered },
      reason: allSourcesFailed ? "All configured sources failed." : null,
      errorClass: allSourcesFailed ? "provider_unavailable" : null,
      now,
    });
    const discoveryState =
      discovery.discoveryState ??
      (checkedSources.length === 0
        ? "not_configured"
        : succeededSources.length === 0
          ? "failed"
          : partialSources.length > 0 || failedSources.length > 0
            ? "partial"
            : discovery.inserted === 0
              ? "empty"
              : "ok");
    if (allSourcesFailed) {
      const message = `All ${checkedSources.length} configured job source(s) failed; discovery is not reported as successful.`;
      if (!failures.includes(message)) failures.push(message);
      if (!warnings.some((warning) => /All .* configured source\(s\) failed/i.test(warning))) warnings.push(message);
    }
    run("UPDATE recruitment_runs SET discovery_state = ? WHERE id = ?", [discoveryState, runId]);
    updateCounts(runId, {
      jobs_discovered: discovery.inserted,
      jobs_duplicates: discovery.duplicates,
      jobs_filtered: discovery.filtered,
      jobs_updated: discovery.updated,
      sources_checked: checkedSources.length,
      sources_succeeded: succeededSources.length,
      sources_failed: failedSources.length,
      sources_partial: partialSources.length,
      warnings: warnings.length,
    });
    notify({
      userId,
      kind: "job_discovery_completed",
      dedupeKey: `discovery:${runId}`,
      subject: `Job discovery completed: ${discovery.inserted} new`,
      body: `${discovery.inserted} new vacancy(ies) stored, ${discovery.updated} previously known vacancy(ies) updated, ${discovery.duplicates} duplicate listing(s) blocked, ${discovery.filtered} posting(s) rejected. ${sourceSummary}`,
      email: false,
    });

    /* 2. Eligibility and scoring */
    pushState(runId, "analysing", "Eligibility and evidence-based scoring are running for every discovered vacancy.");
    const analysisTask = attemptTask("analysis", workflowId, "Assess eligibility and score vacancies", "Swiss residency · sponsorship · languages · weighted match", {
      dependsOn: researchTask.taskId ? [researchTask.taskId] : [],
    });
    logAgent({ runId, agentKey: "analysis", assignment: "Assess eligibility and score every discovered vacancy", status: "running" });
    let eligibleCount = 0;
    const qualifiedJobs: Array<{ id: string; score: number }> = [];
    // A source may repeat an id across queries; the same vacancy is assessed and
    // prepared only once in this run.
    const discoveredJobIds = [...new Set(discovery.jobIds)];
    for (const jobId of discoveredJobIds) {
      const job = jobLite(jobId);
      if (!job) continue;
      const eligibilityDone = options.resume === true && checkpointFor(runId, jobId, "eligibility")?.status === "completed";
      if (eligibilityDone && job.eligibility) {
        if (job.eligibility === "eligible") eligibleCount += 1;
        if (Number(job.qualified) === 1) qualifiedJobs.push({ id: jobId, score: job.match_score ?? 0 });
        continue;
      }
      const eligibility = assessEligibility(
        {
          title: job.title,
          company: job.company,
          location: job.location,
          description: job.description,
          remote: job.remote,
          application_url: job.application_url,
          url: job.url,
          published_at: job.published_at,
          employment_type: job.employment_type,
          german_requirement: job.german_requirement,
          language_evidence: job.language_evidence,
        },
        getProfileData(),
        now,
      );
      const analysis = deps.analyse ? deps.analyse(jobId) : analyseSingleJob(jobId);
      const score = analysis?.score ?? job.match_score ?? 0;
      const autoApply = eligibility.status === "eligible" && score >= threshold && (!analysis || qualifiesForAutoApply(analysis));
      if (eligibility.status === "eligible") eligibleCount += 1;
      // A job assessed by this run belongs to it, even when it was stored by an
      // earlier discovery. The report and the submission verification both read
      // the run's jobs through this link.
      run("UPDATE jobs SET run_id = COALESCE(NULLIF(run_id, ''), ?) WHERE id = ?", [runId, jobId]);
      // The internal qualification outcome is stored explicitly. The legacy
      // `status` bucket remains for compatibility, but it is never an employer
      // decision and the UI labels it as an internal selection result.
      const qualificationStatus = qualificationStatusFor({
        eligible: eligibility.status,
        score,
        threshold,
        qualified: autoApply,
        hardBlocker: Boolean(analysis && autoApplyBlockers(analysis).length > 0),
      });
      run(
        `UPDATE jobs SET eligibility = ?, eligibility_notes = ?, eligibility_checked_at = ?, qualified = ?,
           qualification_status = ?,
           status = CASE WHEN status IN ('applied','rejected') THEN status WHEN ? = 1 THEN 'shortlisted' ELSE 'rejected' END
         WHERE id = ?`,
        [
          eligibility.status,
          JSON.stringify(eligibility).slice(0, 12000),
          eligibility.checkedAt,
          autoApply ? 1 : 0,
          qualificationStatus,
          autoApply ? 1 : 0,
          jobId,
        ],
      );
      recordStage({
        runId,
        jobId,
        stage: "eligibility",
        status: "completed",
        outputRefs: { jobId, eligibility: eligibility.status, matchScore: score, qualified: autoApply },
        evidence: { eligibilityNotes: eligibility.reasons.slice(0, 4), analysis: Boolean(analysis) },
        now,
      });
      if (autoApply) qualifiedJobs.push({ id: jobId, score });
      else {
        const reason =
          eligibility.status !== "eligible"
            ? `Eligibility: ${eligibility.blockers[0] ?? eligibility.reasons[0] ?? eligibility.status}`
            : score < threshold
              ? `Match ${score}% is below ${threshold}%.`
              : (analysis ? autoApplyBlockers(analysis)[0] : "A hard blocker prevents automatic application.");
        logAgent({
          runId,
          agentKey: analysis ? "analysis" : "research",
          assignment: `Assess ${job.title} at ${job.company}`,
          status: "completed",
          output: `Not qualified — ${reason}`,
          decision: "Excluded from automatic application",
          finishedAt: nowIso(),
        });
      }
    }
    qualifiedJobs.sort((a, b) => b.score - a.score);
    const strongMatches = all<{ title: string; company: string; match_score: number }>(
      "SELECT title, company, match_score FROM jobs WHERE run_id = ? AND match_flag = 'strong' ORDER BY match_score DESC LIMIT 5",
      [runId],
    );
    if (strongMatches.length > 0) {
      notify({
        userId,
        kind: "strong_match",
        dedupeKey: `strong_match:${runId}`,
        subject: `${strongMatches.length} strong match${strongMatches.length === 1 ? "" : "es"} discovered`,
        body: strongMatches.map((job) => `${job.title} at ${job.company} — ${job.match_score}%`).join("\n"),
        email: false,
      });
    }
    logAgent({
      runId,
      agentKey: "analysis",
      assignment: "Assess eligibility and score every discovered vacancy",
      status: "completed",
      output: `${discoveredJobIds.length} vacancies assessed; ${eligibleCount} eligible; ${qualifiedJobs.length} at or above ${threshold}%.`,
      finishedAt: nowIso(),
    });
    safeComplete(
      analysisTask.taskId,
      "analysis",
      `${discoveredJobIds.length} vacancies assessed with stored evidence. ${eligibleCount} eligible, ${qualifiedJobs.length} scored ${threshold}% or higher.`,
    );
    updateCounts(runId, { jobs_eligible: eligibleCount, jobs_qualified: qualifiedJobs.length });

    // Per-source contribution: discovery counters plus what this run's scoring
    // actually did with the vacancies found by each source.
    const sourceKeyFor = (source: string): string =>
      source.startsWith("career:")
        ? "career_pages"
        : source.startsWith("greenhouse:")
          ? "greenhouse"
          : source.startsWith("lever:")
            ? "lever"
            : source;
    const metricsByKey = new Map<string, SourceMetrics>();
    for (const source of discovery.sources) {
      metricsByKey.set(source.key, {
        key: source.key,
        label: source.label,
        requests: source.requests,
        responses: source.responses,
        postings: source.fetched,
        fresh: source.fresh,
        relevant: source.relevant,
        duplicates: source.duplicates,
        inserted: source.inserted,
        updated: source.updated ?? 0,
        errors: source.error ? 1 : 0,
        eligible: 0,
        qualified: 0,
        attempts: source.attempts,
        durationMs: source.durationMs,
        status: source.status,
        rejectionReasons: source.rejectionReasons,
        rejectedSamples: source.rejectedSamples,
      });
    }
    const assessed = all<{ source: string; eligibility: string | null; qualified: number }>(
      "SELECT source, eligibility, qualified FROM jobs WHERE run_id = ?",
      [runId],
    );
    for (const row of assessed) {
      const metric = metricsByKey.get(sourceKeyFor(row.source));
      if (!metric) continue;
      if (row.eligibility === "eligible") metric.eligible += 1;
      if (Number(row.qualified) === 1) metric.qualified += 1;
    }
    run("UPDATE recruitment_runs SET source_metrics = ? WHERE id = ?", [JSON.stringify([...metricsByKey.values()]), runId]);

    /* 2b. AI match evaluation — advisory only, scores are never changed. */
    pushState(runId, "analysing", "Ali is reviewing the highest-scoring vacancies with the configured model.");
    const aiEvaluations: Array<{
      jobId: string;
      note: string | null;
      provider: string | null;
      model: string | null;
      ok: boolean;
    }> = [];
    if (!providerConfigured()) {
      logAgent({
        runId,
        agentKey: "analysis",
        assignment: "Review the assessed vacancies with the configured model",
        status: "blocked",
        output: zeroSpendSummary(),
        executionMode: "deterministic",
        finishedAt: nowIso(),
      });
      warnings.push(
        `${zeroSpendSummary()} AI match evaluation was skipped; deterministic eligibility and scoring remain authoritative.`,
      );
    } else {
      for (const jobId of discoveredJobIds.slice(0, 5)) {
        const job = jobLite(jobId);
        if (!job) continue;
        const analysis = parseAnalysis(job.analysis);
        const started = nowIso();
        const result = await aiStep({
          agentKey: "analysis",
          workflowId,
          taskId: analysisTask.taskId,
          system:
            "You are Ali, the Job Analysis Agent. Judge only the supplied evidence. " +
            "Never change a score, never invent experience and never claim that an employer was contacted.",
          prompt: [
            `Vacancy: ${job.title} at ${job.company}${job.location ? ` (${job.location})` : ""}.`,
            job.remote ? "The posting is marked remote." : "The posting is not marked remote.",
            `Deterministic match score: ${job.match_score ?? 0}% against a ${threshold}% automation threshold. Eligibility rule result: ${job.eligibility ?? "not assessed"}.`,
            `Matched evidence: ${analysis?.matched.slice(0, 10).join(", ") || "none"}.`,
            `Missing evidence: ${analysis?.missing.slice(0, 8).join(", ") || "none"}.`,
            `Recorded concerns: ${analysis?.concerns.slice(0, 4).join(" ") || "none"}.`,
            `Excerpt: ${(job.description ?? "").replace(/\s+/g, " ").slice(0, 1800)}`,
            "Answer in at most four sentences: (1) is this a genuine fit for a hands-on senior QA automation engineer rather than keyword overlap, (2) is there a hard blocker such as mandatory German, a non-Swiss location without remote eligibility, seniority or a mandatory domain, (3) do you recommend apply or hold.",
            "Do not change the score and do not invent experience.",
          ].join("\n"),
          maxTokens: 320,
        });
        if (result.ok && result.text) run("UPDATE jobs SET ai_note = ? WHERE id = ?", [result.text.slice(0, 2000), jobId]);
        aiEvaluations.push({ jobId, note: result.text, provider: result.provider, model: result.model, ok: result.ok });
        logAgent({
          runId,
          agentKey: "analysis",
          assignment: `AI review of ${job.title} at ${job.company}`,
          status: result.ok ? "completed" : result.blocked ? "blocked" : "failed",
          output: result.ok ? result.text : null,
          error: result.ok ? null : result.error,
          decision: result.ok
            ? "Advisory assessment only; the stored score and eligibility are unchanged."
            : result.blocked
              ? "Deterministic scoring used; the advisory AI route was unavailable, so no AI assessment was transmitted."
              : "Deterministic scoring used; the AI assessment failed.",
          executionMode: result.ok ? "ai" : "deterministic",
          provider: result.provider,
          model: result.model,
          startedAt: started,
          finishedAt: nowIso(),
        });
        if (!result.ok) {
          warnings.push(
            result.blocked
              ? `AI match evaluation for ${job.title} at ${job.company} was blocked before transmission: ${result.error}`
              : `AI match evaluation for ${job.title} at ${job.company} failed: ${result.error}`,
          );
        }
      }
    }

    /* 2c. Coordinator decision — advisory only. */
    if (providerConfigured()) {
      const vacancyLines = discoveredJobIds
        .slice(0, 5)
        .map((jobId) => {
          const job = jobLite(jobId);
          if (!job) return null;
          const evaluation = aiEvaluations.find((item) => item.jobId === jobId);
          return `- ${job.title} at ${job.company}${job.location ? ` (${job.location})` : ""} · score ${job.match_score ?? 0}% · eligibility ${job.eligibility ?? "unknown"} · ${job.qualified === 1 ? "qualified" : "not qualified"}${evaluation?.note ? ` · AI assessment: ${evaluation.note.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
        })
        .filter((line): line is string => Boolean(line))
        .join("\n");
      const started = nowIso();
      const result = await aiStep({
        agentKey: "coordinator",
        workflowId,
        taskId: plan.taskId,
        system: COORDINATOR_SYSTEM,
        prompt: [
          `Daily autonomous recruitment run ${runRow.run_key} (${discoveryOnly ? "discovery only" : "full"}).`,
          `Threshold: ${threshold}%. Discovered ${discovery.inserted}, eligible ${eligibleCount}, qualified ${qualifiedJobs.length}.`,
          vacancyLines || "No vacancy was stored by this run.",
          "Deterministic rules already decided eligibility, score and qualification; you cannot change them and nothing is submitted in this mode.",
          vacancyLines
            ? "Use only the vacancies listed above. Never invent vacancy ids, employers, requirements or evidence."
            : "This run assessed no vacancy. Do not list, rank, name or invent any vacancy.",
          vacancyLines
            ? "Give: (1) a priority order for the qualifying vacancies, (2) any vacancy you would hold and the evidence for it, (3) one operational note for the next scheduled run. At most five short sentences."
            : "Give one operational note for the next scheduled run. At most three sentences.",
        ].join("\n"),
        maxTokens: 400,
      });
      const supplied = vacancyLines ? vacancyLines.split("\n").length : 0;
      const supported = result.ok && coordinatorOutputSupported(result.text ?? "", supplied);
      if (result.ok && !supported) {
        warnings.push("Coordinator output was withheld: it referenced vacancies that were not part of this run.");
      }
      logAgent({
        runId,
        agentKey: "coordinator",
        assignment: "Review the run and decide the next actions",
        status: result.ok ? "completed" : result.blocked ? "blocked" : "failed",
        output: supported
          ? result.text
          : result.ok
            ? "Advisory withheld: the model referenced vacancies absent from the run evidence."
            : null,
        error: result.ok ? null : result.error,
        decision: supported
          ? result.text
          : result.ok
            ? "AI advisory withheld; deterministic rules retained authority."
            : result.blocked
              ? "AI review was blocked before transmission; deterministic rules retained authority."
              : "AI review unavailable; deterministic rules retained authority.",
        executionMode: result.ok ? "ai" : "deterministic",
        provider: result.provider,
        model: result.model,
        startedAt: started,
        finishedAt: nowIso(),
      });
      if (!result.ok) {
        const reviewFailure = result.blocked
          ? `Coordinator AI review was blocked before transmission: ${result.error}`
          : `Coordinator AI review failed: ${result.error}`;
        warnings.push(reviewFailure);
        if (!result.blocked) failures.push(reviewFailure);
      }
    }

    /* 3. Documents */
    const selected = qualifiedJobs.slice(0, selectionLimit);
    if (qualifiedJobs.length > selected.length && selectionLimit > 0) {
      warnings.push(
        `${qualifiedJobs.length - selected.length} qualifying vacancy(ies) remain for a later run because the daily submission limit is ${policy.maxSubmissionsPerDay}.`,
      );
    }
    let prepared = 0;
    const packagesByJob = new Map<string, PackageOutcome>();
    if (!discoveryOnly && selected.length > 0) {
      pushState(runId, "preparing_applications", `Preparing a tailored CV and cover letter for ${selected.length} qualifying vacanc${selected.length === 1 ? "y" : "ies"}.`);
      for (const item of selected) {
        const job = jobLite(item.id);
        if (!job) continue;
        const validationDecision = options.resume
          ? decideStageRecovery({ runId, jobId: item.id, stage: "vacancy_validation", now, leaseActive: false })
          : null;
        const reuseVacancyEvidence =
          validationDecision?.action === "complete" || validationDecision?.action === "reuse";
        const vacancyCheck = reuseVacancyEvidence
          ? null
          : await verifyVacancyForRun(item.id, deps, deps.now ?? now);
        if (!reuseVacancyEvidence) {
          recordStage({
            runId,
            jobId: item.id,
            stage: "vacancy_validation",
            status: vacancyCheck?.status === "open" ? "completed" : "failed",
            outputRefs: vacancyCheck?.status === "open" ? { jobId: item.id, vacancyStatus: "open" } : {},
            evidence: { vacancyStatus: vacancyCheck?.status ?? null },
            reason: vacancyCheck?.status === "open" ? null : vacancyCheck?.reason ?? "Vacancy verification failed.",
            errorClass: vacancyCheck?.status === "open" ? null : "validation",
            now,
          });
        }
        if (!reuseVacancyEvidence && (!vacancyCheck || vacancyCheck.status !== "open")) {
          const reason = vacancyCheck?.reason ?? "The vacancy could not be found for final verification.";
          warnings.push(`Final vacancy verification blocked ${job.title} at ${job.company}: ${reason}`);
          logAgent({
            runId,
            agentKey: "ats",
            assignment: `Final vacancy verification for ${job.title}`,
            status: "failed",
            error: reason,
            decision: "No documents were generated and no application will be submitted until the live vacancy is verified.",
            finishedAt: nowIso(),
          });
          continue;
        }
        if (reuseVacancyEvidence) {
          logAgent({
            runId,
            agentKey: "ats",
            assignment: `Final vacancy verification for ${job.title}`,
            status: "completed",
            output: "The persisted open-vacancy checkpoint was reused; the external check was not repeated.",
            decision: "Completed evidence was preserved across the restart.",
            finishedAt: nowIso(),
          });
        }
        const preflight = generationPreflight(item.id);
        if (!preflight.ok) {
          warnings.push(`Package skipped for ${job.title} at ${job.company}: ${preflight.reasons.join(" ")}`);
          logAgent({
            runId,
            agentKey: "ats",
            assignment: `Generation preflight for ${job.title}`,
            status: "failed",
            error: preflight.reasons.join(" "),
            decision: "No documents were generated; the vacancy remains queued for review.",
            finishedAt: nowIso(),
          });
          continue;
        }
        let pkg: PackageOutcome | null = null;
        const packageDecision = options.resume
          ? decideStageRecovery({ runId, jobId: item.id, stage: "package_assembly", now, leaseActive: false })
          : null;
        if (packageDecision?.action === "complete" || packageDecision?.action === "reuse") {
          pkg = {
            ok: true,
            message: "Persisted application package reused; no document was regenerated.",
            applicationId: String(packageDecision.outputRefs.applicationId ?? ""),
            cvDocumentId: String(packageDecision.outputRefs.cvDocumentId ?? ""),
            coverDocumentId: String(packageDecision.outputRefs.coverDocumentId ?? ""),
            warnings: [],
          };
          logAgent({
            runId,
            agentKey: "cv",
            assignment: `Create tailored CV for ${job.title}`,
            status: "completed",
            output: "The persisted, validated document package was reused after restart.",
            decision: "Completed document and package outputs were preserved.",
            finishedAt: nowIso(),
          });
        }
        let lastError: string | null = null;
        for (let attempt = 1; attempt <= 2 && !(pkg && pkg.ok); attempt += 1) {
          const started = nowIso();
          try {
            pkg = deps.prepare
              ? await deps.prepare(item.id, workflowId)
              : await generateApplicationPackage(userId, item.id, {
                  workflowId,
                  resumeStage: options.resume ? "reuse" : undefined,
                  dependsOn: analysisTask.taskId ? [analysisTask.taskId] : [],
                });
            if (!pkg.ok) lastError = pkg.message;
          } catch (error) {
            lastError = error instanceof Error ? error.message : "Document generation failed.";
          }
          if (pkg?.ok) {
            logAgent({ runId, agentKey: "cv", assignment: `Create tailored CV for ${job.title}`, status: "completed", attempt, output: `Tailored CV stored${pkg.cvDocumentId ? ` (${pkg.cvDocumentId})` : ""} with its quality record.`, startedAt: started, finishedAt: nowIso() });
            logAgent({ runId, agentKey: "cover", assignment: `Create tailored cover letter for ${job.title}`, status: "completed", attempt, output: `Tailored cover letter stored${pkg.coverDocumentId ? ` (${pkg.coverDocumentId})` : ""} with its quality record.`, startedAt: started, finishedAt: nowIso() });
          } else if (attempt < 2) {
            logAgent({ runId, agentKey: "cv", assignment: `Create and tailor documents for ${job.title}`, status: "retried", attempt, error: lastError, startedAt: started, finishedAt: nowIso(), decision: "Coordinator retried once with the same verified facts." });
          } else {
            logAgent({ runId, agentKey: "cv", assignment: `Create and tailor documents for ${job.title}`, status: "failed", attempt, error: lastError, startedAt: started, finishedAt: nowIso(), decision: "Queued for human intervention; the run continues." });
          }
        }
        if (!pkg?.ok) {
          const documentError = lastError ?? "unknown failure";
          failures.push(`Documents for ${job.title} at ${job.company}: ${documentError}`);
          const app = one<{ id: string }>("SELECT id FROM applications WHERE job_id = ?", [item.id]);
          if (app) {
            run("UPDATE applications SET status = 'awaiting_documents', run_id = ?, last_update = ? WHERE id = ?", [runId, nowIso(), app.id]);
          }
          enqueueDocumentRecovery({
            runId,
            jobId: item.id,
            applicationId: app?.id ?? null,
            error: documentError,
          });
          continue;
        }
        prepared += 1;
        packagesByJob.set(item.id, pkg);
        run("UPDATE jobs SET document_state = 'prepared' WHERE id = ?", [item.id]);
        if (pkg.applicationId) {
          run("UPDATE applications SET run_id = ?, status = CASE WHEN status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN status ELSE 'quality_check' END, last_update = ? WHERE id = ?", [runId, nowIso(), pkg.applicationId]);
          run("UPDATE documents SET run_id = ? WHERE job_id = ? AND deleted_at IS NULL AND kind IN ('tailored_cv','cover_letter')", [runId, item.id]);
          if (!packageDecision || (packageDecision.action !== "complete" && packageDecision.action !== "reuse")) {
            recordApplicationEvent({ applicationId: pkg.applicationId, type: "documents.prepared", message: "Tailored CV and cover letter prepared by the document agents.", meta: { ats: pkg.atsScore ?? null } });
          }
        }
      }
    }
    updateCounts(runId, { packages_prepared: prepared, failures: failures.length, warnings: warnings.length });

    /* 4. Quality gate */
    pushState(runId, "quality_checking", "The ATS agent is independently checking each application package.");
    const ready: Array<{ applicationId: string; jobId: string; job: JobLiteForDocs }> = [];
    const qualityTasksByJob = new Map<string, string>();
    for (const item of discoveryOnly ? [] : selected) {
      const job = jobLite(item.id);
      if (!job) continue;
      const app = one<{ id: string }>("SELECT id FROM applications WHERE job_id = ?", [item.id]);
      if (!app) {
        logAgent({ runId, agentKey: "ats", assignment: `Quality check ${job.title}`, status: "failed", error: "No application record was created.", decision: "Coordinator queued the vacancy for human intervention." });
        continue;
      }
      const pkg = packagesByJob.get(item.id);
      const packageGate = attemptTask(
        "ats",
        workflowId,
        `Independently validate ${job.title} application package`,
        "Kali validates the complete CV and cover-letter package after Amira.",
        {
          dependsOn: [pkg?.cvTaskId, pkg?.coverTaskId].filter((id): id is string => Boolean(id)),
        },
      );
      if (packageGate.warning) warnings.push(packageGate.warning);
      if (packageGate.taskId) qualityTasksByJob.set(item.id, packageGate.taskId);
      const readinessCheckpoint = checkpointFor(runId, item.id, "readiness");
      const readinessEvidence = deriveStageEvidence(runId, item.id, "readiness");
      const reuseReadiness =
        options.resume === true &&
        readinessCheckpoint?.status === "completed" &&
        readinessEvidence.state === "complete";
      if (reuseReadiness) {
        run(
          "UPDATE applications SET status = CASE WHEN status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN status ELSE 'ready_to_submit' END, last_update = ? WHERE id = ?",
          [nowIso(), app.id],
        );
        if (packageGate.taskId) {
          completeTask(
            packageGate.taskId,
            "ats",
            "The persisted readiness and complete package evidence were reused; the gate was not bypassed.",
          );
        }
        logAgent({
          runId,
          agentKey: "ats",
          assignment: `Quality check ${job.title}`,
          status: "completed",
          output: "The persisted readiness state was reused; the package was not regenerated.",
          decision: "The completed readiness output survived the restart.",
          finishedAt: nowIso(),
        });
        ready.push({ applicationId: app.id, jobId: item.id, job });
        continue;
      }
      const readiness = assessSubmissionReadiness(app.id);
      recordStage({
        runId,
        jobId: item.id,
        stage: "readiness",
        status: readiness.ready ? "completed" : readiness.state === "quality_review_required" ? "waiting" : "failed",
        outputRefs: readiness.ready ? { applicationId: app.id, readinessState: readiness.state } : {},
        evidence: { readinessState: readiness.state, reasons: readiness.reasons.slice(0, 5) },
        reason: readiness.ready ? null : readiness.reasons[0] ?? "Readiness did not pass.",
        errorClass: readiness.ready ? null : "validation",
        now,
      });
      if (readiness.ready) {
        run(
          "UPDATE applications SET status = CASE WHEN status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN status ELSE 'ready_to_submit' END, last_update = ? WHERE id = ?",
          [nowIso(), app.id],
        );
        if (packageGate.taskId) {
          completeTask(
            packageGate.taskId,
            "ats",
            "Independent package gate passed: CV, cover letter, eligibility, duplicates and readiness evidence all passed.",
            false,
            { outputRefs: { applicationId: app.id, readinessState: readiness.state } },
          );
        }
        logAgent({ runId, agentKey: "ats", assignment: `Quality check ${job.title}`, status: "completed", output: "All mandatory fields, documents, quality evidence, eligibility and duplicate checks passed.", finishedAt: nowIso() });
        ready.push({ applicationId: app.id, jobId: item.id, job });
      } else if (readiness.state === "quality_review_required") {
        if (packageGate.taskId) {
          failTask(
            packageGate.taskId,
            "ats",
            `Independent package gate requires review: ${readiness.reasons.join(" ")}`,
            "validation",
            { outputRefs: { applicationId: app.id, readinessState: readiness.state } },
          );
        }
        run("UPDATE applications SET status = 'quality_review_required', last_update = ? WHERE id = ?", [nowIso(), app.id]);
        recordApplicationEvent({ applicationId: app.id, type: "quality.review", message: readiness.reasons.join(" ") });
        logAgent({
          runId,
          agentKey: "ats",
          assignment: `Quality check ${job.title}`,
          status: "completed",
          output: `Quality review required: ${readiness.reasons.join(" ")}`,
          decision: "Coordinator withheld submission and queued the package for evidence-based quality review.",
          finishedAt: nowIso(),
        });
        warnings.push(`Quality review required for ${job.title} at ${job.company}: ${readiness.reasons[0]}`);
        notify({
          kind: "ats_blocked",
          dedupeKey: `quality_review:${runId}:${item.id}`,
          subject: `Document quality review required: ${job.title}`,
          body: `${job.company} was not submitted because a quality gate returned a warning: ${readiness.reasons.slice(0, 3).join(" ")}`,
        });
      } else if (readiness.state === "documents_ready") {
        // The documents and quality gates passed; only the owner's automatic
        // submission switch is paused. This is not a per-application approval
        // gate and must not create an approval queue item.
        run("UPDATE applications SET status = 'ready_to_submit', last_update = ? WHERE id = ?", [nowIso(), app.id]);
        recordApplicationEvent({ applicationId: app.id, type: "quality.ready", message: readiness.reasons.join(" ") });
        if (packageGate.taskId) {
          completeTask(
            packageGate.taskId,
            "ats",
            `Independent package gate passed; automatic submission is paused by policy: ${readiness.reasons.join(" ")}`,
            false,
            { outputRefs: { applicationId: app.id, readinessState: readiness.state } },
          );
        }
        logAgent({
          runId,
          agentKey: "ats",
          assignment: `Quality check ${job.title}`,
          status: "completed",
          output: `Documents are ready; automatic submission is paused: ${readiness.reasons.join(" ")}`,
          decision: "Coordinator marked the package ready for submission. No per-application approval is required; sending waits only for the owner-level automatic-submission switch.",
          finishedAt: nowIso(),
        });
      } else {
        if (packageGate.taskId) {
          failTask(
            packageGate.taskId,
            "ats",
            `Independent package gate blocked the application: ${readiness.reasons.join(" ")}`,
            "validation",
            { outputRefs: { applicationId: app.id, readinessState: readiness.state } },
          );
        }
        run("UPDATE applications SET status = 'human_intervention_required', last_update = ? WHERE id = ?", [nowIso(), app.id]);
        recordApplicationEvent({ applicationId: app.id, type: "quality.blocked", message: readiness.reasons.join(" ") });
        logAgent({
          runId,
          agentKey: "ats",
          assignment: `Quality check ${job.title}`,
          status: "failed",
          error: readiness.reasons.join(" "),
          decision: "Coordinator stopped this application and queued it for human intervention.",
          finishedAt: nowIso(),
        });
        warnings.push(`Quality gate stopped ${job.title} at ${job.company}: ${readiness.reasons[0]}`);
        notify({
          kind: "ats_blocked",
          dedupeKey: `quality_blocked:${runId}:${item.id}`,
          subject: `Application documents need attention: ${job.title}`,
          body: `${job.company} was not submitted because a mandatory document/quality check failed: ${readiness.reasons.slice(0, 3).join(" ")}`,
        });
      }
    }

    /* 5. Submission */
    let submitted = 0;
    let unverified = 0;
    let intervention = 0;
    let simulated = 0;
    const submissionTasks: string[] = [];
    if (ready.length > 0) {        pushState(
        runId,
        "submitting",
        dryRun
          ? "Dry run: packages are recorded without contacting an employer."
          : !policy.active
            ? "Simulation: automatic submission is paused, so nothing is sent."
            : "Submitting qualified applications through the verified candidate channel without per-application approval.",
      );
      for (const item of ready) {
        const submitTask = attemptTask(
          "application",
          workflowId,
          `Submit ${item.job.title} at ${item.job.company}`,
          "Noor submits only after Kali's persisted package gate and verifies employer confirmation.",
          { dependsOn: qualityTasksByJob.get(item.jobId) ? [qualityTasksByJob.get(item.jobId)!] : [] },
        );
        if (submitTask.taskId) submissionTasks.push(submitTask.taskId);
        if (submitTask.warning) warnings.push(submitTask.warning);
        const finishSubmissionTask = (status: "completed" | "failed", output: string, errorClass?: "validation" | "submission_ambiguous" | "blocked") => {
          if (!submitTask.taskId) return;
          if (status === "completed") completeTask(submitTask.taskId, "application", output);
          else failTask(submitTask.taskId, "application", output, errorClass ?? "validation");
        };
        // Submission is irreversible. A restart must inspect the persisted
        // employer outcome before even entering the send function: a verified
        // attempt is reused, and an ambiguous or failed attempt is reconciled or
        // stopped instead of being retried blind.
        const employerEvidence = deriveStageEvidence(runId, item.jobId, "employer_submission");
        if (employerEvidence.state === "complete") {
          submitted += 1;
          recordSubmissionCheckpoints(runId, item.jobId, now);
          finishSubmissionTask("completed", "The persisted verified employer submission was reused; no second request was sent.");
          logAgent({
            runId,
            agentKey: "application",
            assignment: `Submit ${item.job.title}`,
            status: "completed",
            output: "The persisted verified employer submission was reused; no second request was sent.",
            decision: "Verified submission evidence survived the restart.",
            finishedAt: nowIso(),
          });
          continue;
        }
        if (employerEvidence.state === "ambiguous") {
          unverified += 1;
          run(
            "UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified', last_update = ? WHERE id = ? AND status != 'submitted'",
            [nowIso(), item.applicationId],
          );
          recordSubmissionCheckpoints(runId, item.jobId, now);
          finishSubmissionTask("failed", employerEvidence.reason ?? "The employer submission outcome is ambiguous.", "submission_ambiguous");
          logAgent({
            runId,
            agentKey: "application",
            assignment: `Submit ${item.job.title}`,
            status: "failed",
            error: employerEvidence.reason,
            decision: "Submission outcome is ambiguous; no retry was attempted without employer reconciliation.",
            finishedAt: nowIso(),
          });
          notify({
            kind: "application_submission_unverified",
            dedupeKey: `submission_ambiguous_checkpoint:${runId}:${item.jobId}`,
            subject: `Submission needs reconciliation: ${item.job.title}`,
            body: `${item.job.company} may already have received this application. ${employerEvidence.reason} It was not resubmitted automatically.`,
          });
          continue;
        }
        if (employerEvidence.state === "failed") {
          intervention += 1;
          recordSubmissionCheckpoints(runId, item.jobId, now);
          finishSubmissionTask("failed", employerEvidence.reason ?? "The prior employer response was terminal.", "blocked");
          logAgent({
            runId,
            agentKey: "application",
            assignment: `Submit ${item.job.title}`,
            status: "skipped",
            error: employerEvidence.reason,
            decision: "The prior employer response was terminal; the application was not automatically retried.",
            finishedAt: nowIso(),
          });
          continue;
        }
        const usage = dailySubmissionUsage(deps.now ?? now);
        if (usage.remaining <= 0) {
          const limitMessage = `Daily submission limit reached; ${item.job.title} at ${item.job.company} remains ready for the next day.`;
          warnings.push(limitMessage);
          finishSubmissionTask("completed", limitMessage);
          break;
        }
        const finalVacancyCheck = await verifyVacancyForRun(item.jobId, deps, deps.now ?? now);
        if (!finalVacancyCheck || finalVacancyCheck.status !== "open") {
          const reason = finalVacancyCheck?.reason ?? "The vacancy could not be found for final verification.";
          intervention += 1;
          warnings.push(`Submission blocked for ${item.job.title} at ${item.job.company}: final vacancy verification failed — ${reason}`);
          run("UPDATE applications SET status = 'human_intervention_required', last_update = ? WHERE id = ?", [nowIso(), item.applicationId]);
          recordApplicationEvent({ applicationId: item.applicationId, type: "vacancy.blocked", message: reason });
          finishSubmissionTask("failed", `The live vacancy could not be verified: ${reason}`, "validation");
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "failed", error: reason, decision: "No application was sent because the live vacancy could not be verified.", finishedAt: nowIso() });
          continue;
        }
        const input = await submissionInputFor(item.applicationId, item.job, runId, deps.now ?? now);
        if (!input) {
          intervention += 1;
          warnings.push(`Application ${item.applicationId} could not be assembled for submission.`);
          finishSubmissionTask("failed", "The application package could not be assembled for submission.", "validation");
          continue;
        }
        if (!submissionAllowed || dryRun) {
          const reason = dryRun
            ? "Dry run requested: nothing was sent."
            : !policy.active
              ? "Automatic submission is paused in settings: this is a non-submitting simulation."
              : "Automatic submission is disabled in settings.";
          recordPolicySimulation({ applicationId: item.applicationId, jobId: item.jobId, reason, at: nowIso() });
          run(
            "UPDATE applications SET status = 'ready_to_submit', submission_status = 'simulated', last_update = ? WHERE id = ?",
            [nowIso(), item.applicationId],
          );
          recordApplicationEvent({ applicationId: item.applicationId, type: "submission.simulated", message: reason });
          finishSubmissionTask("completed", `${reason} No application was sent.`);
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "skipped", output: reason, decision: "The package reached the submission stage without per-application approval; no application was sent only because automatic submission is paused.", finishedAt: nowIso() });
          if (!dryRun) {
            notify({
              kind: "application_approval_required",
              dedupeKey: `approval_required:${runId}:${item.jobId}`,
              subject: `Application ready for your approval: ${item.job.title}`,
              body: `${item.job.company} is prepared but was not submitted. ${reason}`,
            });
          }
          simulated += 1;
          continue;
        }
        logAgent({
          runId,
          agentKey: "application",
          assignment: `Submit ${item.job.title} at ${item.job.company}`,
          status: "running",
          output: "Verifying the candidate-facing application channel and answering only from verified data.",
        });
        let outcome: SubmissionOutcome;
        try {
          outcome = deps.submit ? await deps.submit(input) : await submitApplication(input);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Submission failed.";
          failures.push(`Submission for ${item.job.title}: ${message}`);
          // An unexpected throw can happen after the request was created, so the
          // safe state is unknown rather than a definite failure. It is never
          // retried without employer confirmation.
          run("UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified', last_update = ? WHERE id = ?", [nowIso(), item.applicationId]);
          finishSubmissionTask("failed", `Submission outcome is unknown: ${message}`, "submission_ambiguous");
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "failed", error: message, decision: "Submission outcome is unknown; the coordinator did not retry it blindly.", finishedAt: nowIso() });
          notify({
            kind: "application_submission_unverified",
            dedupeKey: `submission_unknown:${runId}:${item.jobId}`,
            subject: `Submission outcome unknown: ${item.job.title}`,
            body: `${item.job.company} may or may not have received the application. ${message} It is not counted as submitted and will not be retried without confirmation.`,
          });
          intervention += 1;
          continue;
        }
        recordSubmissionCheckpoints(runId, item.jobId, now);
        if (outcome.status === "verified") {
          submitted += 1;
          finishSubmissionTask("completed", outcome.detail);
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "completed", output: outcome.detail, decision: "Coordinator verified the employer reference before counting it.", finishedAt: nowIso() });
        } else if (outcome.status === "unverified") {
          unverified += 1;
          finishSubmissionTask("failed", `Submission was not verified: ${outcome.detail}`, "submission_ambiguous");
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "failed", error: outcome.detail, decision: "Not counted as submitted: no employer reference was returned.", finishedAt: nowIso() });
          notify({
            kind: "application_submission_unverified",
            dedupeKey: `submission_unverified:${runId}:${item.jobId}`,
            subject: `Submission unverified: ${item.job.title}`,
            body: `${item.job.company} did not return a confirmation reference. ${outcome.detail} It is not counted as submitted and must not be retried blindly.`,
          });
        } else if (submissionOutcomeClass(outcome) === "failed_technical") {
          // A broken form or unavailable local browser is not an approval
          // request. Record it as a technical failure so it cannot be mistaken
          // for a package awaiting the owner's decision or a delivered form.
          failures.push(`Submission for ${item.job.title}: ${outcome.detail}`);
          finishSubmissionTask("failed", `Technical submission failure: ${outcome.detail}`, "validation");
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "failed", error: outcome.detail, decision: "Technical submission failure; nothing was recorded as submitted and no approval gate was created.", finishedAt: nowIso() });
        } else {
          intervention += 1;
          finishSubmissionTask("failed", `Submission needs intervention: ${outcome.detail}`, "blocked");
          logAgent({ runId, agentKey: "application", assignment: `Submit ${item.job.title}`, status: "skipped", error: outcome.detail, decision: "Queued for human intervention; nothing was recorded as submitted.", finishedAt: nowIso() });
          notify({
            kind: "application_intervention",
            dedupeKey: `intervention:${runId}:${item.jobId}`,
            subject: `Application needs your attention: ${item.job.title}`,
            body: `${item.job.company} was not submitted. ${outcome.detail}`,
          });
        }
      }
    }

    /* 6. Verification */
    pushState(runId, "verifying_submissions", "Verifying that every recorded submission has employer evidence.");
    const verification = one<{ verified: number; unverified: number; intervention: number }>(
      `SELECT
         (SELECT COUNT(*) FROM application_events e JOIN applications a ON a.id = e.application_id JOIN jobs j ON j.id = a.job_id
            WHERE j.run_id = ? AND e.type = 'submission.verified') AS verified,
         (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? AND a.status = 'submission_unverified') AS unverified,
         (SELECT COUNT(*) FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? AND a.status = 'human_intervention_required') AS intervention`,
      [runId, runId, runId],
    );
    submitted = Number(verification?.verified ?? submitted);
    unverified = Number(verification?.unverified ?? unverified);
    intervention = Number(verification?.intervention ?? intervention);
    updateCounts(runId, {
      applications_submitted: submitted,
      applications_unverified: unverified,
      applications_intervention: intervention,
      applications_simulated: simulated,
      packages_prepared: prepared,
      failures: failures.length,
      warnings: warnings.length,
    });

    runStatus = allSourcesFailed ? "failed" : failures.length > 0 || warnings.length > 0 ? "completed_with_warnings" : "completed";
    const runError = allSourcesFailed
      ? `All configured job sources failed. ${failures.filter((failure) => !failure.startsWith("All ")).slice(0, 3).join(" | ")}`.trim()
      : failures.length
        ? failures.join(" | ").slice(0, 4000)
        : null;
    if (runStatus === "failed") {
      notify({
        userId,
        kind: "recruitment_run_failed",
        dedupeKey: `run_failed:${runId}`,
        subject: "Recruitment run failed: all job sources were unavailable",
        body: runError ?? "All configured job sources failed; no discovery success was claimed.",
        email: false,
      });
    }
    if (submitted > 0) {
      notify({
        userId,
        kind: "application_submitted",
        dedupeKey: `submitted:${runId}`,
        subject: `${submitted} application${submitted === 1 ? "" : "s"} submitted and verified`,
        body: `${submitted} submission(s) returned employer evidence. ${unverified} unverified and ${intervention} awaiting intervention. No unverified result is counted as successful.`,
        email: false,
      });
    }
    if (intervention > 0) {
      notify({
        userId,
        kind: "application_intervention",
        dedupeKey: `intervention:${runId}`,
        subject: `${intervention} application${intervention === 1 ? "" : "s"} need attention`,
        body: "A submission, CAPTCHA, MFA or quality gate requires human intervention. Nothing ambiguous was counted as submitted.",
      });
    }
    const report = `pending:${runId}`;
    run(
      "UPDATE recruitment_runs SET status = ?, finished_at = ?, report = ?, error = ?, warnings_json = ?, failures_json = ? WHERE id = ?",
      [
        runStatus,
        nowIso(),
        report,
        runError,
        JSON.stringify(warnings).slice(0, 40000),
        JSON.stringify(failures).slice(0, 40000),
        runId,
      ],
    );
    closeOpenAssignments(runId, runStatus === "failed" ? "failed" : "completed", "Stage reached its terminal result; no background work remains for this assignment.", workflowId);
    pushState(
      runId,
      runStatus,
      `${discovery.sources.reduce((sum, source) => sum + source.fetched, 0)} postings screened · ${discovery.inserted} new · ${qualifiedJobs.length} qualified · ${prepared} prepared · ${submitted} submitted and verified.`,
    );

    // A specialist that was not required is recorded as SKIPPED with the exact
    // dependency/reason. It is never left to look like a hidden success or an
    // unrecorded crash.
    const downstreamReason =
      discoveryOnly
        ? "No input: discovery-only run — document, quality and submission work was deliberately excluded."
        : qualifiedJobs.length === 0
          ? `No input: no vacancy reached the ${threshold}% threshold and all mandatory gates, so this specialist had no eligible work.`
          : prepared === 0
            ? "No input: no application package completed document preparation, so there was no input for this specialist."
            : "No input: no application package reached this stage after the preceding quality gate.";
    const withDependency = (dependency: string) => `${downstreamReason} Dependency: ${dependency}`;
    recordSkippedAgent({
      runId,
      workflowId,
      agentKey: "cv",
      assignment: "Create and tailor CV documents",
      reason: withDependency("Analysis must produce a new qualifying vacancy."),
    });
    recordSkippedAgent({
      runId,
      workflowId,
      agentKey: "cover",
      assignment: "Create tailored cover letters",
      reason: withDependency("CV Optimisation must produce a tailored CV."),
    });
    recordSkippedAgent({
      runId,
      workflowId,
      agentKey: "ats",
      assignment: "Run the independent quality gate",
      reason: prepared === 0
        ? withDependency("CV Optimisation and Cover Letter must produce a complete package.")
        : "No package required a further quality decision in this run.",
    });
    recordSkippedAgent({
      runId,
      workflowId,
      agentKey: "application",
      assignment: "Submit verified application packages",
      reason:
        ready.length === 0
          ? prepared === 0
            ? withDependency("ATS Quality Control must mark a package ready for submission.")
            : "No input: no package passed every readiness check, so nothing was eligible for submission. Dependency: ATS Quality Control readiness."
          : dryRun || !submissionAllowed
            ? "Safety/policy hold: the package was prepared but no submission was sent because the live policy or delivery channel was not active."
            : "No input: no eligible package remained after the submission limits and safety checks.",
    });

    // The Email & Tracking Agent's run-scoped job is to prepare the execution
    // report and hand it to the existing durable outbox. Delivery acceptance is
    // tracked separately; no Gmail success is claimed by this row.
    const trackingTask = attemptTask(
      "email",
      workflowId,
      "Track outcomes and prepare the administrator report",
      "Rayna tracks persisted submission outcomes and prepares report evidence.",
    );
    if (trackingTask.warning) warnings.push(trackingTask.warning);
    logAgent({
      runId,
      agentKey: "email",
      assignment: "Prepare the administrator execution report",
      status: "completed",
      output: `Structured agent evidence and report inputs are available to ${agentIdentity("coordinator").name} for the consolidated daily brief.`,
      decision: "The specialist does not send an owner-facing email; the Coordinator owns the daily report and delivery record.",
      finishedAt: nowIso(),
    });

    const finalReport = buildRunReport(runId, { warnings, failures });
    run("UPDATE recruitment_runs SET report = ? WHERE id = ?", [finalReport, runId]);
    if (trackingTask.taskId) {
      completeTask(
        trackingTask.taskId,
        "email",
        `Tracked ${submitted} verified submission(s), ${unverified} unverified outcome(s) and ${intervention} intervention(s); the consolidated report and outbox notification were recorded without claiming an employer response.`,
        false,
        { outputRefs: { submitted, unverified, intervention, failures: failures.length, warnings: warnings.length } },
      );
    }
    finishWorkflow(workflowId, runStatus === "failed" ? "failed" : "completed", finalReport.split("\n")[1] ?? "Daily recruitment run completed.");
    // A discovery-only run does not consume the daily schedule slot.
    if (!discoveryOnly && runRow.trigger !== "manual") {
      recordScheduleRun({
        runId,
        status: runStatus,
        now: deps.now ?? now,
        scheduledFor: runRow.scheduled_for ?? null,
      });
    }

    // The Coordinator's daily brief is the single owner-facing consolidated
    // report. Keep run completion visible in-app without emitting a competing
    // execution email for every run.
    notify({
      userId,
      kind: runStatus === "completed_with_warnings" ? "recruitment_partial" : "recruitment_run",
      dedupeKey: `execution_report:${runId}`,
      subject: runStatus === "completed_with_warnings"
        ? `Recruitment execution finished with ${warnings.length} warning(s)`
        : `Recruitment execution finished: ${submitted} verified submission(s)`,
      body: `${discovery.inserted} new vacancies, ${qualifiedJobs.length} qualified (>= ${threshold}%), ${prepared} prepared, ${submitted} submitted with evidence, ${unverified} unverified, ${intervention} needing attention. ${failures.length} failure(s), ${warnings.length} warning(s). The consolidated brief is generated by the Coordinator on its daily schedule.`,
      email: false,
    });
    audit({ action: "recruitment.run_completed", entity: "recruitment_run", entityId: runId, detail: `${runStatus}: ${submitted} verified submissions`, userId });

    return {
      runId,
      status: runStatus,
      discovered: discovery.inserted,
      eligible: eligibleCount,
      qualified: qualifiedJobs.length,
      prepared,
      submitted,
      unverified,
      intervention,
      simulated,
      warnings,
      failures,
      report: finalReport,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The recruitment run failed.";
    failures.push(message);
    const report = buildRunReport(runId, { failures, warnings });
    run(
      "UPDATE recruitment_runs SET status = 'failed', error = ?, finished_at = ?, failures = ?, warnings = ?, warnings_json = ?, failures_json = ?, report = ? WHERE id = ?",
      [
        message.slice(0, 4000),
        nowIso(),
        failures.length,
        warnings.length,
        JSON.stringify(warnings).slice(0, 40000),
        JSON.stringify(failures).slice(0, 40000),
        report,
        runId,
      ],
    );
    closeOpenAssignments(runId, "failed", "Run terminated before this assignment completed.", workflowId);
    pushState(runId, "failed", message);
    if (workflowId) finishWorkflow(workflowId, "failed", message);
    if (runRow.trigger !== "manual") {
      recordScheduleRun({
        runId,
        status: "failed",
        error: message,
        now: deps.now ?? now,
        scheduledFor: runRow.scheduled_for ?? null,
      });
    }
    notify({
      userId,
      kind: "recruitment_run_failed",
      dedupeKey: `run_failed:${runId}`,
      subject: "Recruitment run failed",
      body: message,
      email: false,
    });
    return {
      runId,
      status: "failed",
      discovered: 0,
      eligible: 0,
      qualified: 0,
      prepared: 0,
      submitted: 0,
      unverified: 0,
      intervention: 0,
      simulated: 0,
      warnings,
      failures,
      report,
    };
  } finally {
    clearInterval(runLease);
    releaseRuntimeLock(runLockKey);
    if (memoryRunning === runId) memoryRunning = null;
  }
}

/**
 * Resume an interrupted/failed run through the same durable workflow. The
 * caller does not need to know the failed stage: the checkpoint ledger decides
 * what is reusable, and the package layer reuses a validated document package
 * instead of creating a second one.
 */
export async function resumeRecruitmentRun(
  runId: string,
  options: {
    userId?: string;
    pageBudget?: number;
    maxApplications?: number;
    now?: Date;
    deps?: RunDeps;
    discoveryScope?: "full" | "incremental";
    discoveryOnly?: boolean;
  } = {},
): Promise<RunOutcome> {
  const runRow = runById(runId);
  if (!runRow) throw new Error("Recruitment run not found.");
  if (runtimeLockActive(`recruitment:run:${runId}`, options.now ?? new Date())) {
    throw new Error("The run still has an active worker lease; it cannot be resumed concurrently.");
  }
  const plan = buildStagePlan({ runId, now: options.now });
  pushState(
    runId,
    "starting",
    plan.currentStage
      ? `Restart resumed at persisted stage ${plan.currentStage}; completed outputs are reused.`
      : "Restart resumed from persisted checkpoints; completed outputs are reused.",
  );
  return executeRun(runId, { ...options, resume: true });
}

type JobLiteForDocs = {
  title: string; company: string; url: string | null; application_url: string | null; description: string | null;
  source?: string | null; external_id?: string | null;
  url_confidence?: string | null; employer_url?: string | null;
};

async function verifyVacancyForRun(
  jobId: string,
  dependencies: RunDeps,
  now: Date,
): Promise<VacancyVerification | null> {
  const job = jobLite(jobId);
  if (!job) return null;
  if (dependencies.verifyVacancy) {
    const result = await dependencies.verifyVacancy(jobId);
    // The injected verifier is used by fixtures and by the acceptance run; its
    // verdict must still reach the row, otherwise the generation preflight sees
    // the discovery default ("new") and skips a vacancy that was just verified.
    if (result && (result.status === "open" || result.status === "closed")) {
      run("UPDATE jobs SET vacancy_status = ?, vacancy_verified_at = ? WHERE id = ?", [
        result.status,
        now.toISOString(),
        jobId,
      ]);
    }
    return result;
  }
  return verifyAndPersistVacancy(
    {
      id: job.id,
      title: job.title,
      company: job.company,
      url: job.url,
      application_url: job.application_url,
      description: job.description,
      published_at: job.published_at,
      source: job.source,
      company_domain: job.company_domain,
      expiry_at: job.expiry_at,
    },
    { now },
  );
}

async function submissionInputFor(
  applicationId: string,
  job: JobLiteForDocs,
  runId: string,
  now: Date,
): Promise<SubmissionInput | null> {
  const app = one<{ id: string; job_id: string; cv_document_id: string | null; cover_letter_id: string | null }>(
    "SELECT id, job_id, cv_document_id, cover_letter_id FROM applications WHERE id = ?",
    [applicationId],
  );
  if (!app) return null;
  const cv = app.cv_document_id
    ? one<{ relative_path: string; display_name: string; text_content: string | null }>(
        "SELECT relative_path, display_name, text_content FROM documents WHERE id = ?",
        [app.cv_document_id],
      )
    : null;
  const cover = app.cover_letter_id
    ? one<{ relative_path: string; display_name: string; text_content: string | null }>(
        "SELECT relative_path, display_name, text_content FROM documents WHERE id = ?",
        [app.cover_letter_id],
      )
    : null;
  const fullProfile = getProfileData();
  const profile = fullProfile.profile;
  const answered = all<{ field: string | null; answer: string | null }>(
    "SELECT field, answer FROM application_interventions WHERE application_id = ? AND status = 'resolved' AND answer IS NOT NULL ORDER BY resolved_at",
    [applicationId],
  );
  const applicationAnswers: Record<string, string> = {};
  for (const row of answered) {
    if (row.field && row.answer) applicationAnswers[row.field] = row.answer;
  }
  const experienceText = fullProfile.experiences
    .map((entry) =>
      [
        `${entry.title} — ${entry.company}`,
        [entry.start_date, entry.end_date ?? (entry.is_current ? "Present" : null)].filter(Boolean).join(" → "),
        entry.summary ?? "",
        entry.achievements ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
  const educationText = fullProfile.items
    .filter((item) => /education|degree|certification|course/i.test(item.kind))
    .map((item) => [item.title, item.subtitle ?? "", item.detail ?? ""].filter(Boolean).join(" — "))
    .join("\n");
  return {
    applicationId,
    job: {
      id: app.job_id,
      title: job.title,
      company: job.company,
      url: job.url,
      application_url: job.application_url,
      url_confidence: job.url_confidence ?? null,
      employer_url: job.employer_url ?? null,
      description: job.description,
      source: job.source ?? null,
      external_id: job.external_id ?? null,
    },
    documents: {
      cvPath: cv?.relative_path ?? null,
      cvName: cv?.display_name ?? null,
      coverPath: cover?.relative_path ?? null,
      coverName: cover?.display_name ?? null,
      coverText: cover?.text_content ?? null,
      coverDocumentId: app.cover_letter_id,
      cvDocumentId: app.cv_document_id,
    },
    runId,
    profile: {
      full_name: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      work_authorisation: profile.work_authorisation,
      headline: profile.headline,
      linkedin: profile.linkedin,
      website: profile.website,
      summary: profile.summary,
      skills: fullProfile.skills.map((skill) => skill.name),
      spokenLanguages: fullProfile.languageEntries.map((entry) => `${entry.name} (${entry.level})`),
      experienceText: experienceText || null,
      educationText: educationText || null,
    },
    authorisedAnswers: { ...authorisedAnswers(), ...applicationAnswers },
    now,
  };
}

/* --------------------------------- report -------------------------------- */

export function buildRunReport(runId: string, extra?: { failures?: string[]; warnings?: string[] }): string {
  const runRow = runById(runId);
  if (!runRow) return "Recruitment run not found.";
  const jobs = all<{
    id: string; title: string; company: string; location: string | null; match_score: number | null; eligibility: string | null;
    eligibility_notes: string | null; qualified: number; status: string; application_url: string | null; url: string | null;
    analysis: string | null;
  }>(
    `SELECT id, title, company, location, match_score, eligibility, eligibility_notes, qualified, status, application_url, url, analysis
     FROM jobs WHERE run_id = ? ORDER BY match_score DESC NULLS LAST`,
    [runId],
  );
  const applications = all<{
    id: string; job_id: string; status: string; submitted_at: string | null; confirmation_ref: string | null;
    confirmation: string | null; submission_status: string | null; title: string; company: string; match_score: number | null;
    readiness: string | null; readiness_checked_at: string | null;
  }>(
    `SELECT a.id, a.job_id, a.status, a.submitted_at, a.confirmation_ref, a.confirmation, a.submission_status,
            a.readiness, a.readiness_checked_at, j.title, j.company, j.match_score
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? ORDER BY a.created_at`,
    [runId],
  );
  const agents = all<{
    agent_key: string; assignment: string; status: string; attempt: number; output: string | null; error: string | null;
    coordinator_decision: string | null; execution_mode: string | null; provider: string | null; model: string | null;
  }>(
    "SELECT agent_key, assignment, status, attempt, output, error, coordinator_decision, execution_mode, provider, model FROM recruitment_run_agents WHERE run_id = ? ORDER BY id",
    [runId],
  );
  const schedule = one<{ next_run_at: string | null; last_checked_at: string | null; enabled: number }>(
    "SELECT next_run_at, last_checked_at, enabled FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  const interventions = all<{
    application_id: string; field: string | null; question: string; reason: string; kind: string; title: string; company: string;
  }>(
    `SELECT i.application_id, i.field, i.question, i.reason, i.kind, j.title, j.company
     FROM application_interventions i JOIN jobs j ON j.id = i.job_id
     WHERE j.run_id = ? AND i.status = 'open' ORDER BY i.created_at`,
    [runId],
  );
  const qualified = jobs.filter((job) => job.qualified === 1);
  const rejected = jobs.filter((job) => job.qualified !== 1);
  const verified = applications.filter((app) => app.status === "submitted" || app.submission_status === "verified");
  const prepared = applications.filter((app) => ["ready_to_submit", "quality_check", "submitted", "submission_unverified"].includes(app.status));
  const attention = applications.filter((app) => ["human_intervention_required", "submission_unverified"].includes(app.status));
  const failureList = [...(extra?.failures ?? []), ...(runRow.error ? [runRow.error] : [])].filter(Boolean);
  const warningList = extra?.warnings ?? [];
  let sourceMetrics: SourceMetrics[] = [];
  try {
    const parsed = JSON.parse(runRow.source_metrics ?? "[]");
    if (Array.isArray(parsed)) sourceMetrics = parsed as SourceMetrics[];
  } catch {
    sourceMetrics = [];
  }
  const checks = sourceHealth().filter(
    (check) => !runRow.started_at || check.last_checked_at >= runRow.started_at,
  );
  const failedSources = checks.filter((check) => check.ok !== 1);
  const staleSources = checks.filter((check) => check.ok === 1 && check.fresh === 0);

  const reasonFor = (job: {
    eligibility: string | null;
    eligibility_notes: string | null;
    match_score: number | null;
    analysis?: string | null;
  }) => {
    if (job.analysis) {
      try {
        const parsed = JSON.parse(job.analysis) as { mandatoryBlockers?: string[] };
        if (Array.isArray(parsed.mandatoryBlockers) && parsed.mandatoryBlockers.length > 0) {
          return `Mandatory requirement: ${parsed.mandatoryBlockers[0]}`;
        }
      } catch {
        // Fall through to the eligibility evidence.
      }
    }
    if (job.eligibility && job.eligibility !== "eligible") {
      try {
        const parsed = JSON.parse(job.eligibility_notes ?? "{}") as EligibilityAssessment;
        return `${job.eligibility}: ${parsed.blockers?.[0] ?? parsed.reasons?.[0] ?? "eligibility rule"}`;
      } catch {
        return `${job.eligibility}`;
      }
    }
    if (job.match_score !== null && job.match_score < qualifyingThreshold()) return `Match ${job.match_score}% is below ${qualifyingThreshold()}%.`;
    return "Did not meet the automatic-application rules.";
  };

  const zeroResultExplanation = (): string => {
    if (qualified.length > 0) {
      return `${qualified.length} vacancy(ies) met every rule; a zero-result explanation is not needed.`;
    }
    if (jobs.length === 0) {
      const fetched = sourceMetrics.reduce((sum, metric) => sum + metric.postings, 0);
      const fresh = sourceMetrics.reduce((sum, metric) => sum + metric.fresh, 0);
      const relevant = sourceMetrics.reduce((sum, metric) => sum + metric.relevant, 0);
      if (fetched === 0 && failedSources.length > 0) {
        return (
          `No configured source returned a readable response. This is a source-failure result, not a successful zero-result search. Failed endpoints: ${failedSources.map((check) => `${check.source_key} (${check.error ?? "unknown error"})`).join("; ")}. No vacancy was invented and the 85% threshold was not changed.`
        );
      }
      return (
        `${fetched.toLocaleString("en-GB")} posting(s) were screened, ${fresh.toLocaleString("en-GB")} were fresh and ${relevant} passed the QA relevance rule. ${runRow.jobs_duplicates ?? 0} listing(s) were already known, ${runRow.jobs_updated ?? 0} were updated and ${runRow.jobs_discovered} new vacancy(ies) were stored.` +
        (failedSources.length > 0
          ? ` ${failedSources.length} source endpoint(s) failed: ${failedSources.map((check) => `${check.source_key} (${check.error ?? "unknown error"})`).join("; ")}.`
          : " No configured source failed.") +
        " The 85% threshold was not lowered, publication age alone never rejects a listing, and no vacancy was invented."
      );
    }
    const ineligible = rejected.filter((job) => job.eligibility && job.eligibility !== "eligible").length;
    const below = rejected.filter((job) => job.eligibility === "eligible").length;
    const blockers = rejected.map((job) => reasonFor(job)).slice(0, 4);
    return (
      `${jobs.length} vacancy(ies) assessed; ${ineligible} were ineligible and ${below} were eligible but below the ${qualifyingThreshold()}% threshold or failed a mandatory rule.` +
      (blockers.length ? ` Main reasons: ${blockers.join(" | ").replace(/\.$/, "")}.` : "") +
      " The threshold was not lowered, and publication age alone does not reject an otherwise current vacancy."
    );
  };

  const lines: string[] = [];
  lines.push(`# Daily recruitment report — ${runRow.run_key}`);
  const screenedTotal = sourceMetrics.reduce((sum, metric) => sum + metric.postings, 0);
  const relevantTotal = sourceMetrics.reduce((sum, metric) => sum + metric.relevant, 0);
  lines.push(
    `${screenedTotal.toLocaleString("en-GB")} postings screened, ${relevantTotal} relevant, ${runRow.jobs_discovered} new vacancies stored, ${runRow.jobs_updated ?? 0} known vacancies updated, ${runRow.jobs_duplicates ?? 0} duplicate listing(s), ${runRow.jobs_filtered ?? 0} rejected during discovery, ${runRow.jobs_eligible} eligible, ${runRow.jobs_qualified} qualified at ${qualifyingThreshold()}% or higher, ${runRow.packages_prepared} package(s) prepared, ${runRow.applications_submitted} submitted and verified, ${runRow.applications_unverified} unverified, ${runRow.applications_simulated} simulated, ${runRow.applications_intervention} needing your attention. Run status: ${runRow.status.replace(/_/g, " ")}.`,
  );
  const scope = runRow.discovery_scope === "incremental" ? "incremental" : "full";
  lines.push(
    `Discovery scope: ${scope}. ${scope === "incremental" ? "New and source-updated vacancies were reconciled against the previous successful discovery; known vacancies were not reprocessed." : "Every enabled source was read in full and all new vacancies were reconciled."}`,
  );
  if (runRow.sources_checked) {
    lines.push(
      `Sources: ${runRow.sources_checked} checked, ${runRow.sources_succeeded} returned data, ${runRow.sources_partial ?? 0} partial, ${runRow.sources_failed} failed. Discovery state: ${runRow.discovery_state ?? "unknown"}.`,
    );
  }
  lines.push("");
  lines.push("## 1. Executive summary");
  lines.push(
    `Trigger: ${runRow.trigger}. Started ${formatInZone(runRow.started_at)}. Finished ${formatInZone(runRow.finished_at)}. ` +
      `${verified.length} application(s) carry an employer reference; ${runRow.applications_unverified} submission(s) are unverified; ${attention.length} need human intervention.`,
  );
  if ((runRow.mode ?? "full") === "discovery") {
    lines.push("Mode: discovery only — vacancies were discovered and assessed; no documents were prepared and nothing was submitted.");
  }
  lines.push("");
  lines.push("## 2. Jobs discovered");
  if (jobs.length === 0) lines.push(zeroResultExplanation());
  for (const job of jobs) {
    lines.push(`- ${job.title} — ${job.company}${job.location ? ` (${job.location})` : ""} · match ${job.match_score ?? "—"}% · ${job.application_url ? "application URL captured" : "no application URL"}`);
  }
  if (sourceMetrics.length > 0) {
    lines.push("");
    lines.push("Source contribution:");
    for (const metric of sourceMetrics) {
      lines.push(
        `- ${metric.label}: ${metric.status ?? "unknown"} · ${metric.requests} request(s), ${metric.responses} response(s), ${metric.attempts ?? 0} attempt(s), ${metric.durationMs ?? 0} ms, ${metric.postings} posting(s), ${metric.fresh} fresh, ${metric.relevant} relevant, ${metric.updated ?? 0} updated, ${metric.duplicates} duplicate(s), ${metric.inserted} new · ${metric.eligible} eligible · ${metric.qualified} qualified`,
      );
    }
  }
  if (checks.length > 0) {
    lines.push("");
    lines.push("Sources checked (latest retrieval):");
    for (const check of checks) {
      lines.push(
        `- ${check.source_key} · ${check.employer ?? "unknown employer"} · ${check.method} · ${check.endpoint} · last success ${formatInZone(check.last_success_at)} · ${check.postings} posting(s), ${check.fresh} fresh, ${check.relevant} relevant${check.ok !== 1 ? ` · FAILED: ${check.error ?? "unknown error"}` : ""}`,
      );
    }
    lines.push(
      `- ${checks.length - failedSources.length}/${checks.length} source endpoint(s) returned data; ${failedSources.length} failed; ${staleSources.length} returned no fresh posting.`,
    );
  } else {
    lines.push("");
    lines.push("No source retrieval record is available for this run.");
  }
  lines.push("");
  lines.push("## 3. Jobs rejected and reasons");
  if (rejected.length === 0) lines.push("Every analysed vacancy met the automatic-application rules.");
  for (const job of rejected) lines.push(`- ${job.title} — ${job.company}: ${reasonFor(job)}`);
  if (rejected.length > 0) {
    lines.push(`- ${rejected.filter((job) => job.eligibility === "ineligible").length} ineligible · ${rejected.filter((job) => job.eligibility === "needs_review").length} needing review · ${rejected.filter((job) => job.eligibility === "eligible").length} eligible but unqualified.`);
  }
  lines.push("");
  lines.push("## 4. Jobs scoring 85% or above");
  if (qualified.length === 0) lines.push(`No vacancy reached the ${qualifyingThreshold()}% threshold. The threshold was not lowered.`);
  for (const job of qualified) {
    let gaps = "";
    try {
      const parsed = JSON.parse(job.analysis ?? "{}") as { mandatoryBlockers?: string[] };
      if (parsed.mandatoryBlockers?.length) gaps = ` · mandatory gaps: ${parsed.mandatoryBlockers.join(" ")}`;
    } catch {
      gaps = "";
    }
    lines.push(`- ${job.title} — ${job.company} · ${job.match_score}%${gaps}`);
  }
  lines.push("");
  lines.push("Mandatory blockers are stored separately from weighted preferences. A score at or above 85% cannot override one.");
  lines.push("");
  lines.push("## 5. Applications prepared");
  if (prepared.length === 0) lines.push("No application package was prepared.");
  for (const app of prepared) lines.push(`- ${app.title} — ${app.company} (application ${app.id}) · ${app.status.replace(/_/g, " ")}`);
  lines.push("");
  lines.push("## 6. Applications successfully submitted");
  if (verified.length === 0) lines.push("No application was submitted with employer evidence.");
  for (const app of verified) lines.push(`- ${app.title} — ${app.company} · submitted ${formatInZone(app.submitted_at)}`);
  lines.push("");
  lines.push("## 7. Submission confirmations");
  if (verified.length === 0) lines.push("No confirmation reference was captured.");
  for (const app of verified) lines.push(`- ${app.company}: ${app.confirmation_ref ?? app.confirmation ?? "reference not returned"}`);
  lines.push("");
  lines.push("## 8. Applications needing your attention");
  if (attention.length === 0 && interventions.length === 0) lines.push("Nothing needs human intervention.");
  for (const app of attention) lines.push(`- ${app.title} — ${app.company}: ${app.submission_status ?? app.status.replace(/_/g, " ")}`);
  for (const item of interventions) {
    lines.push(`- QUESTION · ${item.title} — ${item.company}: ${item.question} (${item.reason})`);
  }
  lines.push("");
  lines.push("## 9. Agent failures and recovery actions");
  const delegatedTasks = all<{
    id: string;
    agent_key: string;
    title: string;
    status: string;
    error: string | null;
    recovery_state: string | null;
    error_class: string | null;
    retry_count: number;
  }>(
    "SELECT id, agent_key, title, status, error, recovery_state, error_class, retry_count FROM tasks WHERE run_id = ? ORDER BY created_at",
    [runId],
  );
  const participating = [...new Set(delegatedTasks.map((task) => task.agent_key))];
  const notAssigned = ["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"].filter(
    (key) => !participating.includes(key),
  );
  const recoveringTasks = delegatedTasks.filter(
    (task) => /retry|resum|recover/i.test(task.recovery_state ?? "") || task.status === "retry_scheduled",
  );
  lines.push(
    `Delegated tasks: ${delegatedTasks.length}; completed ${delegatedTasks.filter((task) => task.status === "completed").length}; failed ${delegatedTasks.filter((task) => task.status === "failed").length}; recovering ${recoveringTasks.length}.`,
  );
  lines.push(`Participating agents: ${participating.length ? participating.join(", ") : "none"}.`);
  lines.push(`Not assigned in this run: ${notAssigned.length ? notAssigned.join(", ") : "none"}.`);
  lines.push(
    `Applications: ${runRow.applications_submitted} submitted with employer evidence, ${runRow.applications_unverified} unverified, ${runRow.applications_intervention} requiring intervention.`,
  );
  if (recoveringTasks.length > 0) {
    for (const task of recoveringTasks) {
      lines.push(`- RECOVERY · ${task.agent_key} · ${task.title} · ${task.recovery_state ?? task.status} · retry ${task.retry_count}`);
    }
  } else {
    lines.push("No task entered recovery in this run.");
  }
  const problems = agents.filter((agent) => ["failed", "retried", "skipped"].includes(agent.status));
  if (problems.length === 0) lines.push("No agent failed or was skipped.");
  for (const agent of problems) lines.push(`- ${agent.agent_key} · ${agent.assignment} · ${agent.status} (attempt ${agent.attempt})${agent.error ? `: ${agent.error}` : ""}`);
  for (const failure of failureList) lines.push(`- Run failure: ${failure}`);
  for (const warning of warningList) lines.push(`- Warning: ${warning}`);
  lines.push("");
  lines.push("## 10. Next scheduled run");
  const nextClock = localClockTime(schedule?.next_run_at ?? null);
  lines.push(
    `${formatInZone(schedule?.next_run_at ?? null)}${nextClock ? ` (${nextClock} ${RECRUITMENT_TIMEZONE})` : ""}. ` +
      "The scheduler state is stored in the database and survives a restart, but the host and this application must be running at that time for the run to execute.",
  );
  lines.push("");
  lines.push("## 11. Agent execution and AI provenance");
  const analysisAi = agents.filter((agent) => agent.agent_key === "analysis" && agent.execution_mode === "ai");
  const aiCompleted = agents.filter((agent) => agent.execution_mode === "ai" && agent.status === "completed");
  const aiWithheld = agents.filter((agent) => /withheld/i.test(`${agent.output ?? ""} ${agent.coordinator_decision ?? ""}`));
  lines.push(`- AI evaluations completed: ${aiCompleted.length}; withheld: ${aiWithheld.length}.`);
  const aiProviders = [...new Set(analysisAi.map((agent) => `${agent.provider}/${agent.model}`))];
  const decisionRow = [...agents].reverse().find((agent) => agent.agent_key === "coordinator" && agent.coordinator_decision);
  lines.push(
    `- Deterministic discovery: ${agentIdentity("research").name}'s connectors fetched, filtered and deduplicated the postings above without model inference.`,
  );
  lines.push(
    "- AI-assisted research: none in this run; connector research is deterministic by design, so no model output was used to find or filter vacancies.",
  );
  lines.push(
    analysisAi.length === 0
      ? "- AI match evaluation: no model call was recorded. Deterministic scoring was the only assessment for this run."
      : `- AI match evaluation: ${analysisAi.length} model call(s) served by ${aiProviders.join(", ")}. The scores, eligibility results and the ${qualifyingThreshold()}% threshold were not altered by model output.`,
  );
  lines.push(
    decisionRow
      ? `- Coordinator decision (${decisionRow.provider ?? "deterministic"}/${decisionRow.model ?? "no model"}): ${String(decisionRow.coordinator_decision ?? "").replace(/\s+/g, " ").slice(0, 600)}`
      : "- Coordinator decision: no model-backed decision was recorded; the deterministic rules decided the run.",
  );
  lines.push("- Specialist execution:");
  for (const agent of agents) {
    lines.push(
      `  - ${agent.agent_key} · ${agent.status} · ${agent.execution_mode ?? "unrecorded"}${agent.provider ? ` · ${agent.provider}/${agent.model}` : ""} · ${agent.assignment}`,
    );
  }
  lines.push("");
  lines.push("## 12. Application readiness audit");
  const readinessRows = applications.filter((app) => app.readiness);
  if (readinessRows.length === 0) {
    lines.push(
      (runRow.mode ?? "full") === "discovery"
        ? "Discovery-only run: no package reached the readiness gate."
        : "No application reached the readiness gate.",
    );
  }
  for (const app of readinessRows) {
    try {
      const parsed = JSON.parse(app.readiness ?? "{}") as { ready?: boolean; state?: string; items?: ReadinessItem[] };
      const failed = (parsed.items ?? []).filter((entry) => !entry.passed);
      lines.push(
        `- ${app.title} — ${app.company}: ${parsed.state ?? (parsed.ready ? "ready_for_submission" : "blocked")}${failed.length ? ` (${failed.length} failed check(s)) — ${failed.map((entry) => `${entry.label}: ${entry.detail}`).join(" ")}` : ""}`,
      );
    } catch {
      lines.push(`- ${app.title} — ${app.company}: readiness record could not be parsed.`);
    }
  }
  lines.push("");
  lines.push("## 13. Eight-agent execution manifest");
  const manifest = buildExecutionManifest(runId);
  if (!manifest) {
    lines.push("The execution manifest could not be read.");
  } else {
    lines.push(`${manifest.summary} Dispatched ${manifest.dispatchedAgents}/${manifest.expectedAgents}; results received ${manifest.resultsReceived}; rejected ${manifest.resultsRejected}; handoffs completed ${manifest.handoffsCompleted}/${manifest.handoffsExpected}.`);
    for (const agent of manifest.agents) {
      lines.push(
        `- ${agent.name} · ${agent.state.replace(/_/g, " ")} · ${agent.recordsProcessed} record(s) · ${agent.durationMs === null ? "duration not recorded" : `${Math.round(agent.durationMs / 1000)}s`} · handoff ${agent.handoffTo ?? "none"}: ${agent.handoffComplete ? "completed" : "not completed"}${agent.error ? ` · ERROR: ${agent.error}` : ""}`,
      );
    }
  }
  lines.push("");
  lines.push("## 14. Why this run produced its result");
  if (runRow.discovery_state === "failed") {
    lines.push(
      "All configured sources failed. This run is recorded as failed and does not claim a successful discovery cycle. No vacancy or employer was invented.",
    );
  } else {
    lines.push(zeroResultExplanation());
  }
  lines.push("");
  lines.push("## 15. Standing authorisation and submission policy");
  const livePolicy = getRecruitmentPolicy();
  const liveUsage = dailySubmissionUsage(new Date());
  const heartbeat = schedule?.last_checked_at ? Date.parse(schedule.last_checked_at) : NaN;
  const heartbeatAge = Number.isFinite(heartbeat) ? Math.max(0, Math.round((Date.now() - heartbeat) / 1000)) : null;
  lines.push(`- Automatic submission: ${livePolicy.active ? "active" : livePolicy.activatedAt ? "paused or disabled" : "not activated — simulation only"}.`);
  lines.push(`- Minimum match: ${livePolicy.minMatchScore}% (floor enforced; never lowered by this run).`);
  lines.push(`- Daily cap: ${livePolicy.maxSubmissionsPerDay} verified submission(s); ${liveUsage.verified} used before this report, ${liveUsage.remaining} remaining today (${localDateKey(new Date())}, ${RECRUITMENT_TIMEZONE}).`);
  lines.push(`- Currentness: live vacancy verification required; publication age alone never rejects; duplicate applications blocked; no per-application approval.`);
  lines.push(`- Simulated packages: ${runRow.applications_simulated}; unverified: ${runRow.applications_unverified}; open questions: ${interventions.length}.`);
  if (schedule?.enabled === 1 && heartbeatAge !== null && heartbeatAge > 150) {
    lines.push(
      `- Scheduler heartbeat is ${heartbeatAge}s old. The Mac may be asleep, this application may be offline, or the scheduler may not be running; the next run is not claimed to have executed.`,
    );
  } else {
    lines.push(`- Scheduler heartbeat: ${schedule?.last_checked_at ? formatInZone(schedule.last_checked_at) : "no heartbeat recorded"}.`);
  }
  return lines.join("\n");
}
