import { all, nowIso, one, run } from "./db";
import { randomId } from "./security";
import { agentDefinition, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";

/**
 * Persisted direct-conversation sessions.
 *
 * There is one active conversational agent per user. Activating another agent
 * deactivates the previous one without deleting its history, so returning to
 * the previous agent is instant and does not require an LLM decision.
 */
export type AgentSession = {
  id: string | null;
  userId: string;
  agentKey: AgentKey;
  previousAgentKey: AgentKey | null;
  contextSummary: string | null;
  startedAt: string | null;
  lastActiveAt: string | null;
};

export type HandoverResolution =
  | { kind: "target"; target: AgentKey; reason: string }
  | { kind: "previous"; reason: string }
  | { kind: "same"; target: AgentKey; reason: string }
  | { kind: "unknown"; reason: string };

const AGENT_LOOKUP: Array<[AgentKey, RegExp]> = [
  ["coordinator", /\b(coordinator|chief coordinator|chief|orchestrator)\b/i],
  ["research", /\b(research|research agent|job research|discovery|job search)\b/i],
  ["analysis", /\b(analysis|analyst|job analysis|matching|scoring)\b/i],
  ["cv", /\b(cv|resume|curriculum vitae|cv agent|cv optimisation|cv optimization)\b/i],
  ["ats", /\b(ats|quality control|quality assurance|qc|inspector)\b/i],
  ["cover", /\b(cover letter|cover|letter agent)\b/i],
  ["application", /\b(application|application agent|applications agent|submission|submit)\b/i],
  ["email", /\b(email|tracking|inbox|mail|email agent)\b/i],
];

export function normaliseAgentKey(value: string): AgentKey | null {
  const key = value.trim().toLowerCase();
  if (!key) return null;
  for (const [agentKey, pattern] of AGENT_LOOKUP) {
    if (key === agentKey || pattern.test(key)) return agentKey;
  }
  return null;
}

export function agentKeyForName(value: string): AgentKey | null {
  const target = value.trim().toLowerCase();
  for (const [key] of AGENT_LOOKUP) {
    const definition = agentDefinition(key);
    const identity = agentIdentity(key);
    if (
      target === key ||
      target === definition?.name.toLowerCase() ||
      target === identity.shortName.toLowerCase()
    ) {
      return key;
    }
  }
  return null;
}

/** Deterministic transfer detection. No model call is allowed on this path. */
export function resolveHandoverRequest(message: string): HandoverResolution | null {
  const text = message.trim().toLowerCase();
  if (!text) return null;

  const back = /\b(take me back|go back|switch back|return me|previous agent|last agent|back to the previous)\b/i.test(text);
  const transfer = /\b(transfer|connect|switch|handover|hand off|put me through|take me to|return to|let me talk to|let me speak to|i want to speak to|i want to talk to|speak to|talk to)\b/i.test(text);
  if (!back && !transfer) return null;

  const explicitPrevious = /\b(previous agent|last agent|back to the previous|switch back)\b/i.test(text);
  if (explicitPrevious) return { kind: "previous", reason: "Return to the previous conversational agent." };

  const stripped = text
    .replace(/\b(please|can you|could you|would you|i want to|i'd like to|let me|transfer me|connect me|switch me|take me|return me)\b/g, " ")
    .replace(/\b(to|with|the|a|an|agent|specialist|directly|now|conversation|back|go)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const direct = agentKeyForName(stripped) ?? normaliseAgentKey(stripped);
  if (direct) return { kind: "target", target: direct, reason: "Explicit agent request resolved from the registry." };

  // The remaining words may contain an unambiguous agent alias in a longer
  // sentence; scanning is still deterministic and bounded by the registry.
  const candidates = AGENT_LOOKUP.filter(([, pattern]) => pattern.test(text));
  if (candidates.length === 1) {
    return { kind: "target", target: candidates[0][0], reason: "Agent alias resolved from the registry." };
  }
  if (back) return { kind: "previous", reason: "Return to the previous conversational agent." };
  return { kind: "unknown", reason: "No registered agent matched that request." };
}

export function activeAgentSession(userId: string): AgentSession {
  const row = one<{
    id: string;
    agent_key: string;
    previous_agent_key: string | null;
    context_summary: string | null;
    started_at: string;
    last_active_at: string;
  }>(
    "SELECT id, agent_key, previous_agent_key, context_summary, started_at, last_active_at FROM agent_sessions WHERE user_id = ? AND status = 'active' ORDER BY last_active_at DESC LIMIT 1",
    [userId],
  );
  if (!row) {
    return {
      id: null,
      userId,
      agentKey: "coordinator",
      previousAgentKey: null,
      contextSummary: null,
      startedAt: null,
      lastActiveAt: null,
    };
  }
  return {
    id: row.id,
    userId,
    agentKey: (agentKeyForName(row.agent_key) ?? (row.agent_key as AgentKey)) as AgentKey,
    previousAgentKey: row.previous_agent_key ? (agentKeyForName(row.previous_agent_key) ?? (row.previous_agent_key as AgentKey)) : null,
    contextSummary: row.context_summary,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
  };
}

export function previousAgentFor(userId: string): AgentKey | null {
  const active = activeAgentSession(userId);
  if (active.previousAgentKey) return active.previousAgentKey;
  const previous = one<{ agent_key: string }>(
    "SELECT agent_key FROM agent_sessions WHERE user_id = ? AND status != 'active' ORDER BY last_active_at DESC LIMIT 1",
    [userId],
  );
  return previous ? agentKeyForName(previous.agent_key) : null;
}

export function recentConversationSummary(userId: string, limit = 8): string {
  const rows = all<{ role: string; content: string; meta: string | null }>(
    "SELECT role, content, meta FROM chat_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?",
    [userId, Math.max(1, Math.min(20, limit))],
  ).reverse();
  if (rows.length === 0) return "No previous conversation.";
  return rows
    .map((row) => {
      let agent = "Owner";
      if (row.role !== "user") {
        try {
          const meta = row.meta ? (JSON.parse(row.meta) as { agentKey?: string; agentKeys?: string[] }) : {};
          agent = agentIdentity(meta.agentKey ?? meta.agentKeys?.[0] ?? "coordinator").shortName;
        } catch {
          agent = "Coordinator";
        }
      }
      return `${agent}: ${row.content.replace(/\s+/g, " ").slice(0, 360)}`;
    })
    .join("\n");
}

export type ActivationResult =
  | { ok: true; session: AgentSession; busy: boolean; busyTask: string | null; note: string | null }
  | { ok: false; session: AgentSession; reason: string };

/**
 * Activate a direct session immediately. Read-only conversations are safe to
 * run while the agent executes another task, so the previous task is reported
 * rather than blocking the owner behind a queue. Explicit pauses/disables do
 * block the handover and are reported truthfully.
 */
export function activateAgentSession(userId: string, target: AgentKey, contextSummary?: string): ActivationResult {
  const current = activeAgentSession(userId);
  const agent = one<{ key: string; enabled: number; status: string; current_task: string | null }>(
    "SELECT key, enabled, status, current_task FROM agents WHERE key = ?",
    [target],
  );
  if (!agent) return { ok: false, session: current, reason: "That agent is not registered." };
  if (agent.enabled !== 1) return { ok: false, session: current, reason: `${agentIdentity(target).name} is disabled. Enable it in Agent management first.` };
  if (agent.status === "paused") return { ok: false, session: current, reason: `${agentIdentity(target).name} is paused. Resume it before starting a direct conversation.` };

  if (current.agentKey === target && current.id) {
    run("UPDATE agent_sessions SET last_active_at = ?, context_summary = COALESCE(?, context_summary) WHERE id = ?", [
      nowIso(),
      contextSummary ?? null,
      current.id,
    ]);
    // Read back the refreshed row.
    const refreshed = activeAgentSession(userId);
    return { ok: true, session: refreshed, busy: false, busyTask: null, note: "You are already connected to this agent." };
  }

  const summary = (contextSummary ?? recentConversationSummary(userId)).slice(0, 6000);
  const now = nowIso();
  run(
    "UPDATE agent_sessions SET status = 'inactive', previous_agent_key = ? WHERE user_id = ? AND status = 'active'",
    [target, userId],
  );
  const existing = one<{ id: string }>("SELECT id FROM agent_sessions WHERE user_id = ? AND agent_key = ?", [userId, target]);
  const id = existing?.id ?? `as_${randomId()}`;
  if (existing) {
    run(
      "UPDATE agent_sessions SET status = 'active', previous_agent_key = ?, context_summary = ?, last_active_at = ? WHERE id = ?",
      [current.agentKey, summary, now, id],
    );
  } else {
    run(
      "INSERT INTO agent_sessions (id, user_id, agent_key, status, previous_agent_key, context_summary, started_at, last_active_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?)",
      [id, userId, target, current.agentKey, summary, now, now],
    );
  }
  const session: AgentSession = {
    id,
    userId,
    agentKey: target,
    previousAgentKey: current.agentKey,
    contextSummary: summary,
    startedAt: now,
    lastActiveAt: now,
  };
  const busy = agent.status === "working" || agent.status === "thinking" || agent.status === "waiting";
  return {
    ok: true,
    session,
    busy,
    busyTask: busy ? agent.current_task : null,
    note: busy
      ? `${agentIdentity(target).name} is currently ${agent.status}${agent.current_task ? `: ${agent.current_task}` : ""}. Direct conversation is read-only, so I connected you without waiting; it may refer to the task in progress.`
      : null,
  };
}

export function voiceSessionForAgent(userId: string, agentKey: AgentKey, voiceSessionId: string): string {
  const active = activeAgentSession(userId);
  if (active.agentKey === agentKey && active.id) return `${voiceSessionId}:${active.id}`;
  return voiceSessionId;
}
