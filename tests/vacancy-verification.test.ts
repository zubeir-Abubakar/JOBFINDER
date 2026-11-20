import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-vacancy-"));
process.env.APP_SECRET_KEY = "vacancy-verification-test-secret";
process.env.RECRUITMENT_SCHEDULER = "false";

const db = await import("../lib/db.ts");
const vacancy = await import("../lib/vacancy-verification.ts");

db.getDb();

const title = "Senior Agile Test Engineer";
const company = "Akros Test AG";
const publishedAt = new Date().toISOString();

function page(input: { title?: string; company?: string; validThrough?: string; body?: string }): string {
  const structured = input.title
    ? `<script type="application/ld+json">${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "JobPosting",
        title: input.title,
        datePosted: publishedAt,
        hiringOrganization: { "@type": "Organization", name: input.company ?? company },
        ...(input.validThrough ? { validThrough: input.validThrough } : {}),
      })}</script>`
    : "";
  return `<html><head><title>${input.title ?? "Careers"}</title>${structured}</head><body>${input.body ?? `${input.title ?? ""} ${input.company ?? ""}`}</body></html>`;
}

let server: Server;
let base = "";

test.before(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/missing") {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<html><body>Not found</body></html>");
      return;
    }
    if (path === "/closed") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(page({ title, body: "Applications are closed for this position." }));
      return;
    }
    if (path === "/generic") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(page({ body: "Explore our careers and culture." }));
      return;
    }
    if (path === "/expiry") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(page({ title, validThrough: "2027-01-31T23:59:59Z" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(page({ title }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
});

test.after(() => {
  server.close();
  db.closeDb();
});

function insertFixture(path: string): string {
  const id = `job_vacancy_${path.replace(/\W/g, "")}`;
  db.run(
    `INSERT OR REPLACE INTO jobs (id, source, external_id, title, company, location, remote, url, application_url,
       description, published_at, discovered_at, dedupe_key)
     VALUES (?, 'vacancy-fixture', ?, ?, ?, 'Zürich, Switzerland', 0, ?, ?, ?, ?, ?, ?)`,
    [id, id, title, company, `${base}${path}`, `${base}${path}`, "A controlled fixture vacancy. No employer is contacted.", publishedAt, publishedAt, id],
  );
  return id;
}

test("an open listing with a structured expiry is verified and the expiry is persisted", async () => {
  const id = insertFixture("/expiry");
  const job = db.one<Record<string, string | null>>("SELECT * FROM jobs WHERE id = ?", [id]);
  assert.ok(job);
  const result = await vacancy.verifyAndPersistVacancy(
    {
      id,
      title,
      company,
      url: job.url,
      application_url: job.application_url,
      published_at: job.published_at,
    },
    { fetchImpl: fetch, now: new Date() },
  );
  assert.equal(result.status, "open");
  assert.equal(result.expiryStatus, "known");
  assert.equal(result.expiryAt, "2027-01-31T23:59:59Z");
  assert.equal(result.expirySource, "structured_data");

  const stored = db.one<{ vacancy_status: string; expiry_at: string; expiry_status: string; vacancy_verified_at: string }>(
    "SELECT vacancy_status, expiry_at, expiry_status, vacancy_verified_at FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(stored?.vacancy_status, "open");
  assert.equal(stored?.expiry_at, "2027-01-31T23:59:59Z");
  assert.equal(stored?.expiry_status, "known");
  assert.ok(stored?.vacancy_verified_at);
});

test("an open listing without a supplied expiry records unknown rather than inventing one", async () => {
  const id = insertFixture("/open");
  const job = db.one<Record<string, string | null>>("SELECT * FROM jobs WHERE id = ?", [id]);
  assert.ok(job);
  const result = await vacancy.verifyAndPersistVacancy(
    {
      id,
      title,
      company,
      url: job.url,
      application_url: job.application_url,
      published_at: job.published_at,
    },
    { fetchImpl: fetch, now: new Date() },
  );
  assert.equal(result.status, "open");
  assert.equal(result.expiryAt, null);
  assert.equal(result.expiryStatus, "unknown");
  assert.match(result.reason, /expiry is recorded as unknown/i);
  const stored = db.one<{ expiry_at: string | null; expiry_status: string }>(
    "SELECT expiry_at, expiry_status FROM jobs WHERE id = ?",
    [id],
  );
  assert.equal(stored?.expiry_at, null);
  assert.equal(stored?.expiry_status, "unknown");
});

test("a closed page or HTTP 404 blocks the vacancy", async () => {
  for (const path of ["/closed", "/missing"]) {
    const id = insertFixture(path);
    const job = db.one<Record<string, string | null>>("SELECT * FROM jobs WHERE id = ?", [id]);
    assert.ok(job);
    const result = await vacancy.verifyAndPersistVacancy(
      { id, title, company, url: job.url, application_url: job.application_url, published_at: job.published_at },
      { fetchImpl: fetch, now: new Date() },
    );
    assert.equal(result.status, "closed", `${path} is closed`);
    assert.ok(result.reason.length > 0);
  }
});

test("a generic careers page cannot verify the role and is blocked", async () => {
  const id = insertFixture("/generic");
  const job = db.one<Record<string, string | null>>("SELECT * FROM jobs WHERE id = ?", [id]);
  assert.ok(job);
  const result = await vacancy.verifyAndPersistVacancy(
    { id, title, company, url: job.url, application_url: job.application_url, published_at: job.published_at },
    { fetchImpl: fetch, now: new Date() },
  );
  assert.equal(result.status, "unverified");
  assert.equal(result.checks.every((check) => check.kind !== "application" || !check.identityMatched), true);
  assert.match(result.reason, /could be matched|did not return a page/i);
});

test("a missing publication date blocks an otherwise reachable listing", async () => {
  const id = insertFixture("/open");
  const job = db.one<Record<string, string | null>>("SELECT * FROM jobs WHERE id = ?", [id]);
  assert.ok(job);
  const result = await vacancy.verifyVacancy(
    { title, company, url: job.url, application_url: job.application_url, published_at: null },
    { fetchImpl: fetch, now: new Date() },
  );
  assert.equal(result.publicationStatus, "missing");
  assert.equal(result.status, "unverified");
  assert.match(result.reason, /publication date is missing/i);
});
