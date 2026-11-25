import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { all, nowIso, one, run } from "./db.ts";
import { getSetting, setSetting } from "./settings";
import { notify } from "./notify";
import {
  AiSpendingPolicyError,
  authorizeAiRequest,
  evaluateAiPolicy,
  markPolicyNetworkTransmitted,
  type AiPolicyDecision,
} from "./ai-spending-policy";
import {
  FREE_TIER_STATE_LABEL,
  freeTierStatus,
  recordFreeTierFailure,
  recordFreeTierSuccess,
  type FreeTierState,
} from "./free-tier";
import { agentRoutePreference, freeTierRouteOrder } from "./agent-models";
import {
  OpenRouterRequestError,
  checkOpenRouterCredential,
  openRouterStatus,
  openRouterTextConfig,
  validateOpenRouterFreeModel,
} from "./openrouter";
import { clearProviderCooldowns,
  classifyProviderFailure,
  isFailClosedFailure,
  isRouteFailure,
  isTransientFailure,
  providerCooldown,
  recordProviderFailure as recordRouteFailure,
  recordProviderSuccess,
  retryDelayMs,
  type ProviderFailureKind,
} from "./provider-health";

/**
 * Shared AI provider service.
 *
 * FreeLLMAPI (local OpenAI-compatible gateway) and Gemini are the default
 * free-tier text paths. OpenRouter is an additional opt-in route: it accepts
 * only one exact catalogue-verified `:free` model, checks the authenticated key
 * and zero pricing before transmission, and never falls through to Ollama when
 * an agent is explicitly assigned to it. When a default route is configured, a
 * recoverable failure can fall back to the other verified free tier or an
 * explicitly enabled local Ollama instance. Non-recoverable
 * request/configuration/auth failures fail closed. Gemini Live is a separate
 * voice path.
 *
 * A successful primary call clears the gateway cooldown, so the next request
 * returns to FreeLLMAPI automatically. A fallback result is never cached as a
 * permanent provider preference.
 *
 * Secrets are read from the environment on the server and never returned to the
 * client. Error messages are scrubbed before they are stored or shown.
 */

export type ProviderName = "freellmapi" | "gemini" | "openrouter" | "ollama";

export type ProviderHealth = {
  name: ProviderName;
  label: string;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  model: string;
  models: string[];
  detail: string;
  latencyMs: number | null;
  /** When this health result was produced. */
  checkedAt?: string | null;
  /** True when metadata is reachable but inference is blocked by policy. */
  policyBlocked?: boolean;
  executionType?: "local" | "verified_free_external" | "owner_authorised_external" | "blocked";
  policyReason?: string | null;
  /** Free-tier state for the external providers; absent for OpenRouter. */
  freeTierState?: FreeTierState;
  /** Separate speech diagnostics; a text provider can be healthy while TTS is retired. */
  tts?: {
    enabled: boolean;
    model: string;
    voice: string;
    provider: string;
    expiresAt: string | null;
    valid: boolean;
    detail: string;
  };
};

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

/**
 * Cost is deliberately not asserted as zero. FreeLLMAPI publishes no pricing
 * metadata, so every figure recorded here is an unverified estimate placeholder
 * (cost_chf stays 0 for schema compatibility, cost_status marks it unverified).
 */
export type CostStatus = "unverified";
export type RoutedVia = { platform: string | null; model: string | null } | null;

/**
 * Where an inference call came from. Only `task` calls update the agent task
 * counters; `assistant`, `admin_test` and `manual` calls are recorded so they
 * are visible in usage without being mistaken for workflow executions.
 */
export type AiCallSource = "task" | "assistant" | "admin_test" | "manual" | "legacy";

/** 0 = interactive, 1 = workflow, 2 = advisory queue. */
export type AiPriority = 0 | 1 | 2;

export type ProviderDiagnostics = {
  requestId: string;
  provider: ProviderName | null;
  model: string | null;
  httpStatus: number | null;
  durationMs: number;
  errorClass: string | null;
  retryCount: number;
  fallbackDecision: "primary" | "gemini" | "freellmapi" | "openrouter" | "ollama" | "none";
  /** Provider that failed before a local fallback was selected. */
  fallbackFrom?: ProviderName | null;
  /** Credential-free reason the fallback was selected. */
  fallbackReason?: string | null;
  usableContent: boolean;
};

export type GenerateResult = {
  text: string;
  provider: ProviderName;
  model: string;
  usage: Usage;
  /** provider = reported by the API; estimated = local character heuristic. */
  usageSource: "provider" | "estimated";
  cachedTokens: number;
  latencyMs: number;
  costChf: null;
  costStatus: CostStatus;
  routedVia: RoutedVia;
  /** Safe, credential-free request evidence for persisted task diagnostics. */
  diagnostics?: ProviderDiagnostics;
};

export type GenerateInput = {
  agentKey: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  technical?: boolean;
  /** Ask a capable provider for a JSON object; fallback uses Ollama JSON mode. */
  format?: "json";
  workflowId?: string | null;
  /** The task that caused this call. Required for source="task". */
  taskId?: string | null;
  /** Conversational session that caused this call, when applicable. */
  sessionId?: string | null;
  source?: Exclude<AiCallSource, "legacy">;
  priority?: AiPriority;
  maxWaitMs?: number;
  /** Optional streaming callback. A partial provider answer must not be retried. */
  onDelta?: (delta: string) => void;
};

export class ProvidersUnavailableError extends Error {
  constructor(message = "No AI provider is available. The workflow was paused instead of guessing.") {
    super(message);
    this.name = "ProvidersUnavailableError";
  }
}

/** Raised for HTTP 429 and gateway cooldown/exhaustion responses. */
export class AiRateLimitedError extends Error {
  retryAfterMs: number;
  status: number | null;
  constructor(message: string, retryAfterMs: number, status: number | null = null) {
    super(message);
    this.name = "AiRateLimitedError";
    this.retryAfterMs = retryAfterMs;
    this.status = status;
  }
}

/** A provider response that can safely be retried on another provider. */
export class AiProviderError extends Error {
  provider: ProviderName;
  recoverable: boolean;
  status: number | null;
  constructor(provider: ProviderName, message: string, recoverable: boolean, status: number | null = null) {
    super(message);
    this.name = "AiProviderError";
    this.provider = provider;
    this.recoverable = recoverable;
    this.status = status;
  }
}

/** Invalid credentials, malformed requests or missing local configuration. */
export class AiProviderConfigError extends AiProviderError {
  constructor(provider: ProviderName, message: string) {
    super(provider, message, false, null);
    this.name = "AiProviderConfigError";
  }
}

export function diagnosticsFromError(error: unknown): ProviderDiagnostics | null {
  if (!error || typeof error !== "object") return null;
  const diagnostics = (error as { diagnostics?: unknown }).diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return null;
  return diagnostics as ProviderDiagnostics;
}

export function isTemporaryAiError(error: unknown): boolean {
  return (
    error instanceof AiRateLimitedError ||
    error instanceof ProvidersUnavailableError ||
    (error instanceof AiProviderError && error.recoverable) ||
    (error instanceof Error && isRateLimitMessage(error.message))
  );
}

/** Network, timeout and 5xx-style failures are safe to retry elsewhere. */
export function isRecoverableProviderError(error: unknown): boolean {
  if (error instanceof AiRateLimitedError) return true;
  if (error instanceof AiProviderError) return error.recoverable;
  if (error instanceof ProvidersUnavailableError) return true;
  if (!(error instanceof Error)) return false;
  return /fetch failed|econnrefused|econnreset|enotfound|eai_again|etimedout|network|socket|timed? ?out|timeout|aborted|http 5\d\d|\b50[234]\b/i.test(
    error.message,
  );
}

const HEALTH_TTL_MS = 30_000;
const HEALTH_SNAPSHOT_KEY = "ai_provider_health_snapshot";
type Cache = { at: number; items: ProviderHealth[] };
export type CachedProviderHealth = { checkedAt: string; items: ProviderHealth[] };
type AiSlotWaiter = { priority: number; queuedAt: number; grant: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type AiSlotState = { active: number; waiters: AiSlotWaiter[] };
const g = globalThis as typeof globalThis & {
  __atwProviderHealth?: Cache;
  __atwGatewayCooldown?: { until: number; reason: string | null };
  __atwAiSlots?: AiSlotState;
};

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function config() {
  const env = process.env;
  return {
    budgetChf: Number(env.AI_BUDGET_LIMIT_CHF ?? "0") || 0,
    maxRetries: (() => {
      const parsed = Number(env.AI_MAX_RETRIES ?? "2");
      return Number.isFinite(parsed) ? Math.max(0, Math.min(4, parsed)) : 2;
    })(),
    primary: (env.AI_PRIMARY_PROVIDER ?? "freellmapi").trim().toLowerCase(),
    freellmapi: {
      enabled: (env.FREELLMAPI_ENABLED ?? "false") === "true",
      key: env.FREELLMAPI_API_KEY ?? "",
      base: (env.FREELLMAPI_BASE_URL ?? "http://127.0.0.1:31415/v1").trim().replace(/\/+$/, ""),
      model: (env.FREELLMAPI_MODEL ?? "").trim(),
      allowed: csv(env.FREELLMAPI_ALLOWED_MODELS),
      aliases: csv(env.FREELLMAPI_MODEL_ALIASES),
    },
    gemini: {
      enabled: Boolean(env.GEMINI_API_KEY),
      key: env.GEMINI_API_KEY ?? "",
      model: (env.GEMINI_MODEL ?? "gemini-3.6-flash").trim(),
      base: "https://generativelanguage.googleapis.com/v1beta",
    },
    openrouter: {
      enabled: (env.OPENROUTER_ENABLED ?? "false") === "true",
      key: env.OPENROUTER_API_KEY ?? "",
      base: (env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").trim().replace(/\/+$/, ""),
      model: (env.OPENROUTER_MODEL ?? "").trim(),
      assignedAgents: csv(env.OPENROUTER_ASSIGNED_AGENTS),
      allowPaid: (env.OPENROUTER_ALLOW_PAID_MODELS ?? "false") === "true",
    },
    ollama: {
      enabled: (env.OLLAMA_ENABLED ?? "false") === "true",
      base: (env.OLLAMA_BASE_URL ?? "http://localhost:11434").trim().replace(/\/+$/, ""),
      model: (env.OLLAMA_MODEL ?? "").trim(),
      coderModel: (env.OLLAMA_CODER_MODEL ?? "").trim(),
      timeoutMs: Math.max(5_000, Math.min(180_000, Number(env.OLLAMA_TIMEOUT_MS ?? "60000") || 60_000)),
    },
  };
}

export function aiMaxConcurrency(): number {
  const parsed = Number(process.env.AI_MAX_CONCURRENCY ?? "1");
  return Number.isFinite(parsed) ? Math.max(1, Math.min(4, Math.floor(parsed))) : 1;
}

const COOLDOWN_KEY = "ai_gateway_cooldown";

type CooldownState = { until: number; reason: string | null };

function cooldownState(): CooldownState {
  if (!g.__atwGatewayCooldown) {
    const saved = getSetting<{ until?: string | null; reason?: string | null }>(COOLDOWN_KEY, {});
    const until = saved.until ? Date.parse(saved.until) : 0;
    g.__atwGatewayCooldown = { until: Number.isFinite(until) ? until : 0, reason: saved.reason ?? null };
  }
  return g.__atwGatewayCooldown as CooldownState;
}

export type GatewayCooldownStatus = { until: string | null; remainingMs: number; reason: string | null };

export function gatewayCooldownStatus(): GatewayCooldownStatus {
  const state = cooldownState();
  const remaining = Math.max(0, state.until - Date.now());
  return {
    until: remaining > 0 ? new Date(state.until).toISOString() : null,
    remainingMs: remaining,
    reason: state.reason,
  };
}

export function setGatewayCooldown(retryAfterMs: number, reason: string): GatewayCooldownStatus {
  const bounded = Math.max(1000, Math.min(15 * 60_000, Math.round(retryAfterMs)));
  const until = Date.now() + bounded;
  const message = scrub(reason);
  g.__atwGatewayCooldown = { until, reason: message };
  try {
    setSetting(COOLDOWN_KEY, { until: new Date(until).toISOString(), reason: message, updated_at: nowIso() });
  } catch {
    // A settings write failure must not prevent the in-memory cooldown from holding.
  }
  return gatewayCooldownStatus();
}

export function clearGatewayCooldown(): void {
  // The gateway and the central route health are two views of the same route.
  // Clearing one without the other leaves a hidden cooldown that blocks the
  // next request (and leaks between controlled tests).
  try {
    clearProviderCooldowns("freellmapi");
  } catch {}
  const state = cooldownState();
  if (state.until <= Date.now()) return;
  g.__atwGatewayCooldown = { until: 0, reason: null };
  try {
    setSetting(COOLDOWN_KEY, { until: null, reason: null, updated_at: nowIso() });
  } catch {}
}

const RATE_LIMIT_MESSAGE =
  /(?:\b429\b|rate[\s-]?limit(?:ed)?|too many requests|cooldown|all models exhausted|resource_exhausted|quota (?:exceeded|exhausted))/i;

export function isRateLimitMessage(message: string): boolean {
  return RATE_LIMIT_MESSAGE.test(message);
}

function retryAfterFromValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 1000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric > 0 && numeric < 1000 ? numeric * 1000 : numeric;
    }
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    const match = trimmed.match(/(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i);
    if (match) {
      const numeric = Number(match[1]);
      const unit = match[2].toLowerCase();
      return unit.startsWith("m") ? numeric * 60_000 : unit.startsWith("ms") ? numeric : numeric * 1000;
    }
  }
  return null;
}

/** Retry-After header, common JSON cooldown fields, then a conservative default. */
export function parseRetryAfter(headers: Headers, payload?: unknown): number {
  const header = headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(1000, Math.min(15 * 60_000, seconds * 1000));
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(1000, Math.min(15 * 60_000, date - Date.now()));
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  const error = (body.error ?? {}) as Record<string, unknown>;
  for (const candidate of [
    body.retry_after_ms,
    body.retry_after,
    body.retryAfter,
    body.cooldown_ms,
    body.cooldown_until,
    error.retry_after_ms,
    error.retry_after,
    error.retryAfter,
  ]) {
    const parsed = retryAfterFromValue(candidate);
    if (parsed != null) return Math.max(1000, Math.min(15 * 60_000, parsed));
  }
  const text = [body.message, error.message, body.detail, error.detail]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const match = text.match(/(?:retry|wait|cooldown|after)[^\d]{0,20}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)/i);
  if (match) {
    const numeric = Number(match[1]);
    const unit = match[2].toLowerCase();
    const ms = unit.startsWith("m") ? numeric * 60_000 : unit.startsWith("ms") ? numeric : numeric * 1000;
    return Math.max(1000, Math.min(15 * 60_000, ms));
  }
  const fallback = Number(process.env.AI_RATE_LIMIT_DEFAULT_SECONDS ?? "30");
  return Math.max(1000, Math.min(15 * 60_000, (Number.isFinite(fallback) ? fallback : 30) * 1000));
}

function slotState(): AiSlotState {
  g.__atwAiSlots ??= { active: 0, waiters: [] };
  return g.__atwAiSlots;
}

function effectivePriority(waiter: AiSlotWaiter, now: number): number {
  // Ageing prevents interactive bursts from starving queued workflow work.
  return Math.max(0, waiter.priority - Math.floor((now - waiter.queuedAt) / 15_000));
}

function sortWaiters(state: AiSlotState): void {
  const now = Date.now();
  state.waiters.sort((a, b) => effectivePriority(a, now) - effectivePriority(b, now) || a.queuedAt - b.queuedAt);
}

function releaseAiSlot(): void {
  const state = slotState();
  state.active = Math.max(0, state.active - 1);
  sortWaiters(state);
  const next = state.waiters.shift();
  if (next) next.grant();
}

async function acquireAiSlot(priority: number, maxWaitMs: number): Promise<() => void> {
  const state = slotState();
  if (state.active < aiMaxConcurrency()) {
    state.active += 1;
    return releaseAiSlot;
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: AiSlotWaiter = {
      priority,
      queuedAt: Date.now(),
      grant: () => {},
      reject,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    waiter.timer = setTimeout(() => {
      const index = state.waiters.indexOf(waiter);
      if (index >= 0) state.waiters.splice(index, 1);
      reject(new ProvidersUnavailableError(`AI request waited ${maxWaitMs}ms for a free slot.`));
    }, Math.max(1000, maxWaitMs));
    waiter.timer.unref?.();
    waiter.grant = () => {
      clearTimeout(waiter.timer);
      state.active += 1;
      resolve(releaseAiSlot);
    };
    state.waiters.push(waiter);
    sortWaiters(state);
  });
}

export function aiSlotSnapshot() {
  const state = slotState();
  return { active: state.active, waiting: state.waiters.length, limit: aiMaxConcurrency() };
}

export function providerBudget() {
  return config().budgetChf;
}

/** The gateway is addressed. This says nothing about whether the model policy passes. */
export function freeLlmConfigured(): boolean {
  const c = config().freellmapi;
  return c.enabled && Boolean(c.key) && Boolean(c.base) && Boolean(c.model);
}

/** Routing aliases pick an upstream model per request, so cost/identity cannot be enforced. */
const DYNAMIC_MODEL_PATTERN = /(^|\/)(auto|free-router|fusion|kilo-auto)$/i;

function isDynamicModel(modelId: string): boolean {
  return DYNAMIC_MODEL_PATTERN.test(modelId.trim());
}

/**
 * Strict zero-cost policy, checked before any request is sent.
 *
 * The gateway exposes no pricing data, so cost cannot be proven. The policy
 * therefore requires one pinned, catalogued model id that the operator has
 * explicitly listed. `auto` is refused because the upstream model (and any
 * billing attached to it) is chosen server-side after the request. The
 * allowlist can only narrow the permitted set: known billable vendor ids are
 * refused even when listed, and no environment flag can widen that.
 */
export function freeLlmPolicyIssue(): string | null {
  const c = config().freellmapi;
  if (isDynamicModel(c.model)) {
    return `FREELLMAPI_MODEL=${c.model} is refused: a routing alias chooses the upstream model per request, so zero-cost routing and model identity cannot be enforced. Pin one concrete model id.`;
  }
  if (!c.model) {
    return "FREELLMAPI_MODEL is not set. A specific catalogued model id is required; routing aliases are not permitted.";
  }
  if (isBillableModelId(c.model)) {
    return `Model ${c.model} is a known billable vendor id and is never permitted, even if allowlisted.`;
  }
  if (c.allowed.length === 0) {
    return `FREELLMAPI_ALLOWED_MODELS is empty. List the pinned model id (${c.model}) explicitly to permit it.`;
  }
  const rejected = c.allowed.filter((id) => isDynamicModel(id) || isBillableModelId(id));
  if (rejected.length > 0) {
    return `FREELLMAPI_ALLOWED_MODELS contains ids that are never permitted: ${rejected.join(", ")}. The allowlist can only narrow the permitted set.`;
  }
  if (!c.allowed.includes(c.model)) {
    return `${c.model} is not listed in FREELLMAPI_ALLOWED_MODELS, so it is not permitted.`;
  }
  const badAliases = c.aliases.filter((id) => isDynamicModel(id) || isBillableModelId(id));
  if (badAliases.length > 0) {
    return `FREELLMAPI_MODEL_ALIASES contains ids that are never permitted: ${badAliases.join(", ")}.`;
  }
  return null;
}

/** Gateway configured, model policy passes, and the declared free tier is available. */
export function freeLlmUsable(): boolean {
  return freeLlmConfigured() && freeLlmPolicyIssue() === null && freeTierStatus("freellmapi").allowed;
}

export function ollamaConfigured(): boolean {
  const c = config().ollama;
  return c.enabled && Boolean(c.base) && Boolean(c.model);
}

/** A loopback Ollama model that is both configured and policy-authorised. */
export function localFallbackAllowed(model?: string | null): boolean {
  const c = config().ollama;
  if (!c.enabled || !c.base) return false;
  const chosen = (model ?? c.model).trim();
  if (!chosen) return false;
  return evaluateAiPolicy({ provider: "ollama", model: chosen }).allowed;
}

/** Gemini text is available only through a verified, non-exhausted free tier. */
export function geminiConfigured(): boolean {
  const c = config().gemini;
  return Boolean(c.enabled && c.key && c.model) && freeTierStatus("gemini").allowed;
}

/** True when the operator's preferred primary is Gemini. */
export function geminiSelectedForText(): boolean {
  return config().primary === "gemini";
}

/**
 * One shared answer for the Coordinator and every specialist.
 *
 * Any verified, non-exhausted free route counts as configured. A local Ollama
 * endpoint can serve text on its own. A configured-but-unverified external
 * route is a configuration gap, not a runtime outage: the policy fails closed
 * before transmission instead of silently moving the call to another provider.
 */
export function providerConfigured(): boolean {
  return freeLlmUsable() || geminiConfigured() || localFallbackAllowed(config().ollama.model);
}

/** Synchronous view of the latest health check in this process, if any. */
export type ProviderSnapshot = {
  configured: boolean;
  available: boolean | null;
  detail: string;
  model: string;
  checkedAt: string | null;
  activeProvider?: ProviderName | null;
  activeModel?: string | null;
  fallbackEnabled?: boolean;
  fallbackAvailable?: boolean | null;
  fallbackModel?: string | null;
};

export function providerStatusSnapshot(): ProviderSnapshot {
  const cached = g.__atwProviderHealth;
  const reading = (name: ProviderName) => cached?.items.find((item) => item.name === name) ?? null;
  const ollama = reading("ollama");
  const gemini = reading("gemini");
  const freellmapi = reading("freellmapi");
  const checkedAt = cached ? new Date(cached.at).toISOString() : null;
  const geminiTier = freeTierStatus("gemini");
  const freeLlmTier = freeTierStatus("freellmapi");
  const checkHealth = () => evaluateAiPolicy({ provider: "ollama", model: config().ollama.model });
  const localPolicy = checkHealth();
  const fallbackEnabled = localFallbackAllowed(config().ollama.model);
  const fallbackAvailable = fallbackEnabled && ollama ? ollama.available : null;
  const order: Array<"gemini" | "freellmapi" | "ollama"> = geminiSelectedForText()
    ? ["gemini", "freellmapi", "ollama"]
    : ["freellmapi", "gemini", "ollama"];
  const candidates = order.map((name) => ({ name, reading: reading(name) }));
  const active = candidates.find((candidate) => candidate.reading?.available)?.reading ?? null;
  const configured = providerConfigured();
  const tierDetail = `Gemini: ${FREE_TIER_STATE_LABEL[geminiTier.state]}${geminiTier.allowed ? "" : ` (${geminiTier.detail})`}. FreeLLMAPI: ${FREE_TIER_STATE_LABEL[freeLlmTier.state]}${freeLlmTier.allowed ? "" : ` (${freeLlmTier.detail})`}.`;

  if (active) {
    return {
      configured,
      available: true,
      detail: `${tierDetail} Active route: ${active.name}/${active.model}.`,
      model: active.model,
      checkedAt,
      activeProvider: active.name,
      activeModel: active.model,
      fallbackEnabled,
      fallbackAvailable,
      fallbackModel: config().ollama.model || null,
    };
  }
  if (!configured) {
    return {
      configured: false,
      available: false,
      detail: `${tierDetail} ${localPolicy.block_reason ?? "No authorised inference route is available."}`,
      model: geminiTier.model ?? freeLlmTier.model ?? "not configured",
      checkedAt,
      activeProvider: null,
      activeModel: null,
      fallbackEnabled,
      fallbackAvailable,
      fallbackModel: config().ollama.model || null,
    };
  }
  return {
    configured: true,
    available: null,
    detail: `${tierDetail} No provider health result has been recorded in this process yet.`,
    model: (geminiTier.allowed ? geminiTier.model : freeLlmTier.model) ?? config().ollama.model,
    checkedAt,
    activeProvider: null,
    activeModel: null,
    fallbackEnabled,
    fallbackAvailable,
    fallbackModel: config().ollama.model || null,
  };
}

/** Configured text route, independent of whether a health probe succeeded. */
export type ConfiguredTextProvider = {
  provider: ProviderName | null;
  model: string | null;
  source: "primary" | "fallback" | null;
  detail: string;
};

export function configuredTextProvider(): ConfiguredTextProvider {
  const c = config();
  const geminiTier = freeTierStatus("gemini");
  const freeLlmTier = freeTierStatus("freellmapi");
  const geminiRoute: ConfiguredTextProvider = {
    provider: "gemini",
    model: c.gemini.model || null,
    source: "primary",
    detail: `Gemini ${c.gemini.model} is the free-tier route (${FREE_TIER_STATE_LABEL[geminiTier.state]}). A cross-provider free-tier or loopback Ollama fallback may be used only for a recoverable route failure.`,
  };
  const freeLlmRoute: ConfiguredTextProvider = {
    provider: "freellmapi",
    model: c.freellmapi.model || null,
    source: "primary",
    detail: `FreeLLMAPI ${c.freellmapi.model} is the pinned free-tier route (${FREE_TIER_STATE_LABEL[freeLlmTier.state]}). A cross-provider free-tier or loopback Ollama fallback may be used only for a recoverable route failure.`,
  };
  if (geminiSelectedForText()) {
    if (geminiConfigured()) return geminiRoute;
    if (freeLlmUsable()) return freeLlmRoute;
  } else {
    if (freeLlmUsable()) return freeLlmRoute;
    if (geminiConfigured()) return geminiRoute;
  }
  if (localFallbackAllowed(c.ollama.model)) {
    return {
      provider: "ollama",
      model: c.ollama.model || null,
      source: "fallback",
      detail: "No external free tier is verified and available. Loopback Ollama is the only authorised text route; paid inference is never used.",
    };
  }
  return {
    provider: null,
    model: null,
    source: null,
    detail: `No authorised text route is available. Gemini: ${FREE_TIER_STATE_LABEL[geminiTier.state]}. FreeLLMAPI: ${FREE_TIER_STATE_LABEL[freeLlmTier.state]}. ${freeLlmTier.detail}`,
  };
}

/**
 * Zero-cost policy. FreeLLMAPI's catalogue carries no pricing metadata
 * (331/331 models expose none), so a route's cost cannot be proven from the
 * gateway. We therefore fail closed: only `auto` or an operator-declared
 * allowlist may be requested, and a known vendor-billable model returned by the
 * router is refused rather than silently accepted.
 */
const BILLABLE_MODEL_PATTERN =
  /(^|\/)(claude|gpt-[45]|o[134]|opus|sonnet|haiku|gemini-[0-9.]*-pro|gemini-ultra)/i;

export function isBillableModelId(modelId: string): boolean {
  return BILLABLE_MODEL_PATTERN.test(modelId);
}

/** Pre-request gate: only an explicitly allowlisted, non-billable, concrete model id may be sent. */
export function assertPermittedModel(modelId: string): void {
  const c = config().freellmapi;
  if (isDynamicModel(modelId)) {
    throw new Error("Refused: routing aliases (auto, free-router, fusion, kilo-auto) are not permitted. Pin a concrete catalogued model id.");
  }
  if (isBillableModelId(modelId)) {
    throw new Error(`Refused: model ${modelId} is a known billable vendor id. The zero-cost policy blocks it even if allowlisted.`);
  }
  if (!c.allowed.includes(modelId)) {
    throw new Error(`Refused: ${modelId} is not listed in FREELLMAPI_ALLOWED_MODELS.`);
  }
}

/**
 * Post-response gate. FreeLLMAPI may report the same upstream model under a
 * provider-prefixed id (observed: `gpt-oss-120b` on ovh, `openai/gpt-oss-120b`
 * on groq). Only the pinned id or an explicitly declared alias is accepted;
 * anything else is an unexpected substitution and the response is discarded.
 */
export function assertPinnedResolution(requested: string, resolved: string): void {
  const aliases = config().freellmapi.aliases;
  if (resolved !== requested && !aliases.includes(resolved)) {
    throw new Error(
      `Refused: gateway resolved ${requested} to ${resolved}, which is not the pinned id or a declared alias. Silent substitution is not permitted, so this response was discarded.`,
    );
  }
}

export type GatewayHealthKind = "ok" | "auth" | "rate" | "http";

/** Pure classification so the health path can be tested without a network. */
export function classifyGatewayHealth(status: number, body = ""): { kind: GatewayHealthKind; detail: string } {
  if (status >= 200 && status < 300) return { kind: "ok", detail: "Gateway responded." };
  if (status === 429 || isRateLimitMessage(body)) {
    return { kind: "rate", detail: `Rate limited (HTTP ${status})${body ? `: ${body.slice(0, 140)}` : ""}.` };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", detail: `Authentication failed (HTTP ${status}). FREELLMAPI_API_KEY was rejected.` };
  }
  return { kind: "http", detail: `Gateway returned HTTP ${status}${body ? `: ${body.slice(0, 120)}` : ""}.` };
}

export function classifyGatewayError(error: unknown, base: string): { kind: "unreachable"; detail: string } {
  const message = error instanceof Error ? error.message : "network error";
  return { kind: "unreachable", detail: `FreeLLMAPI unreachable at ${base}: ${message}` };
}

function scrub(message: string): string {
  let text = message;
  for (const secret of [process.env.FREELLMAPI_API_KEY, process.env.GEMINI_API_KEY, process.env.OPENROUTER_API_KEY]) {
    if (secret && secret.length > 8) text = text.split(secret).join("[redacted]");
  }
  return text.slice(0, 500);
}

/** Public for tests and for server-action error messages. */
export function scrubProviderError(message: string): string {
  return scrub(message);
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function freeLlmHealth(): Promise<ProviderHealth> {
  const c = config().freellmapi;
  const guard = evaluateAiPolicy({ provider: "freellmapi", model: c.model });
  const tier = freeTierStatus("freellmapi");
  const base: ProviderHealth = {
    name: "freellmapi",
    label: "FreeLLMAPI (external gateway · free tier)",
    enabled: c.enabled,
    configured: freeLlmConfigured(),
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
    policyBlocked: !guard.allowed,
    executionType: guard.execution_type,
    policyReason: guard.block_reason,
    freeTierState: tier.state,
  };
  if (!c.enabled) return { ...base, detail: "FREELLMAPI_ENABLED is not true." };
  if (!c.key) return { ...base, detail: "FREELLMAPI_API_KEY is not set." };
  if (!c.base) return { ...base, detail: "FREELLMAPI_BASE_URL is not set." };
  const issue = freeLlmPolicyIssue();
  if (issue) return { ...base, detail: issue };

  const cooling = gatewayCooldownStatus();
  if (cooling.remainingMs > 0) {
    return {
      ...base,
      detail: `Rate limited; ${Math.ceil(cooling.remainingMs / 1000)}s cooldown remains. ${cooling.reason ?? ""}`.trim(),
    };
  }

  const started = Date.now();
  try {
    const response = await fetch(`${c.base}/models`, {
      headers: { Authorization: `Bearer ${c.key}` },
      signal: timeout(8000),
      cache: "no-store",
    });
    base.latencyMs = Date.now() - started;
    const text = await response.text().catch(() => "");
    const classified = classifyGatewayHealth(response.status, text);
    if (classified.kind === "rate") {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(text);
      } catch {}
      setGatewayCooldown(parseRetryAfter(response.headers, parsed), classified.detail);
      return { ...base, detail: classified.detail };
    }
    if (classified.kind !== "ok") return { ...base, detail: classified.detail };

    const payload = (() => {
      try {
        return JSON.parse(text) as { data?: Array<{ id?: string }> };
      } catch {
        return {} as { data?: Array<{ id?: string }> };
      }
    })();
    const models = (payload.data ?? []).map((model) => String(model.id ?? "")).filter(Boolean);
    base.models = models;
    if (models.length === 0) return { ...base, detail: "The model catalogue returned no models." };
    if (!models.includes(c.model)) {
      return {
        ...base,
        detail: `${c.model} is not in the gateway catalogue (${models.length} models listed). No substitution was attempted.`,
      };
    }
    if (!tier.allowed) {
      return {
        ...base,
        models,
        detail: `${models.length} models available and the pinned ${c.model} is catalogued, but inference is blocked: ${tier.detail} Metadata reachability is not free-tier eligibility.`,
      };
    }
    return {
      ...base,
      available: true,
      policyBlocked: false,
      executionType: "verified_free_external",
      detail: `${models.length} models available. Pinned ${c.model} is catalogued, allowlisted and declared free-tier (${FREE_TIER_STATE_LABEL[tier.state]}). If its quota is exhausted the route is paused, never upgraded to a paid request.`,
    };
  } catch (error) {
    base.latencyMs = Date.now() - started;
    return { ...base, detail: classifyGatewayError(error, c.base).detail };
  }
}

async function geminiHealth(): Promise<ProviderHealth> {
  const c = config().gemini;
  const guard = evaluateAiPolicy({ provider: "gemini", model: c.model });
  const tier = freeTierStatus("gemini");
  const base: ProviderHealth = {
    name: "gemini",
    label: "Google Gemini (free tier)",
    enabled: c.enabled,
    configured: Boolean(c.enabled && c.model),
    available: false,
    model: c.model,
    models: c.model ? [c.model] : [],
    detail: "",
    latencyMs: null,
    policyBlocked: !guard.allowed,
    executionType: guard.execution_type,
    policyReason: guard.block_reason,
    freeTierState: tier.state,
  };
  if (!c.enabled) return { ...base, detail: "GEMINI_API_KEY is not set. No Gemini request is made." };
  if (!c.model) return { ...base, detail: "GEMINI_MODEL is not set. No model is guessed." };
  if (!tier.allowed) return { ...base, detail: tier.detail };
  if (!guard.allowed) return { ...base, detail: guard.block_reason ?? "Gemini policy check failed." };
  const last = one<{ status: string; model: string; created_at: string; error: string | null }>(
    "SELECT status, model, created_at, error FROM provider_usage WHERE provider = 'gemini' ORDER BY id DESC LIMIT 1",
  );
  if (!last) {
    return {
      ...base,
      detail: `${c.model} is declared free-tier (${FREE_TIER_STATE_LABEL[tier.state]}). No Gemini inference has been recorded yet; availability is not claimed from configuration alone.`,
    };
  }
  if (last.status === "ok") {
    return {
      ...base,
      available: true,
      model: last.model || c.model,
      executionType: "verified_free_external",
      detail: `Last Gemini inference succeeded with ${last.model || c.model} at ${last.created_at} on the declared free tier. Exhaustion pauses this route; it is never upgraded to a paid request.`,
    };
  }
  return {
    ...base,
    detail: `Last Gemini inference failed with ${last.model || c.model} at ${last.created_at}: ${last.error ?? "unknown error"}. A verified FreeLLMAPI free tier or loopback Ollama route may be used for recoverable failures; authentication, configuration and paid-model failures fail closed.`,
  };
}

async function openRouterHealth(): Promise<ProviderHealth> {
  const c = config().openrouter;
  const guard = evaluateAiPolicy({ provider: "openrouter", model: c.model });
  const base: ProviderHealth = {
    name: "openrouter",
    label: "OpenRouter (provider-verified free models)",
    enabled: c.enabled,
    configured: c.enabled && Boolean(c.key) && Boolean(c.model),
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
    policyBlocked: true,
    executionType: "blocked",
    policyReason: guard.block_reason,
  };
  if (!c.enabled) return { ...base, detail: "OPENROUTER_ENABLED is not true. No OpenRouter request is transmitted." };
  if (!c.key) return { ...base, detail: "OPENROUTER_API_KEY is not set. No OpenRouter request is transmitted." };
  if (!c.model) return { ...base, detail: "OPENROUTER_MODEL is not set. No model is guessed and no request is transmitted." };

  const status = await openRouterStatus();
  const assignment = c.assignedAgents.length > 0 ? c.assignedAgents.join(", ") : "no agents assigned";
  return {
    ...base,
    available: status.text.valid,
    policyBlocked: !status.text.valid,
    executionType: status.text.valid ? "verified_free_external" : "blocked",
    policyReason: status.text.policyIssue,
    detail: `${status.text.detail} Assignments: ${assignment}. ${status.tts.detail}`,
    tts: {
      enabled: status.tts.enabled,
      model: status.tts.model,
      voice: status.tts.voice,
      provider: status.tts.provider,
      expiresAt: status.tts.expiresAt,
      valid: status.tts.valid,
      detail: status.tts.detail,
    },
  };
}

function safeEndpoint(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "configured Ollama endpoint";
  }
}

function modelNamesFromTags(payload: unknown): string[] {
  const body = (payload ?? {}) as { models?: Array<{ name?: string; model?: string }> };
  return (body.models ?? [])
    .map((model) => String(model.name ?? model.model ?? "").trim())
    .filter(Boolean);
}

function missingOllamaModel(model: string): string {
  return `${model} is not installed. Run: ollama pull ${model}`;
}

/** Lightweight, secret-free connection probe used by admin health and the test action. */
export type OllamaConnectionTest = {
  ok: boolean;
  enabled: boolean;
  base: string;
  generalModel: string;
  coderModel: string;
  generalInstalled: boolean;
  coderInstalled: boolean;
  models: string[];
  latencyMs: number | null;
  detail: string;
};

export function ollamaEndpointLabel(): string {
  return safeEndpoint(config().ollama.base);
}

export async function testOllamaConnection(): Promise<OllamaConnectionTest> {
  const c = config().ollama;
  const result: OllamaConnectionTest = {
    ok: false,
    enabled: c.enabled,
    base: safeEndpoint(c.base),
    generalModel: c.model || "not configured",
    coderModel: c.coderModel || "not configured",
    generalInstalled: false,
    coderInstalled: false,
    models: [],
    latencyMs: null,
    detail: "",
  };
  if (!c.enabled) return { ...result, detail: "OLLAMA_ENABLED is false; no local request was made." };
  if (!c.base) return { ...result, detail: "OLLAMA_BASE_URL is not set." };
  if (!c.model) return { ...result, detail: "OLLAMA_MODEL is not set. No model was requested." };
  if (!c.coderModel) return { ...result, detail: "OLLAMA_CODER_MODEL is not set. No model was requested." };
  const started = Date.now();
  try {
    const response = await fetch(`${c.base}/api/tags`, { signal: timeout(5_000), cache: "no-store" });
    result.latencyMs = Date.now() - started;
    if (!response.ok) return { ...result, detail: `Ollama returned HTTP ${response.status}.` };
    const payload = await response.json().catch(() => ({}));
    result.models = modelNamesFromTags(payload);
    result.generalInstalled = result.models.includes(c.model);
    result.coderInstalled = result.models.includes(c.coderModel);
    const missing: string[] = [];
    if (!result.generalInstalled) missing.push(missingOllamaModel(c.model));
    if (!result.coderInstalled) missing.push(missingOllamaModel(c.coderModel));
    return {
      ...result,
      ok: missing.length === 0,
      detail: missing.length === 0
        ? `Ollama is reachable at ${result.base}; both configured models are installed.`
        : `Ollama is reachable at ${result.base}, but ${missing.join(" ")}`,
    };
  } catch (error) {
    result.latencyMs = Date.now() - started;
    return {
      ...result,
      detail: `Ollama unreachable at ${result.base}: ${scrub(error instanceof Error ? error.message : "network error")}`,
    };
  }
}

async function ollamaHealth(): Promise<ProviderHealth> {
  const c = config().ollama;
  const guard = evaluateAiPolicy({ provider: "ollama", model: c.model });
  const base: ProviderHealth = {
    name: "ollama",
    label: "Ollama (local only)",
    enabled: c.enabled,
    configured: c.enabled && Boolean(c.base) && Boolean(c.model),
    available: false,
    model: c.model || "not configured",
    models: [],
    detail: "",
    latencyMs: null,
    policyBlocked: !guard.allowed,
    executionType: guard.execution_type,
    policyReason: guard.block_reason,
  };
  if (!c.enabled) return { ...base, detail: "OLLAMA_ENABLED is false. No local model is loaded or contacted." };
  if (!c.base) return { ...base, detail: "OLLAMA_BASE_URL is not set." };
  if (!c.model) return { ...base, detail: "OLLAMA_MODEL is not set." };
  if (!c.coderModel) return { ...base, detail: "OLLAMA_CODER_MODEL is not set; coding-specific fallback is unavailable." };
  if (!guard.allowed) return { ...base, detail: guard.block_reason ?? "Ollama is not verified as local." };
  const started = Date.now();
  try {
    const response = await fetch(`${c.base}/api/tags`, { signal: timeout(5_000), cache: "no-store" });
    base.latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ...base, detail: `Ollama returned HTTP ${response.status} at ${safeEndpoint(c.base)}.` };
    }
    const payload = await response.json().catch(() => ({}));
    const models = modelNamesFromTags(payload);
    base.models = models;
    const generalInstalled = models.includes(c.model);
    const coderInstalled = models.includes(c.coderModel);
    if (!generalInstalled) {
      return { ...base, detail: `Ollama is reachable at ${safeEndpoint(c.base)}, but ${missingOllamaModel(c.model)}.` };
    }
    return {
      ...base,
      available: true,
      detail: coderInstalled
        ? `${models.length} installed model(s). ${c.model} handles general inference and ${c.coderModel} handles coding-specific calls.`
        : `${models.length} installed model(s). ${c.model} is ready for general fallback, but ${missingOllamaModel(c.coderModel)}; coding-specific fallback will fail clearly.`,
    };
  } catch (error) {
    base.latencyMs = Date.now() - started;
    return {
      ...base,
      detail: `Ollama unreachable at ${safeEndpoint(c.base)}: ${scrub(error instanceof Error ? error.message : "network error")}`,
    };
  }
}

/**
 * Latest health results without sending a request. The in-process cache is
 * preferred; the persisted snapshot survives a restart. This is deliberately
 * read-only and is used by the lightweight authenticated status route.
 */
export function cachedProviderHealth(): CachedProviderHealth | null {
  const cached = g.__atwProviderHealth;
  if (cached) return { checkedAt: new Date(cached.at).toISOString(), items: cached.items };
  try {
    const saved = getSetting<CachedProviderHealth | null>(HEALTH_SNAPSHOT_KEY, null);
    if (!saved || typeof saved.checkedAt !== "string" || !Array.isArray(saved.items)) return null;
    return saved;
  } catch {
    return null;
  }
}

export async function providerHealth(force = false): Promise<ProviderHealth[]> {
  const cached = g.__atwProviderHealth;
  if (!force && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.items;
  const items = await Promise.all([freeLlmHealth(), geminiHealth(), openRouterHealth(), ollamaHealth()]);
  const checkedAt = new Date().toISOString();
  const stamped = items.map((item) => ({ ...item, checkedAt }));
  // Do not cache a rate-limited FreeLLMAPI result: once the advertised cooldown
  // expires, the next probe must be allowed to check it immediately. Cache the
  // other providers, though, so fallback readiness remains visible in the UI.
  const rateLimited = stamped.some(
    (item) => item.name === "freellmapi" && /rate limited|cooldown/i.test(item.detail),
  );
  const cacheable = rateLimited ? stamped.filter((item) => item.name !== "freellmapi") : stamped;
  g.__atwProviderHealth = { at: Date.now(), items: cacheable };
  try {
    setSetting(HEALTH_SNAPSHOT_KEY, { checkedAt, items: stamped });
  } catch {
    // Status persistence is advisory; the in-process health result still applies.
  }
  return stamped;
}

export function recordUsage(input: {
  provider: string;
  model: string;
  agentKey: string;
  workflowId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  source?: AiCallSource;
  usage: Usage;
  usageSource?: "provider" | "estimated" | "unknown";
  cachedTokens?: number;
  latencyMs: number;
  status: string;
  error?: string | null;
  routedVia?: RoutedVia;
  fallbackFrom?: ProviderName | null;
  fallbackReason?: string | null;
}): boolean {
  // Task attribution is proven here, at the single usage writer. A caller may
  // request a task link, but it is retained only when the task exists and is
  // owned by the same agent. A missing or mismatched link stays source="task"
  // with task_id=NULL, which the dashboard reports as unresolved. It is never
  // silently converted into background usage or moved to another agent.
  const requested = input.source ?? (input.taskId ? "task" : "manual");
  let source: AiCallSource = requested;
  let taskId = input.taskId ?? null;
  const agentKey = input.agentKey;
  if (source === "task" && taskId) {
    const task = one<{ agent_key: string }>("SELECT agent_key FROM tasks WHERE id = ?", [taskId]);
    if (!task || task.agent_key !== agentKey) taskId = null;
  }
  try {
    // cost_chf stays 0 for schema compatibility but cost_status records that the
    // figure is unverified: the gateway publishes no pricing metadata.
    run(
      `INSERT INTO provider_usage (provider, model, agent_key, workflow_id, task_id, session_id, source, prompt_tokens, completion_tokens, total_tokens, cached_tokens, usage_source, cost_chf, cost_status, routed_platform, routed_model, latency_ms, status, error, fallback_from, fallback_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unverified', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.provider,
        input.model,
        agentKey,
        input.workflowId ?? null,
        taskId,
        input.sessionId ?? null,
        source,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.totalTokens,
        input.cachedTokens ?? 0,
        input.usageSource ?? "unknown",
        input.routedVia?.platform ?? null,
        input.routedVia?.model ?? null,
        input.latencyMs,
        input.status,
        input.error ? scrub(input.error) : null,
        input.fallbackFrom ?? null,
        input.fallbackReason ? scrub(input.fallbackReason) : null,
        nowIso(),
      ],
    );
    // Task execution metadata is a projection of the same usage rows, not a
    // second hand-maintained record. Every provider call (including a failed
    // attempt) updates attempts, provider/model and AI execution mode together.
    if (source === "task" && taskId) {
      run(
        `UPDATE tasks SET
           provider = (SELECT provider FROM provider_usage WHERE task_id = ? ORDER BY id DESC LIMIT 1),
           model = (SELECT model FROM provider_usage WHERE task_id = ? ORDER BY id DESC LIMIT 1),
           execution_mode = 'ai',
           attempts = (SELECT COUNT(*) FROM provider_usage WHERE task_id = ? AND agent_key = ? AND source = 'task'),
           ai_outcome = CASE WHEN EXISTS (
             SELECT 1 FROM provider_usage WHERE task_id = ? AND agent_key = ? AND source = 'task' AND status = 'ok'
           ) THEN 'ok' ELSE 'failed' END
         WHERE id = ? AND agent_key = ?`,
        [taskId, taskId, taskId, agentKey, taskId, agentKey, taskId, agentKey],
      );
    }
    // One place updates the roster counters, so they are exactly the count of
    // valid task-sourced calls. Assistant/manual and unresolved rows never move
    // these counters.
    if (source === "task" && taskId) {
      if (input.status === "ok") {
        run("UPDATE agents SET ai_success_count = ai_success_count + 1 WHERE key = ?", [agentKey]);
      } else if (input.status === "error") {
        run("UPDATE agents SET ai_failure_count = ai_failure_count + 1 WHERE key = ?", [agentKey]);
      }
    }
    return true;
  } catch (error) {
    // Usage tracking must never break an agent run, but a silent failure would
    // make the roster lie, so it is reported on the server log (scrubbed) and
    // the caller is told the row was not persisted.
    console.error("[ai-usage] failed to record call", scrub(error instanceof Error ? error.message : "unknown error"));
    return false;
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function providerHttpFailure(
  provider: ProviderName,
  status: number,
  message: string,
  headers?: Headers,
  payload?: unknown,
): Error {
  if (status === 429 || isRateLimitMessage(message)) {
    return new AiRateLimitedError(
      message,
      headers ? parseRetryAfter(headers, payload) : 30_000,
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new AiProviderConfigError(provider, `Authentication failed (HTTP ${status}): ${message}`);
  }
  if (status === 400 || status === 402 || status === 404 || status === 409 || status === 422) {
    return new AiProviderConfigError(provider, `Request/model configuration failed (HTTP ${status}): ${message}`);
  }
  return new AiProviderError(provider, `Provider HTTP ${status}: ${message}`, status === 408 || status === 425 || status >= 500, status);
}

async function callFreeLlmStreaming(input: GenerateInput & { onDelta: (delta: string) => void }): Promise<GenerateResult> {
  const c = config().freellmapi;
  const guard = evaluateAiPolicy({ provider: "freellmapi", model: c.model });
  if (!guard.allowed) throw new AiSpendingPolicyError(guard);
  try {
    assertPermittedModel(c.model);
  } catch (error) {
    throw new AiProviderConfigError("freellmapi", error instanceof Error ? error.message : "FreeLLMAPI model policy rejected the request.");
  }
  const started = Date.now();
  const response = await fetch(`${c.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.key}`, "Content-Type": "application/json" },
    signal: timeout(45_000),
    body: JSON.stringify({
      model: c.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 800,
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let payload: { error?: { message?: string } } = {};
    try { payload = JSON.parse(raw) as { error?: { message?: string } }; } catch {}
    throw providerHttpFailure("freellmapi", response.status, payload.error?.message ?? raw.slice(0, 300) ?? `FreeLLMAPI HTTP ${response.status}`, response.headers, payload);
  }
  if (!response.body) throw new AiProviderError("freellmapi", "FreeLLMAPI returned no streaming body.", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = c.model;
  let usagePayload: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null = null;
  let routedVia: RoutedVia = null;
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as {
      model?: string;
      choices?: Array<{ delta?: { content?: string }; text?: string; message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      _routed_via?: { platform?: string; model?: string };
    };
    if (payload.model) model = payload.model;
    if (payload.usage) usagePayload = payload.usage;
    if (payload._routed_via) routedVia = { platform: payload._routed_via.platform ?? null, model: payload._routed_via.model ?? null };
    const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text ?? "";
    if (delta) {
      text += delta;
      input.onDelta(delta);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      processLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) processLine(buffer);
  if (!text.trim()) throw new AiProviderError("freellmapi", "FreeLLMAPI returned an empty completion.", true);
  try {
    assertPinnedResolution(c.model, model);
  } catch (error) {
    throw new AiProviderConfigError("freellmapi", error instanceof Error ? error.message : "FreeLLMAPI returned an unpinned model.");
  }
  const usage = usagePayload as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  const usageSource = usage ? "provider" as const : "estimated" as const;
  return {
    text: text.trim(),
    provider: "freellmapi",
    model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(input.prompt),
      completionTokens: usage?.completion_tokens ?? estimateTokens(text),
      totalTokens: usage?.total_tokens ?? estimateTokens(input.prompt) + estimateTokens(text),
    },
    usageSource,
    cachedTokens: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia,
  };
}

async function callFreeLlm(input: GenerateInput): Promise<GenerateResult> {
  if (input.onDelta) return callFreeLlmStreaming(input as GenerateInput & { onDelta: (delta: string) => void });
  const c = config().freellmapi;
  const guard = evaluateAiPolicy({ provider: "freellmapi", model: c.model });
  if (!guard.allowed) throw new AiSpendingPolicyError(guard);
  try {
    assertPermittedModel(c.model);
  } catch (error) {
    throw new AiProviderConfigError("freellmapi", error instanceof Error ? error.message : "FreeLLMAPI model policy rejected the request.");
  }
  const started = Date.now();
  const response = await fetch(`${c.base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
    },
    signal: timeout(45_000),
    body: JSON.stringify({
      model: c.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 800,
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string };
    _routed_via?: { platform?: string; model?: string };
  };
  if (!response.ok) {
    const message = payload.error?.message ?? `FreeLLMAPI HTTP ${response.status}`;
    throw providerHttpFailure("freellmapi", response.status, message, response.headers, payload);
  }
  const text = (payload.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new AiProviderError("freellmapi", "FreeLLMAPI returned an empty completion.", true);
  const model = String(payload.model ?? c.model);
  // Fail closed on any substitution (e.g. an alias rewritten to a provider id).
  try {
    assertPinnedResolution(c.model, model);
  } catch (error) {
    throw new AiProviderConfigError("freellmapi", error instanceof Error ? error.message : "FreeLLMAPI returned an unpinned model.");
  }
  const usageSource = payload.usage ? "provider" as const : "estimated" as const;
  const usage = {
    promptTokens: payload.usage?.prompt_tokens ?? estimateTokens(input.prompt),
    completionTokens: payload.usage?.completion_tokens ?? estimateTokens(text),
    totalTokens:
      payload.usage?.total_tokens ?? estimateTokens(input.prompt) + estimateTokens(text),
  };
  return {
    text,
    provider: "freellmapi",
    model,
    usage,
    usageSource,
    cachedTokens: Number(payload.usage?.prompt_tokens_details?.cached_tokens ?? 0),
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: payload._routed_via
      ? { platform: payload._routed_via.platform ?? null, model: payload._routed_via.model ?? null }
      : null,
  };
}

function openRouterFailure(error: unknown): Error {
  if (error instanceof AiProviderError || error instanceof AiRateLimitedError) return error;
  if (error instanceof OpenRouterRequestError) {
    if (error.kind === "rate_limit") {
      return new AiRateLimitedError(error.message, error.retryAfterMs ?? 30_000, error.status);
    }
    if (error.kind === "authentication" || error.kind === "configuration") {
      return new AiProviderConfigError("openrouter", error.message);
    }
    return new AiProviderError("openrouter", error.message, true, error.status);
  }
  return new AiProviderError(
    "openrouter",
    scrub(error instanceof Error ? error.message : "OpenRouter request failed."),
    true,
  );
}

function openRouterValidationFailure(
  validation: Exclude<Awaited<ReturnType<typeof validateOpenRouterFreeModel>>, { ok: true }>,
): Error {
  if (validation.code === "rate_limit") {
    return new AiRateLimitedError(validation.reason, 30_000, 429);
  }
  if (validation.code === "provider_unavailable") {
    return new AiProviderError("openrouter", validation.reason, true);
  }
  return new AiProviderConfigError("openrouter", validation.reason);
}

/**
 * OpenRouter may report the base model id for a request made to its `:free`
 * variant. That is the same published model, not a paid substitution. Any
 * other id is discarded because it could be a silent upstream change.
 */
function assertOpenRouterResolution(requested: string, returned: string): void {
  if (returned === requested) return;
  if (requested.endsWith(":free") && returned === requested.slice(0, -5)) return;
  throw new AiProviderConfigError(
    "openrouter",
    `Refused: OpenRouter resolved ${requested} to ${returned}, which is not the pinned free id or its exact base id. The response was discarded; no paid substitution is permitted.`,
  );
}

function openRouterHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "X-Title": "AT AI Workforce",
  };
  const referer = (process.env.APP_BASE_URL ?? "").trim();
  if (referer) headers["HTTP-Referer"] = referer;
  return headers;
}

async function callOpenRouterStreaming(
  input: GenerateInput & { onDelta: (delta: string) => void },
): Promise<GenerateResult> {
  const c = openRouterTextConfig();
  try {
    await checkOpenRouterCredential();
  } catch (error) {
    throw openRouterFailure(error);
  }
  const validation = await validateOpenRouterFreeModel(c.model, "text", { checkKey: false });
  if (!validation.ok) throw openRouterValidationFailure(validation);

  const started = Date.now();
  const response = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(c.key),
    signal: timeout(60_000),
    body: JSON.stringify({
      model: c.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 800,
      provider: { allow_fallbacks: false },
      ...(input.format === "json" ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let payload: { error?: { message?: string } } = {};
    try { payload = JSON.parse(raw) as { error?: { message?: string } }; } catch {}
    throw providerHttpFailure(
      "openrouter",
      response.status,
      payload.error?.message ?? raw.slice(0, 300) ?? `OpenRouter HTTP ${response.status}`,
      response.headers,
      payload,
    );
  }
  if (!response.body) throw new AiProviderError("openrouter", "OpenRouter returned no streaming body.", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let model = c.model;
  let provider: string | null = null;
  let usagePayload: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null = null;
  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === "[DONE]") return;
    const payload = JSON.parse(data) as {
      model?: string;
      provider?: string;
      choices?: Array<{ delta?: { content?: string }; text?: string }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
      error?: { message?: string; code?: number };
    };
    if (payload.error) {
      throw new AiProviderError("openrouter", payload.error.message ?? "OpenRouter stream error.", false, payload.error.code ?? null);
    }
    if (payload.model) model = payload.model;
    if (payload.provider) provider = payload.provider;
    if (payload.usage) usagePayload = payload.usage;
    const delta = payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.text ?? "";
    if (delta) {
      text += delta;
      input.onDelta(delta);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      processLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) processLine(buffer);
  if (!text.trim()) throw new AiProviderError("openrouter", "OpenRouter returned an empty completion.", true);
  assertOpenRouterResolution(c.model, model);
  const usage = usagePayload as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
  return {
    text: text.trim(),
    provider: "openrouter",
    model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(input.prompt),
      completionTokens: usage?.completion_tokens ?? estimateTokens(text),
      totalTokens: usage?.total_tokens ?? estimateTokens(input.prompt) + estimateTokens(text),
    },
    usageSource: usage ? "provider" : "estimated",
    cachedTokens: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: { platform: provider, model },
  };
}

async function callOpenRouter(input: GenerateInput): Promise<GenerateResult> {
  if (input.onDelta) return callOpenRouterStreaming(input as GenerateInput & { onDelta: (delta: string) => void });
  const c = openRouterTextConfig();
  try {
    await checkOpenRouterCredential();
  } catch (error) {
    throw openRouterFailure(error);
  }
  const validation = await validateOpenRouterFreeModel(c.model, "text", { checkKey: false });
  if (!validation.ok) throw openRouterValidationFailure(validation);

  const started = Date.now();
  const response = await fetch(`${c.baseUrl}/chat/completions`, {
    method: "POST",
    headers: openRouterHeaders(c.key),
    signal: timeout(60_000),
    body: JSON.stringify({
      model: c.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? 800,
      provider: { allow_fallbacks: false },
      ...(input.format === "json" ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    provider?: string;
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
    error?: { message?: string; code?: number };
  };
  if (!response.ok) {
    throw providerHttpFailure(
      "openrouter",
      response.status,
      payload.error?.message ?? `OpenRouter HTTP ${response.status}`,
      response.headers,
      payload,
    );
  }
  const rawContent = payload.choices?.[0]?.message?.content;
  const text = (typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent
          .map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : ""))
          .join("")
      : "").trim();
  if (!text) throw new AiProviderError("openrouter", "OpenRouter returned an empty completion.", true);
  const model = String(payload.model ?? c.model);
  assertOpenRouterResolution(c.model, model);
  const usage = payload.usage;
  return {
    text,
    provider: "openrouter",
    model,
    usage: {
      promptTokens: usage?.prompt_tokens ?? estimateTokens(input.prompt),
      completionTokens: usage?.completion_tokens ?? estimateTokens(text),
      totalTokens: usage?.total_tokens ?? estimateTokens(input.prompt) + estimateTokens(text),
    },
    usageSource: usage ? "provider" : "estimated",
    cachedTokens: Number(usage?.prompt_tokens_details?.cached_tokens ?? 0),
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: { platform: payload.provider ?? null, model },
  };
}

function ollamaModelFor(input: GenerateInput): string {
  const c = config().ollama;
  return input.technical ? c.coderModel : c.model;
}

async function callOllamaStreaming(input: GenerateInput & { onDelta: (delta: string) => void }): Promise<GenerateResult> {
  const c = config().ollama;
  const guard = evaluateAiPolicy({ provider: "ollama", model: ollamaModelFor(input) });
  if (!guard.allowed) throw new AiSpendingPolicyError(guard);
  if (!c.enabled) throw new AiProviderConfigError("ollama", "Ollama fallback is disabled (OLLAMA_ENABLED is not true).");
  if (!c.base) throw new AiProviderConfigError("ollama", "OLLAMA_BASE_URL is not set.");
  const model = ollamaModelFor(input);
  const configurationName = input.technical ? "OLLAMA_CODER_MODEL" : "OLLAMA_MODEL";
  if (!model) throw new AiProviderConfigError("ollama", `${configurationName} is not set.`);
  const started = Date.now();
  const response = await fetch(`${c.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: timeout(c.timeoutMs),
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: "5m",
      format: input.format === "json" ? "json" : undefined,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      options: { temperature: input.temperature ?? 0.2, num_predict: input.maxTokens ?? 800, num_ctx: 4096 },
    }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    const message = raw.slice(0, 300) || `Ollama HTTP ${response.status}`;
    if (response.status === 404 || /model.*not found|no such model/i.test(message)) {
      throw new AiProviderConfigError("ollama", `${model} is not installed or could not be loaded. Run: ollama pull ${model}`);
    }
    throw providerHttpFailure("ollama", response.status, message);
  }
  if (!response.body) throw new AiProviderError("ollama", "Ollama returned no streaming body.", true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let promptTokens = 0;
  let completionTokens = 0;
  const processLine = (line: string) => {
    if (!line.trim()) return;
    const payload = JSON.parse(line) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number; error?: string };
    if (payload.error) throw new AiProviderError("ollama", payload.error, false);
    const delta = payload.message?.content ?? "";
    if (delta) { text += delta; input.onDelta(delta); }
    if (typeof payload.prompt_eval_count === "number") promptTokens = payload.prompt_eval_count;
    if (typeof payload.eval_count === "number") completionTokens = payload.eval_count;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      processLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) processLine(buffer);
  if (!text.trim()) throw new AiProviderError("ollama", "Ollama returned an empty completion.", true);
  return {
    text: text.trim(),
    provider: "ollama",
    model,
    usage: {
      promptTokens: promptTokens || estimateTokens(input.prompt),
      completionTokens: completionTokens || estimateTokens(text),
      totalTokens: promptTokens + completionTokens || estimateTokens(input.prompt) + estimateTokens(text),
    },
    usageSource: promptTokens && completionTokens ? "provider" : "estimated",
    cachedTokens: 0,
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: null,
  };
}

async function callOllama(input: GenerateInput): Promise<GenerateResult> {
  if (input.onDelta) return callOllamaStreaming(input as GenerateInput & { onDelta: (delta: string) => void });
  const c = config().ollama;
  const guard = evaluateAiPolicy({ provider: "ollama", model: ollamaModelFor(input) });
  if (!guard.allowed) throw new AiSpendingPolicyError(guard);
  if (!c.enabled) throw new AiProviderConfigError("ollama", "Ollama fallback is disabled (OLLAMA_ENABLED is not true).");
  if (!c.base) throw new AiProviderConfigError("ollama", "OLLAMA_BASE_URL is not set.");
  const model = ollamaModelFor(input);
  const configurationName = input.technical ? "OLLAMA_CODER_MODEL" : "OLLAMA_MODEL";
  if (!model) throw new AiProviderConfigError("ollama", `${configurationName} is not set.`);

  const started = Date.now();
  const response = await fetch(`${c.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: timeout(c.timeoutMs),
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: "5m",
      format: input.format === "json" ? "json" : undefined,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      options: {
        temperature: input.temperature ?? 0.2,
        num_predict: input.maxTokens ?? 800,
        num_ctx: 4096,
      },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    model?: string;
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (!response.ok) {
    const message = payload.error ?? `Ollama HTTP ${response.status}`;
    if (response.status === 404 || /model.*not found|no such model/i.test(message)) {
      throw new AiProviderConfigError("ollama", `${model} is not installed or could not be loaded. Run: ollama pull ${model}`);
    }
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 422) {
      throw new AiProviderConfigError("ollama", `Request/model configuration failed (HTTP ${response.status}): ${message}`);
    }
    throw providerHttpFailure("ollama", response.status, message);
  }
  const text = (payload.message?.content ?? "").trim();
  if (!text) throw new AiProviderError("ollama", "Ollama returned an empty completion.", true);
  const reported = typeof payload.prompt_eval_count === "number" && typeof payload.eval_count === "number";
  return {
    text,
    provider: "ollama",
    model,
    usage: {
      promptTokens: payload.prompt_eval_count ?? estimateTokens(input.prompt),
      completionTokens: payload.eval_count ?? estimateTokens(text),
      totalTokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0) || estimateTokens(input.prompt) + estimateTokens(text),
    },
    usageSource: reported ? "provider" : "estimated",
    cachedTokens: 0,
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: null,
  };
}

function geminiHttpStatus(error: unknown): number {
  const candidate = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const parsed = Number(candidate?.response?.status ?? candidate?.status ?? candidate?.code);
  return Number.isFinite(parsed) && parsed >= 400 && parsed <= 599 ? parsed : 502;
}

function geminiErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Gemini request failed";
  return scrub(message).slice(0, 500);
}

/**
 * Gemini text/vision-capable generateContent route. The model is pinned by
 * GEMINI_MODEL; a response is never retried on a different model or provider.
 */
async function callGemini(input: GenerateInput, modelOverride?: string): Promise<GenerateResult> {
  const c = config().gemini;
  const model = (modelOverride ?? c.model).trim();
  const guard = evaluateAiPolicy({ provider: "gemini", model });
  if (!guard.allowed) throw new AiSpendingPolicyError(guard);
  if (!c.enabled || !c.key) throw new AiProviderConfigError("gemini", "GEMINI_API_KEY is not set.");
  if (!model) throw new AiProviderConfigError("gemini", "GEMINI_MODEL is not set.");
  const ai = new GoogleGenAI({
    apiKey: c.key,
    apiVersion: process.env.GEMINI_API_VERSION?.trim() || "v1beta",
  });
  const started = Date.now();
  const configForCall = {
    systemInstruction: input.system,
    temperature: input.temperature ?? 0.2,
    maxOutputTokens: input.maxTokens ?? 800,
    thinkingConfig: { thinkingBudget: 0 },
    ...(input.format === "json" ? { responseMimeType: "application/json" } : {}),
  };
  try {
    let text = "";
    let usage: Record<string, number> | null = null;
    if (input.onDelta) {
      const stream = await ai.models.generateContentStream({
        model,
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        config: configForCall,
      });
      for await (const chunk of stream) {
        const delta = chunk.text ?? "";
        if (delta) {
          text += delta;
          input.onDelta(delta);
        }
        if (chunk.usageMetadata) usage = chunk.usageMetadata as unknown as Record<string, number>;
      }
    } else {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: input.prompt }] }],
        config: configForCall,
      });
      text = response.text ?? "";
      usage = response.usageMetadata ? (response.usageMetadata as unknown as Record<string, number>) : null;
    }
    text = text.trim();
    if (!text) {
      throw new AiProviderError("gemini", "Gemini returned no text. The configured model and generation settings were not silently changed.", false);
    }
    const promptTokens = Number(usage?.promptTokenCount ?? 0) || estimateTokens(`${input.system}\n${input.prompt}`);
    const completionTokens = Number(usage?.candidatesTokenCount ?? 0) || estimateTokens(text);
    const totalTokens = Number(usage?.totalTokenCount ?? 0) || promptTokens + completionTokens;
    return {
      text,
      provider: "gemini",
      model,
      usage: { promptTokens, completionTokens, totalTokens },
      usageSource: usage ? "provider" : "estimated",
      cachedTokens: Number(usage?.cachedContentTokenCount ?? 0),
      latencyMs: Date.now() - started,
      costChf: null,
      costStatus: "unverified",
      routedVia: null,
    };
  } catch (error) {
    if (error instanceof AiSpendingPolicyError || error instanceof AiProviderError || error instanceof AiRateLimitedError) throw error;
    const status = geminiHttpStatus(error);
    const message = geminiErrorMessage(error);
    // A Gemini model that is unavailable is a recoverable model-route failure
    // once the local fallback is configured. Authentication and malformed
    // requests remain terminal and fail closed.
    if (status === 404) throw new AiProviderError("gemini", `Model unavailable (HTTP 404): ${message}`, true, 404);
    throw providerHttpFailure("gemini", status, message);
  }
}

/** Local model compatibility for this exact request, including cooldown. */
function localFallbackAvailability(input: GenerateInput) {
  const c = config().ollama;
  const model = ollamaModelFor(input);
  const configured = c.enabled && Boolean(c.base) && Boolean(model);
  const decision = configured ? evaluateAiPolicy({ provider: "ollama", model }) : null;
  const cooldown = configured ? providerCooldown("ollama", model) : null;
  return {
    configured,
    model,
    decision,
    cooldown,
    enabled: Boolean(decision?.allowed) && !cooldown?.remainingMs,
  };
}

function recordProviderFailure(input: GenerateInput, provider: ProviderName, model: string, started: number, message: string): void {
  recordUsage({
    provider,
    model,
    agentKey: input.agentKey,
    workflowId: input.workflowId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: input.source,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    usageSource: "unknown",
    latencyMs: Date.now() - started,
    status: "error",
    error: message,
  });
}

function errorStatus(error: unknown): number | null {
  if (error instanceof AiRateLimitedError) return error.status;
  if (error instanceof AiProviderError) return error.status;
  const match = error instanceof Error ? error.message.match(/HTTP (\d{3})/) : null;
  return match ? Number(match[1]) : null;
}

function routeFailure(error: unknown): { kind: ProviderFailureKind; message: string; retryAfterMs: number | null; status: number | null } {
  const message = scrub(error instanceof Error ? error.message : "provider failure");
  const status = errorStatus(error);
  // The error class is authoritative. A locally raised configuration error can
  // carry wording that the message classifier would not recognise, so it must
  // never be downgraded to a generic transient failure and retried elsewhere.
  const kind: ProviderFailureKind =
    error instanceof AiProviderConfigError
      ? "configuration"
      : classifyProviderFailure(message, status);
  return {
    kind,
    message,
    retryAfterMs: error instanceof AiRateLimitedError ? error.retryAfterMs : null,
    status,
  };
}

function announceQuota(provider: string, model: string, kind: ProviderFailureKind, retryAt: string | null): void {
  if (!["quota_exhausted", "rate_limited", "cooldown"].includes(kind)) return;
  const hour = new Date().toISOString().slice(0, 13);
  notify({
    kind: "provider_quota_exhausted",
    dedupeKey: `provider_quota:${provider}:${model}:${hour}`,
    subject: `${provider} inference route cooling down`,
    body: `${provider}/${model} returned ${kind.replace(/_/g, " ")}. The route is paused${retryAt ? ` until ${retryAt}` : ""} and no repeated requests will be sent. The other verified free tier is tried next, then loopback Ollama when local inference is configured. No paid request is made.`,
  });
}

function announceFallback(fromProvider: ProviderName, primaryModel: string, result: GenerateResult): void {
  const hour = new Date().toISOString().slice(0, 13);
  notify({
    kind: "provider_fallback",
    dedupeKey: `provider_fallback:${fromProvider}:${primaryModel}:${hour}`,
    subject: `${fromProvider} failed; local Ollama fallback handled inference`,
    body: `${fromProvider}/${primaryModel} did not complete the request. Ollama ${result.model} completed it and the actual provider/model was recorded. Task context was preserved.`,
  });
}

function completedUsage(
  input: GenerateInput,
  result: GenerateResult,
  fallback?: { from: ProviderName; reason: string },
): boolean {
  return recordUsage({
    provider: result.provider,
    model: result.model,
    agentKey: input.agentKey,
    workflowId: input.workflowId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    source: input.source,
    usage: result.usage,
    usageSource: result.usageSource,
    cachedTokens: result.cachedTokens,
    latencyMs: result.latencyMs,
    status: "ok",
    routedVia: result.routedVia,
    fallbackFrom: fallback?.from ?? null,
    fallbackReason: fallback?.reason ?? null,
  });
}

/**
 * Gemini, FreeLLMAPI and an explicitly assigned OpenRouter free model are text
 * routes. OpenRouter is opt-in; its assignment never rewrites the default
 * eight-agent map. Gemini Live is deliberately absent: it is a separate voice
 * transport and a Gemini text key can never be selected here by drift.
 */
type RouteCandidate = {
  provider: "gemini" | "freellmapi" | "openrouter" | "ollama";
  model: string;
};

export type TextRouteChain = {
  agentKey: string;
  preference: ReturnType<typeof agentRoutePreference>;
  candidates: RouteCandidate[];
  skipped: Array<{ provider: string; reason: string }>;
};

function routeModel(provider: RouteCandidate["provider"], input: GenerateInput): string | null {
  if (provider === "gemini") return config().gemini.model || null;
  if (provider === "freellmapi") return config().freellmapi.model || null;
  if (provider === "openrouter") return config().openrouter.model || null;
  return input.technical ? config().ollama.coderModel || null : config().ollama.model || null;
}

/**
 * Ordered free-tier chain for one agent call.
 *
 * The agent's assigned provider comes first. Existing Gemini/FreeLLMAPI agents
 * keep their cross-provider free fallback and loopback Ollama. An explicitly
 * assigned OpenRouter agent fails closed on an OpenRouter outage instead of
 * being moved to Ollama.
 */
export function textRouteChain(input: GenerateInput): TextRouteChain {
  const preference = agentRoutePreference(input.agentKey);
  const candidates: RouteCandidate[] = [];
  const skipped: Array<{ provider: string; reason: string }> = [];
  for (const provider of freeTierRouteOrder(input.agentKey)) {
    const model = routeModel(provider, input);
    if (!model) {
      skipped.push({ provider, reason: `${provider} has no configured model.` });
      continue;
    }
    if (provider === "gemini" && !config().gemini.enabled) {
      skipped.push({ provider, reason: "GEMINI_API_KEY is not set." });
      continue;
    }
    if (provider === "freellmapi" && !freeLlmConfigured()) {
      skipped.push({ provider, reason: "FreeLLMAPI is not completely configured." });
      continue;
    }
    if (provider === "openrouter" && !openRouterTextConfig().enabled) {
      skipped.push({ provider, reason: "OPENROUTER_ENABLED is not true." });
      continue;
    }
    if (provider === "openrouter" && !openRouterTextConfig().key) {
      skipped.push({ provider, reason: "OPENROUTER_API_KEY is not set." });
      continue;
    }
    if (provider === "ollama" && !ollamaConfigured()) {
      skipped.push({ provider, reason: "Ollama is not completely configured." });
      continue;
    }
    candidates.push({ provider, model });
  }
  return { agentKey: input.agentKey, preference, candidates, skipped };
}

/**
 * Free-tier-first text routing.
 *
 * Gemini and FreeLLMAPI are tried in the agent's configured order, then local
 * Ollama. A confirmed free-quota exhaustion moves to the next free route and
 * marks that provider exhausted; it never becomes a paid request. A rate limit
 * only cools the route down. Authentication, malformed-request and model-policy
 * failures fail closed without substituting another provider. If no route is
 * authorised, the audited policy refusal is thrown before any fetch.
 */
export async function generateText(input: GenerateInput): Promise<GenerateResult> {
  const requestId = `ai_${randomUUID()}`;
  const requestStarted = Date.now();
  const chain = textRouteChain(input);
  const policyContext = {
    agentKey: input.agentKey,
    workflowId: input.workflowId ?? null,
    taskId: input.taskId ?? null,
    sessionId: input.sessionId ?? null,
    source: input.source ?? (input.taskId ? "task" : "manual"),
  };
  const failures: string[] = [];
  const blockedDecisions: AiPolicyDecision[] = [];
  let attemptsMade = 0;
  let lastFailureKind: ProviderFailureKind | null = null;
  let lastRateLimit: AiRateLimitedError | null = null;
  let fallbackFrom: ProviderName | null = null;
  let fallbackModel = "";
  let fallbackReason: string | null = null;
  let streamed = false;

  const attemptInput = input.onDelta
    ? { ...input, onDelta: (delta: string) => { streamed = true; input.onDelta?.(delta); } }
    : input;

  try {
    if (chain.candidates.length === 0) {
      const provider = chain.preference.provider === "freellmapi" ? "freellmapi" : "gemini";
      const decision = authorizeAiRequest({
        ...policyContext,
        provider,
        model: chain.preference.model,
        operation: "text.generate",
      });
      const gap = chain.preference.gap ?? chain.skipped.map((item) => `${item.provider}: ${item.reason}`).join(" ");
      throw new AiSpendingPolicyError({
        ...decision,
        block_reason: `${decision.block_reason ?? "No authorised text route is available."} ${gap}`.trim(),
      });
    }

    const release = await acquireAiSlot(input.priority ?? 1, input.maxWaitMs ?? 60_000);
    try {
      for (const candidate of chain.candidates) {
        const { provider, model } = candidate;
        const decision = authorizeAiRequest({
          ...policyContext,
          provider,
          model,
          operation: provider === "ollama" ? "text.generate.local" : "text.generate",
        });
        if (!decision.allowed) {
          blockedDecisions.push(decision);
          failures.push(`${provider}: ${decision.block_reason ?? "blocked by policy"}`);
          continue;
        }

        const cooling = providerCooldown(provider, model);
        if (cooling?.remainingMs) {
          failures.push(
            `${provider} ${model} is cooling down for ${Math.ceil(cooling.remainingMs / 1000)}s: ${cooling.reason ?? "route failure"}`,
          );
          continue;
        }
        if (provider === "freellmapi") {
          const gateway = gatewayCooldownStatus();
          if (gateway.remainingMs > 0) {
            failures.push(
              `FreeLLMAPI gateway cooling down for ${Math.ceil(gateway.remainingMs / 1000)}s: ${gateway.reason ?? "route failure"}`,
            );
            continue;
          }
        }

        const attempts = provider === "ollama" ? 1 : config().maxRetries + 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          attemptsMade += 1;
          const started = Date.now();
          markPolicyNetworkTransmitted(decision.correlation_id);
          try {
            const result =
              provider === "gemini"
                ? await callGemini(attemptInput, model)
                : provider === "freellmapi"
                  ? await callFreeLlm(attemptInput)
                  : provider === "openrouter"
                    ? await callOpenRouter(attemptInput)
                    : await callOllama(attemptInput);
            recordProviderSuccess(provider, result.model);
            if (provider === "gemini" || provider === "freellmapi") {
              recordFreeTierSuccess(provider, result.model);
            }
            if (provider === "freellmapi") clearGatewayCooldown();
            const usedFallback = Boolean(fallbackFrom && fallbackFrom !== provider);
            const usageRecorded = completedUsage(
              input,
              result,
              usedFallback && fallbackFrom ? { from: fallbackFrom, reason: fallbackReason ?? "route failure" } : undefined,
            );
            result.diagnostics = {
              requestId,
              provider: result.provider,
              model: result.model,
              httpStatus: 200,
              durationMs: Date.now() - requestStarted,
              errorClass: usedFallback ? lastFailureKind : null,
              retryCount: Math.max(0, attemptsMade - 1),
              fallbackDecision: usedFallback ? provider : "primary",
              fallbackFrom: usedFallback ? fallbackFrom : null,
              fallbackReason: usedFallback ? fallbackReason : null,
              usableContent: result.text.trim().length > 0,
            };
            // The owner notification claims the fallback was recorded, so it is
            // only sent when the usage row actually exists. A failed insert is
            // reported instead of being contradicted by the notification.
            if (usedFallback && fallbackFrom && usageRecorded) {
              announceFallback(fallbackFrom, fallbackModel, result);
            } else if (usedFallback && fallbackFrom && !usageRecorded) {
              notify({
                kind: "provider_fallback",
                dedupeKey: `provider_fallback_unrecorded:${requestId}`,
                subject: "Fallback inference served but not recorded",
                body: `${provider}/${result.model} completed the request after ${fallbackFrom} failed, but the usage row could not be written. Token totals exclude this call until it is reconciled.`,
              });
            }
            return result;
          } catch (error) {
            if (error instanceof AiSpendingPolicyError) throw error;
            const failure = routeFailure(error);
            lastFailureKind = failure.kind;
            if (error instanceof AiRateLimitedError) lastRateLimit = error;
            if (!fallbackFrom) {
              fallbackFrom = provider;
              fallbackModel = model;
              fallbackReason = `${failure.kind.replace(/_/g, " ")}: ${failure.message}`;
            }
            recordProviderFailure(input, provider, model, started, failure.message);
            const cooldown = recordRouteFailure({
              provider,
              model,
              kind: failure.kind,
              message: failure.message,
              retryAfterMs: failure.retryAfterMs,
              attempt,
            });
            announceQuota(provider, model, failure.kind, cooldown.until);
            if (provider === "gemini" || provider === "freellmapi") {
              recordFreeTierFailure({
                provider,
                model,
                kind: failure.kind,
                message: failure.message,
                retryAfterMs: failure.retryAfterMs,
              });
            }
            if (
              provider === "freellmapi" &&
              (failure.kind === "quota_exhausted" || failure.kind === "rate_limited" || failure.kind === "cooldown")
            ) {
              setGatewayCooldown(cooldown.remainingMs || failure.retryAfterMs || 60_000, failure.message);
            }
            failures.push(`${provider} ${model}: ${failure.message}`);

            if (streamed) {
              throw new ProvidersUnavailableError(
                `${provider} stream failed after a partial response: ${failure.message}. No duplicate provider request was attempted.`,
              );
            }
            if (isFailClosedFailure(failure.kind) || error instanceof AiProviderConfigError) {
              if (error instanceof AiProviderConfigError) throw error;
              throw new ProvidersUnavailableError(
                `${provider} ${model} failed: ${failure.message}. This failure class fails closed; no other provider was contacted.`,
              );
            }
            if (!isTransientFailure(failure.kind) || attempt >= attempts) break;
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, failure.kind, failure.retryAfterMs)));
          }
        }
      }

      if (blockedDecisions.length === chain.candidates.length) {
        const primary = blockedDecisions[0];
        throw new AiSpendingPolicyError({
          ...primary,
          block_reason: `${primary.block_reason ?? "External inference blocked."} ${failures.slice(0, 3).join(" ")}`.trim(),
        });
      }
      if (lastRateLimit) throw lastRateLimit;
      throw new ProvidersUnavailableError(
        `All free-tier routes failed; no paid fallback is permitted. ${failures.slice(-3).join(" · ")}`.trim(),
      );
    } finally {
      release();
    }
  } catch (error) {
    const diagnostics: ProviderDiagnostics = {
      requestId,
      provider: null,
      model: null,
      httpStatus: errorStatus(error),
      durationMs: Date.now() - requestStarted,
      errorClass:
        lastFailureKind ??
        classifyProviderFailure(error instanceof Error ? scrub(error.message) : "provider failure", errorStatus(error)),
      retryCount: Math.max(0, attemptsMade - 1),
      fallbackDecision: fallbackFrom
        ? fallbackFrom === "gemini"
          ? "gemini"
          : fallbackFrom === "freellmapi"
            ? "freellmapi"
            : fallbackFrom === "openrouter"
              ? "openrouter"
              : "ollama"
        : "none",
      fallbackFrom: null,
      fallbackReason: null,
      usableContent: false,
    };
    if (error && typeof error === "object") {
      (error as Error & { diagnostics?: ProviderDiagnostics }).diagnostics = diagnostics;
    }
    throw error;
  }
}

export async function generateJson<T>(input: GenerateInput): Promise<T> {
  const result = await generateText({ ...input, format: "json" });
  const cleaned = result.text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error(`${result.provider} did not return JSON.`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

/**
 * Roster counters must equal task-sourced usage rows. Any non-zero drift is a
 * real telemetry fault, not a display rounding difference.
 */
export type AgentAiReconciliation = {
  key: string;
  name: string;
  counterOk: number;
  counterFailed: number;
  usageOk: number;
  usageFailed: number;
  driftOk: number;
  driftFailed: number;
};

export function aiCounterReconciliation(): AgentAiReconciliation[] {
  return all<Omit<AgentAiReconciliation, "driftOk" | "driftFailed">>(
    `SELECT a.key, a.name,
            a.ai_success_count AS counterOk,
            a.ai_failure_count AS counterFailed,
            (SELECT COUNT(*) FROM provider_usage u JOIN tasks t ON t.id = u.task_id AND t.agent_key = u.agent_key
              WHERE u.agent_key = a.key AND u.source = 'task' AND u.status = 'ok') AS usageOk,
            (SELECT COUNT(*) FROM provider_usage u JOIN tasks t ON t.id = u.task_id AND t.agent_key = u.agent_key
              WHERE u.agent_key = a.key AND u.source = 'task' AND u.status = 'error') AS usageFailed
     FROM agents a ORDER BY a.sort`,
  ).map((row) => ({
    ...row,
    driftOk: Number(row.counterOk) - Number(row.usageOk),
    driftFailed: Number(row.counterFailed) - Number(row.usageFailed),
  }));
}

/** Usage visible in the admin view, split by attribution source. */
export function aiUsageBySource(): Array<{ source: string; status: string; calls: number }> {
  return all<{ source: string; status: string; calls: number }>(
    `SELECT COALESCE(source, 'unattributed') AS source, status, COUNT(*) AS calls
     FROM provider_usage GROUP BY 1, 2 ORDER BY 1, 2`,
  );
}

export function usageSummary() {
  return one<{ requests: number; tokens: number; failures: number; unverified: number }>(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS failures,
            COALESCE(SUM(CASE WHEN cost_status IS NULL OR cost_status = 'unverified' THEN 1 ELSE 0 END), 0) AS unverified
     FROM provider_usage`,
  ) ?? { requests: 0, tokens: 0, failures: 0, unverified: 0 };
}

export function recentUsage(limit = 20) {
  return all<{
    provider: string;
    model: string;
    agent_key: string;
    workflow_id: string | null;
    task_id: string | null;
    source: string | null;
    total_tokens: number;
    latency_ms: number;
    status: string;
    error: string | null;
    created_at: string;
    cost_status: string | null;
    routed_platform: string | null;
    routed_model: string | null;
    fallback_from: string | null;
    fallback_reason: string | null;
  }>(
    "SELECT provider, model, agent_key, workflow_id, task_id, source, total_tokens, latency_ms, status, error, created_at, cost_status, routed_platform, routed_model, fallback_from, fallback_reason FROM provider_usage ORDER BY id DESC LIMIT ?",
    [limit],
  );
}
