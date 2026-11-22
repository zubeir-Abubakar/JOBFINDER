import test from "node:test";
import assert from "node:assert/strict";

import {
  extractCoverLetterRequirements,
  letterBodyFromRenderedText,
  measureCoverLetterText,
  professionalCoverLetterRequirements,
} from "../lib/cover-letter-requirements.ts";

test("explicit recruiter word minimum and maximum are extracted with source evidence", () => {
  const description =
    "Senior QA Engineer at Example AG. Please include a cover letter of at least 160 words and no more than 220 words. " +
    "The role requires 5 years of test automation experience and English C1.";
  const requirements = extractCoverLetterRequirements(description, {
    sourceUrl: "https://example.test/jobs/qa",
    retrievedAt: "2026-11-22T09:00:00.000Z",
  });
  assert.equal(requirements.source, "recruiter");
  assert.equal(requirements.explicit, true);
  assert.equal(requirements.minWords, 160);
  assert.equal(requirements.maxWords, 220);
  assert.equal(requirements.minCharacters, null);
  assert.equal(requirements.maxCharacters, null);
  assert.equal(requirements.sourceUrl, "https://example.test/jobs/qa");
  assert.ok(requirements.evidence.length >= 1);
  assert.match(requirements.evidence.join(" "), /cover letter/i);
  assert.match(requirements.evidence.join(" "), /160|220/);
});

test("an explicit character limit does not invent a word limit", () => {
  const requirements = extractCoverLetterRequirements(
    "Applications need a motivation letter. The motivation letter must not exceed 1,800 characters.",
  );
  assert.equal(requirements.source, "recruiter");
  assert.equal(requirements.minWords, null);
  assert.equal(requirements.maxWords, null);
  assert.equal(requirements.maxCharacters, 1_800);
});

test("without a recruiter instruction the 180–320 target is labelled as an internal default", () => {
  const requirements = extractCoverLetterRequirements(
    "We are hiring a QA engineer with five years of experience. Work authorisation is required.",
  );
  assert.deepEqual(requirements, professionalCoverLetterRequirements());
  assert.equal(requirements.source, "professional_default");
  assert.equal(requirements.explicit, false);
  assert.equal(requirements.minWords, 180);
  assert.equal(requirements.maxWords, 320);
  assert.deepEqual(requirements.evidence, []);
});

test("conflicting recruiter limits are preserved rather than silently choosing one", () => {
  const requirements = extractCoverLetterRequirements(
    "Your cover letter must be at least 300 words. The cover letter must not exceed 200 words.",
  );
  assert.equal(requirements.source, "recruiter");
  assert.equal(requirements.minWords, 300);
  assert.equal(requirements.maxWords, 200);
  assert.ok(requirements.conflicts.some((conflict) => /minimum.*300.*maximum.*200/i.test(conflict)));
});

test("page limits, file formats and mandatory supporting documents are extracted with evidence", () => {
  const requirements = extractCoverLetterRequirements(
    "Please submit a cover letter of no more than one page in PDF format. Two references are required.",
  );
  assert.equal(requirements.source, "recruiter");
  assert.equal(requirements.maxPages, 1);
  assert.deepEqual(requirements.formats, ["pdf"]);
  assert.ok(requirements.supportingDocuments.includes("references"), requirements.supportingDocuments.join(", "));
  assert.match(requirements.evidence.join(" "), /one page|PDF/i);
});

test("persisted recruiter page and supporting-document constraints survive reload", async () => {
  const { resolveCoverLetterRequirements } = await import("../lib/cover-letter-requirements.ts");
  const original = extractCoverLetterRequirements(
    "Your cover letter must be at most 2 pages and must be submitted in Word format. Portfolio required.",
  );
  const resolved = resolveCoverLetterRequirements({
    description: null,
    requirementsJson: JSON.stringify({ coverLetter: original }),
  });
  assert.equal(resolved.maxPages, 2);
  assert.deepEqual(resolved.formats, ["docx"]);
  assert.ok(resolved.supportingDocuments.includes("portfolio"));
});

test("rendered-body extraction and counting ignore the CV-style header but include greeting and closing", () => {
  const rendered = [
    "Ada Lovelace",
    "ada@example.com",
    "18 November 2026",
    "Swiss Payments AG",
    "Dear Hiring Team,",
    "The role calls for reliable release evidence.",
    "I built a verified Playwright suite covering 120 payment scenarios.",
    "Sincerely,",
    "Ada Lovelace",
  ].join("\n");
  const body = letterBodyFromRenderedText(rendered);
  assert.match(body, /^Dear Hiring Team,/);
  assert.match(body, /Sincerely,/);
  assert.doesNotMatch(body, /ada@example\.com/);
  const measurement = measureCoverLetterText(body);
  assert.equal(measurement.words, 23);
  assert.ok(measurement.characters > measurement.words);
});
