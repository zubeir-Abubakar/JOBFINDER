import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ATS submission adapters. Every HTTP boundary is mocked: no employer, ATS or
 * network endpoint is contacted. The tests pin the two safety rules: a
 * credential that only the employer can issue gates every write, and a
 * submission is `verified` only when the ATS returns a reference.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-ats-"));
process.env.APP_SECRET_KEY = "ats-test-secret";
delete process.env.GREENHOUSE_JOB_BOARD_API_KEY;
delete process.env.LEVER_POSTINGS_API_KEY;
delete process.env.ASHBY_API_KEY;

const ats = await import("../lib/submission-ats.ts");

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function fixture(target: ReturnType<typeof ats.atsTargetFor>) {
  assert.ok(target);
  return {
    target: target!,
    job: { title: "Senior QA Engineer", company: "Acme", url: "https://acme.example/job", application_url: "https://acme.example/apply" },
    profile: {
      full_name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "+41 79 000 00 00",
      location: "Zürich",
      headline: "QA automation",
      linkedin: "https://linkedin.example/ada",
      website: null,
      work_authorisation: "Swiss Permit B",
    },
    documents: { cvPath: null, cvName: null, coverPath: null, coverName: null, coverText: "Dear hiring team" },
    at: new Date().toISOString(),
  };
}

test("ATS identity is detected from the connector or from the employer URL", () => {
  assert.equal(ats.atsTargetFor({ source: "greenhouse:sumup", external_id: "8944347002" })?.ats, "greenhouse");
  assert.equal(ats.atsTargetFor({ source: "lever:anybotics", external_id: "abc-123" })?.ats, "lever");
  assert.equal(ats.atsTargetFor({ application_url: "https://jobs.ashbyhq.com/acme/posting-1" })?.board, "acme");
  assert.equal(ats.atsTargetFor({ application_url: "https://jobs.lever.co/acme/uuid-1" })?.postingId, "uuid-1");
  // An employer-hosted URL with an embedded Greenhouse id is not a Greenhouse host.
  assert.equal(ats.atsTargetFor({ application_url: "https://sumup.com/careers/positions/8944347002?gh_jid=8944347002" }), null);
});

test("an employer-issued credential gates every ATS write", () => {
  assert.equal(ats.atsCredential("greenhouse"), null);
  process.env.GREENHOUSE_JOB_BOARD_API_KEY = "gh-employer-key";
  assert.equal(ats.atsCredential("greenhouse")?.key, "gh-employer-key");
  delete process.env.GREENHOUSE_JOB_BOARD_API_KEY;
  assert.match(ats.atsCredentialReason("greenhouse"), /candidate cannot self-issue/i);
  assert.match(ats.atsCredentialReason("lever"), /Super Admin/i);
  assert.match(ats.atsCredentialReason("ashby"), /candidatesWrite/i);
});

test("Greenhouse submits with Basic auth and verifies the returned id", async () => {
  let posted: { url: string; auth: string | null } | null = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method !== "POST") {
      return json({ questions: [{ label: "Email", required: true, fields: [{ name: "email" }] }] });
    }
    posted = { url, auth: new Headers(init?.headers).get("authorization") };
    return json({ id: 98765 });
  }) as typeof fetch;

  const result = await ats.submitViaAts(fixture(ats.atsTargetFor({ source: "greenhouse:acme", external_id: "555" })), {
    kind: "greenhouse",
    key: "gh-employer-key",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.reference, "98765");
  assert.match(posted!.url, /boards-api\.greenhouse\.io\/v1\/boards\/acme\/jobs\/555$/);
  assert.equal(posted!.auth, `Basic ${Buffer.from("gh-employer-key:").toString("base64")}`);
  assert.equal(result.evidence.ats, "greenhouse");
});

test("a required custom question is never answered by invention", async () => {
  let posts = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts += 1;
      return json({ id: 1 });
    }
    return json({
      questions: [
        { label: "Email", required: true, fields: [{ name: "email" }] },
        { label: "Expected salary in CHF", required: true, fields: [{ name: "question_99" }] },
      ],
    });
  }) as typeof fetch;

  const result = await ats.submitViaAts(fixture(ats.atsTargetFor({ source: "greenhouse:acme", external_id: "556" })), {
    kind: "greenhouse",
    key: "gh-employer-key",
  });

  assert.equal(result.status, "blocked");
  assert.match(result.detail, /no answer was invented/i);
  assert.equal(posts, 0, "nothing may be sent when a required answer is unknown");
});

test("a success response without a reference is unverified, not submitted", async () => {
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method !== "POST") return json({ questions: [] });
    return json({ ok: true });
  }) as typeof fetch;

  const result = await ats.submitViaAts(fixture(ats.atsTargetFor({ source: "greenhouse:acme", external_id: "557" })), {
    kind: "greenhouse",
    key: "gh-employer-key",
  });
  assert.equal(result.status, "unverified");
  assert.equal(result.reference, null);
});

test("Lever submits to the postings endpoint and reads its applicationId", async () => {
  let seen = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return json({ applicationId: "lev-99" }, 201);
  }) as typeof fetch;

  const result = await ats.submitViaAts(fixture(ats.atsTargetFor({ source: "lever:anybotics", external_id: "uuid-1" })), {
    kind: "lever",
    key: "lever-employer-key",
  });

  assert.equal(result.status, "verified");
  assert.equal(result.reference, "lev-99");
  assert.match(seen, /api\.lever\.co\/v0\/postings\/anybotics\/uuid-1\?key=lever-employer-key/);
});

test("Ashby rejections are recorded without claiming a submission", async () => {
  globalThis.fetch = (async () => json({ error: "invalid form fields" }, 400)) as typeof fetch;
  const result = await ats.submitViaAts(fixture(ats.atsTargetFor({ source: "ashby:acme", external_id: "posting-1" })), {
    kind: "ashby",
    key: "ashby-employer-key",
  });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /Nothing was recorded as submitted/i);
  assert.equal(result.reference, null);
});
