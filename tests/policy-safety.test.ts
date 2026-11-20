import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-policy-safety-"));
process.env.APP_SECRET_KEY = "policy-safety-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.RECRUITMENT_DRY_RUN;

const db = await import("../lib/db.ts");
const settings = await import("../lib/settings.ts");
const policy = await import("../lib/recruitment-policy.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("fresh installs require approval, disable autonomous submission and start in dry run", () => {
  assert.equal(settings.getSetting("approval_mode", false), true);
  assert.equal(settings.getSetting("autonomous_submission", true), false);
  assert.equal(settings.getSetting("recruitment_dry_run", false), true);
  const current = policy.getRecruitmentPolicy();
  assert.equal(current.requirePerApplicationApproval, true);
  assert.equal(current.autonomousSubmission, false);
  assert.equal(current.active, false);
});

test("a restart does not flip the owner's safety switches", () => {
  settings.setSetting("approval_mode", true);
  settings.setSetting("autonomous_submission", false);
  settings.setSetting("recruitment_dry_run", true);
  db.closeDb();
  db.getDb();
  assert.equal(settings.getSetting("approval_mode", false), true);
  assert.equal(settings.getSetting("autonomous_submission", true), false);
  assert.equal(settings.getSetting("recruitment_dry_run", false), true);
});

test("turning automatic submission off restores per-application approval", () => {
  policy.saveRecruitmentPolicy({
    autonomousSubmission: false,
    minMatchScore: 85,
    maxSubmissionsPerDay: 3,
  });
  assert.equal(settings.getSetting("approval_mode", false), true);
  assert.equal(settings.getSetting("autonomous_submission", true), false);
  assert.equal(policy.getRecruitmentPolicy().active, false);
});
