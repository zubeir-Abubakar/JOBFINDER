import { currentUser } from "@/lib/auth";
import { listWorkflowEvents, subscribeWorkflowEvents, type WorkflowEvent } from "@/lib/events";
import { workflowSnapshotForUser } from "@/lib/workflow-view";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Server-sent events for a single workflow. Historical events are replayed from
 * SQLite first, so a refreshed page reconstructs the run without trusting
 * browser state. The stream closes itself after 25 minutes and EventSource
 * reconnects with the last id.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new Response("Unauthorised", { status: 401 });
  const { id } = await context.params;
  if (!workflowSnapshotForUser(user, id)?.workflow) return new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  const after = Number(url.searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: WorkflowEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        closed = true;
      }
      for (const event of listWorkflowEvents(id, after)) send(event);
      unsubscribe = subscribeWorkflowEvents(id, send);
      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);
      heartbeat.unref?.();

      const shutdown = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };
      request.signal.addEventListener("abort", shutdown, { once: true });
      setTimeout(shutdown, 25 * 60_000).unref?.();
    },
    cancel() {
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
