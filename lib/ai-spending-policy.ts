import { randomUUID } from "node:crypto";
import { all, nowIso, one, run } from "./db";
import {
  FREE_TIER_STATE_LABEL,
  freeTierStatus,
  freeTierSummary,
  geminiLiveFreeTierStatus,
  isKnownBillableModel,
  isDynamicRoutingModel,
  isFreeEligibleGeminiModel,
  isFreeOpenRouterModel,
  isPaidGeminiModel,
  type FreeTierStatus,
} from "./free-tier";
import { OPENROUTER_HEYGEN_TTS_MODEL, openRouterTtsPolicyIssue } from "./openrouter";

/**
 * Free-tier-first AI spending policy.
 *
 * The owner authorises use of the available FREE-TIER capacity of Google
 * Gemini and FreeLLMAPI while the external spending limit remains CHF 0.00.
 * Free-tier use does not create a charge, so it is permitted. Paid models,
 * paid endpoints and paid fallbacks are never permitted.
 *
 * Gemini text/vision is allowed only when its free tier is verified and not
 * exhausted. FreeLLMAPI is allowed only when one pinned, allowlisted,
 * non-billable model has a verified free tier that is not exhausted. If free
 * status cannot be established, the provider fails closed before transmission.
 *
 * Gemini Live voice uses the same free-tier-only gate: the account must be
 * declared free-tier and the configured Live model must carry a published
 * free-tier price. The legacy GEMINI_PAID_AUTHORISED flag cannot authorise a
 * paid voice session. No local voice substitute is claimed.
 *
 * The policy never invents a cost. Free-tier decisions report an estimated cost
 * of CHF 0.00 and never a made-up provider charge.
 */

export const AI_SPENDING_POLICY_ID = "free-tier-first-v3";
export const MAX_AUTHORISED_EXTERNAL_AI_SPEND_CHF = 0 as const;
export const POLICY_LABEL = "FREE-TIER FIRST · CHF 0.00";
export const VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Legacy setting retained only so the admin page can report that it is ignored. */
export const GEMINI_AUTHORISATION_ENV = "GEMINI_PAID_AUTHORISED";

export type AiPolicyProvider =
  | "freellmapi"
  | "gemini"
  | "gemini-live"
  | "openrouter"
  | "ollama"
  | "unknown";

export type AiExecutionType = "local" | "verified_free_external" | "owner_authorised_external" | "blocked";

export type AiPolicyContext = {
  provider: AiPolicyProvider;
  model?: string | null;
  agentKey?: string | null;
  workflowId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  source?: string | null;
  operation?: string | null;
};

export type AiPolicyDecision = {
  allowed: boolean;
  decision: "allowed" | "blocked";
  provider: AiPolicyProvider;
  execution_type: AiExecutionType;
  verified_free: boolean;
  verification_kind: "provider_evidence" | "owner_attestation" | null;
  estimated_cost_chf: 0 | null;
  maximum_authorised_cost_chf: 0;
  billing_authority: "zero_spend" | "owner_authorised" | null;
  cost_status: "unverified" | null;
  block_reason: string | null;
  verification_timestamp: string | null;
  evidence_reference: string | null;
  policy_id: string;
  correlation_id: string;
  model: string | null;
};

/**
 * Evidence shape for an independently verified free external route. Retained so
 * the historical verification checks stay testable; the live free-tier gate in
 * this deployment is the explicit operator declaration plus model checks.
 */
export type ExternalFreeVerification = {
  provider: Exclude<AiPolicyProvider, "ollama" | "unknown">;
  upstream_provider: string;
  account_owner: string;
  billing_arrangement: "free_only";
  model: string;
  free_quota: string;
  hard_cap_enforced: true;
  dynamic_routing: false;
  verified_at: string;
  expires_at: string;
  evidence_reference: string;
};

export class AiSpendingPolicyError extends Error {
  decision: AiPolicyDecision;
  constructor(decision: AiPolicyDecision) {
    super(decision.block_reason ?? "Blocked by the free-tier spending policy.");
    this.name = "AiSpendingPolicyError";
    this.decision = decision;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isLoopbackAiEndpoint(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function externalVerificationIssue(
  evidence: ExternalFreeVerification | null | undefined,
  provider: Exclude<AiPolicyProvider, "ollama" | "unknown">,
  model: string | null,
  now: number = Date.now(),
): string | null {
  if (!evidence) return "No verification evidence exists for this external route.";
  if (evidence.provider !== provider) return "Verification evidence belongs to a different provider.";
  if (!text(evidence.upstream_provider) || /unknown|multiple|dynamic/i.test(evidence.upstream_provider)) {
    return "The actual upstream provider is not identified.";
  }
  if (!text(evidence.account_owner)) return "The upstream account owner is not identified.";
  if (evidence.billing_arrangement !== "free_only") return "The account is not verified as free-only.";
  if (!text(evidence.model)) return "The verified model is missing.";
  if (model && evidence.model !== model) return `Verification covers ${evidence.model}, not ${model}.`;
  if (!text(evidence.free_quota)) return "The applicable free quota is not documented.";
  if (evidence.hard_cap_enforced !== true) return "The provider does not enforce a no-overage hard cap.";
  if (evidence.dynamic_routing !== false) return "Dynamic upstream routing is not permitted.";
  if (!text(evidence.evidence_reference)) return "The evidence reference is missing.";
  const verifiedAt = Date.parse(evidence.verified_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt)) return "Verification timestamps are invalid.";
  if (verifiedAt > now) return "Verification is dated in the future.";
  if (now - verifiedAt > VERIFICATION_MAX_AGE_MS) return "Verification evidence is expired.";
  if (expiresAt <= now) return "Verification evidence has expired.";
  return null;
}

function freeTierBlockReason(provider: FreeTierStatus): string {
  const label = FREE_TIER_STATE_LABEL[provider.state];
  const base = `External inference blocked: ${provider.provider} free tier is ${label}. ${provider.detail}`;
  if (provider.state === "exhausted") {
    return `${base} This provider will not be used for free-tier inference until its quota resets or availability is independently verified. It will never be upgraded to a paid request.`;
  }
  if (provider.state === "blocked") {
    return `${base} A billing restriction can never be answered by paid access. Authorised external spend is CHF 0.00.`;
  }
  return `${base} Authorised external spend is CHF 0.00, and no paid model or endpoint may be substituted.`;
}

function baseDecision(input: AiPolicyContext): AiPolicyDecision {
  return {
    allowed: false,
    decision: "blocked",
    provider: input.provider,
    execution_type: "blocked",
    verified_free: false,
    verification_kind: null,
    estimated_cost_chf: null,
    maximum_authorised_cost_chf: MAX_AUTHORISED_EXTERNAL_AI_SPEND_CHF,
    billing_authority: "zero_spend",
    cost_status: "unverified",
    block_reason: null,
    verification_timestamp: null,
    evidence_reference: null,
    policy_id: AI_SPENDING_POLICY_ID,
    correlation_id: `aip_${randomUUID()}`,
    model: text(input.model) || null,
  };
}

function verifiedFreeDecision(
  decision: AiPolicyDecision,
  status: FreeTierStatus,
): AiPolicyDecision {
  return {
    ...decision,
    allowed: true,
    decision: "allowed",
    execution_type: "verified_free_external",
    verified_free: true,
    verification_kind:
      status.verification_kind === "owner_attestation"
        ? "owner_attestation"
        : status.verification_kind === "provider_evidence"
          ? "provider_evidence"
          : null,
    estimated_cost_chf: 0,
    maximum_authorised_cost_chf: 0,
    billing_authority: "zero_spend",
    cost_status: "unverified",
    verification_timestamp: status.verified_at ?? new Date().toISOString(),
    evidence_reference: status.evidence_reference,
  };
}

/** Pure evaluation used by enforcement, status and tests. It never sends a request. */
export function evaluateAiPolicy(input: AiPolicyContext, now: number = Date.now()): AiPolicyDecision {
  const decision = baseDecision(input);

  if (input.provider === "ollama") {
    const enabled = (process.env.OLLAMA_ENABLED ?? "false") === "true";
    const base = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").trim();
    const model = text(input.model) || (process.env.OLLAMA_MODEL ?? "").trim();
    if (!enabled) {
      return { ...decision, block_reason: "Local Ollama is disabled. No external fallback is permitted." };
    }
    if (!base || !model) {
      return { ...decision, block_reason: "Local Ollama is not completely configured. No external fallback is permitted." };
    }
    if (!isLoopbackAiEndpoint(base)) {
      return {
        ...decision,
        block_reason: `Ollama endpoint ${base} is not loopback. It cannot be verified as local inference, so it is blocked.`,
      };
    }
    return {
      ...decision,
      allowed: true,
      decision: "allowed",
      execution_type: "local",
      estimated_cost_chf: 0,
      model,
    };
  }

  if (input.provider === "unknown") {
    return { ...decision, block_reason: "Unknown AI provider. External inference is blocked." };
  }

  if (input.provider === "gemini") {
    const key = text(process.env.GEMINI_API_KEY);
    if (!key) {
      return {
        ...decision,
        block_reason: "Gemini is not configured: GEMINI_API_KEY is not set. No fallback provider is used for a missing credential.",
      };
    }
    if (!decision.model) {
      return { ...decision, block_reason: "A Gemini model identifier is required. No model was chosen silently." };
    }
    if (!/^gemini-[A-Za-z0-9._-]+$/.test(decision.model)) {
      return { ...decision, block_reason: `Model ${decision.model} is not a Gemini model identifier.` };
    }
    if (isPaidGeminiModel(decision.model) || !isFreeEligibleGeminiModel(decision.model)) {
      return {
        ...decision,
        block_reason: `Model ${decision.model} is not a verified Gemini free-tier model. Paid models are never used, even when GEMINI_PAID_AUTHORISED is set.`,
      };
    }
    const status = freeTierStatus("gemini", now, decision.model);
    if (!status.allowed) {
      return {
        ...decision,
        block_reason: freeTierBlockReason(status),
        verification_timestamp: status.verified_at,
        evidence_reference: status.evidence_reference,
      };
    }
    return verifiedFreeDecision(decision, status);
  }

  if (input.provider === "freellmapi") {
    if (!decision.model) {
      return { ...decision, block_reason: "A pinned FreeLLMAPI model identifier is required. Routing aliases are not permitted." };
    }
    if (isDynamicRoutingModel(decision.model) || isKnownBillableModel(decision.model)) {
      return {
        ...decision,
        block_reason: `Model ${decision.model} is a routing alias or a known billable id. Free-tier inference requires one pinned, non-billable model.`,
      };
    }
    const status = freeTierStatus("freellmapi", now, decision.model);
    if (!status.allowed) {
      return {
        ...decision,
        block_reason: freeTierBlockReason(status),
        verification_timestamp: status.verified_at,
        evidence_reference: status.evidence_reference,
      };
    }
    return verifiedFreeDecision(decision, status);
  }

  if (input.provider === "gemini-live") {
    // Separate voice transport under the same free-tier-only gate. There is no
    // paid path and no local speech-to-text/text-to-speech substitute.
    const key = text(process.env.GEMINI_API_KEY);
    if (!key) {
      return { ...decision, block_reason: "Gemini Live voice is not configured: GEMINI_API_KEY is not set. No fallback voice provider is used." };
    }
    const model = decision.model || text(process.env.GEMINI_LIVE_MODEL) || null;
    if (!model) {
      return { ...decision, block_reason: "Gemini Live voice requires a model identifier." };
    }
    const status = geminiLiveFreeTierStatus(now, model);
    if (!status.allowed) {
      return {
        ...decision,
        model,
        block_reason: `Gemini Live voice is blocked before transmission: ${status.detail} Authorised external spend is CHF 0.00.`,
        verification_timestamp: status.last_success_at,
        evidence_reference: status.evidence_reference,
      };
    }
    return {
      ...decision,
      allowed: true,
      decision: "allowed",
      provider: "gemini-live",
      model,
      execution_type: "verified_free_external",
      verified_free: true,
      verification_kind: status.verification_source === "owner_attestation" ? "owner_attestation" : "provider_evidence",
      estimated_cost_chf: 0,
      maximum_authorised_cost_chf: 0,
      billing_authority: "zero_spend",
      cost_status: "unverified",
      verification_timestamp: new Date(now).toISOString(),
      evidence_reference: status.evidence_reference,
    };
  }

  if (input.provider === "openrouter") {
    const enabled = (process.env.OPENROUTER_ENABLED ?? "false") === "true";
    const key = text(process.env.OPENROUTER_API_KEY);
    const model = decision.model || text(process.env.OPENROUTER_MODEL) || null;
    if (!enabled) {
      return { ...decision, model, block_reason: "OpenRouter is disabled (OPENROUTER_ENABLED is not true). No request is transmitted and no paid fallback is allowed. Authorised external spend is CHF 0.00." };
    }
    if (!key) {
      return { ...decision, model, block_reason: "OpenRouter is enabled but OPENROUTER_API_KEY is not set. No request is transmitted. Authorised external spend is CHF 0.00." };
    }
    if (!model) {
      return { ...decision, model, block_reason: "OpenRouter is enabled but no model is configured. No model is guessed and no request is transmitted." };
    }
    if (!isFreeOpenRouterModel(model)) {
      return { ...decision, model, block_reason: `OpenRouter model ${model} is not an exact free model id ending in :free. Paid models, dynamic routers and automatic model substitution are never used. Authorised external spend is CHF 0.00.` };
    }
    if (model === OPENROUTER_HEYGEN_TTS_MODEL) {
      const ttsIssue = openRouterTtsPolicyIssue(model);
      if (ttsIssue) return { ...decision, model, block_reason: ttsIssue };
    }
    const textExpiry = text(process.env.OPENROUTER_MODEL_EXPIRES_AT);
    if (textExpiry) {
      const parsed = Date.parse(textExpiry);
      if (!Number.isFinite(parsed)) {
        return { ...decision, model, block_reason: "OPENROUTER_MODEL_EXPIRES_AT is not a valid date. The model is blocked." };
      }
      const end = Date.UTC(new Date(parsed).getUTCFullYear(), new Date(parsed).getUTCMonth(), new Date(parsed).getUTCDate(), 23, 59, 59, 999);
      if (now >= end) {
        return { ...decision, model, block_reason: `${model} has expired. The paid or dynamic counterpart is never substituted.` };
      }
    }
    return {
      ...decision,
      allowed: true,
      decision: "allowed",
      model,
      execution_type: "verified_free_external",
      verified_free: true,
      // The catalogue and authenticated key check happen immediately before
      // transmission in the adapter; this policy gate only establishes the
      // exact free id and the absence of an expired/dynamic route.
      verification_kind: null,
      estimated_cost_chf: 0,
      maximum_authorised_cost_chf: 0,
      billing_authority: "zero_spend",
      cost_status: "unverified",
      block_reason: null,
    };
  }

  return {
    ...decision,
    block_reason: "External inference blocked: no verified free-tier route exists. Authorised external spend is CHF 0.00.",
  };
}

function persistDecision(input: AiPolicyContext, decision: AiPolicyDecision): void {
  try {
    run(
      `INSERT INTO ai_policy_decisions
         (created_at, correlation_id, agent_key, workflow_id, task_id, session_id, source, operation,
          provider, model, execution_type, decision, block_reason, verification_timestamp,
          evidence_reference, network_transmitted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        nowIso(),
        decision.correlation_id,
        input.agentKey ?? null,
        input.workflowId ?? null,
        input.taskId ?? null,
        input.sessionId ?? null,
        input.source ?? null,
        input.operation ?? null,
        decision.provider,
        decision.model,
        decision.execution_type,
        decision.decision,
        decision.block_reason,
        decision.verification_timestamp,
        decision.evidence_reference,
      ],
    );
  } catch (error) {
    // Audit persistence must never turn a blocked request into an allowed one.
    console.error(
      "[ai-policy] failed to persist decision",
      error instanceof Error ? error.message.slice(0, 300) : "unknown error",
    );
  }
}

/** Authorise and audit one request before any network transmission. */
export function authorizeAiRequest(input: AiPolicyContext, now: number = Date.now()): AiPolicyDecision {
  const decision = evaluateAiPolicy(input, now);
  persistDecision(input, decision);
  return decision;
}

/** Assert and return the decision, or throw the structured policy refusal. */
export function assertAiRequestAllowed(input: AiPolicyContext, now: number = Date.now()): AiPolicyDecision {
  const decision = authorizeAiRequest(input, now);
  if (!decision.allowed) throw new AiSpendingPolicyError(decision);
  return decision;
}

/** Mark the audited decision as having actually reached the network. */
export function markPolicyNetworkTransmitted(correlationId: string): void {
  try {
    run("UPDATE ai_policy_decisions SET network_transmitted = 1 WHERE correlation_id = ?", [correlationId]);
  } catch {
    // The request has already been authorised; audit marking is best-effort.
  }
}

export type PolicyDashboard = {
  policy: string;
  maximum_authorised_external_spend_chf: 0;
  external_inference: "free_tier_first" | "blocked";
  billing_authority: "zero_spend";
  cost_status: "unverified";
  free_tier: ReturnType<typeof freeTierSummary>;
  total_decisions: number;
  blocked_decisions: number;
  transmitted_decisions: number;
  last_decision_at: string | null;
  blocked_tasks: Array<{ id: string; title: string; agent_key: string; state_reason: string | null; created_at: string }>;
  recent_blocked: Array<{
    created_at: string;
    correlation_id: string;
    agent_key: string | null;
    provider: string;
    model: string | null;
    operation: string | null;
    block_reason: string | null;
  }>;
};

export function policyDashboard(): PolicyDashboard {
  const totals =
    one<{ total: number; blocked: number; transmitted: number; last: string | null }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN decision = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
              COALESCE(SUM(CASE WHEN network_transmitted = 1 THEN 1 ELSE 0 END), 0) AS transmitted,
              MAX(created_at) AS last
       FROM ai_policy_decisions`,
    ) ?? { total: 0, blocked: 0, transmitted: 0, last: null };
  const blockedTasks = all<{ id: string; title: string; agent_key: string; state_reason: string | null; created_at: string }>(
    `SELECT id, title, agent_key, state_reason, created_at
     FROM tasks
     WHERE ai_outcome = 'blocked' OR status = 'blocked'
     ORDER BY created_at DESC LIMIT 10`,
  );
  const recentBlocked = all<{
    created_at: string;
    correlation_id: string;
    agent_key: string | null;
    provider: string;
    model: string | null;
    operation: string | null;
    block_reason: string | null;
  }>(
    `SELECT created_at, correlation_id, agent_key, provider, model, operation, block_reason
     FROM ai_policy_decisions
     WHERE decision = 'blocked'
     ORDER BY id DESC LIMIT 12`,
  );
  const tolerant = freeTierSummary();
  const anyFree = tolerant.gemini.allowed || tolerant.freellmapi.allowed;
  return {
    policy: POLICY_LABEL,
    maximum_authorised_external_spend_chf: MAX_AUTHORISED_EXTERNAL_AI_SPEND_CHF,
    external_inference: anyFree ? "free_tier_first" : "blocked",
    billing_authority: "zero_spend",
    cost_status: "unverified",
    free_tier: tolerant,
    total_decisions: Number(totals.total),
    blocked_decisions: Number(totals.blocked),
    transmitted_decisions: Number(totals.transmitted),
    last_decision_at: totals.last,
    blocked_tasks: blockedTasks,
    recent_blocked: recentBlocked,
  };
}

/** Short, safe text for agent warnings and UI copy. */
export function zeroSpendSummary(): string {
  const summary = freeTierSummary();
  const states = [summary.gemini, summary.freellmapi]
    .map((item) => `${item.provider}: ${FREE_TIER_STATE_LABEL[item.state]}`)
    .join(" · ");
  return `Free-tier first, CHF 0.00 external spend. ${states}. ${summary.detail} Loopback Ollama remains local-only; paid models, endpoints and fallbacks are never used.`;
}
