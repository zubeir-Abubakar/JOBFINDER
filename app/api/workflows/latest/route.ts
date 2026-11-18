import { currentUser } from "@/lib/auth";
import { latestWorkflowSnapshot } from "@/lib/workflow-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const snapshot = latestWorkflowSnapshot();
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
