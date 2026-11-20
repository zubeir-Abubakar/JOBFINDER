import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase2-docs-"));
process.env.APP_SECRET_KEY = "phase2-doc-test";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");

db.getDb();
db.run("UPDATE profiles SET email = ?, phone = ?, work_authorisation = ? WHERE id = 1", [
  "ada@example.com",
  "+41 79 000 00 00",
  "Swiss Permit B — authorised to work without employer sponsorship",
]);
db.run(
  "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES (?, ?, ?, ?, 1, 'cv', 1)",
  ["Playwright", "Automation", "advanced", 4],
);
db.run(
  "INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, achievements, sort) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 1)",
  [
    "Swiss Payments AG",
    "Senior QA Engineer",
    "Zürich",
    "2020-01",
    null,
    "Own test automation, API quality and release readiness for payment products.",
    JSON.stringify(["Built Playwright suites covering 120 payment scenarios and reduced release defects by 30%."]),
  ],
);

const MASTER_TEXT = [
  "Ada Lovelace",
  "Senior QA Automation Engineer",
  "Zürich | ada@example.com | +41 79 000 00 00",
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
  "• Documented risk-based test plans and kept evidence available for product sign-off.",
  "• Supported product sign-off with clear evidence and proportionate release recommendations.",
  "CERTIFICATIONS",
  "ISTQB Certified Tester",
  "EDUCATION",
  "BSc Computer Science — University of Example 2016",
  "LANGUAGES",
  "English (C1) | French (B2)",
].join("\n");

db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_master_phase2', 'system', 'original_cv', 'Master CV', 'master-cv.pdf', 'application/pdf', 'missing-master.pdf', 1200, 'ready', ?, ?)`,
  [MASTER_TEXT, new Date().toISOString()],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_master_phase2' WHERE id = 1");

const DESCRIPTION = [
  "We are hiring a Senior QA Automation Engineer for our fintech payments platform.",
  "You will own Playwright test automation, API testing, release readiness and TypeScript test code.",
  "You will work with engineering and product teams on regression testing and quality gates.",
  "Swiss work authorisation is required; sponsorship is not offered. English is required.",
].join(" ");

function insertJob(id: string, company: string) {
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, url, application_url, description, posted_at, discovered_at, status, dedupe_key)
     VALUES (?, 'manual', ?, 'Senior QA Automation Engineer', ?, 'Zürich, Switzerland', 0, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      id,
      `ext-${id}`,
      company,
      `https://${id}.example/job`,
      `https://${id}.example/apply`,
      DESCRIPTION,
      new Date().toISOString(),
      new Date().toISOString(),
      `dedupe-${id}`,
    ],
  );
}

insertJob("job_phase2_one", "Swiss Payments AG");
insertJob("job_phase2_two", "Second Employer AG");

const workflowId = agents.createWorkflow("documents", "Phase 2 persistence fixture");

test("each vacancy receives its own package and the cover letter has no borrowed CV ATS score", async () => {
  const first = await agents.generateApplicationPackage("system", "job_phase2_one", { workflowId });
  assert.equal(first.ok, true, first.message);
  assert.equal(typeof first.atsScore, "number");

  const cv = db.one<{ id: string; ats_score: number | null; quality_status: string | null; text_content: string; version: string }>(
    "SELECT id, ats_score, quality_status, text_content, version FROM documents WHERE job_id = ? AND kind = 'tailored_cv' AND mime = 'application/pdf' ORDER BY created_at DESC LIMIT 1",
    ["job_phase2_one"],
  );
  const cover = db.one<{ id: string; ats_score: number | null; quality_status: string | null; text_content: string; version: string }>(
    "SELECT id, ats_score, quality_status, text_content, version FROM documents WHERE job_id = ? AND kind = 'cover_letter' AND mime = 'application/pdf' ORDER BY created_at DESC LIMIT 1",
    ["job_phase2_one"],
  );
  assert.ok(cv);
  assert.ok(cover);
  assert.equal(cv!.version, "1.0");
  assert.equal(cover!.version, "1.0");
  assert.equal(typeof cv!.ats_score, "number");
  assert.equal(cover!.ats_score, null, "cover letters must not inherit the CV ATS score");
  assert.match(cv!.text_content, /Swiss Payments AG/);
  assert.match(cover!.text_content, /Swiss Payments AG/);

  const app = db.one<{ readiness: string | null; cv_document_id: string; cover_letter_id: string }>(
    "SELECT readiness, cv_document_id, cover_letter_id FROM applications WHERE job_id = ?",
    ["job_phase2_one"],
  );
  assert.ok(app);
  assert.equal(app!.cv_document_id, cv!.id);
  assert.equal(app!.cover_letter_id, cover!.id);
  const readiness = JSON.parse(app!.readiness ?? "{}") as { state?: string };
  assert.ok(["documents_ready", "quality_review_required"].includes(readiness.state ?? ""), readiness.state ?? "missing readiness state");

  const second = await agents.generateApplicationPackage("system", "job_phase2_two", { workflowId });
  assert.equal(second.ok, true, second.message);
  const secondCv = db.one<{ text_content: string; version: string }>(
    "SELECT text_content, version FROM documents WHERE job_id = ? AND kind = 'tailored_cv' AND mime = 'application/pdf' LIMIT 1",
    ["job_phase2_two"],
  );
  assert.ok(secondCv);
  assert.equal(secondCv!.version, "1.0");
  assert.notEqual(secondCv!.text_content, cv!.text_content, "each vacancy receives a vacancy-specific CV");
  assert.match(secondCv!.text_content, /Second Employer AG/);
});

test("regenerating a vacancy adds a version and preserves the earlier documents", async () => {
  const before = db.all<{ id: string }>("SELECT id FROM documents WHERE job_id = ? AND version = '1.0'", ["job_phase2_one"]);
  assert.equal(before.length, 4, "CV and cover PDF/DOCX files for v1.0");
  const second = await agents.generateApplicationPackage("system", "job_phase2_one", { workflowId });
  assert.equal(second.ok, true, second.message);
  const versions = db.all<{ version: string }>(
    "SELECT DISTINCT version FROM documents WHERE job_id = ? ORDER BY version",
    ["job_phase2_one"],
  );
  assert.deepEqual(versions.map((row) => row.version), ["1.0", "2.0"]);
  for (const doc of before) {
    assert.ok(db.one("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL", [doc.id]), `old document ${doc.id} is preserved`);
  }
  assert.equal(
    db.one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ?", ["job_phase2_one"])?.c,
    0,
    "document generation never submits an application",
  );
  assert.ok(db.one("SELECT id FROM documents WHERE id = 'doc_master_phase2' AND deleted_at IS NULL"), "the original CV remains untouched");
});
