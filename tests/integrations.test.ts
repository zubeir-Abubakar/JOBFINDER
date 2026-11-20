import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-integrations-"));
process.env.APP_SECRET_KEY = "integrations-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.GREENHOUSE_JOB_BOARD_API_KEY;
delete process.env.LEVER_POSTINGS_API_KEY;
delete process.env.ASHBY_API_KEY;
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;

const db = await import("../lib/db.ts");
const integrations = await import("../lib/integrations.ts");

db.getDb();

test("an adapter existing is not reported as an operational integration", async () => {
  const inventory = integrations.integrationInventory();
  assert.equal(inventory.integrations.length, 5);
  assert.equal(inventory.automaticSubmissionOperational, false);
  for (const item of inventory.integrations) {
    assert.equal(item.operational, false, `${item.name} must not claim operational status`);
  }
  assert.ok(inventory.reasons.some((reason) => /No ATS credential is configured/i.test(reason)));
  const greenhouse = inventory.integrations.find((item) => item.key === "greenhouse");
  assert.equal(greenhouse?.connectionStatus, "Awaiting employer credential");
  assert.equal(greenhouse?.credentials[0]?.present, false);
  assert.ok(greenhouse?.missing[0]?.includes("GREENHOUSE_JOB_BOARD_API_KEY"));
  const candidate = inventory.integrations.find((item) => item.key === "candidate_form");
  assert.match(candidate?.operationalDetail ?? "", /mock-tested only/i);

  const missing = await integrations.testIntegrationConnection("greenhouse");
  assert.equal(missing.status, "blocked");
  assert.match(missing.detail, /missing/i);
});

test("a present credential is shown as set but never displayed and never counts as verified", async () => {
  process.env.GREENHOUSE_JOB_BOARD_API_KEY = "super-secret-greenhouse-value";
  process.env.RECRUITMENT_SUBMISSION_ENDPOINT = "https://private.example.test/submit/{job_id}";
  const inventory = integrations.integrationInventory();
  const greenhouse = inventory.integrations.find((item) => item.key === "greenhouse");
  assert.equal(greenhouse?.credentials[0]?.present, true);
  assert.equal(greenhouse?.connectionStatus, "Credential present — not verified");
  assert.equal(greenhouse?.operational, false);
  assert.match(greenhouse?.operationalDetail ?? "", /until a real connection test succeeds/i);
  assert.equal(inventory.automaticSubmissionOperational, false);
  const serialised = JSON.stringify(inventory);
  assert.doesNotMatch(serialised, /super-secret-greenhouse-value/);
  assert.doesNotMatch(serialised, /private\.example\.test/, "the endpoint value is not exposed");
  assert.ok(inventory.integrations.find((item) => item.key === "http_form")?.missing.length);

  const check = await integrations.testIntegrationConnection("greenhouse");
  assert.equal(check.status, "blocked");
  assert.doesNotMatch(check.detail, /super-secret-greenhouse-value/);
});

test("only a recorded successful connection test makes an adapter operational", () => {
  integrations.recordIntegrationCheck("http_form", {
    status: "success",
    checkedAt: new Date().toISOString(),
    detail: "Controlled test endpoint accepted a read-only check. No application was sent.",
  });
  const inventory = integrations.integrationInventory();
  const endpoint = inventory.integrations.find((item) => item.key === "http_form");
  assert.equal(endpoint?.operational, true);
  assert.equal(endpoint?.lastSuccessAt, endpoint?.lastCheck?.checkedAt);
  assert.equal(inventory.automaticSubmissionOperational, true);
  assert.match(endpoint?.operationalDetail ?? "", /every readiness and policy gate/i);
});
