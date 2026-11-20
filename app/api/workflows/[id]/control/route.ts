import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { activeWorkflow, pauseRunningWorkflow, resumeLatestWorkflow, retryWorkflow, stopRunningWorkflow } from "@/lib/workflow";
import { emitWorkflowEvent } from "@/lib/events";
import { workflowSnapshotForUser } from "@/lib/workflow-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await context.params;
  if (!workflowSnapshotForUser(user, id)?.workflow) {
    return Response.json({ error: "Workflow not found" }, { status: 404 });
  }
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = String(body?.action ?? "");

  if (action === "pause") {
    if (activeWorkflow(user)?.id !== id) {
      return Response.json({ error: "Only the running workflow can be paused." }, { status: 409 });
    }
    const message = await pauseRunningWorkflow(user);
    emitWorkflowEvent({ workflowId: id, type: "workflow.paused", message });
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: true, message });
  }
  if (action === "stop" || action === "cancel") {
    if (activeWorkflow(user)?.id !== id) {
      return Response.json({ error: "Only the running workflow can be stopped." }, { status: 409 });
    }
    const message = await stopRunningWorkflow(user);
    emitWorkflowEvent({ workflowId: id, type: "workflow.cancelled", message });
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: true, message });
  }
  if (action === "resume") {
    const result = await resumeLatestWorkflow(user);
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: result.ok, message: result.message, workflowId: result.workflowId });
  }
  if (action === "retry") {
    const result = await retryWorkflow(user, id);
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: result.ok, message: result.message, workflowId: result.workflowId });
  }
  return Response.json({ error: "Unsupported action" }, { status: 400 });
}
