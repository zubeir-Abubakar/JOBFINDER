import { currentUser } from "@/lib/auth";
import {
  createLiveSession,
  isLiveAgentKey,
  liveVoiceConfig,
  normaliseVoice,
  safeSessionId,
  type LiveVoiceName,
} from "@/lib/live-voice";
import { randomId } from "@/lib/security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const sessionWindows = new Map<string, number>();

/** Short-lived, server-authenticated Live credentials. The permanent key is never returned. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });

  const config = liveVoiceConfig();
  if (!config.configured) {
    return Response.json(
      {
        error: `Live voice is not configured. Add ${config.missing.join(", ")} on the server. No paid fallback was attempted.`,
        code: "LIVE_NOT_CONFIGURED",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    agentKey?: unknown;
    sessionId?: unknown;
    voice?: unknown;
    greet?: unknown;
  } | null;
  const requestedAgent = typeof body?.agentKey === "string" ? body.agentKey : "coordinator";
  const agentKey = isLiveAgentKey(requestedAgent) ? requestedAgent : "coordinator";
  const sessionId = safeSessionId(body?.sessionId);
  const voice: LiveVoiceName = normaliseVoice(typeof body?.voice === "string" ? body.voice : config.voice);
  const greet = body?.greet !== false;

  // Prevent a single page from minting tokens in a tight loop. A reconnect
  // still gets a fresh token, but the UI waits between attempts.
  const now = Date.now();
  const previous = sessionWindows.get(user.id) ?? 0;
  if (now - previous < 750) {
    return Response.json({ error: "Please wait a moment before starting another voice session.", code: "LIVE_RATE_LIMIT" }, { status: 429 });
  }
  sessionWindows.set(user.id, now);

  try {
    const session = await createLiveSession({
      userId: user.id,
      agentKey,
      sessionId,
      voice,
      greet,
    });
    return Response.json(session, {
      headers: {
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live voice could not start.";
    return Response.json({ error: message, code: "LIVE_UNAVAILABLE" }, { status: 502 });
  }
}

/** Secret-free capability probe used by the UI before it asks for microphone access. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const config = liveVoiceConfig();
  return Response.json(
    {
      configured: config.configured,
      missing: config.missing,
      model: config.model,
      voice: config.voice,
      voices: ["Charon", "Orus", "Fenrir", "Puck"],
      sessionPrefix: `voice_${randomId().slice(0, 6)}`,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
