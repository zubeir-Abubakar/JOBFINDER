"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { AGENT_VOICE_PROFILES, isLiveVoiceId } from "@/lib/agent-voices";
import { agentVoiceOverrides, saveAgentVoiceOverrides } from "@/lib/agent-voice-settings";
import type { AgentKey } from "@/lib/agent-definitions";

/** Changes only the selected agent's voice; model, provider and instructions stay as stored. */
export async function setAgentVoiceAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const voiceId = String(formData.get("voiceId") ?? "");
  if (!Object.prototype.hasOwnProperty.call(AGENT_VOICE_PROFILES, key)) {
    redirect("/admin/agents?error=Unknown+agent");
  }
  if (voiceId && !isLiveVoiceId(voiceId)) {
    redirect("/admin/agents?error=That+voice+is+not+in+the+supported+Gemini+Live+set");
  }
  const overrides = { ...agentVoiceOverrides() };
  if (isLiveVoiceId(voiceId)) overrides[key as AgentKey] = voiceId;
  else delete overrides[key as AgentKey];
  saveAgentVoiceOverrides(overrides);
  audit({
    action: "agent.voice_changed",
    entity: "agent",
    entityId: key,
    detail: voiceId ? `Voice set to ${voiceId}` : "Voice reset to the configured default",
    userId: admin.id,
  });
  revalidatePath("/admin/agents");
  revalidatePath("/agents");
  revalidatePath("/assistant");
  revalidatePath("/dashboard");
  redirect(`/admin/agents?saved=1&agent=${encodeURIComponent(key)}#voices`);
}
