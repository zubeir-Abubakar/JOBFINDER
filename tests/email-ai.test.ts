import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Mailbox processing must continue deterministically while every external AI
 * route is blocked. No Gmail account, provider or employer is contacted.
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

getDb();

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

let inbox: Mail[] = [acme, beta, delta, gamma];
let externalInferenceCalls = 0;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

  if (url.includes("/chat/completions")) {
    externalInferenceCalls += 1;
    throw new Error("No external inference request is permitted");
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
  return getDb()
    .prepare("SELECT provider, model, task_id, source, status FROM provider_usage WHERE agent_key = 'email' ORDER BY id")
    .all() as Array<{ provider: string; model: string; task_id: string | null; source: string; status: string }>;
}

test("workflow sync classifies deterministically and transmits no external AI", async () => {
  externalInferenceCalls = 0;
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
  assert.equal(result.aiChecked, 3, "the per-sync advisory cap is three");
  assert.equal(result.aiClassified, 0);
  assert.equal(result.aiQueued, 0, "a policy block must not be queued for a later external retry");
  assert.equal(result.aiFailed, 3);
  assert.equal(externalInferenceCalls, 0);
  assert.equal(usageRows().length, 0, "no provider usage may be invented for a blocked request");

  const messages = getDb()
    .prepare("SELECT gmail_id, category, ai_category, ai_classified_at FROM email_messages")
    .all() as Array<{ gmail_id: string; category: string; ai_category: string | null; ai_classified_at: string | null }>;
  const byId = new Map(messages.map((message) => [message.gmail_id, message]));
  assert.equal(byId.get("gm1")?.category, "rejection");
  assert.equal(byId.get("gm2")?.category, "interview_invitation");
  assert.equal(byId.get("gm3")?.category, "unrelated");
  assert.equal(byId.get("gm4")?.category, "recruiter_question");
  for (const message of messages) {
    assert.equal(message.ai_category, null);
    assert.equal(message.ai_classified_at, null);
  }

  assert.equal(applicationStatus("app_acme"), "rejected");
  assert.equal(applicationStatus("app_beta"), "interview_invited");
  assert.equal(applicationStatus("app_delta"), "awaiting_approval");
  assert.equal(applicationStatus("app_gamma"), "awaiting_approval");

  const task = one<{ execution_mode: string; ai_outcome: string; attempts: number }>(
    "SELECT execution_mode, ai_outcome, attempts FROM tasks WHERE id = 'task_email_test'",
  );
  assert.deepEqual({ ...task }, { execution_mode: "deterministic", ai_outcome: "blocked", attempts: 0 });

  const jobs = one<{ n: number }>("SELECT COUNT(*) AS n FROM ai_jobs WHERE task_id = 'task_email_test'");
  assert.equal(jobs?.n, 0);
});

test("manual sync also transmits no external AI and records no usage", async () => {
  externalInferenceCalls = 0;
  inbox = [epsilon, zeta];
  const result = await syncInbox(20, { source: "manual" });
  assert.equal(result.inserted, 2);
  assert.equal(result.aiChecked, 2);
  assert.equal(result.aiClassified, 0);
  assert.equal(result.aiQueued, 0);
  assert.equal(result.aiFailed, 2);
  assert.equal(externalInferenceCalls, 0);
  assert.equal(applicationStatus("app_epsilon"), "acknowledged");
  assert.equal(usageRows().length, 0);
  assert.equal(
    one<{ n: number }>("SELECT COUNT(*) AS n FROM ai_jobs WHERE dedupe_key IN ('email:gm5','email:gm6')")?.n,
    0,
  );
});

test("inbox renders the AI advisory label separately from the authoritative category", () => {
  const source = readFileSync(join(process.cwd(), "app/(app)/inbox/page.tsx"), "utf8");
  assert.ok(source.includes("{category.label}"));
  assert.ok(source.includes("AI: {CATEGORY[message.ai_category]"));
  assert.ok(source.includes("Advisory only"));
});
