import { test, expect } from "@playwright/test";
import type { CandidateDocuments, CandidateProfile } from "../lib/candidate-forms";
import { startAtsFixture, type AtsFixture } from "./ats-fixture/server";

/**
 * Phase 2 browser-executor proof against an isolated JavaScript ATS fixture.
 *
 * These tests never touch an employer, the live database or an external AI
 * provider. The executor is the production Playwright module; only the
 * destination is a loopback fixture.
 */

process.env.OUTBOUND_ALLOW_PRIVATE = "true";
process.env.RECRUITMENT_CANDIDATE_FORMS = "true";
process.env.RECRUITMENT_BROWSER_FORMS = "true";

test.describe.configure({ mode: "serial", timeout: 90_000 });

let fixture: AtsFixture;

test.beforeAll(async () => {
  fixture = await startAtsFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

const profile: CandidateProfile = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+41 79 000 00 00",
  location: "Zürich, Switzerland",
  linkedin: null,
  website: null,
  workAuthorisation: "Swiss Permit B — authorised to work without sponsorship",
  summary: "Senior QA engineer specialising in Playwright and API test automation.",
  skills: ["Playwright", "TypeScript", "API testing"],
  languages: ["English (C1)"],
  experienceText: "Lead QA Engineer — Synthetic Payments\n2020 → 2024\nBuilt Playwright suites for payment APIs.",
  educationText: "BSc Computer Science — University of Example",
  sponsorshipAnswer: "No",
};

const documents: CandidateDocuments = {
  cv: {
    buffer: Buffer.from("%PDF-1.4 synthetic tailored CV for Senior QA Automation Engineer"),
    name: "ada-tailored-cv-qa-automation.pdf",
  },
  cover: {
    buffer: Buffer.from("%PDF-1.4 synthetic tailored cover letter for Northstar Synthetic AG"),
    name: "ada-tailored-cover-northstar.pdf",
  },
  coverText:
    "Dear Northstar hiring team, I am applying for the Senior QA Automation Engineer role with verified Playwright and API testing experience.",
};

async function runForm(input: {
  path?: string;
  profile?: CandidateProfile;
  documents?: CandidateDocuments;
}) {
  const { runBrowserCandidateForm } = await import("../lib/browser-form");
  return runBrowserCandidateForm({
    pageUrl: `${fixture.baseUrl}${input.path ?? "/ats"}`,
    jobTitle: "Senior QA Automation Engineer",
    company: "Northstar Synthetic AG",
    profile: input.profile ?? profile,
    documents: input.documents ?? documents,
  });
}

function posts(): string[] {
  return fixture.state.requests.filter((request) => request.startsWith("POST "));
}

function uniqueProfile(suffix: string, overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return { ...profile, email: `ada+${suffix}@example.com`, ...overrides };
}

test("hydrates the late dynamic form and completes conditional upload questions", async () => {
  const before = fixture.state.submissions.length;
  const run = await runForm({ profile: uniqueProfile("success") });

  expect(run.result.status).toBe("verified");
  expect(run.result.reference).toMatch(/^ATS-2026-\d{4}$/);
  expect(run.result.finalUrl).toContain("/ats/confirmation");
  expect(run.plan.fields.map((field) => field.name)).toEqual(
    expect.arrayContaining(["languages", "cover_letter", "resume", "cover_file"]),
  );

  expect(fixture.state.submissions).toHaveLength(before + 1);
  const submission = fixture.state.submissions[before];
  expect(submission.reference).toBe(run.result.reference);
  expect(submission.fields.full_name).toBe("Ada Lovelace");
  expect(submission.fields.email).toBe("ada+success@example.com");
  expect(submission.fields.country).toBe("Switzerland");
  expect(submission.fields.languages).toBe("English (C1)");
  expect(submission.fields.cover_letter).toContain("Dear Northstar hiring team");
  expect(submission.files.map((file) => file.field).sort()).toEqual(["cover_file", "resume"]);
  expect(submission.files.find((file) => file.field === "resume")?.filename).toBe(
    "ada-tailored-cv-qa-automation.pdf",
  );
  expect(submission.files.find((file) => file.field === "cover_file")?.filename).toBe(
    "ada-tailored-cover-northstar.pdf",
  );
  expect(submission.files.find((file) => file.field === "resume")?.firstBytes).toContain(
    "synthetic tailored CV",
  );
  expect(submission.files.find((file) => file.field === "cover_file")?.firstBytes).toContain(
    "synthetic tailored cover letter",
  );
  expect(posts().filter((request) => request === "POST /ats/apply")).toHaveLength(1);

  // The executor records what it filled and which files it attached.
  const questions = run.result.evidence.questions as Array<{ name: string; action: string }>;
  expect(questions.find((question) => question.name === "languages")?.action).toBe("answer");
  expect(questions.find((question) => question.name === "cover_letter")?.action).toBe("answer");
  // The optional, unverified referral question is left blank rather than invented.
  expect(questions.find((question) => question.name === "how_did_you_hear")?.action).toBe("blank");
  expect(run.result.evidence.files).toEqual([
    documents.cv?.name,
    documents.cover?.name,
  ]);
});

test("an unknown mandatory question stops before submission", async () => {
  const before = fixture.state.submissions.length;
  const beforePosts = posts().length;
  const run = await runForm({ path: "/ats?unknown=1", profile: uniqueProfile("unknown") });

  expect(run.result.status).toBe("blocked");
  expect(run.plan.detail).toMatch(/favourite testing framework/i);
  expect(run.result.evidence.sent).toBe(false);
  expect(fixture.state.submissions).toHaveLength(before);
  expect(posts()).toHaveLength(beforePosts);
});

test("client-side validation prevents the request and is surfaced", async () => {
  const before = posts().length;
  const run = await runForm({
    path: "/ats?invalid=1",
    profile: uniqueProfile("client-invalid", { phone: "079 000 00 00" }),
  });

  expect(run.result.status).toBe("failed");
  expect(run.result.detail).toMatch(/\+41/);
  expect(run.result.evidence.sent).toBe(null);
  expect(posts()).toHaveLength(before);
});

test("server-side validation errors are surfaced without a reference", async () => {
  const before = fixture.state.submissions.length;
  const run = await runForm({
    profile: uniqueProfile("reject", { email: "ada+reject@example.com" }),
  });

  expect(run.result.status).toBe("rejected");
  expect(run.result.httpStatus).toBe(422);
  expect(run.result.reference).toBeNull();
  expect(String(run.result.evidence.responseSnippet)).toMatch(/rejected this email address/i);
  expect(fixture.state.submissions).toHaveLength(before);
});

test("a security challenge stops the executor with human intervention", async () => {
  const before = fixture.state.submissions.length;
  const beforePosts = posts().length;
  const run = await runForm({ path: "/ats-challenge", profile: uniqueProfile("captcha") });

  expect(run.result.status).toBe("blocked");
  expect(run.result.detail).toMatch(/captcha/i);
  expect(run.result.evidence.externalRequirement).toBe("security_challenge");
  expect(fixture.state.submissions).toHaveLength(before);
  expect(posts()).toHaveLength(beforePosts);
});

test("an HTTP 200 without employer confirmation is never treated as submitted", async () => {
  const before = fixture.state.submissions.length;
  const run = await runForm({ path: "/ats?noconfirm=1", profile: uniqueProfile("no-confirmation") });

  expect(run.result.status).toBe("unverified");
  expect(run.result.httpStatus).toBe(200);
  expect(run.result.reference).toBeNull();
  expect(run.result.detail).toMatch(/no explicit confirmation|unverified/i);
  expect(run.result.evidence.sent).toBe(true);
  expect(fixture.state.submissions).toHaveLength(before);
});

test("a repeated submission reuses the existing reference and creates no duplicate", async () => {
  const repeated = uniqueProfile("duplicate");
  const first = await runForm({ profile: repeated });
  const second = await runForm({ profile: repeated });

  expect(first.result.status).toBe("verified");
  expect(second.result.status).toBe("verified");
  expect(second.result.reference).toBe(first.result.reference);
  expect(fixture.state.duplicateAttempts).toBe(1);
  expect(
    fixture.state.submissions.filter((submission) => submission.fields.email === repeated.email),
  ).toHaveLength(1);
});
