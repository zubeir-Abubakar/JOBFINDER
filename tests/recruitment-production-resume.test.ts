import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 3 production resume.
 *
 * The run is reconstructed from SQLite alone after every document, quality,
 * package and readiness stage completed. The only remaining work is the
 * irreversible submission boundary. The submission dependency is a controlled
 * fixture; no employer or external service is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-production-resume-"));
process.env.APP_SECRET_KEY = "production-resume-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const stages = await import("../lib/recruitment-stages.ts");
const runs = await import("../lib/recruitment-run.ts");
const events = await import("../lib/application-events.ts");
import type { SubmissionOutcome } from "../lib/submission.ts";

db.getDb();

test.after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const now = new Date().toISOString();

db.run(
  "UPDATE profiles SET full_name = 'Ada Lovelace', email = 'ada@example.com', phone = '+41 79 000 00 00', work_authorisation = 'Swiss Permit B — authorised without sponsorship' WHERE id = 1",
);
db.run(
  "INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Playwright', 'Automation & testing', 'advanced', 1, 'manual', 99)",
);
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE settings SET value = 'true' WHERE key = 'autonomous_submission'");
db.run("UPDATE settings SET value = 'false' WHERE key = 'approval_mode'");
db.run("UPDATE settings SET value = '3' WHERE key = 'max_applications_per_day'");
db.run(
  `INSERT INTO settings (key, value, updated_at) VALUES ('standing_authorisation_activated_at', ?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  [JSON.stringify(now), now],
);

const description = [
  "We are hiring a senior quality engineer with 5+ years of software testing experience.",
  "You will own test automation with Playwright and Cypress, build REST API tests and run CI pipelines.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "Swiss work authorisation is required and sponsorship is not offered. English is required.",
].join(" ");

const jobId = "job_production_resume";
const applicationId = "app_production_resume";

db.run(
  `INSERT INTO jobs
     (id, source, external_id, title, company, location, remote, url, application_url, description,
      published_at, discovered_at, status, dedupe_key, match_score, analysis, eligibility,
      eligibility_notes, eligibility_checked_at, qualified, vacancy_status, vacancy_verification, vacancy_verified_at)
   VALUES (?, 'manual', 'production-resume', 'Senior QA Automation Engineer', 'Resume Employer AG',
     'Zürich, Switzerland', 0, 'https://resume.example/job', 'https://resume.example/apply', ?,
     ?, ?, 'shortlisted', 'production-resume-dedupe', 95, '{}', 'eligible', '{}', ?, 1, 'open', '{"status":"open"}', ?)`,
  [jobId, description, now, now, now, now],
);

mkdirDocs();

function mkdirDocs(): void {
  const docs = [
    ["doc_production_resume_cv_pdf", "tailored_cv", "application/pdf", "cv.pdf"],
    ["doc_production_resume_cv_docx", "tailored_cv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cv.docx"],
    ["doc_production_resume_cover_pdf", "cover_letter", "application/pdf", "cover.pdf"],
    ["doc_production_resume_cover_docx", "cover_letter", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "cover.docx"],
  ] as const;
  for (const [id, kind, mime, file] of docs) {
    db.run(
      `INSERT INTO documents
         (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, job_id,
          version, quality_status, quality_score, text_content, run_id, created_at)
       VALUES (?, 'system', ?, ?, ?, ?, ?, 1200, 'ready', ?, '1.0', 'passed', 96, ?, NULL, ?)`,
      [
        id,
        kind,
        `${kind} fixture`,
        file,
        mime,
        file,
        jobId,
        kind === "tailored_cv"
          ? "Ada Lovelace — Senior QA Automation Engineer. Playwright, API testing, release readiness."
          : "Dear Resume Employer AG, I am applying for the Senior QA Automation Engineer role.",
        now,
      ],
    );
  }
}

const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
assert.equal(created.created, true);
const runId = created.run.id;

db.run(
  `UPDATE jobs SET run_id = ?, document_state = 'prepared' WHERE id = ?`,
  [runId, jobId],
);
db.run(
  `UPDATE documents SET run_id = ? WHERE job_id = ?`,
  [runId, jobId],
);
db.run(
  `UPDATE recruitment_runs SET jobs_discovered = 1, jobs_eligible = 1, jobs_qualified = 1, packages_prepared = 1, status = 'preparing_applications' WHERE id = ?`,
  [runId],
);

const readiness = JSON.stringify({
  ready: true,
  state: "ready_for_submission",
  reasons: [],
  items: [],
  checkedAt: now,
  engine: "production-resume-test",
});
db.run(
  `INSERT INTO applications
     (id, job_id, status, cv_document_id, cover_letter_id, method, readiness, readiness_checked_at, last_update, created_at, run_id)
   VALUES (?, ?, 'ready_to_submit', 'doc_production_resume_cv_pdf', 'doc_production_resume_cover_pdf',
     'employer_portal', ?, ?, ?, ?, ?)`,
  [applicationId, jobId, readiness, now, now, now, runId],
);

stages.recordStage({ runId, jobId: "", stage: "discovery", status: "completed", outputRefs: { jobIds: [jobId] } });
for (const stage of [
  "vacancy_validation",
  "eligibility",
  "cv_generation",
  "cv_validation",
  "cover_generation",
  "cover_validation",
  "rendering",
  "package_assembly",
  "readiness",
] as const) {
  stages.recordStage({
    runId,
    jobId,
    stage,
    status: "completed",
    outputRefs: { applicationId, cvDocumentId: "doc_production_resume_cv_pdf", coverDocumentId: "doc_production_resume_cover_pdf" },
    evidence: { reconstructedFrom: "sqlite", stage },
  });
}

function count(table: string): number {
  return Number(db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`, [jobId])?.n ?? 0);
}

function verifiedSubmission(input: { applicationId: string; job: { id: string }; runId?: string | null }): SubmissionOutcome {
  const at = new Date().toISOString();
  db.run(
    `INSERT INTO submission_attempts
       (id, application_id, job_id, run_id, channel, endpoint, status, http_status, reference, evidence, error, attempted_at)
     VALUES ('sub_production_resume', ?, ?, ?, 'manual', NULL, 'verified', 200, 'RESUME-REF-1',
       '{"phase":"verified"}', NULL, ?)`,
    [input.applicationId, input.job.id, input.runId ?? null, at],
  );
  db.run(
    `UPDATE applications SET status = 'submitted', submission_status = 'verified', submitted_at = ?,
       confirmation_ref = 'RESUME-REF-1', last_update = ? WHERE id = ?`,
    [at, at, input.applicationId],
  );
  events.recordApplicationEvent({
    applicationId: input.applicationId,
    type: "submission.verified",
    message: "Controlled production-resume fixture verified the submission.",
    meta: { reference: "RESUME-REF-1" },
  });
  return {
    status: "verified",
    channel: "manual",
    detail: "Controlled fixture verified.",
    httpStatus: 200,
    reference: "RESUME-REF-1",
    endpoint: null,
    evidence: { fixture: true },
  };
}

test("production resume reuses completed stages and never regenerates or resends", async () => {
  let prepareCalls = 0;
  let discoverCalls = 0;
  let submitCalls = 0;
  let vacancyChecks = 0;
  const outcome = await runs.resumeRecruitmentRun(runId, {
    deps: {
      discover: async () => {
        discoverCalls += 1;
        throw new Error("discovery must not repeat");
      },
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("documents must not regenerate");
      },
      verifyVacancy: async () => {
        vacancyChecks += 1;
        return {
          status: "open",
          checkedAt: now,
          publishedAt: now,
          publicationStatus: "present",
          expiryAt: null,
          expiryStatus: "unknown",
          expirySource: null,
          reason: "Controlled fixture.",
          checks: [],
          route: {
            statuses: ["APPLICATION_ROUTE_UNRESOLVED"],
            finalStatus: "APPLICATION_ROUTE_UNRESOLVED",
            urlResolved: false,
            urlReachable: false,
            employerIdentityVerified: false,
            vacancyOpenVerified: false,
            applicationFormSupported: false,
            finalUrl: null,
            finalHost: null,
            httpStatus: null,
            formEvidence: [],
            reason: "Controlled fixture with no live route check.",
          },
        };
      },
      submit: async (input) => {
        submitCalls += 1;
        return verifiedSubmission(input);
      },
    },
  });

  assert.equal(outcome.status === "completed" || outcome.status === "completed_with_warnings", true);
  assert.equal(discoverCalls, 0, "completed discovery was reconstructed from SQLite");
  assert.equal(prepareCalls, 0, "the completed document package was reused");
  assert.equal(vacancyChecks, 1, "only the final pre-send vacancy safety check ran");
  assert.equal(submitCalls, 1);
  assert.equal(count("documents"), 4, "no duplicate CV or cover documents");
  assert.equal(count("applications"), 1, "no duplicate application row");
  assert.equal(count("submission_attempts"), 1, "no duplicate submission claim");
  assert.equal(stages.checkpointFor(runId, jobId, "employer_submission")?.status, "completed");
  assert.equal(stages.checkpointFor(runId, jobId, "confirmation_verification")?.status, "completed");

  // Simulate a crash after verified delivery, then restart the production path.
  db.run("UPDATE recruitment_runs SET status = 'failed', finished_at = NULL WHERE id = ?", [runId]);
  let resendCalls = 0;
  const restarted = await runs.resumeRecruitmentRun(runId, {
    deps: {
      discover: async () => {
        throw new Error("discovery must not repeat after verified delivery");
      },
      prepare: async () => {
        throw new Error("documents must not regenerate after verified delivery");
      },
      verifyVacancy: async () => {
        throw new Error("a verified submission must be reused before any employer check");
      },
      submit: async () => {
        resendCalls += 1;
        throw new Error("a verified application must never be sent twice");
      },
    },
  });

  assert.equal(restarted.status === "completed" || restarted.status === "completed_with_warnings", true);
  assert.equal(resendCalls, 0, "no second employer submission was attempted");
  assert.equal(count("documents"), 4);
  assert.equal(count("applications"), 1);
  assert.equal(count("submission_attempts"), 1);
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [applicationId])?.status,
    "submitted",
    "a resumed readiness stage must not downgrade a verified application",
  );
});
