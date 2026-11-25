import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { openVacancyVerification } from "./helpers/open-vacancy.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 2 autonomous recruitment.
 *
 * Discovery and submission are exercised through the real modules with mocked
 * HTTP boundaries (no real employer is contacted). Document generation is
 * injected as a fixture for the orchestration test so the suite runs in
 * milliseconds and never sends an application anywhere.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-recruitment-"));
process.env.APP_SECRET_KEY = "recruitment-test-secret";
process.env.ASHBY_JOB_BOARDS = "novapay";
process.env.EMPLOYER_CAREER_PAGES = "";
process.env.RECRUITMENT_SUBMISSION_ENDPOINT = "https://apply.test/submit/{job_id}";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.GEMINI_API_KEY = "";
delete process.env.GEMINI_API_KEY;

const STRONG_DESCRIPTION = [
  "We are hiring a senior quality engineer with 5+ years of software testing experience.",
  "You will own test automation with Playwright, Cypress, Selenium and Appium, build REST API tests with Postman and REST Assured,",
  "and run CI pipelines in Jenkins and Azure DevOps with Docker, Git, Jira and SQL. Python and TypeScript are used daily.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "English is required. This is a full-time role.",
].join(" ");

const ashbyPostings = [
  {
    id: "posting-1",
    title: "Senior QA Automation Engineer",
    location: "Zürich, Switzerland",
    employmentType: "Full-time",
    isRemote: true,
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-1",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-1/apply",
    descriptionPlain: STRONG_DESCRIPTION,
    isListed: true,
  },
  {
    id: "posting-2",
    title: "SDET",
    location: "Switzerland (Remote)",
    employmentType: "Full-time",
    isRemote: true,
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-2",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-2/apply",
    descriptionPlain: STRONG_DESCRIPTION,
    isListed: true,
  },
  {
    id: "posting-3",
    title: "Test Automation Engineer",
    location: "Remote — Europe",
    employmentType: "Full-time",
    isRemote: true,
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-3",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-3/apply",
    descriptionPlain: `${STRONG_DESCRIPTION} This remote role is open to applicants across Europe.`,
    isListed: true,
  },
  {
    id: "posting-4",
    title: "QA Engineer",
    location: "Bern, Switzerland",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-4",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-4/apply",
    descriptionPlain: `${STRONG_DESCRIPTION} Fluent German (C1) is required for this role.`,
    isListed: true,
  },
  {
    // Same employer and title as posting-1, different board listing.
    id: "posting-1-mirror",
    title: "Senior QA Automation Engineer",
    location: "Zürich, Switzerland",
    isRemote: true,
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-1-mirror",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-1-mirror/apply",
    descriptionPlain: STRONG_DESCRIPTION,
    isListed: true,
  },
  {
    id: "posting-5",
    title: "Product Manager, Payments",
    location: "Zürich, Switzerland",
    publishedAt: new Date().toISOString(),
    jobUrl: "https://jobs.ashbyhq.com/acme/posting-5",
    applyUrl: "https://jobs.ashbyhq.com/acme/posting-5/apply",
    descriptionPlain: "Own the payments roadmap and work with engineering and design.",
    isListed: true,
  },
];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

let submissionPosts = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("arbeitnow.com/api/job-board-api")) return json({ data: [] });
  if (url.includes("api.ashbyhq.com/posting-api/job-board")) return json({ jobs: ashbyPostings });
  if (url.startsWith("https://apply.test/submit/")) {
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData, "the submission must send a real form");
    submissionPosts += 1;
    const id = url.split("/").pop() ?? "unknown";
    return json({ reference: `APP-${id}` });
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const schedule = await import("../lib/recruitment-schedule.ts");
const scoring = await import("../lib/scoring.ts");
const eligibility = await import("../lib/eligibility.ts");
const discovery = await import("../lib/recruitment-discovery.ts");
const submission = await import("../lib/submission.ts");
const runs = await import("../lib/recruitment-run.ts");
const ticker = await import("../lib/recruitment-ticker.ts");
const profileModule = await import("../lib/profile.ts");

db.getDb();
db.run("UPDATE profiles SET email = ?, phone = ? WHERE id = 1", ["candidate@example.com", "+41 79 000 00 00"]);
db.run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Playwright', 'Automation & testing', 'advanced', 1, 'manual', 99)");
// The autonomous pipeline requires an uploaded master CV before it will spend
// model or PDF work on a vacancy. The fixture provides one; no test fabricates
// candidate history beyond this verified text.
mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "master-cv.pdf"), "%PDF-1.4 recruitment test master CV");
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_master_fixture', 'system', 'original_cv', 'Master CV', 'master-cv.pdf', 'application/pdf', 'master-cv.pdf', 38, 'ready', ?, ?)`,
  [
    [
      "Ada Lovelace",
      "Senior QA Automation Engineer",
      "Playwright, API testing, regression testing, test planning, release readiness and defect management.",
      "More than five years of software quality assurance experience in fintech payment platforms and mobile applications.",
      "Built and maintained automated test suites and worked with product and engineering teams on quality gates.",
      "English C1.",
    ].join("\n"),
    new Date().toISOString(),
  ],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_master_fixture' WHERE id = 1");
db.run("UPDATE settings SET value = '60' WHERE key = 'min_match_score'");
// The standing authorisation is off by default in a real installation. The
// suite simulates the owner's explicit activation against a local mock endpoint;
// no employer is contacted. The persisted cap is the owner-authorised 3/day
// maximum; the fixture exercises only as many qualifying vacancies as the cap.
// This fixture exercises delivery against a local mock endpoint, so it opts out
// of the production dry run explicitly.
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE settings SET value = 'true' WHERE key = 'autonomous_submission'");
db.run("UPDATE settings SET value = 'false' WHERE key = 'approval_mode'");
db.run("UPDATE settings SET value = '3' WHERE key = 'max_applications_per_day'");
db.run("INSERT INTO settings (key, value, updated_at) VALUES ('standing_authorisation_activated_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(new Date().toISOString()), new Date().toISOString()]);

test("the main schedule is 12:00 Europe/Zurich every day and survives both DST transitions", () => {
  const weekdays = [1, 2, 3, 4, 5, 6, 7];
  assert.equal(schedule.nextDailyRun(new Date("2026-01-15T07:00:00Z"), { weekdays }).toISOString(), "2026-01-15T11:00:00.000Z");
  assert.equal(schedule.nextDailyRun(new Date("2026-07-15T06:00:00Z"), { weekdays }).toISOString(), "2026-07-15T10:00:00.000Z");
  // At 12:00 local the single occurrence has just passed, so the next is tomorrow.
  assert.equal(schedule.nextDailyRun(new Date("2026-07-15T10:00:00Z"), { weekdays }).toISOString(), "2026-07-16T10:00:00.000Z");
  // Friday after the daily run rolls to Saturday.
  assert.equal(schedule.nextDailyRun(new Date("2026-11-20T11:00:00Z"), { weekdays }).toISOString(), "2026-11-21T11:00:00.000Z");
  // Spring forward (29 Mar 2026) and autumn back (25 Oct 2026): both Sundays are
  // configured days and both keep 12:00 local time.
  assert.equal(schedule.nextDailyRun(new Date("2026-03-28T12:00:00Z"), { weekdays }).toISOString(), "2026-03-29T10:00:00.000Z");
  assert.equal(schedule.nextDailyRun(new Date("2026-10-24T12:00:00Z"), { weekdays }).toISOString(), "2026-10-25T11:00:00.000Z");
  assert.equal(schedule.localDateKey(new Date("2026-11-18T23:30:00Z")), "2026-11-19");
});

test("the schedule is persisted in SQLite, not only in memory", () => {
  const row = schedule.ensureSchedule();
  assert.equal(row.time, "12:00");
  assert.equal(row.timezone, "Europe/Zurich");
  assert.deepEqual(schedule.parseWeekdays(row.weekdays), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(row.next_run_at);
  const toggled = schedule.setScheduleEnabled(false);
  assert.equal(toggled.enabled, 0);
  assert.equal(toggled.next_run_at, null);
  const restored = schedule.setScheduleEnabled(true);
  assert.equal(restored.enabled, 1);
  assert.ok(restored.next_run_at);
  const snapshot = schedule.scheduleSnapshot();
  assert.equal(snapshot.timezone, "Europe/Zurich");
  assert.equal(snapshot.requiresRunningHost, true);
});

test("the daily run key is unique per day, so a second scheduled execution cannot be created", () => {
  const saved = schedule.saveScheduleConfiguration(
    schedule.RECRUITMENT_SCHEDULE_KEY,
    { enabled: true, weekdays: [1, 2, 3, 4, 5, 6, 7], time: "12:00", timezone: "Europe/Zurich" },
    new Date("2030-05-06T06:00:00Z"),
  );
  assert.equal(saved.ok, true);
  assert.deepEqual(schedule.recruitmentRunTimes("12:00"), [{ time: "12:00", mode: "full" }]);
  const first = runs.createRecruitmentRun({ trigger: "schedule", now: new Date("2030-05-06T07:00:00Z") });
  assert.equal(first.created, true);
  assert.equal(first.run.scheduled_for, "2030-05-06T10:00:00.000Z");
  assert.equal(first.run.discovery_scope, "full");
  assert.match(first.run.run_key, /#full-1200$/);
  db.run("UPDATE recruitment_runs SET status = 'failed', finished_at = ? WHERE id = ?", [new Date().toISOString(), first.run.id]);

  // The same day's occurrence is already recorded; a retry must not add a run.
  const duplicate = runs.createRecruitmentRun({ trigger: "schedule", now: new Date("2030-05-06T07:00:00Z") });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.run.id, first.run.id);
});

test("the 85% threshold cannot be lowered by configuration", () => {
  assert.equal(runs.qualifyingThreshold(), 85);
  // The UI reads this same effective value, so it can never display 60/80 while
  // the engine enforces 85.
  assert.equal(scoring.effectiveMinMatchScore(60), 85);
  assert.equal(scoring.effectiveMinMatchScore("80"), 85);
  assert.equal(scoring.effectiveMinMatchScore(92), 92);
  assert.equal(scoring.effectiveMinMatchScore(140), 100);
  assert.equal(scoring.effectiveMinMatchScore(undefined), 85);
  assert.equal(scoring.qualifiesForAutoApply({ score: 84, concerns: [] }), false);
  assert.equal(scoring.qualifiesForAutoApply({ score: 85, concerns: [] }), true);
  assert.equal(
    scoring.qualifiesForAutoApply({ score: 96, concerns: ["German C1 appears to be required — the profile evidences English only."] }),
    false,
  );
});

test("a coordinator advisory that invents vacancy ids is withheld", () => {
  assert.equal(runs.coordinatorOutputSupported("Priority: Vacancy ID: 12345 (High)", 0), false);
  assert.equal(runs.coordinatorOutputSupported("Priority: Vacancy ID: VAC-1234", 0), false);
  assert.equal(runs.coordinatorOutputSupported("No vacancy was assessed by this run; keep the 10:00 schedule.", 0), true);
  assert.equal(runs.coordinatorOutputSupported("Review sumup QA Engineer first, then hold QESTIT.", 2), true);
});

test("cross-source duplicate vacancies are detected before insertion", () => {
  const base = {
    source: "ashby",
    sourcePlatform: "Ashby · test",
    externalId: "dedupe-a",
    title: "Senior QA Engineer (dedupe fixture)",
    company: "Dedupe Widgets GmbH",
    companyDomain: "dedupe.example",
    location: "Zürich, Switzerland",
    remote: false,
    employmentType: "Full-time",
    salary: null,
    url: "https://dedupe.example/jobs/1",
    applicationUrl: "https://dedupe.example/jobs/1/apply",
    description: STRONG_DESCRIPTION,
    publishedAt: new Date().toISOString(),
  };
  const first = discovery.insertDiscovered(base, null);
  assert.ok(first, "the first listing is stored");
  const second = discovery.insertDiscovered({ ...base, source: "career:dedupe.example", externalId: "dedupe-b" }, null);
  assert.equal(second, null, "the same employer and role from another source is a duplicate");
  const count = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE company = ?", ["Dedupe Widgets GmbH"])?.c;
  assert.equal(Number(count), 1);
});

test("Swiss residency, sponsorship and language eligibility are evidence-based", () => {
  const profile = profileModule.getProfileData();
  const base = {
    title: "Senior QA Engineer",
    company: "Eligibility Test AG",
    location: "Zürich, Switzerland",
    description: `${STRONG_DESCRIPTION} Swiss work authorisation is required; sponsorship is not offered.`,
    remote: false,
    application_url: "https://eligibility.example/apply",
    url: "https://eligibility.example/job",
    published_at: null,
    employment_type: "Full-time",
  };
  const swiss = eligibility.assessEligibility(base, profile);
  assert.equal(swiss.status, "eligible");
  assert.equal(swiss.sponsorshipRequired, "no");

  const german = eligibility.assessEligibility(
    { ...base, description: `${STRONG_DESCRIPTION} Fluent German (C1) is required.` },
    profile,
  );
  assert.equal(german.status, "ineligible");
  assert.ok(german.blockers.some((blocker) => /German/.test(blocker)));

  // German "fließend" is a mandatory-language phrase, not a preference.
  const germanFluent = eligibility.assessEligibility(
    {
      ...base,
      location: "Remote — Europe",
      remote: true,
      description: `${STRONG_DESCRIPTION} Du sprichst fließend Deutsch und sehr gut Englisch.`,
    },
    profile,
  );
  assert.equal(germanFluent.status, "ineligible");
  assert.ok(germanFluent.blockers.some((blocker) => /German/.test(blocker)));

  // A separate "nice to have" bullet must not cancel a mandatory language
  // requirement in another bullet of the same description.
  const germanBullets = eligibility.assessEligibility(
    {
      ...base,
      location: "Remote — Europe",
      remote: true,
      description: [
        "Dein Profil",
        "• Du sprichst fließend Deutsch und sehr gut Englisch",
        "Von Vorteil",
        "• Zertifizierungen wie PMP oder PRINCE2",
      ].join("\n"),
    },
    profile,
  );
  assert.equal(germanBullets.status, "ineligible");
  assert.ok(germanBullets.blockers.some((blocker) => /German/.test(blocker)));

  const usOnly = eligibility.assessEligibility(
    {
      ...base,
      location: "Remote",
      remote: true,
      description: `${STRONG_DESCRIPTION} This remote role is restricted to candidates based in the United States.`,
    },
    profile,
  );
  assert.equal(usOnly.status, "ineligible");
  assert.ok(usOnly.blockers.some((blocker) => /excludes Switzerland/i.test(blocker)));

  const europe = eligibility.assessEligibility(
    { ...base, location: "Remote — Europe", remote: true, description: `${STRONG_DESCRIPTION} Open to applicants across Europe.` },
    profile,
  );
  assert.equal(europe.status, "eligible");

  // EMEA and DACH are Europe-wide remote scopes and include Switzerland.
  for (const region of ["Remote — EMEA", "Remote — DACH"]) {
    const scoped = eligibility.assessEligibility(
      { ...base, location: region, remote: true, description: STRONG_DESCRIPTION },
      profile,
    );
    assert.equal(scoped.status, "eligible", `${region} must be treated as open to Swiss residents`);
  }

  // Marketing copy mentioning Switzerland must not turn a foreign on-site role
  // into a Swiss-residency match.
  const berlin = eligibility.assessEligibility(
    {
      ...base,
      location: "Berlin, Germany",
      remote: false,
      description: `${STRONG_DESCRIPTION} Our payments platform is live in 38 markets including Switzerland and Austria.`,
    },
    profile,
  );
  assert.equal(berlin.status, "ineligible");
  assert.ok(berlin.blockers.some((blocker) => /outside Switzerland/i.test(blocker)));
});

type FakePackage = {
  ok: boolean;
  message: string;
  applicationId?: string;
  atsScore?: number;
  cvDocumentId?: string;
  coverDocumentId?: string;
  warnings: string[];
};

let preparedJobs: string[] = [];

async function fakePackage(jobId: string): Promise<FakePackage> {
  preparedJobs.push(jobId);
  const job = db.one<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = ?", [jobId]);
  assert.ok(job);
  mkdirSync(db.UPLOAD_DIR, { recursive: true });
  const cvFile = `cv-${jobId}.pdf`;
  const coverFile = `cover-${jobId}.pdf`;
  writeFileSync(join(db.UPLOAD_DIR, cvFile), "%PDF-1.4 recruitment test CV");
  writeFileSync(join(db.UPLOAD_DIR, coverFile), "%PDF-1.4 recruitment test cover letter");
  const cvId = `doc_${jobId}_cv`;
  const coverId = `doc_${jobId}_cover`;
  const createdAt = new Date().toISOString();
  // The fixture represents a real extracted package: the readiness gate reads
  // the PDF text and refuses an empty document rather than trusting the model.
  const cvText = [
    `Tailored CV for ${job.title} at ${job.company}.`,
    "Senior QA engineer with more than five years of software quality assurance experience.",
    "Playwright automation, API testing, regression testing, release readiness and defect management.",
    "Built and maintained test suites for payment platforms and mobile applications in a fintech environment.",
    "Works with product and engineering teams on test strategy, test planning and quality gates.",
  ].join(" ");
  const coverText = [
    `Dear ${job.company} team,`,
    `I am applying for the ${job.title} role.`,
    "My experience covers Playwright test automation, API testing, regression testing and release readiness for payment platforms.",
    "I would welcome the opportunity to discuss how I can strengthen your quality engineering team.",
  ].join(" ");
  for (const [id, kind, file] of [
    [cvId, "tailored_cv", cvFile],
    [coverId, "cover_letter", coverFile],
  ] as const) {
    db.run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
       VALUES (?, 'system', ?, ?, ?, 'application/pdf', ?, 32, ?, '1.0', 'ready', 'passed', 96, ?, ?)`,
      [id, kind, `${kind} fixture`, file, file, jobId, kind === "tailored_cv" ? cvText : coverText, createdAt],
    );
  }
  const appId = `app_${jobId}`;
  db.run(
    "INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, method, last_update, created_at) VALUES (?, ?, 'documents_preparing', ?, ?, 'http_form', ?, ?)",
    [appId, jobId, cvId, coverId, createdAt, createdAt],
  );
  return { ok: true, message: "fixture package", applicationId: appId, atsScore: 96, cvDocumentId: cvId, coverDocumentId: coverId, warnings: [] };
}

let completedRunId = "";

test("the Chief Coordinator executes discovery, scoring, documents, QA, submission and reporting", async () => {
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
  assert.equal(created.created, true);
  preparedJobs = [];
  const outcome = await runs.executeRun(created.run.id, { deps: { prepare: fakePackage, verifyVacancy: async () => openVacancyVerification() } });
  completedRunId = created.run.id;

  assert.ok(outcome.qualified >= 3, `expected at least three qualifying vacancies, got ${outcome.qualified}`);
  assert.equal(outcome.prepared, outcome.qualified, "every qualifying vacancy receives its own package");
  assert.equal(outcome.submitted, outcome.prepared, "every package with evidence is counted as submitted");
  assert.equal(outcome.intervention, 0);
  assert.equal(submissionPosts, outcome.submitted, "one HTTP submission per verified application");
  assert.equal(new Set(preparedJobs).size, preparedJobs.length, "no duplicate document preparation");

  const stored = runs.runById(created.run.id);
  assert.ok(stored);
  assert.ok(["completed", "completed_with_warnings"].includes(stored.status));
  assert.equal(stored.applications_submitted, outcome.submitted);
  assert.ok(stored.report && stored.report.includes("## 6. Applications successfully submitted"));
  assert.ok(stored.report?.includes("## 10. Next scheduled run"));
  const metrics = JSON.parse(stored.source_metrics ?? "[]") as Array<{ key: string; inserted: number; fresh: number }>;
  const ashbyMetric = metrics.find((metric) => metric.key === "ashby");
  assert.ok(ashbyMetric, "per-source metrics are persisted on the run");
  assert.ok(ashbyMetric!.inserted >= 3, "the Ashby source records what it inserted");
  assert.ok(metrics.some((metric) => metric.key === "greenhouse"), "every configured connector reports a row");

  const german = db.one<{ id: string; eligibility: string; qualified: number }>(
    "SELECT id, eligibility, qualified FROM jobs WHERE title = 'QA Engineer' AND run_id = ?",
    [created.run.id],
  );
  assert.ok(german);
  assert.equal(german!.eligibility, "ineligible");
  assert.equal(Number(german!.qualified), 0);
  const germanApp = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE job_id = ?", [german!.id]);
  assert.equal(Number(germanApp?.c), 0, "an ineligible vacancy is never submitted");

  const verified = db.all<{ id: string; job_id: string; confirmation_ref: string | null; status: string }>(
    "SELECT id, job_id, confirmation_ref, status FROM applications WHERE status = 'submitted'",
  );
  assert.equal(verified.length, outcome.submitted);
  for (const app of verified) {
    assert.equal(app.status, "submitted");
    assert.ok(app.confirmation_ref, "a submitted application always carries a reference");
  }

  const attempts = db.all<{ status: string; evidence: string | null }>("SELECT status, evidence FROM submission_attempts");
  assert.equal(attempts.length, outcome.submitted);
  assert.ok(attempts.every((attempt) => attempt.status === "verified" && attempt.evidence));
});

test("a discovery-only run records results without preparing documents or submitting", async () => {
  const jobIds = db
    .all<{ id: string }>("SELECT id FROM jobs WHERE qualified = 1 AND run_id = ? LIMIT 3", [completedRunId])
    .map((row) => row.id);
  assert.ok(jobIds.length > 0, "the earlier full run produced qualifying vacancies to assess");
  const appsBefore = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c);
  const docsBefore = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM documents")?.c);

  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date(), discoveryOnly: true });
  assert.equal(created.created, true);
  assert.equal(created.run.mode, "discovery");
  const outcome = await runs.executeRun(created.run.id, {
    discoveryOnly: true,
    deps: {
      discover: async () => ({
        discovered: jobIds.length,
        inserted: 0,
        duplicates: 0,
        updated: 0,
        filtered: 0,
        jobIds,
        sources: [
          {
            key: "ashby",
            label: "Ashby boards (1 configured)",
            fetched: 5,
            inserted: 0,
            error: null,
            requests: 1,
            responses: 1,
            fresh: 3,
            relevant: 3,
            duplicates: 0,
            updated: 0,
          },
        ],
        warnings: [],
      }),
    },
  });

  assert.equal(outcome.prepared, 0, "discovery-only runs never prepare documents");
  assert.equal(outcome.submitted, 0, "discovery-only runs never submit");
  const stored = runs.runById(created.run.id);
  assert.equal(stored?.mode, "discovery");
  assert.match(stored?.report ?? "", /discovery only/i);
  assert.match(stored?.report ?? "", /Agent execution and AI provenance/i);
  assert.match(stored?.report ?? "", /no model call was recorded/i, "without a provider the report must not claim model execution");
  assert.equal(Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c), appsBefore);
  assert.equal(Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM documents")?.c), docsBefore);
});

test("a completed run is not executed twice and its records survive a re-read", async () => {
  const before = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM recruitment_run_agents WHERE run_id = ?", [completedRunId])?.c;
  const again = await runs.executeRun(completedRunId);
  assert.ok(["completed", "completed_with_warnings"].includes(again.status));
  const after = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM recruitment_run_agents WHERE run_id = ?", [completedRunId])?.c;
  assert.equal(Number(after), Number(before), "a completed run is never re-executed");
  const persisted = runs.runById(completedRunId);
  assert.ok(persisted?.report?.includes("Daily recruitment report"));
  assert.ok(persisted?.finished_at);
});

test("a duplicate application is blocked and the verified evidence is not overwritten", async () => {
  const app = db.one<{ id: string; job_id: string }>(
    "SELECT id, job_id FROM applications WHERE status = 'submitted' ORDER BY created_at LIMIT 1",
  );
  assert.ok(app);
  const job = db.one<{ id: string; title: string; company: string; url: string | null; application_url: string | null; description: string | null }>(
    "SELECT id, title, company, url, application_url, description FROM jobs WHERE id = ?",
    [app!.job_id],
  );
  const before = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ? AND status = 'verified'", [app!.job_id])?.c;
  const outcome = await submission.submitApplication({
    applicationId: app!.id,
    job: job!,
    documents: {
      cvPath: null,
      cvName: null,
      coverPath: null,
      coverName: null,
      coverText: "cover",
      cvDocumentId: null,
      coverDocumentId: null,
    },
    profile: profileModule.getProfileData().profile,
  });
  assert.equal(outcome.status, "blocked");
  assert.match(outcome.detail, /verified submission already exists/i);
  const after = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM submission_attempts WHERE job_id = ? AND status = 'verified'", [app!.job_id])?.c;
  assert.equal(Number(after), Number(before), "no second verified submission is recorded");
});

test("a vacancy scoring below 85% is excluded before any document work", async () => {
  const jobId = `job_low_${Date.now()}`;
  db.run(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, application_url, description, discovered_at, status, dedupe_key, match_score, analysis)
     VALUES (?, 'manual', 'QA Engineer', 'Below Threshold AG', 'Zürich, Switzerland', 0, 'https://below.example/job', 'https://below.example/apply', ?, ?, 'new', ?, 84, ?)`,
    [
      jobId,
      STRONG_DESCRIPTION,
      new Date().toISOString(),
      `low-${Date.now()}`,
      JSON.stringify({ score: 84, flag: "strong", concerns: [], breakdown: {}, matched: [], missing: [], evidence: {} }),
    ],
  );
  const preparedBefore = preparedJobs.length;
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date() });
  const outcome = await runs.executeRun(created.run.id, {
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
      analyse: () => ({ score: 84, concerns: [] } as unknown as import("../lib/scoring.ts").JobAnalysis),
      prepare: fakePackage,
      verifyVacancy: async () => openVacancyVerification(),
    },
  });
  assert.equal(outcome.qualified, 0);
  assert.equal(outcome.prepared, 0);
  assert.equal(preparedJobs.length, preparedBefore, "no documents are prepared below the threshold");
  const apps = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE job_id = ?", [jobId]);
  assert.equal(Number(apps?.c), 0);
  const stored = runs.runById(created.run.id);
  assert.equal(stored?.jobs_qualified, 0);
  const tagged = db.one<{ run_id: string | null }>("SELECT run_id FROM jobs WHERE id = ?", [jobId]);
  assert.equal(tagged?.run_id, created.run.id, "every assessed vacancy is linked to the run for its report and verification");
});

test("a missed scheduled run is recorded rather than silently skipped", async () => {
  // Make the occurrence due today, including when the test host runs on a
  // weekend, so this exercises the missed-window path rather than the rest day.
  db.run("UPDATE schedule_jobs SET enabled = 1, weekdays = ?, next_run_at = ? WHERE key = ?", [
    JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
    new Date(Date.now() - 48 * 3600_000).toISOString(),
    schedule.RECRUITMENT_SCHEDULE_KEY,
  ]);
  const result = await ticker.tickRecruitmentSchedule();
  assert.equal(result.started, false);
  assert.match(result.reason ?? "", /missed/i);
  const missed = runs.runById(result.runId ?? "");
  assert.ok(missed);
  assert.equal(missed!.status, "failed");
  assert.match(missed!.error ?? "", /missed/i);
  schedule.setScheduleEnabled(true);
});
