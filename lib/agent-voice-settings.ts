import { AGENT_VOICE_PROFILES, applyVoiceOverride, isLiveVoiceId, voiceProfileForAgent, type AgentVoiceProfile, type LiveVoiceId } from "./agent-voices";
import { getSetting, setSetting } from "./settings";
import type { AgentKey } from "./agent-definitions";

export const AGENT_VOICE_SETTINGS_KEY = "agent_voice_overrides";

export type AgentVoiceOverrides = Partial<Record<AgentKey, LiveVoiceId>>;

function isAgentKey(value: string): value is AgentKey {
  return Object.prototype.hasOwnProperty.call(AGENT_VOICE_PROFILES, value);
}

/** Invalid stored values are ignored rather than applied to an unknown agent. */
export function agentVoiceOverrides(): AgentVoiceOverrides {
  const raw = getSetting<Record<string, unknown>>(AGENT_VOICE_SETTINGS_KEY, {});
  const clean: AgentVoiceOverrides = {};
  if (!raw || typeof raw !== "object") return clean;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && isAgentKey(key) && isLiveVoiceId(value)) clean[key] = value;
  }
  return clean;
}

/** The voice used by the live session: the configured default plus any override. */
export function effectiveVoiceProfileForAgent(agentKey: string): AgentVoiceProfile {
  return applyVoiceOverride(voiceProfileForAgent(agentKey), agentVoiceOverrides());
}

export function saveAgentVoiceOverrides(overrides: AgentVoiceOverrides): void {
  setSetting(AGENT_VOICE_SETTINGS_KEY, overrides);
}
