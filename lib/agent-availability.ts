import { one } from "./db";
import { getSetting } from "./settings";
import { freeLlmConfigured, freeLlmPolicyIssue, providerConfigured, providerStatusSnapshot } from "./providers";
import { zeroSpendSummary } from "./ai-spending-policy";

export type AgentAvailability = {
  available: boolean;
  reason: string | null;
  dependency: string | null;
  /** configuration = missing settings; health = configured but unreachable/rejected. */
  cause?: "configuration" | "health" | null;
  /** The agent can do deterministic work, but an optional capability is restricted. */
  restricted?: boolean;
  restriction?: "ai_inference" | "email_access" | null;
};

const AVAILABLE: AgentAvailability = { available: true, reason: null, dependency: null };

/** Deterministic work is available; only the AI-assisted parts are restricted. */
function withAiRestriction(availability: AgentAvailability): AgentAvailability {
  if (!availability.available || providerConfigured()) return availability;
  const policy = freeLlmPolicyIssue();
  return {
    ...availability,
    restricted: true,
    restriction: "ai_inference",
    dependency: "AI inference",
    reason: policy
      ? `No permitted AI model is selected. ${policy} Deterministic work remains available; AI-assisted output is blocked.`
      : `${zeroSpendSummary()} No authorised local AI route is available. Deterministic work remains available; AI-assisted output is marked blocked.`,
  };
}

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
    // The Coordinator's orchestration, discovery, eligibility, scoring and
    // document rules are deterministic. Missing or blocked inference restricts
    // only the AI-assisted parts; it must not take the Coordinator offline or
    // make the whole workforce look unavailable.
    if (!providerConfigured()) {
      const policy = freeLlmPolicyIssue();
      return {
        available: true,
        restricted: true,
        restriction: "ai_inference",
        dependency: "AI inference",
        reason: policy
          ? `No permitted AI model is selected. ${policy} Deterministic coordination remains available; AI-dependent work stays blocked.`
          : freeLlmConfigured()
            ? `${zeroSpendSummary()} External AI is blocked; deterministic coordination remains available. Enable loopback Ollama to restore AI-assisted work.`
            : `${zeroSpendSummary()} No authorised local AI route is configured. Deterministic coordination remains available; AI-dependent work is marked blocked.`,
        cause: "configuration",
      };
    }
    const snapshot = providerStatusSnapshot();
    if (snapshot.available === false) {
      return {
        available: true,
        restricted: true,
        restriction: "ai_inference",
        dependency: "AI inference",
        reason: `AI providers are configured but unavailable: ${snapshot.detail} Deterministic coordination remains available; AI-dependent work stays blocked.`,
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
    // In-app tracking and the execution report remain possible without Gmail.
    // Only mailbox scanning, drafts and approved sending are restricted.
    if (!email.connected) {
      return {
        available: true,
        restricted: true,
        restriction: "email_access",
        dependency: "Gmail OAuth",
        reason:
          "Gmail is not connected. In-app tracking and report preparation remain available; mailbox scanning, recruiter-reply matching and drafts are blocked until Gmail is connected. Notification email is sent by Resend and is unaffected.",
        cause: "configuration",
      };
    }
    const account = one<{ id: number }>("SELECT id FROM gmail_accounts LIMIT 1");
    if (!account || !process.env.APP_SECRET_KEY) {
      return {
        available: true,
        restricted: true,
        restriction: "email_access",
        dependency: account ? "APP_SECRET_KEY" : "Gmail OAuth token",
        reason: account
          ? "APP_SECRET_KEY is not configured, so mailbox access is blocked. In-app tracking and report preparation remain available."
          : "Gmail is marked connected but no stored OAuth account was found. In-app tracking and report preparation remain available; reconnect Gmail to read or send mail.",
        cause: "configuration",
      };
    }
    return AVAILABLE;
  }

  if (key === "analysis" || key === "cv" || key === "ats" || key === "cover") {
    return withAiRestriction(profileReady());
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
