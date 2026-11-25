import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiEvidence } from "./helpers/free-tier-evidence.ts";

/**
 * Gemini-primary routing tests.
 *
 * The Google SDK and Ollama are intercepted at the fetch boundary. No paid
 * request is sent by this suite; the assertions cover the real router, policy
 * checks, cooldowns, persistence and provider selection.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-gemini-fallback-"));
process.env.APP_SECRET_KEY = "gemini-fallback-test-secret";
process.env.AI_PRIMARY_PROVIDER = "gemini";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_PAID_AUTHORISED = "true";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = geminiEvidence();
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_API_VERSION = "v1beta";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.OLLAMA_TIMEOUT_MS = "5000";
process.env.FREELLMAPI_ENABLED = "false";
process.env.FREELLMAPI_API_KEY = "";
process.env.OPENROUTER_ENABLED = "false";
process.env.OPENROUTER_API_KEY = "";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "2";

type GeminiMode = "ok" | "timeout" | "auth" | "rate" | "unavailable" | "model_missing";
let geminiMode: GeminiMode = "ok";
let geminiCalls = 0;
let ollamaCalls = 0;
let activeGemini = 0;
let maxActiveGemini = 0;
let lastGeminiBody = "";
let lastOllamaBody = "";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function geminiSuccess(): Response {
  return json({
    candidates: [
      {
        content: { parts: [{ text: "gemini primary reply" }], role: "model" },
        finishReason: "STOP",
      },
    ],
    usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("generativelanguage.googleapis.com")) {
    geminiCalls += 1;
    lastGeminiBody = String(init?.body ?? "");
    activeGemini += 1;
    maxActiveGemini = Math.max(maxActiveGemini, activeGemini);
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (geminiMode === "timeout") throw new Error("The operation timed out");
      if (geminiMode === "auth") return json({ error: { code: 401, message: "Invalid API key", status: "UNAUTHENTICATED" } }, 401);
      if (geminiMode === "rate") return json({ error: { code: 429, message: "Too many requests", status: "RESOURCE_EXHAUSTED" } }, 429);
      if (geminiMode === "unavailable") return json({ error: { code: 503, message: "Service temporarily unavailable", status: "UNAVAILABLE" } }, 503);
      if (geminiMode === "model_missing") return json({ error: { code: 404, message: "model not found", status: "NOT_FOUND" } }, 404);
      return geminiSuccess();
    } finally {
      activeGemini -= 1;
    }
  }
  if (url.endsWith("/api/chat")) {
    ollamaCalls += 1;
    lastOllamaBody = String(init?.body ?? "");
    return json({
      model: "llama3.2:3b",
      message: { content: "local fallback reply" },
      prompt_eval_count: 7,
      eval_count: 4,
    });
  }
  if (url.endsWith("/api/tags")) {
    return json({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }] });
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const {
  AiProviderConfigError,
  ProvidersUnavailableError,
  generateText,
  providerHealth,
  testOllamaConnection,
} = await import("../lib/providers.ts");

db.getDb();

function input(extra: Record<string, unknown> = {}) {
  return {
    agentKey: "coordinator",
    source: "manual" as const,
    system: "Use only supplied facts. Return a short answer.",
    prompt: "Return a short answer.",
    maxTokens: 32,
    temperature: 0,
    ...extra,
  };
}

function reset(mode: GeminiMode = "ok") {
  geminiMode = mode;
  geminiCalls = 0;
  ollamaCalls = 0;
  activeGemini = 0;
  maxActiveGemini = 0;
  lastGeminiBody = "";
  lastOllamaBody = "";
  db.run("DELETE FROM provider_health");
  db.run("DELETE FROM provider_usage");
}

test("Gemini primary success does not call Ollama", async () => {
  reset("ok");
  const result = await generateText(input());
  assert.equal(result.provider, "gemini");
  assert.equal(result.model, "gemini-3.6-flash");
  assert.equal(geminiCalls, 1);
  assert.equal(ollamaCalls, 0);
  assert.equal(result.diagnostics?.fallbackDecision, "primary");
  assert.equal(result.diagnostics?.fallbackReason, null);
});

test("a Gemini timeout falls back to loopback llama3.2:3b with a recorded reason", async () => {
  reset("timeout");
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "llama3.2:3b");
  assert.equal(geminiCalls, 1);
  assert.equal(ollamaCalls, 1);
  assert.equal(result.diagnostics?.fallbackDecision, "ollama");
  assert.equal(result.diagnostics?.fallbackFrom, "gemini");
  assert.match(result.diagnostics?.fallbackReason ?? "", /timeout/i);
  const row = db.one<{ provider: string; fallback_from: string; fallback_reason: string }>(
    "SELECT provider, fallback_from, fallback_reason FROM provider_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(row?.provider, "ollama");
  assert.equal(row?.fallback_from, "gemini");
  assert.match(row?.fallback_reason ?? "", /timeout/i);
});

test("a Gemini authentication failure fails closed and never calls Ollama", async () => {
  reset("auth");
  await assert.rejects(generateText(input()), (error: unknown) => {
    assert.ok(error instanceof AiProviderConfigError);
    assert.match(error.message, /authentication|401/i);
    return true;
  });
  assert.equal(geminiCalls, 1);
  assert.equal(ollamaCalls, 0);
});

test("Gemini rate limiting falls back without an infinite retry loop", async () => {
  reset("rate");
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(geminiCalls, 1, "the rate-limited primary is not hammered");
  assert.equal(ollamaCalls, 1);
  assert.match(result.diagnostics?.fallbackReason ?? "", /rate|429/i);
});

test("an unavailable Gemini model falls back to the installed local model", async () => {
  reset("model_missing");
  const result = await generateText(input());
  assert.equal(result.provider, "ollama");
  assert.equal(ollamaCalls, 1);
  assert.match(result.diagnostics?.fallbackReason ?? "", /model|404/i);
});

test("a successful primary call is retried after the local fallback, restoring Gemini", async () => {
  reset("unavailable");
  const fallback = await generateText(input());
  assert.equal(fallback.provider, "ollama");

  geminiMode = "ok";
  geminiCalls = 0;
  ollamaCalls = 0;
  db.run("DELETE FROM provider_health");
  const recovered = await generateText(input());
  assert.equal(recovered.provider, "gemini");
  assert.equal(geminiCalls, 1);
  assert.equal(ollamaCalls, 0);
});

test("structured requests use Gemini JSON mode and Ollama JSON mode on fallback", async () => {
  reset("ok");
  const primary = await generateText(input({ format: "json" }));
  assert.equal(primary.provider, "gemini");
  assert.match(lastGeminiBody, /responseMimeType|application\/json/i);

  reset("unavailable");
  const fallback = await generateText(input({ format: "json" }));
  assert.equal(fallback.provider, "ollama");
  assert.equal(JSON.parse(lastOllamaBody).format, "json");
});

test("concurrent requests respect the configured slot limit and never duplicate a fallback", async () => {
  reset("ok");
  const results = await Promise.all(Array.from({ length: 4 }, () => generateText(input())));
  assert.equal(results.filter((result) => result.provider === "gemini").length, 4);
  assert.equal(geminiCalls, 4);
  assert.equal(ollamaCalls, 0);
  assert.ok(maxActiveGemini <= 2, `max concurrent Gemini calls was ${maxActiveGemini}`);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE status = 'ok' AND fallback_reason IS NOT NULL")?.n,
    0,
  );
});

test("the local models and loopback endpoint are verified", async () => {
  const connection = await testOllamaConnection();
  assert.equal(connection.ok, true);
  assert.equal(connection.generalInstalled, true);
  assert.equal(connection.coderInstalled, true);
  const health = await providerHealth(true);
  const ollama = health.find((provider) => provider.name === "ollama");
  assert.equal(ollama?.available, true);
  assert.equal(ollama?.policyBlocked, false);
});

test("a task-bound timeout fallback preserves the task and records the task id", async () => {
  reset("timeout");
  const taskId = "task_fallback_probe";
  db.run("DELETE FROM tasks WHERE id = ?", [taskId]);
  db.run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [taskId, "workflow_fallback_probe", "coordinator", "Fallback persistence probe", "running", new Date().toISOString()],
  );
  const result = await generateText(input({ taskId, workflowId: "workflow_fallback_probe", source: "task" }));
  assert.equal(result.provider, "ollama");
  assert.equal(db.one<{ status: string }>("SELECT status FROM tasks WHERE id = ?", [taskId])?.status, "running");
  assert.equal(
    db.one<{ task_id: string }>("SELECT task_id FROM provider_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1")?.task_id,
    taskId,
  );
});

test("a failed primary with no usable local fallback is explicit and loses no usage evidence", async () => {
  reset("unavailable");
  process.env.OLLAMA_ENABLED = "false";
  try {
    await assert.rejects(generateText(input()), (error: unknown) => {
      assert.ok(error instanceof ProvidersUnavailableError);
      assert.match(error.message, /all free-tier routes failed|no paid fallback is permitted/i);
      return true;
    });
    assert.equal(geminiCalls, 1);
    assert.equal(ollamaCalls, 0);
    assert.ok(
      Number(
        db.one<{ n: number }>("SELECT COUNT(*) AS n FROM provider_usage WHERE provider = 'gemini' AND status = 'error'")?.n,
      ) >= 1,
    );
  } finally {
    process.env.OLLAMA_ENABLED = "true";
  }
});
