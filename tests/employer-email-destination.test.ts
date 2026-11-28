import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Employer email destinations: a job-board quick-apply vacancy whose employer
 * publishes an email address instead of a web form. The address must come from
 * the employer's own page, match the employer domain, and remain a human
 * handoff. Nothing is submitted and no document is generated.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-employer-email-"));
process.env.APP_SECRET_KEY = "employer-email-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;

const db = await import("../lib/db.ts");
const { extractVerifiedEmployerEmail, resolveEmployerEmailDestination } = await import("../lib/employer-contact.ts");
const { clearEmployerEmailDestination, persistEmployerEmailDestination } = await import("../lib/jobs-ch-resolution.ts");
const queue = await import("../lib/recruitment-queue.ts");
const { markEmailHandoffSent } = await import("../lib/email-handoff.ts");
const { channelFor } = await import("../lib/submission.ts");
const { migrationStatus } = await import("../lib/migrations.ts");

const NOW = new Date("2026-11-27T20:00:00.000Z");
const at = NOW.toISOString();
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

const HIDDEN_MAIL = `<joomla-hidden-mail is-link="1" is-email="0" first="${b64("careers")}" last="${b64("telecom26.ch")}" text="${b64(
  "<span>careers@telecom26.ch</span>",
)}" base="">This email address is being protected from spambots.</joomla-hidden-mail>`;

function response(html: string): Response {
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}

test("migration version 2 adds the employer email destination columns", () => {
  const status = migrationStatus(db.getDb());
  assert.ok(status.version >= 2);
  const columns = db.all<{ name: string }>("PRAGMA table_info(jobs)");
  assert.ok(columns.some((column) => column.name === "application_email"));
});

test("Joomla hidden-mail is decoded and only the employer domain is accepted", () => {
  const found = extractVerifiedEmployerEmail(
    `<p>Contact us: ${HIDDEN_MAIL}</p>`,
    "telecom26.ch",
    "https://www.telecom26.ch/about/careers/test-engineer-100-in-zug",
  );
  assert.equal(found?.email, "careers@telecom26.ch");
  assert.equal(found?.method, "joomla_hidden_mail");

  const mismatch = extractVerifiedEmployerEmail(
    `<a href="mailto:recruiter@example.com">apply</a>`,
    "telecom26.ch",
    "https://www.telecom26.ch/about/careers",
  );
  assert.equal(mismatch, null, "a third-party address is not the employer destination");
});

test("a quick-apply listing resolves to the employer's published email through its own pages", async () => {
  const listing = "https://www.jobs.ch/en/vacancies/detail/telecom26-test-engineer/";
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = (typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url).replace(
      "://www.",
      "://",
    );
    if (url.includes("/vacancies/detail/")) return response(`<a href="https://www.telecom26.ch/">Telecom26 AG</a>`);
    if (url.includes("test-engineer-100-in-zug")) {
      return response(`<p>For more information or to submit a CV, please contact us: ${HIDDEN_MAIL}</p>`);
    }
    if (url.includes("/about/careers")) {
      return response(`<a href="/about/careers/test-engineer-100-in-zug">Test Engineer, 100% in Zug</a>`);
    }
    if (url.includes("telecom26.ch")) return response(`<nav><a href="/about/careers">Careers</a></nav>`);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const resolution = await resolveEmployerEmailDestination({
    listingUrl: listing,
    title: "Test Engineer",
    company: "Telecom26 AG",
    fetchImpl,
    timeoutMs: 3_000,
  });
  assert.equal(resolution.ok, true, `${resolution.reason} :: ${JSON.stringify(resolution.evidence)}`);
  assert.equal(resolution.email, "careers@telecom26.ch");
  assert.equal(resolution.employerVacancyUrl, "https://telecom26.ch/about/careers/test-engineer-100-in-zug");
});

test("a persisted email destination becomes a visible human handoff, never an automatic package", () => {
  const jobId = "job_telecom26_fixture";
  db.run(
    `INSERT INTO jobs
       (id, source, external_id, title, company, location, url, application_url, url_confidence, description,
        discovered_at, status, match_score, eligibility, qualified, vacancy_status, german_requirement, canonical_key)
     VALUES (?, 'jobs_ch', '6356cbdb', 'Test Engineer', 'Telecom26 AG', 'Zug',
             'https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a/',
             NULL, 'unresolved', 'Test automation in Python for mobile services.', ?, 'new', 92, 'eligible', 1,
             'open', 'none', 'telecom26|test-engineer')`,
    [jobId, at],
  );
  const stored = persistEmployerEmailDestination(jobId, {
    email: "careers@telecom26.ch",
    employerVacancyUrl: "https://www.telecom26.ch/about/careers/test-engineer-100-in-zug",
    employerSite: "https://www.telecom26.ch/",
    reason: "The employer's own page publishes careers@telecom26.ch.",
    evidence: { emailMethod: "joomla_hidden_mail" },
    verifiedAt: at,
  });
  assert.equal(stored.stored, true);
  queue.syncQualifiedQueue({ actor: "test", now: NOW });

  const row = db.one<{ application_email: string; url_confidence: string; application_url: string | null }>(
    "SELECT application_email, url_confidence, application_url FROM jobs WHERE id = ?",
    [jobId],
  );
  assert.equal(row?.application_email, "careers@telecom26.ch");
  assert.equal(row?.url_confidence, "email");
  assert.equal(row?.application_url, null, "no web form is invented");

  const queueRow = db.one<{ state: string; reason: string }>(
    "SELECT state, reason FROM recruitment_queue WHERE job_id = ?",
    [jobId],
  );
  assert.equal(queueRow?.state, "awaiting_human");
  assert.match(queueRow?.reason ?? "", /email/i);

  const channel = channelFor({
    id: jobId,
    title: "Test Engineer",
    company: "Telecom26 AG",
    url: "https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a/",
    application_url: null,
    url_confidence: "email",
    application_email: "careers@telecom26.ch",
    description: "Test automation.",
  });
  assert.equal(channel.channel, "manual");
  assert.match(channel.reason, /email/i);
  assert.equal(queue.validPackageFor(jobId), null, "no documents are prepared for an email handoff");
});

test("fresh evidence that cannot reproduce the email clears the stale destination", () => {
  const jobId = "job_stale_email_fixture";
  db.run(
    `INSERT INTO jobs
       (id, source, title, company, url, application_url, url_confidence, description, discovered_at, status,
        match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'jobs_ch', 'QA Engineer', 'Stale Email AG', 'https://www.jobs.ch/en/vacancies/detail/stale/',
             NULL, 'email', 'Testing.', ?, 'new', 90, 'eligible', 1, 'open')`,
    [jobId, at],
  );
  persistEmployerEmailDestination(jobId, {
    email: "jobs@stale-email.ch",
    employerVacancyUrl: null,
    employerSite: "https://stale-email.ch/",
    reason: "Initial evidence.",
    evidence: {},
    verifiedAt: at,
  });
  queue.syncQualifiedQueue({ actor: "test", now: NOW });
  assert.equal(queueRowState(jobId), "awaiting_human");

  clearEmployerEmailDestination(jobId, "The employer page no longer publishes the address.");
  const row = db.one<{ application_email: string | null; url_confidence: string; url_provenance: string }>(
    "SELECT application_email, url_confidence, url_provenance FROM jobs WHERE id = ?",
    [jobId],
  );
  assert.equal(row?.application_email, null);
  assert.equal(row?.url_confidence, "unresolved");
  assert.match(row?.url_provenance ?? "", /no longer publishes/);

  queue.syncQualifiedQueue({ actor: "test", now: NOW });
  assert.equal(queueRowState(jobId), "waiting_destination", "the vacancy is visibly unresolved again");
});

test("cleanup never wipes a verified web destination", () => {
  const jobId = "job_direct_email_fixture";
  db.run(
    `INSERT INTO jobs
       (id, source, title, company, url, application_url, url_confidence, discovered_at, status,
        match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'direct', 'QA Lead', 'Direct Form AG', 'https://direct-form.example/jobs/1',
             'https://direct-form.example/apply/1', 'direct', ?, 'new', 91, 'eligible', 1, 'open')`,
    [jobId, at],
  );
  persistEmployerEmailDestination(jobId, {
    email: "jobs@direct-form.example",
    employerVacancyUrl: "https://direct-form.example/jobs/1",
    employerSite: "https://direct-form.example/",
    reason: "Temporary evidence.",
    evidence: {},
    verifiedAt: at,
  });
  clearEmployerEmailDestination(jobId, "Re-resolution failed.");
  const row = db.one<{ application_email: string | null; application_url: string; url_confidence: string }>(
    "SELECT application_email, application_url, url_confidence FROM jobs WHERE id = ?",
    [jobId],
  );
  assert.equal(row?.application_email, null);
  assert.equal(row?.application_url, "https://direct-form.example/apply/1", "the verified form URL is preserved");
  assert.equal(row?.url_confidence, "direct");
});

test("marking an email handoff sent records a timestamp, note and sent_by_owner state", () => {
  const jobId = "job_handoff_sent_fixture";
  const applicationId = "app_handoff_sent_fixture";
  db.run(
    `INSERT INTO jobs
       (id, source, title, company, url, application_email, url_confidence, discovered_at, status,
        match_score, eligibility, qualified, vacancy_status)
     VALUES (?, 'jobs_ch', 'QA Engineer', 'Handoff Sent AG', 'https://www.jobs.ch/en/vacancies/detail/sent/',
             'jobs@handoff-sent.ch', 'email', ?, 'new', 93, 'eligible', 1, 'open')`,
    [jobId, at],
  );
  db.run(
    "INSERT INTO applications (id, job_id, status, submission_state, last_update, created_at) VALUES (?, ?, 'human_intervention_required', 'awaiting_human', ?, ?)",
    [applicationId, jobId, at, at],
  );
  queue.syncQualifiedQueue({ actor: "test", now: NOW });
  assert.equal(queueRowState(jobId), "awaiting_human");
  const attemptsBefore = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts")?.n;

  const result = markEmailHandoffSent({
    applicationId,
    note: "Sent from the owner mailbox with CV and cover letter attached.",
    now: NOW,
  });
  assert.equal(result.ok, true);

  const app = db.one<{
    status: string;
    submission_state: string;
    submission_status: string;
    email_handoff_sent_at: string;
    email_handoff_note: string;
    submitted_at: string;
  }>("SELECT status, submission_state, submission_status, email_handoff_sent_at, email_handoff_note, submitted_at FROM applications WHERE id = ?", [applicationId]);
  assert.equal(app?.status, "submitted_unverified");
  assert.equal(app?.submission_state, "sent_by_owner");
  assert.equal(app?.email_handoff_sent_at, at);
  assert.match(app?.email_handoff_note ?? "", /CV and cover letter/);
  assert.equal(queueRowState(jobId), "sent_by_owner");

  const event = db.one<{ type: string }>(
    "SELECT type FROM application_events WHERE application_id = ? ORDER BY id DESC LIMIT 1",
    [applicationId],
  );
  assert.equal(event?.type, "submission.owner_sent");
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM submission_attempts")?.n,
    attemptsBefore,
    "an owner attestation creates no submission attempt",
  );

  const again = markEmailHandoffSent({ applicationId, note: "Second click", now: new Date(NOW.getTime() + 60_000) });
  assert.equal(again.ok && again.alreadySent, true);
  assert.equal(
    db.one<{ n: number }>("SELECT COUNT(*) AS n FROM application_events WHERE application_id = ? AND type = 'submission.owner_sent'", [applicationId])?.n,
    1,
    "the action is idempotent",
  );
  assert.equal(db.one<{ note: string }>("SELECT email_handoff_note AS note FROM applications WHERE id = ?", [applicationId])?.note.includes("Second click"), false);
});

function queueRowState(jobId: string): string | null {
  return (
    db.one<{ state: string }>("SELECT state FROM recruitment_queue WHERE job_id = ?", [jobId])?.state ?? null
  );
}
