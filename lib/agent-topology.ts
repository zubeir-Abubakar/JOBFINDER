import { all, one } from "./db";
import {
  AGENT_IDENTITY_KEYS,
  agentIdentity,
  isIdentityAgentKey,
  type IdentityAgentKey,
} from "./agent-identity";
import { effectiveVoiceProfileForAgent } from "./agent-voice-settings";
import { workflowAccessibleTo, type WorkflowActor } from "./workflow-view";
import { runStageSummary, type StageCheckpoint } from "./recruitment-stages";

/**
 * Read-only projection of the existing execution records for the live topology.
 *
 * There is no second activity system here: agents come from `agents`, current
 * work from `tasks`, run totals from `recruitment_runs`/`recruitment_run_agents`
 * and the timeline from persisted `workflow_events`. Nothing is estimated.
 */

export type TopologyState =
  | "working"
  | "processing"
  | "waiting"
  | "recovering"
  | "completed"
  | "failed"
  | "idle"
  | "offline";

export type TopologyTask = {
  id: string;
  title: string;
  status: string;
  detail: string | null;
  output: string | null;
  error: string | null;
  taskType: string | null;
  stateReason: string | null;
  heartbeatAt: string | null;
  dependsOn: string[];
  retryCount: number;
  errorClass: string | null;
  recoveryState: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type TopologyEvent = {
  id: number;
  workflowId: string;
  agentKey: string | null;
  agentName: string | null;
  type: string;
  message: string;
  createdAt: string;
  tone: "info" | "good" | "bad" | "neutral";
};

export type TopologyAgent = {
  key: IdentityAgentKey;
  name: string;
  role: string;
  title: string;
  description: string;
  portrait: string;
  initials: string;
  enabled: boolean;
  state: TopologyState;
  stateLabel: string;
  active: boolean;
  /** True only when a persisted task or run assignment exists for this run. */
  assigned: boolean;
  activity: string;
  task: TopologyTask | null;
  startedAt: string | null;
  finishedAt: string | null;
  voiceName: string;
  runCount: number;
  failureCount: number;
  recentTasks: TopologyTask[];
  recentEvents: TopologyEvent[];
};

export type TopologyConnection = {
  agentKey: IdentityAgentKey;
  active: boolean;
  direction: "chief-to-agent" | "agent-to-chief" | null;
  label: string | null;
  phase: "assignment" | "result" | "waiting" | "recovering" | "failed" | null;
  taskId: string | null;
  eventId: number | null;
  updatedAt: string | null;
};

export type TopologyRun = {
  id: string;
  runKey: string;
  workflowId: string | null;
  type: "Full discovery" | "Incremental discovery" | "Discovery only";
  scope: "full" | "incremental";
  trigger: string;
  status: string;
  active: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  jobsDiscovered: number;
  jobsUpdated: number;
  counts: {
    assigned: number;
    total: number;
    completed: number;
    running: number;
    waiting: number;
    recovering: number;
    failed: number;
    skipped: number;
  };
};

export type TopologyRecovery = {
  lastCompleted: string | null;
  currentStage: string | null;
  failedStage: string | null;
  nextAction: string | null;
  retryCount: number;
  checkpoints: Array<{
    stage: string;
    jobId: string;
    status: string;
    attempt: number;
    decision: string | null;
    reason: string | null;
    nextStage: string | null;
    outputRefs: string | null;
    updatedAt: string;
  }>;
};

export type AgentTopologySnapshot = {
  generatedAt: string;
  workflow: { id: string; label: string; status: string; kind: string } | null;
  coordinator: TopologyAgent;
  specialists: TopologyAgent[];
  agents: TopologyAgent[];
  connections: TopologyConnection[];
  run: TopologyRun | null;
  recovery: TopologyRecovery | null;
  events: TopologyEvent[];
  stats: {
    total: number;
    working: number;
    processing: number;
    waiting: number;
    completed: number;
    failed: number;
    recovering: number;
    idle: number;
    offline: number;
  };
};

type AgentRow = {
  key: string;
  name: string;
  role: string;
  description: string;
  enabled: number;
  status: string;
  run_count: number;
  failure_count: number;
};

type TaskRow = {
  id: string;
  agent_key: string;
  title: string;
  status: string;
  detail: string | null;
  output: string | null;
  error: string | null;
  task_type: string | null;
  state_reason: string | null;
  heartbeat_at: string | null;
  depends_on: string | null;
  retry_count: number;
  error_class: string | null;
  recovery_state: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type AssignmentRow = {
  id: number;
  agent_key: string;
  assignment: string;
  status: string;
  output: string | null;
  error: string | null;
  coordinator_decision: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type WorkflowRow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  started_by: string | null;
};

type RunCandidate = {
  id: string;
  run_key: string;
  workflow_id: string | null;
  trigger: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  jobs_discovered: number;
  jobs_updated: number;
  discovery_scope: string | null;
  mode: string | null;
  error: string | null;
  workflow_started_by: string | null;
  workflow_exists: number;
};

type EventRow = {
  id: number;
  workflow_id: string;
  agent_key: string | null;
  type: string;
  message: string | null;
  created_at: string;
};

const ACTIVE_TASK_STATUSES = new Set(["running", "working", "thinking"]);
const WAITING_TASK_STATUSES = new Set([
  "queued",
  "planned",
  "waiting",
  "waiting_provider",
  "retry_scheduled",
  "waiting_intervention",
  "blocked",
]);
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "completed_with_warnings",
  "failed",
  "interrupted",
]);

const STATE_LABELS: Record<TopologyState, string> = {
  working: "Working",
  processing: "Processing",
  waiting: "Waiting",
  recovering: "Recovering",
  completed: "Completed",
  failed: "Failed",
  idle: "Idle",
  offline: "Offline",
};

export function initialsForName(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  return `${parts[0][0] ?? ""}${parts.length > 1 ? parts.at(-1)?.[0] ?? "" : ""}`.toUpperCase();
}

/**
 * The state shown by the topology is derived from the persisted task and agent
 * rows. Completed and failed are terminal display states, not a claim that the
 * agent is still executing. Disabled or paused always wins over stale history.
 */
export function deriveTopologyState(input: {
  enabled: boolean;
  agentStatus: string;
  taskStatus?: string | null;
  recoveryState?: string | null;
}): TopologyState {
  if (!input.enabled || ["disabled", "paused", "unavailable"].includes(input.agentStatus)) return "offline";
  const taskStatus = input.taskStatus ?? null;
  if (taskStatus) {
    if (ACTIVE_TASK_STATUSES.has(taskStatus)) {
      return input.agentStatus === "thinking" || taskStatus === "thinking" ? "processing" : "working";
    }
    if (WAITING_TASK_STATUSES.has(taskStatus)) {
      return /retry|resum|recover/i.test(input.recoveryState ?? "") || taskStatus === "retry_scheduled"
        ? "recovering"
        : "waiting";
    }
    if (taskStatus === "failed") return "failed";
    if (taskStatus === "completed") return "completed";
  }
  if (input.agentStatus === "working") return "working";
  if (input.agentStatus === "thinking") return "processing";
  if (input.agentStatus === "waiting") return "waiting";
  if (input.agentStatus === "failed") return "failed";
  if (input.agentStatus === "completed") return "completed";
  return "idle";
}

function clip(value: string | null | undefined, max = 180): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function taskFromRow(row: TaskRow): TopologyTask {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    detail: row.detail,
    output: row.output,
    error: row.error,
    taskType: row.task_type,
    stateReason: row.state_reason,
    heartbeatAt: row.heartbeat_at,
    dependsOn: parseDependencyIds(row.depends_on),
    retryCount: Number(row.retry_count ?? 0),
    errorClass: row.error_class,
    recoveryState: row.recovery_state,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function parseDependencyIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function taskFromAssignment(row: AssignmentRow): TopologyTask {
  return {
    id: `assignment-${row.id}`,
    title: row.assignment,
    status: row.status,
    detail: row.coordinator_decision,
    output: row.output,
    error: row.error,
    taskType: null,
    stateReason: row.coordinator_decision,
    heartbeatAt: null,
    dependsOn: [],
    retryCount: 0,
    errorClass: null,
    recoveryState: null,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function activityFor(agent: AgentRow, task: TopologyTask | null, state: TopologyState): string {
  if (state === "offline") return agent.enabled === 1 ? "Paused — no new work will start." : "Disabled in agent management.";
  if (!task) return "Not assigned to this run.";
  if (state === "waiting" || state === "recovering") {
    return clip(task.stateReason ?? task.detail ?? task.title, 220);
  }
  if (state === "working" || state === "processing") {
    return clip(task.detail ?? task.title);
  }
  if (state === "failed") return clip(task.error ?? task.title);
  if (state === "completed") return clip(task.output ?? task.title);
  return "No active task.";
}

function toneForEvent(type: string): TopologyEvent["tone"] {
  if (type.endsWith("failed") || type === "workflow.cancelled") return "bad";
  if (type.endsWith("completed") || type === "approval.granted") return "good";
  if (type.endsWith("started") || type.endsWith("progress") || type === "approval.required") return "info";
  return "neutral";
}

function accessibleWorkflow(user: WorkflowActor, row: Pick<WorkflowRow, "started_by">): boolean {
  return workflowAccessibleTo(user, row);
}

function accessibleRun(user: WorkflowActor, run: RunCandidate): boolean {
  if (!run.workflow_id) return workflowAccessibleTo(user, { started_by: null });
  if (!run.workflow_exists) return false;
  return workflowAccessibleTo(user, { started_by: run.workflow_started_by });
}

export function getAgentTopologySnapshot(user: WorkflowActor, now: Date = new Date()): AgentTopologySnapshot {
  const workflowRows = all<WorkflowRow>(
    "SELECT id, kind, label, status, started_by FROM workflows ORDER BY created_at DESC LIMIT 100",
  ).filter((row) => accessibleWorkflow(user, row));

  const runCandidates = all<RunCandidate>(
    `SELECT r.id, r.run_key, r.workflow_id, r.trigger, r.status, r.started_at, r.finished_at,
            r.jobs_discovered, r.jobs_updated, r.discovery_scope, r.mode, r.error,
            w.started_by AS workflow_started_by, CASE WHEN w.id IS NULL THEN 0 ELSE 1 END AS workflow_exists
     FROM recruitment_runs r
     LEFT JOIN workflows w ON w.id = r.workflow_id
     ORDER BY r.created_at DESC LIMIT 50`,
  ).filter((row) => accessibleRun(user, row));
  const runRow = runCandidates.find((row) => !TERMINAL_RUN_STATUSES.has(row.status)) ?? runCandidates[0] ?? null;

  let workflowId: string | null = runRow?.workflow_id ?? workflowRows[0]?.id ?? null;
  let workflow: WorkflowRow | null = workflowId ? workflowRows.find((row) => row.id === workflowId) ?? null : null;
  if (!workflow && workflowId) {
    const direct = one<WorkflowRow>(
      "SELECT id, kind, label, status, started_by FROM workflows WHERE id = ?",
      [workflowId],
    );
    workflow = direct && accessibleWorkflow(user, direct) ? direct : null;
  }
  if (workflow && !workflowId) workflowId = workflow.id;
  if (!workflow) {
    workflowId = null;
    workflow = null;
  }

  const taskRows = workflowId
    ? all<TaskRow>(
        `SELECT id, agent_key, title, status, detail, output, error, task_type, state_reason,
                heartbeat_at, depends_on, retry_count, error_class, recovery_state,
                created_at, started_at, finished_at
         FROM tasks WHERE workflow_id = ? ORDER BY created_at DESC`,
        [workflowId],
      )
    : [];
  const assignmentRows = runRow
    ? all<AssignmentRow>(
        `SELECT id, agent_key, assignment, status, output, error, coordinator_decision, started_at, finished_at, created_at
         FROM recruitment_run_agents WHERE run_id = ? ORDER BY id DESC`,
        [runRow.id],
      )
    : [];
  const runTaskRows = runRow
    ? all<TaskRow>(
        `SELECT id, agent_key, title, status, detail, output, error, task_type, state_reason,
                heartbeat_at, depends_on, retry_count, error_class, recovery_state,
                created_at, started_at, finished_at
         FROM tasks WHERE run_id = ? ORDER BY created_at DESC`,
        [runRow.id],
      )
    : [];
  const eventRows = workflowId
    ? all<EventRow>(
        `SELECT id, workflow_id, agent_key, type, message, created_at
         FROM workflow_events WHERE workflow_id = ? ORDER BY id DESC LIMIT 80`,
        [workflowId],
      ).reverse()
    : [];

  const events: TopologyEvent[] = eventRows.map((row) => {
    const identity = row.agent_key && isIdentityAgentKey(row.agent_key) ? agentIdentity(row.agent_key) : null;
    return {
      id: row.id,
      workflowId: row.workflow_id,
      agentKey: row.agent_key,
      agentName: identity?.name ?? null,
      type: row.type,
      message: row.message ?? row.type,
      createdAt: row.created_at,
      tone: toneForEvent(row.type),
    };
  });

  const latestAssignment = new Map<string, AssignmentRow>();
  for (const row of assignmentRows) {
    if (!latestAssignment.has(row.agent_key)) latestAssignment.set(row.agent_key, row);
  }

  const agentRows = all<AgentRow>(
    `SELECT key, name, role, description, enabled, status, run_count, failure_count
     FROM agents ORDER BY sort`,
  ).filter((row) => isIdentityAgentKey(row.key));

  const agents: TopologyAgent[] = agentRows.map((row) => {
    const identity = agentIdentity(row.key);
    const agentTasks = taskRows.filter((task) => task.agent_key === row.key);
    const liveTask = agentTasks.find(
      (task) => ACTIVE_TASK_STATUSES.has(task.status) || WAITING_TASK_STATUSES.has(task.status),
    );
    const assignment = latestAssignment.get(row.key);
    const task = liveTask
      ? taskFromRow(liveTask)
      : agentTasks[0]
        ? taskFromRow(agentTasks[0])
        : assignment
          ? taskFromAssignment(assignment)
          : null;
    const state = deriveTopologyState({
      enabled: row.enabled === 1,
      agentStatus: row.status,
      taskStatus: task?.status,
      recoveryState: task?.recoveryState ?? null,
    });
    const active = state === "working" || state === "processing" || state === "waiting" || state === "recovering";
    const recentEvents = events.filter((event) => event.agentKey === row.key).slice(-5).reverse();
    return {
      key: row.key as IdentityAgentKey,
      name: identity.name,
      role: identity.role,
      title: identity.title,
      description: identity.responsibilities,
      portrait: identity.image,
      initials: initialsForName(identity.name),
      enabled: row.enabled === 1,
      state,
      stateLabel: !task && state === "idle" ? "Not assigned" : STATE_LABELS[state],
      active,
      assigned: Boolean(task),
      activity: activityFor(row, task, state),
      task,
      startedAt: task?.startedAt ?? null,
      finishedAt: task?.finishedAt ?? null,
      voiceName: effectiveVoiceProfileForAgent(row.key).voiceName,
      runCount: Number(row.run_count),
      failureCount: Number(row.failure_count),
      recentTasks: agentTasks.slice(0, 5).map(taskFromRow),
      recentEvents,
    };
  });

  const workflowActive = workflow?.status === "running" || workflow?.status === "queued";
  let coordinator = agents.find((agent) => agent.key === "coordinator");
  if (!coordinator) {
    const identity = agentIdentity("coordinator");
    coordinator = {
      key: "coordinator",
      name: identity.name,
      role: identity.role,
      title: identity.title,
      description: identity.responsibilities,
      portrait: identity.image,
      initials: initialsForName(identity.name),
      enabled: false,
      state: "offline",
      stateLabel: STATE_LABELS.offline,
      active: false,
      assigned: false,
      activity: "Coordinator record is unavailable.",
      task: null,
      startedAt: null,
      finishedAt: null,
      voiceName: effectiveVoiceProfileForAgent("coordinator").voiceName,
      runCount: 0,
      failureCount: 0,
      recentTasks: [],
      recentEvents: [],
    };
  } else if (workflowActive) {
    coordinator = {
      ...coordinator,
      state: "working",
      stateLabel: "Orchestrating",
      active: true,
      activity: clip(
        runRow
          ? `${runRow.discovery_scope === "incremental" ? "Incremental" : "Full"} discovery · ${runRow.status.replace(/_/g, " ")}`
          : `Workflow ${workflow?.status ?? "running"}`,
      ),
    };
  }

  const displayAgents: TopologyAgent[] = agents.map((agent) =>
    agent.key === "coordinator" ? coordinator : agent,
  );
  const specialists = displayAgents.filter((agent) => agent.key !== "coordinator");
  const connections: TopologyConnection[] = specialists.map((agent) => {
    const latest = agent.recentEvents[0] ?? null;
    const eventAge = latest ? now.getTime() - Date.parse(latest.createdAt) : Number.NaN;
    const recentTerminal =
      Boolean(latest) &&
      (latest?.type === "agent.completed" || latest?.type === "agent.failed") &&
      Number.isFinite(eventAge) &&
      eventAge >= 0 &&
      eventAge < 20_000;
    const runningNow =
      Boolean(agent.task) &&
      (agent.state === "working" || agent.state === "processing") &&
      Boolean(agent.task && ACTIVE_TASK_STATUSES.has(agent.task.status));
    const phase: TopologyConnection["phase"] =
      agent.state === "recovering"
        ? "recovering"
        : runningNow
          ? "assignment"
          : agent.state === "waiting"
            ? "waiting"
            : agent.state === "failed"
              ? "failed"
              : latest?.type === "agent.completed"
                ? "result"
                : null;
    return {
      agentKey: agent.key,
      active: phase === "assignment" || phase === "recovering" || (phase === "result" && recentTerminal),
      direction:
        phase === "result"
          ? "agent-to-chief"
          : phase === "assignment" || phase === "waiting" || phase === "recovering"
            ? "chief-to-agent"
            : null,
      phase,
      taskId: agent.task?.id ?? null,
      eventId: latest?.id ?? null,
      updatedAt: latest?.createdAt ?? agent.task?.finishedAt ?? agent.task?.startedAt ?? null,
      label:
        phase === "assignment" && agent.task
          ? `${coordinator.name} assigned ${agent.name}: ${agent.task.title}`
          : phase === "result"
            ? `${agent.name} returned: ${agent.task?.title ?? latest?.message ?? "task result"}`
            : phase === "waiting" && agent.task
              ? `${agent.name} waiting: ${(agent.task.stateReason ?? agent.task.dependsOn.join(", ")) || agent.task.title}`
              : phase === "failed"
                ? `${agent.name} failed: ${agent.task?.error ?? latest?.message ?? "see task error"}`
                : phase === "recovering"
                  ? `${agent.name} recovering: ${agent.task?.stateReason ?? "retry scheduled"}`
                  : latest?.message ?? null,
    };
  });

  const countedTasks = runTaskRows.length > 0 ? runTaskRows : taskRows;
  const taskCounts = {
    assigned: countedTasks.length,
    total: countedTasks.length,
    completed: countedTasks.filter((row) => row.status === "completed").length,
    running: countedTasks.filter((row) => ACTIVE_TASK_STATUSES.has(row.status)).length,
    waiting: countedTasks.filter(
      (row) => WAITING_TASK_STATUSES.has(row.status) && !/retry|resum|recover/i.test(row.recovery_state ?? "") && row.status !== "retry_scheduled",
    ).length,
    recovering: countedTasks.filter(
      (row) => /retry|resum|recover/i.test(row.recovery_state ?? "") || row.status === "retry_scheduled",
    ).length,
    failed: countedTasks.filter((row) => row.status === "failed").length,
    skipped: assignmentRows.filter((row) => row.status === "skipped").length,
  };
  const counts = taskCounts;

  const run: TopologyRun | null = runRow
    ? {
        id: runRow.id,
        runKey: runRow.run_key,
        workflowId: runRow.workflow_id,
        type:
          runRow.mode === "discovery"
            ? "Discovery only"
            : runRow.discovery_scope === "incremental"
              ? "Incremental discovery"
              : "Full discovery",
        scope: runRow.discovery_scope === "incremental" ? "incremental" : "full",
        trigger: runRow.trigger,
        status: runRow.status,
        active: !TERMINAL_RUN_STATUSES.has(runRow.status),
        startedAt: runRow.started_at,
        finishedAt: runRow.finished_at,
        error: runRow.error,
        jobsDiscovered: Number(runRow.jobs_discovered),
        jobsUpdated: Number(runRow.jobs_updated),
        counts,
      }
    : null;

  const recovery: TopologyRecovery | null = runRow
    ? (() => {
        const summary = runStageSummary(runRow.id);
        return {
          lastCompleted: summary.lastCompleted,
          currentStage: summary.currentStage,
          failedStage: summary.failedStage,
          nextAction: summary.nextAction,
          retryCount: summary.retryCount,
          checkpoints: summary.checkpoints.map((row: StageCheckpoint) => ({
            stage: row.stage,
            jobId: row.job_id,
            status: row.status,
            attempt: row.attempt,
            decision: row.decision,
            reason: row.reason,
            nextStage: row.next_stage,
            outputRefs: row.output_refs,
            updatedAt: row.updated_at,
          })),
        };
      })()
    : null;

  const stats = {
    total: displayAgents.length,
    working: displayAgents.filter((agent) => agent.state === "working").length,
    processing: displayAgents.filter((agent) => agent.state === "processing").length,
    waiting: displayAgents.filter((agent) => agent.state === "waiting").length,
    completed: displayAgents.filter((agent) => agent.state === "completed").length,
    failed: displayAgents.filter((agent) => agent.state === "failed").length,
    recovering: displayAgents.filter((agent) => agent.state === "recovering").length,
    idle: displayAgents.filter((agent) => agent.state === "idle").length,
    offline: displayAgents.filter((agent) => agent.state === "offline").length,
  };

  return {
    generatedAt: now.toISOString(),
    workflow: workflow
      ? { id: workflow.id, label: workflow.label, status: workflow.status, kind: workflow.kind }
      : null,
    coordinator,
    specialists,
    agents: displayAgents,
    connections,
    run,
    recovery,
    events,
    stats,
  };
}

/** Used by tests and route guards without exposing the rest of the projection. */
export const TOPOLOGY_AGENT_KEYS = AGENT_IDENTITY_KEYS;
