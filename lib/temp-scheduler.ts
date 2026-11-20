import { cleanupTempObjects, pruneTempRegistry } from "./temp-store";
import { heartbeatRuntimeWorker, startRuntimeWorker, stopRuntimeWorker } from "./runtime-state";

type SchedulerGlobal = typeof globalThis & { __atwTempTimer?: ReturnType<typeof setInterval> };

/**
 * Local scheduled cleanup. Runs once at server start and then on a configurable
 * interval. In a future cloud deployment the same cleanupTempObjects() function
 * can be invoked by the workflow scheduler instead.
 */
export function startTempCleanupScheduler(): void {
  const g = globalThis as SchedulerGlobal;
  if (g.__atwTempTimer) return;
  startRuntimeWorker("temp_cleanup", "Temporary-object cleanup interval");
  const hours = Number(process.env.TEMP_CLEANUP_INTERVAL_HOURS ?? 6);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? Math.min(48, hours) : 6) * 3600_000;
  const tick = () => {
    heartbeatRuntimeWorker("temp_cleanup");
    void cleanupTempObjects("scheduler")
      .then(() => pruneTempRegistry())
      .catch(() => {
        // Cleanup must never take the application down. The next tick retries.
      });
  };
  tick();
  g.__atwTempTimer = setInterval(tick, intervalMs);
  g.__atwTempTimer.unref?.();
}

export function stopTempCleanupScheduler(): void {
  const g = globalThis as SchedulerGlobal;
  if (g.__atwTempTimer) clearInterval(g.__atwTempTimer);
  g.__atwTempTimer = undefined;
  stopRuntimeWorker("temp_cleanup", "Stopped with the application process");
}
