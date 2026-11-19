"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { routeAssistantMessage } from "@/lib/agent-router";
import { activateAgentSession, agentKeyForName, recentConversationSummary } from "@/lib/agent-sessions";

export async function sendChatMessageAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const message = String(formData.get("message") ?? "").trim().slice(0, 2000);
  if (!message) return;
  run("INSERT INTO chat_messages (user_id, role, content, created_at) VALUES (?, 'user', ?, ?)", [user.id, message, nowIso()]);
  const result = await routeAssistantMessage(user.id, message);
  run("INSERT INTO chat_messages (user_id, role, content, meta, created_at) VALUES (?, 'assistant', ?, ?, ?)", [
    user.id,
    result.reply,
    JSON.stringify({
      taskIds: result.taskIds,
      agentKeys: result.agentKeys ?? [],
      agentKey: result.agentKey,
      sessionId: result.sessionId,
      handover: result.handover ?? null,
      pendingAction: result.pendingAction ?? null,
    }),
    nowIso(),
  ]);
  revalidatePath("/assistant");
  revalidatePath("/dashboard");
}

export async function switchAgentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const raw = String(formData.get("agent") ?? "").trim();
  const target = agentKeyForName(raw);
  if (!target) redirect("/assistant?error=Unknown+agent.#chat");
  const result = activateAgentSession(user.id, target, recentConversationSummary(user.id, 8));
  revalidatePath("/assistant");
  revalidatePath("/agents");
  if (!result.ok) redirect(`/assistant?error=${encodeURIComponent(result.reason)}#chat`);
  redirect(`/assistant?ok=${encodeURIComponent(`Connected to ${target}.`)}#chat`);
}

export async function clearChatAction(): Promise<void> {
  const user = await requireUser();
  run("DELETE FROM chat_messages WHERE user_id = ?", [user.id]);
  revalidatePath("/assistant");
}
