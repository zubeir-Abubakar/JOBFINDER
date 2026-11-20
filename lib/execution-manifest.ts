import { all, one } from "./db";
import { AGENT_DEFINITIONS, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";

/**
 * Run-scoped execution truth.
 *
 * This module is the single source of truth for the run page, the workflow
 * visualization and the administrator email. It reads only persisted evidence:
 * `recruitment_run_agents`, the run's tasks, its applications and its stored
 * source metrics. Registration, a heartbeat or a coordinator sentence is not
 * evidence that an agent executed.
 */

export type ExecutionAgentState =
  | "RUNNING"
  | "COMPLETED"
  | "COMPLETED_WITH_ZERO_RESULTS"
  | "SKIPPED"
  | "DEGRADED"
  | "FAILED"
  | "BLOCKED"
  | "DISABLED"
  | "NOT_EXECUTED";

export type ExecutionSkipCategory = "NO_INPUT" | "SAFETY_POLICY" | "ORCHESTRATION_FAILURE";

/** Human labels that keep a legitimate skip separate from a missing execution. */
export function executionAgentStateLabel(
  state: ExecutionAgentState,
  skipCategory: ExecutionSkipCategory | null = null,
): string {
  if (state === "SKIPPED") {
    return skipCategory === "NO_INPUT" ? "SKIPPED — NO INPUT" : "SKIPPED — SAFETY/POLICY";
  }
  if (state === "NOT_EXECUTED") return "NOT EXECUTED — ORCHESTRATION FAILURE";
  if (state === "COMPLETED_WITH_ZERO_RESULTS") return "Completed with zero results";
  return state.charAt(0) + state.slice(1).toLowerCase();
}

export type ExecutionAgent = {
  key: AgentKey;
  name: string;
  role: string;
  expected: true;
  dispatched: boolean;
  executed: boolean;
  succeeded: boolean;
  state: ExecutionAgentState;
  stateLabel: string;
  skipCategory: ExecutionSkipCategory | null;
  taskIds: string[];
  latestTaskId: string | null;
  assignments: string[];
  output: string | null;
  error: string | null;
  reason: string | null;
  recordsProcessed: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  executionMode: string | null;
  provider: string | null;
  model: string | null;
  dependsOn: AgentKey[];
  retryCount: number;
  handoffFrom: AgentKey | null;
  handoffTo: AgentKey | null;
  handoffComplete: boolean;
};

export type ExecutionSource = {
  key: string;
  label: string;
  status: string;
  postings: number;
  fresh: number;
  relevant: number;
  duplicates: number;
  inserted: number;
  errors: number;
  eligible: number;
  qualified: number;
  requests: number;
  responses: number;
};

export type ExecutionManifest = {
  executionId: string;
  runKey: string;
  workflowId: string | null;
  trigger: string;
  mode: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  expectedAgents: number;
  dispatchedAgents: number;
  executedAgents: number;
  succeededAgents: number;
  failedAgents: number;
  timedOutAgents: number;
  skippedAgents: number;
  blockedAgents: number;
  notExecutedAgents: number;
  resultsReceived: number;
  resultsRejected: number;
  handoffsCompleted: number;
  handoffsExpected: number;
  agents: ExecutionAgent[];
  sources: ExecutionSource[];
  counts: {
    postingsScreened: number;
    fresh: number;
    relevant: number;
    duplicates: number;
    newJobs: number;
    eligible: number;
    qualified: number;
    rejected: number;
    documentsPrepared: number;
    applicationsPrepared: number;
    applicationsReady: number;
    submittedVerified: number;
    submittedUnverified: number;
    submissionFailed: number;
    interventions: number;
  };
  warnings: string[];
  failures: string[];
  summary: string;
};

type RunRecord = {
  id: string;
  run_key: string;
  workflow_id: string | null;
  trigger: string;
  mode: string | null;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  jobs_discovered: number;
  jobs_duplicates: number;
  jobs_filtered: number;
  jobs_eligible: number;
  jobs_qualified: number;
  discovery_state: string | null;
  packages_prepared: number;
  applications_submitted: number;
  applications_unverified: number;
  applications_intervention: number;
  applications_simulated: number;
  failures: number;
  warnings: number;
  source_metrics: string | null;
  warnings_json: string | null;
  failures_json: string | null;
  report: string | null;
  error: string | null;
};

type RunAgentRow = {
  id: number;
  agent_key: string;
  assignment: string;
  status: string;
  attempt: number;
  output: string | null;
  error: string | null;
  coordinator_decision: string | null;
  execution_mode: string | null;
  provider: string | null;
  model: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type TaskRow = {
  id: string;
  agent_key: string;
  title: string;
  status: string;
  output: string | null;
  error: string | null;
  execution_mode: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type SourceMetricRow = {
  key: string;
  label: string;
  requests: number;
  responses: number;
  postings: number;
  fresh: number;
  relevant: number;
  duplicates: number;
  inserted: number;
  errors: number;
  eligible: number;
  qualified: number;
  status?: string | null;
};

const PIPELINE: AgentKey[] = [
  "coordinator",
  "research",
  "analysis",
  "cv",
  "cover",
  "ats",
  "application",
  "email",
];

const ACTIVE_TASK_STATES = new Set([
  "running",
  "working",
  "queued",
  "planned",
  "waiting_provider",
  "retry_scheduled",
]);

const FAILED_TASK_STATES = new Set(["failed", "cancelled"]);

function parseList(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  } catch {
    return [];
  }
}

function parseReportProblems(report: string | null): { warnings: string[]; failures: string[] } {
  if (!report) return { warnings: [], failures: [] };
  const section = report.split(/^## 9\./m)[1]?.split(/^## 10\./m)[0] ?? "";
  const warnings: string[] = [];
  const failures: string[] = [];
  for (const line of section.split("\n")) {
    if (line.startsWith("- Warning:")) warnings.push(line.slice("- Warning:".length).trim());
    if (line.startsWith("- Run failure:")) failures.push(line.slice("- Run failure:".length).trim());
  }
  return { warnings, failures };
}

function parseSources(value: string | null): ExecutionSource[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is SourceMetricRow => Boolean(item && typeof item === "object" && typeof item.key === "string"))
      .map((item) => ({
        key: item.key,
        label: item.label || item.key,
        status: item.status || (item.errors > 0 ? "partial" : item.postings === 0 ? "empty" : "ok"),
        postings: Number(item.postings ?? 0),
        fresh: Number(item.fresh ?? 0),
        relevant: Number(item.relevant ?? 0),
        duplicates: Number(item.duplicates ?? 0),
        inserted: Number(item.inserted ?? 0),
        errors: Number(item.errors ?? 0),
        eligible: Number(item.eligible ?? 0),
        qualified: Number(item.qualified ?? 0),
        requests: Number(item.requests ?? 0),
        responses: Number(item.responses ?? 0),
      }));
  } catch {
    return [];
  }
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start) return null;
  const from = Date.parse(start);
  const to = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

function evidenceTime(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isTimedOut(value: string | null): boolean {
  return Boolean(value && /timed?\s*out|timeout|deadline/i.test(value));
}

function agentDisabled(key: string): boolean {
  const row = one<{ enabled: number; status: string }>("SELECT enabled, status FROM agents WHERE key = ?", [key]);
  return Boolean(row && (row.enabled !== 1 || row.status === "paused"));
}

/**
 * Build the manifest for a persisted run. Returns null only when the run does
 * not exist; missing agents are never hidden.
 */
export function buildExecutionManifest(runId: string): ExecutionManifest | null {
  const runRow = one<RunRecord>("SELECT * FROM recruitment_runs WHERE id = ?", [runId]);
  if (!runRow) return null;

  const runAgents = all<RunAgentRow>(
    "SELECT * FROM recruitment_run_agents WHERE run_id = ? ORDER BY id",
    [runId],
  );
  const tasks = runRow.workflow_id
    ? all<TaskRow>(
        `SELECT id, agent_key, title, status, output, error, execution_mode, provider, model,
                created_at, started_at, finished_at
         FROM tasks WHERE workflow_id = ? ORDER BY created_at`,
        [runRow.workflow_id],
      )
    : [];
  const retryEvents = runRow.workflow_id
    ? all<{ agent_key: string; n: number }>(
        "SELECT agent_key, COUNT(*) AS n FROM workflow_events WHERE workflow_id = ? AND type = 'agent.retrying' GROUP BY agent_key",
        [runRow.workflow_id],
      )
    : [];
  const sources = parseSources(runRow.source_metrics);

  const jobCount = Number(
    one<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE run_id = ?", [runId])?.n ?? 0,
  );
  const documentCount = Number(
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM documents WHERE run_id = ? AND deleted_at IS NULL AND kind IN ('tailored_cv','cover_letter')",
      [runId],
    )?.n ?? 0,
  );
  const applicationRows = all<{ id: string; status: string; submission_status: string | null }>(
    `SELECT a.id, a.status, a.submission_status
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ?`,
    [runId],
  );
  const interventionCount = Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM application_interventions i JOIN jobs j ON j.id = i.job_id
       WHERE j.run_id = ? AND i.status = 'open'`,
      [runId],
    )?.n ?? 0,
  );
  const verifiedCount = Number(
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM application_events e
       JOIN applications a ON a.id = e.application_id JOIN jobs j ON j.id = a.job_id
       WHERE j.run_id = ? AND e.type = 'submission.verified'`,
      [runId],
    )?.n ?? 0,
  );
  const attempts = all<{ status: string }>(
    "SELECT status FROM submission_attempts WHERE run_id = ?",
    [runId],
  );

  // Historical runs predate warnings_json/failures_json. Their exact text was
  // still persisted inside the stored report, so read it without mutating the
  // old record. Runs created after the additive migration use the JSON fields.
  const reportProblems = parseReportProblems(runRow.report);
  const failures = [
    ...new Set([
      ...parseList(runRow.failures_json),
      ...reportProblems.failures,
      ...runAgents
        .filter((row) => row.status === "failed" && row.error)
        .map((row) => row.error as string),
      ...tasks
        .filter((row) => FAILED_TASK_STATES.has(row.status) && row.error)
        .map((row) => row.error as string),
      ...(runRow.error ? [runRow.error] : []),
    ]),
  ];
  const warnings = [
    ...new Set([
      ...parseList(runRow.warnings_json),
      ...reportProblems.warnings,
      ...runAgents
        .filter((row) => row.status === "retried" && row.error)
        .map((row) => row.error as string),
    ]),
  ];
  if (warnings.length === 0 && Number(runRow.warnings ?? 0) > 0) {
    warnings.push(`${runRow.warnings} warning(s) were recorded for this run, but their historical detail is not available.`);
  }
  if (failures.length === 0 && Number(runRow.failures ?? 0) > 0) {
    failures.push(`${runRow.failures} failure(s) were recorded for this run, but their historical detail is not available.`);
  }

  const agents: ExecutionAgent[] = AGENT_DEFINITIONS.map((definition, index) => {
    const key = definition.key;
    const keyRows = runAgents.filter((row) => row.agent_key === key);
    const keyTasks = tasks.filter((row) => row.agent_key === key);
    const evidence = [
      ...keyRows.map((row) => ({
        at: evidenceTime(row.finished_at ?? row.started_at ?? row.created_at),
        status: row.status,
        output: row.output,
        error: row.error,
        decision: row.coordinator_decision,
        assignment: row.assignment,
        executionMode: row.execution_mode,
        provider: row.provider,
        model: row.model,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        taskId: null as string | null,
      })),
      ...keyTasks.map((row) => ({
        at: evidenceTime(row.finished_at ?? row.started_at ?? row.created_at),
        status: row.status,
        output: row.output,
        error: row.error,
        decision: null as string | null,
        assignment: row.title,
        executionMode: row.execution_mode,
        provider: row.provider,
        model: row.model,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        taskId: row.id,
      })),
    ].sort((a, b) => a.at - b.at);

    const latest = evidence[evidence.length - 1] ?? null;
    const hasOpen = evidence.some((item) => ACTIVE_TASK_STATES.has(item.status));
    const hasCompleted = evidence.some((item) => item.status === "completed");
    const hasSkipped = evidence.some((item) => item.status === "skipped");
    const hasFailed = evidence.some((item) => FAILED_TASK_STATES.has(item.status));
    const disabled = agentDisabled(key);
    let state: ExecutionAgentState = "NOT_EXECUTED";

    if (hasOpen) state = "RUNNING";
    else if (latest?.status === "completed") {
      const zeroResult =
        (key === "research" && runRow.jobs_discovered === 0 && runRow.discovery_state !== "failed") ||
        (key === "analysis" && runRow.jobs_discovered === 0 && Number(runRow.jobs_eligible ?? 0) === 0);
      state = zeroResult ? "COMPLETED_WITH_ZERO_RESULTS" : "COMPLETED";
    } else if (latest && FAILED_TASK_STATES.has(latest.status)) {
      state = "FAILED";
    } else if (latest?.status === "retried" || latest?.status === "reassigned") {
      state = hasCompleted ? "COMPLETED" : "DEGRADED";
    } else if (latest?.status === "skipped") {
      state = disabled ? "DISABLED" : /unavailable|disabled|not configured|cannot|blocked/i.test(`${latest.error ?? ""} ${latest.output ?? ""} ${latest.decision ?? ""}`)
        ? "BLOCKED"
        : "SKIPPED";
    } else if (hasCompleted) {
      state = "COMPLETED";
    } else if (hasFailed) {
      state = "FAILED";
    } else if (hasSkipped) {
      state = "SKIPPED";
    } else if (disabled) {
      state = "DISABLED";
    }

    const skipText = `${latest?.output ?? ""} ${latest?.decision ?? ""} ${latest?.error ?? ""}`;
    const skipCategory: ExecutionSkipCategory | null =
      state === "NOT_EXECUTED"
        ? "ORCHESTRATION_FAILURE"
        : state === "SKIPPED"
          ? /no input|discovery-only|no vacancy|no qualifying vacancy|no eligible work|no package|no application package|nothing was (?:eligible|ready)|threshold/i.test(skipText)
            ? "NO_INPUT"
            : "SAFETY_POLICY"
          : null;
    const stateReason =
      state === "SKIPPED"
        ? latest?.output ?? latest?.decision ?? latest?.error ?? "No input was available for this specialist."
        : latest?.decision ?? latest?.error ?? (state === "NOT_EXECUTED" ? "No assignment or task was recorded for this run." : null);

    const dispatched = evidence.some((item) => item.status !== "skipped");
    const executed = ["RUNNING", "COMPLETED", "COMPLETED_WITH_ZERO_RESULTS", "DEGRADED", "FAILED"].includes(state);
    const succeeded = state === "COMPLETED" || state === "COMPLETED_WITH_ZERO_RESULTS";
    const outputEvidence = [...evidence].reverse().find((item) => item.output && item.output.trim());
    const errorEvidence = [...evidence].reverse().find((item) => item.error && item.error.trim());
    const startedAt = evidence
      .map((item) => item.startedAt)
      .filter((item): item is string => Boolean(item))
      .sort()[0] ?? null;
    const finishedAt = evidence
      .map((item) => item.finishedAt)
      .filter((item): item is string => Boolean(item))
      .sort()
      .at(-1) ?? null;

    let recordsProcessed = 0;
    if (key === "research") recordsProcessed = sources.reduce((sum, source) => sum + source.postings, 0);
    else if (key === "analysis") recordsProcessed = jobCount;
    else if (key === "cv" || key === "cover" || key === "ats") recordsProcessed = documentCount;
    else if (key === "application") recordsProcessed = applicationRows.length;
    else if (key === "coordinator") recordsProcessed = 1;
    else if (key === "email" && succeeded) recordsProcessed = 1;

    const previous = index > 0 ? PIPELINE[index - 1] : null;
    const next = index < PIPELINE.length - 1 ? PIPELINE[index + 1] : null;

    const identity = agentIdentity(key);
    return {
      key,
      name: identity.name,
      role: identity.title,
      expected: true,
      dispatched,
      executed,
      succeeded,
      state,
      stateLabel: executionAgentStateLabel(state, skipCategory),
      skipCategory,
      taskIds: keyTasks.map((task) => task.id),
      latestTaskId: latest?.taskId ?? keyTasks.at(-1)?.id ?? null,
      assignments: evidence.map((item) => item.assignment),
      output: outputEvidence?.output ?? null,
      error: errorEvidence?.error ?? null,
      reason: stateReason,
      recordsProcessed,
      startedAt,
      finishedAt,
      durationMs: durationMs(startedAt, finishedAt),
      executionMode: latest?.executionMode ?? null,
      provider: latest?.provider ?? null,
      model: latest?.model ?? null,
      dependsOn: previous ? [previous] : [],
      retryCount: Math.max(
        keyRows.filter((row) => row.status === "retried" || row.status === "reassigned").length,
        retryEvents.find((row) => row.agent_key === key)?.n ?? 0,
      ),
      handoffFrom: previous,
      handoffTo: next,
      handoffComplete: false,
    };
  });

  for (let index = 0; index < agents.length; index += 1) {
    const agent = agents[index];
    if (index === 0) {
      agent.handoffComplete = agent.succeeded;
      continue;
    }
    const previous = agents[index - 1];
    agent.handoffComplete = previous.succeeded && (agent.dispatched || agent.succeeded);
  }

  const postingsScreened = sources.reduce((sum, source) => sum + source.postings, 0);
  const fresh = sources.reduce((sum, source) => sum + source.fresh, 0);
  const relevant = sources.reduce((sum, source) => sum + source.relevant, 0);
  const duplicates = sources.reduce((sum, source) => sum + source.duplicates, 0);
  const applicationsReady = applicationRows.filter((app) => app.status === "ready_to_submit").length;
  const submittedUnverified = applicationRows.filter(
    (app) => app.status === "submission_unverified" || app.submission_status === "unverified",
  ).length;
  const submissionFailed = attempts.filter((attempt) => attempt.status === "failed").length;
  const succeededAgents = agents.filter((agent) => agent.succeeded).length;
  const failedAgents = agents.filter((agent) => agent.state === "FAILED").length;
  const skippedAgents = agents.filter((agent) => agent.state === "SKIPPED").length;
  const blockedAgents = agents.filter((agent) => agent.state === "BLOCKED" || agent.state === "DISABLED").length;
  const notExecutedAgents = agents.filter((agent) => agent.state === "NOT_EXECUTED").length;
  const dispatchedAgents = agents.filter((agent) => agent.dispatched).length;
  const executedAgents = agents.filter((agent) => agent.executed).length;
  const handoffsCompleted = agents.filter((agent) => agent.handoffComplete).length;
  const handoffsExpected = agents.length;

  return {
    executionId: runRow.id,
    runKey: runRow.run_key,
    workflowId: runRow.workflow_id,
    trigger: runRow.trigger,
    mode: runRow.mode ?? "full",
    status: runRow.status,
    startedAt: runRow.started_at,
    finishedAt: runRow.finished_at,
    durationMs: durationMs(runRow.started_at, runRow.finished_at),
    expectedAgents: agents.length,
    dispatchedAgents,
    executedAgents,
    succeededAgents,
    failedAgents,
    timedOutAgents: agents.filter((agent) => isTimedOut(agent.error)).length,
    skippedAgents,
    blockedAgents,
    notExecutedAgents,
    resultsReceived: agents.filter((agent) => agent.succeeded).length,
    resultsRejected: failedAgents,
    handoffsCompleted,
    handoffsExpected,
    agents,
    sources,
    counts: {
      postingsScreened,
      fresh,
      relevant,
      duplicates,
      newJobs: runRow.jobs_discovered,
      eligible: runRow.jobs_eligible,
      qualified: runRow.jobs_qualified,
      rejected: Math.max(0, jobCount - runRow.jobs_qualified),
      documentsPrepared: documentCount,
      applicationsPrepared: applicationRows.length,
      applicationsReady,
      submittedVerified: Math.max(Number(runRow.applications_submitted ?? 0), verifiedCount),
      submittedUnverified: Math.max(Number(runRow.applications_unverified ?? 0), submittedUnverified),
      submissionFailed,
      interventions: Math.max(Number(runRow.applications_intervention ?? 0), interventionCount),
    },
    warnings,
    failures,
    summary: `${succeededAgents} of ${agents.length} agents succeeded, ${failedAgents} failed, ${skippedAgents} skipped and ${notExecutedAgents} were not executed.`,
  };
}

export function executionManifestForWorkflow(workflowId: string): ExecutionManifest | null {
  const run = one<{ id: string }>(
    "SELECT id FROM recruitment_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1",
    [workflowId],
  );
  return run ? buildExecutionManifest(run.id) : null;
}

export function latestExecutionManifest(): ExecutionManifest | null {
  const run = one<{ id: string }>("SELECT id FROM recruitment_runs ORDER BY created_at DESC LIMIT 1");
  return run ? buildExecutionManifest(run.id) : null;
}
