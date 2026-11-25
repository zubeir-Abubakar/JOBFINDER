import { agentIdentity } from "./agent-identity";

/**
 * Free-tier inference assignment for the existing agents.
 *
 * This map selects which already-configured free route an agent prefers. It
 * invents no model id: the model always comes from the existing environment
 * configuration. If that configuration is missing the entry reports a gap
 * instead of silently assigning an unverified model.
 *
 * Deterministic work is never moved to a model here: Ali's scoring, Saffa's
 * discovery, Kali's gates and Noor's submission policy remain authoritative.
 * The route only affects optional advisory text, analysis narrative, document
 * wording and email classification.
 */

export type AgentRouteProvider = "gemini" | "freellmapi" | "openrouter" | "local";

export type AgentRoutePreference = {
  agentKey: string;
  name: string;
  provider: AgentRouteProvider;
  model: string | null;
  /** Why this route was chosen, in operator language. */
  detail: string;
  /** Set when the chosen route cannot be configured; never filled with a guess. */
  gap: string | null;
};

type RouteSpec = {
  provider: AgentRouteProvider;
  detail: string;
  model: () => string | null;
};

const geminiModel = (): string | null => (process.env.GEMINI_MODEL ?? "").trim() || null;
const freeLlmModel = (): string | null => (process.env.FREELLMAPI_MODEL ?? "").trim() || null;
const openRouterModel = (): string | null => (process.env.OPENROUTER_MODEL ?? "").trim() || null;
const openRouterAssignments = (): string[] =>
  (process.env.OPENROUTER_ASSIGNED_AGENTS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);

const SPECS: Record<string, RouteSpec> = {
  coordinator: {
    provider: "gemini",
    detail: "Chief's orchestration, routing and delegation are deterministic. Only optional advisory wording uses free-tier Gemini.",
    model: geminiModel,
  },
  research: {
    provider: "gemini",
    detail: "Saffa's discovery is deterministic connector work. Advisory summaries may use free-tier Gemini.",
    model: geminiModel,
  },
  analysis: {
    provider: "freellmapi",
    detail: "Ali's eligibility and weighted score stay deterministic. Advisory analysis uses the pinned FreeLLMAPI free-tier model.",
    model: freeLlmModel,
  },
  cv: {
    provider: "gemini",
    detail: "Kora's source-preservation rules stay authoritative. CV wording uses free-tier Gemini with JSON mode.",
    model: geminiModel,
  },
  cover: {
    provider: "freellmapi",
    detail: "Amira's claim validation stays authoritative. Cover-letter wording uses the pinned FreeLLMAPI free-tier model with JSON mode.",
    model: freeLlmModel,
  },
  ats: {
    provider: "gemini",
    detail: "Kali's PASS/REVIEW/REJECT gate stays deterministic. Advisory review wording uses free-tier Gemini.",
    model: geminiModel,
  },
  application: {
    provider: "gemini",
    detail: "Noor's submission, duplicate and confirmation gates stay deterministic. Permitted text uses Gemini 3.6 Flash free tier.",
    model: geminiModel,
  },
  email: {
    provider: "gemini",
    detail: "Rayna's correspondence matching and delivery state stay deterministic. Classification and drafts use free-tier Gemini.",
    model: geminiModel,
  },
};

export function agentRoutePreference(agentKey: string): AgentRoutePreference {
  const spec = SPECS[agentKey] ?? null;
  const name = agentIdentity(agentKey).name;
  if (!spec) {
    return {
      agentKey,
      name,
      provider: "local",
      model: null,
      detail: "No free-tier route is registered for this agent; no external model was assigned.",
      gap: `No free-tier provider assignment exists for agent ${agentKey}.`,
    };
  }
  // An explicit OpenRouter assignment is opt-in and never changes the default
  // eight-agent map. The model is still exactly OPENROUTER_MODEL; no model is
  // guessed and no existing Gemini/FreeLLMAPI assignment is rewritten.
  if (openRouterAssignments().includes(agentKey)) {
    const model = openRouterModel();
    return {
      agentKey,
      name,
      provider: "openrouter",
      model,
      detail: `OpenRouter is explicitly assigned to ${name}; only the configured exact free model is requested. No paid or dynamic route is permitted.`,
      gap: model ? null : `OPENROUTER_MODEL is not set, so ${name}'s OpenRouter route has no model to use.`,
    };
  }
  const model = spec.model();
  const envName = spec.provider === "gemini" ? "GEMINI_MODEL" : "FREELLMAPI_MODEL";
  return {
    agentKey,
    name,
    provider: spec.provider,
    model,
    detail: spec.detail,
    gap: model ? null : `${envName} is not set, so ${name}'s ${spec.provider} route has no model to use.`,
  };
}

/** Full roster in the existing display order. */
export function agentRouteTable(): AgentRoutePreference[] {
  return ["coordinator", "research", "analysis", "cv", "ats", "cover", "application", "email"].map((key) =>
    agentRoutePreference(key),
  );
}

/**
 * Ordering for the free-tier fallback chain. The agent's assigned provider is
 * tried first; the other verified free provider is the cross-provider fallback;
 * loopback Ollama is last. No other provider is ever inserted.
 */
export function freeTierRouteOrder(agentKey: string): Array<"gemini" | "freellmapi" | "openrouter" | "ollama"> {
  const preference = agentRoutePreference(agentKey).provider;
  // An explicitly assigned OpenRouter route fails closed. A temporary
  // OpenRouter outage must never silently move the agent to local Ollama or a
  // different provider; the operator can remove the assignment deliberately.
  if (preference === "openrouter") return ["openrouter"];
  if (preference === "freellmapi") return ["freellmapi", "gemini", "ollama"];
  if (preference === "local") {
    const primary = (process.env.AI_PRIMARY_PROVIDER ?? "").trim().toLowerCase();
    return primary === "gemini"
      ? ["gemini", "freellmapi", "ollama"]
      : ["freellmapi", "gemini", "ollama"];
  }
  return ["gemini", "freellmapi", "ollama"];
}
