import { one } from "./db";
import { getSetting } from "./settings";
import { freeLlmPolicyIssue, providerConfigured, providerStatusSnapshot } from "./providers";

export type AgentAvailability = {
  available: boolean;
  reason: string | null;
  dependency: string | null;
  /** configuration = missing settings; health = configured but unreachable/rejected. */
  cause?: "configuration" | "health" | null;
};

const AVAILABLE: AgentAvailability = { available: true, reason: null, dependency: null };

function profileReady(): AgentAvailability {
  const row = one<{ full_name: string | null; skills: number; experiences: number }>(
    `SELECT p.full_name,
            (SELECT COUNT(*) FROM skills WHERE deleted_at IS NULL AND source <> 'seed') AS skills,
            (SELECT COUNT(*) FROM experiences WHERE deleted_at IS NULL) AS experiences
     FROM profiles p WHERE p.id = 1`,
  );
  if (!row?.full_name?.trim()) {
    return { available: false, reason: "The master profile has no full name.", dependency: "Professional profile", cause: "configuration" };
  }
  if (!row.skills) {
    return { available: false, reason: "The master profile has no verified skills.", dependency: "Verified skills", cause: "configuration" };
  }
  if (!row.experiences) {
    return { available: false, reason: "The master profile has no experience records.", dependency: "Verified experience", cause: "configuration" };
  }
  return AVAILABLE;
}

/**
 * Computed dependency health. This is deliberately not written into the agents
 * table: pauses are administrator intent, while availability depends on live
 * configuration and must clear as soon as the dependency is restored.
 *
 * Provider availability comes from one shared provider-layer helper so the
 * Coordinator and every specialist agree, and a configured-but-unreachable
 * gateway is reported differently from a missing configuration.
 */
export function agentAvailability(key: string): AgentAvailability {
  if (key === "coordinator") {
    if (!providerConfigured()) {
      const policy = freeLlmPolicyIssue();
      return {
        available: false,
        dependency: "AI provider",
        reason: policy
          ? `No permitted AI model is selected. ${policy}`
          : "No AI provider is configured. Set the FreeLLMAPI variables to enable the primary gateway, or set OLLAMA_ENABLED=true, OLLAMA_BASE_URL, OLLAMA_MODEL and OLLAMA_CODER_MODEL for local fallback.",
        cause: "configuration",
      };
    }
    const snapshot = providerStatusSnapshot();
    if (snapshot.available === false) {
      return {
        available: false,
        dependency: "AI provider",
        reason: `AI providers are configured but unavailable: ${snapshot.detail}`,
        cause: "health",
      };
    }
    return AVAILABLE;
  }

  if (key === "research") {
    const source = one<{ enabled: number; url: string | null }>("SELECT enabled, url FROM job_sources WHERE key = 'arbeitnow'");
    if (!source) return { available: false, reason: "The Arbeitnow source connector is missing.", dependency: "Arbeitnow connector", cause: "configuration" };
    if (!source.enabled) return { available: false, reason: "The Arbeitnow source is disabled in Job discovery → Sources.", dependency: "Arbeitnow connector", cause: "configuration" };
    if (!source.url) return { available: false, reason: "The Arbeitnow source has no endpoint URL.", dependency: "Arbeitnow endpoint", cause: "configuration" };
    return AVAILABLE;
  }

  if (key === "email") {
    const email = getSetting<{ connected: boolean; account?: string }>("email", { connected: false });
    if (!email.connected) {
      return {
        available: false,
        reason: "Gmail is not connected. Connect it in Inbox before recruiter correspondence can be monitored.",
        dependency: "Gmail OAuth",
        cause: "configuration",
      };
    }
    const account = one<{ id: number }>("SELECT id FROM gmail_accounts LIMIT 1");
    if (!account) {
      return {
        available: false,
        reason: "Gmail is marked connected but no stored OAuth account was found. Reconnect Gmail.",
        dependency: "Gmail OAuth token",
        cause: "configuration",
      };
    }
    if (!process.env.APP_SECRET_KEY) {
      return {
        available: false,
        reason: "APP_SECRET_KEY is not configured, so the stored Gmail OAuth token cannot be decrypted.",
        dependency: "APP_SECRET_KEY",
        cause: "configuration",
      };
    }
    return AVAILABLE;
  }

  if (key === "analysis" || key === "cv" || key === "ats" || key === "cover") {
    return profileReady();
  }

  return AVAILABLE;
}

/**
 * Effective display state: explicit pause wins; unavailable only masks
 * non-terminal states. Completed/failed remain historical facts, which is why
 * the UI must label them as history when no workflow is running.
 */
export function effectiveAgentStatus(
  status: string,
  enabled: boolean,
  availability: AgentAvailability,
  options: { hasActiveWorkflow?: boolean } = {},
): string {
  if (!enabled) return status;
  if (["paused", "working", "thinking", "failed"].includes(status)) return status;
  // "Completed" is a task outcome, not current availability. With no live
  // assignment the roster shows Idle and keeps the task as history.
  if (status === "completed") return "idle";
  if (!availability.available) return "unavailable";
  return status;
}
