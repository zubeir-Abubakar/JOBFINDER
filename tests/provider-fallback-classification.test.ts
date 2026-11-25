import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Failure classification remains useful for diagnostics, but no classified
 * external failure may be retried or answered by another provider. Policy is
 * checked before the network boundary, so these tests must see zero fetches.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-fallback-classes-"));
process.env.APP_SECRET_KEY = "fallback-classification-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "2";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://ollama.test";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

let fetchCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchCalls += 1;
  throw new Error(`No network request is permitted: ${String(input)}`);
}) as typeof fetch;

const { getDb } = await import("../lib/db.ts");
const { generateText } = await import("../lib/providers.ts");
const { AiSpendingPolicyError } = await import("../lib/ai-spending-policy.ts");
const { classifyProviderFailure, failureCooldownMs, isFailClosedFailure } = await import(
  "../lib/provider-health.ts"
);

getDb();

function input() {
  return {
    agentKey: "analysis",
    source: "assistant" as const,
    system: "Use only supplied facts.",
    prompt: "Answer briefly.",
    maxTokens: 16,
    temperature: 0,
  };
}

test("each failure class is classified explicitly", () => {
  assert.equal(classifyProviderFailure("Invalid API key supplied.", 401), "authentication");
  assert.equal(classifyProviderFailure("Request/model configuration failed (HTTP 400)", 400), "configuration");
  assert.equal(
    classifyProviderFailure("Refused: gpt-oss-20b is not listed in FREELLMAPI_ALLOWED_MODELS."),
    "model_policy",
  );
  assert.equal(classifyProviderFailure("Gateway resolved gateway-model to other-model", 200), "unknown");
  assert.equal(classifyProviderFailure("Too many requests", 429), "rate_limited");
  assert.equal(classifyProviderFailure("The operation timed out", null), "timeout");
  assert.equal(classifyProviderFailure("fetch failed: ECONNREFUSED", null), "unavailable");
  assert.equal(classifyProviderFailure("Service temporarily unavailable.", 503), "overloaded");
  assert.equal(classifyProviderFailure("model not found", 404), "model_unavailable");
});

test("authentication, configuration and model-policy failures are terminal for a route", () => {
  for (const kind of ["authentication", "configuration", "model_policy"] as const) {
    assert.equal(isFailClosedFailure(kind), true, `${kind} must fail closed`);
    assert.equal(failureCooldownMs(kind), 0, `${kind} must not create a route cooldown`);
  }
  for (const kind of ["rate_limited", "timeout", "unavailable", "overloaded"] as const) {
    assert.equal(isFailClosedFailure(kind), false, `${kind} is a recoverable route failure`);
  }
});

test("FreeLLMAPI policy refusal is terminal and never falls back to Ollama", async () => {
  fetchCalls = 0;
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof AiSpendingPolicyError);
    assert.match(error.message, /CHF 0\.00|blocked/i);
    return true;
  });
  assert.equal(fetchCalls, 0, "neither the gateway nor Ollama may be contacted");
});

test("changing model names, allowlists or retry counts cannot bypass the policy", async () => {
  const savedModel = process.env.FREELLMAPI_MODEL;
  const savedAllowed = process.env.FREELLMAPI_ALLOWED_MODELS;
  const savedRetries = process.env.AI_MAX_RETRIES;
  process.env.FREELLMAPI_MODEL = "claude-opus-4-5";
  process.env.FREELLMAPI_ALLOWED_MODELS = "claude-opus-4-5";
  process.env.AI_MAX_RETRIES = "4";
  fetchCalls = 0;
  try {
    await assert.rejects(generateText(input()), (error: unknown) => {
      assert.ok(error instanceof AiSpendingPolicyError);
      return true;
    });
    assert.equal(fetchCalls, 0, "a billable model name and four retries still transmit nothing");
  } finally {
    if (savedModel === undefined) delete process.env.FREELLMAPI_MODEL;
    else process.env.FREELLMAPI_MODEL = savedModel;
    if (savedAllowed === undefined) delete process.env.FREELLMAPI_ALLOWED_MODELS;
    else process.env.FREELLMAPI_ALLOWED_MODELS = savedAllowed;
    if (savedRetries === undefined) delete process.env.AI_MAX_RETRIES;
    else process.env.AI_MAX_RETRIES = savedRetries;
  }
});
