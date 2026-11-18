import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Email AI verification.
 *
 * Gmail and FreeLLMAPI are mocked at the fetch boundary so the tests are
 * deterministic and never contact a real mailbox. The production code paths
 * under test are the real `syncInbox`, `classifyWithAi`, provider gateway,
 * usage recorder and application-status rules.
 */

const dataDir = mkdtempSync(join(tmpdir(), "atw-email-ai-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET_KEY = "email-ai-test-secret-key";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gemini-flash-lite";
process.env.FREELLMAPI_ALLOWED_MODELS = "gemini-flash-lite";
process.env.FREELLMAPI_MODEL_ALIASES = "gemini-flash-lite-latest";
process.env.AI_MAX_RETRIES = "2";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

const { getDb, one, run, nowIso } = await import("../lib/db.ts");
const { syncInbox } = await import("../lib/gmail.ts");

const db = getDb();

/* ------------------------------- fixtures ------------------------------- */

function encrypt(value: string): string {
  const key = crypto.scryptSync(process.env.APP_SECRET_KEY as string, "atw-gmail-token", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

run(
  `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, ?, ?, ?, ?, ?, ?)`,
  [
    "verify@example.test",
    encrypt("test-access-token"),
    encrypt("test-refresh-token"),
    new Date(Date.now() + 3_600_000).toISOString(),
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    nowIso(),
  ],
);

function seedApplication(key: string, company: string): void {
  run(
    `INSERT INTO jobs (id, source, title, company, location, remote, url, discovered_at, status)
     VALUES (?, 'manual', ?, ?, 'Zurich', 1, ?, ?, 'documents')`,
    [`job_${key}`, `${company} QA Engineer`, company, `https://example.test/${key}`, nowIso()],
  );
  run(
    `INSERT INTO applications (id, job_id, status, method, last_update, created_at)
     VALUES (?, ?, 'awaiting_approval', 'manual', ?, ?)`,
    [`app_${key}`, `job_${key}`, nowIso(), nowIso()],
  );
}

for (const [key, company] of [
  ["acme", "Acme"],
  ["beta", "Beta"],
  ["delta", "Delta"],
  ["gamma", "Gamma"],
  ["epsilon", "Epsilon"],
  ["zeta", "Zeta"],
  ["eta", "EtaLabs"],
] as const) {
  seedApplication(key, company);
}

type Mail = { id: string; from: string; subject: string; body: string };

const acme = {
  id: "gm1",
  from: "hr@acme.test",
  subject: "Application update",
  body: "Hello, unfortunately we are not moving forward with your application at Acme.",
};
const beta = {
  id: "gm2",
  from: "talent@beta.test",
  subject: "Interview invitation",
  body: "We would like to invite you to an interview at Beta.",
};
const delta = {
  id: "gm3",
  from: "news@delta.test",
  subject: "Monthly product news",
  body: "Delta monthly product news for subscribers.",
};
const gamma = {
  id: "gm4",
  from: "recruiter@gamma.test",
  subject: "Quick question",
  body: "Could you clarify your notice period at Gamma?",
};
const epsilon = {
  id: "gm5",
  from: "jobs@epsilon.test",
  subject: "Application received",
  body: "We received your application at Epsilon.",
};
const zeta = {
  id: "gm6",
  from: "people@zeta.test",
  subject: "Checking in",
  body: "Do you have time for a question about Zeta?",
};
const eta = {
  id: "gm7",
  from: "hr@eta.test",
  subject: "Rejection notice",
  body: "Unfortunately we cannot proceed with EtaLabs.",
};

let inbox: Mail[] = [acme, beta, delta, gamma];
let chatMode: "ok" | "fail" = "ok";
let gatewayModel: string | null = null;
let gatewayAuth: string | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url === "http://gateway.test/v1/models") {
    return json({ data: [{ id: "gemini-flash-lite" }, { id: "gemini-flash-lite-latest" }] });
  }

  if (url === "http://gateway.test/v1/chat/completions") {
    const headers = new Headers(init?.headers as HeadersInit);
    gatewayAuth = headers.get("authorization");
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    gatewayModel = body.model ?? null;
    if (chatMode === "fail") return json({ error: { message: "gateway down for test" } }, 500);
    const prompt = body.messages?.find((message) => message.role === "user")?.content ?? "";
    // Deliberately adversarial labels: the AI must disagree with the regex on
    // all three capped messages so status independence is observable.
    const label = prompt.includes("Monthly product news")
      ? "interview_invitation"
      : prompt.includes("Interview invitation")
        ? "rejection"
        : prompt.includes("Application update")
          ? "unrelated"
          : "recruiter_question";
    return json({
      model: "gemini-flash-lite-latest",
      choices: [{ message: { content: label } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
    });
  }

  if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
    return json({ messages: inbox.map((message) => ({ id: message.id })) });
  }

  const single = url.match(/\/messages\/([^/?]+)\?format=full/);
  if (single) {
    const message = inbox.find((item) => item.id === single[1]);
    if (!message) return json({ error: { message: "not found" } }, 404);
    return json({
      id: message.id,
      threadId: `thread_${message.id}`,
      snippet: message.body.slice(0, 80),
      internalDate: String(Date.now()),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: message.from },
          { name: "Subject", value: message.subject },
        ],
        body: { data: Buffer.from(message.body, "utf8").toString("base64url") },
      },
    });
  }

  throw new Error(`Unexpected fetch: ${url}`);
}) as typeof fetch;

function applicationStatus(id: string): string | null {
  return one<{ status: string }>("SELECT status FROM applications WHERE id = ?", [id])?.status ?? null;
}

function usageRows(): Array<{ provider: string; model: string; task_id: string | null; source: string; status: string }> {
  return db
    .prepare("SELECT provider, model, task_id, source, status FROM provider_usage WHERE agent_key = 'email' ORDER BY id")
    .all() as Array<{ provider: string; model: string; task_id: string | null; source: string; status: string }>;
}

/* ------------------------------- workflow ------------------------------- */

test("workflow classification links calls to the task and AI cannot drive status", async () => {
  run(
    "INSERT INTO workflows (id, kind, label, status, created_at) VALUES ('wf_email_test', 'recruitment', 'Email verification', 'running', ?)",
    [nowIso()],
  );
  run(
    `INSERT INTO tasks (id, workflow_id, agent_key, title, status, execution_mode, created_at, started_at)
     VALUES ('task_email_test', 'wf_email_test', 'email', 'Synchronise recruiter correspondence', 'running', 'deterministic', ?, ?)`,
    [nowIso(), nowIso()],
  );

  const result = await syncInbox(20, { workflowId: "wf_email_test", taskId: "task_email_test", source: "task" });
  assert.equal(result.inserted, 4);
  assert.equal(result.aiChecked, 3, "the per-sync AI cap is three");
  assert.equal(result.aiClassified, 3);
  assert.equal(result.aiFailed, 0);

  // Provider/model: the pinned request id and its declared resolution alias.
  assert.equal(gatewayModel, "gemini-flash-lite");
  assert.equal(gatewayAuth, "Bearer test-gateway-key");
  const usage = usageRows();
  assert.equal(usage.length, 3);
  for (const row of usage) {
    assert.equal(row.provider, "freellmapi");
    assert.equal(row.model, "gemini-flash-lite-latest");
    assert.equal(row.task_id, "task_email_test");
    assert.equal(row.source, "task");
    assert.equal(row.status, "ok");
  }

  const task = one<{ execution_mode: string; ai_outcome: string; provider: string; model: string; attempts: number }>(
    "SELECT execution_mode, ai_outcome, provider, model, attempts FROM tasks WHERE id = 'task_email_test'",
  );
  assert.deepEqual({ ...task }, {
    execution_mode: "ai",
    ai_outcome: "ok",
    provider: "freellmapi",
    model: "gemini-flash-lite-latest",
    attempts: 3,
  });

  const agent = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'email'",
  );
  assert.deepEqual({ ...agent }, { ai_success_count: 3, ai_failure_count: 0 });

  // Both labels are stored; only the deterministic one is authoritative.
  const messages = db
    .prepare("SELECT gmail_id, category, ai_category, ai_classified_at FROM email_messages")
    .all() as Array<{ gmail_id: string; category: string; ai_category: string | null; ai_classified_at: string | null }>;
  const byId = new Map(messages.map((message) => [message.gmail_id, message]));
  assert.equal(byId.get("gm1")?.category, "rejection");
  assert.equal(byId.get("gm1")?.ai_category, "unrelated");
  assert.ok(byId.get("gm1")?.ai_classified_at);
  assert.equal(byId.get("gm2")?.category, "interview_invitation");
  assert.equal(byId.get("gm2")?.ai_category, "rejection");
  assert.ok(byId.get("gm2")?.ai_classified_at);
  assert.equal(byId.get("gm3")?.category, "unrelated");
  assert.equal(byId.get("gm3")?.ai_category, "interview_invitation");
  assert.ok(byId.get("gm3")?.ai_classified_at);
  assert.equal(byId.get("gm4")?.category, "recruiter_question");
  assert.equal(byId.get("gm4")?.ai_category, null, "fourth message is outside the cap");

  // Deterministic transitions happened; the AI label never overrode them.
  assert.equal(applicationStatus("app_acme"), "rejected");
  assert.equal(applicationStatus("app_beta"), "interview_invited");
  assert.equal(
    applicationStatus("app_delta"),
    "awaiting_approval",
    "AI said interview_invitation, but the deterministic category was unrelated",
  );
  assert.equal(applicationStatus("app_gamma"), "awaiting_approval");
});

/* --------------------------------- manual -------------------------------- */

test("manual sync is attributed to manual and repeated syncs make no extra AI calls", async () => {
  inbox = [epsilon, zeta];
  const before = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'email'",
  );
  const usageBefore = usageRows().length;

  const result = await syncInbox(20, { source: "manual" });
  assert.equal(result.inserted, 2);
  assert.equal(result.aiChecked, 2);
  assert.equal(result.aiClassified, 2);

  const manualUsage = usageRows().filter((row) => row.source === "manual");
  assert.equal(manualUsage.length, 2);
  for (const row of manualUsage) {
    assert.equal(row.task_id, null, "manual calls must not claim a recruitment task");
    assert.equal(row.provider, "freellmapi");
    assert.equal(row.model, "gemini-flash-lite-latest");
    assert.equal(row.status, "ok");
  }

  const after = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'email'",
  );
  assert.deepEqual(after, before, "manual calls must not move task counters");
  const task = one<{ attempts: number; ai_outcome: string }>(
    "SELECT attempts, ai_outcome FROM tasks WHERE id = 'task_email_test'",
  );
  assert.deepEqual({ ...task }, { attempts: 3, ai_outcome: "ok" });

  const usageAfterFirst = usageRows().length;
  const repeat = await syncInbox(20, { source: "manual" });
  assert.equal(repeat.inserted, 0);
  assert.equal(repeat.aiChecked, 0);
  assert.equal(repeat.aiClassified, 0);
  assert.equal(usageRows().length, usageAfterFirst, "a repeat sync must not create duplicate AI calls");
  assert.equal(usageAfterFirst, usageBefore + 2);
});

/* -------------------------------- fallback ------------------------------- */

test("regex fallback still classifies and updates status while unavailable AI is queued", async () => {
  inbox = [eta];
  chatMode = "fail";
  run(
    "INSERT INTO workflows (id, kind, label, status, created_at) VALUES ('wf_email_fallback', 'recruitment', 'Fallback verification', 'running', ?)",
    [nowIso()],
  );
  run(
    `INSERT INTO tasks (id, workflow_id, agent_key, title, status, execution_mode, created_at, started_at)
     VALUES ('task_email_fallback', 'wf_email_fallback', 'email', 'Fallback sync', 'running', 'deterministic', ?, ?)`,
    [nowIso(), nowIso()],
  );
  const before = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'email'",
  );

  const result = await syncInbox(20, {
    workflowId: "wf_email_fallback",
    taskId: "task_email_fallback",
    source: "task",
  });
  assert.equal(result.inserted, 1);
  assert.equal(result.aiChecked, 1);
  assert.equal(result.aiClassified, 0);
  assert.equal(result.aiQueued, 1, "unavailable advisory work is queued, not discarded");
  assert.equal(result.aiFailed, 0);

  const failed = usageRows().filter((row) => row.task_id === "task_email_fallback");
  assert.equal(failed.length, 3, "one classification produces three HTTP attempts with the default two retries");
  assert.equal(failed[0]?.status, "error");
  assert.equal(failed[0]?.source, "task");
  assert.equal(failed[0]?.provider, "freellmapi");
  assert.equal(failed[0]?.model, "gemini-flash-lite");
  const queued = one<{ status: string; task_id: string | null }>(
    "SELECT status, task_id FROM ai_jobs WHERE dedupe_key = 'email:gm7'",
  );
  assert.equal(queued?.task_id, "task_email_fallback");
  assert.match(queued?.status ?? "", /queued|processing|rate_limited/, "the advisory job is retained for later");

  const task = one<{ execution_mode: string; ai_outcome: string | null; attempts: number }>(
    "SELECT execution_mode, ai_outcome, attempts FROM tasks WHERE id = 'task_email_fallback'",
  );
  assert.deepEqual(
    { ...task },
    { execution_mode: "deterministic", ai_outcome: null, attempts: 0 },
    "optional AI unavailability must not fail or delay the deterministic task",
  );

  const agent = one<{ ai_success_count: number; ai_failure_count: number }>(
    "SELECT ai_success_count, ai_failure_count FROM agents WHERE key = 'email'",
  );
  assert.equal(agent?.ai_success_count, before?.ai_success_count);
  assert.equal(agent?.ai_failure_count, (before?.ai_failure_count ?? 0) + 3);

  const message = one<{ category: string; ai_category: string | null }>(
    "SELECT category, ai_category FROM email_messages WHERE gmail_id = 'gm7'",
  );
  assert.equal(message?.category, "rejection", "the regex still classified the rejection");
  assert.equal(message?.ai_category, null, "no AI label is invented after a failed call");
  assert.equal(applicationStatus("app_eta"), "rejected", "the deterministic fallback still updated status");
});

/* ----------------------------------- UI ---------------------------------- */

test("inbox renders the AI advisory label separately from the authoritative category", () => {
  const source = readFileSync(join(process.cwd(), "app/(app)/inbox/page.tsx"), "utf8");
  assert.ok(source.includes("{category.label}"), "authoritative category badge is rendered from the deterministic field");
  assert.ok(source.includes("AI: {CATEGORY[message.ai_category]"), "AI advisory badge is rendered separately");
  assert.ok(source.includes("Advisory only"), "the advisory label explains that status changes are deterministic");
});
