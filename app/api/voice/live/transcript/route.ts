import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { nowIso, one, run } from "@/lib/db";
import { isLiveAgentKey, safeSessionId } from "@/lib/live-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Persist completed voice turns in the existing chat_messages table. No raw
 * microphone audio is uploaded here; only the final text transcript.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    sessionId?: unknown;
    turnId?: unknown;
    role?: unknown;
    content?: unknown;
    agentKey?: unknown;
    taskIds?: unknown;
    interrupted?: unknown;
  } | null;
  const sessionId = safeSessionId(body?.sessionId);
  const turnId = typeof body?.turnId === "string" ? body.turnId.slice(0, 100) : "";
  const role = body?.role === "assistant" ? "assistant" : body?.role === "user" ? "user" : "";
  const content = typeof body?.content === "string" ? body.content.trim().slice(0, 6000) : "";
  const agentKey = typeof body?.agentKey === "string" && isLiveAgentKey(body.agentKey) ? body.agentKey : "coordinator";
  if (!turnId || !role || !content) return Response.json({ ok: true, skipped: true });
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(turnId)) return Response.json({ error: "Invalid turn id." }, { status: 400 });

  const taskIds = Array.isArray(body?.taskIds)
    ? body.taskIds.filter((id): id is string => typeof id === "string").slice(0, 12)
    : [];
  const voiceKey = `${sessionId}:${turnId}:${role}`;
  const existing = one<{ id: number }>(
    "SELECT id FROM chat_messages WHERE user_id = ? AND meta LIKE ? LIMIT 1",
    [user.id, `%"voiceKey":"${voiceKey}"%`],
  );
  if (existing) return Response.json({ ok: true, duplicate: true, id: existing.id });

  const meta = JSON.stringify({
    channel: "voice",
    sessionId,
    turnId,
    voiceKey,
    agentKey,
    taskIds,
    interrupted: Boolean(body?.interrupted),
  });
  run("INSERT INTO chat_messages (user_id, role, content, meta, created_at) VALUES (?, ?, ?, ?, ?)", [
    user.id,
    role,
    content,
    meta,
    nowIso(),
  ]);
  revalidatePath("/assistant");
  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
