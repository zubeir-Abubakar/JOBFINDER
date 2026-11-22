import type { AgentKey } from "./agent-definitions";

/**
 * Browser persistence for the live voice transcript's short-lived session id.
 *
 * A session id alone cannot say which agent produced the earlier turns, so the
 * agent key is stored beside it. The global launcher may only resume a session
 * that the server confirmed was the Coordinator. A legacy bare id or a
 * specialist session is discarded instead of being presented as Coordinator
 * history.
 */

export const LIVE_VOICE_SESSION_KEY = "atw.live.session.v2";
export const LEGACY_LIVE_VOICE_SESSION_KEY = "atw.live.session.v1";

export type StoredVoiceSession = {
  sessionId: string;
  agentKey: AgentKey;
};

const SESSION_ID = /^voice_[A-Za-z0-9_-]{6,80}$/;
const AGENT_KEYS: AgentKey[] = [
  "coordinator",
  "research",
  "analysis",
  "cv",
  "ats",
  "cover",
  "application",
  "email",
];

export function serializeVoiceSession(sessionId: string, agentKey: AgentKey): string {
  return JSON.stringify({ sessionId, agentKey });
}

export function parseStoredVoiceSession(raw: string | null): StoredVoiceSession | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const candidate = value as { sessionId?: unknown; agentKey?: unknown };
  if (typeof candidate.sessionId !== "string" || !SESSION_ID.test(candidate.sessionId)) return null;
  if (typeof candidate.agentKey !== "string" || !AGENT_KEYS.includes(candidate.agentKey as AgentKey)) return null;
  return { sessionId: candidate.sessionId, agentKey: candidate.agentKey as AgentKey };
}

/**
 * Only a Coordinator-labelled session may seed the global launcher. The server
 * re-confirms the agent and voice when minting the next token.
 */
export function resumableCoordinatorSession(raw: string | null): string | null {
  const stored = parseStoredVoiceSession(raw);
  return stored?.agentKey === "coordinator" ? stored.sessionId : null;
}
