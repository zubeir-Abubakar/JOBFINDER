import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase4-outreach-"));
process.env.APP_SECRET_KEY = "phase4-outreach-test-secret";
process.env.FREELLMAPI_ENABLED = "false";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
process.env.GMAIL_ENABLED = "false";

const db = await import("../lib/db.ts");
const contacts = await import("../lib/outreach-contacts.ts");
const outreach = await import("../lib/outreach.ts");
const mime = await import("../lib/email-mime.ts");
const ats = await import("../lib/ats-capabilities.ts");
const migrations = await import("../lib/migrations.ts");

db.getDb();

let sequence = 0;
function seedJob(input: {
  company?: string;
  description?: string | null;
  employerUrl?: string | null;
} = {}): { jobId: string; applicationId: string; cvId: string; coverId: string } {
  sequence += 1;
  const id = `p4-job-${sequence}`;
  const applicationId = `p4-app-${sequence}`;
  const cvId = `p4-cv-${sequence}`;
  const coverId = `p4-cover-${sequence}`;
  const company = input.company ?? "Acme Robotics AG";
  const employerUrl = input.employerUrl ?? `https://acme.test/jobs/${id}`;
  const description = input.description ?? `Contact: Jane Doe, Talent Acquisition Partner, jane.doe@acme.test. ${company} builds test systems.`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, application_url, employer_url,
       description, discovered_at, status, match_score, analysis)
     VALUES (?, 'fixture', ?, 'Senior QA Automation Engineer', ?, 'Zurich', ?, ?, ?, ?, ?, 'shortlisted', 91, ?)`,
    [id, id, company, `https://jobs.example.test/${id}`, employerUrl, employerUrl,
      description, now, JSON.stringify({ matched: ["Playwright", "API testing", "release readiness"] })],
  );
  const cvContent = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${company} Senior QA Automation Engineer\nPlaywright API testing\n%%EOF\n`);
  const coverContent = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${company} Senior QA Automation Engineer\nDear hiring team,\n%%EOF\n`);
  writeFileSync(join(db.UPLOAD_DIR, `${cvId}.pdf`), cvContent);
  writeFileSync(join(db.UPLOAD_DIR, `${coverId}.pdf`), coverContent);
  db.run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
     VALUES (?, '1', 'tailored_cv', ?, ?, 'application/pdf', ?, ?, ?, 'v1', 'ready', 'passed', 94, ?, ?)`,
    [cvId, `CV ${company}`, `${cvId}.pdf`, `${cvId}.pdf`, cvContent.length, id, `${company} Senior QA Automation Engineer Playwright API testing`, now],
  );
  db.run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
     VALUES (?, '1', 'cover_letter', ?, ?, 'application/pdf', ?, ?, ?, 'v1', 'ready', 'passed', 92, ?, ?)`,
    [coverId, `Cover ${company}`, `${coverId}.pdf`, `${coverId}.pdf`, coverContent.length, id, `${company} Senior QA Automation Engineer Dear hiring team`, now],
  );
  db.run(
    `INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', ?, ?, ?, ?)`,
    [applicationId, id, cvId, coverId, now, now],
  );
  return { jobId: id, applicationId, cvId, coverId };
}

test("migration v5 adds the outreach ledger without disturbing existing tables", () => {
  assert.equal(migrations.migrationStatus(db.getDb()).version, 5);
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'outreach_%' ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, ["outreach_contacts", "outreach_drafts", "outreach_events"]);
  assert.ok(db.one("SELECT id FROM profiles WHERE id = 1"), "the base profile is preserved");
});

test("explicitly published recruiter details are discovered and ranked", async () => {
  const seeded = seedJob();
  const result = await contacts.discoverOutreachContacts(seeded.jobId);
  assert.equal(result.unavailable, false);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].name, "Jane Doe");
  assert.equal(result.contacts[0].title, "Talent Acquisition Partner");
  assert.equal(result.contacts[0].email, "jane.doe@acme.test");
  assert.equal(result.contacts[0].verificationStatus, "verified");
  assert.equal(result.contacts[0].sourceKind, "vacancy");
});

test("guessed, unrelated and nameless addresses are not accepted", async () => {
  const guessed = seedJob({
    company: "Beta Labs AG",
    description: "Contact Jane Doe, talent acquisition partner, jane.doe at beta.test. Do not guess the address.",
    employerUrl: "https://beta.test/jobs/1",
  });
  const result = await contacts.discoverOutreachContacts(guessed.jobId);
  assert.equal(result.unavailable, true);
  assert.equal(result.contacts.length, 0);
  assert.match(result.reason, /No explicitly published/i);

  const unrelated = seedJob({
    company: "Gamma AG",
    description: "Recruitment partner: Sam Lee, sam.lee@other-employer.test.",
    employerUrl: "https://gamma.test/jobs/1",
  });
  const unrelatedResult = await contacts.discoverOutreachContacts(unrelated.jobId);
  assert.equal(unrelatedResult.contacts.length, 0);

  const page = contacts.contactsFromPublicPage({
    html: '<a href="mailto:careers@gamma.test">Email us</a>',
    pageUrl: "https://gamma.test/about",
    employerHost: "gamma.test",
    company: "Gamma AG",
  });
  assert.deepEqual(page, []);
});

test("a public Person record with an employer-domain address is verified", () => {
  const found = contacts.contactsFromPublicPage({
    html: `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Person",
      name: "Sam Lee",
      jobTitle: "Talent Acquisition Specialist",
      email: "sam.lee@acme.test",
    })}</script>`,
    pageUrl: "https://acme.test/team",
    employerHost: "acme.test",
    company: "Acme Robotics AG",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Sam Lee");
  assert.equal(found[0].sourceKind, "public_page");
  assert.equal(found[0].confidence, 95);
});

test("a bounded public employer page is used only when the vacancy and mailbox have no contact", async () => {
  const seeded = seedJob({
    company: "Public Systems AG",
    employerUrl: "https://public.test/jobs/1",
    description: "Senior QA Automation Engineer. Apply through the employer site.",
  });
  let calls = 0;
  const fetchImpl: typeof fetch = async (url) => {
    const value = String(url);
    if (value === "https://public.test/about") {
      return new Response(`<script type="application/ld+json">${JSON.stringify({
        "@type": "Person",
        name: "Sam Lee",
        jobTitle: "Talent Acquisition Specialist",
        email: "sam.lee@public.test",
      })}</script>`, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  };
  const result = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    fetchImpl,
    draftGateway: async (input) => {
      calls += 1;
      assert.equal(input.to, "sam.lee@public.test");
      return { draftId: "gmail-public-draft", messageId: null, threadId: null, rfcMessageId: null };
    },
  });
  assert.equal(result.status, "draft_created", result.detail);
  assert.equal(calls, 1);
});

test("MIME contains exactly the two validated PDF attachments", () => {
  const built = mime.buildOutreachMime({
    from: "owner@example.test",
    to: "jane.doe@acme.test",
    subject: "Senior QA Automation Engineer — application",
    text: "Hello",
    attachments: [
      { filename: "cv.pdf", mime: "application/pdf", content: Buffer.from("%PDF-1.4 cv") },
      { filename: "cover.pdf", mime: "application/pdf", content: Buffer.from("%PDF-1.4 cover") },
    ],
  });
  const decoded = mime.decodeMime(built.raw);
  assert.match(decoded, /filename="cv\.pdf"/);
  assert.match(decoded, /filename="cover\.pdf"/);
  assert.equal((decoded.match(/Content-Disposition: attachment/g) ?? []).length, 2);
  assert.match(built.rfcMessageId, /^<atw-outreach-/);
});

test("draft creation is idempotent, attaches the exact vacancy documents and never sends", async () => {
  const seeded = seedJob();
  let calls = 0;
  const gateway: import("../lib/outreach.ts").OutreachDraftGateway = async (input) => {
    calls += 1;
    assert.equal(input.to, "jane.doe@acme.test");
    assert.equal(input.attachments.length, 2);
    assert.match(input.attachments[0].content.toString("latin1"), /^%PDF/);
    assert.match(input.attachments[1].content.toString("latin1"), /^%PDF/);
    assert.equal(input.attachments[0].filename, `${seeded.cvId}.pdf`);
    assert.equal(input.attachments[1].filename, `${seeded.coverId}.pdf`);
    return { draftId: "gmail-draft-1", messageId: "gmail-message-1", threadId: "gmail-thread-1", rfcMessageId: "<rfc-1@acme.test>" };
  };
  const first = await outreach.prepareOutreachForApplication({ applicationId: seeded.applicationId, draftGateway: gateway });
  assert.equal(first.status, "draft_created");
  assert.equal(calls, 1);
  const second = await outreach.prepareOutreachForApplication({ applicationId: seeded.applicationId, draftGateway: gateway });
  assert.equal(second.status, "already_exists");
  assert.equal(calls, 1);

  const rows = outreach.outreachForApplication(seeded.applicationId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "draft_created");
  assert.equal(rows[0].gmailDraftId, "gmail-draft-1");
  assert.equal(rows[0].contactName, "Jane Doe");
  assert.notEqual(rows[0].cvSha256, rows[0].coverSha256);
  const app = db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [seeded.applicationId]);
  assert.equal(app?.status, "ready_to_submit");
});

test("sent reconciliation requires observed send evidence and preserves draft state", async () => {
  const seeded = seedJob({ description: "Contact: Olga Berg, Hiring Manager, olga.berg@acme.test." });
  const created = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => ({ draftId: "gmail-draft-sent", messageId: "msg-1", threadId: "thread-1", rfcMessageId: "<rfc-sent@acme.test>" }),
  });
  assert.equal(created.status, "draft_created");
  assert.equal(await outreach.reconcileOutreachFromGmail(created.draftId!), "draft_created", "no Sent copy means no sent state");
  assert.equal(outreach.reconcileOutreachDraft(created.draftId!, {
    state: "draft",
    messageId: "msg-1",
    threadId: "thread-1",
    detail: "Draft still present in Gmail.",
  }), "draft_created");
  assert.equal(outreach.outreachForApplication(seeded.applicationId)[0].sentAt, null);
  assert.equal(outreach.reconcileOutreachDraft(created.draftId!, {
    state: "sent",
    messageId: "msg-1",
    threadId: "thread-1",
    sentAt: "2026-11-27T12:00:00.000Z",
    detail: "Owner-sent message observed in Gmail Sent.",
  }), "sent");
  assert.equal(outreach.outreachForApplication(seeded.applicationId)[0].sentAt, "2026-11-27T12:00:00.000Z");
  assert.ok(outreach.outreachSummary().emailsSent >= 1);
});

test("cross-vacancy documents block outreach without affecting the application", async () => {
  const first = seedJob();
  const second = seedJob({ company: "Delta Systems AG", employerUrl: "https://delta.test/jobs/2", description: "Contact: Max Muster, Recruiter, max.muster@delta.test." });
  db.run("UPDATE applications SET cv_document_id = ? WHERE id = ?", [first.cvId, second.applicationId]);
  const before = db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [second.applicationId]);
  let calls = 0;
  const result = await outreach.prepareOutreachForApplication({
    applicationId: second.applicationId,
    draftGateway: async () => {
      calls += 1;
      return { draftId: "should-not-exist", messageId: null, threadId: null, rfcMessageId: null };
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /another vacancy/i);
  assert.equal(calls, 0);
  assert.equal(db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [second.applicationId])?.status, before?.status);
});

test("the same recipient is not drafted twice across vacancies", async () => {
  const description = "Contact: Nina Novak, Talent Acquisition Partner, nina.novak@acme.test.";
  const first = seedJob({ description });
  const second = seedJob({ description });
  let calls = 0;
  const gateway: import("../lib/outreach.ts").OutreachDraftGateway = async () => {
    calls += 1;
    return { draftId: `gmail-draft-cross-${calls}`, messageId: null, threadId: null, rfcMessageId: null };
  };
  assert.equal((await outreach.prepareOutreachForApplication({ applicationId: first.applicationId, draftGateway: gateway })).status, "draft_created");
  const duplicate = await outreach.prepareOutreachForApplication({ applicationId: second.applicationId, draftGateway: gateway });
  assert.equal(duplicate.status, "already_exists");
  assert.match(duplicate.detail, /another vacancy/i);
  assert.equal(calls, 1);
});

test("explicit no-unsolicited instructions block outreach", async () => {
  const seeded = seedJob({
    description: "No unsolicited applications. Contact: Jane Doe, Talent Acquisition Partner, jane.doe@acme.test.",
  });
  let calls = 0;
  const result = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => {
      calls += 1;
      return { draftId: "not-created", messageId: null, threadId: null, rfcMessageId: null };
    },
  });
  assert.equal(result.status, "blocked");
  assert.match(result.detail, /prohibit unsolicited contact/i);
  assert.equal(calls, 0);
});

test("ATS detection is host/source based and real platforms are not claimed as certified", () => {
  assert.equal(ats.detectAtsDestination({ url: "https://boards.greenhouse.io/acme/jobs/1" }).platform, "greenhouse");
  assert.equal(ats.detectAtsDestination({ url: "https://jobs.lever.co/acme/1" }).platform, "lever");
  assert.equal(ats.detectAtsDestination({ url: "https://acme.myworkdayjobs.com/en-US/job/1" }).platform, "workday");
  assert.equal(ats.detectAtsDestination({ url: "https://acme.test/careers/1" }).platform, "direct_employer");
  assert.equal(ats.detectAtsDestination({ source: "ashby" }).platform, "ashby");
  assert.equal(ats.detectAtsDestination({ url: "not-a-url" }).platform, "unknown");
  const matrix = ats.capabilityMatrix();
  for (const platform of ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "umantis"] as const) {
    const capability = matrix.find((item) => item.platform === platform);
    assert.ok(capability);
    assert.notEqual(capability.certification as string, "certified");
  }
  assert.equal(ats.capabilityFor("direct_employer")?.certification, "synthetic_fixture_only");
});

test("a failed Gmail operation records the failure but leaves the application intact", async () => {
  const seeded = seedJob({ company: "Epsilon AG", employerUrl: "https://epsilon.test/jobs/3", description: "Contact: Ada Meier, Hiring Manager, ada.meier@epsilon.test." });
  const result = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => {
      throw new Error("Fixture Gmail rejected the draft.");
    },
  });
  assert.equal(result.status, "failed");
  const draft = db.one<{ status: string; error: string | null }>("SELECT status, error FROM outreach_drafts WHERE application_id = ?", [seeded.applicationId]);
  assert.equal(draft?.status, "failed");
  assert.match(draft?.error ?? "", /Fixture Gmail rejected/);
  assert.equal(db.one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [seeded.applicationId])?.status, "ready_to_submit");
});
