import { healthRequestAuthorised } from "@/lib/health-access";
import { operationalHealthSnapshot } from "@/lib/runtime-health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Secret-free health endpoint for systemd or a private monitor.
 * Remote callers get 404 unless HEALTH_PUBLIC=true or a bearer
 * HEALTHCHECK_TOKEN is configured and supplied. The response never starts a
 * recruitment run, contacts an employer, sends email or probes a provider.
 */
export async function GET(request: Request): Promise<Response> {
  if (!healthRequestAuthorised(request)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const health = operationalHealthSnapshot();
  const statusCode = health.status === "down" ? 503 : 200;
  return Response.json(
    {
      status: health.status,
      checkedAt: health.checkedAt,
      database: health.database,
      scheduler: health.scheduler,
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        pid: process.pid,
        instanceId: health.instanceId,
      },
      operational: health,
    },
    { status: statusCode, headers: { "Cache-Control": "no-store" } },
  );
}
