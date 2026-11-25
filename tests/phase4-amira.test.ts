import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Phase 4 Amira reliability matrix.
 *
 * All provider responses are mocked at the fetch boundary. No real FreeLLMAPI,
 * Cloudflare, Ollama or employer endpoint is contacted.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-phase4-amira-"));
process.env.APP_SECRET_KEY = "phase4-amira-test";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key-not-real";
process.env.FREELLMAPI_MODEL = "gpt-oss-20b";
process.env.FREELLMAPI_ALLOWED_MODELS = "gpt-oss-20b";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "0";
process.env.OLLAMA_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const db = await import("../lib/db.ts");
const ai = await import("../lib/document-ai.ts");
const quality = await import("../lib/document-quality.ts");
const docgen = await import("../lib/docgen.ts");
const providers = await import("../lib/providers.ts");
const health = await import("../lib/provider-health.ts");
const requirementsModule = await import("../lib/cover-letter-requirements.ts");
const agents = await import("../lib/agents.ts");
const workflowEvents = await import("../lib/events.ts");
const topology = await import("../lib/agent-topology.ts");
import type { MasterCv } from "../lib/master-cv.ts";
import type { JobAnalysis } from "../lib/scoring.ts";

db.getDb();

after(() => {
  db.closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

const JOB = {
  title: "Senior QA Automation Engineer",
  company: "Swiss Payments AG",
  location: "Zürich, Switzerland",
  description: [
    "We are hiring a Senior QA Automation Engineer for our fintech payments platform.",
    "You will own Playwright test automation, API testing, release readiness and TypeScript test code.",
    "You will work with engineering and product teams on regression testing and quality gates.",
    "Swiss work authorisation is required; sponsorship is not offered. English is required.",
  ].join(" "),
};

const ANALYSIS: JobAnalysis = {
  score: 95,
  flag: "strong",
  breakdown: { technical: 0.95, experience: 0.9, seniority: 0.95, language: 1, location: 1, salary: 0.7 },
  weights: { technical: 35, experience: 25, seniority: 15, language: 10, location: 10, salary: 5 },
  matched: ["Playwright", "API testing", "Release readiness", "TypeScript"],
  missing: [],
  preferred: [],
  evidence: { technical: "Playwright, API testing and TypeScript", experience: "Five years in QA", seniority: "Senior", language: "English C1", location: "Swiss Permit B", salary: "Not stated" },
  concerns: [],
  recommendation: "Strong match.",
  seniority: "senior",
  yearsRequired: 5,
  languages: ["English"],
  workPermitNote: "Swiss Permit B is recorded.",
  criteria: [],
  mandatoryBlockers: [],
  preferences: [],
  classification: { category: "test_automation", label: "Test automation", isQa: true, testingIntensity: 1, responsibilities: ["Own test automation and release quality"] },
  engine: "scoring-v1",
  generatedAt: new Date().toISOString(),
};

const MASTER: MasterCv = {
  sourceId: "doc_master_phase4",
  sourceName: "master-cv.pdf",
  sourceText: [
    "Ada Lovelace — Senior QA Automation Engineer",
    "Zürich | ada@example.com | +41 79 000 00 00",
    "Swiss Permit B — authorised to work without employer sponsorship",
    "Playwright, Cypress, Selenium, TypeScript, API testing, release readiness, regression testing, CI/CD, Jira.",
    "Senior QA Engineer, Swiss Payments AG, Jan 2020 – Present",
    "Built Playwright suites that covered 120 payment scenarios and reduced release defects by 30%.",
    "Led API regression testing across 4 releases and cut feedback time from 3 days to 1 day.",
    "Introduced release-readiness evidence that gave engineering and product teams a clear go/no-go decision.",
    "QA Engineer, Mobile Money Ltd, Mar 2017 – Dec 2019",
    "Automated 80 mobile regression cases with Cypress and reduced manual test time by 25%.",
    "Worked with engineering teams on defect triage and quality gates for 6 releases.",
    "QA Engineer, Cloud Retail AG, Jun 2014 – Feb 2017",
    "Built Selenium regression suites for 70 checkout flows and reduced escaped defects by 18%.",
    "Coordinated release testing across web and mobile teams for 8 releases.",
    "Documented risk-based test plans and kept evidence available for product sign-off.",
    "Certifications ISTQB Certified Tester",
    "Education BSc Computer Science — University of Example 2016",
    "Languages English (C1) | French (B2)",
  ].join("\n"),
  name: "Ada Lovelace",
  headline: "Senior QA Automation Engineer",
  contact: ["Zürich", "ada@example.com", "+41 79 000 00 00"],
  permit: "Swiss Permit B — authorised to work without employer sponsorship",
  summary: "Senior QA engineer with fintech payments, mobile and API test automation experience.",
  skillGroups: [
    { label: "Automation", values: ["Playwright", "Cypress", "Selenium"] },
    { label: "Testing", values: ["API testing", "Regression testing", "Release readiness"] },
    { label: "Technical", values: ["TypeScript", "CI/CD", "Jira"] },
  ],
  roles: [
    {
      key: "swiss-payments|senior-qa|2020",
      title: "Senior QA Engineer",
      company: "Swiss Payments AG",
      location: "Zürich",
      dates: "Jan 2020 – Present",
      bullets: [
        "Built Playwright suites that covered 120 payment scenarios and reduced release defects by 30%.",
        "Led API regression testing across 4 releases and cut feedback time from 3 days to 1 day.",
        "Introduced release-readiness evidence that gave engineering and product teams a clear go/no-go decision.",
      ],
      note: null,
    },
    {
      key: "mobile-money|qa|2017",
      title: "QA Engineer",
      company: "Mobile Money Ltd",
      location: "Zürich",
      dates: "Mar 2017 – Dec 2019",
      bullets: [
        "Automated 80 mobile regression cases with Cypress and reduced manual test time by 25%.",
        "Worked with engineering teams on defect triage and quality gates for 6 releases.",
        "Documented risk-based test plans and kept evidence available for product sign-off.",
      ],
      note: null,
    },
    {
      key: "cloud-retail|qa|2014",
      title: "QA Engineer",
      company: "Cloud Retail AG",
      location: "Zürich",
      dates: "Jun 2014 – Feb 2017",
      bullets: [
        "Built Selenium regression suites for 70 checkout flows and reduced escaped defects by 18%.",
        "Coordinated release testing across web and mobile teams for 8 releases.",
        "Documented risk-based test plans and kept evidence available for product sign-off.",
      ],
      note: null,
    },
  ],
  certifications: ["ISTQB Certified Tester"],
  education: [{ title: "BSc Computer Science", date: "2016", institution: "University of Example" }],
  languages: "English (C1) | French (B2)",
  wordCount: 280,
  parsedFrom: "original",
};

let respond: () => Response = () => json({ error: { message: "not configured" } }, 500);
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  return respond();
}) as typeof fetch;

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function providerSuccess(content: string): Response {
  return json({
    model: "gpt-oss-20b",
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  });
}

function validAiLetter(): string {
  const content = ai.deterministicCoverLetter(MASTER, JOB, ANALYSIS);
  return JSON.stringify({ salutation: content.salutation, paragraphs: content.paragraphs, closing: content.closing });
}

function rendered(content: ReturnType<typeof ai.deterministicCoverLetter>): string {
  return docgen.modelToText(docgen.buildCoverLetterModel({ master: MASTER, cover: content, job: JOB }));
}

function validate(content: ReturnType<typeof ai.deterministicCoverLetter>) {
  return quality.validateCoverQuality(MASTER, content, rendered(content), 1, { ...JOB, analysis: ANALYSIS });
}

beforeEach(() => {
  fetchCalls = 0;
  providers.clearGatewayCooldown();
  health.clearProviderCooldowns("freellmapi");
  health.recordProviderSuccess("freellmapi", "gpt-oss-20b");
});

async function cover(requirements = requirementsModule.professionalCoverLetterRequirements()) {
  return ai.generateCoverLetter(MASTER, {
    job: JOB,
    analysis: ANALYSIS,
    taskId: null,
    workflowId: null,
    coverLetterRequirements: requirements,
  });
}

function assertRecovered(
  content: Awaited<ReturnType<typeof cover>>,
  pattern: RegExp,
  label: string,
): void {
  assert.equal(content.tailoredWithAi, false, `${label}: deterministic fallback must be used`);
  assert.ok(content.diagnostics?.requestId.startsWith("ai_"), `${label}: correlation id is persisted`);
  assert.equal(content.diagnostics?.usableContent, false, `${label}: unusable provider content is recorded`);
  const result = validate(content);
  assert.equal(result.status, "passed", `${label}: ${result.issues.map((item) => item.message).join(" | ")}`);
  assert.ok((result.coverLetter?.actualWords ?? 0) >= 180, `${label}: validated fallback meets the floor`);
  assert.match(content.warnings.join(" "), pattern);
}

test("the deterministic fallback is evidence-expanded and passes the rendered quality gate", () => {
  const content = ai.deterministicCoverLetter(MASTER, JOB, ANALYSIS);
  assert.ok(requirementsModule.measureCoverLetter(content).words >= 180);
  const result = validate(content);
  assert.equal(result.status, "passed", result.issues.map((item) => item.message).join(" | "));
  assert.equal(result.coverLetter?.renderedBodyVerified, true);
  assert.ok(content.warnings.some((warning) => /deterministic fallback|Additional verified achievements/.test(warning)));
});

test("the professional default never overrides an explicit recruiter maximum", () => {
  const requirements = requirementsModule.extractCoverLetterRequirements(
    "Please submit a cover letter of no more than 120 words.",
  );
  const content = ai.deterministicCoverLetter(MASTER, JOB, ANALYSIS, requirements);
  const measured = requirementsModule.measureCoverLetter(content);
  assert.ok(measured.words <= 120, `${measured.words} words exceeds the explicit 120-word maximum`);
  const result = quality.validateCoverQuality(MASTER, content, rendered(content), 1, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: requirements,
  });
  assert.equal(result.status, "passed", result.issues.map((item) => item.message).join(" | "));
});

test("external cover-letter inference is blocked before transmission and the deterministic letter passes quality", async () => {
  respond = () => providerSuccess(validAiLetter());
  const content = await cover();
  assert.equal(content.tailoredWithAi, false);
  assert.equal(fetchCalls, 0, "no external inference request is transmitted");
  assert.match(content.warnings.join(" "), /AI tailoring was unavailable|blocked|zero-spend/i);
  assert.equal(validate(content).status, "passed");
});

test("repeated blocked attempts never become a successful external call", async () => {
  const results = await Promise.all([cover(), cover(), cover()]);
  for (const content of results) {
    assert.equal(content.tailoredWithAi, false);
    assert.equal(validate(content).status, "passed");
  }
  assert.equal(fetchCalls, 0);
});

test("a persisted task assignment and completion return the result to Chief", () => {
  const workflowId = "wf_phase4_delegation";
  const runId = "run_phase4_delegation";
  const at = new Date().toISOString();
  db.run(
    "INSERT INTO workflows (id, kind, label, status, started_by, created_at) VALUES (?, 'autonomous_recruitment', 'Phase 4 delegation fixture', 'running', NULL, ?)",
    [workflowId, at],
  );
  db.run(
    `INSERT INTO recruitment_runs (id, run_key, workflow_id, scheduled_for, trigger, status, started_at, discovery_scope, created_at)
     VALUES (?, 'phase4-delegation', ?, NULL, 'manual', 'preparing_applications', ?, 'full', ?)`,
    [runId, workflowId, at, at],
  );
  db.run(
    "INSERT INTO skills (name, category, level, verified, source, sort) VALUES ('Playwright', 'Automation & testing', 'advanced', 1, 'manual', 99)",
  );
  const taskId = agents.startTask("cover", workflowId, "Generate cover letter", `${JOB.company} — ${JOB.title}`, {
    taskType: "cover_letter_generation",
    runId,
    inputRefs: { runId, jobId: "job_phase4_delegation", vacancy: JOB.title },
    idempotencyKey: "phase4:delegation:cover",
  });
  const started = db.one<{ run_id: string; status: string; input_refs: string }>(
    "SELECT run_id, status, input_refs FROM tasks WHERE id = ?",
    [taskId],
  );
  assert.equal(started?.run_id, runId);
  assert.equal(started?.status, "running");
  assert.match(started?.input_refs ?? "", /job_phase4_delegation/);

  agents.completeTask(taskId, "cover", "Cover letter validated and stored.", false, {
    outputRefs: { coverDocumentId: "doc_phase4_cover", passed: true, diagnostics: { requestId: "ai_fixture" } },
  });
  const completed = db.one<{ status: string; output_refs: string }>(
    "SELECT status, output_refs FROM tasks WHERE id = ?",
    [taskId],
  );
  assert.equal(completed?.status, "completed");
  assert.match(completed?.output_refs ?? "", /doc_phase4_cover/);
  const events = workflowEvents.listWorkflowEvents(workflowId);
  assert.deepEqual(
    events.filter((event) => event.agent_key === "cover").map((event) => event.type),
    ["agent.queued", "agent.started", "agent.completed"],
  );

  const snapshot = topology.getAgentTopologySnapshot({ id: "u_phase4", role: "admin" });
  const connection = snapshot.connections.find((item) => item.agentKey === "cover");
  assert.equal(connection?.taskId, taskId);
  assert.equal(connection?.phase, "result");
  assert.equal(connection?.direction, "agent-to-chief");
  assert.equal(connection?.active, true, "a just-completed result is a live return animation");
  assert.match(connection?.label ?? "", /returned/i);
});

test("a recruiter page limit is validated on the rendered document, not the model object", () => {
  const requirements = requirementsModule.extractCoverLetterRequirements(
    "Your cover letter must be no more than one page.",
  );
  const content = ai.deterministicCoverLetter(MASTER, JOB, ANALYSIS, requirements);
  const result = quality.validateCoverQuality(MASTER, content, rendered(content), 2, {
    ...JOB,
    analysis: ANALYSIS,
    coverLetterRequirements: requirements,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.issues.some((item) => item.code === "page_limit_exceeded"));
});
