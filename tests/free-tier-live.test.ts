import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Real free-tier inference evidence.
 *
 * This file is opt-in: it is only defined when FREE_TIER_LIVE=1 is set with the
 * real credentials loaded (for example `node --env-file=.env`). It makes one
 * minimal text request per provider through the actual router and records the
 * actual provider/model. It deliberately does not retry, does not exhaust a
 * quota and never requests a paid model.
 *
 * A skipped run is not evidence. Run it explicitly and report the result.
 */

if (process.env.FREE_TIER_LIVE === "1") {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-free-tier-live-"));
  process.env.APP_SECRET_KEY = "free-tier-live-secret";
  process.env.AI_MAX_RETRIES = "0";
  process.env.AI_MAX_CONCURRENCY = "1";
  // Keep the local route out of this evidence so each provider is proven on its
  // own; fallback behaviour is covered by the deterministic suite.
  process.env.OLLAMA_ENABLED = "false";

  const providers = await import("../lib/providers.ts");
  const freeTier = await import("../lib/free-tier.ts");

  function prompt(agentKey: string) {
    return {
      agentKey,
      source: "manual" as const,
      system: "Answer with exactly one short word. Do not use tools.",
      prompt: "Reply with OK.",
      maxTokens: 8,
      temperature: 0,
    };
  }

  test("real Gemini free-tier text inference uses the declared free-tier model", async () => {
    const status = freeTier.freeTierStatus("gemini");
    assert.equal(status.allowed, true, `Gemini free tier is ${status.state}: ${status.detail}`);
    const result = await providers.generateText(prompt("application"));
    assert.equal(result.provider, "gemini", `fallback occurred: ${result.diagnostics?.fallbackReason ?? "none"}`);
    assert.equal(result.model, process.env.GEMINI_MODEL);
    assert.ok(result.text.trim().length > 0);
    console.log(`[free-tier-live] gemini model=${result.model} tokens=${result.usage.totalTokens} text=${JSON.stringify(result.text.slice(0, 40))}`);
  });

  test("real FreeLLMAPI free-tier text inference uses the pinned free-tier model", async () => {
    const status = freeTier.freeTierStatus("freellmapi");
    assert.equal(status.allowed, true, `FreeLLMAPI free tier is ${status.state}: ${status.detail}`);
    const result = await providers.generateText(prompt("analysis"));
    assert.equal(result.provider, "freellmapi", `fallback occurred: ${result.diagnostics?.fallbackReason ?? "none"}`);
    // The router accepts the pinned id or an explicitly declared resolution
    // alias. The gateway load-balances and reports the provider-prefixed id.
    const accepted = [
      process.env.FREELLMAPI_MODEL,
      ...(process.env.FREELLMAPI_MODEL_ALIASES ?? "").split(",").map((value) => value.trim()),
    ].filter(Boolean);
    assert.ok(accepted.includes(result.model), `unexpected resolved model: ${result.model}`);
    assert.ok(result.text.trim().length > 0);
    console.log(`[free-tier-live] freellmapi model=${result.model} tokens=${result.usage.totalTokens} text=${JSON.stringify(result.text.slice(0, 40))}`);
  });
}
