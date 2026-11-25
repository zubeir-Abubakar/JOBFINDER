import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-stage-recovery-"));
process.env.APP_SECRET_KEY = "stage-recovery-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const stages = await import("../lib/recruitment-stages.ts");
import type { StageHandler } from "../lib/recruitment-stages.ts";

db.getDb();

test.after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

type Fixture = { runId: string; jobId: string; suffix: string; handlers: Record<string, StageHandler> };

function at(offset = 0): string {
  return new Date(Date.now() + offset).toISOString();
}

function createFixture(suffix: string): Fixture {
  const runId = `run_stage_${suffix}`;
  const jobId = `job_stage_${suffix}`;
  const now = at();
  db.run(
    `INSERT INTO recruitment_runs (id, run_key, trigger, status, created_at, jobs_discovered, jobs_duplicates, jobs_filtered)
     VALUES (?, ?, 'manual', 'starting', ?, 0, 0, 0)`,
    [runId, `stage#${suffix}`, now],
  );
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, url, application_url, description, posted_at, discovered_at, status, dedupe_key, match_score, qualified)
     VALUES (?, 'manual', ?, 'Senior QA Automation Engineer', 'Stage Employer AG', 'Zürich', 0, ?, ?, 'Playwright API testing release readiness', ?, ?, 'new', ?, 92, 0)`,
    [
      jobId,
      `external-${suffix}`,
      `https://stage.example/${suffix}`,
      `https://stage.example/${suffix}/apply`,
      now,
      now,
      `stage-dedupe-${suffix}`,
    ],
  );

  const cvPdf = `doc_${suffix}_cv_pdf`;
  const cvDocx = `doc_${suffix}_cv_docx`;
  const coverPdf = `doc_${suffix}_cover_pdf`;
  const coverDocx = `doc_${suffix}_cover_docx`;
  const applicationId = `app_${suffix}`;
  const attemptId = `attempt_${suffix}`;

  const handlers: Record<string, StageHandler> = {
    async discovery() {
      db.run("UPDATE jobs SET run_id = ? WHERE id = ?", [runId, jobId]);
      db.run("UPDATE recruitment_runs SET jobs_discovered = 1 WHERE id = ?", [runId]);
      return { ok: true, outputRefs: { jobIds: [jobId] }, evidence: { source: "synthetic" } };
    },
    async vacancy_validation() {
      db.run(
        "UPDATE jobs SET vacancy_status = 'open', vacancy_verification = '{\"status\":\"open\"}', vacancy_verified_at = ? WHERE id = ?",
        [at(), jobId],
      );
      return { ok: true, outputRefs: { jobId }, evidence: { status: "open" } };
    },
    async eligibility() {
      db.run(
        "UPDATE jobs SET eligibility = 'eligible', eligibility_notes = '{}', eligibility_checked_at = ?, analysis = '{}', match_score = 92, qualified = 1 WHERE id = ?",
        [at(), jobId],
      );
      return { ok: true, outputRefs: { jobId, matchScore: 92 }, evidence: { eligible: true } };
    },
    async cv_generation() {
      const insertDoc = (id: string, mime: string, name: string) =>
        db.run(
          `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, job_id, version, text_content, run_id, created_at)
           VALUES (?, 'system', 'tailored_cv', ?, ?, ?, ?, 0, 'draft', ?, '1.0', 'Ada Lovelace Senior QA Automation Engineer', ?, ?)
           ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id`,
          [id, name, name, mime, name, jobId, runId, at()],
        );
      insertDoc(cvPdf, "application/pdf", `cv-${suffix}.pdf`);
      insertDoc(cvDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `cv-${suffix}.docx`);
      return { ok: true, outputRefs: { cvDocumentId: cvPdf, cvDocxId: cvDocx } };
    },
    async cv_validation() {
      db.run(
        "UPDATE documents SET quality_status = 'passed', quality_score = 96, size_bytes = 1200 WHERE job_id = ? AND kind = 'tailored_cv'",
        [jobId],
      );
      return { ok: true, outputRefs: { cvDocumentId: cvPdf }, evidence: { quality: "passed" } };
    },
    async cover_generation() {
      const insertDoc = (id: string, mime: string, name: string) =>
        db.run(
          `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, job_id, version, text_content, run_id, created_at)
           VALUES (?, 'system', 'cover_letter', ?, ?, ?, ?, 0, 'draft', ?, '1.0', 'Dear Hiring Team, I bring verified Playwright and API testing evidence.', ?, ?)
           ON CONFLICT(id) DO UPDATE SET run_id = excluded.run_id`,
          [id, name, name, mime, name, jobId, runId, at()],
        );
      insertDoc(coverPdf, "application/pdf", `cover-${suffix}.pdf`);
      insertDoc(coverDocx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `cover-${suffix}.docx`);
      return { ok: true, outputRefs: { coverDocumentId: coverPdf, coverDocxId: coverDocx } };
    },
    async cover_validation() {
      db.run(
        "UPDATE documents SET quality_status = 'passed', quality_score = 94, size_bytes = 1200 WHERE job_id = ? AND kind = 'cover_letter'",
        [jobId],
      );
      return { ok: true, outputRefs: { coverDocumentId: coverPdf }, evidence: { quality: "passed" } };
    },
    async rendering() {
      db.run("UPDATE documents SET size_bytes = 1200 WHERE job_id = ? AND deleted_at IS NULL", [jobId]);
      return { ok: true, outputRefs: { cvDocumentId: cvPdf, coverDocumentId: coverPdf } };
    },
    async package_assembly() {
      db.run(
        `INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, method, readiness, readiness_checked_at, last_update, created_at, run_id)
         VALUES (?, ?, 'quality_check', ?, ?, 'employer_portal', NULL, NULL, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET cv_document_id = excluded.cv_document_id, cover_letter_id = excluded.cover_letter_id, run_id = excluded.run_id`,
        [applicationId, jobId, cvPdf, coverPdf, at(), at(), runId],
      );
      return { ok: true, outputRefs: { applicationId, cvDocumentId: cvPdf, coverDocumentId: coverPdf } };
    },
    async readiness() {
      db.run(
        "UPDATE applications SET status = 'ready_to_submit', readiness = '{\"state\":\"ready_for_submission\",\"ready\":true}', readiness_checked_at = ?, last_update = ? WHERE id = ?",
        [at(), at(), applicationId],
      );
      return { ok: true, outputRefs: { applicationId, readinessState: "ready_for_submission" } };
    },
    async submission_claim() {
      db.run(
        `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, endpoint, status, http_status, reference, evidence, error, attempted_at)
         VALUES (?, ?, ?, ?, 'http_form', 'https://stage.example/apply', 'submitting', NULL, NULL, '{"phase":"claimed"}', NULL, ?)
         ON CONFLICT(id) DO NOTHING`,
        [attemptId, applicationId, jobId, runId, at()],
      );
      return { ok: true, outputRefs: { attemptId, submissionStatus: "submitting" } };
    },
    async employer_submission() {
      db.run("UPDATE submission_attempts SET status = 'verified', reference = ? WHERE id = ?", [`REF-${suffix}`, attemptId]);
      return { ok: true, outputRefs: { attemptId, reference: `REF-${suffix}` } };
    },
    async confirmation_verification() {
      db.run(
        "UPDATE applications SET submission_status = 'verified', confirmation_ref = ?, last_update = ? WHERE id = ?",
        [`REF-${suffix}`, at(), applicationId],
      );
      return { ok: true, outputRefs: { applicationId, confirmationRef: `REF-${suffix}` } };
    },
  };
  return { runId, jobId, suffix, handlers };
}

function completedStages(runId: string, jobId: string): string[] {
  return db
    .all<{ stage: string }>(
      "SELECT stage FROM recruitment_stage_checkpoints WHERE run_id = ? AND job_id = ? AND status = 'completed' ORDER BY created_at",
      [runId, jobId],
    )
    .map((row) => row.stage);
}

function counts(fixture: Fixture) {
  return {
    documents: Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM documents WHERE job_id = ?", [fixture.jobId])?.n ?? 0),
    attempts: Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [fixture.jobId])?.n ?? 0),
    applications: Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE job_id = ?", [fixture.jobId])?.n ?? 0),
  };
}

test("stage dependencies are acyclic and strictly ordered", () => {
  const seen = new Set<string>();
  for (let index = 0; index < stages.RECRUITMENT_STAGES.length; index += 1) {
    const stage = stages.RECRUITMENT_STAGES[index];
    assert.equal(seen.has(stage), false, `${stage} appears only once`);
    seen.add(stage);
    assert.equal(
      stages.nextStageAfter(stage),
      stages.RECRUITMENT_STAGES[index + 1] ?? null,
      `${stage} has exactly one forward dependency`,
    );
  }
});

test("every stage resumes from its persisted checkpoint without duplicating documents or claims", async () => {
  for (const stopStage of stages.RECRUITMENT_STAGES) {
    const fixture = createFixture(`resume_${stopStage}`);
    const first = await stages.runStageRecovery({
      runId: fixture.runId,
      jobId: fixture.jobId,
      handlers: fixture.handlers,
      stopAt: stopStage,
    });
    assert.equal(first.stoppedAt, stopStage);
    const before = counts(fixture);
    const restart = await stages.runStageRecovery({
      runId: fixture.runId,
      jobId: fixture.jobId,
      handlers: fixture.handlers,
    });
    const after = counts(fixture);
    if (stopStage === "submission_claim") {
      assert.equal(restart.finalAction, "reconcile_submission", "a claim without a recorded response is ambiguous");
      assert.equal(restart.stoppedAt, "employer_submission");
      assert.equal(after.attempts, 1);
    } else {
      assert.equal(restart.finalAction, "complete", `restart after ${stopStage}`);
      assert.equal(completedStages(fixture.runId, fixture.jobId).length, 12, "job-level stages; discovery is run-level");
    }
    assert.equal(after.documents, 4, "CV and cover PDF/DOCX outputs are never duplicated");
    assert.equal(after.applications, 1);
    assert.ok(after.attempts <= 1);
    assert.ok(before.documents <= after.documents);
  }
});

test("a controlled failure at each side-effecting stage retries only that stage", async () => {
  for (const failAt of [
    "discovery",
    "vacancy_validation",
    "eligibility",
    "cv_generation",
    "cv_validation",
    "cover_generation",
    "cover_validation",
    "rendering",
    "package_assembly",
    "readiness",
    "submission_claim",
    "confirmation_verification",
  ] as const) {
    const fixture = createFixture(`fail_${failAt}`);
    let failed = false;
    const handlers = {
      ...fixture.handlers,
      [failAt]: async (context: Parameters<StageHandler>[0]) => {
        if (!failed) {
          failed = true;
          throw new Error(`injected crash at ${failAt}`);
        }
        return fixture.handlers[failAt](context);
      },
    };
    if (failAt === "rendering") {
      const cvValidation = fixture.handlers.cv_validation;
      const coverValidation = fixture.handlers.cover_validation;
      handlers.cv_validation = async (context) => {
        const result = await cvValidation(context);
        db.run("UPDATE documents SET size_bytes = 0 WHERE job_id = ? AND kind = 'tailored_cv'", [fixture.jobId]);
        return result;
      };
      handlers.cover_validation = async (context) => {
        const result = await coverValidation(context);
        db.run("UPDATE documents SET size_bytes = 0 WHERE job_id = ? AND kind = 'cover_letter'", [fixture.jobId]);
        return result;
      };
    }
    const first = await stages.runStageRecovery({
      runId: fixture.runId,
      jobId: fixture.jobId,
      handlers,
    });
    assert.equal(first.stoppedAt, failAt);
    const firstCheckpoint = stages.checkpointFor(
      fixture.runId,
      failAt === "discovery" ? "" : fixture.jobId,
      failAt,
    );
    assert.equal(firstCheckpoint?.status, "failed");
    const restart = await stages.runStageRecovery({
      runId: fixture.runId,
      jobId: fixture.jobId,
      handlers,
    });
    assert.equal(restart.finalAction, "complete", `retry ${failAt}`);
    assert.equal(completedStages(fixture.runId, fixture.jobId).length, 12, "job-level stages; discovery is run-level");
    assert.deepEqual(counts(fixture), { documents: 4, attempts: 1, applications: 1 });
  }
});

test("an ambiguous employer submission is reconciled and never blindly claimed again", async () => {
  const fixture = createFixture("ambiguous");
  const first = await stages.runStageRecovery({
    runId: fixture.runId,
    jobId: fixture.jobId,
    handlers: fixture.handlers,
    stopAt: "submission_claim",
  });
  assert.equal(first.stoppedAt, "submission_claim");
  db.run(
    "UPDATE submission_attempts SET status = 'unverified', error = 'timeout after request created' WHERE job_id = ?",
    [fixture.jobId],
  );
  db.run(
    "UPDATE applications SET status = 'submission_unverified', submission_status = 'unverified' WHERE job_id = ?",
    [fixture.jobId],
  );
  let employerCalls = 0;
  const restart = await stages.runStageRecovery({
    runId: fixture.runId,
    jobId: fixture.jobId,
    handlers: {
      ...fixture.handlers,
      employer_submission: async () => {
        employerCalls += 1;
        return { ok: true };
      },
    },
  });
  assert.equal(restart.finalAction, "reconcile_submission");
  assert.equal(restart.stoppedAt, "employer_submission");
  assert.equal(employerCalls, 0, "an ambiguous claim must not cause another submission");
  assert.equal(counts(fixture).attempts, 1);
});

test("a valid run lease prevents a second worker from executing stages", async () => {
  const fixture = createFixture("lease");
  db.run(
    "INSERT INTO runtime_locks (key, owner, acquired_at, heartbeat_at, expires_at, meta) VALUES (?, 'other-worker', ?, ?, ?, '{}')",
    [`recruitment:run:${fixture.runId}`, at(), at(), at(5 * 60_000)],
  );
  const result = await stages.runStageRecovery({
    runId: fixture.runId,
    jobId: fixture.jobId,
    handlers: fixture.handlers,
  });
  assert.equal(result.finalAction, "wait_lease");
  assert.equal(result.stoppedAt, "discovery");
  assert.equal(counts(fixture).documents, 0);
});

test("concurrent fixture runs keep their documents, applications and checkpoints isolated", async () => {
  const left = createFixture("concurrent_left");
  const right = createFixture("concurrent_right");
  const [a, b] = await Promise.all([
    stages.runStageRecovery({ runId: left.runId, jobId: left.jobId, handlers: left.handlers }),
    stages.runStageRecovery({ runId: right.runId, jobId: right.jobId, handlers: right.handlers }),
  ]);
  assert.equal(a.finalAction, "complete");
  assert.equal(b.finalAction, "complete");
  const leftDocs = db.all<{ job_id: string }>("SELECT job_id FROM documents WHERE job_id = ?", [left.jobId]);
  const rightDocs = db.all<{ job_id: string }>("SELECT job_id FROM documents WHERE job_id = ?", [right.jobId]);
  assert.equal(leftDocs.length, 4);
  assert.equal(rightDocs.length, 4);
  assert.ok(leftDocs.every((row) => row.job_id === left.jobId));
  assert.ok(rightDocs.every((row) => row.job_id === right.jobId));
  assert.equal(db.one<{ id: string }>("SELECT id FROM applications WHERE job_id = ?", [left.jobId])?.id, `app_${left.suffix}`);
  assert.equal(db.one<{ id: string }>("SELECT id FROM applications WHERE job_id = ?", [right.jobId])?.id, `app_${right.suffix}`);
});
