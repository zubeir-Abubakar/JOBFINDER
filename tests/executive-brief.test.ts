import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-executive-brief-"));
process.env.APP_SECRET_KEY = "executive-brief-test-secret";
process.env.APP_BASE_URL = "https://atw.example.test";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const brief = await import("../lib/executive-brief.ts");
const notifications = await import("../lib/notify.ts");
const mime = await import("../lib/email-mime.ts");
const schedule = await import("../lib/recruitment-schedule.ts");

db.getDb();
notifications.stopNotificationQueue();
db.run(
  `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, 'owner@example.test', 'fixture', NULL, '2030-01-01T00:00:00.000Z', 'gmail.send', '2026-11-20T00:00:00.000Z')`,
);

const now = new Date("2026-11-20T17:00:00+01:00");
const at = "2026-11-20T08:10:00.000Z";
const completedAt = "2026-11-20T09:30:00.000Z";
const submittedAt = "2026-11-20T09:50:00.000Z";

db.run("UPDATE profiles SET email = ?, full_name = ? WHERE id = 1", ["owner@example.test", "Test Owner"]);
db.run(
  "INSERT INTO workflows (id, kind, label, status, created_at, finished_at) VALUES ('wf_brief','autonomous_recruitment','Executive brief fixture','completed',?,?)",
  [at, completedAt],
);
db.run(
  `INSERT INTO recruitment_runs
     (id, run_key, workflow_id, scheduled_for, trigger, status, state_history, started_at, finished_at,
      jobs_discovered, jobs_duplicates, jobs_filtered, jobs_eligible, jobs_qualified, packages_prepared,
      applications_submitted, applications_unverified, applications_intervention, failures, warnings, report, created_at)
   VALUES ('run_brief','2026-11-20#scheduled','wf_brief',?,'schedule','completed','[]',?,?,3,1,4,2,2,1,1,1,1,0,1,?,?)`,
  [at, at, completedAt, "Fixture run completed with one warning.", at],
);

const jobs: Array<[string, string, string, string, number, number, string, string]> = [
  ["job_brief_1", "Senior QA Automation Engineer", "Fixture Alpha AG", "Zurich", 92, 1, "ready_to_submit", "https://fixture.test/1"],
  ["job_brief_2", "QA Lead", "Acme <script>alert(1)</script>", "Bern", 88, 1, "human_intervention_required", "https://fixture.test/2"],
  ["job_brief_3", "Junior Tester", "Fixture Gamma AG", "Geneva", 70, 0, "rejected", "https://fixture.test/3"],
];
for (const [id, title, company, location, score, qualified, status, url] of jobs) {
  db.run(
    `INSERT INTO jobs (id, source, source_platform, external_id, title, company, location, discovered_at, status,
       match_score, qualified, analysis, application_url, url, published_at)
     VALUES (?, 'fixture', 'Fixture', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    [id, id, title, company, location, at, status, score, qualified, url, url, at],
  );
}
// An older record must not leak into the daily period.
db.run(
  `INSERT INTO jobs (id, source, title, company, location, discovered_at, status, match_score, qualified, analysis)
   VALUES ('job_brief_old','fixture','Old Role','Old Co','Basel','2026-11-18T08:00:00.000Z','rejected',60,0,'{}')`,
);

db.run(
  `INSERT INTO applications (id, job_id, status, submission_status, submitted_at, confirmation_ref, method, last_update, created_at)
   VALUES ('app_brief_1','job_brief_1','submitted','verified',?,'TEST-REF-1','candidate_form',?,?)`,
  [submittedAt, submittedAt, at],
);
db.run(
  `INSERT INTO applications (id, job_id, status, readiness, last_update, created_at)
   VALUES ('app_brief_2','job_brief_2','human_intervention_required',?,?,?)`,
  [JSON.stringify({ ready: false, state: "blocked", reasons: ["A legal declaration needs a verified answer."] }), completedAt, at],
);
db.run(
  `INSERT INTO applications (id, job_id, status, readiness, last_update, created_at)
   VALUES ('app_brief_3','job_brief_3','ready_to_submit',?,?,?)`,
  [JSON.stringify({ ready: true, state: "ready_for_submission", reasons: [] }), completedAt, at],
);
db.run(
  `INSERT INTO applications (id, job_id, status, submission_status, last_update, created_at)
   VALUES ('app_brief_4','job_brief_old','submission_unverified','unverified',?,?)`,
  [completedAt, at],
);

db.run(
  `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, status, http_status, reference, evidence, attempted_at)
   VALUES ('sub_brief_1','app_brief_1','job_brief_1','run_brief','candidate_form','verified',200,'TEST-REF-1','{"source":"fixture"}',?)`,
  [submittedAt],
);
db.run(
  `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, status, error, attempted_at)
   VALUES ('sub_brief_2','app_brief_4','job_brief_old','run_brief','candidate_form','unverified','No reference returned',?)`,
  [completedAt],
);
db.run(
  `INSERT INTO application_interventions (id, application_id, job_id, field, question, reason, kind, status, created_at)
   VALUES ('int_brief_1','app_brief_2','job_brief_2','declaration','Do you require visa sponsorship?','The stored profile does not authorize an answer.','question','open',?)`,
  [completedAt],
);

for (const key of ["coordinator", "research", "analysis", "cv", "cover", "ats", "application"] as const) {
  db.run(
    `INSERT INTO recruitment_run_agents (run_id, agent_key, assignment, status, output, coordinator_decision, execution_mode, created_at, finished_at)
     VALUES ('run_brief', ?, ?, 'completed', ?, 'Reconciled by the Coordinator.', 'deterministic', ?, ?)`,
    [key, `${key} fixture assignment`, `${key} fixture output`, at, completedAt],
  );
}
db.run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, output, created_at, started_at, finished_at)
   VALUES ('task_brief_1','wf_brief','cv','Tailor CV','completed','Fixture CV generated.',?,?,?)`,
  [at, at, completedAt],
);
db.run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, output, created_at, started_at, finished_at)
   VALUES ('task_brief_2','wf_brief','application','Submit verified package','completed','Fixture submission verified.',?,?,?)`,
  [at, at, submittedAt],
);
db.run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, error, created_at, started_at, finished_at)
   VALUES ('task_brief_3','wf_brief','research','Read fixture source','failed','Fixture source timeout',?,?,?)`,
  [at, at, completedAt],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at, run_id)
   VALUES ('doc_brief_1','u_fixture','tailored_cv','CV.pdf','CV.pdf','application/pdf','documents/CV.pdf',100,?,'run_brief')`,
  [completedAt],
);
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, created_at, run_id)
   VALUES ('doc_brief_2','u_fixture','cover_letter','Cover.pdf','Cover.pdf','application/pdf','documents/Cover.pdf',100,?,'run_brief')`,
  [completedAt],
);
db.run(
  `INSERT INTO schedule_jobs (key, label, time, timezone, enabled, next_run_at, updated_at)
   VALUES ('daily_recruitment','Daily autonomous recruitment','10:00','Europe/Zurich',1,?,?)`,
  [completedAt, at],
);

test("the daily brief is built from authoritative records and follows the required section order", () => {
  const content = brief.buildExecutiveBriefEmail(now);
  assert.equal(content.subject, "AT Workforce | Daily Executive Brief | 20 Nov 2026");
  assert.equal(content.period.key, "2026-11-20");
  assert.equal(content.dashboardUrl, "https://atw.example.test/dashboard");

  const labels = [
    "01 · DAILY EXECUTIVE BRIEF",
    "02 · EXECUTIVE SUMMARY",
    "03 · WORKFORCE PERFORMANCE METRICS",
    "04 · AGENT-BY-AGENT ACTIVITY",
    "05 · COMPLETED TASKS AND ACHIEVEMENTS",
    "06 · BLOCKED EXCEPTIONS AND INVESTIGATIONS",
    "07 · COORDINATOR'S ASSESSMENT",
    "08 · NEXT OPERATIONAL PRIORITIES",
    "09 · DASHBOARD ACCESS",
    "10 · COORDINATOR SIGNATURE",
  ];
  const positions = labels.map((label) => content.text.indexOf(label));
  assert.ok(positions.every((position) => position >= 0), "every required text section is present");
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sections are in the required order");
  assert.doesNotMatch(content.text, /##/);

  assert.match(content.text, /Jobs discovered: 3/);
  assert.match(content.text, /Jobs qualified: 2/);
  assert.match(content.text, /Submitted \+ verified: 1/);
  assert.match(content.text, /Applications blocked: 2/);
  assert.match(content.text, /Applications pending: 1/);
  assert.match(content.text, /Agents reporting: 7 \/ 8/);
  assert.match(content.text, /Completed tasks recorded: 2/);
  assert.match(content.text, /Fixture source timeout/);
  assert.match(content.text, /Do you require visa sponsorship\?/);
  assert.match(content.text, /Confirm with the employer before any retry/);
  assert.match(content.text, /Recorded submission error/i);

  assert.equal(content.data.run?.id, "run_brief");
  assert.equal(content.data.reportingAgents, 7);
  assert.equal(content.data.registeredAgents, 8);
  assert.ok(content.data.reconciliationNotes.some((note) => /Rayna/.test(note)));
  assert.equal(content.data.assessmentState, "attention_required");
  assert.equal(content.data.metrics.find((metric) => metric.key === "agents")?.display, "7 / 8");
  assert.ok(content.data.achievements.some((item) => /verified employer evidence/i.test(item)));
  assert.ok(content.data.priorities.some((item) => /blocked application/i.test(item)));
  assert.match(content.text, /https:\/\/atw\.example\.test\/dashboard/);

  const identities = ["Chief", "Saffa", "Ali", "Kora", "Kali", "Amira", "Noor", "Rayna", "Chief Coordinator / Orchestrator", "Job Research Agent / Discovery", "Job Analysis Agent / Matching", "CV Optimisation Agent / Documents", "ATS Quality Control Agent", "Application Agent / Cover Letter & Documents", "Application Agent / Submission", "Email & Tracking Agent"];
  for (const agent of identities) {
    assert.match(content.text, new RegExp(agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `plain text is missing ${agent}`);
    assert.match(content.html, new RegExp(agent.replace(/&/g, "&amp;").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `HTML is missing ${agent}`);
  }
});

test("the HTML is branded, responsive, escaped and contains the working dashboard link", () => {
  const content = brief.buildExecutiveBriefEmail(now);
  assert.match(content.html, /background:#0a2540/);
  assert.match(content.html, /#c6a15b/);
  assert.match(content.html, /font-family:Georgia/);
  assert.match(content.html, /src="cid:atw-logo"/);
  assert.match(content.html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(content.html, /@media only screen and \(max-width:600px\)/);
  assert.match(content.html, /table-layout:fixed/);
  assert.match(content.html, /class="metric-cell"/);
  assert.match(content.html, /https:\/\/atw\.example\.test\/dashboard/);
  assert.match(content.html, /Open AT AI Workforce dashboard/);
  assert.match(content.html, /Hi|Hello|Dear/);
  assert.match(content.html, /Chief/);
  assert.match(content.html, /Chief Coordinator \/ Orchestrator/);
  assert.match(content.html, /Blocked exceptions and investigations/i);
  assert.match(content.html, /Next operational priorities/i);
  assert.match(content.html, /Acme &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(content.html, /Acme <script>/);
  assert.doesNotMatch(content.html, /localhost/i);
  assert.doesNotMatch(content.html, /GOOGLE_CLIENT_SECRET|APP_SECRET_KEY|refresh_token/i);
});

test("an empty period is reported as missing execution data, not fabricated activity", () => {
  const content = brief.buildExecutiveBriefEmail(new Date("2026-11-22T12:00:00+01:00"));
  assert.match(content.text, /No recruitment execution was recorded for this reporting period/);
  assert.match(content.text, /not evidence that the workforce performed zero work/);
  assert.match(content.text, /No completion is asserted/);
  assert.match(content.text, /Agents reporting: No run/);
  assert.match(content.text, /No execution record to reconcile/);
  assert.match(content.text, /No verified achievement was recorded/);
  assert.doesNotMatch(content.text, /All 8 registered agents/);
});

test("MIME carries both the plain text and responsive HTML parts", () => {
  const content = brief.buildExecutiveBriefEmail(now);
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
});

test("the Coordinator queues exactly one persisted copy per local day", async () => {
  const first = await brief.sendDailyExecutiveBrief({ now, baseUrl: "https://atw.example.test" });
  assert.equal(first.status, "queued");
  assert.equal(first.emailQueued, true);
  notifications.stopNotificationQueue();
  const second = await brief.sendDailyExecutiveBrief({ now, baseUrl: "https://atw.example.test" });
  assert.equal(second.status, "duplicate");
  assert.equal(second.emailQueued, false);
  assert.equal(
    Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE kind = 'daily_executive_brief'")?.c),
    1,
  );
  assert.equal(
    Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM notification_outbox WHERE kind = 'daily_executive_brief'")?.c),
    1,
  );
  assert.equal(
    db.one<{ dedupe_key: string }>("SELECT dedupe_key FROM notification_outbox WHERE kind = 'daily_executive_brief'")?.dedupe_key,
    "executive_brief:2026-11-20",
  );
  const sent = await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "brief-test-id", threadId: "brief-test-thread" }),
  });
  assert.equal(sent.sent, 1);
  const history = brief.executiveBriefHistory();
  assert.equal(history[0]?.delivery_status, "accepted_by_gmail");
  assert.equal(history[0]?.provider_message_id, "brief-test-id");
  notifications.stopNotificationQueue();
});

test("a missing dashboard URL omits the CTA but does not block the brief", async () => {
  const result = await brief.sendDailyExecutiveBrief({
    now: new Date("2026-11-26T12:00:00+01:00"),
    baseUrl: null,
  });
  assert.equal(result.status, "queued");
  assert.equal(result.emailQueued, true);
  const row = db.one<{ html_body: string; body: string; report_id: string }>(
    "SELECT html_body, body, report_id FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-26'",
  );
  assert.doesNotMatch(row?.html_body ?? "", /https?:\/\/(?:localhost|127\.0\.0\.1)|\.local(?=[/:])/i);
  assert.doesNotMatch(row?.body ?? "", /https?:\/\/(?:localhost|127\.0\.0\.1)/i);
  assert.match(row?.body ?? "", /Dashboard link unavailable/);
  assert.equal(row?.report_id, "brief:2026-11-26");
  notifications.stopNotificationQueue();
  await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "brief-no-url-id", threadId: "brief-no-url-thread" }),
  });
  const history = brief.executiveBriefHistory();
  assert.equal(history[0]?.delivery_state, "accepted_by_gmail");
  notifications.stopNotificationQueue();
});

test("the Europe/Zurich schedule advances one brief per day and handles DST", async () => {
  const localMorning = new Date("2026-11-20T08:00:00+01:00");
  const row = brief.ensureExecutiveBriefSchedule(localMorning);
  assert.equal(row.time, "17:00");
  assert.equal(row.timezone, "Europe/Zurich");
  const first = brief.executiveBriefScheduleSnapshot(localMorning);
  assert.equal(first.next_run_at, "2026-11-20T16:00:00.000Z");

  const tick = await brief.tickExecutiveBriefSchedule(new Date("2026-11-20T17:01:00+01:00"));
  assert.equal(tick.status, "duplicate", "the already queued 20 Nov brief is not sent twice");
  assert.equal(tick.nextRunAt, "2026-11-21T16:00:00.000Z");

  const nextDay = await brief.tickExecutiveBriefSchedule(new Date("2026-11-21T17:01:00+01:00"));
  assert.equal(nextDay.status, "queued");
  notifications.stopNotificationQueue();
  await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "brief-schedule-id", threadId: "brief-schedule-thread" }),
  });
  notifications.stopNotificationQueue();

  const dst = schedule.nextDailyRun(new Date("2026-10-24T16:00:00Z"), {
    time: "17:00",
    timeZone: "Europe/Zurich",
  });
  assert.equal(dst.toISOString(), "2026-10-25T16:00:00.000Z");
});

test("a failed brief delivery is retried through the durable outbox", async () => {
  const retryNow = new Date("2026-11-27T12:00:00+01:00");
  const result = await brief.sendDailyExecutiveBrief({ now: retryNow, baseUrl: "https://atw.example.test" });
  assert.equal(result.status, "queued");
  notifications.stopNotificationQueue();

  const first = await notifications.drainNotificationQueue({
    send: async () => {
      throw new Error("temporary transport outage");
    },
    now: new Date("2026-11-27T12:01:00+01:00"),
    limit: 1,
  });
  assert.equal(first.retryScheduled, 1);
  const retry = db.one<{ status: string; attempts: number; last_error: string }>(
    "SELECT status, attempts, last_error FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-27'",
  );
  assert.equal(retry?.status, "retry_scheduled");
  assert.equal(retry?.attempts, 1);
  assert.match(retry?.last_error ?? "", /temporary transport outage/);

  db.run(
    "UPDATE notification_outbox SET available_at = ? WHERE dedupe_key = 'executive_brief:2026-11-27'",
    [new Date("2026-11-27T12:02:00+01:00").toISOString()],
  );
  const second = await notifications.drainNotificationQueue({
    send: async () => ({ messageId: "brief-retry-id", threadId: "brief-retry-thread" }),
    now: new Date("2026-11-27T12:03:00+01:00"),
    limit: 1,
  });
  assert.equal(second.sent, 1);
  const sent = db.one<{ status: string; provider_message_id: string }>(
    "SELECT status, provider_message_id FROM notification_outbox WHERE dedupe_key = 'executive_brief:2026-11-27'",
  );
  assert.equal(sent?.status, "sent");
  assert.equal(sent?.provider_message_id, "brief-retry-id");
  notifications.stopNotificationQueue();
});

test("the owner report surface is admin-protected and never prints provider secrets", () => {
  const page = readFileSync("app/admin/email/page.tsx", "utf8");
  assert.match(page, /await requireAdmin\(\)/);
  assert.match(page, /executiveBriefHistory/);
  assert.match(page, /executiveBriefScheduleSnapshot/);
  const content = brief.buildExecutiveBriefEmail(now);
  assert.doesNotMatch(content.text + content.html, /GOOGLE_CLIENT_SECRET|GOOGLE_CLIENT_ID|APP_SECRET_KEY|refresh_token/i);
});

test.after(() => {
  notifications.stopNotificationQueue();
  db.closeDb();
});
