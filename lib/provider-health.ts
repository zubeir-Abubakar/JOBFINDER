import { all, nowIso, one, run } from "./db";

/**
 * Central provider failure classification and cooldowns.
 *
 * This module deliberately knows nothing about HTTP clients. The provider
 * router reports one outcome per real attempt, so a cooldown is applied exactly
 * once and the caller can decide whether to try the next permitted route.
 * Authentication/configuration failures are recorded but never cooled down or
 * retried; quota/rate-limit failures are cooled down immediately and are never
 * hammered with repeated requests.
 */

export type ProviderFailureKind =
  | "quota_exhausted"
  | "rate_limited"
  | "cooldown"
  | "overloaded"
  | "unavailable"
  | "timeout"
  | "authentication"
  | "model_unavailable"
  | "model_policy"
  | "configuration"
  | "unknown";

export type ProviderHealthStatus =
  | "healthy"
  | "cooling"
  | "authentication_failed"
  | "configuration_error"
  | "unavailable"
  | "unknown";

export type ProviderHealthRow = {
  provider: string;
  model: string;
  status: ProviderHealthStatus;
  failure_kind: ProviderFailureKind | null;
  consecutive_failures: number;
  cooldown_until: string | null;
  last_error: string | null;
  last_error_at: string | null;
  last_success_at: string | null;
  updated_at: string;
};

export type ProviderCooldown = {
  provider: string;
  model: string;
  status: ProviderHealthStatus;
  kind: ProviderFailureKind | null;
  remainingMs: number;
  until: string | null;
  reason: string | null;
};

const QUOTA = /quota|resource[_ -]?exhausted|free tier|daily limit|billing|exceeded your current quota/i;
const RATE = /(?:^|\D)429(?:\D|$)|rate[\s-]?limit|too many requests/i;
const COOLDOWN = /cooldown|cooling down|all models exhausted|rate-limited or on cooldown/i;
const OVERLOADED = /overload|server busy|temporarily unavailable|service unavailable|\b529\b|\b503\b/i;
const TIMEOUT = /timed? ?out|timeout|aborted|etimedout/i;
const UNAVAILABLE = /fetch failed|econnrefused|econnreset|enotfound|eai_again|network|socket|http 5\d\d|\b50[024]\b/i;
const AUTH = /unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|permission denied|401|403|invalid_grant|revoked/i;
const MODEL = /model.*(?:not found|not installed|unavailable|does not exist)|no such model|404/i;
// Model-policy refusals are produced locally by the zero-cost gate. They are a
// configuration defect, not a provider outage, so they must never be hidden by
// switching to a local model.
const MODEL_POLICY =
  /not listed in FREELLMAPI_ALLOWED_MODELS|\brefused\b|model policy|not permitted|allowlist|declared alias|pinned id|routing aliases/i;
const CONFIG =
  /invalid request|bad request|malformed|configuration|missing .*configuration|\b400\b|\b422\b/i;

/** Deterministic classification. The most actionable cause wins. */
export function classifyProviderFailure(message: string, status: number | null = null): ProviderFailureKind {
  const text = `${message}${status ? ` HTTP ${status}` : ""}`;
  if (AUTH.test(text)) return "authentication";
  if (MODEL_POLICY.test(text)) return "model_policy";
  if (QUOTA.test(text)) return "quota_exhausted";
  if (RATE.test(text)) return "rate_limited";
  if (COOLDOWN.test(text)) return "cooldown";
  if (MODEL.test(text)) return "model_unavailable";
  if (TIMEOUT.test(text)) return "timeout";
  if (OVERLOADED.test(text) || status === 503 || status === 529) return "overloaded";
  if (UNAVAILABLE.test(text)) return "unavailable";
  if (CONFIG.test(text)) return "configuration";
  return "unknown";
}

/** Only transient transport/overload failures are safe to retry in-process. */
export function isTransientFailure(kind: ProviderFailureKind): boolean {
  return kind === "unavailable" || kind === "timeout" || kind === "overloaded" || kind === "unknown";
}

export function isRouteFailure(kind: ProviderFailureKind): boolean {
  return (
    kind === "quota_exhausted" ||
    kind === "rate_limited" ||
    kind === "cooldown" ||
    kind === "overloaded" ||
    kind === "unavailable" ||
    kind === "timeout" ||
    kind === "model_unavailable"
  );
}

/**
 * Defects in the request, credentials or model policy are terminal for this
 * call. They must never be answered by a different model, because that would
 * hide a real configuration fault behind a successful-looking response.
 */
export function isFailClosedFailure(kind: ProviderFailureKind): boolean {
  return kind === "authentication" || kind === "model_policy" || kind === "configuration";
}

function boundedRetryAfter(retryAfterMs: number | null | undefined): number | null {
  if (!Number.isFinite(retryAfterMs ?? NaN)) return null;
  return Math.max(1_000, Math.min(15 * 60_000, Math.round(retryAfterMs as number)));
}

/** Cooldown chosen by failure type; provider Retry-After always takes priority. */
export function failureCooldownMs(
  kind: ProviderFailureKind,
  retryAfterMs: number | null = null,
  attempt = 1,
): number {
  const retry = boundedRetryAfter(retryAfterMs);
  if (retry) return retry;
  if (kind === "quota_exhausted") return 15 * 60_000;
  if (kind === "rate_limited" || kind === "cooldown") return 60_000;
  if (kind === "overloaded") return 30_000;
  if (kind === "unavailable" || kind === "timeout") {
    return Math.min(5 * 60_000, 15_000 * 2 ** Math.max(0, Math.min(4, attempt - 1)));
  }
  return 0;
}

/** Exponential backoff with bounded jitter for transient in-process retries. */
export function retryDelayMs(attempt: number, kind: ProviderFailureKind, retryAfterMs: number | null = null): number {
  const retry = boundedRetryAfter(retryAfterMs);
  if (retry) return retry;
  const base = Math.min(8_000, 400 * 2 ** Math.max(0, attempt - 1));
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(base * jitter);
}

export function recordProviderSuccess(provider: string, model: string): void {
  const at = nowIso();
  run(
    `INSERT INTO provider_health
       (provider, model, status, failure_kind, consecutive_failures, cooldown_until, last_error, last_error_at, last_success_at, updated_at)
     VALUES (?, ?, 'healthy', NULL, 0, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(provider, model) DO UPDATE SET
       status = 'healthy', failure_kind = NULL, consecutive_failures = 0, cooldown_until = NULL,
       last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
    [provider, model, at, at],
  );
}

export function recordProviderFailure(input: {
  provider: string;
  model: string;
  kind: ProviderFailureKind;
  message: string;
  retryAfterMs?: number | null;
  attempt?: number;
}): ProviderCooldown {
  const current = one<ProviderHealthRow>("SELECT * FROM provider_health WHERE provider = ? AND model = ?", [
    input.provider,
    input.model,
  ]);
  const attempt = Math.max(1, Math.floor(input.attempt ?? (current?.consecutive_failures ?? 0) + 1));
  const cooldownMs = failureCooldownMs(input.kind, input.retryAfterMs ?? null, attempt);
  const until = cooldownMs > 0 ? new Date(Date.now() + cooldownMs).toISOString() : null;
  const status: ProviderHealthStatus =
    input.kind === "authentication"
      ? "authentication_failed"
      : input.kind === "model_policy" || input.kind === "configuration"
        ? "configuration_error"
        : cooldownMs > 0
          ? "cooling"
          : "unavailable";
  const at = nowIso();
  run(
    `INSERT INTO provider_health
       (provider, model, status, failure_kind, consecutive_failures, cooldown_until, last_error, last_error_at, last_success_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(provider, model) DO UPDATE SET
       status = excluded.status, failure_kind = excluded.failure_kind,
       consecutive_failures = provider_health.consecutive_failures + 1,
       cooldown_until = excluded.cooldown_until, last_error = excluded.last_error,
       last_error_at = excluded.last_error_at, updated_at = excluded.updated_at`,
    [input.provider, input.model, status, input.kind, attempt, until, input.message.slice(0, 1200), at, at],
  );
  return {
    provider: input.provider,
    model: input.model,
    status,
    kind: input.kind,
    remainingMs: cooldownMs,
    until,
    reason: input.message.slice(0, 1200),
  };
}

export function clearProviderCooldowns(provider?: string): void {
  if (provider) {
    run("DELETE FROM provider_health WHERE provider = ?", [provider]);
    return;
  }
  run("DELETE FROM provider_health");
}

export function providerCooldown(provider: string, model: string, now = Date.now()): ProviderCooldown | null {
  const row = one<ProviderHealthRow>(
    "SELECT * FROM provider_health WHERE provider = ? AND model = ?",
    [provider, model],
  );
  if (!row) return null;
  const until = row.cooldown_until ? Date.parse(row.cooldown_until) : 0;
  const remaining = Number.isFinite(until) ? Math.max(0, until - now) : 0;
  if (remaining <= 0 && !["authentication_failed", "configuration_error", "unavailable"].includes(row.status)) return null;
  return {
    provider,
    model,
    status: row.status,
    kind: row.failure_kind,
    remainingMs: remaining,
    until: remaining > 0 ? row.cooldown_until : null,
    reason: row.last_error,
  };
}

export function providerHealthSnapshot(now = Date.now()): ProviderCooldown[] {
  const rows = all<ProviderHealthRow>(
    "SELECT * FROM provider_health ORDER BY updated_at DESC",
  );
  return rows
    .map((row) => {
      const until = row.cooldown_until ? Date.parse(row.cooldown_until) : 0;
      const remaining = Number.isFinite(until) ? Math.max(0, until - now) : 0;
      return {
        provider: row.provider,
        model: row.model,
        status: row.status,
        kind: row.failure_kind,
        remainingMs: remaining,
        until: remaining > 0 ? row.cooldown_until : null,
        reason: row.last_error,
      };
    })
    .filter((row) => row.status !== "healthy" || row.remainingMs > 0);
}

export function nextProviderRetryAt(now = Date.now()): string | null {
  const rows = providerHealthSnapshot(now).filter((row) => row.remainingMs > 0 && row.until);
  if (rows.length === 0) return null;
  rows.sort((a, b) => Date.parse(a.until as string) - Date.parse(b.until as string));
  return rows[0]?.until ?? null;
}
