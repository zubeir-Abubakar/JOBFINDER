import { currentUser } from "@/lib/auth";
import { getAgentTopologySnapshot } from "@/lib/agent-topology";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Authoritative read-only snapshot for the live topology view. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  return Response.json(getAgentTopologySnapshot(user), {
    headers: { "Cache-Control": "no-store" },
  });
}
