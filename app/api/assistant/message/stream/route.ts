import { revalidatePath } from "next/cache";
import { currentUser } from "@/lib/auth";
import { run, nowIso } from "@/lib/db";
import { routeAssistantMessage } from "@/lib/agent-router";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "The assistant request failed.";
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|key)[-_][A-Za-z0-9_-]{8,}\b/gi, "[redacted]")
    .slice(0, 320);
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!message) return Response.json({ error: "Message is empty." }, { status: 400 });

  run("INSERT INTO chat_messages (user_id, role, content, created_at) VALUES (?, 'user', ?, ?)", [user.id, message, nowIso()]);
  const acceptedAt = performance.now();
  let firstTokenAt: number | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: Record<string, unknown>) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          // The browser may have disconnected; the server-side turn still completes.
        }
      };
      try {
        const result = await routeAssistantMessage(user.id, message, {
          onDelta: (delta) => {
            if (firstTokenAt === null) firstTokenAt = performance.now();
            send({ type: "delta", delta });
          },
        });
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
        const completedAt = performance.now();
        send({
          type: "done",
          reply: result.reply,
          agentKey: result.agentKey,
          agentKeys: result.agentKeys ?? [],
          handover: result.handover ?? null,
          taskIds: result.taskIds,
          timings: {
            acceptedMs: 0,
            routeMs: Math.round((firstTokenAt ?? completedAt) - acceptedAt),
            firstTokenMs: firstTokenAt === null ? null : Math.round(firstTokenAt - acceptedAt),
            totalMs: Math.round(completedAt - acceptedAt),
          },
        });
        revalidatePath("/assistant");
        revalidatePath("/dashboard");
      } catch (error) {
        send({ type: "error", error: publicError(error) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
