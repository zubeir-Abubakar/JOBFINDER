import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-jobs-ch-links-"));
process.env.APP_SECRET_KEY = "jobs-ch-links-test";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const links = await import("../lib/employer-links.ts");
const discovery = await import("../lib/recruitment-discovery.ts");
const backfill = await import("../lib/jobs-ch-resolution.ts");

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const DESCRIPTION =
  "We are hiring a senior QA automation engineer to own Playwright and API testing for a Swiss payments platform. " +
  "You will build regression suites, improve release readiness and report defects in Jira. English is required.";

function resolution(overrides: Record<string, unknown> = {}) {
  return {
    requestedUrl: "https://www.jobs.ch/en/vacancies/detail/jc-9001",
    finalUrl: "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001",
    employerUrl: "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001",
    atsVendor: "greenhouse",
    requisitionId: "9001",
    confidence: "ats" as const,
    reason: "Hosted on the supported greenhouse ATS.",
    hops: 1,
    httpStatus: null,
    method: "embedded_link" as const,
    ...overrides,
  };
}

test("a jobs.ch page is followed through an explicit employer apply link", async () => {
  const calls: string[] = [];
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/jc-9001", {
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        '<html><body><a href="https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001" rel="nofollow">Apply now</a></body></html>',
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.deepEqual(calls, ["https://jobs.ch/en/vacancies/detail/jc-9001"]);
  assert.equal(result.confidence, "ats");
  assert.equal(result.method, "embedded_link");
  assert.equal(result.atsVendor, "greenhouse");
  assert.equal(result.requisitionId, "9001");
  assert.equal(result.employerUrl, "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001");
  assert.equal(links.canAutoSubmitResolved(result), true);
});

test("a jobs.ch redirect still wins and records its method", async () => {
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/jc-9002", {
    fetchImpl: (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://jobs.lever.co/fixture/9002" },
      })) as typeof fetch,
  });
  assert.equal(result.confidence, "ats");
  assert.equal(result.method, "redirect");
  assert.equal(result.atsVendor, "lever");
});

test("a jobs.ch detail page follows its application-redirect route to the employer", async () => {
  const calls: string[] = [];
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a", {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/vacancies/detail/")) return new Response("<html><body>Easy apply</body></html>", { status: 200 });
      if (url.includes("/application-redirect/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://careers.example.ch/jobs/senior-test-engineer" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch,
  });
  assert.deepEqual(calls, [
    "https://jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a",
    "https://www.jobs.ch/en/vacancies/application-redirect/6356cbdb-93a9-43b6-8cc3-9d663049c06a/",
  ]);
  assert.equal(result.confidence, "direct");
  assert.equal(result.employerUrl, "https://careers.example.ch/jobs/senior-test-engineer");
  assert.equal(result.method, "redirect");
});

test("a jobs.ch application page exposes the employer URL in hydration state", async () => {
  const calls: string[] = [];
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a", {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/vacancies/detail/")) return new Response("<html><body>Easy apply</body></html>", { status: 200 });
      return new Response(
        '<html><script>__REACT_QUERY_STATE__ = {"queries":[{"state":{"data":{"applicationOptions":{"isApplicationMethodOnline":false,"method":"APPLICATION_METHOD.EXTERNAL","externalUrl":"https:\\u002F\\u002Fohws.prospective.ch\\u002Fpublic\\u002Fv1\\u002Fredirect\\u002Ffixture\\u002Fats"}}}}]};</script></html>',
        { status: 200 },
      );
    }) as typeof fetch,
  });
  assert.equal(calls.length, 2);
  assert.equal(result.confidence, "ats");
  assert.equal(result.atsVendor, "prospective");
  assert.equal(result.employerUrl, "https://ohws.prospective.ch/public/v1/redirect/fixture/ats");
  assert.equal(result.method, "embedded_link");
});

test("a jobs.ch-hosted quick-apply form is not recorded as an employer URL", async () => {
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/6356cbdb-93a9-43b6-8cc3-9d663049c06a", {
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/vacancies/detail/")) return new Response("<html><body>Easy apply</body></html>", { status: 200 });
      if (url.includes("/application-redirect/")) {
        return new Response(
          '<html><script>__REACT_QUERY_STATE__ = {"queries":[{"state":{"data":{"applicationOptions":{"isApplicationMethodOnline":true,"method":"APPLICATION_METHOD.ONLINE","externalUrl":""}}}}]};</script></html>',
          { status: 200 },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch,
  });
  assert.equal(result.confidence, "unresolved");
  assert.equal(result.employerUrl, null);
  assert.match(result.reason, /quick-apply form/i);
});

test("a jobs.ch page with no employer link remains unresolved", async () => {
  const result = await links.resolveJobsChEmployerUrl("https://www.jobs.ch/en/vacancies/detail/jc-9003", {
    fetchImpl: (async () => new Response("<html><body>Apply on employer site</body></html>", { status: 200 })) as typeof fetch,
  });
  assert.equal(result.confidence, "unresolved");
  assert.equal(result.employerUrl, null);
  assert.equal(result.method, "unresolved");
  assert.match(result.reason, /no employer application link/i);
});

test("resolved provenance is stored with the vacancy and duplicate refresh", () => {
  const provenance = links.employerUrlProvenance(resolution(), "2026-11-24T12:00:00.000Z");
  const id = discovery.insertDiscovered(
    {
      source: "jobs_ch",
      sourcePlatform: "jobs.ch · fixture",
      externalId: "jc-9001",
      title: "Senior QA Automation Engineer",
      company: "Provenance Fixture AG",
      companyDomain: null,
      location: "Zürich, Switzerland",
      remote: false,
      employmentType: "Full-time",
      salary: null,
      url: "https://www.jobs.ch/en/vacancies/detail/jc-9001",
      applicationUrl: null,
      urlProvenance: provenance,
      description: DESCRIPTION,
      publishedAt: "2026-11-24T08:00:00.000Z",
      raw: { fixture: true },
    },
    null,
  );
  assert.ok(id);
  const row = db.one<{
    application_url: string;
    employer_url: string;
    ats_vendor: string;
    requisition_id: string;
    url_confidence: string;
    url_provenance: string;
  }>(
    "SELECT application_url, employer_url, ats_vendor, requisition_id, url_confidence, url_provenance FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.application_url, "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001");
  assert.equal(row?.employer_url, "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001");
  assert.equal(row?.ats_vendor, "greenhouse");
  assert.equal(row?.requisition_id, "9001");
  assert.equal(row?.url_confidence, "ats");
  const stored = JSON.parse(row?.url_provenance ?? "{}");
  assert.equal(stored.resolver, "jobs_ch");
  assert.equal(stored.method, "embedded_link");
  assert.equal(stored.resolvedAt, "2026-11-24T12:00:00.000Z");
});

test("an unresolved listing records evidence but never invents an application URL", () => {
  const provenance = links.employerUrlProvenance(
    resolution({
      finalUrl: "https://jobs.ch/en/vacancies/detail/jc-9004",
      employerUrl: null,
      atsVendor: null,
      requisitionId: null,
      confidence: "unresolved",
      reason: "The listing page did not redirect and no employer application link was found.",
      method: "unresolved",
    }),
    "2026-11-24T12:05:00.000Z",
  );
  const id = discovery.insertDiscovered(
    {
      source: "jobs_ch",
      sourcePlatform: "jobs.ch · fixture",
      externalId: "jc-9004",
      title: "QA Engineer",
      company: "Unresolved Fixture AG",
      companyDomain: null,
      location: "Bern, Switzerland",
      remote: false,
      employmentType: null,
      salary: null,
      url: "https://www.jobs.ch/en/vacancies/detail/jc-9004",
      applicationUrl: null,
      urlProvenance: provenance,
      description: DESCRIPTION,
      publishedAt: "2026-11-24T08:00:00.000Z",
      raw: { fixture: true },
    },
    null,
  );
  assert.ok(id);
  const row = db.one<{ application_url: string | null; url_confidence: string; url_provenance: string }>(
    "SELECT application_url, url_confidence, url_provenance FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(row?.application_url, null);
  assert.equal(row?.url_confidence, "unresolved");
  assert.match(JSON.parse(row?.url_provenance ?? "{}").reason, /no employer application link/i);
});

test("the stored-jobs backfill resolves an older aggregator row", async () => {
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, application_url, url_confidence,
       description, discovered_at, status, dedupe_key)
     VALUES ('job_backfill_jobs_ch', 'jobs_ch', 'jc-9005', 'QA Automation Engineer', 'Backfill AG', 'Zug, Switzerland',
       'https://www.jobs.ch/en/vacancies/detail/jc-9005', NULL, 'aggregator', ?, ?, 'new', 'backfill-jobs-ch')`,
    [DESCRIPTION, new Date().toISOString()],
  );
  const summary = await backfill.resolveStoredJobsChUrls({
    resolve: async () => resolution({ requestedUrl: "https://www.jobs.ch/en/vacancies/detail/jc-9005" }),
  });
  assert.ok(summary.checked >= 1);
  assert.ok(summary.resolved >= 1);
  const row = db.one<{ application_url: string; url_confidence: string; url_provenance: string }>(
    "SELECT application_url, url_confidence, url_provenance FROM jobs WHERE id = 'job_backfill_jobs_ch'",
  );
  assert.equal(row?.application_url, "https://boards.greenhouse.io/fixture/jobs/9001?gh_jid=9001");
  assert.equal(row?.url_confidence, "ats");
  assert.equal(JSON.parse(row?.url_provenance ?? "{}").method, "embedded_link");
});
