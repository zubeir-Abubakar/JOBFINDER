import { currentUser } from "@/lib/auth";
import { transcribeAudio, VoiceUnavailableError } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return Response.json({ error: "No audio was uploaded." }, { status: 400 });
  if (file.size === 0) return Response.json({ error: "The recording was empty." }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: "Recording exceeds 8 MB." }, { status: 413 });

  try {
    const result = await transcribeAudio({
      bytes: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "speech.webm",
      mime: file.type || "audio/webm",
    });
    return Response.json({ text: result.text, provider: "freellmapi", model: result.model });
  } catch (error) {
    const message = error instanceof VoiceUnavailableError ? error.message : "Transcription is unavailable.";
    return Response.json({ error: message, fallback: "browser" }, { status: 503 });
  }
}
