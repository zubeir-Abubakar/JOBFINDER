import { all, getDb, nowIso, run } from "./db";
import { TASK_STALL_AFTER_MS, taskTimeoutMs } from "./task-contract";

/**
 * Stalled-task recovery.
 *
 * A persisted `running` task is not proof that a worker is alive. Recovery only
 * closes a task after the execution window for its task type has elapsed since
 * the last persisted heartbeat, and only when no unexpired recruitment-run
 * lease exists. A slow but healthy task is therefore not failed by a single
 * generic 30-minute threshold.
 */
export { TASK_STALL_AFTER_MS };

type StaleTask = {
  id: string;
  workflow_id: string | null;
  agent_key: string;
  title: string;
  task_type: string | null;
  heartbeat_at: string | null;
  started_at: string | null;
  created_at: string;
  active_lease: number;
};

type WorkflowRow = {
  id: string;
  status: string;
  created_at: string;
  last_activity: string | null;
  last_task_type: string | null;
  active_lease: number;
};

export type TaskRecoveryResult = {
  failedTasks: number;
  pausedWorkflows: number;
  preservedActiveWorkflows: number;
};

function hasValidLease(workflowId: string | null, now: Date): boolean {
  if (!workflowId) return false;
  const row = all<{ active: number }>(
    `SELECT EXISTS(
       SELECT 1
       FROM recruitment_runs r
       JOIN runtime_locks l ON l.key = 'recruitment:run:' || r.id
       WHERE r.workflow_id = ? AND l.expires_at > ?
     ) AS active`,
    [workflowId, now.toISOString()],
  )[0];
  return Number(row?.active ?? 0) === 1;
}

function lastActivityMs(task: Pick<StaleTask, "heartbeat_at" | "started_at" | "created_at">): number {
  return Date.parse(task.heartbeat_at ?? task.started_at ?? task.created_at);
}

export function recoverStalledTasks(now: Date = new Date()): TaskRecoveryResult {
  const at = now.toISOString();
  const activeWorkflows = new Set<string>();
  const touchedWorkflows = new Set<string>();
  let failedTasks = 0;

  const tasks = all<StaleTask>(
    `SELECT t.id, t.workflow_id, t.agent_key, t.title, t.task_type, t.heartbeat_at,
            t.started_at, t.created_at,
            EXISTS(
              SELECT 1
              FROM recruitment_runs r
              JOIN runtime_locks l ON l.key = 'recruitment:run:' || r.id
              WHERE r.workflow_id = t.workflow_id AND l.expires_at > ?
            ) AS active_lease
     FROM tasks t
     WHERE t.status IN ('running','working')
     ORDER BY COALESCE(t.heartbeat_at, t.started_at, t.created_at), t.created_at`,
    [at],
  );

  for (const task of tasks) {
    if (Number(task.active_lease) === 1 || hasValidLease(task.workflow_id, now)) {
      if (task.workflow_id) activeWorkflows.add(task.workflow_id);
      continue;
    }
    const timeoutMs = taskTimeoutMs(task.task_type, task.agent_key, task.title);
    const last = lastActivityMs(task);
    if (Number.isFinite(last) && last >= now.getTime() - timeoutMs) continue;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    const message = `Stalled ${task.task_type ?? "unclassified"} task: no heartbeat within its ${timeoutMinutes}-minute execution window and no active worker lease. The task was failed instead of remaining indefinitely "running"; upstream work was preserved.`;
    const changed = getDb()
      .prepare(
        `UPDATE tasks
         SET status = 'failed', error = COALESCE(error, ?), state_reason = ?,
             error_class = 'timeout', recovery_state = 'stalled', heartbeat_at = NULL, finished_at = ?
         WHERE id = ? AND status IN ('running','working')`,
      )
      .run(message, message.slice(0, 1200), at, task.id);
    if (Number(changed.changes) !== 1) continue;
    failedTasks += 1;
    if (task.workflow_id) {
      touchedWorkflows.add(task.workflow_id);
      run(
        `UPDATE recruitment_run_agents
         SET status = 'failed',
             coordinator_decision = COALESCE(coordinator_decision, ?),
             finished_at = COALESCE(finished_at, ?)
         WHERE run_id IN (SELECT id FROM recruitment_runs WHERE workflow_id = ?)
           AND agent_key = ? AND status IN ('running','queued')`,
        [message, at, task.workflow_id, task.agent_key],
      );
      run(
        "INSERT INTO workflow_events (workflow_id, agent_key, type, message, meta, created_at) VALUES (?, ?, 'agent.failed', ?, ?, ?)",
        [
          task.workflow_id,
          task.agent_key,
          `Recovered a stalled task: ${task.title}`,
          JSON.stringify({ taskId: task.id, recovery: "stalled_task", timeoutMinutes, taskType: task.task_type }),
          at,
        ],
      );
    }
    run(
      `UPDATE agents
       SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'failed' END,
           current_task = NULL
       WHERE key = ? AND current_task = ?`,
      [task.agent_key, task.title],
    );
  }

  const workflows = all<WorkflowRow>(
    `SELECT w.id, w.status, w.created_at,
            (SELECT MAX(COALESCE(t.finished_at, t.heartbeat_at, t.started_at, t.created_at))
               FROM tasks t WHERE t.workflow_id = w.id) AS last_activity,
            (SELECT t.task_type FROM tasks t WHERE t.workflow_id = w.id ORDER BY t.created_at DESC LIMIT 1) AS last_task_type,
            EXISTS(
              SELECT 1
              FROM recruitment_runs r
              JOIN runtime_locks l ON l.key = 'recruitment:run:' || r.id
              WHERE r.workflow_id = w.id AND l.expires_at > ?
            ) AS active_lease
     FROM workflows w
     WHERE w.status IN ('running','queued')`,
    [at],
  );

  let pausedWorkflows = 0;
  for (const workflow of workflows) {
    if (Number(workflow.active_lease) === 1 || hasValidLease(workflow.id, now)) {
      activeWorkflows.add(workflow.id);
      continue;
    }
    const timeoutMs = taskTimeoutMs(workflow.last_task_type, "coordinator", "");
    const last = Date.parse(workflow.last_activity ?? workflow.created_at);
    const stale = !Number.isFinite(last) || last < now.getTime() - timeoutMs;
    if (!stale && !touchedWorkflows.has(workflow.id)) continue;
    const timeoutMinutes = Math.max(1, Math.round(timeoutMs / 60_000));
    const message =
      `Workflow paused after its task lease stalled. No heartbeat arrived within the ${timeoutMinutes}-minute execution window for its last task type and no active worker lease exists. Completed work was preserved; resume or retry from the last good checkpoint.`;
    const changed = getDb()
      .prepare(
        `UPDATE workflows
         SET status = 'paused', error = COALESCE(error, ?), finished_at = ?
         WHERE id = ? AND status IN ('running','queued')`,
      )
      .run(message, at, workflow.id);
    if (Number(changed.changes) !== 1) continue;
    pausedWorkflows += 1;
    run(
      "INSERT INTO workflow_events (workflow_id, agent_key, type, message, meta, created_at) VALUES (?, 'coordinator', 'workflow.paused', ?, ?, ?)",
      [
        workflow.id,
        "Workflow paused by stale-task recovery.",
        JSON.stringify({ recovery: "stalled_task", timeoutMinutes, taskType: workflow.last_task_type }),
        at,
      ],
    );
  }

  return {
    failedTasks,
    pausedWorkflows,
    preservedActiveWorkflows: activeWorkflows.size,
  };
}

/** Fallback cutoff retained for older callers; typed checks are per task. */
export function stalledTaskCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - TASK_STALL_AFTER_MS).toISOString();
}

export function staleTaskCount(now: Date = new Date()): number {
  const rows = all<Pick<StaleTask, "task_type" | "agent_key" | "title" | "heartbeat_at" | "started_at" | "created_at">>(
    "SELECT task_type, agent_key, title, heartbeat_at, started_at, created_at FROM tasks WHERE status IN ('running','working')",
  );
  return rows.filter((task) => {
    const last = lastActivityMs(task);
    return !Number.isFinite(last) || last < now.getTime() - taskTimeoutMs(task.task_type, task.agent_key, task.title);
  }).length;
}

/** Kept next to recovery so callers share one consistent timestamp source. */
export function recoveryTimestamp(): string {
  return nowIso();
}
