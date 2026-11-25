import { nowIso } from "./db";
import { getSetting, setSetting } from "./settings";

/**
 * Free-tier authorisation and quota protection.
 *
 * The owner has authorised use of the available FREE-TIER capacity of Google
 * Gemini and FreeLLMAPI. Free-tier use is permitted while the external spending
 * limit remains CHF 0.00, because it does not create a charge. This module is
 * the single place that decides whether a provider's free tier is verified,
 * whether it has been exhausted, and when it may be used again.
 *
 * Free status is never inferred from a provider name. It requires an explicit
 * operator declaration plus a model/endpoint check that refuses known paid
 * models and dynamic routing. If the declaration is missing the provider is
 * UNVERIFIED and is blocked before transmission.
 *
 * Exhaustion is separate from an ordinary rate limit: a rate limit only cools
 * a route down for its advertised retry window, while a confirmed quota
 * exhaustion blocks free-tier inference until the quota resets or availability
 * is independently verified again.
 */

export type FreeTierProvider = "gemini" | "freellmapi";
export type FreeTierState = "available" | "exhausted" | "unverified" | "blocked";

/**
 * Precise eligibility, kept separate from the routing state. A provider can be
 * owner-attested without pretending it has provider-issued billing evidence.
 */
export type FreeTierEligibility =
  | "provider_verified"
  | "owner_attested"
  | "unverified"
  | "quota_exhausted"
  | "provider_unavailable"
  | "paid_model_blocked";

export const GEMINI_FREE_TIER_ENV = "GEMINI_FREE_TIER_VERIFIED";
export const FREELLMAPI_FREE_TIER_ENV = "FREELLMAPI_FREE_TIER_VERIFIED";
export const GEMINI_FREE_TIER_EVIDENCE_ENV = "GEMINI_FREE_TIER_EVIDENCE";
export const GEMINI_FREE_TIER_ATTESTATION_ENV = "GEMINI_FREE_TIER_ATTESTATION";
export const GEMINI_LIVE_FREE_TIER_ATTESTATION_ENV = "GEMINI_LIVE_FREE_TIER_ATTESTATION";
export const FREELLMAPI_FREE_TIER_EVIDENCE_ENV = "FREELLMAPI_FREE_TIER_EVIDENCE";
export const FREELLMAPI_FREE_TIER_ATTESTATION_ENV = "FREELLMAPI_FREE_TIER_ATTESTATION";
export const FREE_TIER_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type ProviderEvidence = {
  source: "provider_api" | "provider_console";
  account: string;
  model: string;
  billing: "disabled" | "not_enabled" | "free_only";
  hard_cap: true;
  quota: string;
  verified_at: string;
  expires_at: string;
  reference: string;
};

const EXHAUSTION_KEY = "free_tier_exhaustion";
const LAST_ERROR_KEY = "free_tier_last_error";
const LAST_SUCCESS_KEY = "free_tier_last_success";
const VERIFIED_AT_KEY = "free_tier_verified_at";
const LIVE_EXHAUSTION_KEY = "gemini_live_free_tier_exhaustion";
const LIVE_LAST_ERROR_KEY = "gemini_live_free_tier_last_error";
const LIVE_LAST_SUCCESS_KEY = "gemini_live_free_tier_last_success";

type StoredExhaustion = {
  model: string;
  reason: string;
  exhausted_at: string;
  reset_at: string | null;
  /** True when the provider requires payment for this route: not a quota reset. */
  permanent: boolean;
  kind: "quota_exhausted" | "billing_restricted";
};

type ExhaustionStore = Partial<Record<FreeTierProvider, StoredExhaustion>>;

type LastError = {
  model: string | null;
  message: string;
  at: string;
  kind: string;
};

export type FreeTierStatus = {
  provider: FreeTierProvider;
  state: FreeTierState;
  /** Only an AVAILABLE state may transmit a free-tier request. */
  allowed: boolean;
  verified: boolean;
  verification_kind: "provider_evidence" | "owner_attestation" | "none";
  /** Precise eligibility for UI and diagnostics; `state` remains the gate. */
  eligibility: FreeTierEligibility;
  model: string | null;
  verification_source: string | null;
  evidence_reference: string | null;
  no_charge_protection: boolean;
  verified_at: string | null;
  exhausted_at: string | null;
  reset_at: string | null;
  permanent_block: boolean;
  /** Remaining capacity, only when the provider exposes it. */
  remaining: string | null;
  last_error: LastError | null;
  last_success_at: string | null;
  detail: string;
  policy: "free_tier_only" | "zero_spend";
};

const BILLABLE_MODEL_PATTERN =
  /(^|\/)(claude|gpt-[45]|o[134]|opus|sonnet|haiku|gemini-[0-9.]*-pro|gemini-ultra)/i;
const DYNAMIC_MODEL_PATTERN = /(^|\/)(auto|free-router|fusion|kilo-auto)$/i;
/** Gemini models that are only offered on a paid plan. */
const PAID_GEMINI_PATTERN = /-pro\b|-ultra\b|^gemini-2\.5-pro|^gemini-1\.5-pro/i;

function envText(name: string): string {
  return (process.env[name] ?? "").trim();
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * The owner has explicitly checked the provider account and confirmed that the
 * configured route is covered by its free allowance. This is an attestation,
 * not a provider-issued billing record. It is opt-in per provider.
 */
export function providerOwnerAttestationEnabled(provider: FreeTierProvider): boolean {
  const name = provider === "gemini" ? GEMINI_FREE_TIER_ATTESTATION_ENV : FREELLMAPI_FREE_TIER_ATTESTATION_ENV;
  return envText(name) === "owner_confirmed";
}

/**
 * OpenRouter free models must be exact `:free` model ids. A router alias such
 * as `openrouter/free` can choose an upstream route after the request, so it is
 * not accepted for the CHF 0.00 policy. Known billable vendor ids are refused
 * even when they carry a `:free` suffix.
 */
export function isFreeOpenRouterModel(model: string): boolean {
  const id = model.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*:free$/.test(id) && !isKnownBillableModel(id);
}

export function freeLlmModelId(): string | null {
  return envText("FREELLMAPI_MODEL") || null;
}

export function geminiModelId(): string | null {
  return envText("GEMINI_MODEL") || null;
}

/**
 * A per-request model can differ from GEMINI_MODEL (vision uses VISION_MODEL).
 * The verification must check the model that will actually be transmitted.
 */
function effectiveGeminiModel(override?: string | null): string | null {
  return textOrNull(override) ?? geminiModelId();
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed || null;
}

export function isPaidGeminiModel(model: string): boolean {
  return PAID_GEMINI_PATTERN.test(model.trim());
}

/** A Gemini free-tier candidate must be a flash-class model, never a pro model. */
export function isFreeEligibleGeminiModel(model: string): boolean {
  const id = model.trim();
  return /^gemini-[A-Za-z0-9._-]+$/.test(id) && /flash/i.test(id) && !isPaidGeminiModel(id);
}

/**
 * A Gemini Live model with a published free-tier price. Google lists
 * gemini-3.8-live and the flash/native-audio Live models as free of charge on
 * the free tier, up to rate limits. Pro/ultra and other billable ids are
 * refused even when the legacy paid-authorisation flag is set.
 */
export function isFreeEligibleGeminiLiveModel(model: string): boolean {
  const id = model.trim();
  return /^gemini-[A-Za-z0-9._-]+$/.test(id) && /live/i.test(id) && !isPaidGeminiModel(id) && !isKnownBillableModel(id);
}

export function isDynamicRoutingModel(model: string): boolean {
  return DYNAMIC_MODEL_PATTERN.test(model.trim());
}

export function isKnownBillableModel(model: string): boolean {
  return BILLABLE_MODEL_PATTERN.test(model.trim());
}

function exhaustionStore(): ExhaustionStore {
  return getSetting<ExhaustionStore>(EXHAUSTION_KEY, {}) ?? {};
}

function writeExhaustion(provider: FreeTierProvider, entry: StoredExhaustion | null): void {
  const store = exhaustionStore();
  if (entry) store[provider] = entry;
  else delete store[provider];
  setSetting(EXHAUSTION_KEY, store);
}

function lastErrorFor(provider: FreeTierProvider): LastError | null {
  const store = getSetting<Partial<Record<FreeTierProvider, LastError>>>(LAST_ERROR_KEY, {}) ?? {};
  return store[provider] ?? null;
}

function lastSuccessFor(provider: FreeTierProvider): string | null {
  const store = getSetting<Partial<Record<FreeTierProvider, string>>>(LAST_SUCCESS_KEY, {}) ?? {};
  return store[provider] ?? null;
}

function verifiedAtFor(provider: FreeTierProvider): string | null {
  const store = getSetting<Partial<Record<FreeTierProvider, string>>>(VERIFIED_AT_KEY, {}) ?? {};
  return store[provider] ?? null;
}

function markVerifiedAt(provider: FreeTierProvider): string | null {
  const existing = verifiedAtFor(provider);
  if (existing) return existing;
  const at = nowIso();
  const store = getSetting<Partial<Record<FreeTierProvider, string>>>(VERIFIED_AT_KEY, {}) ?? {};
  store[provider] = at;
  setSetting(VERIFIED_AT_KEY, store);
  return at;
}

type Verification = {
  verified: boolean;
  kind: "provider_evidence" | "owner_attestation" | "none";
  source: string | null;
  evidence: string | null;
  model: string | null;
  verified_at: string | null;
  issue: string | null;
  eligibility: FreeTierEligibility;
};

function providerEvidence(provider: FreeTierProvider, model: string | null): {
  evidence: ProviderEvidence | null;
  issue: string | null;
} {
  const raw = envText(
    provider === "gemini" ? GEMINI_FREE_TIER_EVIDENCE_ENV : FREELLMAPI_FREE_TIER_EVIDENCE_ENV,
  );
  if (!raw) {
    return {
      evidence: null,
      issue: `${provider === "gemini" ? GEMINI_FREE_TIER_EVIDENCE_ENV : FREELLMAPI_FREE_TIER_EVIDENCE_ENV} is empty. A provider-issued evidence record is required; an operator declaration alone is not accepted.`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { evidence: null, issue: "The provider free-tier evidence is not valid JSON." };
  }
  const source = parsed.source;
  if (source !== "provider_api" && source !== "provider_console") {
    return { evidence: null, issue: "The evidence source must be provider_api or provider_console." };
  }
  const recordedProvider = typeof parsed.provider === "string" ? parsed.provider.toLowerCase() : "";
  const providerMatches =
    provider === "gemini"
      ? recordedProvider === "gemini" || recordedProvider === "google"
      : recordedProvider === "freellmapi" || recordedProvider === "free-llm-api";
  if (!providerMatches) {
    return { evidence: null, issue: "The evidence record belongs to a different provider." };
  }
  const account = typeof parsed.account === "string" ? parsed.account.trim() : "";
  if (!account) return { evidence: null, issue: "The evidence record does not identify the provider account." };
  const evidenceModel = typeof parsed.model === "string" ? parsed.model.trim() : "";
  const evidenceModels = Array.isArray(parsed.models)
    ? parsed.models.filter((value): value is string => typeof value === "string").map((value) => value.trim())
    : [];
  if (!model || (evidenceModel !== model && !evidenceModels.includes(model))) {
    return { evidence: null, issue: `The evidence covers ${evidenceModel || "no model"}, not ${model ?? "the requested model"}.` };
  }
  const billing = parsed.billing;
  if (billing !== "disabled" && billing !== "not_enabled" && billing !== "free_only") {
    return {
      evidence: null,
      issue: "The evidence does not prove that paid billing is disabled or unavailable for this route.",
    };
  }
  if (parsed.free_tier !== true || parsed.hard_cap !== true) {
    return { evidence: null, issue: "The evidence must prove free_tier=true and hard_cap=true." };
  }
  const quotaStatus = typeof parsed.quota_status === "string" ? parsed.quota_status.toLowerCase() : "";
  const quotaRemaining = Number(parsed.quota_remaining);
  if (!["available", "remaining"].includes(quotaStatus) && !(Number.isFinite(quotaRemaining) && quotaRemaining > 0)) {
    return { evidence: null, issue: "The evidence does not prove that free quota remains." };
  }
  const verifiedAt = typeof parsed.verified_at === "string" ? Date.parse(parsed.verified_at) : NaN;
  const expiresAt = typeof parsed.expires_at === "string" ? Date.parse(parsed.expires_at) : NaN;
  const now = Date.now();
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) {
    return { evidence: null, issue: "The evidence timestamps are invalid." };
  }
  if (verifiedAt > now + 60_000 || now - verifiedAt > FREE_TIER_EVIDENCE_MAX_AGE_MS) {
    return { evidence: null, issue: "The provider evidence is stale or dated in the future." };
  }
  if (expiresAt <= now) return { evidence: null, issue: "The provider evidence has expired." };
  const reference = typeof parsed.evidence_reference === "string" ? parsed.evidence_reference.trim() : "";
  let referenceHost = "";
  try {
    const url = new URL(reference);
    if (!/^https?:$/.test(url.protocol)) throw new Error("protocol");
    referenceHost = url.hostname.toLowerCase();
  } catch {
    return { evidence: null, issue: "The evidence reference must be an HTTP(S) provider URL." };
  }
  if (provider === "gemini") {
    const allowed =
      referenceHost === "ai.google.dev" ||
      referenceHost.endsWith(".google.com") ||
      referenceHost.endsWith(".googleapis.com");
    if (!allowed) return { evidence: null, issue: "The Gemini evidence reference is not on a Google provider domain." };
  } else {
    let baseHost = "";
    try {
      baseHost = new URL(envText("FREELLMAPI_BASE_URL")).hostname.toLowerCase();
    } catch {
      baseHost = "";
    }
    if (!baseHost || referenceHost !== baseHost) {
      return { evidence: null, issue: "The FreeLLMAPI evidence reference is not on the configured gateway host." };
    }
  }
  return {
    evidence: {
      source,
      account,
      model: evidenceModel,
      billing,
      hard_cap: true,
      quota: quotaStatus || String(quotaRemaining),
      verified_at: new Date(verifiedAt).toISOString(),
      expires_at: new Date(expiresAt).toISOString(),
      reference,
    },
    issue: null,
  };
}

/**
 * Free-tier verification for the selected route.
 *
 * Gemini: operator declaration + API key + an explicit flash-class model.
 * FreeLLMAPI: operator declaration + a complete gateway configuration + one
 * pinned, allowlisted, non-billable model id. Dynamic routing aliases are
 * refused because the upstream (and its billing) would be chosen after the
 * request.
 */
export function freeTierVerification(provider: FreeTierProvider, modelOverride?: string | null): Verification {
  const blocked = (
    model: string | null,
    issue: string,
    eligibility: FreeTierEligibility = "unverified",
  ): Verification => ({
    verified: false,
    kind: "none",
    source: null,
    evidence: null,
    model,
    verified_at: null,
    issue,
    eligibility,
  });

  if (provider === "gemini") {
    const model = effectiveGeminiModel(modelOverride);
    const declared = process.env[GEMINI_FREE_TIER_ENV] === "true";
    if (!envText("GEMINI_API_KEY")) return blocked(model, "GEMINI_API_KEY is not set.");
    if (!model) return blocked(model, "GEMINI_MODEL is not set. No model is guessed.");
    if (!isFreeEligibleGeminiModel(model)) {
      return blocked(
        model,
        `${model} is not a verified Gemini free-tier flash model. Paid pro/ultra models are never used.`,
      );
    }
    if (!declared) {
      return blocked(
        model,
        `Gemini free-tier status is unverified. Set ${GEMINI_FREE_TIER_ENV}=true only after confirming ${model} is covered by the account's free tier.`,
      );
    }
    const evidenceText = envText(GEMINI_FREE_TIER_EVIDENCE_ENV);
    if (evidenceText) {
      const proof = providerEvidence("gemini", model);
      if (proof.issue || !proof.evidence) {
        return blocked(model, `Gemini provider evidence is not sufficient: ${proof.issue ?? "unknown evidence error"}`);
      }
      return {
        verified: true,
        kind: "provider_evidence",
        source: "provider-evidence",
        evidence: proof.evidence.reference,
        model,
        verified_at: proof.evidence.verified_at,
        issue: null,
        eligibility: "provider_verified",
      };
    }
    if (providerOwnerAttestationEnabled("gemini")) {
      return {
        verified: true,
        kind: "owner_attestation",
        source: "owner_attestation",
        evidence: null,
        model,
        verified_at: new Date().toISOString(),
        issue: null,
        eligibility: "owner_attested",
      };
    }
    return blocked(
      model,
      `Gemini provider evidence is not sufficient. Provide ${GEMINI_FREE_TIER_EVIDENCE_ENV}, or set ${GEMINI_FREE_TIER_ATTESTATION_ENV}=owner_confirmed after verifying ${model} in the provider account.`,
    );
  }

  const enabled = process.env.FREELLMAPI_ENABLED === "true";
  const base = envText("FREELLMAPI_BASE_URL");
  const key = envText("FREELLMAPI_API_KEY");
  const model = freeLlmModelId();
  const allowed = csv(process.env.FREELLMAPI_ALLOWED_MODELS);
  const declared = process.env[FREELLMAPI_FREE_TIER_ENV] === "true";
  if (!enabled) return blocked(model, "FREELLMAPI_ENABLED is not true.");
  if (!base || !key) {
    return blocked(
      model,
      "FreeLLMAPI configuration is incomplete: FREELLMAPI_BASE_URL and FREELLMAPI_API_KEY are required.",
    );
  }
  if (!model) return blocked(model, "FREELLMAPI_MODEL is not set. No model is guessed.");
  if (isDynamicRoutingModel(model) || isKnownBillableModel(model)) {
    return blocked(
      model,
      `${model} is not a pinned free-tier model. Routing aliases and known billable vendor ids are never used.`,
    );
  }
  if (allowed.length === 0 || !allowed.includes(model)) {
    return blocked(
      model,
      `${model} is not explicitly listed in FREELLMAPI_ALLOWED_MODELS, so its free-tier status cannot be enforced.`,
    );
  }
  if (!declared) {
    return blocked(
      model,
      `FreeLLMAPI free-tier status is unverified. Set ${FREELLMAPI_FREE_TIER_ENV}=true only after confirming ${model} is covered by the account's free tier.`,
    );
  }
  const evidenceText = envText(FREELLMAPI_FREE_TIER_EVIDENCE_ENV);
  if (evidenceText) {
    const proof = providerEvidence("freellmapi", model);
    if (proof.issue || !proof.evidence) {
      return blocked(
        model,
        `FreeLLMAPI provider evidence is not sufficient: ${proof.issue ?? "unknown evidence error"}`,
      );
    }
    return {
      verified: true,
      kind: "provider_evidence",
      source: "provider-evidence",
      evidence: proof.evidence.reference,
      model,
      verified_at: proof.evidence.verified_at,
      issue: null,
      eligibility: "provider_verified",
    };
  }
  if (providerOwnerAttestationEnabled("freellmapi")) {
    return {
      verified: true,
      kind: "owner_attestation",
      source: "owner_attestation",
      evidence: null,
      model,
      verified_at: new Date().toISOString(),
      issue: null,
      eligibility: "owner_attested",
    };
  }
  return blocked(
    model,
    `FreeLLMAPI provider evidence is not sufficient. Provide ${FREELLMAPI_FREE_TIER_EVIDENCE_ENV}, or set ${FREELLMAPI_FREE_TIER_ATTESTATION_ENV}=owner_confirmed after verifying the gateway and ${model}.`,
  );
}

function resetTimeFrom(message: string): string | null {
  const iso = message.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
  if (iso) {
    const parsed = Date.parse(iso[1]);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

function nextUtcMidnight(now: number): string {
  const date = new Date(now);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)).toISOString();
}

const BILLING_RESTRICTION =
  /billing (?:required|disabled|not enabled)|payment required|insufficient[_ ]quota|account.*(?:suspended|restricted)|upgrade your plan|paid plan required/i;

/**
 * Only an explicit quota or daily/monthly-limit message proves exhaustion.
 * Gemini also emits RESOURCE_EXHAUSTED for ordinary per-minute rate limits, so
 * that status alone is deliberately not treated as monthly quota exhaustion.
 */
const CONFIRMED_EXHAUSTION =
  /quota (?:exceeded|exhausted)|exceeded your current quota|daily (?:quota|limit|requests)|monthly (?:quota|limit|requests)|per[- ]day (?:quota|limit)|free[_ ]tier (?:quota )?(?:exhausted|limit reached)/i;

/**
 * Persist a free-tier failure. Only a confirmed quota exhaustion or billing
 * restriction changes free-tier state; an ordinary 429 rate limit is handled by
 * the normal cooldown and must not be mistaken for monthly exhaustion.
 */
export function recordFreeTierFailure(input: {
  provider: FreeTierProvider;
  model: string;
  kind: string;
  message: string;
  retryAfterMs?: number | null;
  now?: number;
}): FreeTierStatus {
  const now = input.now ?? Date.now();
  const kind: LastError["kind"] = input.kind;
  const errorStore =
    getSetting<Partial<Record<FreeTierProvider, LastError>>>(LAST_ERROR_KEY, {}) ?? {};
  errorStore[input.provider] = {
    model: input.model,
    message: input.message.slice(0, 500),
    at: new Date(now).toISOString(),
    kind,
  };
  setSetting(LAST_ERROR_KEY, errorStore);

  if (input.kind === "quota_exhausted" && (CONFIRMED_EXHAUSTION.test(input.message) || BILLING_RESTRICTION.test(input.message))) {
    const permanent = BILLING_RESTRICTION.test(input.message);
    const resetAt = permanent
      ? null
      : resetTimeFrom(input.message) ??
        (input.retryAfterMs && input.retryAfterMs > 0
          ? new Date(now + input.retryAfterMs).toISOString()
          : nextUtcMidnight(now));
    writeExhaustion(input.provider, {
      model: input.model,
      reason: input.message.slice(0, 500),
      exhausted_at: new Date(now).toISOString(),
      reset_at: resetAt,
      permanent,
      kind: permanent ? "billing_restricted" : "quota_exhausted",
    });
  } else if (input.kind === "model_unavailable" || input.kind === "rate_limited") {
    // A missing model or a momentary rate limit does not prove quota exhaustion.
    // The existing cooldown still prevents hammering the route.
  }
  return freeTierStatus(input.provider, now);
}

export function recordFreeTierSuccess(provider: FreeTierProvider, model: string, now = Date.now()): void {
  const store = getSetting<Partial<Record<FreeTierProvider, string>>>(LAST_SUCCESS_KEY, {}) ?? {};
  store[provider] = new Date(now).toISOString();
  setSetting(LAST_SUCCESS_KEY, store);
  const errorStore =
    getSetting<Partial<Record<FreeTierProvider, LastError>>>(LAST_ERROR_KEY, {}) ?? {};
  const existing = errorStore[provider];
  // Keep the last quota/rate-limit error visible; a success only proves the
  // route recovered, not that the earlier causal event never happened.
  if (existing && existing.kind === "quota_exhausted") {
    recordFreeTierClearIfRecovered(provider, model, now);
  }
  markVerifiedAt(provider);
}

export type GeminiLiveFreeTierStatus = {
  state: FreeTierState;
  allowed: boolean;
  verified: boolean;
  eligibility: FreeTierEligibility;
  model: string | null;
  verification_source: string | null;
  evidence_reference: string | null;
  exhausted_at: string | null;
  reset_at: string | null;
  last_error: LastError | null;
  last_success_at: string | null;
  detail: string;
};

export function geminiLiveModelId(): string {
  return envText("GEMINI_LIVE_MODEL") || "gemini-3.8-live";
}

/**
 * The owner has explicitly confirmed in AI Studio that the Gemini key belongs
 * to a free-tier project. This is an owner attestation, not provider-issued
 * billing evidence. It is opt-in and Live-only; text and vision still require
 * the provider evidence record. The Live path performs a real key/model
 * preflight before it mints a token.
 */
export function geminiLiveOwnerAttestationEnabled(): boolean {
  return envText(GEMINI_LIVE_FREE_TIER_ATTESTATION_ENV) === "owner_confirmed";
}

/**
 * Free-tier gate for Chief's Gemini Live voice transport.
 *
 * The account-level operator declaration is the same one used for Gemini text
 * and vision; the Live model itself must also carry a published free-tier
 * price. Text and vision still require provider evidence. Live additionally
 * accepts an explicit, opt-in owner attestation when the evidence field is
 * empty; this is not provider-issued billing proof. The Live path then proves
 * key/model reachability before minting a token. A successful call is never
 * treated as proof that billing is disabled.
 */
export function geminiLiveFreeTierStatus(
  now = Date.now(),
  modelOverride?: string | null,
): GeminiLiveFreeTierStatus {
  const model = textOrNull(modelOverride) ?? geminiLiveModelId();
  const stored = getSetting<StoredExhaustion | null>(LIVE_EXHAUSTION_KEY, null);
  const base = {
    model,
    eligibility: "unverified" as FreeTierEligibility,
    verification_source: null,
    evidence_reference: null,
    exhausted_at: null,
    reset_at: null,
    last_error: getSetting<LastError | null>(LIVE_LAST_ERROR_KEY, null),
    last_success_at: getSetting<string | null>(LIVE_LAST_SUCCESS_KEY, null),
  };

  if (!envText("GEMINI_API_KEY")) {
    return {
      ...base,
      state: "unverified",
      allowed: false,
      verified: false,
      detail: "Gemini Live is not configured: GEMINI_API_KEY is not set. No request is transmitted and no fallback voice provider is substituted.",
    };
  }
  if (!isFreeEligibleGeminiLiveModel(model)) {
    return {
      ...base,
      state: "blocked",
      allowed: false,
      verified: false,
      eligibility: "paid_model_blocked",
      detail: `${model} is not a Gemini Live model with a published free-tier price. Paid Live models are never used, and GEMINI_PAID_AUTHORISED cannot authorise one.`,
    };
  }
  if (process.env[GEMINI_FREE_TIER_ENV] !== "true") {
    return {
      ...base,
      state: "unverified",
      allowed: false,
      verified: false,
      detail: `Gemini Live free-tier status is unverified. Set ${GEMINI_FREE_TIER_ENV}=true only after confirming the account and ${model} are covered by the Gemini free tier. No microphone audio is transmitted.`,
    };
  }

  const liveProof = providerEvidence("gemini", model);
  const hasProviderEvidence = !liveProof.issue && Boolean(liveProof.evidence);
  const hasEmptyEvidence = envText(GEMINI_FREE_TIER_EVIDENCE_ENV) === "";
  const ownerAttested = hasEmptyEvidence && geminiLiveOwnerAttestationEnabled();
  if (!hasProviderEvidence && !ownerAttested) {
    return {
      ...base,
      state: "unverified",
      allowed: false,
      verified: false,
      detail: `Gemini Live provider evidence is not sufficient: ${liveProof.issue ?? "unknown evidence error"}. No microphone audio is transmitted.`,
    };
  }
  const evidence = hasProviderEvidence ? liveProof.evidence!.reference : null;
  const verificationSource = hasProviderEvidence ? GEMINI_FREE_TIER_ENV : "owner_attestation";
  const verificationDetail = hasProviderEvidence
    ? `Gemini Live ${model} is covered by the provider evidence record.`
    : `The owner has confirmed in AI Studio that the Gemini key belongs to a free-tier project. Google does not expose a machine-readable billing attestation to this key, so this is an owner attestation, not provider-issued billing evidence. The key and model are preflighted before each token is minted, and quota or billing failures block the route.`;

  if (stored) {
    const resetMs = stored.reset_at ? Date.parse(stored.reset_at) : NaN;
    const stillBlocked = stored.permanent || !Number.isFinite(resetMs) || resetMs > now;
    if (stillBlocked) {
      return {
        ...base,
        state: stored.permanent ? "blocked" : "exhausted",
        allowed: false,
        verified: true,
        eligibility: stored.permanent ? "paid_model_blocked" : "quota_exhausted",
        verification_source: verificationSource,
        evidence_reference: evidence,
        exhausted_at: stored.exhausted_at,
        reset_at: stored.reset_at,
        detail: stored.permanent
          ? `Gemini Live free-tier access is blocked by a billing restriction: ${stored.reason}`
          : `Gemini Live free-tier quota is exhausted until ${stored.reset_at ?? "an unknown reset time"}. Reason: ${stored.reason}`,
      };
    }
    setSetting(LIVE_EXHAUSTION_KEY, null);
  }

  return {
    ...base,
    state: "available",
    allowed: true,
    verified: true,
    eligibility: verificationSource === "owner_attestation" ? "owner_attested" : "provider_verified",
    verification_source: verificationSource,
    evidence_reference: evidence,
    detail: `${verificationDetail} ${model} has a published free-tier price. Chief speaks as Charon; no paid voice fallback or voice substitution exists.`,
  };
}

/** Persist a Live failure. Only confirmed exhaustion or a billing restriction blocks the route. */
export function recordGeminiLiveFailure(input: {
  model: string;
  message: string;
  kind?: string;
  retryAfterMs?: number | null;
  now?: number;
}): GeminiLiveFreeTierStatus {
  const now = input.now ?? Date.now();
  setSetting(LIVE_LAST_ERROR_KEY, {
    model: input.model,
    message: input.message.slice(0, 500),
    at: new Date(now).toISOString(),
    kind: input.kind ?? "quota_exhausted",
  });
  if (CONFIRMED_EXHAUSTION.test(input.message) || BILLING_RESTRICTION.test(input.message)) {
    const permanent = BILLING_RESTRICTION.test(input.message);
    const resetAt = permanent
      ? null
      : resetTimeFrom(input.message) ??
        (input.retryAfterMs && input.retryAfterMs > 0
          ? new Date(now + input.retryAfterMs).toISOString()
          : nextUtcMidnight(now));
    setSetting(LIVE_EXHAUSTION_KEY, {
      model: input.model,
      reason: input.message.slice(0, 500),
      exhausted_at: new Date(now).toISOString(),
      reset_at: resetAt,
      permanent,
      kind: permanent ? "billing_restricted" : "quota_exhausted",
    });
  }
  return geminiLiveFreeTierStatus(now, input.model);
}

/** A confirmed Live session start after a reset clears a non-permanent block. */
export function recordGeminiLiveSuccess(model: string, now = Date.now()): void {
  setSetting(LIVE_LAST_SUCCESS_KEY, new Date(now).toISOString());
  const stored = getSetting<StoredExhaustion | null>(LIVE_EXHAUSTION_KEY, null);
  if (stored && !stored.permanent) setSetting(LIVE_EXHAUSTION_KEY, null);
}

/** A successful real inference after a reset independently confirms availability. */
function recordFreeTierClearIfRecovered(provider: FreeTierProvider, model: string, now: number): void {
  const stored = exhaustionStore()[provider];
  if (!stored) return;
  // A billing restriction is a permanent block. A later success (for example
  // another model on the same gateway) must not silently unblock it.
  if (stored.permanent) return;
  if (!stored.reset_at || Date.parse(stored.reset_at) <= now) writeExhaustion(provider, null);
  else if (stored.model !== model) writeExhaustion(provider, null);
}

export function clearFreeTierExhaustion(provider?: FreeTierProvider): void {
  if (provider) {
    writeExhaustion(provider, null);
    return;
  }
  setSetting(EXHAUSTION_KEY, {});
}

export function clearGeminiLiveExhaustion(): void {
  setSetting(LIVE_EXHAUSTION_KEY, null);
}

export function freeTierStatus(
  provider: FreeTierProvider,
  now = Date.now(),
  modelOverride?: string | null,
): FreeTierStatus {
  const verification = freeTierVerification(provider, modelOverride);
  const stored = exhaustionStore()[provider] ?? null;
  const lastError = lastErrorFor(provider);
  const lastSuccessAt = lastSuccessFor(provider);
  const verifiedAt = verifiedAtFor(provider);
  const base = {
    provider,
    model: verification.model,
    verification_kind: verification.kind,
    eligibility: verification.eligibility,
    verification_source: verification.source,
    evidence_reference: verification.evidence,
    no_charge_protection: verification.verified,
    verified_at: verification.verified_at ?? verifiedAt,
    last_error: lastError,
    last_success_at: lastSuccessAt,
    remaining: null,
    policy: "free_tier_only" as const,
  };

  if (!verification.verified) {
    return {
      ...base,
      state: "unverified",
      allowed: false,
      verified: false,
      exhausted_at: null,
      reset_at: null,
      permanent_block: false,
      detail: verification.issue ?? "Free-tier status could not be established; the provider is blocked.",
    };
  }

  if (stored) {
    const resetMs = stored.reset_at ? Date.parse(stored.reset_at) : NaN;
    const stillBlocked = stored.permanent || !Number.isFinite(resetMs) || resetMs > now;
    if (stillBlocked) {
      return {
        ...base,
        state: stored.permanent ? "blocked" : "exhausted",
        allowed: false,
        verified: true,
        eligibility: stored.permanent ? "paid_model_blocked" : "quota_exhausted",
        exhausted_at: stored.exhausted_at,
        reset_at: stored.reset_at,
        permanent_block: stored.permanent,
        detail: stored.permanent
          ? `Free-tier access is blocked by a billing restriction: ${stored.reason}`
          : `Free-tier quota is exhausted. Reset at ${stored.reset_at ?? "an unknown time"}. Reason: ${stored.reason}`,
      };
    }
    // The advertised reset has passed. Clear the stale state and let the next
    // real request confirm availability.
    writeExhaustion(provider, null);
  }

  return {
    ...base,
    state: "available",
    allowed: true,
    verified: true,
    eligibility: verification.eligibility,
    exhausted_at: null,
    reset_at: null,
    permanent_block: false,
    detail:
      verification.kind === "owner_attestation"
        ? `${verification.model} is owner-attested as free-tier and no exhaustion is recorded. This is not provider-issued billing evidence; the pinned model and quota/billing guards remain active.`
        : `${verification.model} is declared free-tier and no exhaustion is recorded. Verified via ${verification.source}.`,
  };
}

export type OllamaFreeStatus = {
  state: "local_available" | "unavailable" | "blocked";
  configured: boolean;
  model: string | null;
  coderModel: string | null;
  detail: string;
};

function ollamaFreeTierStatus(): OllamaFreeStatus {
  const enabled = process.env.OLLAMA_ENABLED === "true";
  const base = envText("OLLAMA_BASE_URL") || "http://localhost:11434";
  const model = envText("OLLAMA_MODEL") || null;
  const coderModel = envText("OLLAMA_CODER_MODEL") || null;
  if (!enabled) {
    return { state: "unavailable", configured: false, model, coderModel, detail: "OLLAMA_ENABLED is not true." };
  }
  let loopback = false;
  try {
    const host = new URL(base).hostname.toLowerCase();
    loopback = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    loopback = false;
  }
  if (!loopback) {
    return {
      state: "blocked",
      configured: false,
      model,
      coderModel,
      detail: `${base} is not a loopback endpoint, so it cannot be verified as local inference.`,
    };
  }
  if (!model) {
    return { state: "unavailable", configured: false, model, coderModel, detail: "OLLAMA_MODEL is not set." };
  }
  return {
    state: "local_available",
    configured: true,
    model,
    coderModel,
    detail: `${model} is configured on the loopback endpoint. Local inference never incurs external spend.`,
  };
}

export type FreeTierSummary = {
  gemini: FreeTierStatus;
  freellmapi: FreeTierStatus;
  ollama: OllamaFreeStatus;
  external_spend_limit_chf: 0;
  paid_fallback_permitted: false;
  detail: string;
};

export function freeTierSummary(now = Date.now()): FreeTierSummary {
  const gemini = freeTierStatus("gemini", now);
  const freellmapi = freeTierStatus("freellmapi", now);
  const ollama = ollamaFreeTierStatus();
  const available = [gemini, freellmapi].filter((item) => item.allowed).map((item) => item.provider);
  return {
    gemini,
    freellmapi,
    ollama,
    external_spend_limit_chf: 0,
    paid_fallback_permitted: false,
    detail: available.length
      ? `Free-tier inference is available through ${available.join(" and ")}. No paid model, endpoint or fallback is permitted.`
      : "No external free tier is verified and available. Loopback Ollama is the only remaining inference route; otherwise the task is blocked.",
  };
}

export const FREE_TIER_STATE_LABEL: Record<FreeTierState, string> = {
  available: "FREE TIER AVAILABLE",
  exhausted: "EXHAUSTED",
  unverified: "UNVERIFIED",
  blocked: "BLOCKED",
};

export const FREE_TIER_ELIGIBILITY_LABEL: Record<FreeTierEligibility, string> = {
  provider_verified: "PROVIDER VERIFIED",
  owner_attested: "OWNER ATTESTED",
  unverified: "UNVERIFIED",
  quota_exhausted: "QUOTA EXHAUSTED",
  provider_unavailable: "PROVIDER UNAVAILABLE",
  paid_model_blocked: "PAID MODEL BLOCKED",
};
