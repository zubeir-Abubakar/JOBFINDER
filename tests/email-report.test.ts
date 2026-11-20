import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-email-report-"));
process.env.APP_SECRET_KEY = "email-report-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const email = await import("../lib/email-template.ts");
const mime = await import("../lib/email-mime.ts");

db.getDb();

const now = new Date("2026-11-20T10:00:00+01:00");
const at = "2026-11-20T09:15:00.000Z";
const at2 = "2026-11-20T09:20:00.000Z";
const at3 = "2026-11-20T09:25:00.000Z";
const at4 = "2026-11-20T09:30:00.000Z";

db.run(
  "INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, qualified, analysis, application_url, published_at) VALUES ('job_report_1','test','Senior QA Engineer','Acme <script>','Zurich',?,'applied',92,1,'{}','https://example.test/apply/1',?)",
  [at, at],
);
db.run(
  "INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, qualified, analysis, application_url, published_at) VALUES ('job_report_2','test','Test Lead','Beta AG','Bern',?,'acknowledged',88,1,'{}','https://example.test/apply/2',?)",
  [at, at],
);
db.run(
  "INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, qualified, analysis, application_url, published_at) VALUES ('job_report_3','test','Legacy Role','Gamma','Geneva','2026-11-18T09:00:00.000Z','applied',80,0,'{}','https://example.test/apply/3','2026-11-18T09:00:00.000Z')",
);
db.run(
  "INSERT INTO applications (id, job_id, status, submission_status, submitted_at, confirmation_ref, method, last_update, created_at) VALUES ('app_report_1','job_report_1','submitted','verified',?,'REF-123','candidate_form',?,?)",
  [at, at, at],
);
db.run(
  "INSERT INTO applications (id, job_id, status, submission_status, submitted_at, confirmation_ref, method, last_update, created_at) VALUES ('app_report_2','job_report_2','acknowledged','verified',?,'MAIL-1','email_confirmation',?,?)",
  [at2, at4, at2],
);
db.run(
  "INSERT INTO applications (id, job_id, status, submission_status, submitted_at, confirmation, method, last_update, created_at) VALUES ('app_report_3','job_report_3','submitted',NULL,?,'legacy confirmation','employer_portal',?,?)",
  [at, at, at],
);
db.run(
  "INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, qualified, analysis, application_url, published_at) VALUES ('job_report_4','test','Pending Role','Delta','Basel','2026-11-18T10:00:00.000Z','documents',87,1,'{}','https://example.test/apply/4','2026-11-18T10:00:00.000Z')",
);
db.run(
  "INSERT INTO applications (id, job_id, status, last_update, created_at) VALUES ('app_report_4','job_report_4','ready_to_submit',?,?)",
  [at4, at4],
);
db.run(
  "INSERT INTO submission_attempts (id, application_id, job_id, channel, status, reference, evidence, attempted_at) VALUES ('sub_report_1','app_report_1','job_report_1','candidate_form','verified','REF-123','{}',?)",
  [at],
);
db.run(
  "INSERT INTO submission_attempts (id, application_id, job_id, channel, status, reference, evidence, attempted_at) VALUES ('sub_report_2','app_report_2','job_report_2','email_confirmation','verified','MAIL-1','{}',?)",
  [at2],
);
db.run(
  "INSERT INTO submission_attempts (id, application_id, job_id, channel, status, error, attempted_at) VALUES ('sub_report_3','app_report_4','job_report_1','candidate_form','unverified','No reference returned',?)",
  [at3],
);
db.run(
  "INSERT INTO email_messages (id, gmail_id, application_id, sender, subject, category, received_at, created_at) VALUES ('mail_report_1','gmail_report_1','app_report_2','jobs@beta.test','Application received','acknowledgement',?,?)",
  [at4, at4],
);
db.run(
  "INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at) VALUES ('doc_report_1','u_static_admin','tailored_cv','CV.pdf','CV.pdf','application/pdf','documents/CV.pdf',100,?)",
  [at],
);
db.run(
  "INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at) VALUES ('doc_report_2','u_static_admin','cover_letter','Cover.pdf','Cover.pdf','application/pdf','documents/Cover.pdf',100,?)",
  [at],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, error, created_at, finished_at) VALUES ('task_report_1','cv','Tailor CV','failed','Quality gate failed',?,?)",
  [at, at],
);
db.run(
  "INSERT INTO tasks (id, agent_key, title, status, created_at) VALUES ('task_report_2','application','Submit package','queued',?)",
  [at],
);
db.run(
  "INSERT INTO recruitment_runs (id, run_key, trigger, status, error, created_at, finished_at) VALUES ('run_report_failed','2026-11-20#failed','manual','failed','Controlled failure',?,?)",
  [at, at],
);

test("daily report counts only persisted evidence and produces each required section", () => {
  const content = email.buildDailyRecruitmentReportEmail(now);
  assert.equal(content.subject, "AT AI Workforce | Recruitment Activity Report | 20 Nov 2026");
  assert.match(content.text, /1\. Executive summary/);
  assert.match(content.text, /Jobs discovered: 2/);
  assert.match(content.text, /Jobs analysed: 2/);
  assert.match(content.text, /Suitable matches: 2/);
  assert.match(content.text, /Documents generated: 2/);
  assert.match(content.text, /Applications successfully submitted: 2/);
  assert.match(content.text, /Employer confirmations received: 1/);
  assert.match(content.text, /2\. Successfully submitted applications/);
  assert.match(content.text, /3\. Employer confirmations/);
  assert.match(content.text, /4\. Pending work/);
  assert.match(content.text, /5\. Failed tasks/);
  assert.match(content.text, /6\. Agent activity/);
  assert.match(content.text, /7\. Next actions/);
  assert.match(content.text, /Data note: 1 legacy application/);
  assert.match(content.text, /No blind retry/);
  assert.match(content.text, /Automated report from AT AI Workforce/);
  for (const identity of ["Chief", "Saffa", "Ali", "Kora", "Kali", "Amira", "Noor", "Rayna", "Chief Coordinator / Orchestrator", "Job Research Agent / Discovery", "Job Analysis Agent / Matching", "CV Optimisation Agent / Documents", "ATS Quality Control Agent", "Application Agent / Cover Letter & Documents", "Application Agent / Submission", "Email & Tracking Agent"]) {
    assert.match(content.text, new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `plain text is missing ${identity}`);
    assert.match(content.html, new RegExp(identity.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `HTML is missing ${identity}`);
  }
  assert.doesNotMatch(content.text, /##/);
  assert.match(content.text, /Best regards,\nChief\nChief Coordinator \/ Orchestrator\nAT AI Workforce/);
  assert.match(content.text, /Kora \(cv\)/);
  assert.match(content.text, /Noor \(application\)/);
  assert.match(content.html, /Best regards,/);
  assert.match(content.html, /Kora \(cv\)/);
  assert.match(content.html, /Noor \(application\)/);
});

test("HTML report is branded, responsive, escaped and includes the inline logo", () => {
  const content = email.buildDailyRecruitmentReportEmail(now);
  assert.match(content.html, /AT AI WORKFORCE/);
  assert.match(content.html, /Your Recruitment Activity Report/);
  assert.match(content.html, /src="cid:atw-logo"/);
  assert.match(content.html, /background:#0a2540/);
  assert.match(content.html, /@media only screen and \(max-width:600px\)/);
  assert.match(content.html, /Acme &lt;script&gt;/);
  assert.doesNotMatch(content.html, /Acme <script>/);
  assert.doesNotMatch(content.html, /##/);
  assert.match(content.html, /Employer email confirmation/);
  assert.match(content.html, /ATS \/ endpoint receipt/);
});

test("the daily report identifies task owners by display name and keeps the key for traceability", () => {
  const content = email.buildDailyRecruitmentReportEmail(now);
  assert.match(content.text, /Kora \(cv\).*Tailor CV/);
  assert.match(content.text, /Noor \(application\).*Submit package/);
  assert.doesNotMatch(content.text, /^- cv ·/m);
  assert.doesNotMatch(content.text, /^- application ·/m);
});

test("MIME message carries plain text, HTML and an inline JPEG logo", () => {
  const content = email.renderNotificationEmail({
    subject: "AT AI Workforce | Test",
    body: "Controlled notification body.",
  });
  const result = mime.buildEmailMime({
    from: "notifications@example.test",
    to: "owner@example.test",
    subject: content.subject,
    text: content.text,
    html: content.html,
  });
  assert.equal(result.usedLogo, true);
  const raw = mime.decodeMime(result.raw);
  assert.match(raw, /multipart\/related/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /text\/plain/);
  assert.match(raw, /text\/html/);
  assert.match(raw, /Content-ID: <atw-logo>/);
  assert.match(raw, /image\/jpeg/);
  assert.doesNotMatch(raw, /data:image/);
});
