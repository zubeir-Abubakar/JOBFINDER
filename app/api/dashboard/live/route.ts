import { currentUser } from "@/lib/auth";
import { getDashboardSnapshot } from "@/lib/dashboard-live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Authenticated, read-only live snapshot for the owner dashboard. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  try {
    return Response.json(getDashboardSnapshot(), {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      { error: "The live workforce snapshot could not be read. Existing data was not changed." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
