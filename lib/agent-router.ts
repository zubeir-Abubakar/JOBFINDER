import { agentIdentity } from "./agent-identity";
import type { AgentKey } from "./agent-definitions";
import type { AssistantResult } from "./assistant";
import {
  activateAgentSession,
  activeAgentSession,
  delegationRequest,
  namedAddress,
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
    ? `Back with you — I'm Chief. What would you like to continue with?${busy}`
    : `${previousRequest ? `Back with ${identity.name}.` : `${identity.name} here.`} I have the recent context.${busy}`;
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
export type RouteOptions = { onDelta?: (delta: string) => void; view?: string | null };

export async function routeAssistantMessage(
  userId: string,
  message: string,
  options: RouteOptions = {},
): Promise<RoutedAssistantResult> {
  const handover = resolveHandoverRequest(message);
  const current = activeAgentSession(userId);

  if (handover) {
    if (handover.kind === "unknown") {
      return {
        reply: `I can connect you to ${agentIdentity("coordinator").name}, ${agentIdentity("research").name}, ${agentIdentity("analysis").name}, ${agentIdentity("cv").name}, ${agentIdentity("ats").name}, ${agentIdentity("cover").name}, ${agentIdentity("application").name} or ${agentIdentity("email").name}. Which one did you mean?`,
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

  // Explicit delegation belongs to the named specialist. The specialist keeps
  // its existing read-only permissions; an action outside that role is answered
  // naturally rather than executed by the Coordinator on its behalf.
  const delegated = delegationRequest(message);
  if (delegated) {
    const { target, request } = delegated;
    if (target === current.agentKey) {
      if (!request) return bridge({ ok: true, session: current }, current.agentKey, target, false);
      const result = target === "coordinator"
        ? await handleAssistantMessage(userId, request, { sessionId: current.id, view: options.view ?? null, onDelta: options.onDelta })
        : await handleSpecialistMessage(userId, target, request, current.id, { onDelta: options.onDelta });
      return { ...result, agentKey: target, sessionId: current.id };
    }
    const context = recentConversationSummary(userId, 8);
    const activated = activateAgentSession(userId, target, context);
    if (!activated.ok) return bridge(activated, current.agentKey, target, false);
    if (request) {
      const result = target === "coordinator"
        ? await handleAssistantMessage(userId, request, { sessionId: activated.session.id, view: options.view ?? null, onDelta: options.onDelta })
        : await handleSpecialistMessage(userId, target, request, activated.session.id, { onDelta: options.onDelta });
      return {
        ...result,
        agentKey: target,
        sessionId: activated.session.id,
        handover: { from: current.agentKey, to: target, status: "connected", note: "Explicit delegation resolved before the model call." },
      };
    }
    return bridge(activated, current.agentKey, target, false);
  }

  // Direct address: "Noor, which applications..." or bare "Saffa". The named
  // agent's real session is activated before any model call; the remaining
  // question is answered by that agent, not by a Coordinator imitation.
  const addressed = namedAddress(message);
  if (addressed) {
    const { target, remainder } = addressed;
    if (target === current.agentKey) {
      if (!remainder) {
        return {
          reply: agentIdentity(target).introduction,
          taskIds: [],
          agentKeys: [target],
          agentKey: target,
          sessionId: current.id,
          handover: { from: target, to: target, status: "unchanged", note: "Already active." },
        };
      }
      const result = target === "coordinator"
        ? await handleAssistantMessage(userId, remainder, { sessionId: current.id, view: options.view ?? null, onDelta: options.onDelta })
        : await handleSpecialistMessage(userId, target, remainder, current.id, { onDelta: options.onDelta });
      return { ...result, agentKey: target, sessionId: current.id };
    }
    const context = recentConversationSummary(userId, 8);
    const activated = activateAgentSession(userId, target, context);
    if (!activated.ok) return bridge(activated, current.agentKey, target, false);
    if (remainder) {
      const result = target === "coordinator"
        ? await handleAssistantMessage(userId, remainder, { sessionId: activated.session.id, view: options.view ?? null, onDelta: options.onDelta })
        : await handleSpecialistMessage(userId, target, remainder, activated.session.id, { onDelta: options.onDelta });
      return {
        ...result,
        agentKey: target,
        sessionId: activated.session.id,
        handover: { from: current.agentKey, to: target, status: "connected", note: "Named address resolved before the model call." },
      };
    }
    return bridge(activated, current.agentKey, target, false);
  }

  // An executive brief command is a Coordinator operation even when the owner
  // is currently in a specialist chat. Delivery is never delegated to the
  // Email Agent or interpreted by a model.
  const briefCommand =
    /\b(executive|daily)\s+(brief|report)\b|\bexecutive brief\b/i.test(message) &&
    /\b(send|email|deliver|resend|delivery|delivered|status|sent|queued|bounce|bounced|inbox)\b/i.test(message);
  if (briefCommand && current.agentKey !== "coordinator") {
    const context = recentConversationSummary(userId, 8);
    const activated = activateAgentSession(userId, "coordinator", context);
    const result = await handleAssistantMessage(userId, message, { sessionId: activated.session.id, view: options.view ?? null, onDelta: options.onDelta });
    return {
      ...result,
      agentKey: "coordinator",
      sessionId: activated.session.id,
      handover: { from: current.agentKey, to: "coordinator", status: "connected", note: "Executive brief operations are Coordinator-owned." },
    };
  }

  if (current.agentKey === "coordinator") {
    const result = await handleAssistantMessage(userId, message, { sessionId: current.id, view: options.view ?? null, onDelta: options.onDelta });
    return { ...result, agentKey: "coordinator", sessionId: current.id };
  }

  const result = await handleSpecialistMessage(userId, current.agentKey, message, current.id, { onDelta: options.onDelta });
  return { ...result, agentKey: current.agentKey, sessionId: current.id };
}
