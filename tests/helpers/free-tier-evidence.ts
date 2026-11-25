/**
 * Deterministic provider-evidence fixtures for local tests.
 *
 * These records are test doubles, not claims about a live provider account.
 * They fill the same structure the runtime now requires so tests can exercise
 * the policy without contacting Gemini or FreeLLMAPI.
 */

type EvidenceInput = {
  proofProvider: "gemini" | "google" | "freellmapi";
  models: string[];
  billing: "disabled" | "not_enabled" | "free_only";
  reference: string;
};

function record(input: EvidenceInput): string {
  const now = Date.now();
  return JSON.stringify({
    source: "provider_console",
    provider: input.proofProvider,
    account: "test-account-fixture",
    model: input.models[0],
    models: input.models,
    billing: input.billing,
    free_tier: true,
    hard_cap: true,
    quota_status: "available",
    quota_remaining: 1000,
    verified_at: new Date(now - 60_000).toISOString(),
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    evidence_reference: input.reference,
  });
}

export function geminiEvidence(models: string[] = [process.env.GEMINI_MODEL || "gemini-3.6-flash"]): string {
  return record({
    proofProvider: "google",
    models,
    billing: "disabled",
    reference: "https://console.cloud.google.com/billing/000000-000000-000000",
  });
}

export function freeLlmEvidence(models: string[] = [process.env.FREELLMAPI_MODEL || "gpt-oss-20b"]): string {
  const base = (process.env.FREELLMAPI_BASE_URL || "http://127.0.0.1:31415/v1").replace(/\/+$/, "");
  return record({
    proofProvider: "freellmapi",
    models,
    billing: "free_only",
    reference: `${base}/evidence`,
  });
}
