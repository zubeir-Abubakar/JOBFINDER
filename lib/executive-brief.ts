import { all, one, run, nowIso } from "./db";
import { getSetting, setSetting } from "./settings";
import { publicAppBaseUrl } from "./app-url";
import { audit } from "./audit";
import {
  deliveryStateForRow,
  deliveryStateMessage,
  drainNotificationQueue,
  notify,
  notificationRecipient,
  notificationSender,
  outboxByDedupeKey,
  outboxById,
  refreshOutboxSentObservation,
  resetOutboxForResend,
  type DeliveryState,
  type OutboxRow,
  type OutboxSender,
} from "./notify";
import { statusLabel } from "./application-status";
import { getRecruitmentPolicy } from "./recruitment-policy";
import {
  catchUpWindowHours,
  formatInZone,
  localDateKey,
  localWeekday,
  nextScheduledRun,
  parseWeekdays,
  RECRUITMENT_TIMEZONE,
  zonedParts,
  zonedTimeToUtc,
} from "./recruitment-schedule";
import { buildExecutionManifest, type ExecutionManifest } from "./execution-manifest";
import { agentIdentity, agentSignature } from "./agent-identity";

/**
 * Coordinator-owned daily executive brief.
 *
 * The report is deliberately additive to the existing recruitment execution
 * ledger. It never infers a submission, a completion or an achievement from an
 * agent's narrative: those facts come from `submission_attempts`, `jobs`,
 * `applications`, `tasks` and `recruitment_run_agents`.
 *
 * Delivery uses the existing durable notification outbox. The notification and
 * outbox dedupe keys are both scoped to the Europe/Zurich calendar day, so a
 * retry, a second process or a repeated scheduler tick cannot send a second
 * copy of the same day's brief.
 */

export const EXECUTIVE_BRIEF_KIND = "daily_executive_brief";
export const EXECUTIVE_BRIEF_SCHEDULE_KEY = "daily_executive_brief";
export const EXECUTIVE_BRIEF_TIME = "16:00";
export const EXECUTIVE_BRIEF_WEEKDAYS = [1, 2, 3, 4, 5];
export const EXECUTIVE_BRIEF_DASHBOARD_PATH = "/dashboard";

type Count = { n: number };

export type ExecutiveBriefPeriod = {
  start: string;
  end: string;
  key: string;
  label: string;
  shortLabel: string;
};

type AgentRow = {
  key: string;
  name: string;
  role: string;
  enabled: number;
  status: string;
  current_task: string | null;
};

type RunRow = {
  id: string;
  run_key: string;
  status: string;
  trigger: string;
  started_at: string | null;
  finished_at: string | null;
  jobs_discovered: number;
  jobs_qualified: number;
  packages_prepared: number;
  applications_submitted: number;
  applications_unverified: number;
  failures: number;
  warnings: number;
  error: string | null;
};

type TaskRow = {
  id: string;
  agent_key: string;
  title: string;
  status: string;
  output: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

type RunAgentRow = {
  id: number;
  agent_key: string;
  assignment: string;
  status: string;
  output: string | null;
  error: string | null;
  coordinator_decision: string | null;
  created_at: string;
  finished_at: string | null;
};

type ApplicationRow = {
  id: string;
  status: string;
  readiness: string | null;
  title: string;
  company: string;
  location: string | null;
  last_update: string;
};

type SubmissionRow = {
  application_id: string;
  attempted_at: string;
  reference: string | null;
  channel: string;
  title: string;
  company: string;
};

type FailedSubmissionRow = {
  application_id: string;
  status: string;
  channel: string;
  error: string | null;
  attempted_at: string;
  title: string;
  company: string;
};

type InterventionRow = {
  application_id: string;
  question: string;
  reason: string;
  title: string;
  company: string;
};

type FailedRunRow = {
  id: string;
  run_key: string;
  error: string | null;
  finished_at: string | null;
};

export type ExecutiveBriefAgent = {
  key: string;
  name: string;
  role: string;
  registered: boolean;
  currentState: string;
  executionState: string;
  reported: boolean;
  completed: number;
  failed: number;
  open: number;
  latestAssignment: string | null;
  latestOutput: string | null;
  latestError: string | null;
  reconciliation: string;
};

export type ExecutiveBriefMetric = {
  key: string;
  label: string;
  value: number | null;
  display: string;
  note: string;
  tone: string;
};

export type ExecutiveBriefException = {
  kind: "blocked_application" | "investigation" | "failed_task" | "failed_submission" | "failed_run";
  title: string;
  detail: string;
  reference: string | null;
};

export type ExecutiveBriefData = {
  period: ExecutiveBriefPeriod;
  generatedAt: string;
  ownerName: string;
  run: RunRow | null;
  manifest: ExecutionManifest | null;
  metrics: ExecutiveBriefMetric[];
  agents: ExecutiveBriefAgent[];
  reportingAgents: number;
  registeredAgents: number;
  completedTasks: TaskRow[];
  failedTasks: TaskRow[];
  achievements: string[];
  exceptions: ExecutiveBriefException[];
  exceptionCounts: {
    blockedApplications: number;
    investigations: number;
    failedTasks: number;
    failedSubmissions: number;
    failedRuns: number;
  };
  reconciliationNotes: string[];
  assessment: string;
  assessmentState: "no_execution_record" | "attention_required" | "degraded" | "stable_with_open_work" | "stable";
  priorities: string[];
  nextRunAt: string | null;
  dashboardUrl: string | null;
  policyActive: boolean;
  policyThreshold: number;
  dryRun: boolean;
};

export type ExecutiveBriefEmail = {
  subject: string;
  html: string;
  text: string;
  dashboardUrl: string | null;
  period: ExecutiveBriefPeriod;
  data: ExecutiveBriefData;
};

export type ExecutiveBriefSendStatus = "queued" | "duplicate" | "in_app_only" | "disabled" | "no_recipient" | "blocked" | "failed";

export type ExecutiveBriefSendResult = {
  status: ExecutiveBriefSendStatus;
  period: ExecutiveBriefPeriod;
  notificationId: number | null;
  outboxId: string | null;
  reportId: string;
  deliveryState: DeliveryState;
  emailQueued: boolean;
  detail: string;
  generatedAt: string;
};

/** Structured delivery result shared by the Coordinator, admin and history. */
export type ExecutiveBriefDelivery = {
  reportId: string;
  notificationId: number | null;
  outboxId: string | null;
  period: ExecutiveBriefPeriod;
  state: DeliveryState;
  message: string;
  detail: string;
  recipient: string | null;
  recipientMasked: string | null;
  sender: string | null;
  subject: string | null;
  messageId: string | null;
  threadId: string | null;
  rfcMessageId: string | null;
  attempts: number;
  resendCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  sentObservedAt: string | null;
  sentVerification: string | null;
  deliveryEvidence: string | null;
  bounceInfo: string | null;
  appResponse: string | null;
  dashboardUrl: string | null;
  canResend: boolean;
  generatedAt: string;
};

function count(sql: string, params: unknown[] = []): number {
  return Number(one<Count>(sql, params)?.n ?? 0);
}

function startOfBriefDay(now: Date): Date {
  const parts = zonedParts(now);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0);
}

export function executiveBriefPeriod(now: Date = new Date()): ExecutiveBriefPeriod {
  const start = startOfBriefDay(now);
  const parts = zonedParts(start);
  const end = zonedTimeToUtc(parts.year, parts.month, parts.day + 1, 0, 0);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    key: localDateKey(now),
    label: new Intl.DateTimeFormat("en-GB", {
      timeZone: RECRUITMENT_TIMEZONE,
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(start),
    shortLabel: new Intl.DateTimeFormat("en-GB", {
      timeZone: RECRUITMENT_TIMEZONE,
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(start),
  };
}

function policyLabel(active: boolean): string {
  return active ? "Automatic submission active" : "Automatic submission paused";
}

function readinessReason(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { reasons?: unknown; items?: unknown };
    if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) {
      return String(parsed.reasons[0]);
    }
    if (Array.isArray(parsed.items)) {
      const failed = (parsed.items as Array<{ ok?: unknown; detail?: unknown; label?: unknown }>)
        .find((item) => item && item.ok === false);
      if (failed) return String(failed.detail ?? failed.label ?? "Readiness check did not pass.");
    }
  } catch {
    return null;
  }
  return null;
}

function achievementsFor(input: {
  run: RunRow | null;
  verifiedSubmissions: SubmissionRow[];
  qualified: number;
  documents: number;
  reportingAgents: number;
  registeredAgents: number;
  failedTasks: number;
}): string[] {
  const achievements: string[] = [];
  if (input.verifiedSubmissions.length > 0) {
    const first = input.verifiedSubmissions[0];
    achievements.push(
      `${input.verifiedSubmissions.length} application${input.verifiedSubmissions.length === 1 ? " has" : "s have"} verified employer evidence` +
        (first ? `; first recorded: ${first.company} — ${first.title}.` : "."),
    );
  }
  if (input.qualified > 0) {
    achievements.push(`${input.qualified} ${input.qualified === 1 ? "vacancy" : "vacancies"} met every qualification rule in the reporting period.`);
  }
  if (input.documents > 0) {
    achievements.push(`${input.documents} tailored CV or cover-letter document${input.documents === 1 ? "" : "s"} were generated.`);
  }
  if (
    input.run &&
    input.reportingAgents === input.registeredAgents &&
    input.registeredAgents > 0
  ) {
    achievements.push(`All ${input.registeredAgents} registered agents produced a record in the run ledger.`);
  }
  if (input.run && input.run.status === "completed" && Number(input.run.failures ?? 0) === 0 && input.failedTasks === 0) {
    achievements.push(`Run ${input.run.run_key} completed without a recorded failure.`);
  }
  return achievements;
}

function buildAssessment(input: {
  run: RunRow | null;
  manifest: ExecutionManifest | null;
  reportingAgents: number;
  registeredAgents: number;
  verified: number;
  qualified: number;
  blocked: number;
  pending: number;
  failedTasks: number;
  investigations: number;
  reconciliationNotes: string[];
}): { state: ExecutiveBriefData["assessmentState"]; text: string } {
  if (!input.run) {
    return {
      state: "no_execution_record",
      text:
        "No recruitment execution was recorded for this reporting period. This is a reporting gap, not evidence that the workforce performed zero work. " +
        `The current queue contains ${input.blocked} blocked application(s), ${input.pending} pending application(s) and ${input.investigations} outstanding investigation(s). ` +
        "Check the scheduler and run ledger before treating the next period as a normal operating day.",
    };
  }
  const agentSummary = `${input.reportingAgents} of ${input.registeredAgents} registered agents produced a structured report`;
  const outcome = [
    `${input.verified} application${input.verified === 1 ? " was" : "s were"} verified as submitted`,
    `${input.qualified} ${input.qualified === 1 ? "vacancy" : "vacancies"} qualified`,
    `${input.blocked} application${input.blocked === 1 ? " remains" : "s remain"} blocked`,
    `${input.pending} application${input.pending === 1 ? " remains" : "s remain"} in the preparation queue`,
  ].join("; ");
  const failure = input.failedTasks > 0
    ? `${input.failedTasks} task ${input.failedTasks === 1 ? "failure was" : "failures were"} recorded.`
    : "No task failure was recorded.";
  const gap = input.reconciliationNotes.length > 0
    ? `Reconciliation requires attention: ${input.reconciliationNotes.join(" ")}`
    : "The agent ledger reconciles with the persisted execution records.";
  if (input.failedTasks > 0 || input.investigations > 0) {
    return {
      state: "attention_required",
      text: `${agentSummary}. ${outcome}. ${failure} ${gap} Resolve the exceptions before increasing throughput or enabling further automation.`,
    };
  }
  if (input.blocked > 0 || input.pending > 0) {
    return {
      state: "stable_with_open_work",
      text: `${agentSummary}. ${outcome}. ${failure} ${gap} The pipeline is operating with open work; no unverified outcome is being treated as a success.`,
    };
  }
  return {
    state: "stable",
    text: `${agentSummary}. ${outcome}. ${failure} ${gap} No blocked application or open investigation was recorded for this snapshot.`,
  };
}

function prioritiesFor(input: {
  run: RunRow | null;
  blocked: number;
  pending: number;
  investigations: number;
  failedTasks: number;
  failedRuns: number;
  reconciliationNotes: string[];
  nextRunAt: string | null;
  policyActive: boolean;
  dryRun: boolean;
  dashboardUrl: string | null;
}): string[] {
  const items: string[] = [];
  if (!input.run) {
    items.push("Confirm whether the recruitment scheduler ran and why no execution record exists for this period.");
  }
  if (input.reconciliationNotes.length > 0) {
    items.push("Reconcile the agent ledger with the execution records before relying on the reported coverage.");
  }
  if (input.blocked > 0 || input.investigations > 0) {
    const blocked = `${input.blocked} blocked application${input.blocked === 1 ? "" : "s"}`;
    const investigations = `${input.investigations} open investigation${input.investigations === 1 ? "" : "s"}`;
    items.push(`Resolve ${blocked} and ${investigations}; do not retry an unverified submission blindly.`);
  }
  if (input.failedTasks > 0 || input.failedRuns > 0) {
    const failed = [
      input.failedTasks > 0 ? `${input.failedTasks} failed task${input.failedTasks === 1 ? "" : "s"}` : null,
      input.failedRuns > 0 ? `${input.failedRuns} failed run${input.failedRuns === 1 ? "" : "s"}` : null,
    ].filter(Boolean).join(" and ");
    items.push(`Review ${failed} before the next scheduled execution.`);
  }
  if (input.pending > 0) {
    items.push(`Continue processing ${input.pending} pending application${input.pending === 1 ? "" : "s"} through the normal safety and quality gates.`);
  }
  if (!input.policyActive) {
    items.push("Automatic submission is paused. Qualifying applications will wait until the standing authorisation is explicitly reactivated.");
  } else if (input.dryRun) {
    items.push("A dry run is enabled. Packages can be prepared, but no employer will be contacted.");
  }
  if (!input.dashboardUrl) {
    items.push("Configure a public APP_BASE_URL so the dashboard link in the next brief is usable.");
  }
  items.push(
    input.nextRunAt
      ? `Next recruitment run: ${formatInZone(input.nextRunAt)} (${RECRUITMENT_TIMEZONE}). The application must be running at that time.`
      : "The next recruitment run is not scheduled. Check the recruitment schedule.",
  );
  return items.slice(0, 8);
}

function collectBrief(now: Date, options: { baseUrl?: string | null } = {}): ExecutiveBriefData {
  const period = executiveBriefPeriod(now);
  const params = [period.start, period.end];
  const runRow = one<RunRow>(
    `SELECT id, run_key, status, trigger, started_at, finished_at, jobs_discovered, jobs_qualified,
            packages_prepared, applications_submitted, applications_unverified, failures, warnings, error
     FROM recruitment_runs
     WHERE COALESCE(started_at, created_at) < ?
       AND COALESCE(finished_at, started_at, created_at) >= ?
     ORDER BY COALESCE(finished_at, started_at, created_at) DESC LIMIT 1`,
    [period.end, period.start],
  );
  const manifest = runRow ? buildExecutionManifest(runRow.id) : null;

  const agentRows = all<AgentRow>(
    "SELECT key, name, role, enabled, status, current_task FROM agents ORDER BY sort, key",
  );
  const tasks = all<TaskRow>(
    `SELECT id, agent_key, title, status, output, error, created_at, finished_at FROM tasks
     WHERE (COALESCE(finished_at, created_at) >= ? AND COALESCE(finished_at, created_at) < ?)
        OR (status NOT IN ('completed','failed','cancelled') AND created_at < ?)
     ORDER BY created_at ASC`,
    [...params, period.end],
  );
  const runAgents = runRow
    ? all<RunAgentRow>(
        `SELECT id, agent_key, assignment, status, output, error, coordinator_decision, created_at, finished_at
         FROM recruitment_run_agents
         WHERE run_id = ? AND created_at < ? AND COALESCE(finished_at, created_at) >= ?
         ORDER BY id`,
        [runRow.id, period.end, period.start],
      )
    : [];

  const completedTasks = tasks.filter(
    (task) => task.status === "completed" && task.finished_at && task.finished_at >= period.start && task.finished_at < period.end,
  );
  const failedTasks = tasks.filter(
    (task) => task.status === "failed" && (task.finished_at ?? task.created_at) >= period.start && (task.finished_at ?? task.created_at) < period.end,
  );

  const agents: ExecutiveBriefAgent[] = agentRows.map((agent) => {
    const reports = runAgents.filter((row) => row.agent_key === agent.key);
    const agentTasks = tasks.filter((row) => row.agent_key === agent.key);
    const completed = agentTasks.filter((task) => task.status === "completed").length;
    const failed = agentTasks.filter((task) => task.status === "failed").length;
    const open = agentTasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).length;
    const latest = reports.at(-1) ?? null;
    const manifestAgent = manifest?.agents.find((item) => item.key === agent.key) ?? null;
    const reported = reports.length > 0 || agentTasks.length > 0;
    let reconciliation = "No structured report in this period.";
    if (!runRow) reconciliation = "No execution run was recorded.";
    else if (!agent.enabled) reconciliation = "Agent is disabled in the registry.";
    else if (!reported) reconciliation = "Missing from the run ledger and task ledger.";
    else if (reports.some((row) => row.status === "failed") || failed > 0) reconciliation = "Reported a failure; inspect the recorded error.";
    else if (reports.some((row) => ["running", "queued"].includes(row.status))) reconciliation = "Execution still open at report generation.";
    else reconciliation = "Reconciled with persisted execution records.";
    return {
      key: agent.key,
      name: agentIdentity(agent.key).name,
      role: agentIdentity(agent.key).title,
      registered: agent.enabled === 1,
      currentState: statusLabel(agent.status),
      executionState: manifestAgent?.stateLabel ?? (reports.length > 0 ? statusLabel(latest?.status ?? "reported") : "No execution record"),
      reported,
      completed,
      failed,
      open,
      latestAssignment: latest?.assignment ?? latestAssignmentFromTasks(agentTasks),
      latestOutput: latest?.output ?? [...agentTasks].reverse().find((task) => task.output)?.output ?? null,
      latestError: latest?.error ?? [...agentTasks].reverse().find((task) => task.error)?.error ?? null,
      reconciliation,
    };
  });

  const reportingAgents = agents.filter((agent) => agent.reported).length;
  const registeredAgents = agents.filter((agent) => agent.registered).length;
  const jobsDiscovered = count(
    "SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ? AND discovered_at < ?",
    params,
  );
  const jobsQualified = count(
    "SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ? AND discovered_at < ? AND qualified = 1",
    params,
  );
  const documents = count(
    `SELECT COUNT(*) AS n FROM documents
     WHERE created_at >= ? AND created_at < ? AND deleted_at IS NULL AND kind IN ('tailored_cv','cover_letter')`,
    params,
  );

  const verifiedSubmissions = all<SubmissionRow>(
    `SELECT sa.application_id, MIN(sa.attempted_at) AS attempted_at, MAX(sa.reference) AS reference,
            MAX(sa.channel) AS channel, j.title, j.company
     FROM submission_attempts sa
     JOIN applications a ON a.id = sa.application_id
     JOIN jobs j ON j.id = sa.job_id
     WHERE sa.status = 'verified' AND sa.attempted_at >= ? AND sa.attempted_at < ?
     GROUP BY sa.application_id, j.title, j.company
     ORDER BY attempted_at ASC`,
    params,
  );
  const blockedApplications = all<ApplicationRow>(
    `SELECT a.id, a.status, a.readiness, a.last_update, j.title, j.company, j.location
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status IN (
       'quality_review_required','submission_unverified','submission_unknown',
       'human_intervention_required','submission_failed','awaiting_approval','approval_required'
     )
     ORDER BY a.last_update DESC LIMIT 20`,
  );
  const pendingApplications = all<ApplicationRow>(
    `SELECT a.id, a.status, a.readiness, a.last_update, j.title, j.company, j.location
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status IN (
       'discovered','analysing','under_review','qualified','shortlisted',
       'documents_preparing','preparing_documents','quality_check','ready_to_submit','submitting'
     )
     ORDER BY a.last_update DESC LIMIT 100`,
  );
  const interventions = all<InterventionRow>(
    `SELECT i.application_id, i.question, i.reason, j.title, j.company
     FROM application_interventions i JOIN jobs j ON j.id = i.job_id
     WHERE i.status = 'open' ORDER BY i.created_at DESC LIMIT 20`,
  );
  const unverifiedSubmissions = all<FailedSubmissionRow>(
    `SELECT sa.application_id, sa.status, sa.channel, sa.error, sa.attempted_at, j.title, j.company
     FROM submission_attempts sa
     JOIN applications a ON a.id = sa.application_id
     JOIN jobs j ON j.id = sa.job_id
     WHERE sa.status IN ('unverified','failed')
       AND sa.attempted_at >= ? AND sa.attempted_at < ?
     ORDER BY sa.attempted_at DESC LIMIT 20`,
    params,
  );
  const failedRuns = all<FailedRunRow>(
    `SELECT id, run_key, error, finished_at FROM recruitment_runs
     WHERE status IN ('failed','interrupted')
       AND COALESCE(finished_at, created_at) >= ? AND COALESCE(finished_at, created_at) < ?
     ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 10`,
    params,
  );

  const exceptionMap = new Map<string, ExecutiveBriefException>();
  for (const app of blockedApplications) {
    const intervention = interventions.find((item) => item.application_id === app.id);
    const reason = intervention?.question ?? intervention?.reason ?? readinessReason(app.readiness) ?? statusLabel(app.status);
    exceptionMap.set(`blocked:${app.id}`, {
      kind: "blocked_application",
      title: `${app.company} — ${app.title}`,
      detail: `${statusLabel(app.status)}. ${reason}`,
      reference: app.id,
    });
  }
  for (const item of interventions) {
    const blocked = exceptionMap.get(`blocked:${item.application_id}`);
    if (blocked) {
      // The blocked application already carries the question. Do not list the
      // same application twice under two headings.
      blocked.detail = `${blocked.detail} Owner answer required: ${item.question}`;
      continue;
    }
    exceptionMap.set(`investigation:${item.application_id}:${item.question.slice(0, 40)}`, {
      kind: "investigation",
      title: `${item.company} — ${item.title}`,
      detail: `Owner investigation open: ${item.question} (${item.reason})`,
      reference: item.application_id,
    });
  }
  for (const item of unverifiedSubmissions) {
    const blocked = exceptionMap.get(`blocked:${item.application_id}`);
    if (blocked) {
      blocked.detail = `${blocked.detail} Recorded submission error: ${item.error ?? "no error detail"}. Confirm with the employer before any retry.`;
      continue;
    }
    exceptionMap.set(`submission:${item.application_id}:${item.attempted_at}`, {
      kind: "failed_submission",
      title: `${item.company} — ${item.title}`,
      detail: `${statusLabel(item.status)} via ${statusLabel(item.channel)}. ${item.error ?? "No error detail recorded."} Confirm with the employer before any retry.`,
      reference: item.application_id,
    });
  }
  for (const task of failedTasks) {
    exceptionMap.set(`task:${task.id}`, {
      kind: "failed_task",
      title: `${task.agent_key} — ${task.title}`,
      detail: task.error ?? "No error detail recorded.",
      reference: task.id,
    });
  }
  for (const item of failedRuns) {
    exceptionMap.set(`run:${item.id}`, {
      kind: "failed_run",
      title: `Run ${item.run_key}`,
      detail: item.error ?? "No error detail was recorded.",
      reference: item.id,
    });
  }
  const exceptions = [...exceptionMap.values()];
  const blockedIds = new Set<string>([
    ...blockedApplications.map((app) => app.id),
    ...interventions.map((item) => item.application_id),
    ...unverifiedSubmissions.map((item) => item.application_id),
  ]);
  const investigationIds = new Set<string>([
    ...interventions.map((item) => item.application_id),
    ...unverifiedSubmissions.filter((item) => item.status === "unverified").map((item) => item.application_id),
  ]);

  const reconciliationNotes: string[] = [];
  if (!runRow) {
    reconciliationNotes.push("No execution run was recorded for the period; the absence of agent reports is a data gap, not a zero-work result.");
  } else {
    const missing = agents.filter((agent) => agent.registered && !agent.reported).map((agent) => agent.name);
    if (missing.length > 0) reconciliationNotes.push(`No report was recorded for ${missing.join(", ")}.`);
    if (manifest?.failures.length) {
      reconciliationNotes.push(
        `${manifest.failures.length} execution ${manifest.failures.length === 1 ? "failure was" : "failures were"} recorded by the run ledger.`,
      );
    }
  }
  if (manifest?.sources.some((source) => source.status === "failed")) {
    reconciliationNotes.push("At least one configured vacancy source failed; a zero-result source is not treated as a successful search.");
  }

  const policy = getRecruitmentPolicy();
  const dryRun = getSetting<boolean>("recruitment_dry_run", true);
  const nextRun = one<{ next_run_at: string | null }>(
    "SELECT next_run_at FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  // An explicit invalid URL must never fall back to the environment. No
  // localhost, loopback, .local or private address may enter an email.
  const baseUrl = options.baseUrl === null
    ? null
    : options.baseUrl !== undefined
      ? publicAppBaseUrl(options.baseUrl)
      : publicAppBaseUrl();
  const dashboardUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/, "")}${EXECUTIVE_BRIEF_DASHBOARD_PATH}`
    : null;

  const assessment = buildAssessment({
    run: runRow,
    manifest,
    reportingAgents,
    registeredAgents,
    verified: verifiedSubmissions.length,
    qualified: jobsQualified,
    blocked: blockedIds.size,
    pending: pendingApplications.length,
    failedTasks: failedTasks.length,
    investigations: investigationIds.size,
    reconciliationNotes,
  });

  const metrics: ExecutiveBriefMetric[] = [
    { key: "discovered", label: "Jobs discovered", value: jobsDiscovered, display: String(jobsDiscovered), note: "Stored in the reporting period.", tone: "#0d6fa8" },
    { key: "qualified", label: "Jobs qualified", value: jobsQualified, display: String(jobsQualified), note: "Met every qualification rule.", tone: "#1f7a4d" },
    { key: "submitted", label: "Submitted + verified", value: verifiedSubmissions.length, display: String(verifiedSubmissions.length), note: "Employer evidence only.", tone: "#1f7a4d" },
    { key: "blocked", label: "Applications blocked", value: blockedIds.size, display: String(blockedIds.size), note: "Current queue needing action.", tone: blockedIds.size ? "#b42318" : "#5b6b7c" },
    { key: "pending", label: "Applications pending", value: pendingApplications.length, display: String(pendingApplications.length), note: "Current preparation queue.", tone: pendingApplications.length ? "#9a6700" : "#5b6b7c" },
    {
      key: "agents",
      label: "Agents reporting",
      value: runRow ? reportingAgents : null,
      display: runRow ? `${reportingAgents} / ${registeredAgents}` : "No run",
      note: runRow ? "Reconciled with the run ledger." : "No execution record to reconcile.",
      tone: runRow && reportingAgents < registeredAgents ? "#9a6700" : "#0d6fa8",
    },
  ];

  const owner = one<{ name: string | null }>(
    "SELECT name FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
  );
  const profile = one<{ full_name: string | null }>("SELECT full_name FROM profiles WHERE id = 1");
  const ownerName = (owner?.name ?? profile?.full_name ?? "").trim().split(/\s+/)[0] || "Boss";

  return {
    period,
    generatedAt: now.toISOString(),
    ownerName,
    run: runRow,
    manifest,
    metrics,
    agents,
    reportingAgents,
    registeredAgents,
    completedTasks,
    failedTasks,
    achievements: achievementsFor({
      run: runRow,
      verifiedSubmissions,
      qualified: jobsQualified,
      documents,
      reportingAgents,
      registeredAgents,
      failedTasks: failedTasks.length,
    }),
    exceptions,
    exceptionCounts: {
      blockedApplications: blockedIds.size,
      investigations: investigationIds.size,
      failedTasks: failedTasks.length,
      failedSubmissions: unverifiedSubmissions.filter((item) => item.status === "failed").length,
      failedRuns: failedRuns.length,
    },
    reconciliationNotes,
    assessment: assessment.text,
    assessmentState: assessment.state,
    priorities: prioritiesFor({
      run: runRow,
      blocked: blockedIds.size,
      pending: pendingApplications.length,
      investigations: investigationIds.size,
      failedTasks: failedTasks.length,
      failedRuns: failedRuns.length,
      reconciliationNotes,
      nextRunAt: nextRun?.next_run_at ?? null,
      policyActive: policy.active,
      dryRun,
      dashboardUrl,
    }),
    nextRunAt: nextRun?.next_run_at ?? null,
    dashboardUrl,
    policyActive: policy.active,
    policyThreshold: policy.minMatchScore,
    dryRun,
  };
}

function latestAssignmentFromTasks(tasks: TaskRow[]): string | null {
  return tasks.at(-1)?.title ?? null;
}

/* ---------------------------------- text --------------------------------- */

function renderText(data: ExecutiveBriefData): string {
  const lines: string[] = [];
  lines.push("AT AI WORKFORCE");
  lines.push("01 · DAILY EXECUTIVE BRIEF");
  lines.push(`${data.period.label} · ${RECRUITMENT_TIMEZONE}`);
  lines.push(`Reporting period: ${formatInZone(data.period.start)} – ${formatInZone(data.period.end)}`);
  lines.push("");
  lines.push(`Hello ${data.ownerName},`);
  lines.push("");
  lines.push("02 · EXECUTIVE SUMMARY");
  lines.push(data.assessment);
  if (data.run) {
    lines.push(
      `Run ${data.run.run_key}: ${statusLabel(data.run.status)}; ${data.run.jobs_discovered} discovered, ${data.run.jobs_qualified} qualified, ${data.run.applications_submitted} verified submission(s).`,
    );
  } else {
    lines.push("No recruitment run is linked to this reporting period.");
  }
  if (data.reconciliationNotes.length > 0) {
    lines.push(`Reporting reconciliation: ${data.reconciliationNotes.join(" ")}`);
  }
  lines.push("");
  lines.push("03 · WORKFORCE PERFORMANCE METRICS");
  for (const metric of data.metrics) lines.push(`${metric.label}: ${metric.display} — ${metric.note}`);
  lines.push(
    `Policy: ${policyLabel(data.policyActive)}; threshold ${data.policyThreshold}%; ${data.dryRun ? "dry run enabled" : "live delivery setting"}.`,
  );
  lines.push("");
  lines.push("04 · AGENT-BY-AGENT ACTIVITY");
  for (const agent of data.agents) {
    lines.push(
      `- ${agent.name} (${agent.role}): ${agent.executionState}; ${agent.completed} completed, ${agent.failed} failed, ${agent.open} open.`,
    );
    lines.push(`  Report: ${agent.reconciliation}`);
    if (agent.latestAssignment) lines.push(`  Latest assignment: ${agent.latestAssignment}`);
    if (agent.latestOutput) lines.push(`  Latest evidence: ${agent.latestOutput.replace(/\s+/g, " ").slice(0, 320)}`);
    if (agent.latestError) lines.push(`  Needs attention: ${agent.latestError.slice(0, 320)}`);
  }
  lines.push("");
  lines.push("05 · COMPLETED TASKS AND ACHIEVEMENTS");
  if (!data.run && data.completedTasks.length === 0) {
    lines.push("No completion is asserted: no execution record or completed task exists for this period.");
  } else {
    lines.push(`Completed tasks recorded: ${data.completedTasks.length}`);
    for (const task of data.completedTasks.slice(0, 8)) lines.push(`- ${task.agent_key}: ${task.title}`);
  }
  if (data.achievements.length === 0) {
    lines.push("No verified achievement was recorded in this period.");
  } else {
    for (const achievement of data.achievements) lines.push(`- ${achievement}`);
  }
  lines.push("");
  lines.push("06 · BLOCKED EXCEPTIONS AND INVESTIGATIONS");
  lines.push(
    `Blocked applications: ${data.exceptionCounts.blockedApplications}; open investigations: ${data.exceptionCounts.investigations}; failed tasks: ${data.exceptionCounts.failedTasks}; failed submissions: ${data.exceptionCounts.failedSubmissions}; failed runs: ${data.exceptionCounts.failedRuns}.`,
  );
  if (data.exceptions.length === 0) {
    lines.push("No blocked application, failed submission, failed task or failed run was recorded for this period.");
  } else {
    for (const item of data.exceptions.slice(0, 8)) {
      lines.push(`- ${item.title}: ${item.detail}${item.reference ? ` [${item.reference}]` : ""}`);
    }
    if (data.exceptions.length > 8) lines.push(`- ${data.exceptions.length - 8} more exception(s) are recorded in the dashboard.`);
  }
  lines.push("");
  lines.push("07 · COORDINATOR'S ASSESSMENT");
  lines.push(data.assessment);
  lines.push("");
  lines.push("08 · NEXT OPERATIONAL PRIORITIES");
  data.priorities.forEach((priority, index) => lines.push(`${index + 1}. ${priority}`));
  lines.push("");
  lines.push("09 · DASHBOARD ACCESS");
  lines.push(
    data.dashboardUrl
      ? `Open the AT AI Workforce dashboard: ${data.dashboardUrl}`
      : "Dashboard link unavailable because no public APP_BASE_URL is configured. No localhost link is emitted.",
  );
  lines.push("");
  lines.push("10 · COORDINATOR SIGNATURE");
  for (const line of agentSignature("coordinator")) lines.push(line);
  lines.push("Autonomous Recruitment & Workforce Operations");
  lines.push("");
  lines.push(`Generated ${formatInZone(data.generatedAt)} (${RECRUITMENT_TIMEZONE}).`);
  lines.push("Counts come from persisted records. A submission is counted only with verified employer evidence. Missing records are identified as missing, not converted to zero.");
  return lines.join("\n");
}

/* ---------------------------------- HTML --------------------------------- */

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sectionHeading(number: string, title: string, subtitle?: string): string {
  return `<div style="margin:0 0 12px;">
    <div style="font-size:10px;line-height:1.3;font-weight:700;letter-spacing:.16em;color:#a67c2e;text-transform:uppercase;">${escapeHtml(number)}</div>
    <h2 style="margin:4px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#0a2540;font-weight:700;">${escapeHtml(title)}</h2>
    ${subtitle ? `<p style="margin:4px 0 0;font-size:12px;line-height:1.55;color:#64748b;">${escapeHtml(subtitle)}</p>` : ""}
  </div>`;
}

function emptyState(message: string): string {
  return `<div style="border:1px dashed #cbd5e1;border-radius:8px;background:#f8fafc;padding:13px 15px;color:#64748b;font-size:12px;line-height:1.55;">${escapeHtml(message)}</div>`;
}

function bulletList(items: string[], empty: string): string {
  if (items.length === 0) return emptyState(empty);
  return `<ul style="margin:0;padding:0 0 0 18px;color:#334155;font-size:12px;line-height:1.65;">${items
    .map((item) => `<li style="margin:0 0 5px;">${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function metricCell(metric: ExecutiveBriefMetric): string {
  return `<td class="metric-cell" width="33.333%" valign="top" style="padding:5px;">
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-top:3px solid ${escapeHtml(metric.tone)};border-radius:7px;padding:13px 12px;min-height:76px;">
      <div style="font-size:10px;line-height:1.35;color:#64748b;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(metric.label)}</div>
      <div style="margin-top:5px;font-family:Georgia,'Times New Roman',serif;font-size:25px;line-height:1.1;font-weight:700;color:#0a2540;">${escapeHtml(metric.display)}</div>
      <div style="margin-top:5px;font-size:10px;line-height:1.4;color:#7a8a9a;">${escapeHtml(metric.note)}</div>
    </div>
  </td>`;
}

function agentRows(data: ExecutiveBriefData): string {
  return data.agents
    .map(
      (agent, index) => `<tr style="background:${index % 2 === 0 ? "#ffffff" : "#f8fafc"};">
        <td style="padding:10px 9px;border-bottom:1px solid #e8eef4;vertical-align:top;">
          <div style="font-size:12px;font-weight:700;color:#0a2540;">${escapeHtml(agent.name)}</div>
          <div style="font-size:10px;line-height:1.4;color:#64748b;">${escapeHtml(agent.role)}</div>
        </td>
        <td style="padding:10px 9px;border-bottom:1px solid #e8eef4;vertical-align:top;font-size:11px;line-height:1.45;color:#334155;">
          ${escapeHtml(agent.executionState)}
          <div style="margin-top:2px;font-size:10px;color:#7a8a9a;">${escapeHtml(agent.reported ? "Reporting" : "No report")} · ${escapeHtml(agent.completed)} done / ${escapeHtml(agent.failed)} failed / ${escapeHtml(agent.open)} open</div>
        </td>
        <td style="padding:10px 9px;border-bottom:1px solid #e8eef4;vertical-align:top;font-size:10px;line-height:1.45;color:${agent.latestError ? "#b42318" : "#475569"};">
          ${escapeHtml(agent.latestError ?? agent.reconciliation)}
          ${agent.latestAssignment ? `<div style="margin-top:3px;color:#7a8a9a;">${escapeHtml(agent.latestAssignment)}</div>` : ""}
        </td>
      </tr>`,
    )
    .join("");
}

function renderHtml(data: ExecutiveBriefData): string {
  const [chiefName, chiefTitle, chiefCompany] = agentSignature("coordinator");
  const assessmentTone =
    data.assessmentState === "attention_required" || data.assessmentState === "degraded"
      ? "#b42318"
      : data.assessmentState === "no_execution_record"
        ? "#9a6700"
        : "#0d6fa8";
  const exceptionTone = data.exceptions.length > 0 ? "#b42318" : "#1f7a4d";
  const metricRows = [0, 3].map((start) => `<tr>${data.metrics.slice(start, start + 3).map(metricCell).join("")}</tr>`).join("");
  const completed = data.completedTasks.slice(0, 8).map((task) => `${task.agent_key}: ${task.title}`);
  const exceptionItems = data.exceptions.slice(0, 8).map((item) => `${item.title} — ${item.detail}`);
  if (data.exceptions.length > 8) {
    exceptionItems.push(`${data.exceptions.length - 8} more exception(s) are recorded in the dashboard.`);
  }
  const summaryLine = data.run
    ? `Run ${data.run.run_key} · ${statusLabel(data.run.status)} · ${data.run.jobs_discovered} discovered · ${data.run.jobs_qualified} qualified · ${data.run.applications_submitted} verified submission(s)`
    : "No recruitment execution record is linked to this reporting period.";
  const dashboardBlock = data.dashboardUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0;">
        <tr><td bgcolor="#c6a15b" style="border-radius:6px;padding:11px 18px;">
          <a href="${escapeHtml(data.dashboardUrl)}" target="_blank" rel="noopener" style="display:inline-block;color:#0a2540;font-size:13px;line-height:1.3;font-weight:700;text-decoration:none;">Open AT AI Workforce dashboard →</a>
        </td></tr>
      </table>
      <div style="margin-top:8px;font-size:10px;line-height:1.5;color:#7a8a9a;word-break:break-all;">${escapeHtml(data.dashboardUrl)}</div>`
    : emptyState("Dashboard link unavailable. A public APP_BASE_URL must be configured; no localhost link is emitted.");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>AT AI Workforce | Daily Executive Brief | ${escapeHtml(data.period.shortLabel)}</title>
<!--[if mso]>
<style type="text/css">
  body, table, td, a { font-family: Arial, Helvetica, sans-serif !important; }
  .metric-cell { width:33.333% !important; }
</style>
<![endif]-->
<style>
  body, table, td, a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  a { color:#0d6fa8; }
  @media only screen and (max-width:600px) {
    .container { width:100% !important; max-width:100% !important; }
    .pad { padding:20px 16px !important; }
    .header-pad { padding:22px 18px !important; }
    .metric-cell { display:block !important; width:100% !important; box-sizing:border-box; }
    .stack-col { display:block !important; width:100% !important; box-sizing:border-box; }
    .agent-table { table-layout:fixed !important; width:100% !important; }
    .agent-table th, .agent-table td { padding:7px 4px !important; font-size:10px !important; word-break:break-word !important; overflow-wrap:anywhere !important; }
    .signature { display:block !important; width:100% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f6;color:#1e293b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Daily executive brief for ${escapeHtml(data.period.label)}: ${escapeHtml(data.metrics.map((metric) => `${metric.label} ${metric.display}`).join(", "))}.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f6;">
  <tr><td align="center" style="padding:22px 10px;">
    <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 6px 22px rgba(10,37,64,.10);">
      <tr><td class="header-pad" bgcolor="#0a2540" style="background:#0a2540;padding:26px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="66" valign="middle" style="width:66px;">
              <div style="width:50px;height:50px;background:#0a2540;border:2px solid #c6a15b;border-radius:8px;text-align:center;line-height:50px;">
                <span style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;color:#d4af5a;letter-spacing:-1px;">AT</span>
              </div>
            </td>
            <td valign="middle" style="padding-left:16px;">
              <div style="font-size:10px;line-height:1.3;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#d4af5a;">01 · Daily Executive Brief</div>
              <div style="margin-top:5px;font-family:Georgia,'Times New Roman',serif;font-size:24px;line-height:1.2;font-weight:700;color:#ffffff;">AT AI Workforce</div>
              <div style="margin-top:4px;font-size:13px;line-height:1.4;color:#b9cfe0;">${escapeHtml(data.period.label)} · ${escapeHtml(RECRUITMENT_TIMEZONE)}</div>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td height="4" bgcolor="#c6a15b" style="height:4px;background:#c6a15b;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td class="pad" style="padding:28px 30px;">
        <p style="margin:0 0 16px;color:#334155;font-size:13px;line-height:1.6;">Hello ${escapeHtml(data.ownerName)},</p>
        ${sectionHeading("02", "Executive summary", summaryLine)}
        <p style="margin:0 0 12px;color:#334155;font-size:13px;line-height:1.7;">${escapeHtml(data.assessment)}</p>
        ${data.reconciliationNotes.length > 0
          ? `<div style="margin:0 0 12px;padding:11px 13px;background:#fff8e8;border:1px solid #f0d7a4;border-radius:7px;color:#6b4e16;font-size:11px;line-height:1.6;"><strong>Reporting reconciliation:</strong> ${escapeHtml(data.reconciliationNotes.join(" "))}</div>`
          : `<div style="margin:0 0 12px;padding:11px 13px;background:#eef8f2;border:1px solid #cfe8d8;border-radius:7px;color:#1f5c3b;font-size:11px;line-height:1.6;"><strong>Reporting reconciliation:</strong> Agent records reconcile with the persisted execution ledger.</div>`}
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("03", "Workforce performance metrics", "Activity counts use the Europe/Zurich reporting day. Blocked and pending figures are the current queue at generation time.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 -5px;">${metricRows}</table>
        <div style="margin-top:9px;font-size:10px;line-height:1.5;color:#7a8a9a;">Policy: ${escapeHtml(policyLabel(data.policyActive))}; threshold ${escapeHtml(data.policyThreshold)}%; ${escapeHtml(data.dryRun ? "dry run enabled" : "live submission setting")}.</div>
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("04", "Agent-by-agent activity", "Every registered agent is listed, including an agent with no structured report.")}
        <table role="presentation" class="agent-table" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;font-size:11px;">
          <tr bgcolor="#f1f5f9" style="background:#f1f5f9;">
            <th align="left" style="width:28%;padding:9px 8px;border-bottom:1px solid #dbe5ee;color:#0a2540;font-size:9px;text-transform:uppercase;letter-spacing:.07em;">Agent</th>
            <th align="left" style="width:20%;padding:9px 8px;border-bottom:1px solid #dbe5ee;color:#0a2540;font-size:9px;text-transform:uppercase;letter-spacing:.07em;">Execution</th>
            <th align="left" style="width:52%;padding:9px 8px;border-bottom:1px solid #dbe5ee;color:#0a2540;font-size:9px;text-transform:uppercase;letter-spacing:.07em;">Reconciliation / evidence</th>
          </tr>
          ${agentRows(data)}
        </table>
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("05", "Completed tasks and achievements", "Only completed tasks and verified records are counted.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td class="stack-col" width="50%" valign="top" style="padding:0 8px 0 0;">
              <div style="font-size:11px;font-weight:700;color:#0a2540;margin:0 0 7px;text-transform:uppercase;letter-spacing:.06em;">Completed tasks</div>
              ${bulletList(completed, !data.run ? "No completion is asserted: no execution record exists for this period." : "The run recorded no completed task in this period.")}
            </td>
            <td class="stack-col" width="50%" valign="top" style="padding:0 0 0 8px;">
              <div style="font-size:11px;font-weight:700;color:#0a2540;margin:0 0 7px;text-transform:uppercase;letter-spacing:.06em;">Recorded achievements</div>
              ${bulletList(data.achievements, "No verified achievement was recorded in this period.")}
            </td>
          </tr>
        </table>
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("06", "Blocked exceptions and investigations", "Unresolved work stays visible; an unverified outcome is never presented as a success.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;background:#f8fafc;border:1px solid #e2e8f0;border-left:3px solid ${exceptionTone};border-radius:6px;">
          <tr><td style="padding:10px 12px;font-size:11px;line-height:1.6;color:#475569;">
            Blocked applications: <strong>${escapeHtml(data.exceptionCounts.blockedApplications)}</strong> · Open investigations: <strong>${escapeHtml(data.exceptionCounts.investigations)}</strong> · Failed tasks: <strong>${escapeHtml(data.exceptionCounts.failedTasks)}</strong> · Failed submissions: <strong>${escapeHtml(data.exceptionCounts.failedSubmissions)}</strong> · Failed runs: <strong>${escapeHtml(data.exceptionCounts.failedRuns)}</strong>
          </td></tr>
        </table>
        ${bulletList(exceptionItems, "No blocked application, failed submission, failed task or failed run was recorded for this period.")}
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("07", "Coordinator's assessment", "Deterministic assessment of the persisted evidence; no success is inferred from an agent narrative.")}
        <div style="border-left:4px solid ${assessmentTone};background:#f8fafc;border-radius:0 7px 7px 0;padding:13px 15px;color:#334155;font-size:12px;line-height:1.7;">${escapeHtml(data.assessment)}</div>
        <div style="height:22px;line-height:22px;">&nbsp;</div>

        ${sectionHeading("08", "Next operational priorities", "The Coordinator's ordered operating actions.")}
        ${data.priorities.length > 0
          ? `<ol style="margin:0;padding:0 0 0 19px;color:#334155;font-size:12px;line-height:1.7;">${data.priorities.map((item) => `<li style="margin:0 0 6px;">${escapeHtml(item)}</li>`).join("")}</ol>`
          : emptyState("No operational priority was recorded.")}
        <div style="height:24px;line-height:24px;">&nbsp;</div>

        ${sectionHeading("09", "Dashboard access", "Open the current workforce dashboard for the full operational record.")}
        ${dashboardBlock}
        <div style="height:26px;line-height:26px;">&nbsp;</div>

        ${sectionHeading("10", "Coordinator signature")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;">
          <tr>
            <td class="signature" width="60" valign="top" style="padding:14px 12px 14px 15px;width:60px;"><div style="width:42px;height:42px;background:#0a2540;border:2px solid #c6a15b;border-radius:7px;text-align:center;line-height:42px;"><span style="font-family:Georgia,serif;font-size:17px;font-weight:700;color:#d4af5a;">AT</span></div></td>
            <td class="signature" valign="top" style="padding:14px 15px 14px 0;font-size:12px;line-height:1.6;color:#334155;">
              <strong style="color:#0a2540;">${escapeHtml(chiefName)}</strong><br>
              ${escapeHtml(chiefTitle)}<br>
              ${escapeHtml(chiefCompany)}<br>
              <span style="color:#64748b;">Autonomous Recruitment &amp; Workforce Operations</span>
            </td>
          </tr>
        </table>
        <p style="margin:14px 0 0;color:#7a8a9a;font-size:11px;line-height:1.6;">This brief is generated only by ${escapeHtml(chiefName)}, ${escapeHtml(chiefTitle)}, from persisted workforce records. Routine specialist updates are consolidated here.</p>
      </td></tr>
      <tr><td style="background:#f7f9fc;border-top:1px solid #dfe8f1;padding:18px 30px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="42" style="width:42px;vertical-align:top;"><img src="cid:atw-logo" width="34" height="28" alt="AT AI Workforce" style="display:block;width:34px;height:auto;border-radius:4px;"></td>
            <td style="padding-left:11px;vertical-align:top;font-size:10px;line-height:1.6;color:#7a8a9a;">
              <strong style="color:#0a2540;">AT AI Workforce</strong> · Daily Executive Brief · ${escapeHtml(data.period.label)}<br>
              Generated ${escapeHtml(formatInZone(data.generatedAt))} (${escapeHtml(RECRUITMENT_TIMEZONE)}). Reporting period ${escapeHtml(formatInZone(data.period.start))} – ${escapeHtml(formatInZone(data.period.end))}.<br>
              Verified submissions only. Missing records are identified as missing, not converted to zero.
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function buildExecutiveBriefEmail(
  now: Date = new Date(),
  options: { baseUrl?: string | null } = {},
): ExecutiveBriefEmail {
  const data = collectBrief(now, options);
  return {
    subject: `AT Workforce | Daily Executive Brief | ${data.period.shortLabel}`,
    html: renderHtml(data),
    text: renderText(data),
    dashboardUrl: data.dashboardUrl,
    period: data.period,
    data,
  };
}

/* ------------------------------- scheduling ------------------------------- */

export type ExecutiveBriefSchedule = {
  key: string;
  label: string;
  time: string;
  timezone: string;
  enabled: number;
  weekdays: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  last_scheduled_for: string | null;
};

export function ensureExecutiveBriefSchedule(now: Date = new Date()): ExecutiveBriefSchedule {
  const existing = one<ExecutiveBriefSchedule>(
    "SELECT key, label, time, timezone, enabled, weekdays, next_run_at, last_run_at, last_run_id, last_status, last_error, last_checked_at, last_scheduled_for FROM schedule_jobs WHERE key = ?",
    [EXECUTIVE_BRIEF_SCHEDULE_KEY],
  );
  if (existing) return { ...existing, weekdays: existing.weekdays ?? JSON.stringify(EXECUTIVE_BRIEF_WEEKDAYS) };
  run(
    "INSERT OR IGNORE INTO schedule_jobs (key, label, time, timezone, enabled, weekdays, next_run_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    [
      EXECUTIVE_BRIEF_SCHEDULE_KEY,
      "Daily recruitment report",
      EXECUTIVE_BRIEF_TIME,
      RECRUITMENT_TIMEZONE,
      JSON.stringify(EXECUTIVE_BRIEF_WEEKDAYS),
      nextScheduledRun(now, { time: EXECUTIVE_BRIEF_TIME, weekdays: EXECUTIVE_BRIEF_WEEKDAYS }).toISOString(),
      nowIso(),
    ],
  );
  const created = one<ExecutiveBriefSchedule>(
    "SELECT key, label, time, timezone, enabled, weekdays, next_run_at, last_run_at, last_run_id, last_status, last_error, last_checked_at, last_scheduled_for FROM schedule_jobs WHERE key = ?",
    [EXECUTIVE_BRIEF_SCHEDULE_KEY],
  );
  if (!created) throw new Error("The executive brief schedule could not be created.");
  return { ...created, weekdays: created.weekdays ?? JSON.stringify(EXECUTIVE_BRIEF_WEEKDAYS) };
}

export function executiveBriefScheduleSnapshot(now: Date = new Date()): ExecutiveBriefSchedule & {
  due: boolean;
  missed: boolean;
  weekdaysList: number[];
  scheduledToday: boolean;
  requiresRunningHost: true;
} {
  const row = ensureExecutiveBriefSchedule(now);
  const weekdaysList = parseWeekdays(row.weekdays);
  const next = row.next_run_at ? Date.parse(row.next_run_at) : NaN;
  const scheduledToday = row.enabled === 1 && weekdaysList.includes(localWeekday(now, row.timezone));
  const overdue = scheduledToday && Number.isFinite(next) ? now.getTime() - next : 0;
  return {
    ...row,
    weekdaysList,
    scheduledToday,
    due: scheduledToday && Number.isFinite(next) && overdue >= 0,
    missed: scheduledToday && Number.isFinite(next) && overdue > catchUpWindowHours() * 3600_000,
    requiresRunningHost: true,
  };
}

function markBriefSchedule(input: {
  now: Date;
  status: string;
  error?: string | null;
  nextRunAt: string;
  runId?: string | null;
  scheduledFor?: string | null;
}): void {
  run(
    `UPDATE schedule_jobs SET last_run_at = ?, last_run_id = COALESCE(?, last_run_id),
       last_status = ?, last_error = ?, next_run_at = ?, last_checked_at = ?, last_scheduled_for = COALESCE(?, last_scheduled_for), updated_at = ?
     WHERE key = ?`,
    [
      input.now.toISOString(),
      input.runId ?? null,
      input.status,
      input.error ?? null,
      input.nextRunAt,
      input.now.toISOString(),
      input.scheduledFor ?? null,
      nowIso(),
      EXECUTIVE_BRIEF_SCHEDULE_KEY,
    ],
  );
}

/**
 * Called by the existing scheduler tick. The schedule row is the durable clock;
 * this function only decides whether the one daily brief is due.
 */
export async function tickExecutiveBriefSchedule(now: Date = new Date()): Promise<{
  status: "not_due" | "not_scheduled_today" | "disabled" | "missed" | ExecutiveBriefSendStatus | "failed";
  nextRunAt: string | null;
  detail: string;
}> {
  run("UPDATE schedule_jobs SET last_checked_at = ?, updated_at = ? WHERE key = ?", [
    now.toISOString(),
    nowIso(),
    EXECUTIVE_BRIEF_SCHEDULE_KEY,
  ]);
  const schedule = executiveBriefScheduleSnapshot(now);
  if (schedule.enabled !== 1) {
    return { status: "disabled", nextRunAt: schedule.next_run_at, detail: "The executive brief schedule is disabled." };
  }
  if (!schedule.scheduledToday) {
    return {
      status: "not_scheduled_today",
      nextRunAt: schedule.next_run_at,
      detail: `Today is not a configured report day. The next report is due ${schedule.next_run_at ?? "at the next selected weekday"}.`,
    };
  }
  if (!schedule.due) {
    return { status: "not_due", nextRunAt: schedule.next_run_at, detail: "The next executive brief is not due." };
  }
  if (schedule.missed) {
    const next = nextScheduledRun(now, { time: schedule.time, timeZone: schedule.timezone, weekdays: schedule.weekdaysList }).toISOString();
    markBriefSchedule({
      now,
      status: "missed",
      error: "The scheduled brief was more than the catch-up window late and was not sent as a current brief.",
      nextRunAt: next,
      scheduledFor: schedule.next_run_at,
    });
    return {
      status: "missed",
      nextRunAt: next,
      detail: "The scheduled brief was outside the catch-up window; it was not sent late.",
    };
  }
  try {
    const result = await sendDailyExecutiveBrief({ now });
    const next = nextScheduledRun(now, { time: schedule.time, timeZone: schedule.timezone, weekdays: schedule.weekdaysList }).toISOString();
    markBriefSchedule({
      now,
      status: result.status,
      error: ["failed", "blocked", "no_recipient"].includes(result.status) ? result.detail : null,
      nextRunAt: next,
      runId: result.reportId,
      scheduledFor: schedule.next_run_at,
    });
    return { status: result.status, nextRunAt: next, detail: result.detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Executive brief generation failed.";
    const retry = new Date(now.getTime() + 15 * 60_000).toISOString();
    markBriefSchedule({ now, status: "failed", error: message.slice(0, 800), nextRunAt: retry });
    return { status: "failed", nextRunAt: retry, detail: message };
  }
}

/* -------------------------------- delivery -------------------------------- */

export function executiveBriefReportId(period: ExecutiveBriefPeriod): string {
  return `brief:${period.key}`;
}

function maskRecipient(value: string | null): string | null {
  return value ? value.replace(/^(.).*(@.*)$/, "$1***$2") : null;
}

function testMarkedEmail(content: ExecutiveBriefEmail): ExecutiveBriefEmail {
  const prefix = "[TEST MESSAGE — controlled delivery verification; not a live operational report]\n\n";
  const banner = `<div style="background:#7a2e1f;color:#ffffff;padding:10px 16px;font:13px/1.5 Arial,sans-serif;text-align:center;">TEST MESSAGE — controlled delivery verification; not a live operational report.</div>`;
  return {
    ...content,
    subject: `[TEST] ${content.subject}`,
    text: `${prefix}${content.text}`,
    html: content.html.replace(/(<body[^>]*>)/i, `$1${banner}`),
  };
}

function deliverySnapshot(input: {
  row: OutboxRow | null;
  reportId: string;
  period: ExecutiveBriefPeriod;
  generatedAt: string;
  dashboardUrl: string | null;
  state?: DeliveryState;
  detail?: string | null;
  subject?: string | null;
}): ExecutiveBriefDelivery {
  const row = input.row;
  const state = input.state ?? deliveryStateForRow(row);
  const lastError = row?.last_error ?? null;
  const detail = input.detail ?? row?.delivery_evidence ?? lastError ?? null;
  const dashboardUrl = input.dashboardUrl ?? null;
  return {
    reportId: row?.report_id ?? input.reportId,
    notificationId: row?.notification_id ?? null,
    outboxId: row?.id ?? null,
    period: input.period,
    state,
    message: deliveryStateMessage(state, lastError ?? detail),
    detail: detail ?? "No further delivery evidence is recorded.",
    recipient: row?.recipient ?? null,
    recipientMasked: maskRecipient(row?.recipient ?? null),
    sender: row?.sender ?? null,
    subject: row?.subject ?? input.subject ?? null,
    messageId: row?.provider_message_id ?? null,
    threadId: row?.provider_thread_id ?? null,
    rfcMessageId: row?.rfc_message_id ?? null,
    attempts: Number(row?.attempts ?? 0),
    resendCount: Number(row?.resend_count ?? 0),
    startedAt: row?.started_at ?? null,
    finishedAt: row?.finished_at ?? null,
    lastError,
    nextRetryAt: row?.status === "retry_scheduled" ? row.available_at : null,
    sentObservedAt: row?.sent_observed_at ?? null,
    sentVerification: row?.sent_verification ?? null,
    deliveryEvidence: row?.delivery_evidence ?? null,
    bounceInfo: row?.bounce_info ?? null,
    appResponse: row?.gmail_response ?? null,
    dashboardUrl,
    canResend: ["failed", "blocked", "bounced"].includes(state),
    generatedAt: input.generatedAt,
  };
}

export async function sendDailyExecutiveBrief(options: {
  now?: Date;
  baseUrl?: string | null;
} = {}): Promise<ExecutiveBriefSendResult> {
  const now = options.now ?? new Date();
  const period = executiveBriefPeriod(now);
  const reportId = executiveBriefReportId(period);
  const content = buildExecutiveBriefEmail(now, { baseUrl: options.baseUrl });
  if (getSetting<boolean>("notify_daily_report", true) === false) {
    const result: ExecutiveBriefSendResult = {
      status: "disabled",
      period,
      notificationId: null,
      outboxId: null,
      reportId,
      deliveryState: "blocked",
      emailQueued: false,
      detail: "Daily report delivery is disabled in settings.",
      generatedAt: now.toISOString(),
    };
    setSetting("executive_brief_last", result);
    return result;
  }
  const recipient = notificationRecipient();
  if (!recipient) {
    const result: ExecutiveBriefSendResult = {
      status: "no_recipient",
      period,
      notificationId: null,
      outboxId: null,
      reportId,
      deliveryState: "blocked",
      emailQueued: false,
      detail: "No configured notification recipient is available.",
      generatedAt: now.toISOString(),
    };
    setSetting("executive_brief_last", result);
    audit({ action: "coordinator.executive_brief_blocked", entity: "email", detail: result.detail });
    return result;
  }
  // A missing public dashboard URL no longer blocks the report. The builder
  // omits the CTA and never emits a loopback/private destination.
  const queued = notify({
    kind: EXECUTIVE_BRIEF_KIND,
    dedupeKey: `executive_brief:${period.key}`,
    reportId,
    subject: content.subject,
    body: content.text,
    emailBody: content.text,
    html: content.html,
  });
  const existing = outboxByDedupeKey(`executive_brief:${period.key}`);
  const deliveryState = existing ? deliveryStateForRow(existing) : queued.deliveryState;
  const status: ExecutiveBriefSendStatus = queued.emailQueued
    ? "queued"
    : queued.emailReason?.startsWith("duplicate")
      ? "duplicate"
      : queued.emailReason === "email event disabled"
        ? "blocked"
        : "in_app_only";
  const delivery = deliverySnapshot({
    row: existing,
    reportId,
    period,
    generatedAt: now.toISOString(),
    dashboardUrl: content.dashboardUrl,
    state: deliveryState,
    detail: queued.emailReason,
    subject: content.subject,
  });
  const result: ExecutiveBriefSendResult = {
    status,
    period,
    notificationId: queued.notificationId,
    outboxId: queued.outboxId,
    reportId,
    deliveryState,
    emailQueued: queued.emailQueued,
    detail:
      status === "queued"
        ? "Queued to the durable Gmail outbox. Gmail acceptance is recorded separately from inbox delivery."
        : status === "duplicate"
          ? "Today's executive brief already exists; a second copy was not queued."
          : queued.emailReason ?? "The in-app report was recorded, but no email was queued.",
    generatedAt: now.toISOString(),
  };
  setSetting("executive_brief_last", {
    ...result,
    recipientMasked: maskRecipient(recipient),
    dashboardUrl: content.dashboardUrl,
    delivery,
  });
  audit({
    action: status === "queued" ? "coordinator.executive_brief_queued" : "coordinator.executive_brief_not_queued",
    entity: "email",
    detail: `${period.key}: ${status} — ${result.detail}`.slice(0, 1000),
  });
  return result;
}

/**
 * Explicit immediate send. Generates the current brief, validates Gmail
 * readiness, processes the dedicated outbox row and returns the persisted
 * evidence state. It never waits for the 16:00 schedule and never sends twice
 * unless the caller explicitly requests a resend of a terminal failure.
 */
export async function sendExecutiveBriefNow(options: {
  now?: Date;
  userId?: string | null;
  source?: "coordinator" | "admin" | "test";
  resend?: boolean;
  test?: boolean;
  send?: OutboxSender;
  readiness?: () => Promise<{ ok: boolean; code?: string; detail: string; email: string | null }>;
} = {}): Promise<ExecutiveBriefDelivery> {
  const now = options.now ?? new Date();
  const period = executiveBriefPeriod(now);
  const generatedAt = now.toISOString();
  const reportId = options.test ? `brief:test:${period.key}` : executiveBriefReportId(period);
  const dedupeKey = options.test ? `executive_brief_test:${period.key}` : `executive_brief:${period.key}`;
  const baseContent = buildExecutiveBriefEmail(now);
  const content = options.test ? testMarkedEmail(baseContent) : baseContent;
  const recipient = notificationRecipient();
  const sender = notificationSender();
  const finish = (row: OutboxRow | null, state: DeliveryState, detail: string): ExecutiveBriefDelivery => {
    const delivery = deliverySnapshot({
      row,
      reportId,
      period,
      generatedAt,
      dashboardUrl: content.dashboardUrl,
      state,
      detail,
      subject: content.subject,
    });
    // A test-marked message is recorded in the outbox/history but must not
    // overwrite the operational "latest brief" state.
    if (!options.test) {
      setSetting("executive_brief_last", {
        ...delivery,
        recipientMasked: maskRecipient(recipient),
        dashboardUrl: content.dashboardUrl,
        generatedAt,
      });
    }
    audit({
      action: `coordinator.executive_brief_send_now_${delivery.state}`,
      entity: "email",
      entityId: delivery.outboxId ?? reportId,
      userId: options.userId ?? null,
      detail: [
        `source=${options.source ?? "coordinator"}`,
        `report=${reportId}`,
        `outbox=${delivery.outboxId ?? "none"}`,
        `state=${delivery.state}`,
        `attempts=${delivery.attempts}`,
        `messageId=${delivery.messageId ?? "none"}`,
        detail,
      ].join(" · ").slice(0, 1400),
    });
    return delivery;
  };

  if (getSetting<boolean>("notify_daily_report", true) === false) {
    return finish(null, "blocked", "Daily report delivery is disabled in Settings.");
  }
  if (!recipient) {
    return finish(null, "blocked", "No configured notification recipient is available. Gmail must be connected and the owner address saved.");
  }
  const readiness = options.readiness
    ? await options.readiness()
    : await import("./gmail").then((gmail) => gmail.gmailSendReadiness());
  if (!readiness.ok) {
    return finish(null, "blocked", readiness.detail);
  }

  const existing = outboxByDedupeKey(dedupeKey);
  if (existing) {
    const state = deliveryStateForRow(existing);
    if (!options.resend) {
      const detail = ["failed", "blocked", "bounced"].includes(state)
        ? `${existing.last_error ?? existing.delivery_evidence ?? "The previous attempt did not result in delivery."} A new copy requires an explicit resend.`
        : "This report already has an outbox record; a duplicate was not submitted.";
      return finish(existing, state, detail);
    }
    if (!["failed", "blocked", "bounced"].includes(state)) {
      return finish(existing, state, "Resend is allowed only after a definitive failure, block or bounce. No message was submitted.");
    }
    const reset = resetOutboxForResend({
      outboxId: existing.id,
      to: recipient,
      subject: content.subject,
      body: content.text,
      html: content.html,
      sender,
      reportId,
      now,
      deferQueue: true,
    });
    if (!reset) return finish(existing, state, "The outbox row could not be reset for resend.");
  } else {
    const queued = notify({
      kind: EXECUTIVE_BRIEF_KIND,
      dedupeKey,
      reportId,
      subject: content.subject,
      body: content.text,
      emailBody: content.text,
      html: content.html,
      deferQueue: true,
    });
    if (!queued.emailQueued) {
      return finish(queued.outboxId ? outboxById(queued.outboxId) : null, queued.deliveryState, queued.emailReason ?? "The report was generated but no email was queued.");
    }
  }

  const outboxId = outboxByDedupeKey(dedupeKey)?.id;
  if (!outboxId) return finish(null, "failed", "The outbox record was not created.");
  await drainNotificationQueue({ outboxId, limit: 1, now, send: options.send });
  // Another already-running worker may have claimed the row between the insert
  // and this call. Wait for its persisted result instead of returning a stale
  // "queued" state. This never submits a second message.
  let row = outboxById(outboxId);
  const deadline = Date.now() + 20_000;
  while (
    row &&
    ["queued", "sending"].includes(deliveryStateForRow(row)) &&
    row.status !== "retry_scheduled" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    row = outboxById(outboxId);
  }
  const state = deliveryStateForRow(row);
  return finish(row, state, row?.last_error ?? row?.delivery_evidence ?? "Delivery attempt completed.");
}

/** Read the latest persisted result without sending or probing Gmail. */
export function latestExecutiveBriefDelivery(): ExecutiveBriefDelivery {
  const row = one<OutboxRow>(
    "SELECT * FROM notification_outbox WHERE kind = ? AND dedupe_key NOT LIKE 'executive_brief_test:%' ORDER BY created_at DESC LIMIT 1",
    [EXECUTIVE_BRIEF_KIND],
  );
  const stored = getSetting<(ExecutiveBriefSendResult & { delivery?: ExecutiveBriefDelivery }) | null>("executive_brief_last", null);
  const operationalStored = stored && !(stored.reportId ?? "").startsWith("brief:test:") ? stored : null;
  const period = row?.report_id ? executiveBriefPeriod(new Date()) : operationalStored?.period ?? executiveBriefPeriod(new Date());
  const dashboardUrl = operationalStored?.delivery?.dashboardUrl ?? null;
  if (row) {
    return deliverySnapshot({
      row,
      reportId: row.report_id ?? executiveBriefReportId(period),
      period,
      generatedAt: row.created_at,
      dashboardUrl,
    });
  }
  if (operationalStored) {
    return deliverySnapshot({
      row: null,
      reportId: operationalStored.reportId ?? executiveBriefReportId(period),
      period,
      generatedAt: operationalStored.generatedAt,
      dashboardUrl,
      state: operationalStored.delivery?.state ?? operationalStored.deliveryState ?? "generated",
      detail: operationalStored.detail,
    });
  }
  return deliverySnapshot({
    row: null,
    reportId: executiveBriefReportId(period),
    period,
    generatedAt: nowIso(),
    dashboardUrl,
    state: "generated",
  });
}

/** Recheck the Sent label for the latest brief without creating another send. */
export async function refreshLatestExecutiveBriefDelivery(): Promise<ExecutiveBriefDelivery> {
  const current = latestExecutiveBriefDelivery();
  if (!current.outboxId) return current;
  await refreshOutboxSentObservation(current.outboxId);
  const row = outboxById(current.outboxId);
  return deliverySnapshot({
    row,
    reportId: current.reportId,
    period: current.period,
    generatedAt: current.generatedAt,
    dashboardUrl: current.dashboardUrl,
    state: deliveryStateForRow(row),
    detail: row?.last_error ?? row?.delivery_evidence,
    subject: current.subject,
  });
}

export function executiveBriefHistory(limit = 10): Array<{
  id: number;
  subject: string;
  created_at: string;
  delivery_status: string | null;
  provider_message_id: string | null;
  outbox_status: string | null;
  attempts: number | null;
  last_error: string | null;
  finished_at: string | null;
  outbox_id: string | null;
  report_id: string | null;
  delivery: string | null;
  delivery_state: DeliveryState;
  sender: string | null;
  recipient: string | null;
  provider_thread_id: string | null;
  rfc_message_id: string | null;
  resend_count: number | null;
  started_at: string | null;
  available_at: string | null;
  sent_observed_at: string | null;
  sent_verification: string | null;
  delivery_evidence: string | null;
  bounce_info: string | null;
}> {
  const rows = all<{
    id: number;
    subject: string;
    created_at: string;
    delivery_status: string | null;
    provider_message_id: string | null;
    outbox_status: string | null;
    attempts: number | null;
    last_error: string | null;
    finished_at: string | null;
    outbox_id: string | null;
    report_id: string | null;
    delivery: string | null;
    sender: string | null;
    recipient: string | null;
    provider_thread_id: string | null;
    rfc_message_id: string | null;
    resend_count: number | null;
    started_at: string | null;
    available_at: string | null;
    sent_observed_at: string | null;
    sent_verification: string | null;
    delivery_evidence: string | null;
    bounce_info: string | null;
  }>(
    `SELECT n.id, n.subject, n.created_at, n.delivery_status, n.provider_message_id,
            o.id AS outbox_id, o.report_id, o.status AS outbox_status, o.delivery, o.attempts, o.resend_count,
            o.sender, o.recipient, o.provider_thread_id, o.rfc_message_id, o.started_at, o.available_at,
            o.sent_observed_at, o.sent_verification, o.delivery_evidence, o.bounce_info, o.last_error, o.finished_at
     FROM notifications n
     LEFT JOIN notification_outbox o ON o.dedupe_key = n.dedupe_key
     WHERE n.kind = ?
     ORDER BY n.id DESC LIMIT ?`,
    [EXECUTIVE_BRIEF_KIND, Math.min(50, Math.max(1, limit))],
  );
  return rows.map((row) => ({
    ...row,
    delivery_state: deliveryStateForRow({ status: (row.outbox_status ?? "pending") as OutboxRow["status"], delivery: row.delivery }),
  }));
}
