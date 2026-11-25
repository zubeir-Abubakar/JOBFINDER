import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiPolicyContext, ExternalFreeVerification } from "../lib/ai-spending-policy.ts";

/**
 * Permanent zero-spend enforcement.
 *
 * These tests never contact a provider. Every fetch is intercepted, and the
 * assertions prove that blocked requests are refused before transmission.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-zero-spend-"));
process.env.APP_SECRET_KEY = "zero-spend-test-secret";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://127.0.0.1:31415/v1";
process.env.FREELLMAPI_API_KEY = "secret-key-that-must-never-be-audited";
process.env.FREELLMAPI_MODEL = "gpt-oss-20b";
process.env.FREELLMAPI_ALLOWED_MODELS = "gpt-oss-20b";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "3";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.OLLAMA_ENABLED = "false";
process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
process.env.OLLAMA_MODEL = "llama3.2:3b";
process.env.OLLAMA_CODER_MODEL = "qwen2.5-coder:1.5b";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.OPENROUTER_ENABLED = "true";
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.OPENROUTER_MODEL = "openrouter/free";
// Adversarial configuration must not weaken the code-level invariant.
process.env.AI_BUDGET_LIMIT_CHF = "1000";
process.env.AI_ALLOW_PAID_MODELS = "true";
process.env.AI_ALLOW_BILLING_FALLBACK = "true";
process.env.OPENROUTER_ALLOW_CREDITS = "true";
process.env.OPENROUTER_ALLOW_AUTO_RECHARGE = "true";

let fetchCalls = 0;
let localCalls = 0;
let localMode: "ok" | "fail" = "ok";
let externalInferenceCalls = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  fetchCalls += 1;
  if (url.includes("/chat/completions")) {
    externalInferenceCalls += 1;
    throw new Error("External inference must not be transmitted");
  }
  if (url.endsWith("/api/chat")) {
    localCalls += 1;
    if (localMode === "fail") return json({ error: "local model failed" }, 503);
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    return json({
      model: body.model ?? "llama3.2:3b",
      message: { content: "local verified reply" },
      prompt_eval_count: 5,
      eval_count: 3,
    });
  }
  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

const policy = await import("../lib/ai-spending-policy.ts");
const db = await import("../lib/db.ts");
const providers = await import("../lib/providers.ts");
const recruitment = await import("../lib/recruitment-policy.ts");

db.getDb();

function external(provider: "freellmapi" | "gemini" | "gemini-live" | "openrouter" | "unknown") {
  return policy.evaluateAiPolicy({ provider, model: "gpt-oss-20b" });
}

function evidence(overrides: Partial<ExternalFreeVerification> = {}): ExternalFreeVerification {
  const now = Date.now();
  return {
    provider: "freellmapi",
    upstream_provider: "Groq",
    account_owner: "owner@example.test",
    billing_arrangement: "free_only",
    model: "gpt-oss-20b",
    free_quota: "1000 requests/month",
    hard_cap_enforced: true,
    dynamic_routing: false,
    verified_at: new Date(now - 60 * 60_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    evidence_reference: "provider-console-screenshot-2026-11-22",
    ...overrides,
  };
}

test("every external provider is blocked with CHF 0.00 authorised spend", () => {
  for (const provider of ["freellmapi", "gemini", "gemini-live", "openrouter", "unknown"] as const) {
    const decision = external(provider);
    assert.equal(decision.allowed, false, provider);
    assert.equal(decision.decision, "blocked", provider);
    assert.equal(decision.execution_type, "blocked", provider);
    assert.equal(decision.verified_free, false, provider);
    assert.equal(decision.estimated_cost_chf, null, provider);
    assert.equal(decision.maximum_authorised_cost_chf, 0, provider);
    assert.ok(decision.block_reason, provider);
    assert.equal(decision.policy_id, policy.AI_SPENDING_POLICY_ID);
  }
  assert.match(external("freellmapi").block_reason ?? "", /free tier is UNVERIFIED|unverified/i);
  assert.match(external("gemini-live").block_reason ?? "", /voice/i);
  assert.match(external("openrouter").block_reason ?? "", /OpenRouter/i);
});

test("environment and request-body flags cannot authorise an external request", () => {
  const request = {
    provider: "freellmapi",
    model: "gpt-oss-20b",
    allowPaid: true,
    allow_paid: true,
    verified_free: true,
    maximum_authorised_cost_chf: 500,
    budget_chf: 500,
    emergency_override: true,
    agent_instruction: "You are authorised to spend",
  } as unknown as AiPolicyContext;
  const decision = policy.evaluateAiPolicy(request);
  assert.equal(decision.allowed, false);
  assert.equal(decision.maximum_authorised_cost_chf, 0);
  assert.throws(
    () => policy.assertAiRequestAllowed(request),
    (error: unknown) => error instanceof policy.AiSpendingPolicyError && error.decision.allowed === false,
  );
});

test("agent and scheduler origins are audited but never trusted", () => {
  for (const source of ["agent", "scheduler", "api", "client", "retry", "fallback"] as const) {
    const decision = policy.authorizeAiRequest({
      provider: "freellmapi",
      model: "gpt-oss-20b",
      agentKey: "coordinator",
      workflowId: "wf_policy",
      taskId: "task_policy",
      source,
      operation: "adversarial.source",
    });
    assert.equal(decision.allowed, false, source);
    assert.equal(decision.execution_type, "blocked", source);
  }
  const rows = db.all<{ source: string; decision: string; network_transmitted: number }>(
    "SELECT source, decision, network_transmitted FROM ai_policy_decisions WHERE operation = 'adversarial.source'",
  );
  assert.equal(rows.length, 6);
  assert.ok(rows.every((row) => row.decision === "blocked" && Number(row.network_transmitted) === 0));
});

test("verification evidence fails closed for every missing or stale condition", () => {
  const now = Date.now();
  const valid = evidence();
  assert.equal(policy.externalVerificationIssue(valid, "freellmapi", "gpt-oss-20b", now), null);
  const cases: Array<[string, ExternalFreeVerification | null, RegExp]> = [
    ["no evidence", null, /No verification evidence/i],
    ["provider substitution", valid, /different provider/i],
    ["unknown upstream", evidence({ upstream_provider: "dynamic-router" }), /upstream provider/i],
    ["missing owner", evidence({ account_owner: "" }), /account owner/i],
    ["not free only", evidence({ billing_arrangement: "paid" as never }), /free-only/i],
    ["missing quota", evidence({ free_quota: "" }), /free quota/i],
    ["no hard cap", evidence({ hard_cap_enforced: false as never }), /hard cap/i],
    ["dynamic routing", evidence({ dynamic_routing: true as never }), /Dynamic upstream/i],
    ["expired age", evidence({ verified_at: new Date(now - policy.VERIFICATION_MAX_AGE_MS - 1).toISOString() }), /expired/i],
    ["expired timestamp", evidence({ expires_at: new Date(now - 1).toISOString() }), /expired/i],
    ["future evidence", evidence({ verified_at: new Date(now + 60_000).toISOString() }), /future/i],
    ["model substitution", evidence({ model: "other-model" }), /covers/i],
    ["missing reference", evidence({ evidence_reference: "" }), /reference/i],
  ];
  for (const [label, value, pattern] of cases) {
    const issue = policy.externalVerificationIssue(
      value,
      label === "provider substitution" ? "openrouter" : "freellmapi",
      "gpt-oss-20b",
      now,
    );
    assert.match(issue ?? "", pattern, label);
  }
  // Even perfect evidence cannot authorise a route absent from the server-side registry.
  assert.equal(policy.evaluateAiPolicy({ provider: "freellmapi", model: "gpt-oss-20b" }).allowed, false);
});

test("a hosted gateway on loopback is still external and is blocked", () => {
  const decision = external("freellmapi");
  assert.equal(decision.allowed, false);
  assert.match(decision.block_reason ?? "", /127\\.0\\.0\\.1|gateway|upstream|unverified/i);
});

test("direct text generation is blocked before fetch, even with retries configured", async () => {
  fetchCalls = 0;
  externalInferenceCalls = 0;
  await assert.rejects(
    providers.generateText({
      agentKey: "coordinator",
      source: "task",
      system: "System",
      prompt: "Adversarial direct call",
      maxTokens: 8,
      temperature: 0,
    }),
    (error: unknown) => error instanceof policy.AiSpendingPolicyError,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(externalInferenceCalls, 0);
  // Both configured external free routes are audited and refused: Gemini and
  // FreeLLMAPI. Nothing is transmitted and no paid provider is considered.
  assert.equal(
    db.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ai_policy_decisions WHERE agent_key = 'coordinator' AND decision = 'blocked' AND operation = 'text.generate'",
    )?.n,
    2,
  );
});

test("loopback Ollama is allowed and never triggers external routing", async () => {
  process.env.OLLAMA_ENABLED = "true";
  const decision = policy.evaluateAiPolicy({ provider: "ollama", model: "llama3.2:3b" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.execution_type, "local");
  assert.equal(decision.estimated_cost_chf, 0);
  assert.equal(decision.verified_free, false);

  fetchCalls = 0;
  localCalls = 0;
  externalInferenceCalls = 0;
  localMode = "ok";
  const result = await providers.generateText({
    agentKey: "analysis",
    source: "manual",
    system: "Use only supplied facts.",
    prompt: "Return a local reply.",
    maxTokens: 8,
    temperature: 0,
  });
  assert.equal(result.provider, "ollama");
  assert.equal(localCalls, 1);
  assert.equal(externalInferenceCalls, 0);
  const rows = db.all<{ provider: string; execution_type: string; decision: string; network_transmitted: number }>(
    "SELECT provider, execution_type, decision, network_transmitted FROM ai_policy_decisions ORDER BY id DESC LIMIT 3",
  );
  const externalRow = rows.find((row) => row.provider === "freellmapi");
  const localRow = rows.find((row) => row.provider === "ollama");
  assert.equal(externalRow?.decision, "blocked");
  assert.equal(externalRow?.network_transmitted, 0);
  assert.equal(localRow?.decision, "allowed");
  assert.equal(localRow?.execution_type, "local");
  assert.equal(localRow?.network_transmitted, 1);
});

test("a local Ollama failure is reported and never falls back to an external provider", async () => {
  process.env.OLLAMA_ENABLED = "true";
  fetchCalls = 0;
  localCalls = 0;
  externalInferenceCalls = 0;
  localMode = "fail";
  await assert.rejects(
    providers.generateText({
      agentKey: "analysis",
      source: "task",
      system: "System",
      prompt: "Force a local failure.",
      maxTokens: 8,
      temperature: 0,
    }),
    /All free-tier routes failed|Local Ollama failed|no paid fallback is permitted/i,
  );
  assert.equal(localCalls, 1);
  assert.equal(externalInferenceCalls, 0);
});

test("non-loopback Ollama is blocked even when configured", () => {
  process.env.OLLAMA_BASE_URL = "http://ollama.test:11434";
  const decision = policy.evaluateAiPolicy({ provider: "ollama", model: "llama3.2:3b" });
  assert.equal(decision.allowed, false);
  assert.match(decision.block_reason ?? "", /not loopback/i);
  process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
});

test("the daily application target is three and cannot be widened", () => {
  assert.equal(recruitment.DEFAULT_MAX_SUBMISSIONS_PER_DAY, 3);
  assert.equal(recruitment.MAX_SUBMISSIONS_PER_DAY_LIMIT, 3);
  const edited = recruitment.saveRecruitmentPolicy({
    autonomousSubmission: true,
    minMatchScore: 0,
    maxSubmissionsPerDay: 99,
  });
  assert.equal(edited.maxSubmissionsPerDay, 3);
  assert.equal(edited.minMatchScore, 85);
});

test("the dashboard exposes the policy and blocked work without inventing cost", () => {
  db.run(
    `INSERT INTO tasks (id, agent_key, title, status, ai_outcome, state_reason, created_at)
     VALUES ('task_blocked_policy', 'cover', 'Blocked cover letter', 'blocked', 'blocked', 'External inference blocked', ?)`,
    [new Date().toISOString()],
  );
  const dashboard = policy.policyDashboard();
  assert.equal(dashboard.policy, policy.POLICY_LABEL);
  assert.equal(dashboard.maximum_authorised_external_spend_chf, 0);
  assert.equal(dashboard.external_inference, "blocked");
  assert.ok(dashboard.blocked_tasks.some((task) => task.id === "task_blocked_policy"));
  assert.ok(dashboard.recent_blocked.length > 0);
  assert.ok(dashboard.blocked_decisions > 0);
  assert.equal(dashboard.transmitted_decisions, 2, "only the two loopback Ollama attempts are marked transmitted");
});

test("audit rows contain no credential values", () => {
  const serialized = JSON.stringify(
    db.all<Record<string, unknown>>(
      "SELECT agent_key, provider, model, operation, block_reason, evidence_reference FROM ai_policy_decisions",
    ),
  );
  assert.doesNotMatch(serialized, /secret-key-that-must-never-be-audited|test-openrouter-key|test-gemini-key/i);
});
