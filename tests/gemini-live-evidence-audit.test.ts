import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gemini Live evidence audit.
 *
 * These are mocked-boundary tests only. No test contacts Google, and the
 * "evidence" records below are deliberately labelled fixtures. They exercise
 * the existing gate; they are not proof that a Google account is on the free
 * tier. The real provider evidence remains unavailable.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-live-evidence-audit-"));
process.env.APP_SECRET_KEY = "live-evidence-audit-secret";
process.env.AI_MAX_RETRIES = "0";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.GEMINI_MODEL = "gemini-3.6-flash";
process.env.GEMINI_LIVE_MODEL = "gemini-3.8-live";
process.env.GEMINI_LIVE_VOICE = "Charon";
process.env.GEMINI_LIVE_API_VERSION = "v1beta";
process.env.GEMINI_FREE_TIER_VERIFIED = "true";
process.env.GEMINI_FREE_TIER_EVIDENCE = "";
process.env.GEMINI_PAID_AUTHORISED = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";

let fetchCalls = 0;
let authFailure = false;
let contactedHosts: string[] = [];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls += 1;
  contactedHosts.push(new URL(url).host);
  if (url.includes("auth_tokens")) {
    if (authFailure) return json({ error: { code: 401, message: "API key not valid" } }, 401);
    return json({ name: "auth_tokens/evidence-audit" });
  }
  if (url.endsWith("/api/chat")) {
    return json({
      model: "llama3.2:3b",
      message: { content: "local text remains available" },
      prompt_eval_count: 4,
      eval_count: 3,
    });
  }
  if (url.endsWith("/api/tags")) {
    return json({ models: [{ name: "llama3.2:3b" }, { name: "qwen2.5-coder:1.5b" }] });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const policy = await import("../lib/ai-spending-policy.ts");
const freeTier = await import("../lib/free-tier.ts");
const live = await import("../lib/live-voice.ts");
const providers = await import("../lib/providers.ts");
const db = await import("../lib/db.ts");

db.getDb();

function fixture(overrides: Record<string, unknown> = {}): string {
  const now = Date.now();
  return JSON.stringify({
    source: "provider_console",
    provider: "google",
    account: "fixture-account-not-provider-issued",
    model: "gemini-3.8-live",
    models: ["gemini-3.8-live"],
    billing: "disabled",
    free_tier: true,
    hard_cap: true,
    quota_status: "available",
    quota_remaining: 1,
    verified_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    evidence_reference: "https://console.cloud.google.com/billing/000000-000000-000000",
    ...overrides,
  });
}

function session() {
  return live.createLiveSession({
    userId: "user_evidence_audit",
    agentKey: "coordinator",
    sessionId: "voice_evidenceaudit",
    voice: "Charon",
    greet: true,
  });
}

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
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
  fetchCalls = 0;
  authFailure = false;
  contactedHosts = [];
  freeTier.clearGeminiLiveExhaustion();
  freeTier.clearFreeTierExhaustion();
});

test("2. missing provider evidence blocks before any network request", async () => {
  await assert.rejects(session(), /GEMINI_FREE_TIER_EVIDENCE is empty/);
  assert.equal(fetchCalls, 0);
  assert.equal(freeTier.geminiLiveFreeTierStatus().state, "unverified");
});

test("3. an operator-only declaration is not accepted", async () => {
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: undefined, GEMINI_FREE_TIER_VERIFIED: "true" }, async () => {
    const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" });
    assert.equal(decision.allowed, false);
    assert.match(decision.block_reason ?? "", /provider evidence/i);
    await assert.rejects(session(), /provider evidence/i);
    assert.equal(fetchCalls, 0);
  });
});

test("4a. invalid JSON evidence is rejected", async () => {
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: "{not-json" }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.match(status.detail, /not valid JSON/i);
    await assert.rejects(session(), /not valid JSON/i);
    assert.equal(fetchCalls, 0);
  });
});

test("4b. evidence pointing outside Google's provider domains is rejected", async () => {
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: fixture({ evidence_reference: "https://example.invalid/evidence" }) }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.match(status.detail, /not on a Google provider domain/i);
    await assert.rejects(session(), /not on a Google provider domain/i);
    assert.equal(fetchCalls, 0);
  });
});

test("5. expired evidence is rejected", async () => {
  const now = Date.now();
  const expired = fixture({
    verified_at: new Date(now - 2 * 60 * 60_000).toISOString(),
    expires_at: new Date(now - 60_000).toISOString(),
  });
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: expired }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "unverified");
    assert.match(status.detail, /expired/i);
    await assert.rejects(session(), /expired/i);
    assert.equal(fetchCalls, 0);
  });
});

test("6a. evidence for a different model is rejected", async () => {
  await withEnv(
    { GEMINI_FREE_TIER_EVIDENCE: fixture({ model: "gemini-3.6-flash", models: ["gemini-3.6-flash"] }) },
    async () => {
      const status = freeTier.geminiLiveFreeTierStatus();
      assert.equal(status.state, "unverified");
      assert.match(status.detail, /not gemini-3\.8-live/i);
      await assert.rejects(session(), /not gemini-3\.8-live/i);
      assert.equal(fetchCalls, 0);
    },
  );
});

test("7. an unsupported or paid Live model is refused", async () => {
  await withEnv({ GEMINI_LIVE_MODEL: "gemini-3.8-live-pro" }, async () => {
    const status = freeTier.geminiLiveFreeTierStatus();
    assert.equal(status.state, "blocked");
    assert.equal(policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live-pro" }).allowed, false);
    await assert.rejects(session(), /paid|free-tier/i);
    assert.equal(fetchCalls, 0);
  });
});

test("8. recorded free-quota exhaustion blocks before transmission", async () => {
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: fixture() }, async () => {
    const now = Date.now() - 60_000;
    freeTier.recordGeminiLiveFailure({
      model: "gemini-3.8-live",
      message: "You exceeded your current quota (daily limit); reset at 2099-01-01T00:00:00.000Z",
      now,
    });
    const status = freeTier.geminiLiveFreeTierStatus(now + 60_000);
    assert.equal(status.state, "exhausted");
    assert.equal(status.allowed, false);
    await assert.rejects(session(), /exhausted|quota/i);
    assert.equal(fetchCalls, 0);
  });
});

test("10. a provider authentication failure ends the attempt with no fallback", async () => {
  authFailure = true;
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: fixture() }, async () => {
    await assert.rejects(session(), /authentication failed/i);
    assert.ok(fetchCalls >= 1, "the mocked token request was attempted");
    assert.ok(contactedHosts.every((host) => host === "generativelanguage.googleapis.com"));
    assert.match(freeTier.geminiLiveFreeTierStatus().last_error?.message ?? "", /API key not valid/);
  });
});

test("11. evidence is re-read for each attempt; removal blocks the next attempt", async () => {
  await withEnv({ GEMINI_FREE_TIER_EVIDENCE: fixture() }, async () => {
    assert.equal(freeTier.geminiLiveFreeTierStatus().state, "available");
    await withEnv({ GEMINI_FREE_TIER_EVIDENCE: undefined }, async () => {
      assert.equal(freeTier.geminiLiveFreeTierStatus().state, "unverified");
      await assert.rejects(session(), /GEMINI_FREE_TIER_EVIDENCE is empty/);
    });
  });
});

test("12. the legacy paid-authorisation flag cannot produce a request", async () => {
  await withEnv(
    { GEMINI_FREE_TIER_EVIDENCE: undefined, GEMINI_PAID_AUTHORISED: "true", GEMINI_FREE_TIER_VERIFIED: "true" },
    async () => {
      const decision = policy.evaluateAiPolicy({ provider: "gemini-live", model: "gemini-3.8-live" });
      assert.equal(decision.allowed, false);
      assert.equal(decision.maximum_authorised_cost_chf, 0);
      await assert.rejects(session(), /blocked|provider evidence/i);
      assert.equal(fetchCalls, 0);
    },
  );
});

test("13. blocked attempts return no session URL and transmit no microphone audio", async () => {
  let resolved: unknown = null;
  try {
    resolved = await session();
  } catch {
    // expected
  }
  assert.equal(resolved, null);
  assert.equal(fetchCalls, 0, "no token, WebSocket URL or Google request may be issued");
});

test("15. text interaction remains available through loopback Ollama while Live is blocked", async () => {
  const result = await providers.generateText({
    agentKey: "application",
    source: "manual",
    system: "Answer briefly.",
    prompt: "Return one short sentence.",
    maxTokens: 16,
    temperature: 0,
  });
  assert.equal(result.provider, "ollama");
  assert.equal(result.model, "llama3.2:3b");
  assert.match(result.text, /local text remains available/);
  assert.ok(contactedHosts.every((host) => host === "127.0.0.1:11434" || host === "127.0.0.1"));
});

test.skip("1. valid provider-issued evidence is accepted", () => {});
test.skip("6b. wrong project or credential identity is rejected", () => {});
test.skip("9. an unavailable provider evidence endpoint is handled", () => {});
test.skip("14. a real Gemini Live session succeeds only with genuine verification", () => {});
