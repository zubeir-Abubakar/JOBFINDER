import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubmissionJob } from "../lib/submission";
import type { LinkResolution } from "../lib/employer-links";

/**
 * Regression fixtures for the three recovery fixes:
 *  - an aggregator listing is never used as an application destination,
 *  - a stored pure-location rejection is re-assessed with the corrected rule,
 *  - a discovery attempt that produced no usable source is retried once.
 *
 * No job board, employer or provider is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-recruitment-recovery-"));
process.env.APP_SECRET_KEY = "recruitment-recovery-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_DISCOVERY_RETRY_MS = "0";
delete process.env.RECRUITMENT_SUBMISSION_ENDPOINT;

const { ensureEmployerDestination } = await import("../lib/submission.ts");
const { channelFor } = await import("../lib/submission.ts");
const { requalifyLocationRejections, discoverWithRetry } = await import("../lib/recruitment-run.ts");
const db = await import("../lib/db.ts");

const LISTING = "https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a/";

const submissionJob = (overrides: Partial<SubmissionJob> = {}): SubmissionJob => ({
  id: "job_recovery_fixture",
  title: "QA Automation Engineer",
  company: "Example AG",
  url: LISTING,
  application_url: null,
  url_confidence: "unresolved",
  description: "Playwright and API testing.",
  ...overrides,
});

const resolution = (overrides: Partial<LinkResolution>): LinkResolution => ({
  requestedUrl: LISTING,
  finalUrl: LISTING,
  employerUrl: null,
  atsVendor: null,
  requisitionId: null,
  confidence: "unresolved",
  reason: "not resolved",
  hops: 0,
  httpStatus: 200,
  method: "unresolved",
  ...overrides,
});

test("an unresolved listing is cleared and becomes a human handoff, never a form page", async () => {
  const job = submissionJob();
  await ensureEmployerDestination(job, async () => resolution({}));
  assert.equal(job.application_url, null);
  assert.equal(job.url_confidence, "unresolved");
  const channel = channelFor(job);
  assert.equal(channel.channel, "manual");
  assert.match(channel.reason, /unresolved|not submitted as an application/i);
});

test("a resolved employer or ATS destination becomes the application URL", async () => {
  const job = submissionJob();
  const employer = "https://jobs.smartrecruiters.com/Example/744000137693459-qa-engineer";
  await ensureEmployerDestination(job, async () =>
    resolution({
      employerUrl: employer,
      atsVendor: "smartrecruiters",
      confidence: "ats",
      method: "redirect",
      reason: "Hosted on the supported smartrecruiters ATS.",
    }),
  );
  assert.equal(job.application_url, employer);
  assert.equal(job.url_confidence, "ats");
  assert.equal(channelFor(job).channel, "candidate_form");
});

test("an already employer-hosted URL is not resolved again", async () => {
  const direct = "https://careers.example.ch/jobs/qa-engineer";
  const job = submissionJob({ application_url: direct, url_confidence: "direct" });
  let called = 0;
  await ensureEmployerDestination(job, async () => {
    called += 1;
    return resolution({});
  });
  assert.equal(called, 0);
  assert.equal(job.application_url, direct);
});

test("a stored pure-location rejection is re-assessed after the Swiss-location fix", () => {
  const now = new Date().toISOString();
  const notes = JSON.stringify({
    status: "ineligible",
    blockers: ["Location is outside Switzerland and no remote option is offered."],
    reasons: ["Posting location is outside Switzerland and the role is not marked remote."],
  });
  const insert = db.getDb().prepare(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, application_url, description,
                       discovered_at, status, match_score, match_flag, eligibility, eligibility_notes, qualified)
     VALUES (?, 'jobs_ch', ?, ?, ?, 0, ?, ?, ?, ?, 'rejected', ?, 'strong', 'ineligible', ?, 0)`,
  );
  insert.run("job_recovery_ch", "QA Test Engineer", "Siemens Schweiz AG", "CH", LISTING, "https://jobs.siemens.com/x",
    "Senior QA engineer for a payments platform. Playwright, API testing, regression testing. English is required.",
    now, 92, notes);
  insert.run("job_recovery_lisbon", "QA Automation Engineer", "Airapps", "Zurich", LISTING, "https://jobs.ashbyhq.com/x",
    "Senior QA engineer. Playwright, API testing. This is a fully onsite position, based at our office in Lisbon.",
    now, 91, notes);

  const result = requalifyLocationRejections(new Date(now));
  assert.equal(result.checked, 2);
  assert.equal(result.upgraded, 1);

  const ch = db.one<{ eligibility: string; qualified: number; status: string }>(
    "SELECT eligibility, qualified, status FROM jobs WHERE id = 'job_recovery_ch'",
  );
  assert.equal(ch?.eligibility, "eligible");
  assert.equal(Number(ch?.qualified), 1);
  assert.equal(ch?.status, "shortlisted");

  const lisbon = db.one<{ eligibility: string; qualified: number }>(
    "SELECT eligibility, qualified FROM jobs WHERE id = 'job_recovery_lisbon'",
  );
  assert.equal(lisbon?.eligibility, "ineligible");
  assert.equal(Number(lisbon?.qualified), 0);
});

test("discovery is retried once when the first attempt produced no usable source", async () => {
  const reasons: string[] = [];
  let calls = 0;
  const usable = { sources: [{ requests: 2, responses: 2 }] };
  const result = await discoverWithRetry(
    async () => {
      calls += 1;
      if (calls === 1) {
        return { sources: [{ requests: 2, responses: 0 }], allSourcesFailed: true };
      }
      return usable;
    },
    { retries: 1, delayMs: 0, onRetry: (_attempt, reason) => reasons.push(reason) },
  );
  assert.equal(calls, 2);
  assert.equal(result, usable);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /no usable response/i);
});

test("a genuine outage still fails after the single retry", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      discoverWithRetry(
        async () => {
          calls += 1;
          throw new Error("network down");
        },
        { retries: 1, delayMs: 0 },
      ),
    /network down/,
  );
  assert.equal(calls, 2);
});
