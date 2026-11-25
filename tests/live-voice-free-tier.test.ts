import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { geminiEvidence } from "./helpers/free-tier-evidence.ts";

/**
 * Gemini Live voice under the CHF 0.00 free-tier-only policy.
 *
 * No real Google request is made. The fetch boundary is intercepted so the
 * tests can prove that an unverified or exhausted free tier is blocked before
 * transmission, that the legacy paid-authorisation flag cannot open a paid
 * path, and that Chief's Charon identity is unchanged.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-live-free-tier-"));
process.env.APP_SECRET_KEY = "live-free-tier-test-secret";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = geminiEvidence(["gemini-3.8-live"]);
process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
process.env.GEMINI_LIVE_VOICE = "Charon";
process.env.GEMINI_LIVE_API_VERSION = "v1beta";
// Adversarial legacy setting: it must change nothing.
process.env.GEMINI_PAID_AUTHORISED = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

let fetchCalls = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls += 1;
  if (url.includes("auth_tokens")) {
    return json({ name: "auth_tokens/free-tier-test" });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const policy = await import("../lib/ai-spending-policy.ts");
const freeTier = await import("../lib/free-tier.ts");
const live = await import("../lib/live-voice.ts");
const voices = await import("../lib/agent-voices.ts");
const db = await import("../lib/db.ts");

db.getDb();

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

function session(agentKey: "coordinator" | "analysis" = "coordinator") {
  return live.createLiveSession({
    userId: "user_voice_test",
    agentKey,
    sessionId: "voice_freetier123",
    voice: "Charon",
    greet: true,
  });
}

beforeEach(() => {
  fetchCalls = 0;
  freeTier.clearGeminiLiveExhaustion();
});

test("a declared free-tier Live model is permitted at CHF 0.00", () => {
  const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.execution_type, "verified_free_external");
  assert.equal(decision.verified_free, true);
  assert.equal(decision.estimated_cost_chf, 0);
  assert.equal(decision.maximum_authorised_cost_chf, 0);
  assert.equal(decision.billing_authority, "zero_spend");

  const status = freeTier.geminiLiveFreeTierStatus();
  assert.equal(status.state, "available");
  assert.equal(status.model, "gemini-3.8-live");
});

test("an unverified Gemini account blocks voice before transmission, even with the paid flag", () => {
  withEnv({ GEMINI_FREE_TIER_VERIFIED: "false", GEMINI_PAID_AUTHORISED: "true" }, () => {
    const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.estimated_cost_chf, null);
    assert.equal(decision.maximum_authorised_cost_chf, 0);
    assert.match(decision.block_reason ?? "", /blocked before transmission|unverified|free-tier/i);
    assert.equal(live.liveVoiceConfig().blockedByPolicy, true);
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
  });
});

test("voice is refused without minting a token when the free tier is unverified", async () => {
  await withEnvAsync({ GEMINI_FREE_TIER_VERIFIED: "false" }, async () => {
    await assert.rejects(session(), /blocked|unverified|free-tier/i);
    assert.equal(fetchCalls, 0, "no request may reach Google while free-tier status is unverified");
  });
});

test("a paid or pro Live model is refused even when the free tier is declared", () => {
  withEnv({ GEMINI_LIVE_MODEL: "gemini-3.8-live-pro" }, () => {
    const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live-pro" });
    assert.equal(decision.allowed, false);
    assert.match(decision.block_reason ?? "", /paid|free-tier price/i);
    assert.equal(freeTier.geminiLiveFreeTierStatus().state, "blocked");
  });
});

test("a confirmed Live quota exhaustion blocks voice until the reset, never paid access", () => {
  const now = Date.parse("2026-11-23T10:00:00.000Z");
  freeTier.recordGeminiLiveFailure({
    model: "gemini-3.8-live",
    message: "You exceeded your current quota (daily limit)",
    now,
  });
  const exhausted = freeTier.geminiLiveFreeTierStatus(now + 60_000);
  assert.equal(exhausted.state, "exhausted");
  assert.equal(exhausted.allowed, false);
  assert.ok(exhausted.reset_at);
  assert.equal(
    policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" }, now + 60_000).allowed,
    false,
  );

  const afterReset = freeTier.geminiLiveFreeTierStatus(now + 2 * 86_400_000);
  assert.equal(afterReset.state, "available");
  assert.equal(afterReset.allowed, true);
});

test("Chief keeps the Charon voice and the coordinator default", () => {
  assert.equal(voices.AGENT_VOICE_PROFILES.coordinator.voiceId, "Charon");
  assert.equal(live.normaliseVoice("Charon"), "Charon");
  assert.equal(live.normaliseVoice("unknown-voice"), "Charon", "an unknown voice must not substitute a different identity");
  assert.equal(live.liveVoiceConfig().voice, "Charon");
  assert.equal(live.liveVoiceConfig().model, "gemini-3.8-live");
});

test("a verified free-tier Live session is minted for Charon and marked transmitted", async () => {
  const result = await session();
  assert.equal(result.agentKey, "coordinator");
  assert.equal(result.agentName, "Chief");
  assert.equal(result.voice, "Charon");
  assert.equal(result.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Charon");
  assert.equal(result.setup.model, "models/gemini-3.8-live");
  assert.match(result.wsUrl, /^wss:\/\/generativelanguage\.googleapis\.com\//);
  assert.equal(fetchCalls, 1);

  const row = db.one<{ provider: string; execution_type: string; decision: string; network_transmitted: number }>(
    "SELECT provider, execution_type, decision, network_transmitted FROM ai_policy_decisions ORDER BY id DESC LIMIT 1",
  );
  assert.equal(row?.provider, "gemini-live");
  assert.equal(row?.decision, "allowed");
  assert.equal(row?.execution_type, "verified_free_external");
  assert.equal(Number(row?.network_transmitted), 1);
});

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
