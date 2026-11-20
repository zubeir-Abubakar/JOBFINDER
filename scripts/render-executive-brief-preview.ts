/**
 * Render a clearly-labelled sample of the Coordinator's daily executive brief.
 *
 * This script uses an isolated temporary database and a `.test` dashboard
 * origin. It never imports the live workspace data and never enqueues or sends
 * an email. Run:
 *
 *   npx tsx scripts/render-executive-brief-preview.ts
 *
 * Outputs:
 *   artifacts/executive-brief-preview.html
 *   artifacts/executive-brief-preview-page.html
 *   artifacts/executive-brief-preview.txt
 *   artifacts/executive-brief-preview.json
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-brief-preview-"));
process.env.APP_BASE_URL = "https://app.example.test";
process.env.APP_SECRET_KEY = "executive-brief-preview-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const { buildExecutiveBriefEmail } = await import("../lib/executive-brief.ts");

db.getDb();

const now = new Date("2026-11-20T17:00:00+01:00");
const at = "2026-11-20T08:10:00.000Z";
const done = "2026-11-20T09:45:00.000Z";

db.run("UPDATE profiles SET email = ?, full_name = ? WHERE id = 1", ["owner@example.test", "Test Owner"]);
db.run(
  `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, 'owner@example.test', 'fixture', NULL, '2030-01-01T00:00:00.000Z', 'gmail.send', '2026-11-20T00:00:00.000Z')`,
);
db.run(
  "INSERT INTO workflows (id, kind, label, status, created_at, finished_at) VALUES ('wf_preview','autonomous_recruitment','TEST DATA preview','completed',?,?)",
  [at, done],
);
db.run(
  `INSERT INTO recruitment_runs
     (id, run_key, workflow_id, scheduled_for, trigger, status, state_history, started_at, finished_at,
      jobs_discovered, jobs_duplicates, jobs_filtered, jobs_eligible, jobs_qualified, packages_prepared,
      applications_submitted, applications_unverified, applications_intervention, failures, warnings, report, created_at)
   VALUES ('run_preview','TEST-DATA-2026-11-20','wf_preview',?,'schedule','completed','[]',?,?,3,12,6,3,3,2,1,0,1,0,2,?,?)`,
  [at, at, done, "TEST DATA preview run.", at],
);

const jobs = [
  ["job_preview_1", "[TEST] Senior QA Automation Engineer", "[TEST] Northstar Payments AG", "Zurich", 94, 1, "submitted"],
  ["job_preview_2", "[TEST] QA Lead", "[TEST] Alpine Ledger AG", "Bern", 89, 1, "human_intervention_required"],
  ["job_preview_3", "[TEST] Test Manager", "[TEST] Helvetic Cloud AG", "Geneva", 86, 1, "ready_to_submit"],
];
for (const [id, title, company, location, score, qualified, status] of jobs) {
  db.run(
    `INSERT INTO jobs (id, source, source_platform, external_id, title, company, location, discovered_at, status,
       match_score, qualified, analysis, application_url, url, published_at)
     VALUES (?, 'fixture', 'TEST fixture', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    [id, id, title, company, location, at, status, score, qualified, `https://${id}.test/apply`, `https://${id}.test/job`, at],
  );
}
db.run(
  `INSERT INTO applications (id, job_id, status, submission_status, submitted_at, confirmation_ref, method, last_update, created_at)
   VALUES ('app_preview_1','job_preview_1','submitted','verified',?,'TEST-REF-2026-001','candidate_form',?,?)`,
  [done, done, at],
);
db.run(
  `INSERT INTO applications (id, job_id, status, readiness, last_update, created_at)
   VALUES ('app_preview_2','job_preview_2','human_intervention_required',?,?,?)`,
  [JSON.stringify({ ready: false, state: "blocked", reasons: ["A legal declaration requires a verified owner answer."] }), done, at],
);
db.run(
  `INSERT INTO applications (id, job_id, status, readiness, last_update, created_at)
   VALUES ('app_preview_3','job_preview_3','ready_to_submit',?,?,?)`,
  [JSON.stringify({ ready: true, state: "ready_for_submission", reasons: [] }), done, at],
);
db.run(
  `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, status, http_status, reference, evidence, attempted_at)
   VALUES ('sub_preview_1','app_preview_1','job_preview_1','run_preview','candidate_form','verified',200,'TEST-REF-2026-001','{"source":"TEST fixture"}',?)`,
  [done],
);
db.run(
  `INSERT INTO application_interventions (id, application_id, job_id, field, question, reason, kind, status, created_at)
   VALUES ('int_preview_1','app_preview_2','job_preview_2','declaration','Do you require visa sponsorship?','The stored profile does not contain a verified answer.','question','open',?)`,
  [done],
);
for (const key of ["coordinator", "research", "analysis", "cv", "cover", "ats", "application", "email"] as const) {
  db.run(
    `INSERT INTO recruitment_run_agents (run_id, agent_key, assignment, status, output, coordinator_decision, execution_mode, created_at, finished_at)
     VALUES ('run_preview', ?, ?, 'completed', ?, 'Reconciled with persisted test records.', 'deterministic', ?, ?)`,
    [key, `TEST ${key} assignment`, `TEST ${key} output recorded.`, at, done],
  );
}
for (const [id, agent, title, output] of [
  ["task_preview_1", "research", "Search configured TEST sources", "3 TEST postings stored; 12 duplicates blocked."],
  ["task_preview_2", "cv", "Tailor CV for [TEST] Northstar", "TEST tailored CV generated."],
  ["task_preview_3", "application", "Submit verified TEST package", "TEST submission verified with reference TEST-REF-2026-001."],
] as const) {
  db.run(
    `INSERT INTO tasks (id, workflow_id, agent_key, title, status, output, created_at, started_at, finished_at)
     VALUES (?, 'wf_preview', ?, ?, 'completed', ?, ?, ?, ?)`,
    [id, agent, title, output, at, at, done],
  );
}
db.run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, error, created_at, started_at, finished_at)
   VALUES ('task_preview_failed','wf_preview','ats','TEST source quality check','failed','TEST fixture warning: one source returned no readable postings.',?,?,?)`,
  [at, at, done],
);
for (const [id, name] of [["doc_preview_1", "CV.pdf"], ["doc_preview_2", "Cover.pdf"]] as const) {
  db.run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at, run_id)
     VALUES (?, 'u_test', ?, ?, ?, 'application/pdf', ?, 100, ?, 'run_preview')`,
    [id, id.endsWith("1") ? "tailored_cv" : "cover_letter", name, name, `documents/${name}`, done],
  );
}
db.run(
  `INSERT INTO schedule_jobs (key, label, time, timezone, enabled, next_run_at, updated_at)
   VALUES ('daily_recruitment','Daily autonomous recruitment','10:00','Europe/Zurich',1,?,?)`,
  ["2026-11-21T09:00:00.000Z", at],
);

const content = buildExecutiveBriefEmail(now);
mkdirSync("artifacts", { recursive: true });
writeFileSync("artifacts/executive-brief-preview.html", content.html);
writeFileSync("artifacts/executive-brief-preview.txt", content.text);
writeFileSync(
  "artifacts/executive-brief-preview.json",
  JSON.stringify(
    {
      note: "TEST DATA only. Generated from an isolated fixture database; no live application or email was used.",
      subject: content.subject,
      period: content.period,
      dashboardUrl: content.dashboardUrl,
      metrics: content.data.metrics,
      reportingAgents: content.data.reportingAgents,
      registeredAgents: content.data.registeredAgents,
      assessment: content.data.assessment,
      achievements: content.data.achievements,
      exceptions: content.data.exceptions,
    },
    null,
    2,
  ),
);

const banner = `<div style="background:#7a2e1f;color:#fff;padding:10px 16px;font:13px/1.5 Arial,sans-serif;text-align:center;">TEST DATA — generated from an isolated fixture database. This is not a live report and no email was sent.</div>`;
// Browsers do not resolve a MIME Content-ID; the preview page embeds the same
// logo bytes while the actual email source keeps its cid reference.
const previewLogo = `data:image/jpeg;base64,${readFileSync("Logo.jpeg").toString("base64")}`;
const previewPage = content.html
  .replace(/src="cid:atw-logo"/g, `src="${previewLogo}"`)
  .replace(/(<body[^>]*>)/i, `$1${banner}`);
writeFileSync("artifacts/executive-brief-preview-page.html", previewPage);

console.log(
  JSON.stringify(
    {
      subject: content.subject,
      dashboardUrl: content.dashboardUrl,
      reportingAgents: `${content.data.reportingAgents}/${content.data.registeredAgents}`,
      blocked: content.data.exceptionCounts.blockedApplications,
      verified: content.data.metrics.find((metric) => metric.key === "submitted")?.display,
      preview: "artifacts/executive-brief-preview-page.html",
      html: "artifacts/executive-brief-preview.html",
      text: "artifacts/executive-brief-preview.txt",
      sent: false,
    },
    null,
    2,
  ),
);
db.closeDb();
