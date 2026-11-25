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

test("fresh installs submit eligible applications automatically with no per-application approval", () => {
  assert.equal(settings.getSetting("approval_mode", true), false);
  assert.equal(settings.getSetting("autonomous_submission", false), true);
  assert.equal(settings.getSetting("recruitment_dry_run", true), false);
  const current = policy.getRecruitmentPolicy();
  assert.equal(current.requirePerApplicationApproval, false);
  assert.equal(current.autonomousSubmission, true);
  assert.equal(current.active, true);
});

test("a restart does not flip the owner's automatic-submission switch", () => {
  settings.setSetting("autonomous_submission", false);
  db.closeDb();
  db.getDb();
  assert.equal(settings.getSetting("approval_mode", true), false);
  assert.equal(settings.getSetting("autonomous_submission", true), false);
  assert.equal(policy.getRecruitmentPolicy().active, false);
});

test("pausing automatic submission never restores a per-application approval gate", () => {
  policy.saveRecruitmentPolicy({
    autonomousSubmission: false,
    minMatchScore: 85,
    maxSubmissionsPerDay: 3,
  });
  assert.equal(settings.getSetting("approval_mode", true), false);
  assert.equal(settings.getSetting("autonomous_submission", true), false);
  assert.equal(policy.getRecruitmentPolicy().requirePerApplicationApproval, false);
  assert.equal(policy.getRecruitmentPolicy().active, false);

  policy.resumeStandingAuthorisation();
  assert.equal(settings.getSetting("autonomous_submission", false), true);
  assert.equal(settings.getSetting("approval_mode", true), false);
  assert.equal(policy.getRecruitmentPolicy().requirePerApplicationApproval, false);
  assert.equal(policy.getRecruitmentPolicy().active, true);
});

test("the daily cap and threshold floor survive a policy save", () => {
  policy.saveRecruitmentPolicy({
    autonomousSubmission: true,
    minMatchScore: 10,
    maxSubmissionsPerDay: 99,
  });
  const current = policy.getRecruitmentPolicy();
  assert.equal(current.minMatchScore, 85);
  assert.equal(current.maxSubmissionsPerDay, policy.MAX_SUBMISSIONS_PER_DAY_LIMIT);
});
