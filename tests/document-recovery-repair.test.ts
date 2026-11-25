import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import mammoth from "mammoth";

/**
 * Synthetic full-pipeline check for a failed cover letter.
 *
 * The validated CV is deliberately created by the real package generator, then
 * its cover letter is failed and the durable recovery queue is run. Recovery
 * must reuse the CV, create a new cover version, validate both files, render and
 * link the package, and leave it unsubmitted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-document-recovery-"));
process.env.APP_SECRET_KEY = "document-recovery-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");
const recovery = await import("../lib/recruitment-recovery.ts");

db.getDb();
db.run("INSERT OR IGNORE INTO profiles (id) VALUES (1)");
db.run(
  "UPDATE profiles SET full_name = ?, headline = ?, email = ?, phone = ?, location = ?, work_authorisation = ? WHERE id = 1",
  [
    "Ada Lovelace",
    "Senior QA Automation Engineer",
    "ada@example.test",
    "+41 79 000 00 00",
    "Zürich",
    "Swiss Permit B — authorised to work without employer sponsorship",
  ],
);
for (const [name, category, level] of [
  ["Playwright", "Automation", "advanced"],
  ["Cypress", "Automation", "advanced"],
  ["API testing", "Testing", "advanced"],
  ["release readiness", "Testing", "advanced"],
] as const) {
  db.run(
    "INSERT INTO skills (name, category, level, verified, source, sort) VALUES (?, ?, ?, 1, 'manual', 1)",
    [name, category, level],
  );
}
db.run(
  "INSERT INTO experiences (company, title, location, start_date, is_current, summary, achievements, sort) VALUES (?, ?, ?, ?, 1, ?, ?, 1)",
  [
    "Swiss Payments AG",
    "Senior QA Engineer",
    "Zürich",
    "2020-01",
    "Own test automation, API quality and release readiness for payment products.",
    JSON.stringify(["Built Playwright suites covering 120 payment scenarios and reduced release defects by 30%."]),
  ],
);

const MASTER_TEXT = [
  "Ada Lovelace",
  "Senior QA Automation Engineer",
  "Zürich | ada@example.test | +41 79 000 00 00",
  "Swiss Permit B — authorised to work without employer sponsorship",
  "PROFESSIONAL SUMMARY",
  "Senior QA engineer with fintech payments, mobile and API test automation experience. I combine hands-on Playwright and TypeScript delivery with release-risk analysis, evidence-based quality gates and clear reporting for engineering and product stakeholders.",
  "TECHNICAL SKILLS",
  "Automation: Playwright, Cypress, Selenium",
  "Testing: API testing, Regression testing, Release readiness",
  "Technical: TypeScript, CI/CD, Jira",
  "PROFESSIONAL EXPERIENCE",
  "Senior QA Engineer Jan 2020 – Present",
  "Swiss Payments AG, Zürich",
  "• Built Playwright suites that covered 120 payment scenarios and reduced release defects by 30%.",
  "• Led API regression testing across 4 releases and cut feedback time from 3 days to 1 day.",
  "• Introduced release-readiness evidence that gave engineering and product teams a clear go/no-go decision.",
  "• Kept release evidence traceable for audit and stakeholder review across web and mobile products.",
  "QA Engineer Mar 2017 – Dec 2019",
  "Mobile Money Ltd, Zürich",
  "• Automated 80 mobile regression cases with Cypress and reduced manual test time by 25%.",
  "• Worked with engineering teams on defect triage and quality gates for 6 releases.",
  "• Documented risk-based test plans and kept evidence available for product sign-off.",
  "QA Engineer Jun 2014 – Feb 2017",
  "Cloud Retail AG, Zürich",
  "• Built Selenium regression suites for 70 checkout flows and reduced escaped defects by 18%.",
  "• Coordinated release testing across web and mobile teams for 8 releases.",
  "• Supported product sign-off with clear evidence and proportionate release recommendations.",
  "CERTIFICATIONS",
  "ISTQB Certified Tester",
  "EDUCATION",
  "BSc Computer Science — University of Example 2016",
  "LANGUAGES",
  "English (C1) | French (B2)",
].join("\n");

mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "master-cv.pdf"), "%PDF-1.4 fixture master CV");
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_master_recovery', 'system', 'original_cv', 'Master CV', 'master-cv.pdf', 'application/pdf', 'master-cv.pdf', 80, 'ready', ?, ?)`,
  [MASTER_TEXT, new Date().toISOString()],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_master_recovery'");

const now = new Date();
const jobId = "job_recovery_synthetic";
db.run(
  `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, url, application_url,
     description, published_at, discovered_at, status, dedupe_key, match_score, analysis, eligibility, qualified)
   VALUES (?, 'manual', 'recovery-synthetic', 'Senior Agile Test Engineer', 'Synthetic Employer AG', 'Bern, Switzerland',
     0, 'Full-time', 'https://recovery.example/job', 'https://recovery.example/apply', ?, ?, ?, 'shortlisted',
     'recovery-synthetic', 95, NULL, 'eligible', 1)`,
  [
    jobId,
    [
      "We are hiring a senior agile test engineer with 5+ years of software testing experience.",
      "You will own end-to-end testing, integration testing, Playwright automation, API testing and release readiness.",
      "You will lead risk-based test planning and provide evidence for go/no-go decisions.",
      "English is required; the candidate holds Swiss work authorisation.",
    ].join(" "),
    now.toISOString(),
    now.toISOString(),
  ],
);

const run = agents.createWorkflow("documents", "Document recovery test", "system");
const runId = `run_document_recovery_${Date.now()}`;
db.run(
  `INSERT INTO recruitment_runs (id, run_key, workflow_id, trigger, status, created_at, jobs_discovered, jobs_duplicates, jobs_filtered, jobs_eligible, jobs_qualified)
   VALUES (?, ?, ?, 'manual', 'preparing_applications', ?, 1, 0, 0, 1, 1)`,
  [runId, `document-recovery#${Date.now()}`, run, now.toISOString()],
);
db.run("UPDATE jobs SET run_id = ? WHERE id = ?", [runId, jobId]);

const initial = await agents.generateApplicationPackage("system", jobId, { workflowId: run });
assert.equal(initial.ok, true, initial.message);
assert.ok(initial.applicationId);
const cvBefore = db.one<{ id: string }>(
  "SELECT id FROM documents WHERE job_id = ? AND kind = 'tailored_cv' AND mime = 'application/pdf' AND quality_status = 'passed'",
  [jobId],
);
const oldCover = db.one<{ id: string }>(
  "SELECT id FROM documents WHERE job_id = ? AND kind = 'cover_letter' AND mime = 'application/pdf' AND quality_status = 'passed'",
  [jobId],
);
assert.ok(cvBefore && oldCover);

// Recreate the historical failure: the old cover is failed, the application is
// awaiting documents, and the durable recovery row is due for a retry.
db.run("UPDATE documents SET quality_status = 'failed', quality_score = 80, status = 'blocked' WHERE id = ?", [oldCover!.id]);
db.run("UPDATE documents SET quality_score = 0 WHERE job_id = ? AND kind = 'cover_letter' AND id <> ?", [jobId, oldCover!.id]);
db.run("UPDATE applications SET cover_letter_id = NULL, status = 'awaiting_documents', readiness = NULL WHERE id = ?", [initial.applicationId]);
const recoveryId = "rec_document_recovery_synthetic";
db.run(
  `INSERT INTO recruitment_recovery
     (id, dedupe_key, run_id, job_id, application_id, stage, status, attempts, available_at, last_error, created_at)
   VALUES (?, ?, ?, ?, ?, 'documents', 'retry_scheduled', 0, ?, ?, ?)`,
  [
    recoveryId,
    `documents:${runId}:${jobId}`,
    runId,
    jobId,
    initial.applicationId,
    new Date().toISOString(),
    "Quality control rejected the cover letter: too short.",
    new Date().toISOString(),
  ],
);

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("recovery reuses the validated CV, writes a new validated cover and keeps the package unsubmitted", async () => {
  const result = await recovery.processRecoveryQueue({
    now: new Date(),
    prepare: (id, workflowId, resumeStage) =>
      agents.generateApplicationPackage("system", id, { workflowId: workflowId ?? undefined, resumeStage }),
  });
  assert.equal(result.completed, 1, JSON.stringify(result));

  const row = db.one<{
    status: string;
    application_id: string | null;
    attempts: number;
    last_error: string | null;
    finished_at: string | null;
  }>("SELECT status, application_id, attempts, last_error, finished_at FROM recruitment_recovery WHERE id = ?", [recoveryId]);
  assert.ok(row);
  assert.equal(row!.status, "completed");
  assert.equal(row!.application_id, initial.applicationId);
  assert.equal(row!.attempts, 1);
  assert.equal(row!.last_error, null);
  assert.ok(row!.finished_at);

  const app = db.one<{
    id: string;
    status: string;
    cv_document_id: string;
    cover_letter_id: string;
    submission_status: string | null;
    submitted_at: string | null;
  }>("SELECT id, status, cv_document_id, cover_letter_id, submission_status, submitted_at FROM applications WHERE id = ?", [
    initial.applicationId,
  ]);
  assert.ok(app);
  assert.equal(app!.cv_document_id, cvBefore!.id, "the validated CV is reused");
  assert.notEqual(app!.cover_letter_id, oldCover!.id, "the failed cover is not relinked");
  assert.equal(app!.status, "quality_check");
  assert.equal(app!.submission_status, null);
  assert.equal(app!.submitted_at, null);

  const newCover = db.one<{
    id: string;
    version: string;
    quality_status: string;
    quality_score: number;
    quality_report: string;
    text_content: string;
    relative_path: string;
    size_bytes: number;
  }>("SELECT id, version, quality_status, quality_score, quality_report, text_content, relative_path, size_bytes FROM documents WHERE id = ?", [
    app!.cover_letter_id,
  ]);
  assert.ok(newCover);
  assert.equal(newCover!.quality_status, "passed");
  assert.equal(newCover!.quality_score, 100);
  assert.equal(newCover!.version, "2.0");
  const quality = JSON.parse(newCover!.quality_report) as { coverLetter?: { actualWords: number; renderedBodyVerified: boolean } };
  assert.ok((quality.coverLetter?.actualWords ?? 0) >= 180);
  assert.equal(quality.coverLetter?.renderedBodyVerified, true);
  assert.match(newCover!.text_content, /Synthetic Employer AG/);

  const old = db.one<{ quality_status: string; status: string }>("SELECT quality_status, status FROM documents WHERE id = ?", [
    oldCover!.id,
  ]);
  assert.equal(old?.quality_status, "failed", "the old failed cover remains as evidence");
  assert.equal(old?.status, "blocked", "the old failed cover is not promoted");

  const cv = db.one<{ status: string }>("SELECT status FROM documents WHERE id = ?", [cvBefore!.id]);
  assert.equal(cv?.status, "ready", "only the selected validated CV is promoted");

  const attached = db.all<{ mime: string; relative_path: string }>(
    "SELECT mime, relative_path FROM documents WHERE id IN (?, ?)",
    [app!.cv_document_id, app!.cover_letter_id],
  );
  for (const doc of attached) {
    const bytes = readFileSync(join(db.UPLOAD_DIR, doc.relative_path));
    assert.ok(bytes.length > 0);
    if (doc.mime === "application/pdf") {
      const pdf = await PDFDocument.load(bytes);
      assert.ok(pdf.getPageCount() >= 1);
    } else {
      const text = await mammoth.extractRawText({ buffer: bytes });
      assert.match(text.value, /Ada Lovelace|Synthetic Employer AG/);
    }
  }
  assert.equal(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", [jobId])?.c, 0);

  const trace = db.one<{ agent_key: string; status: string; output: string }>(
    "SELECT agent_key, status, output FROM recruitment_run_agents WHERE run_id = ? ORDER BY rowid DESC LIMIT 1",
    [runId],
  );
  assert.equal(trace?.agent_key, "cover");
  assert.equal(trace?.status, "completed");
  assert.match(trace?.output ?? "", /nothing was submitted|normal ATS/i);
});

test("a stale processing lease is reclaimed and completed without regenerating validated documents", async () => {
  const staleId = "rec_document_recovery_stale";
  const oldStart = new Date(Date.now() - 20 * 60_000).toISOString();
  db.run(
    `INSERT INTO recruitment_recovery
       (id, dedupe_key, run_id, job_id, application_id, stage, status, attempts, available_at, last_error, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'documents', 'processing', 2, ?, 'worker died after claim', ?, ?)`,
    [staleId, `documents:${runId}:${jobId}:stale`, runId, jobId, initial.applicationId, oldStart, oldStart, oldStart],
  );
  let prepareCalls = 0;
  const now = new Date();
  const result = await recovery.processRecoveryQueue({
    now,
    prepare: async () => {
      prepareCalls += 1;
      throw new Error("validated documents must be reused after a stale lease is reclaimed");
    },
  });
  assert.equal(result.completed, 1, JSON.stringify(result));
  assert.equal(prepareCalls, 0, "the existing validated package is not regenerated");
  const row = db.one<{ status: string; attempts: number; started_at: string; last_error: string | null }>(
    "SELECT status, attempts, started_at, last_error FROM recruitment_recovery WHERE id = ?",
    [staleId],
  );
  assert.equal(row?.status, "completed");
  assert.equal(row?.attempts, 3);
  assert.equal(row?.last_error, null);
  assert.ok(Date.parse(row?.started_at ?? "") >= now.getTime() - 1_000, "the reclaimed row gets a fresh execution lease");
});
