import { one } from "./db";
import { getSetting } from "./settings";

export type AgentAvailability = {
  available: boolean;
  reason: string | null;
  dependency: string | null;
};

const AVAILABLE: AgentAvailability = { available: true, reason: null, dependency: null };

function profileReady(): AgentAvailability {
  const row = one<{ full_name: string | null; skills: number; experiences: number }>(
    `SELECT p.full_name,
            (SELECT COUNT(*) FROM skills) AS skills,
            (SELECT COUNT(*) FROM experiences) AS experiences
     FROM profiles p WHERE p.id = 1`,
  );
  if (!row?.full_name?.trim()) {
    return { available: false, reason: "The master profile has no full name.", dependency: "Professional profile" };
  }
  if (!row.skills) {
    return { available: false, reason: "The master profile has no verified skills.", dependency: "Verified skills" };
  }
  if (!row.experiences) {
    return { available: false, reason: "The master profile has no experience records.", dependency: "Verified experience" };
  }
  return AVAILABLE;
}

/**
 * Computed dependency health. This is deliberately not written into the agents
 * table: pauses are administrator intent, while availability depends on live
 * configuration and must clear as soon as the dependency is restored.
 */
export function agentAvailability(key: string): AgentAvailability {
  if (key === "coordinator") {
    const configured =
      Boolean(process.env.GEMINI_API_KEY) ||
      (process.env.OPENROUTER_ENABLED === "true" && Boolean(process.env.OPENROUTER_API_KEY)) ||
      process.env.OLLAMA_ENABLED !== "false";
    return configured
      ? AVAILABLE
      : { available: false, reason: "No AI provider is enabled: Gemini and OpenRouter keys are absent and Ollama is disabled.", dependency: "AI provider" };
  }

  if (key === "research") {
    const source = one<{ enabled: number; url: string | null }>("SELECT enabled, url FROM job_sources WHERE key = 'arbeitnow'");
    if (!source) return { available: false, reason: "The Arbeitnow source connector is missing.", dependency: "Arbeitnow connector" };
    if (!source.enabled) return { available: false, reason: "The Arbeitnow source is disabled in Job discovery → Sources.", dependency: "Arbeitnow connector" };
    if (!source.url) return { available: false, reason: "The Arbeitnow source has no endpoint URL.", dependency: "Arbeitnow endpoint" };
    return AVAILABLE;
  }

  if (key === "email") {
    const email = getSetting<{ connected: boolean; account?: string }>("email", { connected: false });
    if (!email.connected) {
      return { available: false, reason: "Gmail is not connected. Connect it in Inbox before recruiter correspondence can be monitored.", dependency: "Gmail OAuth" };
    }
    const account = one<{ id: number }>("SELECT id FROM gmail_accounts LIMIT 1");
    if (!account) {
      return { available: false, reason: "Gmail is marked connected but no stored OAuth account was found. Reconnect Gmail.", dependency: "Gmail OAuth token" };
    }
    if (!process.env.APP_SECRET_KEY) {
      return { available: false, reason: "APP_SECRET_KEY is not configured, so the stored Gmail OAuth token cannot be decrypted.", dependency: "APP_SECRET_KEY" };
    }
    return AVAILABLE;
  }

  if (key === "analysis" || key === "cv" || key === "ats" || key === "cover") {
    return profileReady();
  }

  return AVAILABLE;
}

/** Effective display state: explicit pause wins; unavailable only masks non-active states. */
export function effectiveAgentStatus(status: string, enabled: boolean, availability: AgentAvailability): string {
  if (!enabled) return status;
  if (["paused", "working", "thinking", "failed", "completed"].includes(status)) return status;
  if (!availability.available) return "unavailable";
  return status;
}
