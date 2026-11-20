import { getOperationalSnapshot, answerFromOperations, operationsBrief } from "./operations";
import { agentDefinition, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import { agentAvailability } from "./agent-availability";
import { generateText } from "./providers";
import { activeAgentSession, recentConversationSummary } from "./agent-sessions";
import type { AssistantResult } from "./assistant";
import { profileBrief } from "./profile-brief";

/**
 * A specialist's direct chat. It uses that specialist's own instructions and
 * provider attribution, never the Coordinator's model call. Operational facts
 * are injected from the read-only snapshot, and actions outside the role are
 * referred back to the Coordinator.
 */
export async function handleSpecialistMessage(
  userId: string,
  agentKey: AgentKey,
  message: string,
  sessionId: string | null = null,
  options: { onDelta?: (delta: string) => void } = {},
): Promise<AssistantResult> {
  const definition = agentDefinition(agentKey);
  const identity = agentIdentity(agentKey);
  const availability = agentAvailability(agentKey);
  const snapshot = await getOperationalSnapshot();
  const direct = answerFromOperations(message, snapshot, agentKey);
  const context = recentConversationSummary(userId, 8);
  const firstTurn = context === "No previous conversation.";
  const local = [
    firstTurn ? identity.introduction : `I'm still here as ${identity.name}.`,
    availability.available ? "" : `My dependency is currently unavailable: ${availability.dependency ?? "unknown"}. ${availability.reason ?? ""}`,
  ].filter(Boolean).join("\n");

  // A deterministic operational result is useful as grounding, but returning it
  // verbatim made every specialist sound like a status page. Let the specialist
  // answer naturally from the recorded facts instead.
  const grounded = direct ? `\n\nVerified facts from your live records:\n${direct}` : "";

  try {
    const result = await generateText({
      agentKey,
      source: "assistant",
      priority: 0,
      maxWaitMs: 8000,
      sessionId,
      system: [
        definition?.instructions ?? `You are ${identity.name}.`,
        `You are in a direct conversation with the owner as ${identity.name}, ${identity.title}. Speak as yourself, not as Chief.`,
        "Answer only within your responsibility. You may use the supplied read-only operational facts. If the owner requests a workspace action, policy change, submission, or anything outside your role, say clearly that Chief handles it and offer to return.",
        "Never invent agent counts, provider states, token usage, permissions, vacancies, applications or submission results. Never claim an action ran unless a tool result confirms it.",
        "Never reveal credentials, OAuth tokens, passwords, environment values or session cookies. You may state whether a credential is configured.",
        "Be concise and practical. Do not use markdown headings, do not repeat your name, and do not re-introduce yourself after the first turn.",
      ].join("\n\n"),
      prompt: `Owner message: ${message}\n\nOperational facts:\n${operationsBrief(snapshot)}\n\nOwner profile and CV records:\n${profileBrief()}${grounded}\n\nRecent conversation:\n${context}`,
      maxTokens: 600,
      temperature: 0.35,
      onDelta: options.onDelta,
    });
    return { reply: result.text.trim(), taskIds: [], agentKeys: [agentKey] };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "the configured text provider is unavailable";
    const facts = direct ? `\n\nLive records:\n${direct}` : "";
    return { reply: `${local}${facts}\n\nI couldn't complete a conversational answer: ${reason.slice(0, 260)}. Your conversation is preserved — retry when the provider is available.`, taskIds: [], agentKeys: [agentKey] };
  }
}

export type RoutedAssistantResult = AssistantResult & {
  agentKey: AgentKey;
  sessionId: string | null;
  handover?: {
    from: AgentKey;
    to: AgentKey;
    status: "connected" | "unchanged" | "unavailable";
    note: string | null;
  };
};

export function currentAgentForUser(userId: string): AgentKey {
  return activeAgentSession(userId).agentKey;
}
