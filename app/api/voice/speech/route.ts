import { currentUser } from "@/lib/auth";
import { speechFriendly, synthesizeSpeech, VoiceUnavailableError } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { text?: unknown; voice?: unknown; speed?: unknown } | null;
  const text = typeof body?.text === "string" ? speechFriendly(body.text) : "";
  if (!text) return Response.json({ error: "No text supplied." }, { status: 400 });

  try {
    const result = await synthesizeSpeech(text, {
      voice: typeof body?.voice === "string" ? body.voice : undefined,
      speed: typeof body?.speed === "number" ? body.speed : undefined,
    });
    return new Response(new Uint8Array(result.bytes), {
      headers: {
        "Content-Type": result.mime,
        "Content-Length": String(result.bytes.length),
        "Cache-Control": "private, no-store",
        "X-Voice-Source": result.cached ? "cache" : result.source,
        "X-Voice-Name": result.voice,
        "X-Voice-Model": result.model,
        ...(result.expiresAt ? { "X-Voice-Expires-At": result.expiresAt } : {}),
      },
    });
  } catch (error) {
    const message = error instanceof VoiceUnavailableError ? error.message : "Speech synthesis is unavailable.";
    return Response.json({ error: message, fallback: "browser" }, { status: 503 });
  }
}
