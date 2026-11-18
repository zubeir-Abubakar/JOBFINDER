import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The provider tests mock both HTTP boundaries. They exercise the real
 * generateText() router, cooldown state, usage rows and caller-side single
 * result, without requiring a local Ollama daemon in CI.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-ollama-fallback-"));
process.env.APP_SECRET_KEY = "ollama-fallback-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.AI_RATE_LIMIT_DEFAULT_SECONDS = "1";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://ollama.test";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.GEMINI_API_KEY = "";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;

type Mode = "ok" | "rate" | "outage";
let gatewayMode: Mode = "ok";
let ollamaMode: "ok" | "fail" | "missing" = "ok";
let gatewayCalls = 0;
let ollamaCalls = 0;
let lastOllamaModel = "";
let lastOllamaPrompt = "";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v1/models")) {
    return json({ data: [{ id: "gateway-model" }] });
  }
  if (url.endsWith("/v1/chat/completions")) {
    gatewayCalls += 1;
    if (gatewayMode === "rate") {
      return json({ error: { message: "Too many requests; rate limit reached." } }, 429, { "Retry-After": "1" });
    }
    if (gatewayMode === "outage") {
      return json({ error: { message: "Gateway temporarily unavailable." } }, 503);
    }
    return json({
      model: "gateway-model",
      choices: [{ message: { content: "primary reply" } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
  }
  if (url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: Array<{ content?: string }>;
    };
    lastOllamaModel = body.model ?? "";
    lastOllamaPrompt = body.messages?.[1]?.content ?? "";
    if (ollamaMode === "fail") return json({ error: "local model crashed" }, 503);
    if (ollamaMode === "missing") return json({ error: "model not found" }, 404);
    return json({
      model: lastOllamaModel,
      message: { content: "local reply" },
      prompt_eval_count: 6,
      eval_count: 3,
    });
  }
  if (url.endsWith("/api/tags")) {
    return json({
      models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }],
    });
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const { getDb, one, run } = await import("../lib/db.ts");
const {
  ProvidersUnavailableError,
  clearGatewayCooldown,
  gatewayCooldownStatus,
  generateText,
  providerHealth,
  setGatewayCooldown,
  testOllamaConnection,
} = await import("../lib/providers.ts");

getDb();
run(
  `INSERT OR IGNORE INTO tasks (id, agent_key, title, status, created_at)
   VALUES ('task_fallback', 'analysis', 'Fallback test', 'completed', ?)`,
  [new Date().toISOString()],
);

function input(technical = false) {
  return {
    agentKey: "analysis",
    taskId: "task_fallback",
    source: "task" as const,
    system: "Use only the supplied facts.",
    prompt: "Explain the deterministic result.",
    maxTokens: 16,
    temperature: 0,
    technical,
  };
}

function reset(mode: Mode = "ok"): void {
  clearGatewayCooldown();
  gatewayMode = mode;
  ollamaMode = "ok";
  gatewayCalls = 0;
  ollamaCalls = 0;
  lastOllamaModel = "";
  lastOllamaPrompt = "";
}

test("normal FreeLLMAPI inference succeeds without contacting Ollama", async () => {
  reset("ok");
  const result = await generateText(input());
  assert.equal(result.provider, "freellmapi");
  assert.equal(result.model, "gateway-model");
  assert.equal(gatewayCalls, 1);
  assert.equal(ollamaCalls, 0);
});

test("FreeLLMAPI 429 triggers Ollama with the general model", async () => {
  reset("rate");
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "llama3.2:3b");
  assert.equal(lastOllamaModel, "llama3.2:3b");
  assert.equal(gatewayCalls, 1);
  assert.equal(ollamaCalls, 1);
  assert.ok(gatewayCooldownStatus().remainingMs > 0, "the primary cooldown is retained");
});

test("coding-specific inference uses OLLAMA_CODER_MODEL", async () => {
  reset("rate");
  const result = await generateText(input(true));
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "qwen2.5-coder:1.5b");
  assert.equal(lastOllamaModel, "qwen2.5-coder:1.5b");
  assert.match(lastOllamaPrompt, /deterministic result/);
});

test("FreeLLMAPI becomes primary again after the cooldown expires", async () => {
  reset("ok");
  setGatewayCooldown(1000, "test cooldown");
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const result = await generateText(input());
  assert.equal(result.provider, "freellmapi");
  assert.equal(result.model, "gateway-model");
  assert.equal(ollamaCalls, 0, "Ollama must not be contacted after primary recovery");
});

test("an unset FreeLLMAPI model is served by Ollama instead of failing", async () => {
  const saved = process.env.FREELLMAPI_MODEL;
  delete process.env.FREELLMAPI_MODEL;
  gatewayMode = "ok";
  gatewayCalls = 0;
  ollamaCalls = 0;
  try {
    const result = await generateText({ agentKey: "coordinator", system: "system", prompt: "prompt" });
    assert.equal(result.provider, "ollama");
    assert.equal(result.model, "llama3.2:3b");
    assert.equal(gatewayCalls, 0, "an incomplete gateway is never called just to confirm it is incomplete");
    assert.equal(ollamaCalls, 1);
  } finally {
    if (saved === undefined) delete process.env.FREELLMAPI_MODEL;
    else process.env.FREELLMAPI_MODEL = saved;
  }
});

test("Ollama unavailable returns a clear error without crashing", async () => {
  reset("rate");
  ollamaMode = "fail";
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof ProvidersUnavailableError);
    assert.match(error.message, /FreeLLMAPI failed/);
    assert.match(error.message, /Ollama fallback failed/);
    assert.match(error.message, /503/);
    return true;
  });
});

test("both providers unavailable produces a useful diagnostic", async () => {
  reset("outage");
  ollamaMode = "fail";
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof ProvidersUnavailableError);
    assert.match(error.message, /FreeLLMAPI failed/);
    assert.match(error.message, /Ollama fallback failed/);
    assert.match(error.message, /Gateway temporarily unavailable/);
    return true;
  });
});

test("a fallback returns one result, so caller-side tool work runs once", async () => {
  reset("rate");
  const before = one<{ successes: number; failures: number }>(
    `SELECT
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_fallback' AND status = 'ok') AS successes,
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_fallback' AND status = 'error') AS failures`,
  ) ?? { successes: 0, failures: 0 };
  let toolExecutions = 0;
  const result = await generateText(input());
  if (result.text) toolExecutions += 1;
  assert.equal(result.provider, "ollama");
  assert.equal(toolExecutions, 1, "the caller receives one successful result, not one per provider attempt");

  const after = one<{ successes: number; failures: number }>(
    `SELECT
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_fallback' AND status = 'ok') AS successes,
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_fallback' AND status = 'error') AS failures`,
  );
  assert.equal(Number(after?.successes) - Number(before.successes), 1);
  assert.equal(Number(after?.failures) - Number(before.failures), 1);
});

test("the lightweight Ollama connection probe reports both installed models", async () => {
  const result = await testOllamaConnection();
  assert.equal(result.ok, true);
  assert.equal(result.generalInstalled, true);
  assert.equal(result.coderInstalled, true);
  assert.deepEqual(result.models, ["llama3.2:3b", "qwen2.5-coder:1.5b"]);
  assert.match(result.detail, /both configured models are installed/);
});

test("provider health reports Ollama as a real fallback", async () => {
  const health = await providerHealth(true);
  const ollama = health.find((provider) => provider.name === "ollama");
  assert.equal(ollama?.configured, true);
  assert.equal(ollama?.available, true);
  assert.deepEqual(ollama?.models, ["llama3.2:3b", "qwen2.5-coder:1.5b"]);
});
