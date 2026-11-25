import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Every agent must pass through the one central policy. With FreeLLMAPI
 * configured but its upstream billing unverified, and Ollama not loopback,
 * not one agent may transmit an inference request.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-routing-"));
process.env.APP_SECRET_KEY = "agent-routing-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "2";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://ollama.test";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OPENROUTER_ENABLED = "true";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL = "openrouter/free";

let fetchCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchCalls += 1;
  throw new Error(`No network request is permitted: ${String(input)}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const providers = await import("../lib/providers.ts");
const { AGENT_DEFINITIONS } = await import("../lib/agent-definitions.ts");
const { AiSpendingPolicyError } = await import("../lib/ai-spending-policy.ts");

db.getDb();

function input(key: string) {
  return {
    agentKey: key,
    source: "task" as const,
    system: `System context for ${key}`,
    prompt: `Unique task context for ${key}`,
    maxTokens: 16,
    temperature: 0,
  };
}

test("all eight agents are blocked before transmission when external billing is unverified", async () => {
  fetchCalls = 0;
  for (const definition of AGENT_DEFINITIONS) {
    await assert.rejects(
      providers.generateText(input(definition.key)),
      (error: unknown) => {
        assert.ok(error instanceof AiSpendingPolicyError, `${definition.name} must receive the policy refusal`);
        assert.equal(error.decision.allowed, false);
        assert.equal(error.decision.execution_type, "blocked");
        assert.match(error.message, /CHF 0\.00|blocked/i);
        return true;
      },
      definition.name,
    );
  }
  assert.equal(fetchCalls, 0, "no agent may reach FreeLLMAPI, Ollama, Gemini or OpenRouter");

  const decisions = db.all<{ provider: string; decision: string; execution_type: string; network_transmitted: number }>(
    "SELECT provider, decision, execution_type, network_transmitted FROM ai_policy_decisions ORDER BY id",
  );
  assert.equal(decisions.length, 24, "each agent records the Gemini, FreeLLMAPI and local policy decisions");
  assert.ok(decisions.every((row) => row.decision === "blocked"));
  assert.ok(decisions.every((row) => row.execution_type === "blocked"));
  assert.ok(decisions.every((row) => Number(row.network_transmitted) === 0));
});

test("a non-loopback Ollama endpoint is not treated as local inference", async () => {
  fetchCalls = 0;
  await assert.rejects(providers.generateText(input("analysis")), (error: unknown) => {
    assert.ok(error instanceof AiSpendingPolicyError);
    assert.match(error.message, /ollama\.test|not loopback/i);
    return true;
  });
  assert.equal(fetchCalls, 0);
});
