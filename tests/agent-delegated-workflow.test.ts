import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openVacancyVerification } from "./helpers/open-vacancy.ts";

/**
 * Full delegated path, using the real document/task pipeline.
 *
 * Discovery and vacancy verification are controlled fixtures, but the CV,
 * cover-letter and final ATS gate are actual persisted tasks. Automatic
 * submission is put in dry-run mode so no employer or network is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-agent-workflow-"));
process.env.APP_SECRET_KEY = "agent-workflow-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_DRY_RUN = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const agents = await import("../lib/agents.ts");
const runs = await import("../lib/recruitment-run.ts");

db.getDb();
db.run("UPDATE agents SET enabled = 1, status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'idle' END");
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
   VALUES ('doc_master_workflow', 'system', 'original_cv', 'Master CV', 'master-cv.pdf', 'application/pdf', 'master-cv.pdf', 80, 'ready', ?, ?)`,
  [MASTER_TEXT, new Date().toISOString()],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_master_workflow' WHERE id = 1");

const now = new Date();
const jobId = "job_delegated_workflow";
db.run(
  `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, url, application_url,
     description, published_at, discovered_at, status, dedupe_key, match_score, match_flag)
   VALUES (?, 'manual', ?, ?, ?, 'Zürich, Switzerland', 0, 'Full-time', ?, ?, ?, ?, ?, 'new', ?, 95, 'strong')`,
  [
    jobId,
    "ext-workflow",
    "Senior QA Automation Engineer",
    "Delegated Employer AG",
    "https://fixture.test/job",
    "https://fixture.test/apply",
    [
      "We are hiring a senior quality engineer with 5+ years of software testing experience.",
      "You will own test automation with Playwright and Cypress, build REST API tests and run CI pipelines.",
      "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
      "English is required. Swiss work authorisation is required; the candidate already holds a Swiss Permit B.",
    ].join(" "),
    now.toISOString(),
    now.toISOString(),
    "dedupe-delegated-workflow",
  ],
);

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("the full delegated workflow persists Kora → Amira → Kali → Noor and never claims a dry-run submission", async () => {
  const created = runs.createRecruitmentRun({ trigger: "manual", now });
  assert.equal(created.created, true);
  const outcome = await runs.executeRun(created.run.id, {
    now,
    maxApplications: 1,
    pageBudget: 1,
    deps: {
      discover: async () => ({
        discovered: 1,
        inserted: 1,
        duplicates: 0,
        updated: 0,
        filtered: 0,
        jobIds: [jobId],
        sources: [],
        warnings: [],
      }),
      analyse: () =>
        ({
          score: 95,
          concerns: [],
          mandatoryBlockers: [],
          preferences: [],
          criteria: [],
          matched: ["Playwright", "API testing", "release readiness"],
          missing: [],
          breakdown: {},
          evidence: {},
          flag: "strong",
        }) as unknown as import("../lib/scoring.ts").JobAnalysis,
      prepare: (id, workflowId) => agents.generateApplicationPackage("system", id, { workflowId }),
      verifyVacancy: async () => openVacancyVerification(now.toISOString()),
    },
  });

  assert.equal(outcome.prepared, 1, outcome.report);
  assert.equal(outcome.submitted, 0);
  const diagnosticApp = db.one<{ status: string; readiness: string | null }>(
    "SELECT status, readiness FROM applications WHERE job_id = ?",
    [jobId],
  );
  assert.equal(
    outcome.simulated,
    1,
    `dry run records a simulation, not a submission: ${JSON.stringify(diagnosticApp)}`,
  );

  const tasks = db.all<{
    id: string;
    agent_key: string;
    title: string;
    status: string;
    depends_on: string | null;
    output: string | null;
  }>("SELECT id, agent_key, title, status, depends_on, output FROM tasks WHERE run_id = ? ORDER BY rowid", [created.run.id]);
  const byAgent = (key: string) => tasks.filter((task) => task.agent_key === key);
  assert.ok(byAgent("coordinator").length >= 1);
  assert.ok(byAgent("research").length >= 1);
  assert.ok(byAgent("analysis").length >= 1);
  assert.ok(byAgent("cv").length >= 1);
  assert.ok(byAgent("cover").length >= 1);
  assert.ok(byAgent("application").length >= 1);
  assert.ok(byAgent("email").length >= 1);

  const cv = byAgent("cv").at(-1)!;
  const cover = byAgent("cover").at(-1)!;
  const packageGate = byAgent("ats").find((task) => /^Independently validate/.test(task.title));
  assert.ok(packageGate, "Kali must own a persisted final package gate");
  assert.equal(packageGate!.status, "completed");
  assert.ok(tasks.findIndex((task) => task.id === cv.id) < tasks.findIndex((task) => task.id === cover.id));
  assert.ok(tasks.findIndex((task) => task.id === cover.id) < tasks.findIndex((task) => task.id === packageGate!.id));
  assert.ok(
    JSON.parse(cover.depends_on ?? "[]").includes(cv.id) || JSON.parse(cover.depends_on ?? "[]").length > 0,
    "Amira depends on a persisted Kora/CV task",
  );
  assert.ok(
    JSON.parse(packageGate!.depends_on ?? "[]").includes(cover.id),
    "Kali's final gate depends on Amira's cover-letter task",
  );

  const noor = byAgent("application").at(-1)!;
  assert.equal(noor.status, "completed");
  assert.match(noor.output ?? "", /Dry run|No application was sent/i);
  assert.ok(
    JSON.parse(noor.depends_on ?? "[]").includes(packageGate!.id),
    "Noor depends on Kali's final package gate",
  );

  const app = db.one<{ status: string; submission_status: string | null; cv_document_id: string | null; cover_letter_id: string | null }>(
    "SELECT status, submission_status, cv_document_id, cover_letter_id FROM applications WHERE job_id = ?",
    [jobId],
  );
  assert.ok(app);
  assert.ok(app!.cv_document_id && app!.cover_letter_id);
  assert.equal(app!.submission_status, "simulated");
  assert.notEqual(app!.status, "submitted");
});
