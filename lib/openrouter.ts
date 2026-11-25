import { isFreeOpenRouterModel } from "./free-tier";

/**
 * OpenRouter's OpenAI-compatible API is a free-model-only additional route.
 *
 * The public model list is not proof that a request is authorised: OpenRouter
 * also requires a valid key. Every text or speech call therefore validates the
 * key and the exact model's catalogue pricing before inference. The dynamic
 * `openrouter/free` router is deliberately refused because its upstream and
 * price are selected after the request.
 */

export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_HEYGEN_TTS_MODEL = "heygen/heygen-voice-1-turbo:free";
export const OPENROUTER_HEYGEN_TTS_PROVIDER = "heygen";
export const OPENROUTER_HEYGEN_DEFAULT_VOICE = "nadine";
export const OPENROUTER_HEYGEN_EXPIRES_AT = "2026-11-30";
export const OPENROUTER_HEYGEN_VOICES = [
  "nadine",
  "tabitha",
  "bram",
  "gareth",
  "noelle",
  "meredith",
  "sabrina",
  "lucian",
  "weston",
  "vincent",
] as const;

export type OpenRouterModality = "text" | "speech";
export type OpenRouterTtsVoice = (typeof OPENROUTER_HEYGEN_VOICES)[number];

export type OpenRouterTextConfig = {
  enabled: boolean;
  key: string;
  baseUrl: string;
  model: string;
  assignedAgents: string[];
};

export type OpenRouterTtsConfig = {
  enabled: boolean;
  key: string;
  baseUrl: string;
  model: string;
  voice: OpenRouterTtsVoice;
  provider: string;
  expiresAt: string | null;
};

export type OpenRouterCatalogueModel = {
  id: string;
  name?: string;
  canonical_slug?: string;
  pricing?: Record<string, string | number>;
  expiration_date?: string | null;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_voices?: string[];
  endpoints?: string[];
};

export type OpenRouterCatalogue = {
  models: OpenRouterCatalogueModel[];
  fetchedAt: string;
};

export type OpenRouterCredential = {
  valid: true;
  checkedAt: string;
};

export class OpenRouterRequestError extends Error {
  kind: "authentication" | "rate_limit" | "unavailable" | "catalogue" | "configuration";
  status: number | null;
  retryAfterMs: number | null;
  constructor(
    kind: OpenRouterRequestError["kind"],
    message: string,
    status: number | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "OpenRouterRequestError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type OpenRouterFreeModelValidation =
  | {
      ok: true;
      id: string;
      model: OpenRouterCatalogueModel;
      pricing: Record<string, string | number>;
      expiresAt: string | null;
      verifiedAt: string;
    }
  | {
      ok: false;
      code:
        | "disabled"
        | "missing_key"
        | "invalid_model"
        | "paid_model"
        | "wrong_modality"
        | "not_catalogued"
        | "expired"
        | "authentication"
        | "rate_limit"
        | "provider_unavailable"
        | "catalogue";
      reason: string;
      expiresAt: string | null;
    };

const g = globalThis as typeof globalThis & {
  __atwOpenRouterCatalogue?: Partial<Record<OpenRouterModality, { at: number; value: OpenRouterCatalogue }>>;
  __atwOpenRouterCredential?: { at: number; value: OpenRouterCredential };
};

const CATALOGUE_TTL_MS = 10 * 60_000;
const CREDENTIAL_TTL_MS = 30_000;

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normaliseBase(raw: string): string {
  return raw.replace(/\/+$/, "");
}

export function openRouterTextConfig(): OpenRouterTextConfig {
  return {
    enabled: env("OPENROUTER_ENABLED") === "true",
    key: env("OPENROUTER_API_KEY"),
    baseUrl: normaliseBase(env("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL),
    model: env("OPENROUTER_MODEL"),
    assignedAgents: csv(process.env.OPENROUTER_ASSIGNED_AGENTS),
  };
}

export function openRouterTtsConfig(): OpenRouterTtsConfig {
  const candidateVoice = env("OPENROUTER_TTS_VOICE") || OPENROUTER_HEYGEN_DEFAULT_VOICE;
  const voice = (OPENROUTER_HEYGEN_VOICES as readonly string[]).includes(candidateVoice)
    ? (candidateVoice as OpenRouterTtsVoice)
    : OPENROUTER_HEYGEN_DEFAULT_VOICE;
  const configuredExpiry = env("OPENROUTER_TTS_EXPIRES_AT") || OPENROUTER_HEYGEN_EXPIRES_AT;
  return {
    enabled: env("OPENROUTER_TTS_ENABLED") === "true",
    key: env("OPENROUTER_API_KEY"),
    baseUrl: normaliseBase(env("OPENROUTER_BASE_URL") || OPENROUTER_DEFAULT_BASE_URL),
    model: env("OPENROUTER_TTS_MODEL") || OPENROUTER_HEYGEN_TTS_MODEL,
    voice,
    provider: env("OPENROUTER_TTS_PROVIDER") || OPENROUTER_HEYGEN_TTS_PROVIDER,
    expiresAt: configuredExpiry || null,
  };
}

export function openRouterAssignedTo(agentKey: string): boolean {
  return openRouterTextConfig().assignedAgents.includes(agentKey);
}

export function openRouterTextConfigured(): boolean {
  const c = openRouterTextConfig();
  return c.enabled && Boolean(c.key) && Boolean(c.baseUrl) && Boolean(c.model);
}

export function openRouterTtsConfigured(): boolean {
  const c = openRouterTtsConfig();
  return c.enabled && Boolean(c.key) && Boolean(c.baseUrl) && Boolean(c.model);
}

/** Synchronous name/expiry gate; the catalogue and key are checked before inference. */
export function openRouterTextPolicyIssue(model = openRouterTextConfig().model): string | null {
  const c = openRouterTextConfig();
  if (!c.enabled) return "OPENROUTER_ENABLED is not true. No OpenRouter request is transmitted.";
  if (!c.key) return "OPENROUTER_API_KEY is not set. No OpenRouter request is transmitted.";
  if (!model) return "OPENROUTER_MODEL is not set. No model is guessed and no request is transmitted.";
  if (!isFreeOpenRouterModel(model)) {
    return `${model} is not an exact free model id ending in :free. Paid models and dynamic routers are refused.`;
  }
  return null;
}

export function openRouterTtsPolicyIssue(model = openRouterTtsConfig().model): string | null {
  const c = openRouterTtsConfig();
  if (!c.enabled) return "OPENROUTER_TTS_ENABLED is not true. Chief speech is not configured.";
  if (!c.key) return "OPENROUTER_API_KEY is not set. Chief speech is not configured.";
  if (model !== OPENROUTER_HEYGEN_TTS_MODEL) {
    return `Chief speech requires the exact free model ${OPENROUTER_HEYGEN_TTS_MODEL}; ${model || "no model"} is refused.`;
  }
  if (c.provider !== OPENROUTER_HEYGEN_TTS_PROVIDER) {
    return `Chief speech requires provider ${OPENROUTER_HEYGEN_TTS_PROVIDER}; ${c.provider || "no provider"} is refused.`;
  }
  const expiry = c.expiresAt ? Date.parse(c.expiresAt) : NaN;
  if (!Number.isFinite(expiry)) return "OPENROUTER_TTS_EXPIRES_AT is not a valid date. The free voice route is blocked.";
  if (Date.now() >= endOfUtcDay(expiry)) {
    return `The ${OPENROUTER_HEYGEN_TTS_MODEL} free voice model retired on ${c.expiresAt}. The paid counterpart is never substituted.`;
  }
  return null;
}

function endOfUtcDay(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999);
}

function retryAfterMs(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (!raw) return 30_000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(1000, Math.min(15 * 60_000, seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(1000, Math.min(15 * 60_000, date - Date.now()));
  return 30_000;
}

function classifyStatus(status: number, headers: Headers): OpenRouterRequestError {
  if (status === 401 || status === 403) {
    return new OpenRouterRequestError(
      "authentication",
      `OpenRouter rejected OPENROUTER_API_KEY (HTTP ${status}). No inference request was sent.`,
      status,
    );
  }
  if (status === 402) {
    return new OpenRouterRequestError(
      "configuration",
      "OpenRouter requires credits for this route. CHF 0.00 policy blocks it; no paid request is made.",
      status,
    );
  }
  if (status === 429) {
    return new OpenRouterRequestError(
      "rate_limit",
      "OpenRouter rate limit reached. The route is cooling down; no paid fallback is used.",
      status,
      retryAfterMs(headers),
    );
  }
  return new OpenRouterRequestError(
    status >= 500 ? "unavailable" : "catalogue",
    `OpenRouter returned HTTP ${status}. No model substitution was attempted.`,
    status,
  );
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    return String(payload.error?.message ?? "").slice(0, 240);
  } catch {
    return text.slice(0, 240);
  }
}

/** Validate the key with an authenticated endpoint; the public catalogue alone is not enough. */
export async function checkOpenRouterCredential(force = false): Promise<OpenRouterCredential> {
  const c = openRouterTextConfig();
  if (!c.key) throw new OpenRouterRequestError("authentication", "OPENROUTER_API_KEY is not set.");
  const cached = g.__atwOpenRouterCredential;
  if (!force && cached && Date.now() - cached.at < CREDENTIAL_TTL_MS) return cached.value;
  let response: Response;
  try {
    response = await fetch(`${c.baseUrl}/key`, {
      headers: { Authorization: `Bearer ${c.key}` },
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch {
    throw new OpenRouterRequestError("unavailable", "OpenRouter key validation was unreachable. No inference request was sent.");
  }
  if (!response.ok) {
    const detail = await readError(response);
    const error = classifyStatus(response.status, response.headers);
    if (detail) error.message = `${error.message} ${detail}`;
    throw error;
  }
  const value = { valid: true as const, checkedAt: new Date().toISOString() };
  g.__atwOpenRouterCredential = { at: Date.now(), value };
  return value;
}

export async function discoverOpenRouterModels(
  modality: OpenRouterModality,
  options: { force?: boolean } = {},
): Promise<OpenRouterCatalogue> {
  const c = openRouterTextConfig();
  if (!c.key) throw new OpenRouterRequestError("authentication", "OPENROUTER_API_KEY is not set.");
  const cached = g.__atwOpenRouterCatalogue?.[modality];
  if (!options.force && cached && Date.now() - cached.at < CATALOGUE_TTL_MS) return cached.value;

  let response: Response;
  try {
    response = await fetch(
      `${c.baseUrl}/models?output_modalities=${encodeURIComponent(modality)}&max_price=0&limit=500`,
      {
        headers: { Authorization: `Bearer ${c.key}` },
        signal: AbortSignal.timeout(15_000),
        cache: "no-store",
      },
    );
  } catch {
    throw new OpenRouterRequestError("unavailable", "OpenRouter model catalogue was unreachable. No inference request was sent.");
  }
  if (!response.ok) {
    const detail = await readError(response);
    const error = classifyStatus(response.status, response.headers);
    if (detail) error.message = `${error.message} ${detail}`;
    throw error;
  }
  const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
  if (!payload || !Array.isArray(payload.data)) {
    throw new OpenRouterRequestError("catalogue", "OpenRouter returned an invalid model catalogue.");
  }
  const value: OpenRouterCatalogue = {
    models: payload.data as OpenRouterCatalogueModel[],
    fetchedAt: new Date().toISOString(),
  };
  g.__atwOpenRouterCatalogue ??= {};
  g.__atwOpenRouterCatalogue[modality] = { at: Date.now(), value };
  return value;
}

function pricingIsZero(pricing: Record<string, string | number> | undefined): boolean {
  if (!pricing) return false;
  const values = Object.values(pricing);
  if (values.length === 0) return false;
  return values.every((value) => Number(value) === 0);
}

function parseExpiry(value: string | null | undefined): number | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? endOfUtcDay(parsed) : null;
}

export async function validateOpenRouterFreeModel(
  requested: string,
  modality: OpenRouterModality,
  options: { now?: number; checkKey?: boolean } = {},
): Promise<OpenRouterFreeModelValidation> {
  const now = options.now ?? Date.now();
  const model = requested.trim();
  if (!isFreeOpenRouterModel(model)) {
    return {
      ok: false,
      code: "invalid_model",
      reason: `${model || "No model"} is not an exact free model id ending in :free. openrouter/free and paid ids are refused.`,
      expiresAt: null,
    };
  }
  if (options.checkKey !== false) {
    try {
      await checkOpenRouterCredential();
    } catch (error) {
      const failure = error instanceof OpenRouterRequestError ? error : null;
      return {
        ok: false,
        code:
          failure?.kind === "authentication"
            ? "authentication"
            : failure?.kind === "rate_limit"
              ? "rate_limit"
              : failure?.kind === "unavailable"
                ? "provider_unavailable"
                : "catalogue",
        reason: error instanceof Error ? error.message : "OpenRouter key validation failed.",
        expiresAt: null,
      };
    }
  }

  let catalogue: OpenRouterCatalogue;
  try {
    catalogue = await discoverOpenRouterModels(modality);
  } catch (error) {
    const failure = error instanceof OpenRouterRequestError ? error : null;
    return {
      ok: false,
      code:
        failure?.kind === "authentication"
          ? "authentication"
          : failure?.kind === "rate_limit"
            ? "rate_limit"
            : failure?.kind === "unavailable"
              ? "provider_unavailable"
              : "catalogue",
      reason: error instanceof Error ? error.message : "OpenRouter model catalogue was unavailable.",
      expiresAt: null,
    };
  }

  const entry = catalogue.models.find((candidate) => candidate.id === model);
  if (!entry) {
    return {
      ok: false,
      code: "not_catalogued",
      reason: `${model} is not listed as a zero-price ${modality} model on OpenRouter. No substitution was attempted.`,
      expiresAt: null,
    };
  }
  if (!pricingIsZero(entry.pricing)) {
    return {
      ok: false,
      code: "paid_model",
      reason: `${model} is catalogued with a non-zero price. The CHF 0.00 policy blocks it.`,
      expiresAt: null,
    };
  }
  const outputs = entry.architecture?.output_modalities ?? [];
  if (!outputs.includes(modality)) {
    return {
      ok: false,
      code: "wrong_modality",
      reason: `${model} does not advertise ${modality} output. It cannot serve this request.`,
      expiresAt: null,
    };
  }
  if (modality === "speech" && !(entry.endpoints ?? []).includes("/api/v1/audio/speech")) {
    return {
      ok: false,
      code: "wrong_modality",
      reason: `${model} does not advertise the OpenRouter speech endpoint.`,
      expiresAt: null,
    };
  }

  const catalogueExpiry = parseExpiry(entry.expiration_date);
  const configuredExpiry =
    modality === "speech" ? parseExpiry(openRouterTtsConfig().expiresAt) : null;
  const expiryCandidates = [catalogueExpiry, configuredExpiry].filter((value): value is number => value !== null);
  const expiry = expiryCandidates.length > 0 ? Math.min(...expiryCandidates) : null;
  if (expiry !== null && now >= expiry) {
    return {
      ok: false,
      code: "expired",
      reason:
        modality === "speech"
          ? `${model} retired on ${new Date(expiry).toISOString().slice(0, 10)}. The paid counterpart is never substituted.`
          : `${model} has expired on OpenRouter. No substitution was attempted.`,
      expiresAt: new Date(expiry).toISOString(),
    };
  }

  return {
    ok: true,
    id: model,
    model: entry,
    pricing: entry.pricing ?? {},
    expiresAt: expiry ? new Date(expiry).toISOString() : null,
    verifiedAt: new Date(now).toISOString(),
  };
}

export function clearOpenRouterCache(): void {
  g.__atwOpenRouterCatalogue = undefined;
  g.__atwOpenRouterCredential = undefined;
}

export type OpenRouterStatus = {
  configured: boolean;
  text: {
    enabled: boolean;
    model: string;
    policyIssue: string | null;
    valid: boolean;
    detail: string;
    assignedAgents: string[];
    expiresAt: string | null;
  };
  tts: {
    enabled: boolean;
    model: string;
    voice: string;
    provider: string;
    expiresAt: string | null;
    valid: boolean;
    detail: string;
  };
};

export async function openRouterStatus(): Promise<OpenRouterStatus> {
  const textConfig = openRouterTextConfig();
  const ttsConfig = openRouterTtsConfig();
  const textIssue = openRouterTextPolicyIssue();
  const ttsIssue = openRouterTtsPolicyIssue();
  let textValid = false;
  let textDetail = textIssue ?? "Catalogue validation has not run.";
  let textExpiresAt: string | null = null;
  let ttsValid = false;
  let ttsDetail = ttsIssue ?? "Catalogue validation has not run.";
  let ttsExpiresAt = ttsConfig.expiresAt;

  if (!textIssue) {
    const validation = await validateOpenRouterFreeModel(textConfig.model, "text");
    textValid = validation.ok;
    textDetail = validation.ok
      ? `Provider-verified zero-price text model. Exact id ${validation.id}; no paid fallback is permitted.`
      : validation.reason;
    textExpiresAt = validation.ok ? validation.expiresAt : null;
  }
  if (!ttsIssue) {
    const validation = await validateOpenRouterFreeModel(ttsConfig.model, "speech");
    ttsValid = validation.ok;
    ttsExpiresAt = validation.ok ? validation.expiresAt : ttsConfig.expiresAt;
    ttsDetail = validation.ok
      ? `Provider-verified zero-price speech model, restricted to provider ${ttsConfig.provider}. Expires ${validation.expiresAt ?? ttsConfig.expiresAt}.`
      : validation.reason;
  }

  return {
    configured: openRouterTextConfigured() || openRouterTtsConfigured(),
    text: {
      enabled: textConfig.enabled,
      model: textConfig.model,
      policyIssue: textIssue,
      valid: textValid,
      detail: textDetail,
      assignedAgents: textConfig.assignedAgents,
      expiresAt: textExpiresAt,
    },
    tts: {
      enabled: ttsConfig.enabled,
      model: ttsConfig.model,
      voice: ttsConfig.voice,
      provider: ttsConfig.provider,
      expiresAt: ttsExpiresAt,
      valid: ttsValid,
      detail: ttsDetail,
    },
  };
}
