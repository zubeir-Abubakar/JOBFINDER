/**
 * Next.js instrumentation: starts the local background workers exactly once per
 * server process. Node runtime only; Edge has no filesystem.
 *
 * In production this is called once for the `next start` process. The guard is
 * still important for development hot reloads and for any future server adapter
 * that invokes instrumentation more than once.
 */

type InstrumentationGlobal = typeof globalThis & {
  __atwInstrumentation?: {
    promise: Promise<void> | null;
    started: boolean;
    startedAt: string | null;
  };
};

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as InstrumentationGlobal;
  if (g.__atwInstrumentation?.promise) return g.__atwInstrumentation.promise;

  const state = (g.__atwInstrumentation ??= {
    promise: null,
    started: false,
    startedAt: null,
  });
  state.startedAt = new Date().toISOString();

  state.promise = (async () => {
    const { installShutdownHandlers } = await import("./lib/runtime-lifecycle");
    installShutdownHandlers();

    const { recoverInterruptedRecruitmentRuns } = await import("./lib/recruitment-run");
    recoverInterruptedRecruitmentRuns();

    // A process can die after claiming an employer submission but before writing
    // the response. Startup must surface that as unresolved, never retry it.
    const { recoverStaleSubmissionClaims } = await import("./lib/submission");
    recoverStaleSubmissionClaims();

    // Close genuinely stale tasks from a prior process before new timers start.
    const { recoverStalledTasks } = await import("./lib/task-recovery");
    recoverStalledTasks();

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

    state.started = true;
    console.info(`[runtime] background workers started once at ${state.startedAt}`);
  })();

  try {
    await state.promise;
  } catch (error) {
    // A failed startup may be retried by a future register() invocation, but a
    // partially started process must not silently claim all workers are healthy.
    state.promise = null;
    state.started = false;
    throw error;
  }
}
