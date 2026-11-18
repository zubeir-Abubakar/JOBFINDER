/**
 * Next.js instrumentation: starts the local temporary-cache scheduler once per
 * server process. Node runtime only; Edge has no filesystem.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startTempCleanupScheduler } = await import("./lib/temp-scheduler");
  startTempCleanupScheduler();
  const { startAiQueue } = await import("./lib/ai-queue");
  startAiQueue();
  // Persistent daily recruitment schedule. The row lives in SQLite; this timer
  // only asks the database whether a run is due.
  const { startRecruitmentScheduler } = await import("./lib/recruitment-ticker");
  startRecruitmentScheduler();
}
