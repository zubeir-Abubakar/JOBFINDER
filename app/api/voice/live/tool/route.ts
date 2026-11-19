import { currentUser } from "@/lib/auth";
import { executeLiveTool, isLiveAgentKey, safeSessionId } from "@/lib/live-voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The Live model can only reach these fixed handlers. It never receives SQL,
 * filesystem access, credentials, or an arbitrary URL fetcher.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    args?: unknown;
    agentKey?: unknown;
    sessionId?: unknown;
  } | null;
  const name = typeof body?.name === "string" ? body.name : "";
  const agentKey = typeof body?.agentKey === "string" && isLiveAgentKey(body.agentKey) ? body.agentKey : "coordinator";
  const args = body?.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : {};
  if (!name) return Response.json({ error: "Missing tool name." }, { status: 400 });
  const sessionId = safeSessionId(body?.sessionId);

  try {
    const outcome = await executeLiveTool({ userId: user.id, agentKey, sessionId, name, args });
    return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      { response: { ok: false, error: error instanceof Error ? error.message : "The workspace tool failed." } },
      { status: 500 },
    );
  }
}
