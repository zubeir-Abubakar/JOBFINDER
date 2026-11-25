import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Provider-specific owner attestation.
 *
 * No real provider is contacted. The fetch boundary is mocked so the tests can
 * prove that Gemini and FreeLLMAPI use their configured models, that missing or
 * malformed evidence still fails closed, and that paid/dynamic models remain
 * unreachable.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-owner-attestation-"));
process.env.APP_SECRET_KEY = "owner-attestation-test-secret";
process.env.AI_PRIMARY_PROVIDER = "gemini";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.AI_BUDGET_LIMIT_CHF = "1000"; // adversarial: code must keep CHF 0.00
process.env.AI_ALLOW_PAID_MODELS = "true"; // adversarial: ignored by policy
process.env.AI_ALLOW_BILLING_FALLBACK = "true"; // adversarial: ignored by policy
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = "";
process.env.GEMINI_FREE_TIER_ATTESTATION = "owner_confirmed";
process.env.GEMINI_LIVE_FREE_TIER_ATTESTATION = "owner_confirmed";
process.env.GEMINI_PAID_AUTHORISED = "true"; // legacy: ignored
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31415/v1";
process.env.FREELLMAPI_API_KEY = "test-freellmapi-key";
process.env.FREELLMAPI_MODEL = "gpt-oss-20b";
process.env.FREELLMAPI_ALLOWED_MODELS = "gpt-oss-20b";
process.env.FREELLMAPI_MODEL_ALIASES = "openai/gpt-oss-20b";
process.env.FREELLMAPI_FREE_TIER_VERIFIED = "true";
process.env.FREELLMAPI_FREE_TIER_EVIDENCE = "";
process.env.FREELLMAPI_FREE_TIER_ATTESTATION = "owner_confirmed";
process.env.OLLAMA_ENABLED = "false";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_MODEL;
process.env.OPENROUTER_ALLOW_PAID_MODELS = "true"; // adversarial: ignored
process.env.OPENROUTER_ALLOW_CREDITS = "true";
process.env.OPENROUTER_ALLOW_AUTO_RECHARGE = "true";

let geminiCalls = 0;
let freeLlmCalls = 0;
let ollamaCalls = 0;
let openRouterCalls = 0;
const contactedHosts: string[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).host;
  contactedHosts.push(host);
  if (host === "generativelanguage.googleapis.com") {
    geminiCalls += 1;
    return json({
      candidates: [{ content: { parts: [{ text: "OK" }], role: "model" }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 },
      modelVersion: "gemini-3.6-flash",
    });
  }
  if (host === "127.0.0.1:31415" && url.endsWith("/chat/completions")) {
    freeLlmCalls += 1;
    return json({
      model: "gpt-oss-20b",
      choices: [{ message: { content: "OK" } }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
  }
  if (url.endsWith("/api/tags") || url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    return json({ error: "Ollama must not be called by this test" }, 503);
  }
  if (host.endsWith("openrouter.ai")) {
    openRouterCalls += 1;
    throw new Error("OpenRouter must not be called");
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const freeTier = await import("../lib/free-tier.ts");
const policy = await import("../lib/ai-spending-policy.ts");
const providers = await import("../lib/providers.ts");
const health = await import("../lib/provider-health.ts");
const db = await import("../lib/db.ts");
const { agentRouteTable } = await import("../lib/agent-models.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

beforeEach(() => {
  geminiCalls = 0;
  freeLlmCalls = 0;
  ollamaCalls = 0;
  openRouterCalls = 0;
  contactedHosts.length = 0;
  freeTier.clearFreeTierExhaustion();
  health.clearProviderCooldowns();
  db.run("DELETE FROM provider_usage");
});

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
    system: "Use only the supplied instruction.",
    prompt: "Reply with exactly OK.",
    maxTokens: 32,
    temperature: 0,
  };
}

test("owner attestation makes Gemini and FreeLLMAPI eligible without pretending to be provider evidence", () => {
  const gemini = freeTier.freeTierStatus("gemini");
  assert.equal(gemini.state, "available");
  assert.equal(gemini.allowed, true);
  assert.equal(gemini.verification_kind, "owner_attestation");
  assert.equal(gemini.eligibility, "owner_attested");
  assert.equal(gemini.verification_source, "owner_attestation");
  assert.equal(gemini.evidence_reference, null);
  assert.match(gemini.detail, /owner-attested|not provider-issued billing evidence/i);

  const freeLlm = freeTier.freeTierStatus("freellmapi");
  assert.equal(freeLlm.state, "available");
  assert.equal(freeLlm.allowed, true);
  assert.equal(freeLlm.verification_kind, "owner_attestation");
  assert.equal(freeLlm.eligibility, "owner_attested");

  const geminiDecision = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" });
  assert.equal(geminiDecision.allowed, true);
  assert.equal(geminiDecision.verification_kind, "owner_attestation");
  assert.equal(geminiDecision.estimated_cost_chf, 0);
  assert.equal(geminiDecision.maximum_authorised_cost_chf, 0);
  assert.equal(geminiDecision.billing_authority, "zero_spend");

  const freeLlmDecision = policy.evaluateAiPolicy({ provider: "freellmapi", model: "gpt-oss-20b" });
  assert.equal(freeLlmDecision.allowed, true);
  assert.equal(freeLlmDecision.verification_kind, "owner_attestation");
  assert.equal(freeLlmDecision.estimated_cost_chf, 0);
});

test("missing attestation blocks both external providers before fetch", async () => {
  await withEnv(
    { GEMINI_FREE_TIER_ATTESTATION: undefined, FREELLMAPI_FREE_TIER_ATTESTATION: undefined },
    async () => {
      assert.equal(freeTier.freeTierStatus("gemini").allowed, false);
      assert.equal(freeTier.freeTierStatus("freellmapi").allowed, false);
      await assert.rejects(providers.generateText(input("analysis")), (error: unknown) => {
        assert.ok(error instanceof policy.AiSpendingPolicyError);
        assert.match(error.message, /UNVERIFIED|owner_confirmed|blocked/i);
        return true;
      });
      assert.equal(geminiCalls, 0);
      assert.equal(freeLlmCalls, 0);
      assert.equal(ollamaCalls, 0);
      assert.equal(contactedHosts.length, 0);
    },
  );
});

test("malformed evidence does not fall back to owner attestation", () => {
  withEnv(
    { GEMINI_FREE_TIER_EVIDENCE: "{not-json", FREELLMAPI_FREE_TIER_EVIDENCE: "{not-json" },
    () => {
      const gemini = freeTier.freeTierStatus("gemini");
      assert.equal(gemini.state, "unverified");
      assert.equal(gemini.allowed, false);
      assert.match(gemini.detail, /not valid JSON/i);

      const freeLlm = freeTier.freeTierStatus("freellmapi");
      assert.equal(freeLlm.state, "unverified");
      assert.equal(freeLlm.allowed, false);
      assert.match(freeLlm.detail, /not valid JSON/i);
    },
  );
});

test("paid and dynamic model identifiers stay blocked under owner attestation", () => {
  assert.equal(policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-2.5-pro" }).allowed, false);
  assert.match(
    policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-2.5-pro" }).block_reason ?? "",
    /paid|free-tier/i,
  );

  for (const model of ["auto", "free-router", "claude-opus-4-5", "gpt-5"]) {
    const decision = policy.evaluateAiPolicy({ provider: "freellmapi", model });
    assert.equal(decision.allowed, false, model);
    assert.match(decision.block_reason ?? "", /billable|routing alias|pinned/i, model);
  }

  withEnv(
    {
      OPENROUTER_ENABLED: "true",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_MODEL: "openrouter/free",
    },
    () => {
      const decision = policy.evaluateAiPolicy({ provider: "openrouter", model: "openrouter/free" });
      assert.equal(decision.allowed, false);
      assert.match(decision.block_reason ?? "", /exact free|:free|Paid|dynamic/i);
      assert.equal(openRouterCalls, 0);
    },
  );

  withEnv(
    {
      OPENROUTER_ENABLED: "true",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_MODEL: "meta-llama/llama-3.3-8b-instruct:free",
    },
    () => {
      assert.equal(freeTier.isFreeOpenRouterModel("meta-llama/llama-3.3-8b-instruct:free"), true);
      assert.equal(freeTier.isFreeOpenRouterModel("openrouter/free"), false);
      assert.equal(freeTier.isFreeOpenRouterModel("openai/gpt-4:free"), false);
      const decision = policy.evaluateAiPolicy({
        provider: "openrouter",
        model: "meta-llama/llama-3.3-8b-instruct:free",
      });
      assert.equal(decision.allowed, true, "an exact free id passes the preflight policy gate");
      assert.equal(decision.execution_type, "verified_free_external");
      assert.equal(decision.estimated_cost_chf, 0);
      assert.equal(openRouterCalls, 0, "the policy gate itself never contacts OpenRouter");
    },
  );
});

test("the configured agent assignments use Gemini and FreeLLMAPI, never OpenRouter or Ollama", async () => {
  const routes = Object.fromEntries(agentRouteTable().map((route) => [route.agentKey, route.provider]));
  assert.deepEqual(routes, {
    coordinator: "gemini",
    research: "gemini",
    analysis: "freellmapi",
    cv: "gemini",
    ats: "gemini",
    cover: "freellmapi",
    application: "gemini",
    email: "gemini",
  });

  const noor = await providers.generateText(input("application"));
  assert.equal(noor.provider, "gemini");
  assert.equal(noor.model, "gemini-3.6-flash");
  assert.ok(noor.text.length > 0);

  const ali = await providers.generateText(input("analysis"));
  assert.equal(ali.provider, "freellmapi");
  assert.equal(ali.model, "gpt-oss-20b");
  assert.ok(ali.text.length > 0);

  assert.equal(ollamaCalls, 0);
  assert.equal(openRouterCalls, 0);
  assert.ok(contactedHosts.every((host) => host === "generativelanguage.googleapis.com" || host === "127.0.0.1:31415"));

  const usage = db.all<{ provider: string; model: string; agent_key: string }>(
    "SELECT provider, model, agent_key FROM provider_usage WHERE status = 'ok' ORDER BY id",
  );
  assert.deepEqual(
    usage.map((row) => `${row.agent_key}:${row.provider}:${row.model}`),
    ["application:gemini:gemini-3.6-flash", "analysis:freellmapi:gpt-oss-20b"],
  );
});

test("Gemini Live keeps its separate owner attestation", () => {
  const live = freeTier.geminiLiveFreeTierStatus();
  assert.equal(live.state, "available");
  assert.equal(live.allowed, true);
  assert.equal(live.verification_source, "owner_attestation");
  assert.equal(live.eligibility, "owner_attested");
  assert.equal(live.model, "gemini-3.8-live");
});
