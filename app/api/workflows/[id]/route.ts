import { currentUser } from "@/lib/auth";
import { workflowSnapshotForUser } from "@/lib/workflow-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await context.params;
  const snapshot = workflowSnapshotForUser(user, id);
  if (!snapshot?.workflow) return Response.json({ error: "Workflow not found" }, { status: 404 });
  return Response.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
