/**
 * Next.js instrumentation: starts the local temporary-cache scheduler once per
 * server process. Node runtime only; Edge has no filesystem.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installShutdownHandlers } = await import("./lib/runtime-lifecycle");
  installShutdownHandlers();
  const { recoverInterruptedRecruitmentRuns } = await import("./lib/recruitment-run");
  recoverInterruptedRecruitmentRuns();
  const { startTempCleanupScheduler } = await import("./lib/temp-scheduler");
  startTempCleanupScheduler();
  const { startAiQueue } = await import("./lib/ai-queue");
  startAiQueue();
  // Durable email outbox and document recovery survive process restarts.
  const { startNotificationQueue } = await import("./lib/notify");
  startNotificationQueue();
  const { startRecoveryQueue } = await import("./lib/recruitment-recovery");
  startRecoveryQueue();
  // Persistent daily recruitment schedule. The row lives in SQLite; this timer
  // only asks the database whether a run is due.
  const { startRecruitmentScheduler } = await import("./lib/recruitment-ticker");
  startRecruitmentScheduler();
}
