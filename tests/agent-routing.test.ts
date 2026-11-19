import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * TEST A-D: every one of the eight agents must use the single FreeLLMAPI
 * router, retain its own task context, and recover through Ollama when the
 * gateway is rate-limited. All HTTP boundaries are mocked; no provider or paid
 * API is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-routing-"));
process.env.APP_SECRET_KEY = "agent-routing-test-secret";
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
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OPENROUTER_ENABLED = "true";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL = "openrouter/free";

let gatewayMode: "ok" | "rate" = "ok";
let gatewayCalls = 0;
let ollamaCalls = 0;
let directCalls = 0;
let lastOllamaPrompt = "";
let lastOllamaSystem = "";

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.endsWith("/v1/models")) return json({ data: [{ id: "gateway-model" }] });
  if (url.endsWith("/v1/chat/completions")) {
    gatewayCalls += 1;
    if (gatewayMode === "rate") {
      return json({ error: { message: "Too many requests; rate limit reached." } }, 429, { "Retry-After": "1" });
    }
    return json({
      model: "gateway-model",
      choices: [{ message: { content: "gateway reply" } }],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
      _routed_via: { platform: "groq", model: "openai/gateway-model" },
    });
  }
  if (url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: Array<{ role?: string; content?: string }>;
    };
    lastOllamaSystem = body.messages?.find((message) => message.role === "system")?.content ?? "";
    lastOllamaPrompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    return json({
      model: "llama3.2:3b",
      message: { content: "local reply" },
      prompt_eval_count: 8,
      eval_count: 3,
    });
  }
  if (url.includes("generativelanguage.googleapis.com") || url.includes("openrouter.ai")) {
    directCalls += 1;
    throw new Error(`Direct provider call is forbidden: ${url}`);
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const providers = await import("../lib/providers.ts");
const health = await import("../lib/provider-health.ts");
const { AGENT_DEFINITIONS } = await import("../lib/agent-definitions.ts");

db.getDb();
const taskFor = new Map<string, string>();
for (const definition of AGENT_DEFINITIONS) {
  const taskId = `task_route_${definition.key}`;
  taskFor.set(definition.key, taskId);
  db.run(
    `INSERT INTO tasks (id, agent_key, title, status, created_at)
     VALUES (?, ?, ?, 'running', ?)`,
    [taskId, definition.key, `Acceptance task for ${definition.name}`, new Date().toISOString()],
  );
}

function input(key: string) {
  return {
    agentKey: key,
    taskId: taskFor.get(key) ?? null,
    source: "task" as const,
    system: `System context for ${key}`,
    prompt: `Unique task context for ${key}`,
    maxTokens: 16,
    temperature: 0,
  };
}

function reset(): void {
  providers.clearGatewayCooldown();
  health.clearProviderCooldowns();
  gatewayMode = "ok";
  gatewayCalls = 0;
  ollamaCalls = 0;
  lastOllamaPrompt = "";
  lastOllamaSystem = "";
}

test("TEST A: all eight agents execute through the central FreeLLMAPI gateway", async () => {
  reset();
  const results: Array<{ key: string; provider: string; model: string }> = [];
  for (const definition of AGENT_DEFINITIONS) {
    const result = await providers.generateText(input(definition.key));
    results.push({ key: definition.key, provider: result.provider, model: result.model });
    assert.equal(result.provider, "freellmapi", `${definition.name} must use the central gateway`);
    assert.equal(result.model, "gateway-model");
  }
  assert.equal(results.length, 8);
  assert.equal(gatewayCalls, 8, "one real inference per agent");
  assert.equal(ollamaCalls, 0);

  const routed = db.all<{ agent_key: string; routed_platform: string | null; routed_model: string | null }>(
    "SELECT agent_key, routed_platform, routed_model FROM provider_usage WHERE status = 'ok' ORDER BY id",
  );
  assert.equal(routed.length, 8);
  assert.ok(routed.every((row) => row.routed_platform === "groq" && row.routed_model === "openai/gateway-model"));
});

test("TEST B/C: every agent falls back to Ollama when FreeLLMAPI returns 429", async () => {
  reset();
  gatewayMode = "rate";
  for (const definition of AGENT_DEFINITIONS) {
    providers.clearGatewayCooldown();
    health.clearProviderCooldowns();
    const result = await providers.generateText(input(definition.key));
    assert.equal(result.provider, "ollama", `${definition.name} must recover through Ollama`);
    assert.equal(result.model, "llama3.2:3b");
    assert.match(lastOllamaSystem, new RegExp(`System context for ${definition.key}`));
    assert.match(lastOllamaPrompt, new RegExp(`Unique task context for ${definition.key}`));
  }
  assert.equal(ollamaCalls, 8);
  assert.equal(gatewayCalls, 8, "each agent made one gateway attempt before fallback");
  assert.equal(directCalls, 0, "Gemini and OpenRouter are never called");
});
