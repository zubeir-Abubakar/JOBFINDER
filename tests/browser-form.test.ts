import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Controlled ATS fixtures for the local Playwright executor.
 *
 * Every page and endpoint is on 127.0.0.1. No real employer, aggregator or ATS
 * is contacted. The forms are rendered by JavaScript after the initial response,
 * so the server-rendered HTTP parser cannot see them and the browser fallback is
 * the only channel that can submit them.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-browser-form-"));
process.env.APP_SECRET_KEY = "browser-form-test";
process.env.RECRUITMENT_CANDIDATE_FORMS = "true";
process.env.RECRUITMENT_BROWSER_FORMS = "true";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const POSTS: Array<{ path: string; body: string; contentType: string }> = [];

function fields(extra = ""): string {
  return [
    '<input type="hidden" name="csrf_token" value="js-fixture-token-9001">',
    '<label for="full_name">Full name</label><input id="full_name" name="full_name" required>',
    '<label for="email">Email</label><input id="email" name="email" type="email" required>',
    '<label for="phone">Phone</label><input id="phone" name="phone" required>',
    '<label for="work_authorisation">Work authorisation</label><input id="work_authorisation" name="work_authorisation" required>',
    '<label for="resume">Resume / CV</label><input id="resume" name="resume" type="file" required>',
    '<label for="cover_letter">Cover letter</label><textarea id="cover_letter" name="cover_letter"></textarea>',
    '<label for="how">How did you hear about us?</label><input id="how" name="how_did_you_hear">',
    extra,
    '<button type="submit">Submit application</button>',
  ].join("");
}

/** The <form> tag is built with the DOM API so the static HTML contains none. */
function dynamicPage(extra = "", action = "/dynamic-submit"): string {
  return `<!doctype html><html><body>
<div id="root">Loading application…</div>
<script>
setTimeout(function () {
  var root = document.getElementById('root');
  var form = document.createElement('form');
  form.method = 'post';
  form.action = ${JSON.stringify(action)};
  form.enctype = 'multipart/form-data';
  form.innerHTML = ${JSON.stringify(fields(extra))};
  root.appendChild(form);
}, 120);
</script>
</body></html>`;
}

function wizardStepOnePage(): string {
  return `<!doctype html><html><body>
<h1>Application · step 1 of 2</h1>
<form method="get" action="/wizard-step2">
  <label for="full_name">Full name</label><input id="full_name" name="full_name" required>
  <label for="email">Email</label><input id="email" name="email" type="email" required>
  <label for="phone">Phone</label><input id="phone" name="phone" required>
  <label for="work_authorisation">Work authorisation</label><input id="work_authorisation" name="work_authorisation" required>
  <button id="wizard-next" type="submit">Next</button>
</form>
</body></html>`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function wizardStepTwoPage(searchParams: URLSearchParams): string {
  const carried = ["full_name", "email", "phone", "work_authorisation"]
    .map((name) => `<input type="hidden" name="${name}" value="${escapeAttribute(searchParams.get(name) ?? "")}">`)
    .join("");
  return `<!doctype html><html><body>
<h1>Application · step 2 of 2</h1>
<form method="post" action="/wizard-submit" enctype="multipart/form-data">
  ${carried}
  <label for="resume">Resume / CV</label><input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx" required>
  <label for="cover_file">Cover letter file</label><input id="cover_file" name="cover_file" type="file" accept=".pdf,.doc,.docx" required>
  <label for="cover_letter">Cover letter text</label><textarea id="cover_letter" name="cover_letter"></textarea>
  <label for="how">How did you hear about us?</label><input id="how" name="how_did_you_hear">
  <button id="wizard-submit" type="submit">Submit application</button>
</form>
</body></html>`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET") {
    if (url.pathname === "/dynamic") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(dynamicPage());
      return;
    }
    if (url.pathname === "/dynamic-legal") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        dynamicPage(
          '<label for="legal"><input id="legal" type="checkbox" name="legal_declaration" required> I certify that the information is true and complete</label>',
        ),
      );
      return;
    }
    if (url.pathname === "/dynamic-unknown") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        dynamicPage(
          '<label for="favourite_editor">Favourite editor</label><input id="favourite_editor" name="favourite_editor" required>',
        ),
      );
      return;
    }
    if (url.pathname === "/dynamic-captcha") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        dynamicPage(
          '<div class="g-recaptcha" data-sitekey="fixture" style="width:304px;height:78px"></div>',
        ),
      );
      return;
    }
    if (url.pathname === "/dynamic-500") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(dynamicPage("", "/dynamic-500-submit"));
      return;
    }
    if (url.pathname === "/wizard") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(wizardStepOnePage());
      return;
    }
    if (url.pathname === "/wizard-step2") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(wizardStepTwoPage(url.searchParams));
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
    POSTS.push({ path: url.pathname, body, contentType: String(req.headers["content-type"] ?? "") });
    if (url.pathname === "/dynamic-500-submit") {
      res.writeHead(500, { "Content-Type": "text/html" });
      res.end("<html><body><h1>Server error</h1></body></html>");
      return;
    }
    if (url.pathname === "/wizard-submit") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h1>Thank you for applying</h1><p>Your application was received.</p><p>Reference: WIZ-2026-4242</p></body></html>",
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<html><body><h1>Thank you for applying</h1><p>We have received your application.</p><p>Reference: DYN-2026-9001</p></body></html>",
    );
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

after(() => {
  server.close();
});

const db = await import("../lib/db.ts");
const submission = await import("../lib/submission.ts");
import type { CandidateDocuments, CandidateProfile } from "../lib/candidate-forms.ts";

db.getDb();
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE profiles SET email = ?, phone = ?, work_authorisation = ? WHERE id = 1", [
  "ada@example.com",
  "+41 79 000 00 00",
  "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
]);

mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "browser-cv.pdf"), "%PDF-1.4 browser fixture CV");
writeFileSync(join(db.UPLOAD_DIR, "browser-cover.pdf"), "%PDF-1.4 browser fixture cover");

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
  cv: { buffer: Buffer.from("%PDF-1.4 browser tailored"), name: "browser-cv.pdf" },
  cover: { buffer: Buffer.from("%PDF-1.4 browser cover"), name: "browser-cover.pdf" },
  coverText:
    "Dear Fixture team, I am applying for the Senior QA Automation Engineer role. I use Playwright and API testing for payment platforms.",
};

const STRONG_DESCRIPTION = [
  "We are hiring a senior quality engineer with 5+ years of software testing experience.",
  "You will own test automation with Playwright and Cypress, build REST API tests and run CI pipelines.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "English is required. This is a full-time role.",
].join(" ");

function makeJob(input: { id: string; path?: string; url?: string }) {
  const applicationUrl = input.url ?? `${base}${input.path ?? "/dynamic"}`;
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, remote, employment_type, url, application_url, description, published_at, discovered_at, status, dedupe_key, match_score)
     VALUES (?, 'manual', ?, 'Senior QA Automation Engineer', 'Dynamic Fixture AG', 'Zürich, Switzerland', 0, 'Full-time', ?, ?, ?, ?, ?, 'new', ?, 95)`,
    [
      input.id,
      `ext-${input.id}`,
      applicationUrl,
      applicationUrl,
      STRONG_DESCRIPTION,
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
    id: string;
    title: string;
    company: string;
    url: string | null;
    application_url: string | null;
    description: string | null;
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
      cvPath: "browser-cv.pdf",
      cvName: "browser-cv.pdf",
      coverPath: "browser-cover.pdf",
      coverName: "browser-cover.pdf",
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

function stored(applicationId: string) {
  const row = db.one<{
    status: string;
    submission_status: string | null;
    submission_evidence: string | null;
    approved_at: string | null;
    confirmation_ref: string | null;
  }>(
    "SELECT status, submission_status, submission_evidence, approved_at, confirmation_ref FROM applications WHERE id = ?",
    [applicationId],
  );
  assert.ok(row);
  return {
    ...row!,
    evidence: JSON.parse(row!.submission_evidence ?? "{}") as Record<string, unknown>,
  };
}

test("a JavaScript-rendered ATS form is submitted automatically and verified without approval", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "browser_verified" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "verified", outcome.detail);
  assert.equal(outcome.channel, "candidate_form");
  assert.equal(outcome.reference, "DYN-2026-9001");
  assert.equal(POSTS.length, before + 1, "the dynamic form is posted exactly once");
  const post = POSTS[POSTS.length - 1];
  assert.equal(post.path, "/dynamic-submit");
  assert.match(post.contentType, /multipart\/form-data/);
  assert.match(post.body, /js-fixture-token-9001/, "hidden CSRF value is preserved by the browser form");
  assert.match(post.body, /Ada Lovelace/, "verified name is filled");
  assert.match(post.body, /browser-cv\.pdf/, "tailored CV is uploaded");
  assert.match(post.body, /Dear Fixture team/, "verified cover letter text is filled");

  const row = stored(applicationId);
  assert.equal(row.status, "submitted");
  assert.equal(row.submission_status, "verified");
  assert.equal(row.confirmation_ref, "DYN-2026-9001");
  assert.equal(row.approved_at, null, "no per-application approval flag was needed");
  assert.equal(row.evidence.outcomeClass, "submitted_verified");
  assert.equal(row.evidence.executor, "playwright");
});

test("a two-step ATS wizard uploads both documents and submits exactly once", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "wizard_verified", path: "/wizard" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "verified", outcome.detail);
  assert.equal(outcome.channel, "candidate_form");
  assert.equal(outcome.reference, "WIZ-2026-4242");
  assert.equal(POSTS.length, before + 1, "the wizard's final step is posted exactly once");
  const post = POSTS[POSTS.length - 1];
  assert.equal(post.path, "/wizard-submit");
  assert.match(post.contentType, /multipart\/form-data/);
  assert.match(post.body, /Ada Lovelace/);
  assert.match(post.body, /browser-cv\.pdf/, "the CV is uploaded in step 2");
  assert.match(post.body, /browser-cover\.pdf/, "the cover-letter file is uploaded in step 2");
  assert.match(post.body, /Dear Fixture team/, "the verified cover text is retained");

  const row = stored(applicationId);
  assert.equal(row.status, "submitted");
  assert.equal(row.submission_status, "verified");
  assert.equal(row.confirmation_ref, "WIZ-2026-4242");
  assert.equal(row.approved_at, null, "no per-application approval was required");
  assert.equal(row.evidence.outcomeClass, "submitted_verified");
  assert.equal(row.evidence.executor, "playwright");
});

test("a required unknown question leaves the package prepared but not submitted", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "browser_prepared", path: "/dynamic-unknown" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked", outcome.detail);
  assert.match(outcome.detail, /favourite editor|not covered by verified profile/i);
  assert.equal(POSTS.length, before, "nothing is posted when a required fact is not verified");
  const row = stored(applicationId);
  assert.equal(row.status, "human_intervention_required");
  assert.equal(row.evidence.outcomeClass, "prepared_not_submitted");
  assert.equal(row.evidence.sent, false);
});

test("a JavaScript-rendered CAPTCHA is an external blocker and is never bypassed", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "browser_captcha", path: "/dynamic-captcha" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked", outcome.detail);
  assert.match(outcome.detail, /captcha/i);
  assert.equal(POSTS.length, before, "no request is made when a CAPTCHA is present");
  const row = stored(applicationId);
  assert.equal(row.status, "human_intervention_required");
  assert.equal(row.evidence.externalRequirement, "security_challenge");
  assert.equal(row.evidence.outcomeClass, "blocked_external");
});

test("an ambiguous legal declaration is an external blocker, not a routine approval gate", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "browser_legal", path: "/dynamic-legal" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked", outcome.detail);
  assert.match(outcome.detail, /legal declaration/i);
  assert.equal(POSTS.length, before, "the legal declaration is never accepted on the owner's behalf");
  const row = stored(applicationId);
  assert.equal(row.evidence.externalRequirement, "legal_declaration");
  assert.equal(row.evidence.outcomeClass, "blocked_external");
  const intervention = db.one<{ kind: string }>(
    "SELECT kind FROM application_interventions WHERE application_id = ? AND status = 'open'",
    [applicationId],
  );
  assert.equal(intervention?.kind, "legal");
});

test("a technical browser failure is recorded as failed, not as awaiting approval", { timeout: 90_000 }, async () => {
  // A closed loopback port is an unreachable employer page, not a real request.
  const { jobId, applicationId } = makeJob({ id: "browser_technical", url: "http://127.0.0.1:1/apply" });
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "failed", outcome.detail);
  assert.match(outcome.detail, /nothing was sent/i);
  assert.equal(POSTS.length, before);
  const row = stored(applicationId);
  assert.equal(row.status, "submission_failed");
  assert.equal(row.submission_status, "failed");
  assert.equal(row.evidence.outcomeClass, "failed_technical");
});

test("a channel-level CAPTCHA declaration is classified as an external blocker", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "manual_captcha", path: "/dynamic" });
  db.run("UPDATE jobs SET description = ? WHERE id = ?", [
    `${STRONG_DESCRIPTION} Applications are protected by a CAPTCHA on the employer portal.`,
    jobId,
  ]);
  const before = POSTS.length;
  const outcome = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(outcome.status, "blocked", outcome.detail);
  assert.match(outcome.detail, /captcha/i);
  assert.equal(POSTS.length, before, "the employer is never contacted for a declared CAPTCHA");
  const row = stored(applicationId);
  assert.equal(row.status, "human_intervention_required");
  assert.equal(row.evidence.externalRequirement, "captcha");
  assert.equal(row.evidence.outcomeClass, "blocked_external");
});

test("an uncertain POST outcome is unverified and is never retried blindly", { timeout: 90_000 }, async () => {
  const { jobId, applicationId } = makeJob({ id: "browser_uncertain", path: "/dynamic-500" });
  const before = POSTS.length;
  const first = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(first.status, "failed", first.detail);
  assert.equal(first.httpStatus, 500);
  assert.match(first.detail, /delivery is unknown/i);
  assert.equal(POSTS.length, before + 1);
  let row = stored(applicationId);
  assert.equal(row.status, "submission_unverified");
  assert.equal(row.submission_status, "unverified");
  assert.equal(row.evidence.outcomeClass, "outcome_uncertain");

  db.run("UPDATE applications SET status = 'ready_to_submit' WHERE id = ?", [applicationId]);
  const second = await submission.submitApplication(submissionInput(jobId, applicationId));
  assert.equal(second.status, "blocked");
  assert.match(second.detail, /ambiguous|blind retry/i);
  assert.equal(POSTS.length, before + 1, "the uncertain submission is not sent twice");
  row = stored(applicationId);
  assert.equal(row.status, "submission_unverified");
});
