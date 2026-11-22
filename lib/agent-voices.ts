import type { AgentKey } from "./agent-definitions";

/**
 * Distinct Gemini Live voice profiles for the eight registered agents.
 *
 * Gemini Live exposes 30 prebuilt HD voices. These eight are all in Google's
 * published supported set and were chosen for different timbres, not merely
 * different labels. The Live API supports voice name, not rate/pitch controls,
 * so `rate` is recorded for UI transparency and `pitch` is explicitly null
 * rather than pretending a setting exists.
 */
export const LIVE_VOICE_IDS = [
  "Charon",
  "Orus",
  "Fenrir",
  "Kore",
  "Puck",
  "Aoede",
  "Leda",
  "Zephyr",
] as const;

export type LiveVoiceId = (typeof LIVE_VOICE_IDS)[number];

export type AgentVoiceProfile = {
  agentKey: AgentKey;
  voiceId: LiveVoiceId;
  voiceName: string;
  provider: "gemini-live";
  language: string;
  style: string;
  rate: number;
  /** Gemini Live does not expose a pitch parameter. */
  pitch: null;
  available: boolean;
};

export const AGENT_VOICE_PROFILES: Record<AgentKey, AgentVoiceProfile> = {
  coordinator: {
    agentKey: "coordinator",
    voiceId: "Charon",
    voiceName: "Charon — informative, calm",
    provider: "gemini-live",
    language: "English",
    style: "Calm, precise, quietly authoritative",
    rate: 1,
    pitch: null,
    available: true,
  },
  research: {
    agentKey: "research",
    voiceId: "Leda",
    voiceName: "Leda — youthful, clear",
    provider: "gemini-live",
    language: "English",
    style: "Focused and evidence-led",
    rate: 1,
    pitch: null,
    available: true,
  },
  analysis: {
    agentKey: "analysis",
    voiceId: "Fenrir",
    voiceName: "Fenrir — energetic, direct",
    provider: "gemini-live",
    language: "English",
    style: "Sharp, analytical and direct",
    rate: 1,
    pitch: null,
    available: true,
  },
  cv: {
    agentKey: "cv",
    voiceId: "Kore",
    voiceName: "Kore — firm, clear",
    provider: "gemini-live",
    language: "English",
    style: "Structured and editorial",
    rate: 1,
    pitch: null,
    available: true,
  },
  ats: {
    agentKey: "ats",
    voiceId: "Puck",
    voiceName: "Puck — upbeat, brisk",
    provider: "gemini-live",
    language: "English",
    style: "Precise and quality-focused",
    rate: 1,
    pitch: null,
    available: true,
  },
  cover: {
    agentKey: "cover",
    voiceId: "Aoede",
    voiceName: "Aoede — breezy, warm",
    provider: "gemini-live",
    language: "English",
    style: "Warm, persuasive and human",
    rate: 1,
    pitch: null,
    available: true,
  },
  application: {
    agentKey: "application",
    voiceId: "Orus",
    voiceName: "Orus — firm, composed",
    provider: "gemini-live",
    language: "English",
    style: "Practical and process-driven",
    rate: 1,
    pitch: null,
    available: true,
  },
  email: {
    agentKey: "email",
    voiceId: "Zephyr",
    voiceName: "Zephyr — bright, lively",
    provider: "gemini-live",
    language: "English",
    style: "Attentive and correspondence-focused",
    rate: 1,
    pitch: null,
    available: true,
  },
};

export function voiceProfileForAgent(agentKey: string): AgentVoiceProfile {
  return AGENT_VOICE_PROFILES[agentKey as AgentKey] ?? AGENT_VOICE_PROFILES.coordinator;
}

export function isLiveVoiceId(value: string): value is LiveVoiceId {
  return LIVE_VOICE_IDS.includes(value as LiveVoiceId);
}

/** Human label for any supported voice, including one not currently assigned. */
export function voiceNameForId(voiceId: LiveVoiceId): string {
  const profile = Object.values(AGENT_VOICE_PROFILES).find((candidate) => candidate.voiceId === voiceId);
  return profile?.voiceName ?? `${voiceId} — Gemini Live voice`;
}

/** The existing supported set, in its published order. No new voices are invented. */
export function supportedVoices(): Array<{ voiceId: LiveVoiceId; voiceName: string }> {
  return LIVE_VOICE_IDS.map((voiceId) => ({ voiceId, voiceName: voiceNameForId(voiceId) }));
}

/**
 * Applies a stored per-agent override. Only the voice fields change; identity,
 * provider, language, style and every other agent's profile are untouched.
 */
export function applyVoiceOverride(
  profile: AgentVoiceProfile,
  overrides: Partial<Record<AgentKey, string>>,
): AgentVoiceProfile {
  const candidate = overrides[profile.agentKey];
  if (!candidate || !isLiveVoiceId(candidate)) return profile;
  return { ...profile, voiceId: candidate, voiceName: voiceNameForId(candidate) };
}
