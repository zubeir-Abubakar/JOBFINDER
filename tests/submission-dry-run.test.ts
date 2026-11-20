import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-submission-dry-run-"));
process.env.APP_SECRET_KEY = "submission-dry-run-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const { setSetting } = await import("../lib/settings.ts");
const { submitApplication } = await import("../lib/submission.ts");

db.getDb();
const now = new Date("2026-11-20T10:00:00.000Z");
const at = now.toISOString();

db.run(
  "INSERT INTO jobs (id, source, title, company, url, application_url, description, discovered_at, status, published_at) VALUES ('job_dry','test','QA Engineer','Dry Run AG','https://example.test/job','https://example.test/apply','Apply now',?,'shortlisted',?)",
  [at, at],
);
db.run(
  "INSERT INTO applications (id, job_id, status, readiness, last_update, created_at) VALUES ('app_dry','job_dry','ready_to_submit',?,?,?)",
  [JSON.stringify({ ready: true, state: "ready_for_submission", items: [] }), at, at],
);
setSetting("standing_authorisation_activated_at", at);
setSetting("autonomous_submission", true);
setSetting("approval_mode", false);
setSetting("recruitment_dry_run", true);

test("dry-run blocks before any claim or employer request", async () => {
  const outcome = await submitApplication({
    applicationId: "app_dry",
    job: {
      id: "job_dry",
      title: "QA Engineer",
      company: "Dry Run AG",
      url: "https://example.test/job",
      application_url: "https://example.test/apply",
      description: "Apply now",
    },
    documents: {
      cvPath: null,
      cvName: null,
      coverPath: null,
      coverName: null,
      coverText: null,
      coverDocumentId: null,
      cvDocumentId: null,
    },
    profile: {
      full_name: "Test Owner",
      email: "owner@example.test",
      phone: null,
      location: "Zurich",
      work_authorisation: "Swiss Permit B",
      headline: null,
      linkedin: null,
      website: null,
    },
    now,
  });

  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /Dry run is enabled/);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = 'job_dry'")?.n,
    0,
  );
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM application_events WHERE application_id = 'app_dry' AND type = 'submission.dry_run'")?.n,
    1,
  );
  assert.equal(
    db.one<{ status: string }>("SELECT status FROM applications WHERE id = 'app_dry'")?.status,
    "ready_to_submit",
  );
});
