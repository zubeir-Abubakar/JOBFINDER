import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freeLlmEvidence, geminiEvidence } from "./helpers/free-tier-evidence.ts";

/**
 * Free-tier-first provider policy.
 *
 * No real provider is contacted. Gemini, FreeLLMAPI and Ollama are intercepted
 * at the fetch boundary, and the assertions cover the real router, policy,
 * quota state, cross-provider fallback and paid-provider blocking.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-free-tier-"));
process.env.APP_SECRET_KEY = "free-tier-test-secret";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31415/v1";
process.env.FREELLMAPI_API_KEY = "test-freellmapi-key";
process.env.FREELLMAPI_MODEL = "gpt-oss-20b";
process.env.FREELLMAPI_ALLOWED_MODELS = "gpt-oss-20b";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.FREELLMAPI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = geminiEvidence();
process.env.FREELLMAPI_FREE_TIER_EVIDENCE = freeLlmEvidence();
process.env.AI_PRIMARY_PROVIDER = "gemini";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.OPENROUTER_ENABLED = "true";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL = "openrouter/free";

type Mode = "ok" | "quota" | "rate" | "unavailable";
let geminiMode: Mode = "ok";
let freeLlmMode: Mode = "ok";
let ollamaMode: "ok" | "fail" = "ok";
let geminiCalls = 0;
let freeLlmCalls = 0;
let ollamaCalls = 0;
let contactedHosts: string[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function geminiSuccess(): Response {
  return json({
    candidates: [{ content: { parts: [{ text: "gemini free-tier reply" }], role: "model" }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  contactedHosts.push(new URL(url).host);
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls += 1;
    if (geminiMode === "quota") {
      return json(
        {
          error: {
            code: 429,
            message: "You exceeded your current quota for this model (daily limit)",
            status: "RESOURCE_EXHAUSTED",
          },
        },
        429,
      );
    }
    if (geminiMode === "rate") {
      return json({ error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }, 429);
    }
    if (geminiMode === "unavailable") {
      return json({ error: { code: 503, message: "Service temporarily unavailable", status: "UNAVAILABLE" } }, 503);
    }
    // Rayna's classification path must receive a valid label from its model.
    if (String(init?.body ?? "").includes("classify recruitment email")) {
      return json({
        candidates: [{ content: { parts: [{ text: "acknowledgement" }], role: "model" }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1, totalTokenCount: 6 },
      });
    }
    return geminiSuccess();
  }
  if (url.endsWith("/v1/chat/completions")) {
    freeLlmCalls += 1;
    if (freeLlmMode === "quota") {
      return json({ error: { message: "You exceeded your current quota (daily limit)" } }, 429);
    }
    if (freeLlmMode === "rate") {
      return json({ error: { message: "429 too many requests" } }, 429);
    }
    if (freeLlmMode === "unavailable") return json({ error: { message: "gateway unavailable" } }, 503);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return json({
      model: body.model ?? "gpt-oss-20b",
      choices: [{ message: { content: "freellmapi free-tier reply" } }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
  }
  if (url.endsWith("/v1/models")) {
    return json({ data: [{ id: "gpt-oss-20b" }] });
  }
  if (url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    if (ollamaMode === "fail") return json({ error: "local model crashed" }, 503);
    return json({ model: "llama3.2:3b", message: { content: "local reply" }, prompt_eval_count: 4, eval_count: 3 });
  }
  if (url.endsWith("/api/tags")) {
    return json({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }] });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const policy = await import("../lib/ai-spending-policy.ts");
const freeTier = await import("../lib/free-tier.ts");
const providers = await import("../lib/providers.ts");
const health = await import("../lib/provider-health.ts");
const db = await import("../lib/db.ts");
const { AGENT_DEFINITIONS } = await import("../lib/agent-definitions.ts");
const { agentRoutePreference, agentRouteTable } = await import("../lib/agent-models.ts");

db.getDb();

function reset(): void {
  geminiMode = "ok";
  freeLlmMode = "ok";
  ollamaMode = "ok";
  geminiCalls = 0;
  freeLlmCalls = 0;
  ollamaCalls = 0;
  contactedHosts = [];
  freeTier.clearFreeTierExhaustion();
  health.clearProviderCooldowns();
  providers.clearGatewayCooldown();
  db.run("DELETE FROM provider_usage");
}

function withEnv(values: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore);
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

function input(agentKey: string) {
  return {
    agentKey,
    source: "manual" as const,
    system: "Use only supplied facts. Answer briefly.",
    prompt: "Return one short sentence.",
    maxTokens: 24,
    temperature: 0,
  };
}

beforeEach(reset);

test("a declared free tier is allowed for text with CHF 0.00 estimated cost", () => {
  const gemini = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" });
  assert.equal(gemini.allowed, true);
  assert.equal(gemini.execution_type, "verified_free_external");
  assert.equal(gemini.verified_free, true);
  assert.equal(gemini.estimated_cost_chf, 0);
  assert.equal(gemini.maximum_authorised_cost_chf, 0);
  assert.equal(gemini.billing_authority, "zero_spend");

  const gateway = policy.evaluateAiPolicy({ provider: "freellmapi", model: "gpt-oss-20b" });
  assert.equal(gateway.allowed, true);
  assert.equal(gateway.execution_type, "verified_free_external");
  assert.equal(gateway.estimated_cost_chf, 0);
});

test("an unverified free tier is blocked before transmission, even with credentials", async () => {
  await withEnv(
    { GEMINI_FREE_TIER_VERIFIED: "false", FREELLMAPI_FREE_TIER_VERIFIED: "false", OLLAMA_ENABLED: "false" },
    async () => {
      assert.equal(policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" }).allowed, false);
      assert.equal(policy.evaluateAiPolicy({ provider: "freellmapi", model: "gpt-oss-20b" }).allowed, false);
      await assert.rejects(
        providers.generateText(input("application")),
        (error: unknown) => error instanceof policy.AiSpendingPolicyError,
      );
      assert.equal(geminiCalls, 0);
      assert.equal(freeLlmCalls, 0);
      assert.equal(contactedHosts.length, 0);
    },
  );
});

test("a paid Gemini model is refused even when the free-tier flag is set", () => {
  const decision = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-2.5-pro" });
  assert.equal(decision.allowed, false);
  assert.match(decision.block_reason ?? "", /not a verified Gemini free-tier model|paid/i);
});

test("dynamic routing and billable FreeLLMAPI ids are refused", () => {
  for (const model of ["auto", "free-router", "claude-opus-4-5", "gpt-5"]) {
    const decision = policy.evaluateAiPolicy({ provider: "freellmapi", model });
    assert.equal(decision.allowed, false, model);
    assert.match(decision.block_reason ?? "", /routing alias|billable|pinned/i, model);
  }
});

test("OpenRouter is never permitted, even when enabled and credentialed", () => {
  const decision = policy.evaluateAiPolicy({ provider: "openrouter", model: "openrouter/free" });
  assert.equal(decision.allowed, false);
  assert.match(decision.block_reason ?? "", /OpenRouter|not a permitted free-tier provider/i);
});

test("a confirmed quota exhaustion blocks the provider; an ordinary rate limit does not", () => {
  const now = Date.parse("2026-11-23T10:00:00.000Z");
  freeTier.recordFreeTierFailure({
    provider: "gemini",
    model: "gemini-3.6-flash",
    kind: "quota_exhausted",
    message: "You exceeded your current quota for this model (daily limit)",
    now,
  });
  const exhausted = freeTier.freeTierStatus("gemini", now + 60_000);
  assert.equal(exhausted.state, "exhausted");
  assert.equal(exhausted.allowed, false);
  assert.ok(exhausted.reset_at);
  assert.equal(policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" }, now + 60_000).allowed, false);

  freeTier.clearFreeTierExhaustion("gemini");
  freeTier.recordFreeTierFailure({
    provider: "gemini",
    model: "gemini-3.6-flash",
    kind: "quota_exhausted",
    message: "429 Too many requests (RESOURCE_EXHAUSTED)",
    now,
  });
  const rateLimited = freeTier.freeTierStatus("gemini", now + 60_000);
  assert.equal(rateLimited.state, "available", "a rate limit is not proof of quota exhaustion");
  assert.equal(rateLimited.allowed, true);
});

test("an exhausted provider becomes available again after its reset time", () => {
  const now = Date.parse("2026-11-23T10:00:00.000Z");
  freeTier.recordFreeTierFailure({
    provider: "freellmapi",
    model: "gpt-oss-20b",
    kind: "quota_exhausted",
    message: "daily limit reached",
    retryAfterMs: 60_000,
    now,
  });
  assert.equal(freeTier.freeTierStatus("freellmapi", now + 30_000).state, "exhausted");
  assert.equal(freeTier.freeTierStatus("freellmapi", now + 61_000).state, "available");
});

test("Agent assignments use the configured free-tier models", () => {
  assert.equal(agentRoutePreference("analysis").provider, "freellmapi");
  assert.equal(agentRoutePreference("analysis").model, "gpt-oss-20b");
  assert.equal(agentRoutePreference("cover").provider, "freellmapi");
  assert.equal(agentRoutePreference("application").provider, "gemini");
  assert.equal(agentRoutePreference("application").model, "gemini-3.6-flash");
  assert.equal(agentRoutePreference("ats").provider, "gemini");
  assert.equal(agentRoutePreference("email").provider, "gemini");
  assert.equal(agentRoutePreference("cv").provider, "gemini");
  assert.equal(agentRoutePreference("research").provider, "gemini");
  assert.equal(agentRoutePreference("coordinator").provider, "gemini");
  assert.equal(agentRouteTable().length, 8);
  for (const definition of AGENT_DEFINITIONS) {
    assert.ok(agentRouteTable().some((route) => route.agentKey === definition.key), definition.key);
  }
});

test("Ali and Amira use the pinned FreeLLMAPI free-tier model", async () => {
  for (const key of ["analysis", "cover"]) {
    reset();
    const result = await providers.generateText(input(key));
    assert.equal(result.provider, "freellmapi", key);
    assert.equal(result.model, "gpt-oss-20b", key);
    assert.equal(geminiCalls, 0, key);
    const row = db.one<{ provider: string; execution_type: string }>(
      "SELECT provider, execution_type FROM ai_policy_decisions WHERE decision = 'allowed' ORDER BY id DESC LIMIT 1",
    );
    assert.equal(row?.provider, "freellmapi");
    assert.equal(row?.execution_type, "verified_free_external");
  }
});

test("Noor, Kali and Rayna use free-tier Gemini", async () => {
  for (const key of ["application", "ats", "email"]) {
    reset();
    const result = await providers.generateText(input(key));
    assert.equal(result.provider, "gemini", key);
    assert.equal(result.model, "gemini-3.6-flash", key);
    assert.equal(freeLlmCalls, 0, key);
  }
});

test("FreeLLMAPI exhaustion falls across to Gemini without a paid request", async () => {
  freeLlmMode = "quota";
  const result = await providers.generateText(input("analysis"));
  assert.equal(result.provider, "gemini");
  assert.equal(result.diagnostics?.fallbackFrom, "freellmapi");
  assert.match(result.diagnostics?.fallbackReason ?? "", /quota/i);
  assert.equal(freeTier.freeTierStatus("freellmapi").state, "exhausted");
  const usage = db.one<{ provider: string; fallback_from: string }>(
    "SELECT provider, fallback_from FROM provider_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(usage?.provider, "gemini");
  assert.equal(usage?.fallback_from, "freellmapi");
  assert.ok(
    contactedHosts.every((host) => /^(generativelanguage\.googleapis\.com|127\.0\.0\.1|localhost)(:\d+)?$/.test(host)),
  );
});

test("Gemini exhaustion falls across to FreeLLMAPI for a Gemini-first agent", async () => {
  geminiMode = "quota";
  const result = await providers.generateText(input("application"));
  assert.equal(result.provider, "freellmapi");
  assert.equal(result.diagnostics?.fallbackFrom, "gemini");
  assert.equal(freeTier.freeTierStatus("gemini").state, "exhausted");
});

test("with both free tiers exhausted, loopback Ollama serves the call locally", async () => {
  const now = new Date().toISOString();
  freeTier.recordFreeTierFailure({
    provider: "gemini",
    model: "gemini-3.6-flash",
    kind: "quota_exhausted",
    message: "daily limit reached",
    now: Date.parse(now),
  });
  freeTier.recordFreeTierFailure({
    provider: "freellmapi",
    model: "gpt-oss-20b",
    kind: "quota_exhausted",
    message: "daily limit reached",
    now: Date.parse(now),
  });
  const result = await providers.generateText(input("analysis"));
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "llama3.2:3b");
  assert.equal(geminiCalls, 0);
  assert.equal(freeLlmCalls, 0);
  assert.equal(ollamaCalls, 1);
});

test("with both free tiers exhausted and no local model, the task is blocked with no paid call", async () => {
  const now = Date.now();
  for (const provider of ["gemini", "freellmapi"] as const) {
    freeTier.recordFreeTierFailure({
      provider,
      model: provider === "gemini" ? "gemini-3.6-flash" : "gpt-oss-20b",
      kind: "quota_exhausted",
      message: "daily limit reached",
      now,
    });
  }
  await withEnv({ OLLAMA_ENABLED: "false" }, async () => {
    await assert.rejects(providers.generateText(input("analysis")), (error: unknown) => {
      assert.ok(error instanceof policy.AiSpendingPolicyError);
      assert.match(error.message, /free tier is EXHAUSTED|blocked/i);
      return true;
    });
  });
  assert.equal(geminiCalls, 0);
  assert.equal(freeLlmCalls, 0);
  assert.ok(!contactedHosts.some((host) => /openrouter|groq|cloudflare|ovh|openai/i.test(host)));
});

test("a non-loopback Ollama endpoint is not treated as local inference", () => {
  const decision = policy.evaluateAiPolicy({ provider: "ollama", model: "llama3.2:3b" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.execution_type, "local");
  const original = process.env.OLLAMA_BASE_URL;
  process.env.OLLAMA_BASE_URL = "http://ollama.example.com:11434";
  try {
    assert.equal(policy.evaluateAiPolicy({ provider: "ollama", model: "llama3.2:3b" }).allowed, false);
  } finally {
    process.env.OLLAMA_BASE_URL = original;
  }
});

test("Rayna's email classification reasoning path uses free-tier Gemini", async () => {
  const { enqueueAiJob, drainAiQueue } = await import("../lib/ai-queue.ts");
  const queued = enqueueAiJob({
    kind: "email_classification",
    dedupeKey: "rayna:classification:free-tier",
    agentKey: "email",
    source: "manual",
    priority: 2,
    payload: { subject: "Application received", body: "Thank you for applying to Example AG." },
  });
  await drainAiQueue();
  const job = db.one<{ status: string; provider: string | null; model: string | null; result: string | null }>(
    "SELECT status, provider, model, result FROM ai_jobs WHERE id = ?",
    [queued.job.id],
  );
  assert.equal(job?.status, "completed");
  assert.equal(job?.provider, "gemini");
  assert.equal(job?.model, "gemini-3.6-flash");
  assert.equal(job?.result, "acknowledgement");
  assert.equal(freeLlmCalls, 0, "Rayna's classification did not need the FreeLLMAPI route");
});

test("the daily application target and autonomous submission are unchanged", async () => {
  const recruitment = await import("../lib/recruitment-policy.ts");
  assert.equal(recruitment.DEFAULT_MAX_SUBMISSIONS_PER_DAY, 3);
  assert.equal(recruitment.MAX_SUBMISSIONS_PER_DAY_LIMIT, 3);
});
