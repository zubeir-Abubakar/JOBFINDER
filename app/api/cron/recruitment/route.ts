import { tickRecruitmentSchedule } from "@/lib/recruitment-ticker";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron-compatible trigger. A local timer also ticks the same function, so this
 * route is optional locally and becomes the scheduler entry point when the
 * application is deployed to a platform that invokes HTTP cron jobs.
 *
 * When CRON_SECRET is set the request must present it as a bearer token; the
 * endpoint can never start a run anonymously in that configuration.
 */
async function handle(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = request.headers.get("authorization");
    if (header !== `Bearer ${secret}`) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
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
