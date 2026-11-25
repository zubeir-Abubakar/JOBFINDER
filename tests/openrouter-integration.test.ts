import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * MOCK TEST — no real OpenRouter, HeyGen or Ollama request is made.
 *
 * The fetch boundary is replaced with a deterministic catalogue and response.
 * This proves the adapter's preflight, pricing, provider restriction, expiry and
 * fail-closed behaviour. Real inference evidence is recorded separately by the
 * operator-run live checks.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-openrouter-"));
process.env.APP_SECRET_KEY = "openrouter-test-secret";
process.env.OPENROUTER_ENABLED = "true";
process.env.OPENROUTER_API_KEY = "test-openrouter-key-not-real";
process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
process.env.OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
process.env.OPENROUTER_ASSIGNED_AGENTS = "";
process.env.OPENROUTER_TTS_ENABLED = "true";
process.env.OPENROUTER_TTS_MODEL = "heygen/heygen-voice-1-turbo:free";
process.env.OPENROUTER_TTS_VOICE = "nadine";
process.env.OPENROUTER_TTS_PROVIDER = "heygen";
process.env.OPENROUTER_TTS_EXPIRES_AT = "2026-11-30";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";

let keyStatus = 200;
let chatStatus = 200;
let chatBody: unknown = null;
let ttsStatus = 200;
let ttsBody = Buffer.alloc(1500, 7);
let keyCalls = 0;
let catalogueCalls = 0;
let chatCalls = 0;
let speechCalls = 0;
let ollamaCalls = 0;
let lastSpeechBody: Record<string, unknown> | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function textCatalogue() {
  return {
    data: [
      {
        id: "google/gemma-4-31b-it:free",
        name: "Google: Gemma 4 31B (free)",
        pricing: { prompt: "0", completion: "0" },
        expiration_date: null,
        architecture: { output_modalities: ["text"] },
      },
      {
        id: "openai/gpt-4o",
        name: "OpenAI: GPT-4o",
        pricing: { prompt: "0.000005", completion: "0.000015" },
        expiration_date: null,
        architecture: { output_modalities: ["text"] },
      },
    ],
  };
}

function speechCatalogue() {
  return {
    data: [
      {
        id: "heygen/heygen-voice-1-turbo:free",
        name: "HeyGen: HeyGen Voice Turbo (free)",
        pricing: { prompt: "0", completion: "0" },
        expiration_date: "2026-11-30",
        architecture: { output_modalities: ["speech"] },
        endpoints: ["/api/v1/audio/speech"],
        supported_voices: ["nadine", "tabitha"],
      },
    ],
  };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).host;
  if (host !== "openrouter.test") {
    if (host === "127.0.0.1:11434") ollamaCalls += 1;
    throw new Error(`Unexpected host contacted: ${host}`);
  }
  if (url.endsWith("/key")) {
    keyCalls += 1;
    return keyStatus === 200 ? json({ data: { label: "test" } }) : json({ error: { message: "rate limited" } }, keyStatus);
  }
  if (url.includes("/models?")) {
    catalogueCalls += 1;
    return json(url.includes("output_modalities=speech") ? speechCatalogue() : textCatalogue());
  }
  if (url.endsWith("/chat/completions")) {
    chatCalls += 1;
    if (chatStatus !== 200) {
      return json({ error: { message: "429 too many requests, retry later" } }, chatStatus);
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return json(
      chatBody ?? {
        model: body.model?.replace(/:free$/, ""),
        provider: "Google AI Studio",
        choices: [{ message: { content: "OPENROUTER_OK" } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      },
    );
  }
  if (url.endsWith("/audio/speech")) {
    speechCalls += 1;
    lastSpeechBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (ttsStatus !== 200) return json({ error: { message: "retired" } }, ttsStatus);
    return new Response(ttsBody, {
      headers: { "Content-Type": "audio/pcm;rate=44100;channels=1", "X-Generation-Id": "gen_test_1" },
    });
  }
  throw new Error(`Unexpected OpenRouter path: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const providers = await import("../lib/providers.ts");
const policy = await import("../lib/ai-spending-policy.ts");
const openRouter = await import("../lib/openrouter.ts");
const health = await import("../lib/provider-health.ts");
const voice = await import("../lib/voice.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

beforeEach(() => {
  keyStatus = 200;
  chatStatus = 200;
  chatBody = null;
  ttsStatus = 200;
  ttsBody = Buffer.alloc(1500, 7);
  keyCalls = 0;
  catalogueCalls = 0;
  chatCalls = 0;
  speechCalls = 0;
  ollamaCalls = 0;
  lastSpeechBody = null;
  openRouter.clearOpenRouterCache();
  health.clearProviderCooldowns();
  db.run("DELETE FROM provider_usage");
  db.run("DELETE FROM ai_policy_decisions");
  delete process.env.OPENROUTER_ASSIGNED_AGENTS;
});

test("the exact free text model is catalogued at zero price and can complete inference", async () => {
  process.env.OPENROUTER_ASSIGNED_AGENTS = "research";
  const result = await providers.generateText({
    agentKey: "research",
    source: "manual",
    system: "Reply with exactly OPENROUTER_OK.",
    prompt: "Return the marker.",
    maxTokens: 12,
    temperature: 0,
  });
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, "google/gemma-4-31b-it");
  assert.equal(result.text, "OPENROUTER_OK");
  assert.equal(result.routedVia?.platform, "Google AI Studio");
  assert.equal(ollamaCalls, 0, "no Ollama substitution");
  assert.equal(keyCalls, 1);
  assert.ok(catalogueCalls >= 1);
  const usage = db.one<{ provider: string; model: string; routed_platform: string }>(
    "SELECT provider, model, routed_platform FROM provider_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(usage?.provider, "openrouter");
  assert.equal(usage?.model, "google/gemma-4-31b-it");
  assert.equal(usage?.routed_platform, "Google AI Studio");
});

test("dynamic and paid OpenRouter ids never reach the network", async () => {
  for (const model of ["openrouter/free", "openai/gpt-4o", "openai/gpt-4o:free", "auto"]) {
    const validation = await openRouter.validateOpenRouterFreeModel(model, "text");
    assert.equal(validation.ok, false, model);
    assert.match(validation.reason, /exact free|paid|refused/i, model);
  }
  assert.equal(keyCalls, 0);
  assert.equal(chatCalls, 0);
});

test("the exact HeyGen model is restricted to provider heygen and returns browser-playable wav", async () => {
  const result = await voice.synthesizeSpeech("Chief integration speech check.", { voice: "nadine" });
  assert.equal(result.source, "openrouter-heygen");
  assert.equal(result.model, "heygen/heygen-voice-1-turbo:free");
  assert.equal(result.mime, "audio/wav");
  assert.equal(result.generationId, "gen_test_1");
  assert.ok(result.bytes.length > 1000);
  assert.equal(result.bytes.subarray(0, 4).toString(), "RIFF");
  assert.equal(result.bytes.subarray(8, 12).toString(), "WAVE");
  assert.equal(speechCalls, 1);
  assert.deepEqual(lastSpeechBody?.provider, {
    only: ["heygen"],
    order: ["heygen"],
    allow_fallbacks: false,
  });
  assert.equal(lastSpeechBody?.model, "heygen/heygen-voice-1-turbo:free");
  assert.equal(lastSpeechBody?.response_format, "pcm");
  assert.equal(ollamaCalls, 0);
});

test("the HeyGen free model is rejected after its 30 November 2026 retirement", async () => {
  const validation = await openRouter.validateOpenRouterFreeModel(
    "heygen/heygen-voice-1-turbo:free",
    "speech",
    { now: Date.parse("2026-12-01T00:00:00.000Z") },
  );
  assert.equal(validation.ok, false);
  assert.equal(validation.code, "expired");
  assert.match(validation.reason, /retired|paid counterpart/i);
  assert.equal(speechCalls, 0);
});

test("an OpenRouter 429 fails closed without calling Ollama", async () => {
  process.env.OPENROUTER_ASSIGNED_AGENTS = "research";
  keyStatus = 429;
  await assert.rejects(
    providers.generateText({
      agentKey: "research",
      source: "manual",
      system: "System",
      prompt: "Prompt",
      maxTokens: 8,
      temperature: 0,
    }),
    (error: unknown) => {
      assert.ok(error instanceof providers.AiRateLimitedError);
      assert.ok(error.retryAfterMs >= 1000);
      return true;
    },
  );
  assert.equal(chatCalls, 0);
  assert.equal(ollamaCalls, 0);
});

test("the policy gate allows exact free ids but blocks a non-free gateway alias", () => {
  const exact = policy.evaluateAiPolicy({ provider: "openrouter", model: "google/gemma-4-31b-it:free" });
  assert.equal(exact.allowed, true);
  assert.equal(exact.execution_type, "verified_free_external");
  const dynamic = policy.evaluateAiPolicy({ provider: "openrouter", model: "openrouter/free" });
  assert.equal(dynamic.allowed, false);
  assert.match(dynamic.block_reason ?? "", /exact free|:free/i);
});
