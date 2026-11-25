import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Explicit Live-only owner attestation.
 *
 * This is not provider-issued billing evidence. The owner has confirmed the
 * project is on the free tier in AI Studio; the runtime still proves that the
 * configured key reaches the exact Live model and that a token is minted.
 * Text and vision keep the stricter provider-evidence gate.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-live-attestation-"));
process.env.APP_SECRET_KEY = "live-attestation-test-secret";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
process.env.GEMINI_LIVE_VOICE = "Charon";
process.env.GEMINI_LIVE_API_VERSION = "v1beta";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = "";
process.env.GEMINI_LIVE_FREE_TIER_ATTESTATION = "owner_confirmed";
process.env.GEMINI_PAID_AUTHORISED = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

let modelCalls = 0;
let tokenCalls = 0;
let modelStatus = 200;
let modelError = "Project 123456789012 must be verified before it can use the Gemini API Free tier.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/models/")) {
    modelCalls += 1;
    if (modelStatus !== 200) return json({ error: { message: modelError } }, modelStatus);
    return json({ name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] });
  }
  if (url.includes("auth_tokens")) {
    tokenCalls += 1;
    return json({ name: "auth_tokens/attestation-test" });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const policy = await import("../lib/ai-spending-policy.ts");
const freeTier = await import("../lib/free-tier.ts");
const live = await import("../lib/live-voice.ts");
const db = await import("../lib/db.ts");

db.getDb();

function session() {
  return live.createLiveSession({
    userId: "user_attestation_test",
    agentKey: "coordinator",
    sessionId: "voice_attestation123",
    voice: "Charon",
    greet: true,
  });
}

function withEnv<T>(values: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withEnvAsync<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => {
  modelCalls = 0;
  tokenCalls = 0;
  modelStatus = 200;
  modelError = "Project 123456789012 must be verified before it can use the Gemini API Free tier.";
  freeTier.clearGeminiLiveExhaustion();
});

test("an explicit owner attestation allows Live only after the key/model preflight", async () => {
  const status = freeTier.geminiLiveFreeTierStatus();
  assert.equal(status.state, "available");
  assert.equal(status.allowed, true);
  assert.equal(status.verification_source, "owner_attestation");
  assert.equal(status.evidence_reference, null);
  assert.match(status.detail, /owner attestation/i);
  assert.match(status.detail, /not provider-issued billing evidence/i);

  const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.estimated_cost_chf, 0);

  const result = await session();
  assert.equal(result.agentName, "Chief");
  assert.equal(result.voice, "Charon");
  assert.equal(modelCalls, 1);
  assert.equal(tokenCalls, 1);
  assert.match(result.wsUrl, /^wss:\/\/generativelanguage\.googleapis\.com\//);
});

test("the attestation is opt-in: empty evidence still blocks when it is absent", async () => {
  await withEnvAsync({ GEMINI_LIVE_FREE_TIER_ATTESTATION: undefined }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.equal(status.allowed, false);
    await assert.rejects(session(), /GEMINI_FREE_TIER_EVIDENCE is empty/);
    assert.equal(modelCalls, 0);
    assert.equal(tokenCalls, 0);
  });
});

test("the attestation cannot override the free-tier declaration", async () => {
  await withEnvAsync({ GEMINI_FREE_TIER_VERIFIED: "false" }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.match(status.detail, /GEMINI_FREE_TIER_VERIFIED=true/);
    await assert.rejects(session(), /unverified|free-tier/i);
    assert.equal(modelCalls, 0);
    assert.equal(tokenCalls, 0);
  });
});

test("malformed provider evidence fails closed instead of falling back to the attestation", async () => {
  await withEnvAsync({ GEMINI_FREE_TIER_EVIDENCE: "{not-json" }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.match(status.detail, /not valid JSON/i);
    await assert.rejects(session(), /not valid JSON/i);
    assert.equal(modelCalls, 0);
    assert.equal(tokenCalls, 0);
  });
});

test("the attestation cannot authorise a paid Live model", async () => {
  await withEnvAsync({ GEMINI_LIVE_MODEL: "gemini-3.8-live-pro" }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "blocked");
    assert.equal(status.allowed, false);
    assert.match(status.detail, /paid|free-tier/i);
    await assert.rejects(session(), /paid|free-tier/i);
    assert.equal(modelCalls, 0);
    assert.equal(tokenCalls, 0);
  });
});

test("a failed key/model preflight blocks before any token is minted", async () => {
  modelStatus = 403;
  const result = await session().then(
    () => null,
    (error: unknown) => error,
  );
  assert.ok(result instanceof Error);
  assert.match(result.message, /preflight blocked/i);
  assert.match(result.message, /must be verified/i);
  assert.equal(modelCalls, 1);
  assert.equal(tokenCalls, 0);
});
