import { currentUser } from "@/lib/auth";
import { providerStatusSummary } from "@/lib/provider-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Read-only, authenticated provider status. No probes are sent from this view. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  return Response.json(providerStatusSummary(), { headers: { "Cache-Control": "no-store" } });
}
