import { all, one } from "./db";
import {
  cachedProviderHealth,
  freeLlmPolicyIssue,
  gatewayCooldownStatus,
  type ProviderHealth,
} from "./providers";
import { providerCooldown } from "./provider-health";
import { evaluateAiPolicy } from "./ai-spending-policy";
import {
  FREE_TIER_STATE_LABEL,
  freeTierStatus,
  freeTierSummary,
  geminiLiveFreeTierStatus,
  type FreeTierState,
  type FreeTierSummary,
  type OllamaFreeStatus,
} from "./free-tier";

/**
 * Truthful, read-only provider status for the UI.
 *
 * A configured route is not the same thing as an available route. Availability
 * comes only from a recent health result. With no health result the route is
 * unknown; with one older than the freshness window it is stale. This module
 * never sends a provider request, so the authenticated status route can refresh
 * cheaply without contacting FreeLLMAPI or Ollama.
 */
export const PROVIDER_STATUS_FRESHNESS_MS = 5 * 60_000;

export type ProviderStatusState =
  | "primary"
  | "fallback"
  | "degraded"
  | "unavailable"
  | "unconfigured"
  | "unknown";

export type ProviderAvailability =
  | "available"
  | "unavailable"
  | "unknown"
  | "stale"
  | "not_configured";

export type ProviderRouteState =
  | "healthy"
  | "cooling"
  | "error"
  | "unavailable"
  | "unknown"
  | "stale"
  | "not_configured";

export type ProviderRouteStatus = {
  enabled: boolean;
  configured: boolean;
  provider: string;
  model: string | null;
  state: ProviderRouteState;
  availability: ProviderAvailability;
  statusLabel: string;
  detail: string;
  checkedAt: string | null;
  policyBlocked?: boolean;
  executionType?: "local" | "verified_free_external" | "owner_authorised_external" | "blocked";
  freeTierState?: FreeTierState;
};

export type GeminiLiveStatus = {
  configured: boolean;
  authorised: boolean;
  model: string;
  freeTierState: FreeTierState;
  statusLabel: string;
  detail: string;
  lastSessionAt: string | null;
};

export type ProviderBillingStatus = {
  provider: "gemini";
  authority: "owner_authorised" | "zero_spend";
  currency: "CHF";
  maximumAuthorisedExternalSpendChf: number | null;
  actualSpend: "not_reported";
  costStatus: "unverified";
  detail: string;
};

export type ProviderStatusSummary = {
  state: ProviderStatusState;
  label: string;
  detail: string;
  primary: ProviderRouteStatus;
  fallback: ProviderRouteStatus;
  gemini: ProviderRouteStatus;
  geminiLive: GeminiLiveStatus;
  billing: ProviderBillingStatus;
  lastFallback: { provider: string; model: string; at: string; fallbackFrom: string | null; fallbackReason: string | null } | null;
  fallbacksLast24h: number;
  checkedAt: string;
  maximumAuthorisedExternalSpendChf: number | null;
  externalInference: "free_tier_first" | "blocked";
  freeTier: FreeTierSummary;
  ollamaLocal: OllamaFreeStatus;
};

export type ProviderStatusOptions = {
  /** Latest health readings. Omit to use the cached/persisted result. */
  health?: ProviderHealth[] | null;
  /** Injectable clock for deterministic freshness tests. */
  now?: number;
};

type HealthReading = {
  availability: ProviderAvailability;
  state: ProviderRouteState;
  statusLabel: string;
  checkedAt: string | null;
  reading: ProviderHealth | null;
};

function endpointHost(raw: string, fallback: string): string {
  try {
    const url = new URL(raw);
    return url.host || fallback;
  } catch {
    return fallback;
  }
}

function latestHealth(health: ProviderHealth[] | null | undefined, name: string): ProviderHealth | null {
  return health?.find((item) => item.name === name) ?? null;
}

function healthReading(reading: ProviderHealth | null, now: number): HealthReading {
  if (!reading || !reading.checkedAt) {
    return {
      availability: "unknown",
      state: "unknown",
      statusLabel: "Availability unknown",
      checkedAt: reading?.checkedAt ?? null,
      reading,
    };
  }
  const checkedAt = Date.parse(reading.checkedAt);
  if (!Number.isFinite(checkedAt)) {
    return {
      availability: "unknown",
      state: "unknown",
      statusLabel: "Availability unknown",
      checkedAt: reading.checkedAt,
      reading,
    };
  }
  if (now - checkedAt > PROVIDER_STATUS_FRESHNESS_MS) {
    return {
      availability: "stale",
      state: "stale",
      statusLabel: "Last health result is stale",
      checkedAt: reading.checkedAt,
      reading,
    };
  }
  if (reading.available) {
    return {
      availability: "available",
      state: "healthy",
      statusLabel: "Healthy",
      checkedAt: reading.checkedAt,
      reading,
    };
  }
  return {
    availability: "unavailable",
    state: "unavailable",
    statusLabel: "Configured but unavailable",
    checkedAt: reading.checkedAt,
    reading,
  };
}

function unreachable(detail: string | null | undefined): boolean {
  return Boolean(detail && /unreachable|fetch failed|econnrefused|econnreset|enotfound|eai_again|network|socket/i.test(detail));
}

function geminiRoute(health: ProviderHealth[], now: number): ProviderRouteStatus {
  const enabled = Boolean(process.env.GEMINI_API_KEY?.trim());
  const model = (process.env.GEMINI_MODEL ?? "gemini-3.6-flash").trim() || null;
  const decision = evaluateAiPolicy({ provider: "gemini", model });
  const tier = freeTierStatus("gemini", now);
  if (!enabled) {
    return {
      enabled: false,
      configured: false,
      provider: "gemini",
      model,
      state: "not_configured",
      availability: "not_configured",
      statusLabel: "Not configured",
      detail: "GEMINI_API_KEY is not set. No Gemini request is made.",
      checkedAt: null,
      freeTierState: tier.state,
    };
  }
  if (!decision.allowed) {
    return {
      enabled: true,
      configured: true,
      provider: "gemini",
      model,
      state: tier.state === "exhausted" || tier.state === "blocked" ? "unavailable" : "error",
      availability: "not_configured",
      statusLabel: FREE_TIER_STATE_LABEL[tier.state],
      detail: tier.detail,
      checkedAt: null,
      policyBlocked: true,
      executionType: "blocked",
      freeTierState: tier.state,
    };
  }
  const last = one<{ id: number; status: string; model: string; created_at: string; error: string | null }>(
    "SELECT id, status, model, created_at, error FROM provider_usage WHERE provider = 'gemini' ORDER BY id DESC LIMIT 1",
  );
  const success = one<{ id: number; model: string; created_at: string }>(
    "SELECT id, model, created_at FROM provider_usage WHERE provider = 'gemini' AND status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  if (last?.status === "error" && (!success || Number(last.id) > Number(success.id))) {
    return {
      enabled: true,
      configured: true,
      provider: "gemini",
      model: last.model || model,
      state: "error",
      availability: "unavailable",
      statusLabel: "Latest Gemini call failed",
      detail: `Gemini ${last.model || model} failed at ${last.created_at}: ${last.error ?? "unknown error"}. Recoverable route failures may use the verified FreeLLMAPI free tier or loopback Ollama; authentication, configuration and paid-model failures fail closed.`,
      checkedAt: last.created_at,
      policyBlocked: false,
      executionType: "verified_free_external",
      freeTierState: tier.state,
    };
  }
  if (success) {
    return {
      enabled: true,
      configured: true,
      provider: "gemini",
      model: success.model || model,
      state: "healthy",
      availability: "available",
      statusLabel: FREE_TIER_STATE_LABEL[tier.state],
      detail: `Last Gemini inference succeeded with ${success.model || model} at ${success.created_at} on the declared free tier. Exhaustion pauses the route and is never converted to a paid request.`,
      checkedAt: success.created_at,
      policyBlocked: false,
      executionType: "verified_free_external",
      freeTierState: tier.state,
    };
  }
  return {
    enabled: true,
    configured: true,
    provider: "gemini",
    model,
    state: "unknown",
    availability: "unknown",
    statusLabel: "Gemini free tier configured · awaiting first call",
    detail: `${model} is declared free-tier (${FREE_TIER_STATE_LABEL[tier.state]}). No successful Gemini inference has been recorded yet; availability is not claimed from configuration alone.`,
    checkedAt: null,
    policyBlocked: false,
    executionType: "verified_free_external",
    freeTierState: tier.state,
  };
}


function primaryRoute(health: ProviderHealth[], now: number): ProviderRouteStatus {
  if ((process.env.AI_PRIMARY_PROVIDER ?? "freellmapi").trim().toLowerCase() === "gemini") {
    return geminiRoute(health, now);
  }
  const enabled = (process.env.FREELLMAPI_ENABLED ?? "false") === "true";
  const base = (process.env.FREELLMAPI_BASE_URL ?? "").trim();
  const key = (process.env.FREELLMAPI_API_KEY ?? "").trim();
  const model = (process.env.FREELLMAPI_MODEL ?? "").trim() || null;
  const configured = enabled && Boolean(base) && Boolean(key) && Boolean(model);

  if (!enabled) {
    return {
      enabled,
      configured: false,
      provider: "freellmapi",
      model,
      state: "not_configured",
      availability: "not_configured",
      statusLabel: "Not configured",
      detail: "FREELLMAPI_ENABLED is not true.",
      checkedAt: null,
    };
  }
  if (!configured) {
    return {
      enabled,
      configured: false,
      provider: "freellmapi",
      model,
      state: "not_configured",
      availability: "not_configured",
      statusLabel: "Not configured",
      detail: "FreeLLMAPI configuration is incomplete. This is a configuration gap, not a service outage.",
      checkedAt: null,
    };
  }

  const tier = freeTierStatus("freellmapi", now);
  const policyIssue = freeLlmPolicyIssue();
  if (policyIssue) {
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: "error",
      availability: "not_configured",
      statusLabel: "Configuration error",
      detail: policyIssue,
      checkedAt: null,
      freeTierState: tier.state,
    };
  }

  const external = evaluateAiPolicy({ provider: "freellmapi", model });
  if (!external.allowed) {
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: tier.state === "exhausted" || tier.state === "blocked" ? "unavailable" : "error",
      availability: "not_configured",
      statusLabel: FREE_TIER_STATE_LABEL[tier.state],
      detail: tier.detail,
      checkedAt: null,
      policyBlocked: true,
      executionType: "blocked",
      freeTierState: tier.state,
    };
  }

  const cooldown = providerCooldown("freellmapi", model as string);
  const gateway = gatewayCooldownStatus();
  const remaining = Math.max(cooldown?.remainingMs ?? 0, gateway.remainingMs);
  if (remaining > 0) {
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: "cooling",
      availability: "unavailable",
      statusLabel: "Cooling down",
      detail: `Cooling down for ${Math.ceil(remaining / 1000)}s. ${cooldown?.reason ?? gateway.reason ?? ""}`.trim(),
      checkedAt: null,
    };
  }

  const result = healthReading(latestHealth(health, "freellmapi"), now);
  if (result.availability === "available") {
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: "healthy",
      availability: "available",
      executionType: "verified_free_external",
      statusLabel: "FREE TIER AVAILABLE",
      detail: result.reading?.detail ?? `FreeLLMAPI ${model} is declared free-tier and its gateway health check passed.`,
      checkedAt: result.checkedAt,
      freeTierState: tier.state,
    };
  }
  if (result.availability === "unavailable") {
    const host = endpointHost(base, "the configured gateway");
    const detail = unreachable(result.reading?.detail)
      ? `FreeLLMAPI is configured, but its gateway is currently unreachable at ${host}.`
      : `FreeLLMAPI is configured, but its latest health check failed: ${result.reading?.detail ?? "unknown failure"}`;
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: "unavailable",
      availability: "unavailable",
      statusLabel: "Configured but unavailable",
      detail,
      checkedAt: result.checkedAt,
      freeTierState: tier.state,
    };
  }
  if (result.availability === "stale") {
    return {
      enabled,
      configured: true,
      provider: "freellmapi",
      model,
      state: "stale",
      availability: "stale",
      statusLabel: "Last health result is stale",
      detail: `FreeLLMAPI is configured, but its last health result is stale (checked ${result.checkedAt}). Availability is unknown.`,
      checkedAt: result.checkedAt,
      freeTierState: tier.state,
    };
  }
  return {
    enabled,
    configured: true,
    provider: "freellmapi",
    model,
    state: "unknown",
    availability: "unknown",
    statusLabel: `Free tier ${FREE_TIER_STATE_LABEL[tier.state]} · availability unknown`,
    detail: "FreeLLMAPI is configured, but its availability is unknown. No health check has been recorded.",
    checkedAt: result.checkedAt,
    freeTierState: tier.state,
  };
}

function fallbackRoute(health: ProviderHealth[], now: number): ProviderRouteStatus {
  const enabled = (process.env.OLLAMA_ENABLED ?? "false") === "true";
  const base = (process.env.OLLAMA_BASE_URL ?? "").trim();
  const model = (process.env.OLLAMA_MODEL ?? "").trim() || null;
  const coderModel = (process.env.OLLAMA_CODER_MODEL ?? "").trim() || null;
  const configured = enabled && Boolean(base) && Boolean(model) && Boolean(coderModel);

  if (!enabled) {
    return {
      enabled,
      configured: false,
      provider: "ollama",
      model,
      state: "not_configured",
      availability: "not_configured",
      statusLabel: "Not configured",
      detail: "OLLAMA_ENABLED is not true.",
      checkedAt: null,
    };
  }
  if (!configured) {
    const missing = [
      base ? null : "OLLAMA_BASE_URL",
      model ? null : "OLLAMA_MODEL",
      coderModel ? null : "OLLAMA_CODER_MODEL",
    ].filter(Boolean);
    return {
      enabled,
      configured: false,
      provider: "ollama",
      model,
      state: "not_configured",
      availability: "not_configured",
      statusLabel: "Not configured",
      detail: `Ollama is enabled but incomplete: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set. This is a configuration gap, not a service outage.`,
      checkedAt: null,
    };
  }

  const local = evaluateAiPolicy({ provider: "ollama", model });
  if (!local.allowed) {
    return {
      enabled,
      configured: true,
      provider: "ollama",
      model,
      state: "error",
      availability: "not_configured",
      statusLabel: "Blocked by zero-spend policy",
      detail: local.block_reason ?? "This Ollama endpoint cannot be verified as local inference.",
      checkedAt: null,
      policyBlocked: true,
      executionType: "blocked",
    };
  }

  const cooldown = providerCooldown("ollama", model as string);
  if (cooldown?.remainingMs) {
    return {
      enabled,
      configured: true,
      provider: "ollama",
      model,
      state: "cooling",
      availability: "unavailable",
      executionType: "local",
      statusLabel: "Cooling down",
      detail: `Cooling down for ${Math.ceil(cooldown.remainingMs / 1000)}s. ${cooldown.reason ?? ""}`.trim(),
      checkedAt: null,
    };
  }

  const result = healthReading(latestHealth(health, "ollama"), now);
  if (result.availability === "available") {
    return {
      enabled,
      configured: true,
      provider: "ollama",
      model,
      state: "healthy",
      availability: "available",
      executionType: "local",
      statusLabel: "Healthy",
      detail: result.reading?.detail ?? "Ollama health check passed.",
      checkedAt: result.checkedAt,
    };
  }
  if (result.availability === "unavailable") {
    const host = endpointHost(base, "localhost:11434");
    const detail = unreachable(result.reading?.detail)
      ? `Ollama is configured as the local fallback, but its service is currently unreachable at ${host}.`
      : `Ollama is configured as the local fallback, but its latest health check failed: ${result.reading?.detail ?? "unknown failure"}`;
    return {
      enabled,
      configured: true,
      provider: "ollama",
      model,
      state: "unavailable",
      availability: "unavailable",
      executionType: "local",
      statusLabel: "Configured but unavailable",
      detail,
      checkedAt: result.checkedAt,
    };
  }
  if (result.availability === "stale") {
    return {
      enabled,
      configured: true,
      provider: "ollama",
      model,
      state: "stale",
      availability: "stale",
      executionType: "local",
      statusLabel: "Last health result is stale",
      detail: `Ollama is configured as the local fallback. Last health result is stale (checked ${result.checkedAt}). Availability is unknown.`,
      checkedAt: result.checkedAt,
    };
  }
  return {
    enabled,
    configured: true,
    provider: "ollama",
    model,
    state: "unknown",
    availability: "unknown",
    executionType: "local",
    statusLabel: "Availability unknown",
    detail: "Ollama is configured as the local fallback, but availability is unknown. No health check has been recorded.",
    checkedAt: result.checkedAt,
  };
}

function summarize(primary: ProviderRouteStatus, fallback: ProviderRouteStatus): { state: ProviderStatusState; label: string; detail: string } {
  if (primary.provider === "gemini") {
    if (!primary.configured) {
      return { state: "unconfigured", label: "Gemini not configured", detail: primary.detail };
    }
    if (primary.availability === "available") {
      return fallback.availability === "available"
        ? { state: "primary", label: "Gemini free tier · local fallback ready", detail: `${primary.detail} ${fallback.detail}`.trim() }
        : { state: "primary", label: "Gemini free tier available", detail: primary.detail };
    }
    if (fallback.availability === "available") {
      return {
        state: "degraded",
        label: "Gemini degraded · local fallback ready",
        detail: `${primary.detail} ${fallback.detail}`.trim(),
      };
    }
    if (primary.availability === "unknown") {
      return { state: "unknown", label: "Gemini configured · awaiting first call", detail: primary.detail };
    }
    return { state: "unavailable", label: "Gemini unavailable", detail: primary.detail };
  }
  if (primary.policyBlocked) {
    if (fallback.availability === "available") {
      return {
        state: "fallback",
        label: "Local inference only",
        detail: `${primary.detail} Loopback Ollama is available and is the only authorised route.`,
      };
    }
    return {
      state: "unavailable",
      label: "No authorised inference route",
      detail: `${primary.detail} ${fallback.detail}`.trim(),
    };
  }

  if (!primary.configured && !fallback.configured) {
    return {
      state: "unconfigured",
      label: "No text provider configured",
      detail: "Neither FreeLLMAPI nor Ollama is completely configured. This is a configuration gap, not a service outage.",
    };
  }

  if (primary.availability === "available") {
    if (fallback.availability === "available") {
      return {
        state: "primary",
        label: "Primary provider active",
        detail: `FreeLLMAPI is healthy. Ollama is available as the local fallback.`,
      };
    }
    if (fallback.state === "cooling") {
      return {
        state: "primary",
        label: "Primary healthy · fallback cooling",
        detail: `FreeLLMAPI is healthy. ${fallback.detail}`,
      };
    }
    if (fallback.availability === "unavailable") {
      return {
        state: "primary",
        label: "Primary healthy · fallback unavailable",
        detail: `FreeLLMAPI is healthy. ${fallback.detail} Normal AI inference can continue through FreeLLMAPI while the local fallback is offline.`,
      };
    }
    if (fallback.availability === "stale") {
      return {
        state: "primary",
        label: "Primary healthy · fallback stale",
        detail: `FreeLLMAPI is healthy. ${fallback.detail}`,
      };
    }
    if (fallback.availability === "unknown") {
      return {
        state: "primary",
        label: "Primary healthy · fallback unknown",
        detail: `FreeLLMAPI is healthy. ${fallback.detail}`,
      };
    }
    return {
      state: "primary",
      label: "Primary provider active",
      detail: `FreeLLMAPI is healthy. No local fallback is configured.`,
    };
  }

  if (fallback.availability === "available") {
    if (!primary.configured) {
      return {
        state: "fallback",
        label: "Local fallback only",
        detail: `FreeLLMAPI is not configured. Ollama is available as the local text fallback.`,
      };
    }
    return {
      state: "degraded",
      label: "Provider degraded",
      detail: `FreeLLMAPI is ${primary.statusLabel.toLowerCase()}. Ollama is available as the local fallback. ${primary.detail}`.trim(),
    };
  }

  if (primary.availability === "unavailable" && fallback.availability === "unavailable") {
    return {
      state: "unavailable",
      label: "All providers unavailable",
      detail: `Primary: ${primary.detail} Fallback: ${fallback.detail}`,
    };
  }

  if (!primary.configured && fallback.availability === "unavailable") {
    return {
      state: "unavailable",
      label: "Local fallback configured but unavailable",
      detail: `${primary.detail} ${fallback.detail}`.trim(),
    };
  }

  if (primary.availability === "unavailable") {
    return {
      state: "unavailable",
      label: `Primary unavailable · fallback ${fallback.statusLabel.toLowerCase()}`,
      detail: `Primary: ${primary.detail} Fallback: ${fallback.detail}`,
    };
  }

  if (fallback.availability === "unavailable") {
    return {
      state: "unknown",
      label: `Primary ${primary.statusLabel.toLowerCase()} · fallback unavailable`,
      detail: `Primary: ${primary.detail} Fallback: ${fallback.detail}`,
    };
  }

  if (primary.state === "error" || primary.state === "cooling") {
    return {
      state: "unavailable",
      label: `Primary ${primary.statusLabel.toLowerCase()} · fallback ${fallback.statusLabel.toLowerCase()}`,
      detail: `Primary: ${primary.detail} Fallback: ${fallback.detail}`,
    };
  }

  return {
    state: "unknown",
    label: primary.availability === "stale" || fallback.availability === "stale"
      ? "Provider health is stale"
      : "Provider availability unknown",
    detail: `Primary: ${primary.detail} Fallback: ${fallback.detail}`,
  };
}

export function providerStatusSummary(options: ProviderStatusOptions = {}): ProviderStatusSummary {
  const now = options.now ?? Date.now();
  const health = options.health !== undefined ? options.health : cachedProviderHealth()?.items ?? null;
  const primary = primaryRoute(health ?? [], now);
  const fallback = fallbackRoute(health ?? [], now);
  const lastFallbackRow = one<{
    provider: string;
    model: string;
    created_at: string;
    fallback_from: string | null;
    fallback_reason: string | null;
  }>(
    "SELECT provider, model, created_at, fallback_from, fallback_reason FROM provider_usage WHERE provider = 'ollama' AND status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  const lastFallback = lastFallbackRow
    ? {
        provider: lastFallbackRow.provider,
        model: lastFallbackRow.model,
        at: lastFallbackRow.created_at,
        fallbackFrom: lastFallbackRow.fallback_from,
        fallbackReason: lastFallbackRow.fallback_reason,
      }
    : null;
  const fallbacksLast24h =
    all<{ provider: string; model: string; created_at: string }>(
      "SELECT provider, model, created_at FROM provider_usage WHERE provider = 'ollama' AND status = 'ok' AND created_at >= datetime('now', '-1 day')",
    ).length;
  const overall = summarize(primary, fallback);
  const gemini = geminiRoute(health ?? [], now);
  const tiers = freeTierSummary(now);
  const anyFreeTierAvailable = tiers.gemini.allowed || tiers.freellmapi.allowed;
  const liveModel = (process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live").trim() || "gemini-3.8-live";
  const liveDecision = evaluateAiPolicy({ provider: "gemini-live", model: liveModel }, now);
  const liveStatus = geminiLiveFreeTierStatus(now);
  const lastLive = one<{ created_at: string }>(
    "SELECT created_at FROM provider_usage WHERE provider = 'gemini-live' ORDER BY id DESC LIMIT 1",
  );

  return {
    ...overall,
    primary,
    fallback,
    gemini,
    geminiLive: {
      configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      authorised: liveDecision.allowed,
      model: liveModel,
      freeTierState: liveStatus.state,
      statusLabel: liveDecision.allowed
        ? `${FREE_TIER_STATE_LABEL[liveStatus.state]} · Charon`
        : FREE_TIER_STATE_LABEL[liveStatus.state],
      detail: liveDecision.allowed
        ? `Gemini Live ${liveModel} is declared free-tier and has a published free-tier price. Chief speaks as Charon; no paid voice fallback or voice substitution exists. Google exposes no machine-readable free-tier attestation, so this is a declared gate plus a model check.`
        : liveDecision.block_reason ?? liveStatus.detail,
      lastSessionAt: lastLive?.created_at ?? null,
    },
    billing: {
      provider: "gemini",
      authority: "zero_spend",
      currency: "CHF",
      maximumAuthorisedExternalSpendChf: 0,
      actualSpend: "not_reported",
      costStatus: "unverified",
      detail: anyFreeTierAvailable
        ? "Only verified free-tier capacity is used. The external spend limit remains CHF 0.00 and no paid model, endpoint or fallback is permitted."
        : "No verified free-tier provider is available. External spend is CHF 0.00; only loopback Ollama may serve inference.",
    },
    lastFallback,
    fallbacksLast24h,
    checkedAt: new Date(now).toISOString(),
    maximumAuthorisedExternalSpendChf: 0,
    externalInference: anyFreeTierAvailable ? "free_tier_first" : "blocked",
    freeTier: tiers,
    ollamaLocal: tiers.ollama,
  };
}
