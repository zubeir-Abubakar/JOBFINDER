import { all, nowIso, one, run } from "./db.ts";
import { getSetting, setSetting } from "./settings";

/**
 * Shared AI provider service.
 *
 * FreeLLMAPI (local OpenAI-compatible gateway) is the primary and only
 * permitted inference path. When it is configured, no other provider is ever
 * tried — the service fails closed instead of silently falling back to a paid
 * or local model.
 *
 * Gemini/OpenRouter/Ollama remain in the file only so an existing installation
 * that explicitly enabled them can still report health; they are never used as
 * a fallback while FreeLLMAPI is configured, and Ollama must be explicitly
 * enabled to run at all.
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

export type GenerateResult = {
  text: string;
  provider: ProviderName;
  model: string;
  usage: Usage;
  latencyMs: number;
  costChf: null;
  costStatus: CostStatus;
  routedVia: RoutedVia;
};

export type GenerateInput = {
  agentKey: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  technical?: boolean;
  workflowId?: string | null;
  /** The task that caused this call. Required for source="task". */
  taskId?: string | null;
  source?: Exclude<AiCallSource, "legacy">;
  priority?: AiPriority;
  maxWaitMs?: number;
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

export function isTemporaryAiError(error: unknown): boolean {
  return (
    error instanceof AiRateLimitedError ||
    error instanceof ProvidersUnavailableError ||
    (error instanceof Error && isRateLimitMessage(error.message))
  );
}

const HEALTH_TTL_MS = 30_000;
type Cache = { at: number; items: ProviderHealth[] };
type AiSlotWaiter = { priority: number; queuedAt: number; grant: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type AiSlotState = { active: number; waiters: AiSlotWaiter[] };
const g = globalThis as typeof globalThis & {
  __atwProviderHealth?: Cache;
  __atwOpenRouterBlockedUntil?: number;
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
    maxRetries: Math.max(0, Math.min(4, Number(env.AI_MAX_RETRIES ?? "2") || 2)),
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
      model: env.GEMINI_MODEL ?? "gemini-2.0-flash",
      base: "https://generativelanguage.googleapis.com/v1beta",
    },
    openrouter: {
      enabled: (env.OPENROUTER_ENABLED ?? "false") === "true" && Boolean(env.OPENROUTER_API_KEY),
      key: env.OPENROUTER_API_KEY ?? "",
      model: env.OPENROUTER_MODEL ?? "openrouter/free",
      allowPaid: (env.OPENROUTER_ALLOW_PAID_MODELS ?? "false") === "true",
    },
    ollama: {
      enabled: (env.OLLAMA_ENABLED ?? "false") === "true",
      base: (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, ""),
      model: env.OLLAMA_MODEL ?? "llama3.2:3b",
      coderModel: env.OLLAMA_CODER_MODEL ?? "qwen2.5-coder:1.5b",
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

/** Gateway configured AND the zero-cost model policy passes. */
export function freeLlmUsable(): boolean {
  return freeLlmConfigured() && freeLlmPolicyIssue() === null;
}

function legacyConfigured(): boolean {
  const c = config();
  return Boolean(c.gemini.key) || c.openrouter.enabled || c.ollama.enabled;
}

/** One shared answer for the Coordinator and every specialist. */
export function providerConfigured(): boolean {
  return freeLlmUsable() || legacyConfigured();
}

/** Synchronous view of the latest health check in this process, if any. */
export type ProviderSnapshot = {
  configured: boolean;
  available: boolean | null;
  detail: string;
  model: string;
  checkedAt: string | null;
};

export function providerStatusSnapshot(): ProviderSnapshot {
  const cooling = gatewayCooldownStatus();
  if (cooling.remainingMs > 0) {
    return {
      configured: freeLlmConfigured() || legacyConfigured(),
      available: false,
      detail: `FreeLLMAPI is cooling down for ${Math.ceil(cooling.remainingMs / 1000)}s. ${cooling.reason ?? ""}`.trim(),
      model: config().freellmapi.model,
      checkedAt: new Date().toISOString(),
    };
  }
  const cached = g.__atwProviderHealth;
  const fl = cached?.items.find((item) => item.name === "freellmapi");
  if (freeLlmConfigured()) {
    return {
      configured: true,
      available: fl ? fl.available : null,
      detail: fl?.detail ?? "Health has not been checked in this process yet.",
      model: fl?.model ?? config().freellmapi.model,
      checkedAt: cached ? new Date(cached.at).toISOString() : null,
    };
  }
  const usable = cached ? cached.items.some((item) => item.enabled && item.available) : null;
  return {
    configured: legacyConfigured(),
    available: usable,
    detail: fl?.detail ?? "FreeLLMAPI is not configured.",
    model: fl?.model ?? config().freellmapi.model,
    checkedAt: cached ? new Date(cached.at).toISOString() : null,
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
  const base: ProviderHealth = {
    name: "freellmapi",
    label: "FreeLLMAPI (local gateway)",
    enabled: c.enabled,
    configured: freeLlmConfigured(),
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
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
    return {
      ...base,
      available: true,
      detail: `${models.length} models available. Pinned ${c.model} is catalogued and allowlisted; resolution must be the pinned id or a declared alias. Cost remains unverified (the gateway publishes no pricing).`,
    };
  } catch (error) {
    base.latencyMs = Date.now() - started;
    return { ...base, detail: classifyGatewayError(error, c.base).detail };
  }
}

async function geminiHealth(): Promise<ProviderHealth> {
  const c = config().gemini;
  const base: ProviderHealth = {
    name: "gemini",
    label: "Google Gemini (not permitted)",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
  };
  if (!c.enabled) return { ...base, detail: "GEMINI_API_KEY is not set. FreeLLMAPI is the only permitted gateway." };
  return { ...base, detail: "Configured but not used: fallback to Gemini is disabled." };
}

async function openRouterHealth(): Promise<ProviderHealth> {
  const c = config().openrouter;
  const base: ProviderHealth = {
    name: "openrouter",
    label: "OpenRouter (not permitted)",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
  };
  if (!c.enabled) return { ...base, detail: "OPENROUTER_ENABLED is false. FreeLLMAPI is the only permitted gateway." };
  return { ...base, detail: "Configured but not used: fallback to OpenRouter is disabled." };
}

async function ollamaHealth(): Promise<ProviderHealth> {
  const c = config().ollama;
  const base: ProviderHealth = {
    name: "ollama",
    label: "Ollama (local inference)",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: "",
    latencyMs: null,
  };
  if (!c.enabled) return { ...base, detail: "OLLAMA_ENABLED is false. No local model is loaded or contacted." };
  return { ...base, detail: "Explicitly enabled, but not used while FreeLLMAPI is configured." };
}

export async function providerHealth(force = false): Promise<ProviderHealth[]> {
  const cached = g.__atwProviderHealth;
  if (!force && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.items;
  const items = await Promise.all([freeLlmHealth(), geminiHealth(), openRouterHealth(), ollamaHealth()]);
  const checkedAt = new Date().toISOString();
  const stamped = items.map((item) => ({ ...item, checkedAt }));
  // Do not cache a rate-limited health result: once the advertised cooldown
  // expires, the next call must be allowed to probe the gateway immediately.
  const rateLimited = stamped.some(
    (item) => item.name === "freellmapi" && /rate limited|cooldown/i.test(item.detail),
  );
  if (!rateLimited) g.__atwProviderHealth = { at: Date.now(), items: stamped };
  return stamped;
}

export function recordUsage(input: {
  provider: string;
  model: string;
  agentKey: string;
  workflowId?: string | null;
  taskId?: string | null;
  source?: AiCallSource;
  usage: Usage;
  latencyMs: number;
  status: string;
  error?: string | null;
  routedVia?: RoutedVia;
}) {
  // A call cannot claim to be task-bound without a task. Misconfiguration is
  // recorded as a manual call instead of creating unattributable task usage.
  const requested = input.source ?? (input.taskId ? "task" : "manual");
  const source: AiCallSource = requested === "task" && !input.taskId ? "manual" : requested;
  try {
    // cost_chf stays 0 for schema compatibility but cost_status records that the
    // figure is unverified: the gateway publishes no pricing metadata.
    run(
      `INSERT INTO provider_usage (provider, model, agent_key, workflow_id, task_id, source, prompt_tokens, completion_tokens, total_tokens, cost_chf, cost_status, routed_platform, routed_model, latency_ms, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'unverified', ?, ?, ?, ?, ?, ?)`,
      [
        input.provider,
        input.model,
        input.agentKey,
        input.workflowId ?? null,
        input.taskId ?? null,
        source,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.totalTokens,
        input.routedVia?.platform ?? null,
        input.routedVia?.model ?? null,
        input.latencyMs,
        input.status,
        input.error ? scrub(input.error) : null,
        nowIso(),
      ],
    );
    // One place updates the roster counters, so they are exactly the count of
    // task-sourced calls. Attempts count individually; a retry is a failed call.
    if (source === "task" && input.taskId) {
      if (input.status === "ok") {
        run("UPDATE agents SET ai_success_count = ai_success_count + 1 WHERE key = ?", [input.agentKey]);
      } else if (input.status === "error") {
        run("UPDATE agents SET ai_failure_count = ai_failure_count + 1 WHERE key = ?", [input.agentKey]);
      }
    }
  } catch (error) {
    // Usage tracking must never break an agent run, but a silent failure would
    // make the roster lie, so it is reported on the server log (scrubbed).
    console.error("[ai-usage] failed to record call", scrub(error instanceof Error ? error.message : "unknown error"));
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function callFreeLlm(input: GenerateInput): Promise<GenerateResult> {
  const c = config().freellmapi;
  assertPermittedModel(c.model);
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
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string };
    _routed_via?: { platform?: string; model?: string };
  };
  if (!response.ok) {
    const message = payload.error?.message ?? `FreeLLMAPI HTTP ${response.status}`;
    if (response.status === 429 || isRateLimitMessage(message)) {
      throw new AiRateLimitedError(message, parseRetryAfter(response.headers, payload), response.status);
    }
    throw new Error(message);
  }
  const text = (payload.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("FreeLLMAPI returned an empty completion.");
  const model = String(payload.model ?? c.model);
  // Fail closed on any substitution (e.g. an alias rewritten to a provider id).
  assertPinnedResolution(c.model, model);
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
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: payload._routed_via
      ? { platform: payload._routed_via.platform ?? null, model: payload._routed_via.model ?? null }
      : null,
  };
}

async function callGemini(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
  const c = config().gemini;
  const started = Date.now();
  const response = await fetch(`${c.base}/models/${encodeURIComponent(c.model)}:generateContent?key=${encodeURIComponent(c.key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: input.system }] },
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        temperature: input.temperature ?? 0.2,
        maxOutputTokens: input.maxTokens ?? 800,
      },
    }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(payload.error?.message ?? `Gemini HTTP ${response.status}`);
  const text = (payload.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) throw new Error("Gemini returned an empty candidate.");
  const usage = {
    promptTokens: payload.usageMetadata?.promptTokenCount ?? estimateTokens(input.prompt),
    completionTokens: payload.usageMetadata?.candidatesTokenCount ?? estimateTokens(text),
    totalTokens: payload.usageMetadata?.totalTokenCount ?? estimateTokens(input.prompt) + estimateTokens(text),
  };
  return { text, provider: "gemini", model: c.model, usage, latencyMs: Date.now() - started, costChf: null, costStatus: "unverified", routedVia: null };
}

async function callOpenRouter(input: GenerateInput, signal: AbortSignal): Promise<GenerateResult> {
  const c = config().openrouter;
  if (!c.allowPaid && c.model !== "openrouter/free" && !c.model.endsWith(":free")) {
    throw new Error("Blocked: the configured OpenRouter model is not a verified free model.");
  }
  const started = Date.now();
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "AT AI Workforce",
    },
    signal,
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
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    error?: { message?: string; code?: number | string };
  };
  if (!response.ok) {
    if (response.status === 402 || /insufficient|credit/i.test(payload.error?.message ?? "")) {
      g.__atwOpenRouterBlockedUntil = Date.now() + 10 * 60_000;
    }
    throw new Error(payload.error?.message ?? `OpenRouter HTTP ${response.status}`);
  }
  const text = (payload.choices?.[0]?.message?.content ?? "").trim();
  if (!text) {
    g.__atwOpenRouterBlockedUntil = Date.now() + 5 * 60_000;
    throw new Error("OpenRouter returned an empty completion; marked unavailable and falling back.");
  }
  return {
    text,
    provider: "openrouter",
    model: c.model,
    usage: {
      promptTokens: payload.usage?.prompt_tokens ?? estimateTokens(input.prompt),
      completionTokens: payload.usage?.completion_tokens ?? estimateTokens(text),
      totalTokens: payload.usage?.total_tokens ?? estimateTokens(input.prompt) + estimateTokens(text),
    },
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: null,
  };
}

async function callOllama(input: GenerateInput, health: ProviderHealth | undefined): Promise<GenerateResult> {
  const c = config().ollama;
  const installed = health?.models ?? [];
  const preferred = input.technical ? c.coderModel : c.model;
  const model = installed.includes(preferred) ? preferred : installed.includes(c.model) ? c.model : installed[0];
  if (!model) throw new Error("No installed Ollama model is available.");
  const started = Date.now();
  const response = await fetch(`${c.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: timeout(90_000),
    body: JSON.stringify({
      model,
      stream: false,
      keep_alive: "5m",
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
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? `Ollama HTTP ${response.status}`);
  const text = (payload.message?.content ?? "").trim();
  if (!text) throw new Error("Ollama returned an empty completion.");
  return {
    text,
    provider: "ollama",
    model,
    usage: {
      promptTokens: payload.prompt_eval_count ?? estimateTokens(input.prompt),
      completionTokens: payload.eval_count ?? estimateTokens(text),
      totalTokens: (payload.prompt_eval_count ?? 0) + (payload.eval_count ?? 0) || estimateTokens(input.prompt) + estimateTokens(text),
    },
    latencyMs: Date.now() - started,
    costChf: null,
    costStatus: "unverified",
    routedVia: null,
  };
}

export async function generateText(input: GenerateInput): Promise<GenerateResult> {
  const attempts = config().maxRetries + 1;

  // Primary path: FreeLLMAPI only. No fallback of any kind.
  if (freeLlmConfigured()) {
    const release = await acquireAiSlot(input.priority ?? 1, input.maxWaitMs ?? 60_000);
    try {
      const cooling = gatewayCooldownStatus();
      if (cooling.remainingMs > 0) {
        throw new AiRateLimitedError(
          `FreeLLMAPI is cooling down for ${Math.ceil(cooling.remainingMs / 1000)}s. ${cooling.reason ?? ""}`.trim(),
          cooling.remainingMs,
          429,
        );
      }
      const health = await providerHealth();
      const coolingAfterHealth = gatewayCooldownStatus();
      if (coolingAfterHealth.remainingMs > 0) {
        throw new AiRateLimitedError(
          `FreeLLMAPI is cooling down for ${Math.ceil(coolingAfterHealth.remainingMs / 1000)}s. ${coolingAfterHealth.reason ?? ""}`.trim(),
          coolingAfterHealth.remainingMs,
          429,
        );
      }
      const gateway = health.find((item) => item.name === "freellmapi");
    if (!gateway?.available) {
      const detail = `FreeLLMAPI is unavailable: ${gateway?.detail ?? "no health result"}. No fallback provider was attempted.`;
      // A pre-flight failure is still an AI execution attempt. Recording it keeps
      // the roster counters aligned with the calls the agents actually tried.
      recordUsage({
        provider: "freellmapi",
        model: config().freellmapi.model,
        agentKey: input.agentKey,
        workflowId: input.workflowId,
        taskId: input.taskId,
        source: input.source,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        status: "error",
        error: detail,
      });
      throw new ProvidersUnavailableError(detail);
    }
    const errors: string[] = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const result = await callFreeLlm(input);
        clearGatewayCooldown();
        recordUsage({
          provider: result.provider,
          model: result.model,
          agentKey: input.agentKey,
          workflowId: input.workflowId,
          taskId: input.taskId,
          source: input.source,
          usage: result.usage,
          latencyMs: result.latencyMs,
          status: "ok",
          routedVia: result.routedVia,
        });
        return result;
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : "gateway failure");
        recordUsage({
          provider: "freellmapi",
          model: config().freellmapi.model,
          agentKey: input.agentKey,
          workflowId: input.workflowId,
          taskId: input.taskId,
          source: input.source,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: Date.now() - started,
          status: "error",
          error: message,
        });
        if (error instanceof AiRateLimitedError) {
          setGatewayCooldown(error.retryAfterMs, message);
          throw error;
        }
        errors.push(`attempt ${attempt}: ${message}`);
        const permanent = /refused|blocked|insufficient|401|403|404|empty|not offered|credit|abort|timed? ?out|high demand/i.test(message);
        if (permanent) break;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
    throw new ProvidersUnavailableError(`FreeLLMAPI failed and no fallback is permitted. ${errors.slice(-2).join(" · ")}`);
    } finally {
      release();
    }
  }

  // Legacy path, reached only when FreeLLMAPI is NOT configured and a provider
  // was explicitly enabled. Never used as a fallback from the primary gateway.
  const health = await providerHealth();
  const order: ProviderHealth[] = ["gemini", "openrouter", "ollama"]
    .map((name) => health.find((item) => item.name === name))
    .filter((item): item is ProviderHealth => Boolean(item && item.enabled));

  const errors: string[] = [];
  for (const provider of order) {
    if (!provider.available) {
      errors.push(`${provider.name}: ${provider.detail}`);
      continue;
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      try {
        const result =
          provider.name === "gemini"
            ? await callGemini(input, timeout(20_000))
            : provider.name === "openrouter"
              ? await callOpenRouter(input, timeout(20_000))
              : await callOllama(input, provider);
        recordUsage({
          provider: result.provider,
          model: result.model,
          agentKey: input.agentKey,
          workflowId: input.workflowId,
          taskId: input.taskId,
          source: input.source,
          usage: result.usage,
          latencyMs: result.latencyMs,
          status: "ok",
          routedVia: result.routedVia,
        });
        return result;
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : "provider failure");
        recordUsage({
          provider: provider.name,
          model: provider.model,
          agentKey: input.agentKey,
          workflowId: input.workflowId,
          taskId: input.taskId,
          source: input.source,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          latencyMs: Date.now() - started,
          status: "error",
          error: message,
        });
        errors.push(`${provider.name} attempt ${attempt}: ${message}`);
        const permanent = /blocked|insufficient|401|403|404|empty|not offered|credit|abort|timed? ?out|high demand/i.test(message);
        if (permanent) break;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  throw new ProvidersUnavailableError(
    `All AI providers failed. ${errors.slice(-3).join(" · ")}`.trim(),
  );
}

export async function generateJson<T>(input: GenerateInput): Promise<T> {
  const result = await generateText(input);
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
            (SELECT COUNT(*) FROM provider_usage u WHERE u.agent_key = a.key AND u.source = 'task' AND u.status = 'ok') AS usageOk,
            (SELECT COUNT(*) FROM provider_usage u WHERE u.agent_key = a.key AND u.source = 'task' AND u.status = 'error') AS usageFailed
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
  }>(
    "SELECT provider, model, agent_key, workflow_id, task_id, source, total_tokens, latency_ms, status, error, created_at, cost_status, routed_platform, routed_model FROM provider_usage ORDER BY id DESC LIMIT ?",
    [limit],
  );
}
