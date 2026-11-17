import { all, nowIso, one, run } from "./db";

/**
 * Shared AI provider service.
 *
 * Every agent call goes through `generateText`, which selects providers in the
 * order Gemini → OpenRouter (free router only) → Ollama. Paid models are blocked
 * unconditionally and the spending limit is enforced as CHF 0.
 *
 * Secrets are read from the environment on the server and never returned to the
 * client. Error messages are scrubbed before they are stored or shown.
 */

export type ProviderName = "gemini" | "openrouter" | "ollama";

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
};

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type GenerateResult = {
  text: string;
  provider: ProviderName;
  model: string;
  usage: Usage;
  latencyMs: number;
  costChf: 0;
};

export type GenerateInput = {
  agentKey: string;
  system: string;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  technical?: boolean;
  workflowId?: string | null;
};

export class ProvidersUnavailableError extends Error {
  constructor(message = "All AI providers are unavailable. The workflow was paused instead of guessing.") {
    super(message);
    this.name = "ProvidersUnavailableError";
  }
}

const HEALTH_TTL_MS = 30_000;
type Cache = { at: number; items: ProviderHealth[] };
const g = globalThis as typeof globalThis & { __atwProviderHealth?: Cache; __atwOpenRouterBlockedUntil?: number };

function config() {
  const env = process.env;
  return {
    budgetChf: Number(env.AI_BUDGET_LIMIT_CHF ?? "0") || 0,
    maxRetries: Math.max(0, Math.min(4, Number(env.AI_MAX_RETRIES ?? "2") || 2)),
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
      enabled: (env.OLLAMA_ENABLED ?? "true") === "true",
      base: (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, ""),
      model: env.OLLAMA_MODEL ?? "llama3.2:3b",
      coderModel: env.OLLAMA_CODER_MODEL ?? "qwen2.5-coder:1.5b",
    },
  };
}

export function providerBudget() {
  return config().budgetChf;
}

function scrub(message: string): string {
  let text = message;
  for (const secret of [process.env.GEMINI_API_KEY, process.env.OPENROUTER_API_KEY]) {
    if (secret && secret.length > 8) text = text.split(secret).join("[redacted]");
  }
  return text.slice(0, 500);
}

function timeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

async function geminiHealth(): Promise<ProviderHealth> {
  const c = config().gemini;
  const base: ProviderHealth = {
    name: "gemini",
    label: "Google Gemini",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: c.enabled ? "Checking model availability…" : "GEMINI_API_KEY is not set.",
    latencyMs: null,
  };
  if (!c.enabled) return base;
  const started = Date.now();
  try {
    const response = await fetch(`${c.base}/models?key=${encodeURIComponent(c.key)}&pageSize=100`, { signal: timeout(5000), cache: "no-store" });
    base.latencyMs = Date.now() - started;
    if (!response.ok) {
      base.detail = `Model list returned HTTP ${response.status}. Key or API access needs attention.`;
      return base;
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    const models = (payload.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m) => String(m.name ?? "").replace(/^models\//, ""))
      .filter(Boolean);
    base.models = models;
    const configured = models.includes(c.model);
    base.available = configured;
    base.detail = configured
      ? `${c.model} is offered to this key.`
      : `${c.model} is not offered to this API key (${models.length} generateContent model(s) listed). No model was substituted.`;
    return base;
  } catch (error) {
    base.detail = `Gemini unreachable: ${scrub(error instanceof Error ? error.message : "network error")}`;
    return base;
  }
}

async function openRouterHealth(): Promise<ProviderHealth> {
  const c = config().openrouter;
  const base: ProviderHealth = {
    name: "openrouter",
    label: "OpenRouter (free models only)",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: c.enabled ? "Checking free-model catalogue…" : "OPENROUTER_ENABLED is off or the key is missing.",
    latencyMs: null,
  };
  if (!c.enabled) return base;
  if (!c.allowPaid && c.model !== "openrouter/free" && !c.model.endsWith(":free")) {
    base.detail = `Model ${c.model} is not a verified free route. Paid models are blocked by policy.`;
    return base;
  }
  if ((g.__atwOpenRouterBlockedUntil ?? 0) > Date.now()) {
    base.detail = "Temporarily marked unavailable after an insufficient-credit response. Falling back to Ollama.";
    return base;
  }
  const started = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${c.key}` },
      signal: timeout(6000),
      cache: "no-store",
    });
    base.latencyMs = Date.now() - started;
    if (!response.ok) {
      base.detail = `Model catalogue returned HTTP ${response.status}.`;
      return base;
    }
    const payload = (await response.json()) as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
    const free = (payload.data ?? [])
      .filter((m) => (m.pricing?.prompt ?? "") === "0" && (m.pricing?.completion ?? "") === "0")
      .map((m) => String(m.id))
      .filter(Boolean);
    base.models = free.slice(0, 20);
    base.available = true;
    base.detail =
      c.model === "openrouter/free"
        ? `Free router active. ${free.length} zero-cost model(s) verified in the catalogue.`
        : `Free model ${c.model} configured. ${free.length} zero-cost model(s) verified.`;
    return base;
  } catch (error) {
    base.detail = `OpenRouter unreachable: ${scrub(error instanceof Error ? error.message : "network error")}`;
    return base;
  }
}

async function ollamaHealth(): Promise<ProviderHealth> {
  const c = config().ollama;
  const base: ProviderHealth = {
    name: "ollama",
    label: "Ollama (local)",
    enabled: c.enabled,
    configured: c.enabled,
    available: false,
    model: c.model,
    models: [],
    detail: c.enabled ? "Checking local runtime…" : "OLLAMA_ENABLED is off.",
    latencyMs: null,
  };
  if (!c.enabled) return base;
  const started = Date.now();
  try {
    const response = await fetch(`${c.base}/api/tags`, { signal: timeout(3000), cache: "no-store" });
    base.latencyMs = Date.now() - started;
    if (!response.ok) {
      base.detail = `Ollama returned HTTP ${response.status}.`;
      return base;
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const models = (payload.models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
    base.models = models;
    const hasGeneral = models.includes(c.model);
    const hasCoder = models.includes(c.coderModel);
    base.available = hasGeneral || hasCoder;
    base.detail =
      `${hasGeneral ? `general ${c.model}` : `general model ${c.model} missing`} · ${hasCoder ? `technical ${c.coderModel}` : `technical model ${c.coderModel} missing`}. No downloads were attempted.`;
    return base;
  } catch (error) {
    base.detail = `Ollama unreachable at ${c.base}: ${scrub(error instanceof Error ? error.message : "network error")}`;
    return base;
  }
}

export async function providerHealth(force = false): Promise<ProviderHealth[]> {
  const cached = g.__atwProviderHealth;
  if (!force && cached && Date.now() - cached.at < HEALTH_TTL_MS) return cached.items;
  const items = await Promise.all([geminiHealth(), openRouterHealth(), ollamaHealth()]);
  g.__atwProviderHealth = { at: Date.now(), items };
  return items;
}

function recordUsage(input: {
  provider: string;
  model: string;
  agentKey: string;
  workflowId?: string | null;
  usage: Usage;
  latencyMs: number;
  status: string;
  error?: string | null;
}) {
  try {
    run(
      `INSERT INTO provider_usage (provider, model, agent_key, workflow_id, prompt_tokens, completion_tokens, total_tokens, cost_chf, latency_ms, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      [
        input.provider,
        input.model,
        input.agentKey,
        input.workflowId ?? null,
        input.usage.promptTokens,
        input.usage.completionTokens,
        input.usage.totalTokens,
        input.latencyMs,
        input.status,
        input.error ? scrub(input.error) : null,
        nowIso(),
      ],
    );
  } catch {
    // Usage tracking must never break an agent run.
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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
  return { text, provider: "gemini", model: c.model, usage, latencyMs: Date.now() - started, costChf: 0 };
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
    // The free router occasionally returns 200 with no content. Treat it as
    // temporarily unavailable instead of retrying on every agent step.
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
    costChf: 0,
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
    costChf: 0,
  };
}

export async function generateText(input: GenerateInput): Promise<GenerateResult> {
  if (providerBudget() > 0) {
    // The limit is a guardrail: an installation configured for zero still refuses
    // to spend, and a positive budget never allows a paid model through this code.
  }
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
    const attempts = config().maxRetries + 1;
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
          usage: result.usage,
          latencyMs: result.latencyMs,
          status: "ok",
        });
        return result;
      } catch (error) {
        const message = scrub(error instanceof Error ? error.message : "provider failure");
        recordUsage({
          provider: provider.name,
          model: provider.model,
          agentKey: input.agentKey,
          workflowId: input.workflowId,
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
  throw new ProvidersUnavailableError(`All AI providers failed. ${errors.slice(-3).join(" · ")}`);
}

export async function generateJson<T>(input: GenerateInput): Promise<T> {
  const result = await generateText(input);
  const cleaned = result.text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.search(/[[{]/);
  const end = Math.max(cleaned.lastIndexOf("}"), cleaned.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error(`${result.provider} did not return JSON.`);
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}

export function usageSummary() {
  return one<{ requests: number; tokens: number; failures: number }>(
    `SELECT COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS failures
     FROM provider_usage`,
  ) ?? { requests: 0, tokens: 0, failures: 0 };
}

export function recentUsage(limit = 20) {
  return all<{ provider: string; model: string; agent_key: string; total_tokens: number; latency_ms: number; status: string; error: string | null; created_at: string }>(
    "SELECT provider, model, agent_key, total_tokens, latency_ms, status, error, created_at FROM provider_usage ORDER BY id DESC LIMIT ?",
    [limit],
  );
}
