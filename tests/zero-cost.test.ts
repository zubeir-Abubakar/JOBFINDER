import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-zero-cost-"));
process.env.APP_SECRET_KEY = "zero-cost-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const policy = await import("../lib/ai-spending-policy.ts");

db.getDb();

const MANAGED = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FREE_TIER_VERIFIED",
  "GEMINI_FREE_TIER_EVIDENCE",
  "FREELLMAPI_ENABLED",
  "FREELLMAPI_BASE_URL",
  "FREELLMAPI_API_KEY",
  "FREELLMAPI_MODEL",
  "FREELLMAPI_ALLOWED_MODELS",
  "FREELLMAPI_FREE_TIER_VERIFIED",
  "FREELLMAPI_FREE_TIER_EVIDENCE",
  "OLLAMA_ENABLED",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "OLLAMA_CODER_MODEL",
];

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const key of MANAGED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
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

test("Gemini credentials without a free-tier declaration are blocked before transmission", () => {
  withEnv(
    {
      GEMINI_API_KEY: "test-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      FREELLMAPI_ENABLED: "false",
      OLLAMA_ENABLED: "false",
    },
    () => {
      const decision = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" });
      assert.equal(decision.allowed, false);
      assert.equal(decision.execution_type, "blocked");
      assert.equal(decision.estimated_cost_chf, null);
      assert.match(decision.block_reason ?? "", /free tier is UNVERIFIED/i);
    },
  );
});

test("a configured FreeLLMAPI gateway without free-tier evidence is blocked", () => {
  withEnv(
    {
      FREELLMAPI_ENABLED: "true",
      FREELLMAPI_BASE_URL: "http://127.0.0.1:31415/v1",
      FREELLMAPI_API_KEY: "test-key",
      FREELLMAPI_MODEL: "gpt-oss-120b",
      FREELLMAPI_ALLOWED_MODELS: "gpt-oss-120b",
      OLLAMA_ENABLED: "false",
    },
    () => {
      const decision = policy.evaluateAiPolicy({ provider: "freellmapi", model: "gpt-oss-120b" });
      assert.equal(decision.allowed, false);
      assert.match(decision.block_reason ?? "", /free tier is UNVERIFIED/i);
    },
  );
});

test("an operator declaration without provider evidence is not accepted", () => {
  withEnv(
    {
      GEMINI_API_KEY: "test-key",
      GEMINI_MODEL: "gemini-3.6-flash",
      GEMINI_FREE_TIER_VERIFIED: "true",
      FREELLMAPI_ENABLED: "false",
      OLLAMA_ENABLED: "false",
    },
    () => {
      const decision = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" });
      assert.equal(decision.allowed, false);
      assert.equal(decision.verification_kind, null);
      assert.match(decision.block_reason ?? "", /provider evidence/i);
    },
  );
});

test("only loopback Ollama is allowed when no external free tier is verified", () => {
  withEnv(
    {
      GEMINI_FREE_TIER_VERIFIED: "false",
      FREELLMAPI_ENABLED: "false",
      OLLAMA_ENABLED: "true",
      OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      OLLAMA_MODEL: "llama3.2:3b",
    },
    () => {
      const local = policy.evaluateAiPolicy({ provider: "ollama", model: "llama3.2:3b" });
      assert.equal(local.allowed, true);
      assert.equal(local.execution_type, "local");
      assert.equal(local.estimated_cost_chf, 0);
      const external = policy.evaluateAiPolicy({ provider: "gemini", model: "gemini-3.6-flash" });
      assert.equal(external.allowed, false);
    },
  );
});
