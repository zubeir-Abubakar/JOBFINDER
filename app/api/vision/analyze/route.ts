import { currentUser } from "@/lib/auth";
import { analyzeScreenFrame, VisionUnavailableError } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * One explicit screen frame, one question. The image must be a base64 data URL;
 * the server never fetches an arbitrary URL, and nothing is stored.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { image?: unknown; question?: unknown } | null;
  if (!body) return Response.json({ error: "No request body was supplied." }, { status: 400 });
  try {
    const result = await analyzeScreenFrame({ imageDataUrl: body.image, question: body.question });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof VisionUnavailableError) {
      return Response.json({ error: error.message, code: "VISION_UNAVAILABLE" }, { status: error.status });
    }
    return Response.json({ error: "Visual understanding failed." }, { status: 502 });
  }
}
