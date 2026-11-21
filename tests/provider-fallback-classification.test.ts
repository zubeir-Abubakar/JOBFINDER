import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Failure classification is a safety boundary: a configuration or model-policy
 * defect must fail closed and must never be answered by the local model.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-fallback-classes-"));
process.env.APP_SECRET_KEY = "fallback-classification-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://ollama.test";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

let gatewayReply: "ok" | "auth" | "bad_request" | "rate" | "outage" | "timeout" = "ok";
let gatewayCalls = 0;
let ollamaCalls = 0;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v1/models")) return json({ data: [{ id: "gateway-model" }] });
  if (url.endsWith("/v1/chat/completions")) {
    gatewayCalls += 1;
    if (gatewayReply === "auth") return json({ error: { message: "Invalid API key supplied." } }, 401);
    if (gatewayReply === "bad_request") return json({ error: { message: "Invalid request: malformed messages." } }, 400);
    if (gatewayReply === "rate") return json({ error: { message: "Too many requests." } }, 429, { "Retry-After": "1" });
    if (gatewayReply === "outage") return json({ error: { message: "Service temporarily unavailable." } }, 503);
    if (gatewayReply === "timeout") throw new DOMException("The operation timed out", "TimeoutError");
    return json({
      model: "gateway-model",
      choices: [{ message: { content: "primary reply" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });
  }
  if (url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    return json({ model: "llama3.2:3b", message: { content: "local reply" }, prompt_eval_count: 2, eval_count: 2 });
  }
  if (url.endsWith("/api/tags")) return json({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }] });
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const { getDb } = await import("../lib/db.ts");
const {
  AiProviderConfigError,
  clearGatewayCooldown,
  generateText,
} = await import("../lib/providers.ts");
const { classifyProviderFailure, clearProviderCooldowns, failureCooldownMs, isFailClosedFailure } = await import(
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

function reset(reply: typeof gatewayReply = "ok"): void {
  gatewayReply = reply;
  gatewayCalls = 0;
  ollamaCalls = 0;
  clearGatewayCooldown();
  clearProviderCooldowns();
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

test("authentication, configuration and model-policy failures fail closed with no cooldown", () => {
  for (const kind of ["authentication", "configuration", "model_policy"] as const) {
    assert.equal(isFailClosedFailure(kind), true, `${kind} must fail closed`);
    assert.equal(failureCooldownMs(kind), 0, `${kind} must not create a route cooldown`);
  }
  for (const kind of ["rate_limited", "timeout", "unavailable", "overloaded"] as const) {
    assert.equal(isFailClosedFailure(kind), false, `${kind} is a recoverable route failure`);
  }
});

test("a local model-policy refusal never falls back to Ollama", async () => {
  const saved = process.env.FREELLMAPI_MODEL;
  process.env.FREELLMAPI_MODEL = "blocked-model";
  reset("ok");
  try {
    await assert.rejects(generateText(input()), (error: unknown) => {
      assert.ok(error instanceof AiProviderConfigError, "the policy refusal must surface as a configuration error");
      assert.match(error.message, /not listed in FREELLMAPI_ALLOWED_MODELS/);
      return true;
    });
    assert.equal(gatewayCalls, 0, "the gateway is never called for a locally rejected model");
    assert.equal(ollamaCalls, 0, "Ollama must not hide the configuration defect");
  } finally {
    process.env.FREELLMAPI_MODEL = saved;
  }
});

test("a 401 authentication failure fails closed", async () => {
  reset("auth");
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof AiProviderConfigError);
    assert.match(error.message, /Authentication failed/);
    return true;
  });
  assert.equal(ollamaCalls, 0);
});

test("a 400 request/configuration failure fails closed", async () => {
  reset("bad_request");
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof AiProviderConfigError);
    assert.match(error.message, /configuration failed/);
    return true;
  });
  assert.equal(ollamaCalls, 0);
});

test("a 429 rate limit is recoverable and uses the local fallback", async () => {
  reset("rate");
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(ollamaCalls, 1);
});

test("an outage and a timeout are recoverable and use the local fallback", async () => {
  reset("outage");
  const outage = await generateText(input());
  assert.equal(outage.provider, "ollama");

  reset("timeout");
  const timeout = await generateText(input());
  assert.equal(timeout.provider, "ollama");
  assert.equal(ollamaCalls, 1);
});
