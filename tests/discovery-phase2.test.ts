import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 2 discovery acceptance fixtures.
 *
 * Every employer, board and vacancy below is fictional. HTTP is intercepted by
 * the local mock. No employer, job board, AI provider or submission endpoint is
 * contacted; no application is created or sent.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-discovery-phase2-"));
process.env.APP_SECRET_KEY = "discovery-phase2-test-secret";
process.env.RECRUITMENT_HTTP_RETRY_BASE_MS = "1";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.GEMINI_API_KEY = "";
delete process.env.GEMINI_API_KEY;
process.env.ASHBY_JOB_BOARDS = "phase2";
process.env.GREENHOUSE_BOARDS = "phase2gh";
process.env.LEVER_SITES = "phase2lever";
process.env.JOBS_CH_QUERIES = "QA Engineer";
process.env.EMPLOYER_CAREER_PAGES = "https://careers.phase2.test/jobs";

const now = Date.now();
const recent = new Date(now - 60 * 60_000).toISOString();
const old = new Date(now - 400 * 86_400_000).toISOString();

const STRONG = [
  "We are hiring a senior quality engineer with five years of software testing experience.",
  "You will own Playwright, Cypress, Selenium and Appium test automation, REST API testing with Postman,",
  "CI pipelines in Jenkins and Azure DevOps, Docker, Git, Jira and SQL.",
  "The team ships a fintech payments platform; you will lead test planning, regression testing and release readiness.",
  "English is required. This is a full-time role.",
].join(" ");

const NO_LANGUAGE = [
  "We are hiring a senior software quality engineer to own test automation with Playwright, Selenium and API testing.",
  "You will build regression suites, run CI pipelines and lead release readiness for a cloud payments platform in Switzerland.",
].join(" ");

type Mode = "normal" | "ashby-fail" | "jobs-ch-500" | "empty";

let mode: Mode = "normal";
let fetchCalls = 0;
let rateLimitCalls = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function jobPostingHtml(input: {
  title: string;
  company: string;
  location: string;
  url: string;
  description: string;
  datePosted?: string;
  validThrough?: string;
}): string {
  return `<html><head><title>${input.title}</title><script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: input.title,
    description: input.description,
    datePosted: input.datePosted ?? recent,
    ...(input.validThrough ? { validThrough: input.validThrough } : {}),
    hiringOrganization: { "@type": "Organization", name: input.company },
    jobLocation: {
      "@type": "Place",
      address: { addressLocality: input.location, addressCountry: "CH" },
    },
    url: input.url,
    identifier: input.url,
  })}</script></head><body><h1>${input.title}</h1><p>${input.company}</p></body></html>`;
}

const arbeitnowJobs = [
  {
    slug: "p2-arb-current",
    company_name: "Helvetia Quality AG",
    title: "Senior QA Automation Engineer",
    location: "Bern, Switzerland",
    remote: false,
    url: "https://careers.helvetia-quality.test/jobs/arb-current",
    description: STRONG,
    created_at: Math.floor(now / 1000),
    job_types: ["Full-time"],
  },
  {
    slug: "p2-arb-old-open",
    company_name: "Old But Open GmbH",
    title: "QA Engineer",
    location: "Zürich, Switzerland",
    remote: false,
    url: "https://careers.old-but-open.test/jobs/arb-old",
    description: STRONG,
    created_at: Math.floor(new Date(old).getTime() / 1000),
    job_types: ["Full-time"],
  },
  {
    slug: "p2-arb-berlin",
    company_name: "Berlin Product AG",
    title: "QA Engineer",
    location: "Berlin, Germany",
    remote: false,
    url: "https://careers.berlin-product.test/jobs/arb-berlin",
    description: STRONG,
    created_at: Math.floor(now / 1000),
    job_types: ["Full-time"],
  },
  {
    slug: "p2-arb-non-qa",
    company_name: "Product House AG",
    title: "Product Manager, Payments",
    location: "Zürich, Switzerland",
    remote: false,
    url: "https://careers.product-house.test/jobs/arb-pm",
    description: STRONG,
    created_at: Math.floor(now / 1000),
    job_types: ["Full-time"],
  },
];

const ashbyJobs = [
  {
    id: "p2-ash-old-open",
    title: "SDET",
    location: "Zürich, Switzerland",
    employmentType: "Full-time",
    isRemote: false,
    publishedAt: old,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-old-open",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-old-open/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-remote-emea",
    title: "QA Engineer - Core Database (remote)",
    location: "EMEA",
    publishedAt: old,
    isRemote: null,
    workplaceType: null,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-remote-emea",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-remote-emea/apply",
    descriptionPlain: `${STRONG} This role is remote across EMEA.`,
    isListed: true,
  },
  {
    id: "p2-ash-expired",
    title: "QA Lead",
    location: "Bern, Switzerland",
    publishedAt: old,
    applicationDeadline: old,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-expired",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-expired/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-no-url",
    title: "QA Engineer — No Link",
    location: "Lausanne, Switzerland",
    publishedAt: recent,
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-location-biel",
    title: "QA Engineer (Location Split)",
    location: "Biel, Switzerland",
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-location-biel",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-location-biel/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-location-zurich",
    title: "QA Engineer (Location Split)",
    location: "Zürich, Switzerland",
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-location-zurich",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-location-zurich/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-cross-source",
    title: "Senior QA Automation Engineer",
    location: "Zürich, Switzerland",
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-cross-source",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-cross-source/apply",
    descriptionPlain: STRONG,
    isListed: true,
  },
  {
    id: "p2-ash-german",
    title: "Senior QA Engineer",
    location: "Bern, Switzerland",
    publishedAt: recent,
    jobUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-german",
    applyUrl: "https://jobs.ashbyhq.com/phase2/p2-ash-german/apply",
    descriptionPlain: `${STRONG} Fluent German (C1) is mandatory for this role.`,
    isListed: true,
  },
];

const greenhouseJobs = [
  {
    id: 22001,
    title: "Senior QA Automation Engineer",
    company_name: "Phase2",
    updated_at: recent,
    first_published: old,
    absolute_url: "https://boards.greenhouse.io/phase2gh/jobs/22001",
    location: { name: "Zürich, Switzerland" },
    content: STRONG,
  },
  {
    id: 22002,
    title: "Software Development Engineer in Test",
    company_name: "Greenhouse Fixture AG",
    updated_at: recent,
    first_published: old,
    absolute_url: "https://boards.greenhouse.io/phase2gh/jobs/22002",
    location: { name: "Remote — Europe" },
    content: STRONG,
  },
];

const leverJobs = [
  {
    id: "p2-lever-1",
    text: "Test Lead",
    createdAt: now,
    hostedUrl: "https://jobs.lever.co/phase2lever/p2-lever-1",
    applyUrl: "https://jobs.lever.co/phase2lever/p2-lever-1/apply",
    descriptionPlain: `${STRONG} This remote role is open to applicants across Europe.`,
    workplaceType: "remote",
    categories: { location: "Remote — Europe", commitment: "Full-time" },
  },
];

const jobsChDocuments = [
  {
    job_id: "p2-jc-preview-defect",
    title: "Quality Assurance & Test Manager 80-100%",
    company_name: "Swiss Life Fixture AG",
    place: "Zürich",
    publication_date: old,
    // The real preview often contains no software vocabulary. The connector
    // must read the detail page before rejecting this genuine QA role.
    preview: "You know what it takes to implement demanding projects with high quality.",
    _links: { detail_en: { href: "https://jobs.test/detail/p2-jc-preview-defect" } },
  },
  {
    job_id: "p2-jc-expired",
    title: "QA Lead",
    company_name: "Expired Swiss AG",
    place: "Zug",
    publication_date: old,
    preview: "A QA leadership role with test automation and software delivery.",
    _links: { detail_en: { href: "https://jobs.test/detail/p2-jc-expired" } },
  },
  {
    job_id: "p2-jc-non-qa",
    title: "Project Manager Transformation",
    company_name: "Project House AG",
    place: "Geneva",
    publication_date: recent,
    preview: "Lead a finance transformation programme.",
    _links: { detail_en: { href: "https://jobs.test/detail/p2-jc-non-qa" } },
  },
  {
    job_id: "p2-jc-pagination",
    title: "QA Automation Engineer",
    company_name: "Pagination Fixture AG",
    place: "Lausanne",
    publication_date: recent,
    preview: "Playwright and API testing for a cloud platform.",
    _links: { detail_en: { href: "https://jobs.test/detail/p2-jc-pagination" } },
  },
];

let jobBoardQueries = 0;
let jobsChPageOneCalls = 0;
let jobsChPageTwoCalls = 0;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  fetchCalls += 1;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("retry.test/429")) {
    rateLimitCalls += 1;
    return rateLimitCalls === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
      : json({ ok: true });
  }
  if (url.includes("retry.test/403")) return new Response("", { status: 403 });
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
    return json({ jobs: ashbyJobs });
  }
  if (url.includes("boards-api.greenhouse.io")) {
    return json({ jobs: greenhouseJobs });
  }
  if (url.includes("api.lever.co/v0/postings")) {
    return json(leverJobs);
  }
  if (url.includes("jobs.ch/api/v1/public/search")) {
    if (mode === "jobs-ch-500") return new Response("", { status: 500 });
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page") ?? "1");
    jobBoardQueries += 1;
    if (page === 1) {
      jobsChPageOneCalls += 1;
      return json({ documents: jobsChDocuments.slice(0, 3), current_page: 1, num_pages: 2, total_hits: 4 });
    }
    jobsChPageTwoCalls += 1;
    return json({ documents: [jobsChDocuments[3]], current_page: 2, num_pages: 2, total_hits: 4 });
  }
  if (url.startsWith("https://jobs.test/detail/")) {
    const id = url.split("/").at(-1);
    const document = jobsChDocuments.find((item) => item.job_id === id);
    assert.ok(document, `unexpected jobs.ch detail ${id}`);
    return new Response(
      jobPostingHtml({
        title: document.title,
        company: document.company_name,
        location: document.place,
        url: `https://jobs.test/job/${document.job_id}`,
        description: STRONG,
        datePosted: document.publication_date,
        validThrough: document.job_id === "p2-jc-expired" ? old : undefined,
      }),
      { status: 200, headers: { "Content-Type": "text/html" } },
    );
  }
  if (url === "https://careers.phase2.test/jobs") {
    const open = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Career QA Engineer",
      description: STRONG,
      datePosted: old,
      hiringOrganization: { "@type": "Organization", name: "Nova Career Fixture AG" },
      jobLocation: { "@type": "Place", address: { addressLocality: "Geneva", addressCountry: "CH" } },
      url: "https://careers.phase2.test/jobs/career-old-open",
    };
    const expired = {
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "QA Analyst",
      description: STRONG,
      datePosted: old,
      validThrough: old,
      hiringOrganization: { "@type": "Organization", name: "Nova Career Fixture AG" },
      jobLocation: { "@type": "Place", address: { addressLocality: "Basel", addressCountry: "CH" } },
      url: "https://careers.phase2.test/jobs/career-expired",
    };
    return new Response(`<html><script type="application/ld+json">${JSON.stringify([open, expired])}</script></html>`, {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
  if (url === "https://js-only.test/careers") {
    return new Response("<html><body><div id=\"root\"></div><script src=\"/app.js\"></script></body></html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
  }
  throw new Error(`Unexpected Phase 2 test fetch: ${url}`);
}) as typeof fetch;

const db = await import("../lib/db.ts");
const discovery = await import("../lib/recruitment-discovery.ts");
const sourceHttp = await import("../lib/source-http.ts");
const eligibility = await import("../lib/eligibility.ts");
const profileModule = await import("../lib/profile.ts");
const runs = await import("../lib/recruitment-run.ts");
const jobs = await import("../lib/jobs.ts");
const scoring = await import("../lib/scoring.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

test("all six source families retrieve, parse, qualify and persist genuine listings", async () => {
  mode = "normal";
  const result = await discovery.discoverJobSources({ runId: "run_p2_normal", pages: 2 });
  assert.equal(result.sourcesChecked, 6);
  assert.equal(result.sourcesSucceeded, 6);
  assert.equal(result.sourcesFailed, 0);
  assert.ok(result.inserted >= 10, `expected genuine persisted listings, got ${result.inserted}`);

  const stored = db.all<{
    id: string;
    source: string;
    title: string;
    company: string;
    location: string;
    salary: string | null;
    published_at: string | null;
    description: string;
  }>("SELECT id, source, title, company, location, salary, published_at, description FROM jobs ORDER BY discovered_at");

  // Old publication dates are not expiry evidence.
  assert.ok(
    stored.some((job) => job.title === "SDET" && job.source === "ashby" && job.published_at === old),
    "an old Ashby listing is stored when the source does not declare a deadline",
  );
  assert.ok(
    stored.some((job) => job.title === "QA Engineer" && job.company === "Old But Open GmbH"),
    "an old Arbeitnow listing is stored when it is still returned by the source",
  );
  assert.ok(
    stored.some((job) => job.title === "Career QA Engineer" && job.published_at === old),
    "an old career-page listing with no expiry is stored",
  );

  // The jobs.ch preview defect: no software vocabulary in the preview, full
  // software-QA responsibilities in the JSON-LD detail.
  const previewDefect = stored.find((job) => job.title === "Quality Assurance & Test Manager 80-100%");
  assert.ok(previewDefect, "jobs.ch full detail is read before classification");
  assert.match(previewDefect!.description, /Playwright|software testing|API/i);
  assert.equal(previewDefect!.source, "jobs_ch");
  assert.ok(
    stored.some((job) => job.company === "Pagination Fixture AG"),
    "the second jobs.ch page is read",
  );

  // Same employer and title in different cities is two real vacancies.
  const locations = stored.filter((job) => job.title === "QA Engineer (Location Split)");
  assert.equal(locations.length, 2, "location is part of vacancy identity");
  assert.deepEqual(locations.map((job) => job.location).sort(), ["Biel, Switzerland", "Zürich, Switzerland"]);

  // Duplicate listing across Ashby and Greenhouse is one canonical vacancy.
  assert.equal(
    stored.filter((job) => job.title === "Senior QA Automation Engineer" && job.company === "Phase2").length,
    1,
    "the cross-source duplicate is stored once",
  );

  // Missing salary is not a rejection.
  assert.ok(stored.some((job) => job.title === "SDET" && job.salary === null));
  assert.ok(stored.some((job) => job.company === "Greenhouse Fixture AG" && job.salary === null));

  // Genuinely expired and non-QA listings are not persisted.
  assert.equal(stored.some((job) => job.title === "QA Lead" && job.company === "Expired Swiss AG"), false);
  assert.equal(stored.some((job) => job.company === "Expired Swiss AG"), false);
  assert.equal(stored.some((job) => job.title === "QA Analyst" && job.company === "Nova Career Fixture AG"), false);
  assert.equal(stored.some((job) => job.company === "Berlin Product AG"), false);
  assert.equal(stored.some((job) => job.title === "Project Manager, Payments"), false);

  // Rejection explanations are persisted with the run metrics.
  const ashby = result.sources.find((source) => source.key === "ashby");
  assert.ok(
    Object.keys(ashby?.rejectionReasons ?? {}).some((reason) => reason.startsWith("Source states the application deadline has passed")),
    "expired Ashby listing has an exact deadline rejection reason",
  );
  assert.ok(ashby?.rejectionReasons?.["Missing the original job URL"]);
  assert.ok(result.sources.find((source) => source.key === "jobs_ch")?.rejectionReasons?.["Not a QA/testing title"]);

  // Repeated polling updates last-seen evidence but creates no duplicate.
  const countBefore = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c);
  const second = await discovery.discoverJobSources({ runId: "run_p2_repeat", pages: 2 });
  assert.equal(second.inserted, 0, "a repeated poll creates no new duplicate");
  assert.ok(second.duplicates > 0, "known listings are counted as duplicates");
  const countAfter = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c);
  assert.equal(countAfter, countBefore, "repeated polling keeps one canonical row per vacancy");

  // Persistence and display query both see the genuine rows.
  const listed = jobs.listJobs({ limit: 200, status: "all" });
  assert.ok(listed.length >= 10);
  assert.ok(listed.some((job) => job.title === "Quality Assurance & Test Manager 80-100%"));
});

test("jobs.ch pagination and full-detail qualification are independently verifiable", async () => {
  const first = await discovery.discoverFromJobsCh(["QA Engineer"], { page: 1, detailsPerQuery: 10 });
  assert.equal(first.responses, 3, "one search response plus two fetched detail pages");
  assert.equal(first.fetched, 3);
  assert.ok(first.jobs.some((job) => job.title === "Quality Assurance & Test Manager 80-100%"));
  assert.equal(first.jobs.some((job) => job.title === "QA Lead"), false);

  const second = await discovery.discoverFromJobsCh(["QA Engineer"], { page: 2, detailsPerQuery: 10 });
  assert.equal(second.fetched, 1);
  assert.equal(second.jobs[0]?.title, "QA Automation Engineer");
});

test("403, 429 and timeout are bounded and classified without claiming success", async () => {
  const forbidden = await sourceHttp.requestJson("https://retry.test/403");
  assert.equal(forbidden.ok, false);
  assert.equal(forbidden.errorCategory, "authentication");
  assert.equal(forbidden.attempts, 1);

  rateLimitCalls = 0;
  const limited = await sourceHttp.requestJson("https://retry.test/429");
  assert.equal(limited.ok, true);
  assert.equal(limited.attempts, 2, "429 respects Retry-After and retries once");

  const timedOut = await sourceHttp.requestJson("https://retry.test/timeout");
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.errorCategory, "timeout");
  assert.equal(timedOut.attempts, 3);
});

test("a source failure is isolated and the remaining sources still contribute", async () => {
  mode = "ashby-fail";
  const before = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c);
  const result = await discovery.discoverJobSources({ runId: "run_p2_partial", pages: 1 });
  mode = "normal";
  assert.equal(result.allSourcesFailed, false);
  assert.ok((result.sourcesFailed ?? 0) >= 1);
  assert.ok((result.sourcesSucceeded ?? 0) >= 1);
  assert.ok(result.sources.some((source) => source.key === "jobs_ch" && source.responses > 0));
  const after = Number(db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c);
  assert.ok(after >= before, "a failed source does not delete or corrupt persisted vacancies");
});

test("Swiss Permit B, missing language metadata and missing salary do not eliminate a relevant vacancy", () => {
  const profile = profileModule.getProfileData();
  assert.match(profile.profile.work_authorisation ?? "", /Permit B/i);
  const assessment = eligibility.assessEligibility(
    {
      title: "Senior QA Automation Engineer",
      company: "Permit B Fixture AG",
      location: "Bern, Switzerland",
      description: NO_LANGUAGE,
      remote: false,
      application_url: "https://permit-b.test/apply",
      url: "https://permit-b.test/job",
      published_at: old,
      employment_type: "Full-time",
    },
    profile,
  );
  assert.equal(assessment.status, "eligible");
  assert.equal(assessment.sponsorshipRequired, "no");
  assert.equal(assessment.germanRequired, false);
  assert.equal(assessment.frenchRequired, false);

  const biel = eligibility.assessEligibility(
    {
      title: "Software Development Engineer in Test (SDET)",
      company: "Akros Fixture AG",
      location: "Biel",
      remote: false,
      description: "Build Playwright and API test automation for a software platform in Switzerland.",
      application_url: "https://akros.test/jobs/biel-sdet",
    },
    profile,
  );
  assert.equal(biel.status, "eligible", "Biel is a Swiss location and must not be treated as foreign");
});

test("marketing copy and contradictory remote flags cannot make a foreign onsite role eligible", () => {
  const profile = profileModule.getProfileData();
  const assessment = eligibility.assessEligibility(
    {
      title: "Backend QA Engineer, Berlin",
      company: "Air Apps Fixture",
      location: "Berlin Metropolitain Area",
      remote: true,
      description:
        "We reach over 100 million downloads worldwide. This is a fully onsite position, based at our office in Lisbon. You will test backend APIs and maintain automation.",
      application_url: "https://careers.phase2.test/foreign-onsite",
    },
    profile,
  );
  assert.notEqual(assessment.status, "eligible");
  assert.ok(assessment.blockers.some((blocker) => /on-site role outside Switzerland/i.test(blocker)));

  const mislabeledSwiss = eligibility.assessEligibility(
    {
      title: "QA Automation Engineer",
      company: "Air Apps Fixture",
      location: "Zurich",
      remote: false,
      description:
        "This is a fully onsite position, based at our office in Lisbon. You will maintain automated tests for our apps worldwide.",
      application_url: "https://careers.phase2.test/mislabeled-zurich",
    },
    profile,
  );
  assert.notEqual(mislabeledSwiss.status, "eligible", "a Swiss location label cannot override explicit foreign onsite evidence");
  assert.ok(mislabeledSwiss.blockers.some((blocker) => /on-site role outside Switzerland/i.test(blocker)));
});

test("a mandatory qualification gap blocks auto-apply even above 85%", () => {
  assert.equal(
    scoring.qualifiesForAutoApply({
      score: 92,
      concerns: [],
      mandatoryBlockers: ["ISTQB is stated as a requirement."],
    }),
    false,
  );
  assert.ok(scoring.autoApplyBlockers({ score: 92, mandatoryBlockers: ["ISTQB is stated as a requirement."] }).length > 0);
});

test("a JavaScript-only page is reported empty rather than fabricated", async () => {
  const result = await discovery.discoverFromCareerPages(["https://js-only.test/careers"]);
  assert.equal(result.responses, 1);
  assert.equal(result.fetched, 0);
  assert.equal(result.jobs.length, 0, "unsupported JavaScript rendering is not claimed as discovery");
});

test("Chief orchestrates discovery-only work with real task lifecycles and no AI usage", async () => {
  const stored = db.all<{ id: string }>("SELECT id FROM jobs ORDER BY discovered_at LIMIT 3").map((row) => row.id);
  assert.ok(stored.length > 0);
  const created = runs.createRecruitmentRun({ trigger: "manual", now: new Date(), discoveryOnly: true });
  const outcome = await runs.executeRun(created.run.id, {
    discoveryOnly: true,
    deps: {
      discover: async () => ({
        discovered: stored.length,
        inserted: 0,
        duplicates: 0,
        updated: 0,
        filtered: 0,
        jobIds: stored,
        sources: [
          {
            key: "phase2-fixture",
            label: "Phase 2 fixture source",
            fetched: stored.length,
            inserted: 0,
            error: null,
            requests: 1,
            responses: 1,
            fresh: stored.length,
            relevant: stored.length,
            duplicates: 0,
            updated: 0,
            configured: true,
            status: "ok",
            attempts: 1,
            durationMs: 1,
          },
        ],
        warnings: [],
        discoveryState: "ok",
      }),
    },
  });
  assert.equal(outcome.prepared, 0, "discovery-only never prepares documents");
  assert.equal(outcome.submitted, 0, "discovery-only never submits applications");

  const workflow = db.one<{ kind: string; status: string }>(
    "SELECT kind, status FROM workflows WHERE id = (SELECT workflow_id FROM recruitment_runs WHERE id = ?)",
    [created.run.id],
  );
  assert.equal(workflow?.kind, "autonomous_recruitment");

  const taskRows = db.all<{ agent_key: string; status: string; title: string }>(
    "SELECT agent_key, status, title FROM tasks WHERE workflow_id = (SELECT workflow_id FROM recruitment_runs WHERE id = ?)",
    [created.run.id],
  );
  for (const agent of ["coordinator", "research"]) {
    assert.ok(
      taskRows.some((task) => task.agent_key === agent && task.status === "completed"),
      `${agent} has a completed actual task: ${JSON.stringify(taskRows)}`,
    );
  }
  // The analysis task cannot be opened while the isolated fixture profile lacks
  // verified skills, but the run ledger must still record the deterministic
  // assessment honestly instead of inventing an agent execution.
  const agentRows = db.all<{ agent_key: string; status: string; output: string | null }>(
    "SELECT agent_key, status, output FROM recruitment_run_agents WHERE run_id = ?",
    [created.run.id],
  );
  const analysisAgent = agentRows.find((agent) => agent.agent_key === "analysis");
  assert.ok(analysisAgent, "analysis work is recorded in the run ledger");
  assert.ok(["completed", "blocked"].includes(analysisAgent!.status));
  assert.ok(agentRows.some((agent) => agent.agent_key === "coordinator" && agent.status === "completed"));
  const research = taskRows.find((task) => task.agent_key === "research");
  assert.match(research?.title ?? "", /Search configured sources/i);

  const usage = db.one<{ c: number }>("SELECT COUNT(*) AS c FROM provider_usage")?.c;
  assert.equal(Number(usage), 0, "deterministic discovery made no invented AI call");
});
