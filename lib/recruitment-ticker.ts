import { nowIso, run } from "./db";
import { randomId } from "./security";
import { activeRun, createRecruitmentRun, executeRun, recoverInterruptedRecruitmentRuns } from "./recruitment-run";
import { acquireRuntimeLock, heartbeatRuntimeWorker, releaseRuntimeLock, startRuntimeWorker, stopRuntimeWorker } from "./runtime-state";
import {
  RECRUITMENT_SCHEDULE_KEY,
  recordScheduleRun,
  scheduleSnapshot,
  catchUpWindowHours,
  formatInZone,
  localDateKey,
} from "./recruitment-schedule";
import { audit } from "./audit";
import { notify } from "./notify";
import { tickExecutiveBriefSchedule } from "./executive-brief";

/**
 * Schedule tick. Called by the process timer and by the cron-compatible API
 * route, so the same rules apply locally and in a future hosted deployment.
 *
 * - one run per local calendar day (unique run key),
 * - catch-up inside the configured window,
 * - an explicit "missed" record once that window has passed, never a silent skip,
 * - never two runs at once.
 */

type TickGlobal = typeof globalThis & { __atwRecruitmentTimer?: ReturnType<typeof setInterval> };

let lastTickAt: string | null = null;

/** Honest in-process scheduler health for the dashboard. */
export function recruitmentSchedulerStatus(): { running: boolean; lastTickAt: string | null } {
  const g = globalThis as TickGlobal;
  return { running: Boolean(g.__atwRecruitmentTimer), lastTickAt };
}

export type TickResult = {
  checkedAt: string;
  enabled: boolean;
  started: boolean;
  runId?: string;
  reason?: string;
  nextRunAt?: string | null;
  executiveBrief?: Awaited<ReturnType<typeof tickExecutiveBriefSchedule>>;
};

export async function tickRecruitmentSchedule(now: Date = new Date()): Promise<TickResult> {
  // Liveness belongs to the process, not to whether this process won the tick
  // lease. A paused schedule is still a running, healthy scheduler.
  heartbeatRuntimeWorker("recruitment_scheduler");
  // The consolidated executive brief is a separate durable schedule row. It is
  // ticked even when the recruitment schedule is paused so a disabled pipeline
  // cannot hide a missing daily report.
  let executiveBrief: Awaited<ReturnType<typeof tickExecutiveBriefSchedule>> | undefined;
  try {
    executiveBrief = await tickExecutiveBriefSchedule(now);
  } catch (error) {
    executiveBrief = {
      status: "failed",
      nextRunAt: null,
      detail: error instanceof Error ? error.message : "Executive brief scheduler failed.",
    };
  }
  const initial = scheduleSnapshot(now);
  if (!initial.enabled) {
    return { checkedAt: now.toISOString(), enabled: false, started: false, reason: "The daily schedule is disabled.", executiveBrief };
  }
  const lockKey = "recruitment:scheduler";
  if (!acquireRuntimeLock(lockKey, 300_000, undefined, { at: now.toISOString() })) {
    return {
      checkedAt: now.toISOString(),
      enabled: true,
      started: false,
      nextRunAt: initial.nextRunAt,
      reason: "Another application instance holds the scheduler tick lease; this process made no scheduling decision.",
      executiveBrief,
    };
  }
  try {
    const recovery = recoverInterruptedRecruitmentRuns(now);
    if (recovery.resumed.length > 0) {
      const resumedId = recovery.resumed[0];
      await executeRun(resumedId, { now });
      return {
        checkedAt: now.toISOString(),
        enabled: true,
        started: true,
        runId: resumedId,
        reason: "Resumed a scheduled run that survived a process restart.",
        executiveBrief,
      };
    }
    // Persisted liveness, so the dashboard can distinguish "paused" from "the
    // process is not running" without relying on in-memory state.
    run("UPDATE schedule_jobs SET last_checked_at = ? WHERE key = ?", [now.toISOString(), RECRUITMENT_SCHEDULE_KEY]);
    const snapshot = scheduleSnapshot(now);
    if (!snapshot.due) {
      return { checkedAt: now.toISOString(), enabled: true, started: false, nextRunAt: snapshot.nextRunAt, executiveBrief };
    }
    const running = activeRun();
    if (running) {
      return {
        checkedAt: now.toISOString(),
        enabled: true,
        started: false,
        runId: running.id,
        reason: "A recruitment run is already in progress.",
        executiveBrief,
      };
    }

    if (snapshot.missed) {
      const scheduledAt = snapshot.nextRunAt;
      const missedId = `run_${randomId()}`;
      const reason = `The scheduled run at ${formatInZone(scheduledAt)} was missed by more than ${catchUpWindowHours()} hour(s). The host or application was not running. It was not silently executed late.`;
      run(
        `INSERT INTO recruitment_runs (id, run_key, scheduled_for, trigger, status, state_history, failures, warnings, error, report, created_at, finished_at)
         VALUES (?, ?, ?, 'catch_up', 'failed', ?, 0, 0, ?, ?, ?, ?)`,
        [
          missedId,
          `${localDateKey(new Date(scheduledAt ?? now.toISOString()))}#missed-${randomId().slice(0, 6)}`,
          scheduledAt,
          JSON.stringify([{ state: "scheduled", at: scheduledAt }, { state: "failed", at: now.toISOString(), message: reason }]),
          reason,
          reason,
          now.toISOString(),
          now.toISOString(),
        ],
      );
      recordScheduleRun({ runId: missedId, status: "failed", error: reason, now });
      notify({ kind: "recruitment_missed", subject: "A scheduled recruitment run was missed", body: reason });
      audit({ action: "recruitment.run_missed", entity: "recruitment_run", entityId: missedId, detail: reason });
      return { checkedAt: now.toISOString(), enabled: true, started: false, runId: missedId, reason, executiveBrief };
    }

    const created = createRecruitmentRun({
      trigger: snapshot.overdueMs > 0 ? "catch_up" : "schedule",
      now,
      scheduledFor: snapshot.nextRunAt,
    });
    if (!created.created) {
      return {
        checkedAt: now.toISOString(),
        enabled: true,
        started: false,
        runId: created.run.id,
        reason: created.message,
        nextRunAt: snapshot.nextRunAt,
        executiveBrief,
      };
    }
    await executeRun(created.run.id, { now });
    return { checkedAt: now.toISOString(), enabled: true, started: true, runId: created.run.id, executiveBrief };
  } finally {
    releaseRuntimeLock(lockKey);
  }
}

/**
 * Process-local timer. It only decides when to ask SQLite whether a run is due;
 * the schedule itself survives restarts because it is stored in the database.
 */
export function startRecruitmentScheduler(): void {
  if (process.env.RECRUITMENT_SCHEDULER === "false") return;
  const g = globalThis as TickGlobal;
  if (g.__atwRecruitmentTimer) return;
  startRuntimeWorker("recruitment_scheduler", "Durable daily recruitment schedule ticker");
  const tick = () => {
    lastTickAt = new Date().toISOString();
    void tickRecruitmentSchedule().catch(() => {
      // A failed tick must not take the server down; the next tick retries and
      // the failure is visible in the run/schedule records.
    });
  };
  tick();
  g.__atwRecruitmentTimer = setInterval(tick, 60_000);
  g.__atwRecruitmentTimer.unref?.();
}

export function stopRecruitmentScheduler(): void {
  const g = globalThis as TickGlobal;
  if (g.__atwRecruitmentTimer) clearInterval(g.__atwRecruitmentTimer);
  g.__atwRecruitmentTimer = undefined;
  stopRuntimeWorker("recruitment_scheduler", "Stopped with the application process");
}
