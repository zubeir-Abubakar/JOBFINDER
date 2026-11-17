"use server";

import { revalidatePath } from "next/cache";
import { nowIso, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { handleAssistantMessage } from "@/lib/assistant";

export async function sendChatMessageAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const message = String(formData.get("message") ?? "").trim().slice(0, 2000);
  if (!message) return;
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
}

export async function clearChatAction(): Promise<void> {
  const user = await requireUser();
  run("DELETE FROM chat_messages WHERE user_id = ?", [user.id]);
  revalidatePath("/assistant");
}
