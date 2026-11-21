import { all, one } from "./db";
import { gatewayCooldownStatus } from "./providers";
import { providerCooldown } from "./provider-health";

/**
 * Truthful, read-only provider status for the UI.
 *
 * `primary` means FreeLLMAPI is configured and not cooling down. `fallback`
 * means only Ollama is configured. `degraded` means the primary route is
 * cooling/unavailable but the configured local fallback can still answer.
 * `unavailable` means no configured route can currently answer. Nothing here
 * invents availability: values come from configuration, the persisted health
 * table and recorded usage rows.
 */
export type ProviderStatusState = "primary" | "fallback" | "degraded" | "unavailable" | "unconfigured";

export type ProviderRouteStatus = {
  configured: boolean;
  provider: string;
  model: string | null;
  state: "ready" | "cooling" | "error" | "not_configured";
  detail: string;
};

export type ProviderStatusSummary = {
  state: ProviderStatusState;
  label: string;
  detail: string;
  primary: ProviderRouteStatus;
  fallback: ProviderRouteStatus;
  lastFallback: { provider: string; model: string; at: string } | null;
  fallbacksLast24h: number;
  checkedAt: string;
};

function primaryRoute(): ProviderRouteStatus {
  const enabled = (process.env.FREELLMAPI_ENABLED ?? "false") === "true";
  const model = (process.env.FREELLMAPI_MODEL ?? "").trim() || null;
  const configured = enabled && Boolean(model);
  if (!configured) {
    return {
      configured: false,
      provider: "freellmapi",
      model,
      state: "not_configured",
      detail: enabled
        ? "FREELLMAPI_MODEL is not set, so the primary route is incomplete."
        : "FREELLMAPI_ENABLED is not true.",
    };
  }
  const cooldown = providerCooldown("freellmapi", model as string);
  const gateway = gatewayCooldownStatus();
  const remaining = Math.max(cooldown?.remainingMs ?? 0, gateway.remainingMs);
  if (remaining > 0) {
    return {
      configured: true,
      provider: "freellmapi",
      model,
      state: "cooling",
      detail: `Cooling down for ${Math.ceil(remaining / 1000)}s. ${cooldown?.reason ?? gateway.reason ?? ""}`.trim(),
    };
  }
  const row = one<{ status: string; last_error: string | null }>(
    "SELECT status, last_error FROM provider_health WHERE provider = 'freellmapi' AND model = ?",
    [model],
  );
  if (row && (row.status === "configuration_error" || row.status === "authentication_failed")) {
    return {
      configured: true,
      provider: "freellmapi",
      model,
      state: "error",
      detail: `${row.status.replace(/_/g, " ")}. ${row.last_error ?? ""}`.trim(),
    };
  }
  return {
    configured: true,
    provider: "freellmapi",
    model,
    state: "ready",
    detail: "Primary text route configured and not cooling down.",
  };
}

function fallbackRoute(): ProviderRouteStatus {
  const enabled = (process.env.OLLAMA_ENABLED ?? "false") === "true";
  const model = (process.env.OLLAMA_MODEL ?? "").trim() || null;
  const configured = enabled && Boolean(model);
  if (!configured) {
    return {
      configured: false,
      provider: "ollama",
      model,
      state: "not_configured",
      detail: enabled ? "OLLAMA_MODEL is not set." : "OLLAMA_ENABLED is not true.",
    };
  }
  const cooldown = providerCooldown("ollama", model as string);
  if (cooldown?.remainingMs) {
    return {
      configured: true,
      provider: "ollama",
      model,
      state: "cooling",
      detail: `Cooling down for ${Math.ceil(cooldown.remainingMs / 1000)}s. ${cooldown.reason ?? ""}`.trim(),
    };
  }
  const row = one<{ status: string; last_error: string | null }>(
    "SELECT status, last_error FROM provider_health WHERE provider = 'ollama' AND model = ?",
    [model],
  );
  if (row && (row.status === "configuration_error" || row.status === "authentication_failed")) {
    return {
      configured: true,
      provider: "ollama",
      model,
      state: "error",
      detail: `${row.status.replace(/_/g, " ")}. ${row.last_error ?? ""}`.trim(),
    };
  }
  return {
    configured: true,
    provider: "ollama",
    model,
    state: "ready",
    detail: "Local fallback configured. It is used only for permitted recoverable failures.",
  };
}

export function providerStatusSummary(): ProviderStatusSummary {
  const primary = primaryRoute();
  const fallback = fallbackRoute();
  const lastFallbackRow = one<{ provider: string; model: string; created_at: string }>(
    "SELECT provider, model, created_at FROM provider_usage WHERE provider = 'ollama' AND status = 'ok' ORDER BY created_at DESC LIMIT 1",
  );
  const lastFallback = lastFallbackRow
    ? { provider: lastFallbackRow.provider, model: lastFallbackRow.model, at: lastFallbackRow.created_at }
    : null;
  const fallbacksLast24h =
    all<{ provider: string; model: string; created_at: string }>(
      "SELECT provider, model, created_at FROM provider_usage WHERE provider = 'ollama' AND status = 'ok' AND created_at >= datetime('now', '-1 day')",
    ).length;

  let state: ProviderStatusState;
  let label: string;
  let detail: string;
  if (primary.state === "ready") {
    state = "primary";
    label = "Primary provider active";
    detail = `${primary.provider}/${primary.model}. ${fallback.configured ? "Local fallback is ready." : "No local fallback is configured."}`;
  } else if (!primary.configured && fallback.configured) {
    state = "fallback";
    label = "Local fallback only";
    detail = `Primary route not configured. Ollama ${fallback.model} is the configured text route.`;
  } else if ((primary.state === "cooling" || primary.state === "error") && fallback.state === "ready") {
    state = "degraded";
    label = "Provider degraded";
    detail = `Primary route ${primary.state}. Local fallback ${fallback.model} is ready. ${primary.detail}`.trim();
  } else if (!primary.configured && !fallback.configured) {
    state = "unconfigured";
    label = "No text provider configured";
    detail = "Neither FreeLLMAPI nor Ollama is completely configured.";
  } else {
    state = "unavailable";
    label = "All providers unavailable";
    detail = `Primary: ${primary.detail} Fallback: ${fallback.detail}`.trim();
  }

  return {
    state,
    label,
    detail,
    primary,
    fallback,
    lastFallback,
    fallbacksLast24h,
    checkedAt: new Date().toISOString(),
  };
}
