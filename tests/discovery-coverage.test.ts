import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-coverage-"));
process.env.APP_SECRET_KEY = "discovery-coverage-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";
process.env.JOBS_CH_QUERIES = "QA Engineer";
delete process.env.RECRUITMENT_DISCOVERY_EXPANSION;

const db = await import("../lib/db.ts");
const discovery = await import("../lib/recruitment-discovery.ts");

db.getDb();

test("all requested QA role families are recognised as QA titles", () => {
  const titles = [
    "Senior QA Engineer",
    "QA Automation Engineer",
    "Senior QA Automation Engineer",
    "SDET",
    "Senior Test Automation Engineer",
    "Mobile QA Engineer",
    "Software Test Engineer",
    "Test Lead",
    "QA Lead",
    "QA Engineer — Fintech",
    "API Test Engineer",
    "Automation Test Engineer",
    "Test Architect",
    "Quality Assurance Analyst",
  ];
  for (const title of titles) assert.equal(discovery.isQaTitle(title), true, title);
});

test("configured jobs.ch queries are expanded with the role-family set only when configured", () => {
  const queries = discovery.configuredJobsChQueries();
  assert.ok(queries.includes("QA Engineer"));
  for (const query of discovery.DEFAULT_JOBS_CH_QA_QUERIES) assert.ok(queries.includes(query), query);
  assert.equal(new Set(queries.map((query) => query.toLowerCase())).size, queries.length);
  assert.deepEqual(discovery.expandJobsChQueries([]), []);
});

test("the expansion can be explicitly disabled without dropping operator queries", () => {
  process.env.RECRUITMENT_DISCOVERY_EXPANSION = "false";
  try {
    assert.deepEqual(discovery.expandJobsChQueries(["QA Engineer"]), ["QA Engineer"]);
  } finally {
    delete process.env.RECRUITMENT_DISCOVERY_EXPANSION;
  }
});
