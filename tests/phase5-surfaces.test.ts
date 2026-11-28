import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase5-surfaces-"));
process.env.APP_SECRET_KEY = "phase5-surfaces-test-secret";
process.env.GMAIL_ENABLED = "false";

const db = await import("../lib/db.ts");
const contacts = await import("../lib/outreach-contacts.ts");
const outreach = await import("../lib/outreach.ts");
const sessions = await import("../lib/agent-sessions.ts");
const capabilities = await import("../lib/capabilities.ts");
const identity = await import("../lib/agent-identity.ts");

db.getDb();

let sequence = 0;

function seedVacancy(input: {
  company?: string;
  description?: string | null;
  applicationEmail?: string | null;
  verifiedAt?: string | null;
} = {}) {
  sequence += 1;
  const jobId = `p5-job-${sequence}`;
  const applicationId = `p5-app-${sequence}`;
  const cvId = `p5-cv-${sequence}`;
  const coverId = `p5-cover-${sequence}`;
  const company = input.company ?? "Acme Robotics AG";
  const employerUrl = `https://acme.test/jobs/${jobId}`;
  const now = new Date().toISOString();
  const description = input.description ?? `${company} builds test systems.`;
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, application_url, employer_url,
       description, discovered_at, status, match_score, analysis, application_email, application_email_source, application_email_verified_at)
     VALUES (?, 'fixture', ?, 'Senior QA Automation Engineer', ?, 'Zurich', ?, ?, ?, ?, ?, 'shortlisted', 91, ?, ?, ?, ?)`,
    [jobId, jobId, company, `https://jobs.example.test/${jobId}`, employerUrl, employerUrl, description, now,
      JSON.stringify({ matched: ["GitHub", "Regression"] }),
      input.applicationEmail ?? null,
      input.applicationEmail ? "verified_employer_page" : null,
      input.verifiedAt ?? null],
  );
  const cvContent = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${company} Senior QA Automation Engineer\n%%EOF\n`);
  const coverContent = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${company} Senior QA Automation Engineer\n%%EOF\n`);
  writeFileSync(join(db.UPLOAD_DIR, `${cvId}.pdf`), cvContent);
  writeFileSync(join(db.UPLOAD_DIR, `${coverId}.pdf`), coverContent);
  db.run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
     VALUES (?, '1', 'tailored_cv', ?, ?, 'application/pdf', ?, ?, ?, 'v1', 'ready', 'passed', 94, ?, ?)`,
    [cvId, `CV ${company}`, `${cvId}.pdf`, `${cvId}.pdf`, cvContent.length, jobId, `${company} Senior QA Automation Engineer`, now],
  );
  db.run(
    `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
     VALUES (?, '1', 'cover_letter', ?, ?, 'application/pdf', ?, ?, ?, 'v1', 'ready', 'passed', 92, ?, ?)`,
    [coverId, `Cover ${company}`, `${coverId}.pdf`, `${coverId}.pdf`, coverContent.length, jobId, `${company} Senior QA Automation Engineer`, now],
  );
  db.run(
    `INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', ?, ?, ?, ?)`,
    [applicationId, jobId, cvId, coverId, now, now],
  );
  return { jobId, applicationId, cvId, coverId, company };
}

function storeContact(jobId: string, company: string, email: string) {
  const id = `p5-contact-${sequence}-${email}`;
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO outreach_contacts (id, job_id, name, title, company, email, email_domain, source_url, source_kind,
       discovery_method, evidence, confidence, priority, verification_status, created_at, updated_at)
     VALUES (?, ?, 'Recruitment team', 'Official recruitment contact', ?, ?, 'acme.test', 'https://acme.test/careers',
       'public_page', 'verified_application_inbox', ?, 85, 8, 'verified', ?, ?)`,
    [id, jobId, company, email, JSON.stringify({ field: "application_email", email }), now, now],
  );
  return id;
}

test("a verified employer application inbox becomes an official contact, never a named person", async () => {
  const seeded = seedVacancy({
    company: "Telecom Test AG",
    applicationEmail: "careers@acme.test",
    verifiedAt: "2026-11-27T19:07:22.197Z",
  });
  const result = await contacts.discoverOutreachContacts(seeded.jobId);
  assert.equal(result.unavailable, false);
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].email, "careers@acme.test");
  assert.equal(result.contacts[0].name, "Recruitment team");
  assert.equal(result.contacts[0].title, "Official recruitment contact");
  assert.equal(result.contacts[0].discoveryMethod, "verified_application_inbox");
  assert.match(String(result.contacts[0].evidence.note), /team inbox, not a named individual/);
});

test("an unverified or unrelated application address is not accepted as a contact", async () => {
  const unverified = seedVacancy({ company: "Unverified AG", applicationEmail: "careers@acme.test", verifiedAt: null });
  const unverifiedResult = await contacts.discoverOutreachContacts(unverified.jobId);
  assert.equal(unverifiedResult.contacts.length, 0);
  assert.equal(unverifiedResult.unavailable, true);

  const unrelated = seedVacancy({
    company: "Unrelated AG",
    applicationEmail: "jobs@somewhere-else.test",
    verifiedAt: "2026-11-27T19:07:22.197Z",
  });
  const unrelatedResult = await contacts.discoverOutreachContacts(unrelated.jobId);
  assert.equal(unrelatedResult.contacts.length, 0);
});

test("a team inbox is greeted as a team and only verified skills are quoted", () => {
  const seeded = seedVacancy({ company: "Acme Robotics AG" });
  const email = outreach.generateOutreachEmail({
    application: {
      id: seeded.applicationId,
      job_id: seeded.jobId,
      status: "ready_to_submit",
      cv_document_id: seeded.cvId,
      cover_letter_id: seeded.coverId,
      title: "Senior QA Automation Engineer",
      company: seeded.company,
      location: "Zurich",
      description: "Playwright and API testing",
      match_score: 91,
      analysis: JSON.stringify({ matched: ["GitHub", "Regression"] }),
      employer_url: null,
      application_url: null,
      application_email: null,
    },
    contact: {
      id: "c1",
      jobId: seeded.jobId,
      name: "Recruitment team",
      title: "Official recruitment contact",
      company: seeded.company,
      email: "careers@acme.test",
      emailDomain: "acme.test",
      sourceUrl: "https://acme.test/careers",
      sourceKind: "public_page",
      discoveryMethod: "verified_application_inbox",
      evidence: {},
      confidence: 85,
      priority: 8,
      verificationStatus: "verified",
    },
  });
  assert.match(email.body, /^Dear Hiring Team,/);
  assert.doesNotMatch(email.body, /Dear Recruitment,/);
  assert.doesNotMatch(email.body, /GitHub/);
});

test("the outreach dashboard reports real rows and separates draft from sent", async () => {
  const seeded = seedVacancy({ company: "Dashboard AG" });
  storeContact(seeded.jobId, seeded.company, `careers+dashboard-${sequence}@acme.test`);
  const before = outreach.outreachDashboard();
  const beforeCounts = before.counters;

  const created = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => ({ draftId: "gmail-draft-1", messageId: "m1", threadId: "t1", rfcMessageId: "<r@test>" }),
  });
  assert.equal(created.status, "draft_created");
  assert.equal(created.gmailDraftId, "gmail-draft-1");

  const view = outreach.outreachDashboard();
  assert.equal(view.counters.draftsPrepared, beforeCounts.draftsPrepared + 1);
  assert.ok(view.counters.verifiedContacts >= 1);
  assert.equal(view.counters.awaitingReview, beforeCounts.awaitingReview + 1);
  assert.equal(view.counters.emailsSent, beforeCounts.emailsSent);
  assert.equal(view.counters.needsIntervention, beforeCounts.needsIntervention);
  const row = view.drafts.find((draft) => draft.id === created.draftId);
  assert.ok(row);
  assert.equal(row!.status, "draft_created");
  assert.equal(row!.cv.state, "attached");
  assert.equal(row!.cover.state, "attached");
  assert.equal(row!.applicationStatus, "ready_to_submit");

  const detail = outreach.outreachDraftDetail(created.draftId!);
  assert.ok(detail);
  assert.match(detail!.body, /Senior QA Automation Engineer/);
  assert.equal(detail!.events.length, 1);
});

test("deleting or downgrading a document changes the attachment status instead of pretending", async () => {
  const seeded = seedVacancy({ company: "Attachment AG" });
  storeContact(seeded.jobId, seeded.company, `careers+attachment-${sequence}@acme.test`);
  const created = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => ({ draftId: "gmail-draft-2", messageId: "m2", threadId: "t2", rfcMessageId: "<r2@test>" }),
  });
  db.run("UPDATE documents SET quality_status = 'failed' WHERE id = ?", [seeded.cvId]);
  const view = outreach.outreachDashboard();
  const row = view.drafts.find((draft) => draft.id === created.draftId);
  assert.ok(row);
  assert.equal(row!.cv.state, "quality_failed");
  assert.equal(row!.cover.state, "attached");

  db.run("UPDATE documents SET deleted_at = ? WHERE id = ?", [new Date().toISOString(), seeded.coverId]);
  const after = outreach.outreachDashboard().drafts.find((draft) => draft.id === created.draftId);
  assert.equal(after!.cover.state, "missing");
});

test("a failed draft is counted as needing intervention, never as sent", async () => {
  const seeded = seedVacancy({ company: "Failure AG" });
  storeContact(seeded.jobId, seeded.company, `careers+failure-${sequence}@acme.test`);
  const before = outreach.outreachDashboard().counters;
  const created = await outreach.prepareOutreachForApplication({
    applicationId: seeded.applicationId,
    draftGateway: async () => {
      throw new Error("Gmail rejected the draft");
    },
  });
  assert.equal(created.status, "failed");
  const view = outreach.outreachDashboard();
  assert.equal(view.counters.emailsSent, before.emailsSent);
  assert.equal(view.counters.needsIntervention, before.needsIntervention + 1);
  const row = view.drafts.find((draft) => draft.id === created.draftId);
  assert.match(row?.error ?? "", /Gmail rejected/);
});

test("every registered agent resolves to a usable conversation entry point", () => {
  const keys = identity.AGENT_IDENTITY_KEYS;
  assert.equal(keys.length, 8);
  for (const key of keys) {
    assert.equal(sessions.agentKeyForName(key), key);
    const activation = sessions.activateAgentSession("user_phase5", key);
    assert.equal(activation.ok, true, `${key} should activate`);
    assert.equal(sessions.activeAgentSession("user_phase5").agentKey, key);
  }
  assert.equal(sessions.agentKeyForName("not-an-agent"), null);
});

test("the capability registry is evidence-based and covers every required category", () => {
  const required = [
    "Recruitment discovery",
    "Job qualification and matching",
    "Candidate profile and eligibility",
    "ATS detection and destination verification",
    "Application document generation",
    "CV and cover-letter quality validation",
    "Autonomous application submission",
    "Employer confirmation and reconciliation",
    "Hiring-manager discovery",
    "Email drafting and Gmail integration",
    "Employer reply synchronisation",
    "Agent conversations",
    "Noor orchestration and reporting",
    "Scheduler and background workers",
    "Notifications",
    "Audit logs and submission history",
    "AI provider and spending controls",
    "Database, migrations and backups",
    "Security and access controls",
    "System health and diagnostics",
  ];
  const { capabilities: registry, summary } = capabilities.capabilityRegistry();
  for (const category of required) {
    assert.ok(registry.some((item) => item.category === category), `missing category: ${category}`);
  }
  assert.ok(summary.total >= 20);
  assert.equal(summary.total, registry.length);
  for (const item of registry) {
    assert.ok(item.description.length > 40, `${item.id} needs a real description`);
    assert.ok(["Implemented", "Partially implemented"].includes(item.implementation));
    assert.ok(["Configured", "Not configured", "Not required"].includes(item.dependency));
    assert.ok(["Live-verified", "Awaiting live verification", "Blocked", "Failed"].includes(item.live));
    assert.ok(item.limitations.length > 10, `${item.id} needs an honest limitation`);
    assert.ok(item.liveDetail.length > 10, `${item.id} needs live evidence text`);
    assert.ok(item.tests.every((name) => !/^tests\//.test(name)), "test names are file names");
    assert.doesNotMatch(
      `${item.dependencyDetail} ${item.liveDetail}`,
      /(sk-[a-z0-9]{10,}|ghp_[a-z0-9]{10,}|AIza[a-z0-9_-]{10,}|client_secret\s*=|password\s*=|bearer\s+[a-z0-9])/i,
      `${item.id} must not expose a credential`,
    );
  }
  const gmail = registry.find((item) => item.id === "gmail-drafts");
  assert.ok(gmail);
  assert.equal(gmail!.enabled, false, "Gmail is disabled in this isolated test environment");
  assert.equal(gmail!.dependency, "Not configured");
  assert.notEqual(gmail!.live, "Failed");
});
