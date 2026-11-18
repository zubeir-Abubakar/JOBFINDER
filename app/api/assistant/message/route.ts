import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { run, nowIso } from "@/lib/db";
import { handleAssistantMessage } from "@/lib/assistant";
import { chatHistory } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  return Response.json({ messages: chatHistory(user.id, 40) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Shared conversational entry point for the floating voice assistant and the
 * full assistant page. It runs the same Coordinator and the same approval
 * rules; voice never gets a privileged path.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) return Response.json({ error: "Message is empty." }, { status: 400 });

  run("INSERT INTO chat_messages (user_id, role, content, created_at) VALUES (?, 'user', ?, ?)", [user.id, message, nowIso()]);
  const result = await handleAssistantMessage(user.id, message);
  run("INSERT INTO chat_messages (user_id, role, content, meta, created_at) VALUES (?, 'assistant', ?, ?, ?)", [
    user.id,
    result.reply,
    JSON.stringify({ taskIds: result.taskIds, agentKeys: result.agentKeys ?? [], pendingAction: result.pendingAction ?? null }),
    nowIso(),
  ]);
  revalidatePath("/assistant");
  revalidatePath("/dashboard");
  return Response.json({
    reply: result.reply,
    agentKeys: result.agentKeys ?? [],
    taskIds: result.taskIds,
    pendingAction: result.pendingAction ?? null,
  });
}
