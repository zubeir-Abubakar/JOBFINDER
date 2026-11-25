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
      blockedByPolicy: capability.blockedByPolicy,
      provider: capability.provider,
      model: capability.model,
      supportsImages: capability.provider === "gemini",
      verified: capability.verified,
      verifiedAt: capability.verifiedAt,
      lastError: capability.lastError,
      detail: capability.detail,
      transmission: capability.blockedByPolicy
        ? "No frame is transmitted. Gemini vision is not authorised."
        : "No frame is transmitted until you explicitly ask about one. When asked, one approved frame is sent to Gemini; actual Google charges are not estimated.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
