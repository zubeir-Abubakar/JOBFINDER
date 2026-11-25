import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderHealth } from "../lib/providers.ts";
import { freeLlmEvidence, geminiEvidence } from "./helpers/free-tier-evidence.ts";

/**
 * Status reporting only. No provider request is sent and every database write
 * stays in this file's temporary database.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-provider-status-"));
process.env.APP_SECRET_KEY = "provider-status-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31415/v1";
process.env.FREELLMAPI_API_KEY = "provider-status-test-key-not-real";
process.env.FREELLMAPI_MODEL = "gpt-oss-20b";
process.env.FREELLMAPI_ALLOWED_MODELS = "gpt-oss-20b";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.GEMINI_FREE_TIER_EVIDENCE = geminiEvidence(["gemini-3.6-flash", "gemini-3.8-live"]);
process.env.FREELLMAPI_FREE_TIER_EVIDENCE = freeLlmEvidence();
process.env.OLLAMA_ENABLED = "true";
process.env.OLLAMA_BASE_URL = "http://localhost:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
delete process.env.GEMINI_API_KEY;
delete process.env.OPENROUTER_API_KEY;
process.env.OPENROUTER_ENABLED = "false";

const db = await import("../lib/db.ts");
const health = await import("../lib/provider-health.ts");
const { PROVIDER_STATUS_FRESHNESS_MS, providerStatusSummary } = await import("../lib/provider-status.ts");
const { clearGatewayCooldown } = await import("../lib/providers.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

beforeEach(() => {
  clearGatewayCooldown();
  health.clearProviderCooldowns();
});

const NOW = Date.parse("2026-11-22T15:00:00.000Z");
const FRESH = new Date(NOW - 20_000).toISOString();
const STALE = new Date(NOW - PROVIDER_STATUS_FRESHNESS_MS - 1_000).toISOString();

function reading(
  name: "freellmapi" | "ollama",
  available: boolean,
  detail: string,
  checkedAt: string = FRESH,
): ProviderHealth {
  return {
    name,
    label: name === "freellmapi" ? "FreeLLMAPI (external gateway)" : "Ollama (local only)",
    enabled: true,
    configured: true,
    available,
    model: name === "freellmapi" ? "gpt-oss-20b" : "llama3.2:3b",
    models: [],
    detail,
    latencyMs: 12,
    checkedAt,
  };
}

const FREELMMAPI_HEALTHY = reading(
  "freellmapi",
  true,
  "314 models available. Pinned gpt-oss-20b is catalogued and allowlisted.",
);
const OLLAMA_HEALTHY = reading("ollama", true, "Ollama is reachable and both models are installed.");
const OLLAMA_UNREACHABLE = reading(
  "ollama",
  false,
  "Ollama unreachable at http://localhost:11434: fetch failed",
);

function withEnv(values: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(values);
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a reachable FreeLLMAPI metadata endpoint is still blocked for inference", () => {
  const summary = providerStatusSummary({
    health: [FREELMMAPI_HEALTHY, OLLAMA_UNREACHABLE],
    now: NOW,
  });
  assert.equal(summary.primary.availability, "not_configured");
  assert.equal(summary.primary.statusLabel, "UNVERIFIED");
  assert.equal(summary.primary.policyBlocked, true);
  assert.equal(summary.primary.executionType, "blocked");
  assert.match(summary.primary.detail, /free tier|unverified|CHF 0\.00/i);
  assert.equal(summary.externalInference, "blocked");
  assert.equal(summary.maximumAuthorisedExternalSpendChf, 0);
  assert.equal(summary.freeTier.freellmapi.state, "unverified");
  assert.equal(summary.freeTier.gemini.state, "unverified");
  assert.equal(summary.state, "unavailable");
  assert.equal(summary.label, "No authorised inference route");
});

test("loopback Ollama available is reported as local-only, never primary external", () => {
  const summary = providerStatusSummary({
    health: [FREELMMAPI_HEALTHY, OLLAMA_HEALTHY],
    now: NOW,
  });
  assert.equal(summary.state, "fallback");
  assert.equal(summary.label, "Local inference only");
  assert.equal(summary.primary.policyBlocked, true);
  assert.equal(summary.fallback.availability, "available");
  assert.equal(summary.fallback.executionType, "local");
  assert.match(summary.detail, /only authorised route|blocked/i);
  assert.doesNotMatch(summary.detail, /Normal AI inference can continue through FreeLLMAPI/i);
});

test("verified free-tier Gemini is reported without inventing a cost or claiming a verified call", () => {
  withEnv(
    {
      AI_PRIMARY_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      GEMINI_FREE_TIER_VERIFIED: "true",
      GEMINI_LIVE_MODEL: "gemini-3.8-live",
      GEMINI_PAID_AUTHORISED: "false",
    },
    () => {
      const summary = providerStatusSummary({ health: [], now: NOW });
      assert.equal(summary.primary.provider, "gemini");
      assert.equal(summary.primary.configured, true);
      assert.equal(summary.primary.policyBlocked, false);
      assert.equal(summary.primary.executionType, "verified_free_external");
      assert.equal(summary.primary.availability, "unknown");
      assert.equal(summary.primary.statusLabel, "Gemini free tier configured · awaiting first call");
      assert.equal(summary.geminiLive.authorised, true, "the declared Gemini free tier covers the published free-tier Live model");
      assert.equal(summary.geminiLive.freeTierState, "available");
      assert.match(summary.geminiLive.statusLabel, /FREE TIER AVAILABLE/);
      assert.equal(summary.geminiLive.model, "gemini-3.8-live");
      assert.equal(summary.billing.authority, "zero_spend");
      assert.equal(summary.billing.actualSpend, "not_reported");
      assert.equal(summary.billing.costStatus, "unverified");
      assert.equal(summary.maximumAuthorisedExternalSpendChf, 0);
      assert.equal(summary.externalInference, "free_tier_first");
      assert.equal(summary.freeTier.gemini.state, "available");
    },
  );
});

test("a paid-authorisation flag never makes Gemini text available without a free-tier declaration", () => {
  withEnv(
    {
      AI_PRIMARY_PROVIDER: "gemini",
      GEMINI_API_KEY: "test-gemini-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      GEMINI_FREE_TIER_VERIFIED: "false",
      GEMINI_PAID_AUTHORISED: "true",
    },
    () => {
      const summary = providerStatusSummary({ health: [], now: NOW });
      assert.equal(summary.primary.provider, "gemini");
      assert.equal(summary.primary.configured, true);
      assert.equal(summary.primary.policyBlocked, true);
      assert.equal(summary.primary.executionType, "blocked");
      assert.equal(summary.primary.statusLabel, "UNVERIFIED");
      assert.equal(summary.geminiLive.authorised, false, "the legacy paid flag cannot authorise Gemini Live");
      assert.equal(summary.geminiLive.freeTierState, "unverified");
      assert.equal(summary.billing.authority, "zero_spend");
      assert.equal(summary.maximumAuthorisedExternalSpendChf, 0);
      assert.equal(summary.externalInference, "blocked");
    },
  );
});

test("a non-loopback Ollama endpoint is blocked even when its health probe succeeds", () => {
  withEnv({ OLLAMA_BASE_URL: "http://ollama.test" }, () => {
    const summary = providerStatusSummary({
      health: [FREELMMAPI_HEALTHY, OLLAMA_HEALTHY],
      now: NOW,
    });
    assert.equal(summary.fallback.policyBlocked, true);
    assert.equal(summary.fallback.statusLabel, "Blocked by zero-spend policy");
    assert.equal(summary.state, "unavailable");
    assert.equal(summary.label, "No authorised inference route");
  });
});

test("stale Ollama health is still stale and never promoted to ready", () => {
  const summary = providerStatusSummary({
    health: [
      FREELMMAPI_HEALTHY,
      reading("ollama", false, "Ollama unreachable at http://localhost:11434: fetch failed", STALE),
    ],
    now: NOW,
  });
  assert.equal(summary.primary.policyBlocked, true);
  assert.equal(summary.fallback.availability, "stale");
  assert.equal(summary.fallback.statusLabel, "Last health result is stale");
  assert.equal(summary.state, "unavailable");
});

test("missing provider configuration is a configuration gap, not a service outage", () => {
  withEnv({ FREELLMAPI_ENABLED: "false", OLLAMA_ENABLED: "false" }, () => {
    const summary = providerStatusSummary({ health: [], now: NOW });
    assert.equal(summary.state, "unconfigured");
    assert.equal(summary.primary.availability, "not_configured");
    assert.equal(summary.fallback.availability, "not_configured");
    assert.match(summary.detail, /configuration gap, not a service outage/i);
  });
});

test("an incomplete local fallback is a configuration gap", () => {
  withEnv({ OLLAMA_CODER_MODEL: "" }, () => {
    const summary = providerStatusSummary({
      health: [FREELMMAPI_HEALTHY, OLLAMA_UNREACHABLE],
      now: NOW,
    });
    assert.equal(summary.primary.policyBlocked, true);
    assert.equal(summary.fallback.enabled, true);
    assert.equal(summary.fallback.configured, false);
    assert.equal(summary.fallback.availability, "not_configured");
    assert.match(summary.fallback.detail, /OLLAMA_CODER_MODEL/);
  });
});

test("provider status never initiates a network probe", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error("provider status must not send requests");
  }) as typeof fetch;
  try {
    const cached = providerStatusSummary({ now: NOW });
    assert.ok(cached.primary.provider);
    providerStatusSummary({ health: [FREELMMAPI_HEALTHY, OLLAMA_HEALTHY], now: NOW });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an expired historical cooldown stops appearing as an active route without deleting the evidence row", () => {
  health.recordProviderFailure({
    provider: "ollama",
    model: "llama3.2:3b",
    kind: "unavailable",
    message: "fetch failed",
    attempt: 1,
  });
  const row = db.one<{ status: string; last_error: string }>(
    "SELECT status, last_error FROM provider_health WHERE provider = 'ollama' AND model = 'llama3.2:3b'",
  );
  assert.equal(row?.status, "cooling");
  assert.equal(row?.last_error, "fetch failed");

  const active = health.providerHealthSnapshot(Date.now() + 20_000);
  assert.equal(active.some((entry) => entry.provider === "ollama"), false);
  assert.ok(
    db.one<{ provider: string }>(
      "SELECT provider FROM provider_health WHERE provider = 'ollama' AND model = 'llama3.2:3b'",
    ),
    "historical health evidence must remain in the database",
  );
});
