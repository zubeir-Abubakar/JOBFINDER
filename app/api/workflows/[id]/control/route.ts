import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { pauseRunningWorkflow, resumeLatestWorkflow, retryWorkflow, stopRunningWorkflow } from "@/lib/workflow";
import { emitWorkflowEvent } from "@/lib/events";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
  const action = String(body?.action ?? "");

  if (action === "pause") {
    const message = await pauseRunningWorkflow();
    emitWorkflowEvent({ workflowId: id, type: "workflow.paused", message });
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: true, message });
  }
  if (action === "stop" || action === "cancel") {
    const message = await stopRunningWorkflow();
    emitWorkflowEvent({ workflowId: id, type: "workflow.cancelled", message });
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: true, message });
  }
  if (action === "resume") {
    const result = await resumeLatestWorkflow(user.id);
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: result.ok, message: result.message, workflowId: result.workflowId });
  }
  if (action === "retry") {
    const result = await retryWorkflow(user.id, id);
    revalidatePath("/agents");
    revalidatePath("/dashboard");
    return Response.json({ ok: result.ok, message: result.message, workflowId: result.workflowId });
  }
  return Response.json({ error: "Unsupported action" }, { status: 400 });
}
