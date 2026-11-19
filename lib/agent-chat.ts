import { getOperationalSnapshot, answerFromOperations, operationsBrief } from "./operations";
import { agentDefinition, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import { agentAvailability } from "./agent-availability";
import { generateText } from "./providers";
import { activeAgentSession, recentConversationSummary } from "./agent-sessions";
import type { AssistantResult } from "./assistant";

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
): Promise<AssistantResult> {
  const definition = agentDefinition(agentKey);
  const identity = agentIdentity(agentKey);
  const availability = agentAvailability(agentKey);
  const snapshot = await getOperationalSnapshot();
  const agent = snapshot.agents.find((item) => item.key === agentKey);
  const direct = answerFromOperations(message, snapshot, agentKey);
  const context = recentConversationSummary(userId, 8);
  const local = [
    `I am ${identity.name}, the ${definition?.role ?? "specialist"} agent.`,
    agent
      ? `Current status: ${agent.status}${agent.currentTask ? ` — ${agent.currentTask}` : ""}. Provider: ${agent.provider ?? "not used yet"}${agent.model ? ` / ${agent.model}` : ""} (${agent.providerStatus}). Voice: ${agent.voice.voiceName}.`
      : "Current status is unavailable.",
    availability.available
      ? `I can help with: ${definition?.input ?? "my assigned work"}.`
      : `My dependency is currently unavailable: ${availability.dependency ?? "unknown"}. ${availability.reason ?? ""}`,
    "I can answer read-only questions about my work and the live workspace. Actions and policy changes stay with the Coordinator.",
  ].join("\n");

  if (direct && agentKey !== "coordinator") {
    // A deterministic answer is preferable to a model call for factual
    // questions, and still respects the specialist's read-only boundary.
    return { reply: direct, taskIds: [], agentKeys: [agentKey] };
  }

  try {
    const result = await generateText({
      agentKey,
      source: "assistant",
      priority: 0,
      maxWaitMs: 8000,
      sessionId,
      system: [
        definition?.instructions ?? `You are ${identity.name}.`,
        `You are in a direct conversation with the owner as ${identity.name}. Speak as yourself, not as the Chief Coordinator.`,
        "Answer only within your responsibility. You may use the supplied read-only operational facts. If the owner requests a workspace action, policy change, submission, or anything outside your role, say clearly that the Chief Coordinator handles it and offer to return.",
        "Never invent agent counts, provider states, token usage, permissions, vacancies, applications or submission results. Never claim an action ran unless a tool result confirms it.",
        "Never reveal credentials, OAuth tokens, passwords, environment values or session cookies. You may state whether a credential is configured.",
        "Be concise and practical. Do not use markdown headings.",
      ].join("\n\n"),
      prompt: `Owner message: ${message}\n\nOperational facts:\n${operationsBrief(snapshot)}\n\nRecent conversation:\n${context}`,
      maxTokens: 600,
      temperature: 0.35,
    });
    return { reply: result.text.trim(), taskIds: [], agentKeys: [agentKey] };
  } catch {
    return { reply: local, taskIds: [], agentKeys: [agentKey] };
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
