import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-handoff-"));
process.env.APP_SECRET_KEY = "handoff-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";

const db = await import("../lib/db.ts");
const handoff = await import("../lib/handoff.ts");

db.getDb();
const ts = "2026-11-20T09:00:00.000Z";
db.run("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_owner','owner@example.test','x','Owner','owner',?)", [ts]);
db.run("INSERT INTO users (id, email, password_hash, name, role, created_at) VALUES ('u_foreign','foreign@example.test','x','Foreign','owner',?)", [ts]);
db.run(
  `INSERT INTO jobs (id, source, source_platform, external_id, title, company, location, url, application_url, description,
     published_at, discovered_at, status, match_score, qualified, analysis, eligibility, vacancy_status, vacancy_verification, vacancy_verified_at)
   VALUES ('job_handoff','fixture','Greenhouse','ext-1','Senior QA Engineer','Fixture AG','Zurich',
     'https://fixture.test/post/1','https://fixture.test/apply/1','Apply with Playwright and TypeScript.',
     ?, ?, 'ready', 92, 1, ?, 'eligible', 'open', 'Employer endpoint returned 200 and the vacancy is listed.', ?)`,
  [ts, ts, JSON.stringify({ score: 92, flag: "strong", matched: ["Playwright", "TypeScript"], missing: ["German"], concerns: [] }), ts],
);
db.run(
  `INSERT INTO applications (id, job_id, status, submission_status, cv_document_id, cover_letter_id, readiness, last_update, created_at)
   VALUES ('app_handoff','job_handoff','human_intervention_required','blocked','doc_cv','doc_cover',?,?,?)`,
  [JSON.stringify({ ready: false, state: "blocked", reasons: ["The employer form uses a CAPTCHA."] }), ts, ts],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, created_at)
   VALUES ('doc_cv','u_owner','tailored_cv','Tailored CV — Fixture','cv.pdf','application/pdf','cv.pdf',?)`,
  [ts],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, created_at)
   VALUES ('doc_cover','u_owner','cover_letter','Cover letter — Fixture','cover.pdf','application/pdf','cover.pdf',?)`,
  [ts],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, created_at)
   VALUES ('doc_foreign','u_foreign','tailored_cv','Foreign CV','foreign.pdf','application/pdf','foreign.pdf',?)`,
  [ts],
);
db.run(
  `INSERT INTO application_interventions (id, application_id, job_id, field, question, reason, kind, status, answer, resolved_at, created_at)
   VALUES ('int_handoff','app_handoff','job_handoff','captcha','Complete the security check','The employer form uses a CAPTCHA, which is never bypassed.','captcha','open',NULL,NULL,?)`,
  [ts],
);
db.run(
  `INSERT INTO application_interventions (id, application_id, job_id, field, question, reason, kind, status, answer, resolved_at, created_at)
   VALUES ('int_answer','app_handoff','job_handoff','notice','What is your notice period?','Answered by the owner.','question','resolved','One month',?,?)`,
  [ts, ts],
);

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("a blocked application has a complete persistent handoff package", () => {
  const item = handoff.handoffForApplication("u_owner", "app_handoff");
  assert.ok(item);
  assert.equal(item!.employer, "Fixture AG");
  assert.equal(item!.jobTitle, "Senior QA Engineer");
  assert.equal(item!.applicationUrl, "https://fixture.test/apply/1");
  assert.equal(item!.postingUrl, "https://fixture.test/post/1");
  assert.equal(item!.matchScore, 92);
  assert.match(item!.matchExplanation, /Playwright/);
  assert.equal(item!.blocker.kind, "captcha");
  assert.match(item!.stopExplanation, /No application was sent/i);
  assert.equal(item!.cv?.id, "doc_cv");
  assert.equal(item!.coverLetter?.id, "doc_cover");
  assert.equal(item!.preparedAnswers.length, 1);
  assert.equal(item!.preparedAnswers[0].answer, "One month");
  assert.ok(item!.remainingSteps.some((step) => /CAPTCHA/.test(step)));
  assert.equal(item!.queueStatus, "waiting_for_user_action");
});

test("another account's document is never included, even if its id is linked", () => {
  db.run("UPDATE applications SET cv_document_id = 'doc_foreign' WHERE id = 'app_handoff'");
  const item = handoff.handoffForApplication("u_owner", "app_handoff");
  assert.ok(item);
  assert.equal(item!.cv, null, "a foreign document is not exposed");
  db.run("UPDATE applications SET cv_document_id = 'doc_cv' WHERE id = 'app_handoff'");
});

test("the handoff survives a database reopen", () => {
  db.closeDb();
  db.getDb();
  const item = handoff.handoffForApplication("u_owner", "app_handoff");
  assert.ok(item);
  assert.equal(item!.applicationUrl, "https://fixture.test/apply/1");
  assert.equal(item!.cv?.id, "doc_cv");
});
