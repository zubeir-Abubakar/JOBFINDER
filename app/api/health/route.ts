import { one, schemaVersion } from "@/lib/db";
import { scheduleSnapshot } from "@/lib/recruitment-schedule";
import { recruitmentSchedulerStatus } from "@/lib/recruitment-ticker";

export const dynamic = "force-dynamic";

/**
 * Lightweight, secret-free health endpoint for Oracle/load-balancer probes.
 * It checks the database and reports the persisted scheduler state; it does not
 * start a recruitment run or make a provider inference request.
 */
export async function GET(): Promise<Response> {
  const checkedAt = new Date().toISOString();
  try {
    const database = one<{ ok: number }>("SELECT 1 AS ok");
    const schedule = scheduleSnapshot();
    const ticker = recruitmentSchedulerStatus();
    const healthy = database?.ok === 1;
    return Response.json(
      {
        status: healthy ? "ok" : "down",
        checkedAt,
        database: { ok: healthy, schemaVersion: schemaVersion() },
        scheduler: {
          enabled: schedule.enabled,
          time: schedule.time,
          timezone: schedule.timezone,
          nextRunAt: schedule.nextRunAt,
          lastRunAt: schedule.lastRunAt,
          lastRunId: schedule.lastRunId,
          lastStatus: schedule.lastStatus,
          lastCheckedAt: schedule.lastCheckedAt,
          tickerRunning: ticker.running,
        },
        process: { uptimeSeconds: Math.round(process.uptime()) },
      },
      { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "down", checkedAt, database: { ok: false } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
