import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-arbeitnow-relevance-"));
process.env.APP_SECRET_KEY = "arbeitnow-relevance-test-secret";

const db = await import("../lib/db.ts");
const { researchJobs } = await import("../lib/jobs.ts");
db.getDb();

const now = Math.floor(Date.now() / 1000);
const qaDescription =
  "We are hiring a senior quality engineer with 5+ years of software testing experience. " +
  "You will own Playwright and API test automation, test planning, regression testing and release readiness. " +
  "English is required and the role is based in Zürich, Switzerland.";

const feed = {
  data: [
    {
      slug: "anybotics-hardware-test",
      company_name: "Anybotics",
      title: "Industrialization / Electronics Test Engineer",
      location: "Zurich",
      remote: false,
      url: "https://www.arbeitnow.ch/jobs/companies/anybotics/hardware-test",
      description:
        "Industrialise electronics test stations for PCB assembly. Design fixtures, validate hardware, " +
        "operate environmental chambers and support the production ramp in Zurich.",
      created_at: now,
      job_types: ["Full-time"],
    },
    {
      slug: "qa-automation-role",
      company_name: "Helvetia Test Labs",
      title: "Senior QA Automation Engineer",
      location: "Zürich, Switzerland",
      remote: false,
      url: "https://arbeitnow.test/jobs/qa-automation-role",
      description: qaDescription,
      created_at: now,
      job_types: ["Full-time"],
    },
  ],
};

test("Arbeitnow does not count a hardware-testing title as a relevant QA duplicate", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(feed), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    const result = await researchJobs(1, 10);
    assert.equal(result.fetched, 2);
    assert.equal(result.inserted, 1);
    assert.equal(result.duplicates, 0);
    assert.equal(result.filteredOut, 1);
    assert.ok(
      Object.keys(result.rejectionReasons).some((reason) => /Not a hands-on QA\/SDET role/.test(reason)),
      "the hardware role is filtered by the shared relevance classifier",
    );
    assert.equal(
      db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE title = 'Industrialization / Electronics Test Engineer'")?.c,
      0,
    );
    assert.equal(
      db.one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE title = 'Senior QA Automation Engineer'")?.c,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
