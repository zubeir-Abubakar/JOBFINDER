import { currentUser } from "@/lib/auth";
import { visionCapability } from "@/lib/vision";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Capability is reported truthfully: configured is not the same as verified. */
export async function GET() {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Unauthorised" }, { status: 401 });
  const capability = visionCapability();
  return Response.json(
    {
      enabled: capability.enabled,
      configured: capability.configured,
      provider: capability.provider,
      model: capability.model,
      supportsImages: capability.provider === "gemini",
      verified: capability.verified,
      verifiedAt: capability.verifiedAt,
      lastError: capability.lastError,
      detail: capability.detail,
      transmission: "A frame is sent only after the owner clicks “Ask about this screen”.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
