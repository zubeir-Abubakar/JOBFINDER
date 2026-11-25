import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, UPLOAD_DIR, all, one, schemaVersion } from "./db";
import { scheduleSnapshot, formatInZone } from "./recruitment-schedule";
import { recruitmentSchedulerStatus } from "./recruitment-ticker";
import {
  runtimeInstanceId,
  runtimeLockSnapshot,
  runtimeWorkerSnapshot,
  WORKER_STALE_AFTER_MS,
  type RuntimeWorkerView,
} from "./runtime-state";
import { executiveBriefScheduleSnapshot } from "./executive-brief";
import { notificationQueueSnapshot } from "./notify";
import { recoverySnapshot } from "./recruitment-recovery";
import { aiQueueSnapshot } from "./ai-queue";
import { nextProviderRetryAt, providerHealthSnapshot } from "./provider-health";

/**
 * Operational health is read from persisted state, not inferred from a running
 * browser. A worker whose heartbeat is old is reported as stale, not healthy.
 * Provider connectivity and successful inference are separate facts.
 */

export type RuntimeHealth = {
  checkedAt: string;
  status: "operational" | "degraded" | "down";
  detail: string;
  database: {
    ok: boolean;
    integrity: string;
    schemaVersion: number;
    fileMode: string | null;
    uploadMode: string | null;
    permissionWarning: string | null;
  };
  scheduler: ReturnType<typeof scheduleSnapshot> & {
    tickerRunning: boolean;
    lastTickAt: string | null;
    worker: RuntimeWorkerView | null;
    lock: ReturnType<typeof runtimeLockSnapshot>[number] | null;
  };
  executiveBrief: ReturnType<typeof executiveBriefScheduleSnapshot> & {
    heartbeatAgeSeconds: number | null;
    stale: boolean;
  };
  workers: RuntimeWorkerView[];
  locks: ReturnType<typeof runtimeLockSnapshot>;
  instanceId: string;
  queues: {
    notifications: ReturnType<typeof notificationQueueSnapshot>;
    recovery: ReturnType<typeof recoverySnapshot>;
    ai: ReturnType<typeof aiQueueSnapshot>;
    tasks: Record<string, number>;
    runningTasks: Array<{ id: string; agent_key: string; title: string; status: string; started_at: string | null }>;
  };
  recruitment: {
    lastSuccessfulRun: {
      id: string;
      status: string;
      trigger: string;
      startedAt: string | null;
      finishedAt: string | null;
    } | null;
    recentRuns: Array<{ id: string; status: string; trigger: string; finishedAt: string | null; error: string | null }>;
    nextRunAt: string | null;
    nextRunLabel: string;
    submissionFailures: number;
    submissionUnknown: number;
    notificationFailures: number;
  };
  providers: {
    routes: ReturnType<typeof providerHealthSnapshot>;
    nextRetryAt: string | null;
    lastSuccessfulInferenceAt: string | null;
    lastSuccessfulProvider: string | null;
    lastSuccessfulModel: string | null;
    detail: string;
  };
  agents: {
    registered: number;
    activeTasks: number;
    failedTasksToday: number;
  };
};

function modeOf(file: string): string | null {
  try {
    return `0${(fs.statSync(file).mode & 0o777).toString(8)}`;
  } catch {
    return null;
  }
}

function taskCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")) {
    out[row.status] = Number(row.n);
  }
  return out;
}

export function operationalHealthSnapshot(now: Date = new Date()): RuntimeHealth {
  const checkedAt = now.toISOString();
  const dbFile = path.join(DATA_DIR, "at-ai-workforce.db");
  let integrity = "unavailable";
  let ok = false;
  try {
    const row = one<{ quick_check: string }>("PRAGMA quick_check");
    integrity = String(row?.quick_check ?? "unavailable");
    ok = integrity === "ok";
  } catch {
    ok = false;
  }

  const scheduler = scheduleSnapshot(now);
  const executiveBriefSnapshot = executiveBriefScheduleSnapshot(now);
  const briefCheckedAt = Date.parse(executiveBriefSnapshot.last_checked_at ?? "");
  const executiveBriefAgeSeconds = Number.isFinite(briefCheckedAt)
    ? Math.max(0, Math.round((now.getTime() - briefCheckedAt) / 1000))
    : null;
  const executiveBrief = {
    ...executiveBriefSnapshot,
    heartbeatAgeSeconds: executiveBriefAgeSeconds,
    stale: executiveBriefAgeSeconds === null || executiveBriefAgeSeconds * 1000 > WORKER_STALE_AFTER_MS,
  };
  const workers = runtimeWorkerSnapshot(now);
  const locks = runtimeLockSnapshot(now);
  const schedulerWorker = workers.find((worker) => worker.name === "recruitment_scheduler") ?? null;
  const schedulerLock = locks.find((lock) => lock.key === "recruitment:scheduler") ?? null;
  const ticker = recruitmentSchedulerStatus();
  const notifications = notificationQueueSnapshot();
  const recovery = recoverySnapshot();
  const ai = aiQueueSnapshot();
  const tasks = taskCounts();
  const runningTasks = all<{ id: string; agent_key: string; title: string; status: string; started_at: string | null }>(
    "SELECT id, agent_key, title, status, started_at FROM tasks WHERE status IN ('running','working') ORDER BY started_at LIMIT 20",
  );
  const failedToday = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed' AND created_at >= ?",
    [new Date(now.getTime() - 24 * 3600_000).toISOString()],
  )?.c ?? 0;
  const activeTasks = Number(tasks.running ?? 0) + Number(tasks.working ?? 0);
  const registered = one<{ c: number }>("SELECT COUNT(*) AS c FROM agents")?.c ?? 0;

  const lastSuccessfulRun = one<{
    id: string; status: string; trigger: string; started_at: string | null; finished_at: string | null;
  }>(
    "SELECT id, status, trigger, started_at, finished_at FROM recruitment_runs WHERE status IN ('completed','completed_with_warnings') ORDER BY finished_at DESC LIMIT 1",
  );
  const recentRuns = all<{ id: string; status: string; trigger: string; finished_at: string | null; error: string | null }>(
    "SELECT id, status, trigger, finished_at, error FROM recruitment_runs ORDER BY created_at DESC LIMIT 5",
  );
  const submissionFailures = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM applications WHERE status = 'submission_failed' OR submission_status = 'failed'",
  )?.c ?? 0;
  const submissionUnknown = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM applications WHERE status = 'submission_unverified' OR submission_status = 'unverified'",
  )?.c ?? 0;
  const notificationFailures = Number(notifications.counts.failed ?? 0);
  const lastInference = one<{ provider: string; model: string; created_at: string }>(
    "SELECT provider, model, created_at FROM provider_usage WHERE status = 'ok' ORDER BY created_at DESC LIMIT 1",
  );
  const providerRoutes = providerHealthSnapshot();
  const dbFileMode = modeOf(dbFile);
  const uploadMode = modeOf(UPLOAD_DIR);
  const permissionWarning =
    dbFileMode && (Number.parseInt(dbFileMode, 8) & 0o077) !== 0
      ? `Database mode ${dbFileMode} is readable outside the service user. Expected 0600.`
      : uploadMode && (Number.parseInt(uploadMode, 8) & 0o077) !== 0
        ? `Uploads directory mode ${uploadMode} is accessible outside the service user. Expected 0700.`
        : null;

  // A queue worker is required only when its durable queue has work waiting.
  // An idle queue is allowed to be dormant: its enqueue path starts it again.
  // This keeps an empty advisory queue or an empty outbox from presenting the
  // whole deterministic application as degraded.
  const queueWork: Record<string, number> = {
    ai_queue:
      Number(ai.counts.queued ?? 0) +
      Number(ai.counts.processing ?? 0) +
      Number(ai.counts.rate_limited ?? 0),
    document_recovery:
      Number(recovery.counts.pending ?? 0) +
      Number(recovery.counts.processing ?? 0) +
      Number(recovery.counts.retry_scheduled ?? 0),
    notification_outbox:
      Number(notifications.counts.pending ?? 0) +
      Number(notifications.counts.sending ?? 0) +
      Number(notifications.counts.retry_scheduled ?? 0),
  };
  const queueWorkerProblem = Object.entries(queueWork).some(([name, pending]) => {
    if (pending <= 0) return false;
    const worker = workers.find((candidate) => candidate.name === name);
    return !worker || worker.effectiveStatus !== "running";
  });
  const dormantWorkers = workers.filter(
    (worker) =>
      worker.name !== "temp_cleanup" &&
      worker.name !== "recruitment_scheduler" &&
      worker.effectiveStatus !== "running" &&
      Number(queueWork[worker.name] ?? 0) === 0,
  );
  const executiveBriefProblem =
    executiveBrief.enabled === 1 &&
    executiveBrief.due &&
    schedulerWorker?.effectiveStatus !== "running";
  const workerProblem =
    (scheduler.enabled && schedulerWorker?.effectiveStatus !== "running") ||
    executiveBriefProblem ||
    queueWorkerProblem;
  const status: RuntimeHealth["status"] = !ok
    ? "down"
    : workerProblem || permissionWarning
      ? "degraded"
      : "operational";
  const detail = !ok
    ? `SQLite health check returned ${integrity}.`
    : workerProblem
      ? "A required background worker is stopped or stale; inspect the worker list."
      : permissionWarning
        ? permissionWarning
        : dormantWorkers.length > 0
          ? `Scheduler and required workers are running. Idle queue workers are dormant with no pending work: ${dormantWorkers.map((worker) => `${worker.name} (${worker.effectiveStatus})`).join(", ")}. Idle queues do not degrade deterministic operations.`
          : "Database, scheduler and background workers are healthy.";

  return {
    checkedAt,
    status,
    detail,
    database: {
      ok,
      integrity,
      schemaVersion: schemaVersion(),
      fileMode: dbFileMode,
      uploadMode,
      permissionWarning,
    },
    scheduler: {
      ...scheduler,
      tickerRunning: ticker.running,
      lastTickAt: ticker.lastTickAt,
      worker: schedulerWorker,
      lock: schedulerLock,
    },
    executiveBrief,
    workers,
    locks,
    instanceId: runtimeInstanceId(),
    queues: {
      notifications,
      recovery,
      ai,
      tasks,
      runningTasks,
    },
    recruitment: {
      lastSuccessfulRun: lastSuccessfulRun
        ? {
            id: lastSuccessfulRun.id,
            status: lastSuccessfulRun.status,
            trigger: lastSuccessfulRun.trigger,
            startedAt: lastSuccessfulRun.started_at,
            finishedAt: lastSuccessfulRun.finished_at,
          }
        : null,
      recentRuns: recentRuns.map((row) => ({
        id: row.id,
        status: row.status,
        trigger: row.trigger,
        finishedAt: row.finished_at,
        error: row.error,
      })),
      nextRunAt: scheduler.nextRunAt,
      nextRunLabel: formatInZone(scheduler.nextRunAt, scheduler.timezone),
      submissionFailures,
      submissionUnknown,
      notificationFailures,
    },
    providers: {
      routes: providerRoutes,
      nextRetryAt: nextProviderRetryAt(),
      lastSuccessfulInferenceAt: lastInference?.created_at ?? null,
      lastSuccessfulProvider: lastInference?.provider ?? null,
      lastSuccessfulModel: lastInference?.model ?? null,
      detail: lastInference
        ? `Last successful inference: ${lastInference.provider}/${lastInference.model} at ${lastInference.created_at}. This is inference evidence, not a live connectivity check.`
        : "No successful inference is recorded. Connectivity and inference success are separate facts.",
    },
    agents: {
      registered: Number(registered),
      activeTasks,
      failedTasksToday: Number(failedToday),
    },
  };
}
