import assert from "node:assert/strict";
import test from "node:test";

const { classifyDestination, resolveEmployerUrl, canAutoSubmitResolved } = await import("../lib/employer-links.ts");

function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

test("a direct employer host is accepted without a network request", async () => {
  let calls = 0;
  const result = await resolveEmployerUrl("https://careers.example.ch/jobs/qa-engineer", {
    fetchImpl: (async () => {
      calls += 1;
      throw new Error("must not be called");
    }) as typeof fetch,
  });
  assert.equal(result.confidence, "direct");
  assert.equal(result.employerUrl, "https://careers.example.ch/jobs/qa-engineer");
  assert.equal(result.atsVendor, null);
  assert.equal(calls, 0);
  assert.equal(canAutoSubmitResolved(result), true);
});

test("an aggregator listing is followed to the employer ATS and never auto-submitted from the aggregator", async () => {
  const calls: string[] = [];
  const result = await resolveEmployerUrl("https://www.jobs.ch/en/vacancies/detail/abc-1", {
    fetchImpl: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return redirect("https://boards.greenhouse.io/fixture/jobs/4567?gh_jid=4567");
    }) as typeof fetch,
  });
  assert.deepEqual(calls, ["https://jobs.ch/en/vacancies/detail/abc-1"]);
  assert.equal(result.confidence, "ats");
  assert.equal(result.atsVendor, "greenhouse");
  assert.equal(result.requisitionId, "4567");
  assert.equal(result.employerUrl, "https://boards.greenhouse.io/fixture/jobs/4567?gh_jid=4567");
  assert.equal(result.hops, 1);
  assert.equal(canAutoSubmitResolved(result), true);
});

test("no redirect leaves the link unresolved and unable to auto-submit", async () => {
  const result = await resolveEmployerUrl("https://www.jobs.ch/en/vacancies/detail/def-2", {
    fetchImpl: (async () => new Response("<html>Apply on employer site</html>", { status: 200 })) as typeof fetch,
  });
  assert.equal(result.confidence, "unresolved");
  assert.equal(result.employerUrl, null);
  assert.equal(canAutoSubmitResolved(result), false);
  assert.match(result.reason, /did not redirect/i);
});

test("a blocked or unavailable page is unresolved, not a closed vacancy and not a direct link", async () => {
  const blocked = await resolveEmployerUrl("https://www.jobs.ch/en/vacancies/detail/ghi-3", {
    fetchImpl: (async () => new Response("captcha", { status: 403 })) as typeof fetch,
  });
  assert.equal(blocked.confidence, "unresolved");
  assert.equal(canAutoSubmitResolved(blocked), false);

  const offline = await resolveEmployerUrl("https://www.jobs.ch/en/vacancies/detail/jkl-4", {
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch,
  });
  assert.equal(offline.confidence, "unresolved");
  assert.match(offline.reason, /could not be read/i);
});

test("an unresolved or aggregator-only vacancy is never auto-submitted", async () => {
  const { applicationProvenanceBlocker, channelFor } = await import("../lib/submission.ts");
  const base = {
    id: "job_fixture",
    title: "QA Engineer",
    company: "Fixture AG",
    description: "A normal vacancy.",
    url: "https://www.jobs.ch/en/vacancies/detail/fixture-1",
    application_url: null,
    url_confidence: "aggregator",
  };
  assert.match(String(applicationProvenanceBlocker(base)), /aggregator|not been resolved/i);
  assert.equal(channelFor(base).channel, "manual");

  const unresolved = { ...base, url_confidence: "unresolved", url: "https://example.ch/careers/qa" };
  assert.match(String(applicationProvenanceBlocker(unresolved)), /unresolved/i);

  const resolved = {
    ...base,
    url_confidence: "ats",
    application_url: "https://boards.greenhouse.io/fixture/jobs/4567",
  };
  assert.equal(applicationProvenanceBlocker(resolved), null);
  assert.notEqual(channelFor(resolved).channel, "manual");

  const legacyAggregator = { ...base, url_confidence: null };
  assert.ok(applicationProvenanceBlocker(legacyAggregator), "a legacy row with an aggregator URL is still blocked");
});

test("classification distinguishes ATS, employer, aggregator and missing", () => {
  assert.equal(classifyDestination("https://jobs.lever.co/acme/123").confidence, "ats");
  assert.equal(classifyDestination("https://inventx.onlyfy.jobs/application/apply/fixture").confidence, "ats");
  assert.equal(classifyDestination("https://ohws.prospective.ch/public/v1/redirect/fixture/ats").confidence, "ats");
  assert.equal(classifyDestination("https://join.com/companies/acme/123").confidence, "ats");
  assert.equal(classifyDestination("https://acme.example/jobs/qa").confidence, "direct");
  assert.equal(classifyDestination("https://www.jobs.ch/en/vacancies/detail/x").confidence, "aggregator");
  assert.equal(classifyDestination(null).confidence, "missing");
});
