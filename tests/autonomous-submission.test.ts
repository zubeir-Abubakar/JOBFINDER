import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { openVacancyVerification } from "./helpers/open-vacancy.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 2.6 — standing authorisation and candidate-facing forms.
 *
 * Every HTTP request goes to a local fixture server. No employer, ATS or real
 * application form is contacted, and no application leaves this machine.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-standing-"));
process.env.APP_SECRET_KEY = "standing-authorisation-test";
process.env.RECRUITMENT_CANDIDATE_FORMS = "true";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const STRONG_DESCRIPTION = [
  "We are hiring a senior quality engineer with 5+ years of software testing experience.",
  "You will own test automation with Playwright and Cypress, build REST API tests and run CI pipelines.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "English is required. This is a full-time role.",
].join(" ");

const FORM = (extra = "") => `<!doctype html><html><body>
<form method="post" action="/submit">
  <input type="hidden" name="csrf_token" value="csrf-fixture-123">
  <label for="full_name">Full name</label>
  <input id="full_name" name="full_name" required>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required>
  <label for="phone">Phone</label>
  <input id="phone" name="phone" required>
  <label for="work_authorisation">Work authorisation</label>
  <input id="work_authorisation" name="work_authorisation" required>
  <label for="resume">Resume / CV</label>
  <input id="resume" name="resume" type="file" required>
  <label for="cover_letter">Cover letter</label>
  <textarea id="cover_letter" name="cover_letter"></textarea>
  <label for="how">How did you hear about us?</label>
  <input id="how" name="how_did_you_hear">
  ${extra}
  <button type="submit">Apply</button>
</form>
</body></html>`;

const QUESTIONS = FORM(`
  <label for="salary">Salary expectation</label><input id="salary" name="salary_expectation" required>
  <label for="notice">Notice period</label><input id="notice" name="notice_period">
  <label for="relocate">Willing to relocate?</label><input id="relocate" name="willing_to_relocate">
  <label for="legal">I certify the information is true</label><input id="legal" name="legal_declaration" type="checkbox" required>
`);

const posts: Array<{ path: string; body: string; contentType: string }> = [];

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET") {
    if (url.pathname === "/apply") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FORM());
      return;
    }
    if (url.pathname === "/questions") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(QUESTIONS);
      return;
    }
    if (url.pathname === "/captcha") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FORM('<div class="g-recaptcha" data-sitekey="fixture"></div>'));
      return;
    }
    if (url.pathname === "/mfa") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FORM('<p>Enter the verification code from your authenticator app.</p>'));
      return;
    }
    if (url.pathname === "/ambiguous") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FORM().replace('action="/submit"', 'action="/ambiguous-submit"'));
      return;
    }
    res.writeHead(404);
    res.end("not found");
    return;
  }
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", () => {
    posts.push({ path: url.pathname, body, contentType: String(req.headers["content-type"] ?? "") });
    if (url.pathname === "/ambiguous-submit") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Thanks for your message.</h1></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body><h1>Thank you for applying</h1><p>Reference: APP-2026-0042</p></body></html>");
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
});

const db = await import("../lib/db.ts");
const policy = await import("../lib/recruitment-policy.ts");
const candidateForms = await import("../lib/candidate-forms.ts");
import type { CandidateDocuments, CandidateProfile } from "../lib/candidate-forms.ts";
const submission = await import("../lib/submission.ts");
const runs = await import("../lib/recruitment-run.ts");
const profileModule = await import("../lib/profile.ts");

db.getDb();
// This fixture exercises real (local) form delivery; production defaults remain
// a dry run. The fixture must opt out explicitly.
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE profiles SET email = ?, phone = ?, work_authorisation = ? WHERE id = 1", [
  "ada@example.com",
  "+41 79 000 00 00",
  "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
]);

mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "master-cv.pdf"), "%PDF-1.4 standing authorisation fixture master CV");
writeFileSync(join(db.UPLOAD_DIR, "ada-lovelace-cv.pdf"), "%PDF-1.4 tailored fixture CV");
writeFileSync(join(db.UPLOAD_DIR, "ada-lovelace-cover.pdf"), "%PDF-1.4 tailored fixture cover");
const masterText = [
  "Ada Lovelace — Senior QA Automation Engineer",
  "Playwright, Cypress, API testing, regression testing, test planning, release readiness and defect management.",
  "More than five years of software quality assurance experience in fintech payment platforms and mobile applications.",
  "Built and maintained automated test suites and worked with product and engineering teams on quality gates.",
  "English C1.",
].join("\n");
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_master_standing', 'system', 'original_cv', 'Master CV', 'master-cv.pdf', 'application/pdf', 'master-cv.pdf', 50, 'ready', ?, ?)`,
  [masterText, new Date().toISOString()],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_master_standing' WHERE id = 1");

const profile: CandidateProfile = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+41 79 000 00 00",
  location: "Zürich",
  linkedin: null,
  website: null,
  workAuthorisation: "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
  summary: "Senior QA engineer with fintech, mobile and API test automation experience.",
  skills: ["Playwright", "Cypress", "API testing"],
  languages: ["English (C1)"],
  experienceText: "Lead QA Engineer — Cashia\n2020 → 2024\nBuilt Playwright suites for payment APIs.",
  educationText: "BSc Computer Science — University of Example",
  sponsorshipAnswer: "No",
};

const documents: CandidateDocuments = {
  cv: { buffer: Buffer.from("%PDF-1.4 tailored"), name: "ada-lovelace-cv.pdf" },
  cover: { buffer: Buffer.from("%PDF-1.4 cover"), name: "ada-lovelace-cover.pdf" },
  coverText:
    "Dear Autonomous Test AG team, I am applying for the Senior QA Automation Engineer role. I use Playwright and API testing for payment platforms.",
};

function makeJob(input: { id: string; title: string; company: string; path: string; description?: string }) {
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, url, application_url, description, published_at, discovered_at, status, dedupe_key, match_score)
     VALUES (?, 'manual', ?, ?, ?, 'Zürich, Switzerland', 0, 'Full-time', ?, ?, ?, ?, ?, 'new', ?, 95)`,
    [
      input.id,
      `ext-${input.id}`,
      input.title,
      input.company,
      `${base}${input.path}`,
      `${base}${input.path}`,
      input.description ?? STRONG_DESCRIPTION,
      new Date().toISOString(),
      new Date().toISOString(),
      `dedupe-${input.id}`,
    ],
  );
  const applicationId = `app_${input.id}`;
  const readiness = JSON.stringify({
    ready: true,
    state: "ready_for_submission",
    reasons: [],
    items: [],
    checkedAt: new Date().toISOString(),
    engine: "test-readiness",
  });
  db.run(
    `INSERT INTO applications (id, job_id, status, method, readiness, readiness_checked_at, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', 'candidate_form', ?, ?, ?, ?)`,
    [applicationId, input.id, readiness, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
  );
  return { jobId: input.id, applicationId };
}

function submissionInput(jobId: string, applicationId: string) {
  const job = db.one<{
    id: string; title: string; company: string; url: string | null; application_url: string | null; description: string | null;
  }>("SELECT id, title, company, url, application_url, description FROM jobs WHERE id = ?", [jobId]);
  assert.ok(job);
  return {
    applicationId,
    job: {
      id: jobId,
      title: job!.title,
      company: job!.company,
      url: job!.url,
      application_url: job!.application_url,
      description: job!.description,
      source: "manual",
      external_id: `ext-${jobId}`,
    },
    documents: {
      cvPath: "ada-lovelace-cv.pdf",
      cvName: "ada-lovelace-cv.pdf",
      coverPath: "ada-lovelace-cover.pdf",
      coverName: "ada-lovelace-cover.pdf",
      coverText: documents.coverText,
      cvDocumentId: null,
      coverDocumentId: null,
    },
    profile: {
      full_name: profile.fullName,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      work_authorisation: profile.workAuthorisation,
      headline: "Senior QA Automation Engineer",
      linkedin: profile.linkedin,
      website: profile.website,
      summary: profile.summary,
      skills: profile.skills,
      spokenLanguages: profile.languages,
      experienceText: profile.experienceText,
      educationText: profile.educationText,
    },
    authorisedAnswers: {},
  };
}

function fakePackage(jobId: string) {
  const job = db.one<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = ?", [jobId]);
  assert.ok(job);
  const cvFile = `cv-${jobId}.pdf`;
  const coverFile = `cover-${jobId}.pdf`;
  writeFileSync(join(db.UPLOAD_DIR, cvFile), "%PDF-1.4 standing fixture CV");
  writeFileSync(join(db.UPLOAD_DIR, coverFile), "%PDF-1.4 standing fixture cover");
  const cvText = [
    `Tailored CV for ${job!.title} at ${job!.company}.`,
    "Senior QA engineer with more than five years of software quality assurance experience.",
    "Playwright automation, Cypress, API testing, regression testing, release readiness and defect management.",
    "Built and maintained test suites for payment platforms and mobile applications in a fintech environment.",
    "Works with product and engineering teams on test strategy, test planning and quality gates.",
  ].join(" ");
  const coverText = [
    `Dear ${job!.company} team,`,
    `I am applying for the ${job!.title} role.`,
    "My experience covers Playwright test automation, API testing, regression testing and release readiness for payment platforms.",
    "I would welcome the opportunity to discuss how I can strengthen your quality engineering team.",
  ].join(" ");
  const createdAt = new Date().toISOString();
  for (const [id, kind, file, text] of [
    [`doc_${jobId}_cv`, "tailored_cv", cvFile, cvText],
    [`doc_${jobId}_cover`, "cover_letter", coverFile, coverText],
  ] as const) {
    db.run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
       VALUES (?, 'system', ?, ?, ?, 'application/pdf', ?, 32, ?, '1.0', 'ready', 'passed', 96, ?, ?)`,
      [id, kind, `${kind} fixture`, file, file, jobId, text, createdAt],
    );
  }
  const appId = `app_${jobId}`;
  db.run("UPDATE applications SET cv_document_id = ?, cover_letter_id = ? WHERE id = ?", [`doc_${jobId}_cv`, `doc_${jobId}_cover`, appId]);
  return {
    ok: true,
    message: "fixture package",
    applicationId: appId,
    atsScore: 96,
    cvDocumentId: `doc_${jobId}_cv`,
    coverDocumentId: `doc_${jobId}_cover`,
    warnings: [],
  };
}

test("defaults are 85%, 7 days, 5/day, and activation is deliberately absent", () => {
  const current = policy.getRecruitmentPolicy();
  assert.equal(current.minMatchScore, 85);
  assert.equal(current.maxSubmissionsPerDay, 5);
  assert.equal(current.freshnessDays, 7);
  assert.equal(current.autonomousSubmission, false);
  assert.equal(current.requirePerApplicationApproval, true);
  assert.equal(current.activatedAt, null);
  assert.equal(current.active, false);
});

test("before activation no application leaves the app", async () => {
  const { jobId, applicationId } = makeJob({
    id: "gated_job",
    title: "Senior QA Automation Engineer",
    company: "Gated Employer AG",
    path: "/apply",
  });
  const before = posts.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /standing authorisation is not activated/i);
  assert.equal(posts.length, before, "no HTTP POST is made before activation");
});

test("one blocked application does not stop another qualifying application", async () => {
  policy.activateStandingAuthorisation("test-owner");
  assert.equal(policy.getRecruitmentPolicy().active, true);
  // Keep the cap out of the way for the channel/evidence tests; the dedicated
  // daily-limit tests below lower it deliberately.
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 10 });
  const salary = makeJob({
    id: "run_salary",
    title: "Senior QA Automation Engineer",
    company: "Salary Question AG",
    path: "/questions",
  });
  const straight = makeJob({
    id: "run_straight",
    title: "Senior QA Automation Engineer",
    company: "Straight Form AG",
    path: "/apply",
  });
  db.run("UPDATE jobs SET run_id = NULL WHERE id IN (?, ?)", [salary.jobId, straight.jobId]);
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
  assert.equal(created.created, true);
  const outcome = await runs.executeRun(created.run.id, {
    deps: {
      discover: async () => ({
        discovered: 2,
        inserted: 2,
        duplicates: 0,
        filtered: 0,
        jobIds: [salary.jobId, straight.jobId],
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
          matched: [],
          missing: [],
          breakdown: {},
          evidence: {},
        }) as unknown as import("../lib/scoring.ts").JobAnalysis,
      prepare: async (jobId) => fakePackage(jobId),
      verifyVacancy: async () => openVacancyVerification(),
    },
  });
  assert.equal(outcome.simulated, 0);
  assert.equal(outcome.submitted, 1, "the straightforward form is submitted");
  assert.equal(outcome.intervention, 1, "the unanswerable salary form is queued, not invented");
  const salaryApp = db.one<{ status: string; submission_status: string | null }>(
    "SELECT status, submission_status FROM applications WHERE job_id = ?",
    [salary.jobId],
  );
  assert.equal(salaryApp?.status, "human_intervention_required");
  const straightApp = db.one<{ status: string; confirmation_ref: string | null }>(
    "SELECT status, confirmation_ref FROM applications WHERE job_id = ?",
    [straight.jobId],
  );
  assert.equal(straightApp?.status, "submitted");
  assert.equal(straightApp?.confirmation_ref, "APP-2026-0042");
  const open = db.all<{ question: string }>(
    "SELECT question FROM application_interventions WHERE application_id = ? AND status = 'open'",
    [salary.applicationId],
  );
  assert.ok(open.some((row) => /salary/i.test(row.question)));
  assert.match(runs.runById(created.run.id)?.report ?? "", /Standing authorisation and submission policy/);
});

test("a straightforward candidate form is completed from verified data only", async () => {
  const spark = makeJob({
    id: "direct_straight",
    title: "Senior QA Automation Engineer",
    company: "Direct Form AG",
    path: "/apply",
  });
  db.run("UPDATE applications SET status = 'ready_to_submit' WHERE id = ?", [spark.applicationId]);
  const plan = await candidateForms.prepareCandidateForm({
    pageUrl: `${base}/apply`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Direct Form AG",
    profile,
    documents,
  });
  assert.equal(plan.status, "ready");
  assert.equal(
    plan.questions.find((question) => question.category === "referral")?.action,
    "blank",
    "a nonessential unknown field is left blank rather than blocking the form",
  );
  const before = posts.length;
  const outcome = await submission.submitApplication(submissionInput(spark.jobId, spark.applicationId));
  assert.equal(outcome.status, "verified", outcome.detail);
  assert.equal(outcome.channel, "candidate_form");
  assert.equal(outcome.reference, "APP-2026-0042");
  const post = posts[posts.length - 1];
  assert.equal(posts.length, before + 1);
  assert.match(post.body, /csrf-fixture-123/, "hidden CSRF value is preserved");
  assert.match(post.body, /ada-lovelace-cv\.pdf/, "the tailored CV is uploaded");
  assert.match(post.body, /Ada Lovelace/, "verified name is submitted");
  const stored = db.one<{ status: string; submission_status: string; confirmation_ref: string }>(
    "SELECT status, submission_status, confirmation_ref FROM applications WHERE id = ?",
    [spark.applicationId],
  );
  assert.equal(stored?.status, "submitted");
  assert.equal(stored?.submission_status, "verified");
  assert.equal(stored?.confirmation_ref, "APP-2026-0042");
});

test("an application cannot bypass the persisted readiness gate", async () => {
  const { jobId, applicationId } = makeJob({
    id: "not_ready_job",
    title: "Senior QA Automation Engineer",
    company: "Not Ready AG",
    path: "/apply",
  });
  db.run(
    "UPDATE applications SET readiness = ? WHERE id = ?",
    [JSON.stringify({ ready: false, state: "blocked", reasons: ["fixture blocked"] }), applicationId],
  );
  const before = posts.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /readiness/i);
  assert.equal(posts.length, before, "a non-ready application is never posted");
  const stored = db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [applicationId]);
  assert.equal(stored?.status, "ready_to_submit", "the refusal does not pretend the application was sent");
});

test("atomic claim prevents concurrent workers from sending the same vacancy twice", async () => {
  const { jobId, applicationId } = makeJob({
    id: "race_job",
    title: "Senior QA Automation Engineer",
    company: "Race Form AG",
    path: "/apply",
  });
  const before = posts.length;
  const input = submissionInput(jobId, applicationId);
  const [first, second] = await Promise.all([
    submission.submitApplication(input),
    submission.submitApplication(input),
  ]);
  const verified = [first, second].filter((outcome) => outcome.status === "verified");
  assert.equal(verified.length, 1, "exactly one worker may send");
  assert.equal([first, second].filter((outcome) => outcome.status === "blocked").length, 1);
  assert.equal(posts.length, before + 1, "the vacancy is posted exactly once");
  const verifiedAttempts = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ? AND status = 'verified'",
    [jobId],
  );
  assert.equal(verifiedAttempts?.c, 1);
  const activeClaims = db.one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ? AND status = 'submitting'",
    [jobId],
  );
  assert.equal(activeClaims?.c, 0, "the winning claim was finalised, not left stale");
});

test("a stale submitting lease is recovered as unknown and never retried", async () => {
  const { jobId, applicationId } = makeJob({
    id: "stale_job",
    title: "Senior QA Automation Engineer",
    company: "Stale Claim AG",
    path: "/apply",
  });
  const staleAt = new Date(Date.now() - 10 * 60_000).toISOString();
  db.run("UPDATE applications SET status = 'submitting' WHERE id = ?", [applicationId]);
  db.run(
    `INSERT INTO submission_attempts (id, application_id, job_id, channel, status, attempted_at)
     VALUES ('sub_stale_fixture', ?, ?, 'candidate_form', 'submitting', ?)`,
    [applicationId, jobId, staleAt],
  );
  const before = posts.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked");
  assert.equal(posts.length, before, "a stale lease is not a safe retry");
  const stored = db.one<{ status: string; submission_status: string | null }>(
    "SELECT status, submission_status FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.equal(stored?.status, "submission_unverified");
  assert.equal(stored?.submission_status, "unverified");
  const stale = db.one<{ status: string }>("SELECT status FROM submission_attempts WHERE id = 'sub_stale_fixture'");
  assert.equal(stale?.status, "unverified");
});

test("an unknown essential answer, salary, notice and relocation all trigger intervention", async () => {
  const plan = await candidateForms.prepareCandidateForm({
    pageUrl: `${base}/questions`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Question Employer AG",
    profile,
    documents,
  });
  assert.equal(plan.status, "intervention");
  for (const category of ["salary", "notice", "relocation", "legal"]) {
    const question = plan.questions.find((item) => item.category === category);
    assert.ok(question, `${category} question is detected`);
    assert.equal(question!.action, "intervention");
    assert.equal(question!.consequential, true);
  }
  const postsBefore = posts.length;
  const result = await candidateForms.submitCandidateForm({ plan, documents });
  assert.equal(result.status, "blocked");
  assert.equal(result.evidence.sent, false);
  assert.equal(posts.length, postsBefore, "an intervention never POSTs the form");
});

test("explicitly authorised salary is used, but unauthorised relocation still stops the form", async () => {
  const salaryOnly = await candidateForms.prepareCandidateForm({
    pageUrl: `${base}/questions`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Question Employer AG",
    profile,
    documents,
    authorised: { salary_expectation: "CHF 120,000" },
  });
  assert.equal(salaryOnly.questions.find((item) => item.category === "salary")?.action, "answer");
  assert.equal(salaryOnly.questions.find((item) => item.category === "relocation")?.action, "intervention");
  assert.equal(salaryOnly.status, "intervention");
});

test("CAPTCHA and MFA stop the workflow before any POST", async () => {
  const before = posts.length;
  for (const path of ["/captcha", "/mfa"]) {
    const plan = await candidateForms.prepareCandidateForm({
      pageUrl: `${base}${path}`,
      jobTitle: "Senior QA Automation Engineer",
      company: "Security Employer AG",
      profile,
      documents,
    });
    assert.equal(plan.status, "security", path);
    const result = await candidateForms.submitCandidateForm({ plan, documents });
    assert.equal(result.status, "blocked");
  }
  assert.equal(posts.length, before, "security challenges never reach the form endpoint");
});

test("an ambiguous response is unverified and cannot be blindly retried", async () => {
  const { jobId, applicationId } = makeJob({
    id: "ambiguous_job",
    title: "Senior QA Automation Engineer",
    company: "Ambiguous Form AG",
    path: "/ambiguous",
  });
  const before = posts.length;
  const first = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(first.status, "unverified", first.detail);
  assert.equal(posts.length, before + 1);
  db.run("UPDATE applications SET status = 'ready_to_submit' WHERE id = ?", [applicationId]);
  const second = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(second.status, "blocked");
  assert.match(second.detail, /ambiguous|blind retry/i);
  assert.equal(posts.length, before + 1, "no second POST is attempted");
});

test("a duplicate application is blocked and does not create another attempt", async () => {
  const { jobId, applicationId } = makeJob({
    id: "duplicate_job",
    title: "Senior QA Automation Engineer",
    company: "Duplicate Form AG",
    path: "/apply",
  });
  const before = posts.length;
  const first = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(first.status, "verified");
  db.run("UPDATE applications SET status = 'ready_to_submit' WHERE id = ?", [applicationId]);
  const second = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(second.status, "blocked");
  assert.match(second.detail, /verified submission already exists/i);
  assert.equal(posts.length, before + 1, "the duplicate is not posted");
  assert.equal(
    db.one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ? AND status = 'verified'", [jobId])?.c,
    1,
    "exactly one verified attempt exists",
  );
});

test("the daily cap stops document preparation once today's verified submissions are used", async () => {
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 1 });
  const usage = policy.dailySubmissionUsage();
  assert.equal(usage.remaining, 0, "earlier verified submissions in this test file consume the one-per-day cap");
  const { jobId } = makeJob({
    id: "daily_cap_job",
    title: "Senior QA Automation Engineer",
    company: "Daily Cap AG",
    path: "/apply",
  });
  let prepareCalls = 0;
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
  const outcome = await runs.executeRun(created.run.id, {
    deps: {
      discover: async () => ({
        discovered: 1,
        inserted: 1,
        duplicates: 0,
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
          matched: [],
          missing: [],
          breakdown: {},
          evidence: {},
        }) as unknown as import("../lib/scoring.ts").JobAnalysis,
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("document preparation must not run at the daily cap");
      },
    },
  });
  assert.equal(outcome.qualified, 1);
  assert.equal(outcome.prepared, 0);
  assert.equal(prepareCalls, 0);
  assert.ok(outcome.warnings.some((warning) => /daily limit|daily cap/i.test(warning)));
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 3 });
});

test("a direct submission is blocked at the daily cap without losing its ready state", async () => {
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 1 });
  const { jobId, applicationId } = makeJob({
    id: "direct_cap_job",
    title: "Senior QA Automation Engineer",
    company: "Direct Cap AG",
    path: "/apply",
  });
  const before = posts.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /daily limit/i);
  assert.equal(posts.length, before, "the cap is enforced immediately before sending");
  const stored = db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [applicationId]);
  assert.equal(stored?.status, "ready_to_submit", "the package remains queued for the next day");
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 3 });
});

test("the daily limit is three verified submissions and policy edits cannot widen or lower the floors", () => {
  const future = new Date("2031-06-15T12:00:00.000Z");
  const dayStart = policy.startOfRecruitmentDay(future).toISOString();
  const at = new Date(Date.parse(dayStart) + 3600_000).toISOString();
  for (let index = 0; index < 3; index += 1) {
    db.run(
      `INSERT INTO submission_attempts (id, application_id, job_id, channel, status, reference, attempted_at)
       VALUES (?, ?, ?, 'candidate_form', 'verified', ?, ?)`,
      [`future_${index}`, `future_app_${index}`, `future_job_${index}`, `FUTURE-${index}`, at],
    );
  }
  const usage = policy.dailySubmissionUsage(future);
  assert.equal(usage.verified, 3);
  assert.equal(usage.remaining, 0);
  assert.equal(usage.limit, 3);

  const edited = policy.saveRecruitmentPolicy({
    autonomousSubmission: true,
    minMatchScore: 10,
    maxSubmissionsPerDay: 99,
  });
  assert.equal(edited.minMatchScore, 85, "the threshold floor cannot be lowered");
  assert.equal(edited.maxSubmissionsPerDay, 10, "the hard cap is enforced");
  policy.saveRecruitmentPolicy({ autonomousSubmission: true, minMatchScore: 85, maxSubmissionsPerDay: 3 });
  assert.equal(policy.dailySubmissionUsage(future).remaining, 0);
});
