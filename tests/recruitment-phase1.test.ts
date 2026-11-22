import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { openVacancyVerification } from "./helpers/open-vacancy.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 1 acceptance fixtures.
 *
 * Every employer, board and vacancy below is fictional. The only HTTP calls
 * are intercepted by the local mock; no job board, employer, Gmail account or
 * AI provider is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase1-"));
process.env.APP_SECRET_KEY = "phase-one-test-secret";
process.env.RECRUITMENT_HTTP_RETRY_BASE_MS = "1";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.RECRUITMENT_SUBMISSION_ENDPOINT = "https://apply.test/submit/{job_id}";
process.env.RECRUITMENT_SUBMISSION_ENABLED = "true";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.GEMINI_API_KEY = "";
delete process.env.GEMINI_API_KEY;

process.env.ASHBY_JOB_BOARDS = "novapay";
process.env.GREENHOUSE_BOARDS = "novapay";
process.env.LEVER_SITES = "novapay";
process.env.JOBS_CH_QUERIES = "QA Engineer|SDET";
process.env.EMPLOYER_CAREER_PAGES = "https://careers.nova.test/jobs";

const now = new Date();
const recent = now.toISOString();
const old = new Date(now.getTime() - 30 * 86_400_000).toISOString();

const STRONG = [
  "We are hiring a senior quality engineer with 5+ years of software testing experience.",
  "You will own test automation with Playwright, Cypress, Selenium and Appium, build REST API tests with Postman and REST Assured,",
  "and run CI pipelines in Jenkins and Azure DevOps with Docker, Git, Jira and SQL. Python and TypeScript are used daily.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "English is required. This is a full-time role.",
].join(" ");

type Mode = "normal" | "all-fail" | "ashby-fail" | "malformed-ashby" | "empty";

let mode: Mode = "normal";
let submissionPosts = 0;
let fetchCalls = 0;
const phase1FixtureCompanies = new Map<string, string>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const arbeitnowJobs = [
  {
    slug: "arb-qa-1",
    company_name: "Helvetia Test Labs",
    title: "Senior QA Automation Engineer",
    location: "Zürich, Switzerland",
    remote: false,
    url: "https://arbeitnow.test/jobs/arb-qa-1",
    description: STRONG,
    created_at: Math.floor(now.getTime() / 1000),
    job_types: ["Full-time"],
  },
  {
    slug: "arb-expired-1",
    company_name: "Old Feed AG",
    title: "QA Engineer",
    location: "Zürich, Switzerland",
    remote: false,
    url: "https://arbeitnow.test/jobs/arb-expired-1",
    description: STRONG,
    created_at: Math.floor(new Date(old).getTime() / 1000),
    job_types: ["Full-time"],
  },
];

const ashbyJobs = [
  {
    id: "ash-1",
    title: "Senior SDET",
    location: "Zürich, Switzerland",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/novapay/ash-1",
    applyUrl: "https://jobs.ashbyhq.com/novapay/ash-1/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "ash-2",
    title: "Test Automation Engineer",
    location: "Berlin, Germany",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/novapay/ash-2",
    applyUrl: "https://jobs.ashbyhq.com/novapay/ash-2/apply",
    descriptionPlain: `${STRONG} Our platform is used across Europe.`,
    isListed: true,
  },
  {
    id: "ash-3",
    title: "Senior QA Engineer",
    location: "Bern, Switzerland",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/novapay/ash-3",
    applyUrl: "https://jobs.ashbyhq.com/novapay/ash-3/apply",
    descriptionPlain: `${STRONG} Fluent German (C1) is mandatory for this role.`,
    isListed: true,
  },
  {
    id: "ash-expired",
    title: "QA Lead",
    location: "Zürich, Switzerland",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: old,
    jobUrl: "https://jobs.ashbyhq.com/novapay/ash-expired",
    applyUrl: "https://jobs.ashbyhq.com/novapay/ash-expired/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
];

const greenhouseJobs = [
  {
    id: 9001,
    title: "Senior SDET",
    company_name: "Novapay",
    updated_at: recent,
    first_published: recent,
    absolute_url: "https://boards.greenhouse.io/novapay/jobs/9001",
    location: { name: "Zürich, Switzerland" },
    content: STRONG,
  },
  {
    id: 9002,
    title: "Test Automation Engineer",
    company_name: "Novapay",
    updated_at: recent,
    first_published: recent,
    absolute_url: "https://boards.greenhouse.io/novapay/jobs/9002",
    location: { name: "Remote — Europe" },
    content: `${STRONG} This remote role is open to Europe.`,
  },
  {
    id: 9003,
    title: "Salesforce QA Engineer",
    company_name: "Novapay",
    updated_at: recent,
    first_published: recent,
    absolute_url: "https://boards.greenhouse.io/novapay/jobs/9003",
    location: { name: "Zürich, Switzerland" },
    content:
      "Salesforce QA engineer with Apex, Copado, Provar, Salesforce CPQ, marketing cloud and certification requirements. Ten years of Salesforce-only quality engineering experience.",
  },
];

const leverJobs = [
  {
    id: "lev-1",
    text: "Test Lead",
    createdAt: now.getTime(),
    hostedUrl: "https://jobs.lever.co/novapay/lev-1",
    applyUrl: "https://jobs.lever.co/novapay/lev-1/apply",
    descriptionPlain: `${STRONG} This remote role is open to Europe.`,
    workplaceType: "remote",
    categories: { location: "Remote — Europe", commitment: "Full-time" },
  },
  {
    id: "lev-2",
    text: "QA Engineer",
    createdAt: now.getTime(),
    hostedUrl: "https://jobs.lever.co/novapay/lev-2",
    applyUrl: "https://jobs.lever.co/novapay/lev-2/apply",
    descriptionPlain: `${STRONG} This remote role is restricted to candidates based in the United States.`,
    workplaceType: "remote",
    categories: { location: "Remote — United States", commitment: "Full-time" },
  },
];

const jobsChDocuments = [
  {
    job_id: "jc-1",
    title: "QA Automation Engineer",
    company_name: "Alpine Quality GmbH",
    place: "Zürich, Switzerland",
    publication_date: recent,
    preview: STRONG,
    _links: { detail_en: { href: "https://jobs.test/detail/jc-1" } },
  },
  {
    job_id: "jc-2",
    title: "Test Manager",
    company_name: "Leman Systems SA",
    place: "Lausanne, Switzerland",
    publication_date: recent,
    preview: STRONG,
    _links: { detail_en: { href: "https://jobs.test/detail/jc-2" } },
  },
  {
    job_id: "jc-3",
    title: "QA Lead",
    company_name: "Expired Swiss AG",
    place: "Zug, Switzerland",
    publication_date: old,
    preview: STRONG,
    _links: { detail_en: { href: "https://jobs.test/detail/jc-3" } },
  },
  {
    job_id: "jc-4",
    title: "Pagination QA Engineer",
    company_name: "Pagination AG",
    place: "Bern, Switzerland",
    publication_date: recent,
    preview: STRONG,
    _links: { detail_en: { href: "https://jobs.test/detail/jc-4" } },
  },
];

function jobPostingHtml(input: { title: string; company: string; location: string; url: string; description: string; date: string }): string {
  return `<html><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: input.title,
    description: input.description,
    datePosted: input.date,
    hiringOrganization: { "@type": "Organization", name: input.company },
    jobLocation: { "@type": "Place", address: { addressLocality: input.location, addressCountry: "CH" } },
    url: input.url,
    identifier: input.url,
  })}</script></html>`;
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (mode === "all-fail") throw new TypeError("fetch failed");
  if (url.startsWith("https://apply.test/submit/")) {
    assert.equal(init?.method, "POST");
    assert.ok(init?.body instanceof FormData);
    submissionPosts += 1;
    return json({ reference: `PHASE1-${submissionPosts}` });
  }
  const fixturePage = url.match(/^https:\/\/phase1_job_\d+\.test\/(?:job|apply)$/);
  if (fixturePage) {
    const company = phase1FixtureCompanies.get(url.split("/")[2]?.split(".")[0] ?? "") ?? "Controlled Fixture AG";
    const structured = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Senior QA Automation Engineer",
      description: STRONG,
      datePosted: recent,
      hiringOrganization: { "@type": "Organization", name: company },
      jobLocation: { "@type": "Place", address: { addressLocality: "Zürich", addressCountry: "CH" } },
      url,
    };
    return new Response(
      `<html><head><title>Senior QA Automation Engineer at ${company}</title><script type="application/ld+json">${JSON.stringify(structured)}</script></head><body><h1>Senior QA Automation Engineer</h1><p>${company}</p><p>Applications are open.</p></body></html>`,
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }
  if (url.includes("retry.test/429")) {
    if (fetchCalls === 1) return new Response("", { status: 429, headers: { "Retry-After": "1" } });
    return json({ ok: true });
  }
  if (url.includes("retry.test/500")) {
    if (fetchCalls === 1) return new Response("", { status: 500 });
    return json({ ok: true });
  }
  if (url.includes("retry.test/404")) return new Response("", { status: 404 });
  if (url.includes("retry.test/timeout")) {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  if (url.includes("arbeitnow.com/api/job-board-api")) {
    return json({ data: mode === "empty" ? [] : arbeitnowJobs });
  }
  if (url.includes("api.ashbyhq.com/posting-api/job-board")) {
    if (mode === "ashby-fail") return new Response("", { status: 500 });
    if (url.includes("/broken")) return new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/empty")) return json({ jobs: [] });
    return json({ jobs: ashbyJobs });
  }
  if (url.includes("boards-api.greenhouse.io")) return json({ jobs: greenhouseJobs });
  if (url.includes("api.lever.co/v0/postings")) return json(leverJobs);
  if (url.includes("jobs.ch/api/v1/public/search")) {
    const parsed = new URL(url);
    const query = parsed.searchParams.get("query") ?? "";
    const page = Number(parsed.searchParams.get("page") ?? "1");
    const documents = page === 2
      ? [jobsChDocuments[3]]
      : query === "SDET"
        ? [jobsChDocuments[0], jobsChDocuments[2]]
        : jobsChDocuments.slice(0, 3);
    return json({ documents, current_page: page, num_pages: 2, total_hits: 4 });
  }
  if (url.startsWith("https://jobs.test/detail/")) {
    const id = url.split("/").at(-1);
    const document = jobsChDocuments.find((item) => item.job_id === id);
    assert.ok(document);
    if (document.job_id === "jc-2") return new Response("detail unavailable", { status: 500 });
    return new Response(
      jobPostingHtml({
        title: document.title,
        company: document.company_name,
        location: document.place,
        url: `https://jobs.test/job/${document.job_id}`,
        description: STRONG,
        date: document.publication_date,
      }),
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }
  if (url === "https://careers.nova.test/jobs") {
    const posting = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Career QA Engineer",
      description: STRONG,
      datePosted: recent,
      hiringOrganization: { "@type": "Organization", name: "Nova Career AG" },
      jobLocation: { "@type": "Place", address: { addressLocality: "Geneva", addressCountry: "CH" } },
      url: "https://careers.nova.test/jobs/career-qa",
    };
    const expired = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "QA Analyst",
      description: STRONG,
      datePosted: old,
      validThrough: old,
      hiringOrganization: { "@type": "Organization", name: "Nova Career AG" },
      jobLocation: { "@type": "Place", address: { addressLocality: "Basel", addressCountry: "CH" } },
      url: "https://careers.nova.test/jobs/expired-qa",
    };
    return new Response(`<html><script type="application/ld+json">${JSON.stringify([posting, expired])}</script></html>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
  throw new Error(`Unexpected test URL: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const discovery = await import("../lib/recruitment-discovery.ts");
const runs = await import("../lib/recruitment-run.ts");
const policy = await import("../lib/recruitment-policy.ts");
const sourceHttp = await import("../lib/source-http.ts");
const eligibility = await import("../lib/eligibility.ts");
const profileModule = await import("../lib/profile.ts");
const emailTemplate = await import("../lib/email-template.ts");

db.getDb();
db.run("UPDATE profiles SET email = ?, full_name = ? WHERE id = 1", ["candidate@example.com", "Abubakar Towfiq"]);
db.run("INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Playwright', 'Automation & testing', 'advanced', 1, 'manual', 99)");
mkdirSync(db.UPLOAD_DIR, { recursive: true });
writeFileSync(join(db.UPLOAD_DIR, "phase1-master-cv.pdf"), "%PDF-1.4 phase one master CV");
db.run(
  `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, status, text_content, created_at)
   VALUES ('doc_phase1_master', 'system', 'original_cv', 'Master CV', 'phase1-master-cv.pdf', 'application/pdf', 'phase1-master-cv.pdf', 31, 'ready', ?, ?)`,
  [
    [
      "Abubakar Towfiq",
      "Senior QA Automation Engineer",
      "Playwright, API testing, regression testing, test planning, release readiness and defect management.",
      "More than five years of software quality assurance experience in fintech payment platforms and mobile applications.",
      "Built and maintained automated test suites and worked with product and engineering teams on quality gates.",
      "English C1.",
    ].join("\n"),
    now.toISOString(),
  ],
);
db.run("UPDATE profiles SET source_cv_id = 'doc_phase1_master' WHERE id = 1");
// The fixture uses a local mock endpoint and must explicitly disable dry run.
db.run("UPDATE settings SET value = 'false' WHERE key = 'recruitment_dry_run'");
db.run("UPDATE settings SET value = 'true' WHERE key = 'autonomous_submission'");
db.run("UPDATE settings SET value = 'false' WHERE key = 'approval_mode'");
db.run("UPDATE settings SET value = '5' WHERE key = 'max_applications_per_day'");
db.run(
  "INSERT INTO settings (key, value, updated_at) VALUES ('standing_authorisation_activated_at', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  [JSON.stringify(now.toISOString()), now.toISOString()],
);

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
  const cvFile = `phase1-cv-${jobId}.pdf`;
  const coverFile = `phase1-cover-${jobId}.pdf`;
  writeFileSync(join(db.UPLOAD_DIR, cvFile), "%PDF-1.4 phase one tailored CV");
  writeFileSync(join(db.UPLOAD_DIR, coverFile), "%PDF-1.4 phase one cover letter");
  const cvId = `doc_${jobId}_phase1_cv`;
  const coverId = `doc_${jobId}_phase1_cover`;
  const appId = `app_${jobId}_phase1`;
  const createdAt = new Date().toISOString();
  const cvText = [
    "Abubakar Towfiq",
    `Tailored CV for ${job.title} at ${job.company}.`,
    "Senior QA engineer with more than five years of software quality assurance experience.",
    "Playwright automation, API testing, regression testing, release readiness and defect management.",
    "Built and maintained test suites for payment platforms and mobile applications in a fintech environment.",
    "Works with product and engineering teams on test strategy, test planning and quality gates.",
    "English C1.",
  ].join(" ");
  const coverText = [
    `Dear ${job.company} team,`,
    `I am applying for the ${job.title} role.`,
    "My experience covers Playwright test automation, API testing, regression testing and release readiness for payment platforms.",
    "I would welcome the opportunity to discuss how I can strengthen your quality engineering team.",
  ].join(" ");
  for (const [id, kind, file, text] of [
    [cvId, "tailored_cv", cvFile, cvText],
    [coverId, "cover_letter", coverFile, coverText],
  ] as const) {
    db.run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
       VALUES (?, 'system', ?, ?, ?, 'application/pdf', ?, 38, ?, '1.0', 'ready', 'passed', 96, ?, ?)`,
      [id, kind, `${kind} fixture`, file, file, jobId, text, createdAt],
    );
  }
  db.run(
    "INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, method, last_update, created_at) VALUES (?, ?, 'documents_preparing', ?, ?, 'http_form', ?, ?)",
    [appId, jobId, cvId, coverId, createdAt, createdAt],
  );
  return { ok: true, message: "phase 1 fixture", applicationId: appId, atsScore: 96, cvDocumentId: cvId, coverDocumentId: coverId, warnings: [] };
}

test("a normal fixture run covers every connector, deduplicates and preserves rejection reasons", async () => {
  mode = "normal";
  const result = await discovery.discoverJobSources({ runId: "run_phase1_fixture", pages: 2 });

  assert.equal(result.sourcesChecked, 6, "Arbeitnow, Ashby, Greenhouse, Lever, jobs.ch and career pages were checked");
  assert.equal(result.sourcesSucceeded, 6);
  assert.equal(result.sourcesFailed, 0);
  assert.equal(result.allSourcesFailed, false);
  assert.ok(result.inserted >= 10, `expected at least ten stored fictional vacancies, got ${result.inserted}`);
  assert.ok(result.duplicates >= 1, "the cross-source duplicate was counted");
  assert.ok(result.filtered >= 1, "expired or geographically invalid postings were rejected");

  const stored = db.all<{ title: string; company: string; source: string; eligibility: string | null }>(
    "SELECT title, company, source FROM jobs WHERE run_id = 'run_phase1_fixture'",
  );
  assert.ok(stored.length >= 10);
  assert.equal(
    stored.filter((job) => job.title === "Senior SDET" && job.company === "Novapay").length,
    1,
    "the Ashby/Greenhouse duplicate is stored once",
  );
  assert.equal(stored.some((job) => job.title === "QA Lead" && job.company === "Expired Swiss AG"), false, "expired jobs.ch vacancy is not stored");
  assert.equal(stored.some((job) => job.title === "Pagination QA Engineer" && job.company === "Pagination AG"), true, "the supported second jobs.ch page is read");
  assert.equal(stored.some((job) => job.title === "QA Analyst" && job.company === "Nova Career AG"), false, "expired career-page vacancy is not stored");

  const profile = profileModule.getProfileData();
  const german = stored.find((job) => job.title === "Senior QA Engineer" && job.company === "Novapay");
  assert.ok(german);
  const germanRow = db.one<{ id: string; title: string; company: string; description: string; location: string; remote: number; url: string; application_url: string }>(
    "SELECT id, title, company, description, location, remote, url, application_url FROM jobs WHERE title = 'Senior QA Engineer' AND company = 'Novapay' LIMIT 1",
  );
  assert.ok(germanRow);
  const germanEligibility = eligibility.assessEligibility(
    { ...germanRow, remote: Boolean(germanRow.remote), published_at: recent, employment_type: "Full-time" },
    profile,
  );
  assert.equal(germanEligibility.status, "ineligible");
  assert.ok(germanEligibility.blockers.some((blocker) => /German/i.test(blocker)));

  const berlin = db.one<{ id: string; title: string; company: string; description: string; location: string; remote: number; url: string; application_url: string }>(
    "SELECT id, title, company, description, location, remote, url, application_url FROM jobs WHERE title = 'Test Automation Engineer' AND company = 'Novapay' LIMIT 1",
  );
  assert.ok(berlin);
  const berlinEligibility = eligibility.assessEligibility(
    { ...berlin, remote: Boolean(berlin.remote), published_at: recent, employment_type: "Full-time" },
    profile,
  );
  assert.equal(berlinEligibility.status, "ineligible");
  assert.ok(berlinEligibility.blockers.some((blocker) => /outside Switzerland/i.test(blocker)));

  const health = discovery.sourceHealth();
  for (const key of ["arbeitnow", "ashby", "greenhouse", "lever", "jobs_ch", "career"]) {
    assert.ok(health.some((check) => check.source_key.startsWith(key)), `${key} health was recorded`);
  }
  assert.ok(health.every((check) => check.last_attempts > 0), "attempt counts were persisted");
});

test("HTTP 429 respects Retry-After, transient 500 retries, and permanent 404 does not loop", async () => {
  const previous = globalThis.fetch;
  try {
    let attempts429 = 0;
    globalThis.fetch = (async () => {
      attempts429 += 1;
      return attempts429 === 1
        ? new Response("", { status: 429, headers: { "Retry-After": "1" } })
        : json({ ok: true });
    }) as typeof fetch;
    const started = Date.now();
    const rateLimited = await sourceHttp.requestJson<{ ok: boolean }>("https://retry.test/429");
    assert.equal(rateLimited.ok, true);
    assert.equal(rateLimited.attempts, 2);
    assert.ok(Date.now() - started >= 900, "the Retry-After delay was respected");
    assert.equal(rateLimited.diagnostics[0]?.retryDecision, "retry");

    let attempts500 = 0;
    globalThis.fetch = (async () => {
      attempts500 += 1;
      return attempts500 === 1 ? new Response("", { status: 500 }) : json({ ok: true });
    }) as typeof fetch;
    const transient = await sourceHttp.requestJson<{ ok: boolean }>("https://retry.test/500");
    assert.equal(transient.ok, true);
    assert.equal(transient.attempts, 2);

    let attempts404 = 0;
    globalThis.fetch = (async () => {
      attempts404 += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const permanent = await sourceHttp.requestJson("https://retry.test/404");
    assert.equal(permanent.ok, false);
    assert.equal(permanent.errorCategory, "http");
    assert.equal(attempts404, 1, "a permanent client error is not retried");
  } finally {
    globalThis.fetch = previous;
  }
});

test("timeouts and malformed source responses are classified without infinite retries", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }) as typeof fetch;
    const timedOut = await sourceHttp.requestJson("https://retry.test/timeout");
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.errorCategory, "timeout");
    assert.equal(timedOut.attempts, 3, "timeouts are bounded to three attempts");

    globalThis.fetch = previous;
    mode = "malformed-ashby";
    const malformed = await discovery.discoverFromAshby(["broken"]);
    assert.equal(malformed.responses, 0);
    assert.equal(malformed.errorCategory, "parse");
    assert.match(malformed.error ?? "", /invalid response/i);

    mode = "empty";
    const empty = await discovery.discoverFromAshby(["empty"]);
    assert.equal(empty.error, null);
    assert.equal(empty.responses, 1);
    assert.equal(empty.fetched, 0);
  } finally {
    mode = "normal";
    globalThis.fetch = previous;
  }
});

test("partial source failure keeps successful results from the other sources", async () => {
  mode = "ashby-fail";
  const result = await discovery.discoverJobSources({ runId: "run_phase1_partial", pages: 1 });
  assert.equal(result.allSourcesFailed, false);
  assert.ok((result.sourcesFailed ?? 0) >= 1, "the failing Ashby source is counted");
  assert.ok((result.sourcesSucceeded ?? 0) >= 1, "other sources still succeeded");
  assert.ok(result.warnings.some((warning) => /Ashby/i.test(warning)));
  assert.equal(result.sourcesPartial, 0, "a source with no successful response is failed, not partial");
});

test("all-source failure is explicit and never reported as a successful discovery", async () => {
  mode = "all-fail";
  const result = await discovery.discoverJobSources({ runId: "run_phase1_failed", pages: 1 });
  assert.equal(result.allSourcesFailed, true);
  assert.equal(result.sourcesSucceeded, 0);
  assert.ok((result.sourcesFailed ?? 0) > 0);
  assert.equal(result.discoveryState, "failed");
  assert.ok(result.warnings.some((warning) => /All .* configured source/i.test(warning)));

  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date("2032-01-02T09:00:00Z") });
  const outcome = await runs.executeRun(created.run.id, {
    now: new Date("2032-01-02T09:00:00Z"),
    deps: {
      discover: async () => result,
    },
  });
  assert.equal(outcome.status, "failed");
  const stored = runs.runById(created.run.id);
  assert.equal(stored?.status, "failed");
  assert.match(stored?.error ?? "", /All configured job sources failed/i);
  assert.equal(stored?.applications_submitted, 0);
  mode = "normal";
});

test("dashboard and agents launchers use the multi-vacancy engine and scheduler orchestration", () => {
  const dashboard = readFileSync("app/(app)/dashboard/page.tsx", "utf8");
  const agents = readFileSync("app/(app)/agents/list/page.tsx", "utf8");
  const action = readFileSync("lib/actions/recruitment.ts", "utf8");
  const ticker = readFileSync("lib/recruitment-ticker.ts", "utf8");
  const workflow = readFileSync("lib/workflow.ts", "utf8");
  for (const page of [dashboard, agents]) {
    assert.match(page, /startAutonomousRecruitmentAction/);
    assert.doesNotMatch(page, /startWorkflowAction/);
  }
  assert.match(action, /startDailyRun\(\{ trigger: "manual"/);
  assert.match(ticker, /executeRun\(created\.run\.id/);
  assert.match(workflow, /Manual single-vacancy workflow queued/);
});

test("a six-vacancy fixture run prepares and submits only the configured daily limit, in rank order", async () => {
  const fixtures = [
    { id: "phase1_job_96", company: "Fixture Alpha AG", score: 96 },
    { id: "phase1_job_95", company: "Fixture Beta AG", score: 95 },
    { id: "phase1_job_94", company: "Fixture Gamma AG", score: 94 },
    { id: "phase1_job_93", company: "Fixture Delta AG", score: 93 },
    { id: "phase1_job_92", company: "Fixture Epsilon AG", score: 92 },
    { id: "phase1_job_91", company: "Fixture Zeta AG", score: 91 },
  ];
  const ids = new Map<string, string>();
  for (const fixture of fixtures) {
    phase1FixtureCompanies.set(fixture.id, fixture.company);
    const inserted = discovery.insertDiscovered(
      {
        source: "phase1-fixture",
        sourcePlatform: "Phase 1 fixture",
        externalId: fixture.id,
        title: "Senior QA Automation Engineer",
        company: fixture.company,
        companyDomain: `${fixture.id}.test`,
        location: "Zürich, Switzerland",
        remote: false,
        employmentType: "Full-time",
        salary: null,
        url: `https://${fixture.id}.test/job`,
        applicationUrl: `https://${fixture.id}.test/apply`,
        description: STRONG,
        publishedAt: recent,
      },
      null,
    );
    assert.ok(inserted, `fixture ${fixture.id} was inserted`);
    ids.set(fixture.id, inserted!);
    db.run("UPDATE jobs SET match_score = ? WHERE id = ?", [fixture.score, inserted]);
  }
  const rankedIds = fixtures.map((fixture) => ids.get(fixture.id)!);
  const discoveryIds = [
    rankedIds[0],
    rankedIds[0],
    ...rankedIds.slice(1),
  ];
  preparedJobs = [];
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date("2032-02-03T09:00:00Z") });
  const outcome = await runs.executeRun(created.run.id, {
    now: new Date("2032-02-03T09:00:00Z"),
    deps: {
      discover: async () => ({
        discovered: 6,
        inserted: 6,
        duplicates: 0,
        updated: 0,
        filtered: 0,
        jobIds: discoveryIds,
        sources: [
          {
            key: "phase1",
            label: "Phase 1 fixture source",
            fetched: 6,
            inserted: 6,
            error: null,
            requests: 1,
            responses: 1,
            fresh: 6,
            relevant: 6,
            duplicates: 0,
            updated: 0,
            configured: true,
            status: "ok",
            attempts: 1,
            durationMs: 1,
          },
        ],
        warnings: [],
      }),
      analyse: (jobId) =>
        ({
          score: fixtures.find((fixture) => ids.get(fixture.id) === jobId)?.score ?? 91,
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

  assert.equal(outcome.qualified, 6, "the duplicate id is assessed once");
  assert.equal(outcome.prepared, 5, "the persisted five/day cap is enforced");
  assert.equal(outcome.submitted, 5);
  assert.equal(submissionPosts, 5, "exactly five mock submissions were posted");
  assert.equal(new Set(preparedJobs).size, 5, "no vacancy is prepared twice");
  assert.deepEqual(preparedJobs, rankedIds.slice(0, 5));
  assert.ok(outcome.warnings.some((warning) => /daily submission limit/i.test(warning)));

  const stored = runs.runById(created.run.id);
  assert.equal(stored?.jobs_qualified, 6);
  assert.equal(stored?.packages_prepared, 5);
  assert.equal(stored?.applications_submitted, 5);
  assert.equal(stored?.sources_checked, 1);
  assert.equal(stored?.sources_succeeded, 1);
  assert.equal(stored?.discovery_state, "ok");

  db.closeDb();
  db.getDb();
  const afterRestart = runs.runById(created.run.id);
  assert.equal(afterRestart?.applications_submitted, 5);
  assert.ok(afterRestart?.report?.includes("Daily recruitment report"));
});

test("no real application or email is sent by the fixture suite", () => {
  assert.equal(submissionPosts, 5);
  const externalAttempts = db.all<{ channel: string; endpoint: string | null }>("SELECT channel, endpoint FROM submission_attempts");
  assert.ok(externalAttempts.every((attempt) => attempt.endpoint?.startsWith("https://apply.test/")));
  const outbox = db.all<{ recipient: string }>("SELECT recipient FROM notification_outbox");
  assert.ok(outbox.every((row) => !row.recipient || row.recipient.endsWith(".test") || row.recipient.endsWith(".local")));
});

test("the controlled fixture execution records every agent and a verified mock submission", () => {
  const run = db.one<{ id: string; run_key: string; status: string; packages_prepared: number; applications_submitted: number }>(
    "SELECT id, run_key, status, packages_prepared, applications_submitted FROM recruitment_runs WHERE packages_prepared = 5 AND applications_submitted = 5 ORDER BY started_at DESC LIMIT 1",
  );
  assert.ok(run, "the five-package controlled run is present");
  const rows = db.all<{ agent_key: string; assignment: string; status: string; output: string | null; error: string | null }>(
    "SELECT agent_key, assignment, status, output, error FROM recruitment_run_agents WHERE run_id = ? ORDER BY id",
    [run.id],
  );
  const required = ["coordinator", "research", "analysis", "cv", "cover", "ats", "application", "email"] as const;
  for (const key of required) {
    assert.ok(rows.some((row) => row.agent_key === key), `${key} has an execution record`);
    assert.ok(rows.some((row) => row.agent_key === key && row.status === "completed"), `${key} completed an assignment`);
  }
  const research = rows.filter((row) => row.agent_key === "research" && row.status === "completed").at(-1);
  assert.match(research?.output ?? "", /new|duplicates|rejected/i);
  const analysis = rows.filter((row) => row.agent_key === "analysis" && row.status === "completed").at(-1);
  assert.ok(analysis?.output, "analysis recorded its assessment");
  assert.match(rows.find((row) => row.agent_key === "cv" && row.status === "completed")?.output ?? "", /Tailored CV/i);
  assert.match(rows.find((row) => row.agent_key === "cover" && row.status === "completed")?.output ?? "", /cover letter/i);
  assert.ok(rows.some((row) => row.agent_key === "ats" && row.status === "completed" && /readiness|quality|passed/i.test(row.output ?? "")));
  assert.ok(rows.some((row) => row.agent_key === "application" && row.status === "completed" && /PHASE1-|verified|reference/i.test(row.output ?? "")));
  assert.match(rows.find((row) => row.agent_key === "email" && row.status === "completed")?.output ?? "", /HTML|report/i);

  const attempts = db.all<{ status: string; reference: string | null }>(
    "SELECT status, reference FROM submission_attempts WHERE application_id IN (SELECT id FROM applications WHERE job_id IN (SELECT id FROM jobs WHERE run_id = ?))",
    [run.id],
  );
  assert.equal(attempts.length, 5, "five controlled submissions were attempted");
  assert.ok(attempts.every((attempt) => attempt.status === "verified" && attempt.reference?.startsWith("PHASE1-")));
});

test("the execution report is generated from the controlled run with every required section", () => {
  const run = db.one<{ id: string }>(
    "SELECT id FROM recruitment_runs WHERE packages_prepared = 5 AND applications_submitted = 5 ORDER BY started_at DESC LIMIT 1",
  );
  assert.ok(run);
  const content = emailTemplate.buildRecruitmentExecutionEmail(run.id);
  assert.ok(content, "the execution report is generated from persisted run records");
  assert.match(content.subject, /Recruitment execution/i);
  const html = content.html;
  assert.match(html, /Hello/i);
  assert.match(html, />Chief</);
  assert.match(html, /Chief Coordinator \/ Orchestrator/);
  assert.match(html, /cid:atw-logo|data:image\//i);
  for (const section of [/Coordinator/i, /Research/i, /Analysis/i, /CV/i, /Cover/i, /ATS/i, /Application/i, /Email/i]) {
    assert.match(html, section);
  }
  assert.match(html, /Prepared|prepared/i);
  assert.match(html, /submitted|Submitted/i);
  assert.match(html, /pending|Pending/i);
  assert.match(html, /warning|Warning/i);
  assert.match(html, /action|Action/i);
  assert.match(html, /Duration|duration/i);
  assert.match(content.text, /Hello/i);
});
