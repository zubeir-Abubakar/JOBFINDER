import { agentIdentity } from "./agent-identity";
import type { AgentKey } from "./agent-definitions";
import type { AssistantResult } from "./assistant";
import {
  activateAgentSession,
  activeAgentSession,
  previousAgentFor,
  recentConversationSummary,
  resolveHandoverRequest,
} from "./agent-sessions";
import { handleAssistantMessage } from "./assistant";
import { handleSpecialistMessage, type RoutedAssistantResult } from "./agent-chat";

function bridge(result: {
  ok: boolean;
  session: ReturnType<typeof activeAgentSession>;
  busy?: boolean;
  busyTask?: string | null;
  note?: string | null;
  reason?: string;
}, from: AgentKey, target: AgentKey, previousRequest: boolean): RoutedAssistantResult {
  if (!result.ok) {
    return {
      reply: `I did not switch: ${result.reason ?? "that agent is unavailable."}\n\nYou are still connected to ${agentIdentity(from).name}.`,
      taskIds: [],
      agentKeys: [from],
      agentKey: from,
      sessionId: result.session.id,
      handover: { from, to: target, status: "unavailable", note: result.reason ?? null },
    };
  }
  const identity = agentIdentity(target);
  const busy = result.note ? `\n\n${result.note}` : "";
  const coordinator = target === "coordinator";
  const reply = coordinator
    ? `Returned to the Chief Coordinator. Orchestration is active again; direct specialist sessions remain available from the agent roster.${busy}\n\nAsk about agents, providers, tokens, health, permissions or recruitment, or request another specialist.`
    : `${previousRequest ? "Returned to" : "Connected directly to"} ${identity.name} (${identity.shortName}). This is a direct ${previousRequest ? "previous" : "specialist"} conversation; the Chief Coordinator remains available for orchestration.${busy}\n\nAsk ${identity.shortName} what you need, or say “return to the coordinator”.`;
  return {
    reply,
    taskIds: [],
    agentKeys: [target],
    agentKey: target,
    sessionId: result.session.id,
    handover: { from, to: target, status: "connected", note: result.note ?? null },
  };
}

/**
 * Deterministic text routing. Handover is resolved before any model call; only
 * an actual request, question or command reaches a provider.
 */
export async function routeAssistantMessage(userId: string, message: string): Promise<RoutedAssistantResult> {
  const handover = resolveHandoverRequest(message);
  const current = activeAgentSession(userId);

  if (handover) {
    if (handover.kind === "unknown") {
      return {
        reply: `I could not match that to a registered agent. The roster is: ${["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"].map((key) => agentIdentity(key).shortName).join(", ")}.`,
        taskIds: [],
        agentKeys: [current.agentKey],
        agentKey: current.agentKey,
        sessionId: current.id,
        handover: { from: current.agentKey, to: current.agentKey, status: "unchanged", note: handover.reason },
      };
    }
    const target: AgentKey = handover.kind === "previous" ? (previousAgentFor(userId) ?? "coordinator") : handover.target;
    if (target === current.agentKey) {
      return {
        reply: `You are already directly connected to ${agentIdentity(target).name}. Ask your question, or request another agent.`,
        taskIds: [],
        agentKeys: [target],
        agentKey: target,
        sessionId: current.id,
        handover: { from: current.agentKey, to: target, status: "unchanged", note: "Already active." },
      };
    }
    const context = recentConversationSummary(userId, 8);
    const result = activateAgentSession(userId, target, context);
    return bridge(result, current.agentKey, target, handover.kind === "previous");
  }

  if (current.agentKey === "coordinator") {
    const result = await handleAssistantMessage(userId, message, { sessionId: current.id });
    return { ...result, agentKey: "coordinator", sessionId: current.id };
  }

  const result = await handleSpecialistMessage(userId, current.agentKey, message, current.id);
  return { ...result, agentKey: current.agentKey, sessionId: current.id };
}
