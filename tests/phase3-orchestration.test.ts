import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startAtsFixture } from "../e2e/ats-fixture/server.ts";
import { newToken, sha256 } from "../lib/security.ts";
import { openVacancyVerification } from "./helpers/open-vacancy.ts";

/**
 * Phase 3 — full recruitment-to-application orchestration.
 *
 * This test drives the real daily-run orchestrator, persistent queue,
 * destination preflight, package generator, readiness gate, Playwright executor
 * and application/queue persistence. Only discovery and the live vacancy check
 * are injected, because they are external systems outside this proof. Every
 * HTTP request the executor makes goes to a loopback JavaScript ATS fixture.
 */

process.env.OUTBOUND_ALLOW_PRIVATE = "true";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase3-orchestration-"));
process.env.APP_SECRET_KEY = "phase3-orchestration-test";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_CANDIDATE_FORMS = "true";
process.env.RECRUITMENT_BROWSER_FORMS = "true";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const fixture = await startAtsFixture();

const db = await import("../lib/db.ts");
const policy = await import("../lib/recruitment-policy.ts");
const runs = await import("../lib/recruitment-run.ts");
const submission = await import("../lib/submission.ts");
const queue = await import("../lib/recruitment-queue.ts");

db.getDb();

const OWNER_ID = "user_phase3_browser";
db.run(
  `INSERT OR IGNORE INTO users (id, email, password_hash, name, role, status, created_at)
   VALUES (?, 'phase3-browser@example.test', 'unused-synthetic-session', 'Phase 3 Browser Owner', 'owner', 'active', ?)`,
  [OWNER_ID, new Date().toISOString()],
);

after(async () => {
  await fixture.close();
  db.closeDb();
});

db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE settings SET value = 'true' WHERE key = 'autonomous_submission'");
db.run("UPDATE settings SET value = 'false' WHERE key = 'approval_mode'");
policy.activateStandingAuthorisation("phase3-owner");

mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "phase3-master.pdf"), "%PDF-1.4 phase 3 master CV");

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
   VALUES ('doc_phase3_master', 'system', 'original_cv', 'Master CV', 'phase3-master.pdf', 'application/pdf',
     'phase3-master.pdf', 1200, 'ready', ?, ?)`,
  [MASTER_TEXT, new Date().toISOString()],
);
db.run(
  `UPDATE profiles SET full_name = 'Ada Lovelace', email = 'ada@example.com', phone = '+41 79 000 00 00',
     location = 'Zürich, Switzerland', work_authorisation = 'Swiss Permit B — authorised to work without employer sponsorship',
     languages = '["English (C1)","French (B2)"]', source_cv_id = 'doc_phase3_master' WHERE id = 1`,
);
db.run(
  "INSERT INTO skills (name, category, level, years, verified, source, sort) VALUES ('Playwright', 'Automation', 'advanced', 4, 1, 'cv', 1)",
);

const DESCRIPTION = [
  "We are hiring a Senior QA Automation Engineer for our fintech payments platform.",
  "You will own Playwright test automation, API testing, release readiness and TypeScript test code.",
  "You will work with engineering and product teams on regression testing and quality gates.",
  "Swiss work authorisation is required; sponsorship is not offered. English is required.",
  "Contact: Lena Frei, Talent Acquisition Partner, lena.frei@northstar.example.",
].join(" ");

const ANALYSIS = {
  score: 95,
  flag: "strong",
  concerns: [],
  mandatoryBlockers: [],
  preferences: [],
  criteria: [],
  matched: ["Playwright", "API testing", "release readiness"],
  missing: [],
  breakdown: { technical: 95, experience: 95, seniority: 95, language: 95, location: 100, salary: 90 },
  evidence: {},
  disclaimer: "Fixture analysis for a synthetic vacancy.",
};

const jobId = "job_phase3_northstar";
db.run(
  `INSERT INTO jobs
     (id, source, external_id, title, company, location, remote, url, application_url, employer_url, url_confidence, description,
      published_at, discovered_at, status, dedupe_key, canonical_key, employer_key, match_score, analysis,
      eligibility, eligibility_notes, eligibility_checked_at, qualified, qualification_status, vacancy_status,
      vacancy_verified_at, german_requirement)
   VALUES (?, 'manual', 'phase3-northstar', 'Senior QA Automation Engineer', 'Northstar Synthetic AG',
     'Zürich, Switzerland', 0, 'https://northstar.example/jobs/qa', ?, 'https://northstar.example', 'direct', ?, ?, ?, 'shortlisted',
     'phase3-northstar', 'phase3|northstar|qa', 'northstar synthetic', 95, ?, 'eligible', '{}', ?,
     1, 'qualified', 'open', ?, 'none')`,
  [
    jobId,
    `${fixture.baseUrl}/ats`,
    DESCRIPTION,
    new Date().toISOString(),
    new Date().toISOString(),
    JSON.stringify(ANALYSIS),
    new Date().toISOString(),
    new Date().toISOString(),
  ],
);

const run = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
assert.equal(run.created, true);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseURL: string, child: ReturnType<typeof spawn>, logs: () => string): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Temporary Next server exited before becoming ready.\n${logs()}`);
    try {
      const response = await fetch(`${baseURL}/login`, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Temporary Next server did not become ready within 120s.\n${logs()}`);
}

/**
 * Open the real persisted application in a browser against the same test
 * database, reload it, and verify the receipt and full event history. The
 * synthetic session is inserted directly, so no password or external auth
 * service is involved.
 */
async function assertDetailPageSurvivesReload(applicationId: string): Promise<void> {
  const sessionToken = newToken();
  const expires = new Date(Date.now() + 60 * 60_000).toISOString();
  db.run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, '127.0.0.1', 'phase3-browser')",
    [sha256(sessionToken), OWNER_ID, new Date().toISOString(), expires],
  );

  const events = db.all<{ type: string; message: string | null }>(
    "SELECT type, message FROM application_events WHERE application_id = ? ORDER BY id",
    [applicationId],
  );
  const prepared = events.find((event) => event.type === "documents.prepared")?.message;
  const verified = events.find((event) => event.type === "submission.verified")?.message;
  assert.ok(prepared, "the generated-package event is persisted before the browser check");
  assert.ok(verified, "the verified-submission event is persisted before the browser check");

  const port = await freePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const hasBuild = existsSync(join(process.cwd(), ".next/BUILD_ID"));
  const nextBin = join(process.cwd(), "node_modules/next/dist/bin/next");
  let logs = "";
  const child = spawn(
    process.execPath,
    [nextBin, hasBuild ? "start" : "dev", "-H", "127.0.0.1", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: hasBuild ? "production" : "development",
        NEXT_TELEMETRY_DISABLED: "1",
        DATA_DIR: process.env.DATA_DIR,
        APP_SECRET_KEY: process.env.APP_SECRET_KEY,
        RECRUITMENT_SCHEDULER: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => {
    logs = `${logs}${String(chunk)}`.slice(-12_000);
  });
  child.stderr?.on("data", (chunk) => {
    logs = `${logs}${String(chunk)}`.slice(-12_000);
  });

  const browser = await chromium.launch({ headless: true });
  try {
    await waitForServer(baseURL, child, () => logs);
    const context = await browser.newContext({ baseURL });
    await context.addCookies([
      {
        name: "atw_session",
        value: sessionToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    const attemptsBefore = Number(
      db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n,
    );

    const assertReceipt = async (): Promise<void> => {
      await page.getByRole("heading", { name: "Senior QA Automation Engineer — Northstar Synthetic AG", level: 1 }).waitFor();
      await page.getByText("ATS-2026-1001", { exact: true }).first().waitFor();
      await page.getByText(/employer-confirmed/).first().waitFor();
      await page.getByText(/Tailored CV/).first().waitFor();
      await page.getByRole("heading", { name: "Hiring-manager outreach" }).waitFor();
      await page.getByText(/Gmail draft created — not sent/).first().waitFor();
      const history = page.locator("section.card", { hasText: "History" });
      await history.getByText(prepared!, { exact: true }).waitFor();
      await history.getByText(verified!, { exact: true }).waitFor();
      await history.getByText(/documents\.prepared/).waitFor();
      await history.getByText(/submission\.verified/).waitFor();
    };

    await page.goto(`/applications/${applicationId}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await assertReceipt();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await assertReceipt();

    assert.equal(
      Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n),
      attemptsBefore,
      "reloading the detail page created no duplicate submission attempt",
    );
    assert.equal(attemptsBefore, 1, "the browser check used the single verified Phase 3 attempt");
    assert.equal(
      db.one<{ state: string }>("SELECT state FROM recruitment_queue WHERE job_id = ?", [jobId])?.state,
      "confirmed",
    );
    await context.close();
  } finally {
    await browser.close();
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(undefined);
      }, 5_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
}

test("the real orchestration prepares, validates, submits and survives a browser reload", { timeout: 240_000 }, async () => {
  const outcome = await runs.executeRun(run.run.id, {
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
      analyse: () => ANALYSIS as never,
      verifyVacancy: async () => openVacancyVerification(),
    },
  });

  assert.equal(outcome.prepared, 1, "one validated package was prepared by the real generator");
  assert.equal(outcome.submitted, 1, `run did not verify the submission: ${outcome.warnings.join(" | ")}`);
  assert.equal(outcome.intervention, 0);

  const app = db.one<{
    id: string;
    status: string;
    submission_status: string;
    submission_state: string;
    confirmation: string | null;
    confirmation_ref: string | null;
    submitted_at: string | null;
    cv_document_id: string;
    cover_letter_id: string;
    readiness: string;
  }>(
    `SELECT id, status, submission_status, submission_state, confirmation, confirmation_ref, submitted_at,
       cv_document_id, cover_letter_id, readiness FROM applications WHERE job_id = ?`,
    [jobId],
  );
  assert.ok(app);
  assert.equal(app!.status, "submitted");
  assert.equal(app!.submission_status, "verified");
  assert.equal(app!.confirmation_ref, "ATS-2026-1001");
  assert.equal(app!.confirmation, "ATS-2026-1001");
  assert.ok(app!.submitted_at);

  const attempt = db.one<{
    status: string;
    reference: string | null;
    idempotency_key: string | null;
    destination: string | null;
    started_at: string | null;
    reconciliation_state: string | null;
  }>(
    `SELECT status, reference, idempotency_key, destination, started_at, reconciliation_state
     FROM submission_attempts WHERE job_id = ? ORDER BY attempted_at DESC LIMIT 1`,
    [jobId],
  );
  assert.equal(attempt?.status, "verified");
  assert.equal(attempt?.reference, "ATS-2026-1001");
  assert.match(attempt?.idempotency_key ?? "", new RegExp(`^submission:${jobId}:sub_`));
  assert.equal(attempt?.destination, `${fixture.baseUrl}/ats/apply`, "the persisted destination is the actual irreversible endpoint");
  assert.ok(attempt?.started_at);
  assert.equal(attempt?.reconciliation_state, "confirmed");

  const cv = db.one<{ id: string; job_id: string; quality_status: string; text_content: string }>(
    "SELECT id, job_id, quality_status, text_content FROM documents WHERE id = ?",
    [app!.cv_document_id],
  );
  const cover = db.one<{ id: string; job_id: string; quality_status: string; text_content: string }>(
    "SELECT id, job_id, quality_status, text_content FROM documents WHERE id = ?",
    [app!.cover_letter_id],
  );
  assert.equal(cv?.job_id, jobId);
  assert.equal(cover?.job_id, jobId);
  assert.equal(cv?.quality_status, "passed");
  assert.equal(cover?.quality_status, "passed");
  assert.match(cv?.text_content ?? "", /Northstar Synthetic AG/);
  assert.match(cover?.text_content ?? "", /Northstar Synthetic AG/);
  const readiness = JSON.parse(app!.readiness ?? "{}") as { state?: string };
  assert.equal(readiness.state, "ready_for_submission");

  assert.equal(fixture.state.submissions.length, 1);
  const received = fixture.state.submissions[0];
  assert.equal(received.reference, "ATS-2026-1001");
  assert.equal(received.fields.full_name, "Ada Lovelace");
  assert.equal(received.fields.email, "ada@example.com");
  assert.equal(received.fields.country, "Switzerland");
  assert.equal(received.fields.languages, "English (C1)");
  assert.ok(received.files.some((file) => file.field === "resume" && file.filename.endsWith(".pdf")));
  assert.ok(received.files.some((file) => file.field === "cover_file" && file.filename.endsWith(".pdf")));

  const snapshot = queue.queueSnapshot().find((row) => row.jobId === jobId);
  assert.equal(snapshot?.state, "confirmed");
  const events = db.all<{ type: string }>("SELECT type FROM application_events WHERE application_id = ?", [app!.id]);
  assert.ok(events.some((event) => event.type === "documents.prepared"));
  assert.ok(events.some((event) => event.type === "submission.verified"));

  const queueEvents = db.all<{ to_state: string }>("SELECT to_state FROM recruitment_queue_events WHERE job_id = ?", [jobId]);
  assert.ok(queueEvents.some((event) => event.to_state === "submitting"), "browser execution was visible in the queue");
  assert.ok(queueEvents.some((event) => event.to_state === "confirmed"));

  const report = runs.runById(run.run.id)?.report ?? "";
  assert.match(report, /Rayna · COMPLETED/, "a finished run must not show the tracking agent as still running");
  assert.match(report, /8 of 8 agents succeeded/);

  assert.ok(submission.existingVerifiedSubmission(jobId), "the verified reference is persisted for duplicate prevention");

  const outreach = await import("../lib/outreach.ts");
  const draftResult = await outreach.prepareOutreachForApplication({
    applicationId: app!.id,
    draftGateway: async (input) => {
      assert.equal(input.to, "lena.frei@northstar.example");
      assert.equal(input.attachments.length, 2);
      assert.match(input.attachments[0].content.toString("latin1"), /^%PDF/);
      assert.match(input.attachments[1].content.toString("latin1"), /^%PDF/);
      assert.match(input.body, /Senior QA Automation Engineer/);
      assert.match(input.body, /Northstar Synthetic AG/);
      return { draftId: "gmail-phase3-draft", messageId: "gmail-phase3-message", threadId: "gmail-phase3-thread", rfcMessageId: "<phase3@northstar.example>" };
    },
  });
  assert.equal(draftResult.status, "draft_created", draftResult.detail);
  assert.equal(db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [app!.id])?.status, "submitted");
  assert.equal(db.one<{ status: string }>("SELECT status FROM outreach_drafts WHERE application_id = ?", [app!.id])?.status, "draft_created");

  await assertDetailPageSurvivesReload(app!.id);
});

test("a second execution of the completed run reuses evidence and sends nothing", { timeout: 30_000 }, async () => {
  const before = fixture.state.submissions.length;
  const again = await runs.executeRun(run.run.id);
  assert.ok(["completed", "completed_with_warnings"].includes(again.status));
  assert.equal(fixture.state.submissions.length, before);
  assert.equal(
    Number(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts WHERE job_id = ?", [jobId])?.n),
    1,
    "the verified attempt was not duplicated",
  );
});
