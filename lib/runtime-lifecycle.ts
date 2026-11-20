import { stopAiQueue } from "./ai-queue";
import { stopNotificationQueue } from "./notify";
import { stopRecoveryQueue } from "./recruitment-recovery";
import { stopRecruitmentScheduler } from "./recruitment-ticker";
import { stopTempCleanupScheduler } from "./temp-scheduler";
import { runtimeInstanceId, stopRuntimeWorker, runtimeWorkerSnapshot } from "./runtime-state";

/**
 * Graceful worker shutdown.
 *
 * Next.js owns the HTTP server lifecycle, but the background workers are
 * timers and loops owned by this process. On SIGTERM/SIGINT we stop accepting
 * new timer work, mark the workers stopped in SQLite, and let the runtime exit
 * shortly afterwards. In-flight queue rows keep their normal stale-lease
 * recovery, so a hard kill still cannot strand a job permanently.
 */

type ShutdownGlobal = typeof globalThis & {
  __atwShutdown?: {
    installed: boolean;
    shuttingDown: boolean;
    reason: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
};

const g = globalThis as ShutdownGlobal;

function state() {
  g.__atwShutdown ??= {
    installed: false,
    shuttingDown: false,
    reason: null,
    startedAt: null,
    completedAt: null,
  };
  return g.__atwShutdown;
}

export function shutdownState() {
  return { ...state(), instanceId: runtimeInstanceId() };
}

export function isShuttingDown(): boolean {
  return state().shuttingDown;
}

const stops: Array<{ name: string; run: () => void }> = [
  { name: "recruitment_scheduler", run: stopRecruitmentScheduler },
  { name: "notification_outbox", run: stopNotificationQueue },
  { name: "document_recovery", run: stopRecoveryQueue },
  { name: "ai_queue", run: stopAiQueue },
  { name: "temp_cleanup", run: stopTempCleanupScheduler },
];

export function stopBackgroundWorkers(reason = "process shutdown"): void {
  const current = state();
  if (current.shuttingDown) return;
  current.shuttingDown = true;
  current.reason = reason;
  current.startedAt = new Date().toISOString();
  for (const worker of stops) {
    try {
      worker.run();
      stopRuntimeWorker(worker.name, `Stopped: ${reason}`);
    } catch {
      // One broken worker must not prevent the other timers from stopping.
    }
  }
  current.completedAt = new Date().toISOString();
}

export function installShutdownHandlers(): void {
  const current = state();
  if (current.installed || typeof process.once !== "function") return;
  current.installed = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      stopBackgroundWorkers(signal);
      // Give the current synchronous cleanup a moment, then let systemd/Docker
      // complete the stop. The configured service has a 30s stop timeout.
      const timer = setTimeout(() => process.exit(0), 100);
      timer.unref?.();
    });
  }
}

export function workerRuntimeView() {
  return runtimeWorkerSnapshot();
}
