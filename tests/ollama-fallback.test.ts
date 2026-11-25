import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Loopback Ollama is the only authorised text route. FreeLLMAPI is configured
 * but must never be contacted; no failure of the local model may trigger it.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-ollama-local-"));
process.env.APP_SECRET_KEY = "ollama-local-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "2";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_ENABLED = "false";

let ollamaMode: "ok" | "fail" | "missing" = "ok";
let ollamaCalls = 0;
let externalInferenceCalls = 0;
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
    externalInferenceCalls += 1;
    throw new Error("FreeLLMAPI must never receive an inference request");
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
    return json({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }] });
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const { getDb, one, run } = await import("../lib/db.ts");
const { clearProviderCooldowns } = await import("../lib/provider-health.ts");
const {
  AiProviderConfigError,
  ProvidersUnavailableError,
  generateText,
  providerHealth,
  testOllamaConnection,
} = await import("../lib/providers.ts");

getDb();
run(
  `INSERT OR IGNORE INTO tasks (id, agent_key, title, status, created_at)
   VALUES ('task_local', 'analysis', 'Local test', 'completed', ?)`,
  [new Date().toISOString()],
);

function input(technical = false) {
  return {
    agentKey: "analysis",
    taskId: "task_local",
    source: "task" as const,
    system: "Use only the supplied facts.",
    prompt: "Explain the deterministic result.",
    maxTokens: 16,
    temperature: 0,
    technical,
  };
}

function reset(): void {
  clearProviderCooldowns();
  ollamaMode = "ok";
  ollamaCalls = 0;
  externalInferenceCalls = 0;
  lastOllamaModel = "";
  lastOllamaPrompt = "";
}

test("loopback Ollama serves text with zero external inference", async () => {
  reset();
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "llama3.2:3b");
  assert.equal(ollamaCalls, 1);
  assert.equal(externalInferenceCalls, 0);
});

test("coding-specific inference uses OLLAMA_CODER_MODEL", async () => {
  reset();
  const result = await generateText(input(true));
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "qwen2.5-coder:1.5b");
  assert.equal(lastOllamaModel, "qwen2.5-coder:1.5b");
  assert.match(lastOllamaPrompt, /deterministic result/);
  assert.equal(externalInferenceCalls, 0);
});

test("a local Ollama failure is reported and never triggers an external fallback", async () => {
  reset();
  ollamaMode = "fail";
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof ProvidersUnavailableError);
    assert.match(error.message, /All free-tier routes failed|Local Ollama failed/i);
    assert.match(error.message, /no paid fallback is permitted/i);
    assert.match(error.message, /503/);
    return true;
  });
  assert.equal(externalInferenceCalls, 0);
});

test("a missing local model is not answered by FreeLLMAPI", async () => {
  reset();
  ollamaMode = "missing";
  await assert.rejects(generateText(input()), (error: unknown) => {
    // A missing local model is a configuration failure and is never answered
    // by an external provider.
    assert.ok(error instanceof ProvidersUnavailableError || error instanceof AiProviderConfigError);
    assert.match(error.message, /not installed|could not be loaded/i);
    return true;
  });
  assert.equal(externalInferenceCalls, 0);
});

test("a local result records one usage row and one caller-side result", async () => {
  reset();
  const before = one<{ successes: number; failures: number }>(
    `SELECT
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_local' AND status = 'ok') AS successes,
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_local' AND status = 'error') AS failures`,
  ) ?? { successes: 0, failures: 0 };
  let toolExecutions = 0;
  const result = await generateText(input());
  if (result.text) toolExecutions += 1;
  assert.equal(result.provider, "ollama");
  assert.equal(toolExecutions, 1);
  const after = one<{ successes: number; failures: number }>(
    `SELECT
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_local' AND status = 'ok') AS successes,
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_local' AND status = 'error') AS failures`,
  );
  assert.equal(Number(after?.successes) - Number(before.successes), 1);
  assert.equal(Number(after?.failures) - Number(before.failures), 0);
});

test("the lightweight Ollama connection probe reports both installed models", async () => {
  const result = await testOllamaConnection();
  assert.equal(result.ok, true);
  assert.equal(result.generalInstalled, true);
  assert.equal(result.coderInstalled, true);
  assert.deepEqual(result.models, ["llama3.2:3b", "qwen2.5-coder:1.5b"]);
  assert.match(result.detail, /both configured models are installed/);
});

test("provider health reports loopback Ollama as available and FreeLLMAPI as policy-blocked", async () => {
  const health = await providerHealth(true);
  const ollama = health.find((provider) => provider.name === "ollama");
  const gateway = health.find((provider) => provider.name === "freellmapi");
  assert.equal(ollama?.configured, true);
  assert.equal(ollama?.available, true);
  assert.equal(ollama?.policyBlocked, false);
  assert.equal(gateway?.available, false, "free-tier eligibility is not established");
  assert.equal(gateway?.policyBlocked, true, "so inference is blocked");
  assert.match(gateway?.detail ?? "", /free tier|unverified/i);
  assert.equal(gateway?.executionType, "blocked");
});
