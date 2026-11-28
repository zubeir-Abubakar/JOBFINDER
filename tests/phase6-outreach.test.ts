import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase6-outreach-"));
process.env.APP_SECRET_KEY = "phase6-outreach-test-secret";
process.env.GMAIL_ENABLED = "false";

const db = await import("../lib/db.ts");
const outreach = await import("../lib/outreach.ts");
const capabilities = await import("../lib/capabilities.ts");
const submission = await import("../lib/submission.ts");

db.getDb();

const DESCRIPTION = `Telecom26 delivers mobile services built for a borderless world. We have an immediate need for a Test Engineer to join our team.
Test Engineer, 100% in Zug
Key responsibilities:
We are looking for a Test Engineer to help our engineering team deliver reliable mobile telecom provisioning, data-processing and analytic services. You will design, automate and run tests across our platform, from backend services and APIs to the SIM Portal web application. The role covers end-to-end testing of mobile network functionality and our BSS (provisioning, rating, charging and billing) systems.
Technical Skills:
• Designing test strategies, test plans and test cases for complex, distributed systems
• Building and maintaining automated test suites (functional, integration, regression and end-to-end)
• Testing APIs and backend services, including validating data flows end to end
• Test automation in Python (e.g. pytest)
• Testing RESTful APIs and gRPC services
• SQL and relational databases (PostgreSQL) for test data setup and result validation
• UI test automation for web applications (e.g. Playwright, Cypress or Selenium)
• Integrating automated tests into CI/CD pipelines
• Docker and containerized test environments`;

const PROFILE = {
  name: "ABUBAKAR TOWFIQ",
  headline: "Senior QA Engineer | Mobile (iOS/Android) | Test Automation | API & Payment Systems",
  email: "zubeir.abubakar525@gmail.com",
  phone: "+4179 368 05 70",
  location: "Switzerland",
  summary:
    "Senior QA Engineer (SDET) with 6+ years of experience delivering quality across SaaS and fintech platforms. Skilled in Playwright, Cypress, Selenium, TypeScript, API testing and CI/CD. Reduced regression time by 40%.",
  workAuthorisation: "Swiss Permit B — authorised to work in Switzerland without employer sponsorship",
};

const SKILLS = [
  "Playwright",
  "Cypress",
  "Selenium",
  "Selenium WebDriver",
  "Python",
  "SQL",
  "CI/CD",
  "REST APIs",
  "Docker",
  "JMeter",
];

const APPLICATION = {
  id: "p6-app",
  job_id: "p6-job",
  status: "ready_to_submit",
  cv_document_id: "p6-cv",
  cover_letter_id: "p6-cover",
  title: "Test Engineer",
  company: "Telecom26 AG",
  location: "Zug",
  description: DESCRIPTION,
  match_score: 91,
  analysis: null,
  employer_url: "https://telecom26.test",
  application_url: "https://telecom26.test/jobs/test-engineer",
  application_email: "careers@telecom26.test",
};

const CONTACT = {
  id: "p6-contact",
  jobId: "p6-job",
  name: "Recruitment team",
  title: "Official recruitment contact",
  company: "Telecom26 AG",
  email: "careers@telecom26.test",
  emailDomain: "telecom26.test",
  sourceUrl: "https://telecom26.test/about/careers",
  sourceKind: "public_page" as const,
  discoveryMethod: "verified_application_inbox" as const,
  evidence: { note: "Official recruitment team inbox, not a named individual." },
  confidence: 85,
  priority: 8,
  verificationStatus: "verified" as const,
};

function seedProfile(): void {
  db.run("DELETE FROM skills");
  db.run("DELETE FROM experiences");
  db.run(
    `UPDATE profiles SET full_name = ?, headline = ?, email = ?, phone = ?, location = ?, work_authorisation = ?, summary = ?
     WHERE id = 1`,
    [PROFILE.name, PROFILE.headline, PROFILE.email, PROFILE.phone, PROFILE.location, PROFILE.workAuthorisation, PROFILE.summary],
  );
  for (const [index, name] of SKILLS.entries()) {
    db.run("INSERT INTO skills (name, category, verified, sort) VALUES (?, 'Engineering', 1, ?)", [name, index]);
  }
  db.run(
    `INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, sort)
     VALUES ('Cashia', 'Lead QA Engineer', 'Kenya', 'Oct 2023', 'April 2026', 0, ?, 0)`,
    [
      [
        "- Owned end-to-end software quality across web applications serving multiple international markets.",
        "- Built and maintained scalable Playwright, Cypress and Selenium automation frameworks.",
        "- Designed comprehensive regression suites covering critical customer workflows.",
        "- Integrated automated tests into CI/CD pipelines enabling continuous quality validation.",
        "- Built automated API validation for distributed microservices.",
        "- Improved regression execution time by approximately 40%.",
        "- Achieved zero critical production escapes across major releases.",
      ].join("\n"),
    ],
  );
  db.run(
    `INSERT INTO experiences (company, title, location, start_date, end_date, is_current, summary, sort)
     VALUES ('Nobilis', 'QA Engineer / V&V Test Lead', 'Kenya', 'Feb 2024', 'May 2024', 0, ?, 1)`,
    [
      [
        "• Performed testing activities for ERP and financial systems within a regulated Swiss enterprise environment.",
        "• Automated regression scenarios using Selenium and Python to improve testing efficiency and coverage.",
        "• Conducted SQL database validation and backend data verification for reporting accuracy.",
      ].join("\n"),
    ],
  );
}

seedProfile();

test("the generated email is complete, vacancy-specific and passes every quality check", () => {
  const email = outreach.generateOutreachEmail({
    application: APPLICATION,
    contact: CONTACT,
    profile: PROFILE,
    skills: SKILLS,
  });
  const assessment = outreach.assessOutreachEmail({
    subject: email.subject,
    body: email.body,
    application: APPLICATION,
    profile: PROFILE,
    skills: SKILLS,
  });

  assert.equal(assessment.ok, true, assessment.summary);
  assert.equal(assessment.checks.filter((check) => !check.ok).length, 0);
  assert.ok(assessment.wordCount >= 180 && assessment.wordCount <= 280, `word count ${assessment.wordCount}`);
  assert.match(email.body, /^Dear Hiring Team,/);
  assert.match(email.body, /Test Engineer/);
  assert.match(email.body, /Telecom26 AG/);
  assert.match(email.body, /Cashia/);
  assert.match(email.body, /40%/);
  assert.match(email.body, /24 hours down to 12/);
  assert.match(email.body, /tailored CV and cover letter/);
  assert.match(email.body, /Swiss Permit B/);
  assert.match(email.body, /without employer sponsorship/);
  assert.match(email.body, /zubeir\.abubakar525@gmail\.com/);
  // The old generic wording must not reappear.
  assert.doesNotMatch(email.body, /I am writing to express my interest/i);
  assert.doesNotMatch(email.body, /I was particularly drawn/i);
  // A tool that is not verified never appears.
  assert.doesNotMatch(email.body, /Kubernetes/);
});

test("a short generic message fails the deterministic quality gate", () => {
  const body = [
    "Dear Hiring Team,",
    "I am writing to express my interest in the Test Engineer role. I am a passionate quality professional with a proven track record.",
    "I would welcome the opportunity to discuss this role.",
    "Kind regards,",
    PROFILE.name,
  ].join("\n");
  const assessment = outreach.assessOutreachEmail({
    subject: "Application",
    body,
    application: APPLICATION,
    profile: PROFILE,
    skills: SKILLS,
  });
  assert.equal(assessment.ok, false);
  const failed = assessment.checks.filter((check) => !check.ok).map((check) => check.id);
  assert.ok(failed.includes("word_count"), failed.join(","));
  assert.ok(failed.includes("vacancy_reference"), failed.join(","));
  assert.ok(failed.includes("attachments"), failed.join(","));
  assert.ok(failed.includes("work_authorisation"), failed.join(","));
  assert.ok(failed.includes("generic_language"), failed.join(","));
});

test("repeated skill lists, repeated sentences and unsupported tools are detected", () => {
  const repeated = [
    "Dear Hiring Team,",
    "I am applying for the Test Engineer role at Telecom26 AG.",
    "My toolkit is Playwright, Cypress, Selenium and SQL. I use Playwright, Cypress, Selenium and SQL every day at Cashia.",
    "I have attached my tailored CV and cover letter for this position.",
    "I hold a Swiss Permit B and am authorised to work in Switzerland without employer sponsorship.",
    "The same sentence is repeated here. The same sentence is repeated here.",
    "I also work with Kubernetes clusters every week.",
    "Kind regards,",
    PROFILE.name,
    PROFILE.email,
  ].join("\n");
  const assessment = outreach.assessOutreachEmail({
    subject: "Test Engineer — application",
    body: repeated,
    application: APPLICATION,
    profile: PROFILE,
    skills: SKILLS,
  });
  assert.equal(assessment.ok, false);
  const failed = assessment.checks.filter((check) => !check.ok).map((check) => check.id);
  assert.ok(failed.includes("repeated_skill_lists"), failed.join(","));
  assert.ok(failed.includes("repeated_phrasing"), failed.join(","));
  assert.ok(failed.includes("unsupported_claims"), failed.join(","));
  const unsupported = assessment.checks.find((check) => check.id === "unsupported_claims");
  assert.match(unsupported?.detail ?? "", /Kubernetes/);
});

test("a stored draft exposes quality, and drafted is never counted as sent", async () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO jobs (id, source, external_id, title, company, location, url, application_url, employer_url, description,
       discovered_at, status, match_score, application_email, application_email_source, application_email_verified_at)
     VALUES (?, 'fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shortlisted', 91, ?, 'verified_employer_page', ?)`,
    [
      APPLICATION.job_id,
      APPLICATION.job_id,
      APPLICATION.title,
      APPLICATION.company,
      APPLICATION.location,
      APPLICATION.application_url,
      APPLICATION.application_url,
      APPLICATION.employer_url,
      DESCRIPTION,
      now,
      APPLICATION.application_email,
      now,
    ],
  );
  const cvContent = Buffer.from(`%PDF-1.4\n% Telecom26 AG Test Engineer\n%%EOF\n`);
  const coverContent = Buffer.from(`%PDF-1.4\n% Telecom26 AG Test Engineer cover letter\n%%EOF\n`);
  for (const [id, kind] of [
    [APPLICATION.cv_document_id, "tailored_cv"],
    [APPLICATION.cover_letter_id, "cover_letter"],
  ] as const) {
    const content = kind === "tailored_cv" ? cvContent : coverContent;
    writeFileSync(join(db.UPLOAD_DIR, `${id}.pdf`), content);
    db.run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, quality_status, quality_score, text_content, created_at)
       VALUES (?, '1', ?, ?, ?, 'application/pdf', ?, ?, ?, 'v1', 'ready', 'passed', 95, ?, ?)`,
      [id, kind, id, `${id}.pdf`, `${id}.pdf`, content.length, APPLICATION.job_id, `${APPLICATION.company} ${APPLICATION.title}`, now],
    );
  }
  db.run(
    `INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, last_update, created_at)
     VALUES (?, ?, 'ready_to_submit', ?, ?, ?, ?)`,
    [APPLICATION.id, APPLICATION.job_id, APPLICATION.cv_document_id, APPLICATION.cover_letter_id, now, now],
  );
  db.run(
    `INSERT INTO outreach_contacts (id, job_id, name, title, company, email, email_domain, source_url, source_kind,
       discovery_method, evidence, confidence, priority, verification_status, created_at, updated_at)
     VALUES (?, ?, 'Recruitment team', 'Official recruitment contact', ?, ?, 'telecom26.test', 'https://telecom26.test/careers',
       'public_page', 'verified_application_inbox', '{}', 85, 8, 'verified', ?, ?)`,
    [CONTACT.id, APPLICATION.job_id, APPLICATION.company, CONTACT.email, now, now],
  );

  const created = await outreach.prepareOutreachForApplication({
    applicationId: APPLICATION.id,
    contactId: CONTACT.id,
    draftGateway: async () => ({ draftId: "gmail-draft-phase6", messageId: "m6", threadId: "t6", rfcMessageId: "<p6@test>" }),
  });
  assert.equal(created.status, "draft_created", created.detail);

  const view = outreach.outreachDashboard();
  const row = view.drafts.find((draft) => draft.id === created.draftId);
  assert.ok(row);
  assert.equal(row!.status, "draft_created");
  assert.equal(row!.sentAt, null);
  assert.equal(row!.replies, 0);
  assert.equal(view.counters.emailsSent, 0);

  const detail = outreach.outreachDraftDetail(created.draftId!);
  assert.ok(detail);
  assert.ok(detail!.quality);
  assert.equal(detail!.quality!.ok, true, detail!.quality!.summary);
  assert.match(detail!.body, /Telecom26 AG/);

  // Updating the same row must not create a second draft record.
  const before = db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outreach_drafts")?.n;
  const again = await outreach.prepareOutreachForApplication({
    applicationId: APPLICATION.id,
    contactId: CONTACT.id,
    draftGateway: async () => ({ draftId: "gmail-draft-second", messageId: "m7", threadId: "t7", rfcMessageId: "<p7@test>" }),
  });
  assert.equal(again.status, "already_exists");
  assert.equal(db.one<{ n: number }>("SELECT COUNT(*) AS n FROM outreach_drafts")?.n, before);
});

test("failure notifications distinguish all five submission outcome states", () => {
  const base = { channel: "candidate_form" as const, endpoint: null, reference: null };
  const before = submission.notificationOutcome({
    ...base,
    status: "failed",
    httpStatus: null,
    detail: "The uploaded document was cleared by the form. Nothing was sent.",
    evidence: { sent: false },
  });
  assert.equal(before.code, "failed_before_submission");
  assert.equal(before.beforeSubmit, true);

  const missing = submission.notificationOutcome({
    ...base,
    status: "blocked",
    httpStatus: null,
    detail: "1 essential question(s) cannot be answered.",
    evidence: { blockers: ["Department: This required question is not covered by verified profile data."] },
  });
  assert.equal(missing.code, "blocked_missing_information");

  const security = submission.notificationOutcome({
    ...base,
    status: "blocked",
    httpStatus: null,
    detail: "The form contains a CAPTCHA.",
    evidence: { externalRequirement: "security_challenge" },
  });
  assert.equal(security.code, "blocked_security");

  assert.equal(
    submission.notificationOutcome({ ...base, status: "unverified", httpStatus: 200, detail: "No reference.", evidence: null }).code,
    "submitted_unverified",
  );
  assert.equal(
    submission.notificationOutcome({ ...base, status: "verified", httpStatus: 200, detail: "Confirmed.", evidence: null, reference: "REF-1" }).code,
    "employer_confirmed",
  );
});

test("the capability registry records the outreach inbox, send state and blocked form adapter honestly", () => {
  db.run("UPDATE applications SET submission_status = 'blocked', status = 'human_intervention_required' WHERE id = ?", [
    APPLICATION.id,
  ]);
  const { capabilities: registry } = capabilities.capabilityRegistry();
  const inbox = registry.find((item) => item.id === "outreach-inbox");
  const send = registry.find((item) => item.id === "gmail-send");
  const adapter = registry.find((item) => item.id === "form-adapter-digital-forms");
  const gmail = registry.find((item) => item.id === "gmail-drafts");
  assert.ok(inbox && send && adapter && gmail);
  assert.match(inbox!.description, /View prepared emails/);
  assert.equal(inbox!.href, "/outreach");
  assert.equal(send!.live, "Awaiting live verification", "sending must not be claimed as verified");
  assert.match(send!.liveDetail, /has not been exercised/i);
  assert.equal(adapter!.live, "Blocked");
  assert.match(adapter!.limitations, /Digt/);
  assert.match(gmail!.limitations, /not sending/i);
});
