import crypto from "node:crypto";
import { tickRecruitmentSchedule } from "@/lib/recruitment-ticker";
import { isLoopbackRequest } from "@/lib/request-context";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron-compatible trigger. A local timer also ticks the same function, so this
 * route is optional locally and becomes the scheduler entry point when the
 * application is deployed to a platform that invokes HTTP cron jobs.
 *
 * A remote request must always present CRON_SECRET. A direct request on the
 * host is allowed for the local timer, but only when it does not carry an
 * untrusted proxy header. The production service binds to 127.0.0.1.
 */
async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  const supplied = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
  if (secret) {
    const actual = Buffer.from(supplied);
    const expected = Buffer.from(secret);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
  } else if (!isLoopbackRequest(request.headers, { allowDirect: process.env.NODE_ENV !== "production" })) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await tickRecruitmentSchedule();
  return Response.json(result, { status: result.started ? 200 : 202 });
}

export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
