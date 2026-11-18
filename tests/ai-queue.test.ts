import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * FreeLLMAPI rate-limit and advisory-queue verification.
 *
 * All HTTP is mocked at the fetch boundary. These tests exercise the real
 * provider limiter, cooldown persistence, durable queue, task telemetry and
 * email-sync fallback, without contacting a gateway or Gmail.
 */

const dataDir = mkdtempSync(join(tmpdir(), "atw-ai-queue-"));
process.env.DATA_DIR = dataDir;
process.env.APP_SECRET_KEY = "ai-queue-test-secret-key";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gemini-flash-lite";
process.env.FREELLMAPI_ALLOWED_MODELS = "gemini-flash-lite";
process.env.FREELLMAPI_MODEL_ALIASES = "gemini-flash-lite-latest";
process.env.AI_MAX_RETRIES = "2";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.AI_QUEUE_MAX_ATTEMPTS = "3";
process.env.AI_RATE_LIMIT_DEFAULT_SECONDS = "1";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

type Mode = "ok" | "rate" | "cooldown" | "gate";
let mode: Mode = "ok";
let chatCalls = 0;
let modelCalls = 0;
const prompts: string[] = [];
const gates: Array<() => void> = [];

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function completion(text: string): Response {
  return json({
    model: "gemini-flash-lite",
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("gmail.googleapis.com") && url.includes("/messages?")) {
    return json({ messages: [{ id: gmailMessage.id }] });
  }
  if (url.includes("gmail.googleapis.com") && url.includes(`/messages/${gmailMessage.id}`)) {
    return json(gmailMessage);
  }
  if (url.endsWith("/models")) {
    modelCalls += 1;
    return json({ data: [{ id: "gemini-flash-lite" }, { id: "gemini-flash-lite-latest" }] });
  }
  if (url.endsWith("/chat/completions")) {
    chatCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: string }> };
    const prompt = body.messages?.[1]?.content ?? "";
    prompts.push(prompt);
    if (mode === "rate") {
      return json({ error: { message: "Too many requests; rate limit reached." } }, 429, { "Retry-After": "1" });
    }
    if (mode === "cooldown") {
      return json(
        {
          error: {
            message:
              "All models exhausted: 1 route checked (1 rate-limited or on cooldown). Add more API keys or wait for rate limits to reset.",
          },
        },
        503,
      );
    }
    if (mode === "gate") {
      return await new Promise<Response>((resolve) => gates.push(() => resolve(completion("gated reply"))));
    }
    return completion(prompt.startsWith("Subject:") ? "rejection" : "advisory reply");
  }
  throw new Error(`Unexpected test fetch: ${url}`);
}) as typeof fetch;

const { getDb, nowIso, one, run } = await import("../lib/db.ts");
const {
  AiRateLimitedError,
  clearGatewayCooldown,
  gatewayCooldownStatus,
  generateText,
} = await import("../lib/providers.ts");
const { aiQueueSnapshot, drainAiQueue, enqueueAiJob } = await import("../lib/ai-queue.ts");
const { syncInbox } = await import("../lib/gmail.ts");

getDb();
run("INSERT OR IGNORE INTO workflows (id, kind, label, status, created_at) VALUES ('wf_queue', 'recruitment', 'Queue test', 'running', ?)", [nowIso()]);
run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at)
   VALUES ('task_queue', 'wf_queue', 'analysis', 'Queued analysis note', 'completed', ?)`,
  [nowIso()],
);
run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at)
   VALUES ('task_email', 'wf_queue', 'email', 'Queued email classification', 'completed', ?)`,
  [nowIso()],
);
run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at)
   VALUES ('task_direct', 'wf_queue', 'analysis', 'Direct provider test', 'completed', ?)`,
  [nowIso()],
);

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function genericInput(prompt = "Explain this deterministic result.") {
  return {
    agentKey: "analysis",
    workflowId: "wf_queue",
    taskId: "task_direct",
    source: "task" as const,
    system: "Use only the supplied facts.",
    prompt,
    maxTokens: 16,
    temperature: 0,
  };
}

test("an HTTP 429 is detected, Retry-After is respected, and no retry is fired", async () => {
  clearGatewayCooldown();
  mode = "rate";
  const before = chatCalls;
  await assert.rejects(generateText(genericInput()), (error: unknown) => {
    assert.ok(error instanceof AiRateLimitedError);
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterMs >= 1000);
    return true;
  });
  assert.equal(chatCalls - before, 1, "a 429 must not be retried");
  const cooling = gatewayCooldownStatus();
  assert.ok(cooling.remainingMs > 0);
  assert.match(cooling.reason ?? "", /429|rate|Too many/i);

  const duringCooldown = chatCalls;
  await assert.rejects(generateText(genericInput()), (error: unknown) => error instanceof AiRateLimitedError);
  assert.equal(chatCalls, duringCooldown, "no HTTP request may fire while the route is cooling down");
  clearGatewayCooldown();
});

test("gateway exhaustion/cooldown text is treated as a rate limit even without HTTP 429", async () => {
  clearGatewayCooldown();
  mode = "cooldown";
  const before = chatCalls;
  await assert.rejects(generateText(genericInput()), (error: unknown) => {
    assert.ok(error instanceof AiRateLimitedError);
    assert.match(error.message, /All models exhausted|cooldown/i);
    return true;
  });
  assert.equal(chatCalls - before, 1);
  assert.match(gatewayCooldownStatus().reason ?? "", /All models exhausted|cooldown/i);
  clearGatewayCooldown();
});

test("queued advisory work resumes after cooldown, keeps its task id and is not duplicated", async () => {
  clearGatewayCooldown();
  mode = "rate";
  const queued = enqueueAiJob({
    kind: "analysis_note",
    dedupeKey: "task:task_queue:analysis_note",
    agentKey: "analysis",
    workflowId: "wf_queue",
    taskId: "task_queue",
    source: "task",
    priority: 2,
    payload: {
      system: "Use only the supplied facts.",
      prompt: "Explain the deterministic evidence.",
      maxTokens: 16,
      temperature: 0,
      jobId: null,
    },
  });
  assert.equal(queued.created, true);
  const duplicate = enqueueAiJob({
    kind: "analysis_note",
    dedupeKey: "task:task_queue:analysis_note",
    agentKey: "analysis",
    workflowId: "wf_queue",
    taskId: "task_queue",
    source: "task",
    priority: 2,
    payload: { prompt: "duplicate" },
  });
  assert.equal(duplicate.created, false, "the same logical job must not be queued twice");
  assert.equal(duplicate.job.id, queued.job.id);

  const failedCalls = chatCalls;
  await drainAiQueue();
  assert.equal(chatCalls - failedCalls, 1);
  let job = one<{ status: string; attempts: number; task_id: string | null }>("SELECT status, attempts, task_id FROM ai_jobs WHERE id = ?", [queued.job.id]);
  assert.equal(job?.status, "rate_limited");
  assert.equal(job?.attempts, 1);
  assert.equal(job?.task_id, "task_queue", "the queued job must retain its task id");
  let task = one<{ execution_mode: string | null; ai_outcome: string | null; attempts: number }>(
    "SELECT execution_mode, ai_outcome, attempts FROM tasks WHERE id = 'task_queue'",
  );
  assert.equal(task?.ai_outcome, null, "optional AI unavailability must not fail the task");
  assert.equal(task?.attempts, 0);

  const coolingCalls = chatCalls;
  await drainAiQueue();
  assert.equal(chatCalls, coolingCalls, "the queue must not poll the gateway during cooldown");

  mode = "ok";
  clearGatewayCooldown();
  run("UPDATE ai_jobs SET available_at = ? WHERE id = ?", [nowIso(), queued.job.id]);
  const resumedCalls = chatCalls;
  await drainAiQueue();
  assert.equal(chatCalls - resumedCalls, 1, "the job resumes once, after availability returns");
  job = one<{ status: string; attempts: number; task_id: string | null }>("SELECT status, attempts, task_id FROM ai_jobs WHERE id = ?", [queued.job.id]);
  assert.equal(job?.status, "completed");

  task = one<{ execution_mode: string | null; ai_outcome: string | null; attempts: number }>(
    "SELECT execution_mode, ai_outcome, attempts FROM tasks WHERE id = 'task_queue'",
  );
  assert.equal(task?.execution_mode, "ai");
  assert.equal(task?.ai_outcome, "ok");
  assert.equal(task?.attempts, 1);
  const usage = one<{ errors: number; successes: number }>(
    `SELECT
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_queue' AND status = 'error') AS errors,
       (SELECT COUNT(*) FROM provider_usage WHERE task_id = 'task_queue' AND status = 'ok') AS successes`,
  );
  assert.equal(usage?.errors, 1);
  assert.equal(usage?.successes, 1);

  const afterCompletion = chatCalls;
  const again = enqueueAiJob({
    kind: "analysis_note",
    dedupeKey: "task:task_queue:analysis_note",
    agentKey: "analysis",
    taskId: "task_queue",
    payload: { prompt: "repeat" },
  });
  assert.equal(again.created, false);
  assert.equal(again.job.status, "completed");
  assert.equal(chatCalls, afterCompletion, "a completed classification is never generated twice");
});

function encrypt(value: string): string {
  const key = crypto.scryptSync(process.env.APP_SECRET_KEY as string, "atw-gmail-token", 32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

run(
  `INSERT INTO gmail_accounts (id, email, access_token, refresh_token, expires_at, scopes, connected_at)
   VALUES (1, 'queue@example.test', ?, ?, ?, 'https://www.googleapis.com/auth/gmail.readonly', ?)`,
  [encrypt("access"), encrypt("refresh"), new Date(Date.now() + 3_600_000).toISOString(), nowIso()],
);

const gmailMessage = {
  id: "gm_queue",
  threadId: "th_queue",
  internalDate: String(Date.now()),
  snippet: "Unfortunately we cannot proceed.",
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: "hr@queue-example.test" },
      { name: "Subject", value: "Application update" },
    ],
    body: { data: Buffer.from("Unfortunately we cannot proceed with your application.").toString("base64url") },
  },
};

test("email AI falls back deterministically, queues once, and completes without blocking sync", async () => {
  clearGatewayCooldown();
  mode = "rate";
  const started = Date.now();
  const result = await syncInbox(5, { workflowId: "wf_queue", taskId: "task_email", source: "task" });
  assert.ok(Date.now() - started < 2500, "mailbox sync must not wait on the AI cooldown");
  assert.equal(result.aiChecked, 1);
  assert.equal(result.aiQueued, 1);
  assert.equal(result.aiClassified, 0);
  assert.equal(one<{ ai_category: string | null }>("SELECT ai_category FROM email_messages WHERE gmail_id = 'gm_queue'")?.ai_category, null);
  const deterministic = one<{ category: string }>("SELECT category FROM email_messages WHERE gmail_id = 'gm_queue'");
  assert.equal(deterministic?.category, "rejection", "the deterministic category remains authoritative");
  assert.equal(
    one<{ ai_outcome: string | null }>("SELECT ai_outcome FROM tasks WHERE id = 'task_email'")?.ai_outcome,
    null,
    "queued optional AI must not fail the email task",
  );
  assert.ok(aiQueueSnapshot().counts.rate_limited + aiQueueSnapshot().counts.queued >= 1);

  mode = "ok";
  clearGatewayCooldown();
  run("UPDATE ai_jobs SET available_at = ? WHERE dedupe_key = 'email:gm_queue'", [nowIso()]);
  await drainAiQueue();
  assert.equal(
    one<{ ai_category: string | null }>("SELECT ai_category FROM email_messages WHERE gmail_id = 'gm_queue'")?.ai_category,
    "rejection",
  );
  assert.equal(one<{ ai_outcome: string | null }>("SELECT ai_outcome FROM tasks WHERE id = 'task_email'")?.ai_outcome, "ok");
  assert.equal(
    one<{ n: number }>("SELECT COUNT(*) AS n FROM ai_jobs WHERE dedupe_key = 'email:gm_queue'")?.n,
    1,
  );

  const callsBeforeResync = chatCalls;
  const resync = await syncInbox(5, { workflowId: "wf_queue", taskId: "task_email", source: "task" });
  assert.equal(resync.aiChecked, 0, "existing mail is not classified again");
  assert.equal(chatCalls, callsBeforeResync);
});

test("interactive requests take priority over queued advisory work without starvation", async () => {
  clearGatewayCooldown();
  mode = "gate";
  const baseCalls = chatCalls;
  const basePrompt = prompts.length;
  const a = generateText({ ...genericInput("A advisory"), priority: 2, maxWaitMs: 5000 });
  await waitFor(() => chatCalls === baseCalls + 1, "first advisory call");
  const b = generateText({ ...genericInput("B interactive"), priority: 0, maxWaitMs: 5000 });
  const c = generateText({ ...genericInput("C workflow"), priority: 1, maxWaitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  gates.shift()?.();
  await a;
  await waitFor(() => chatCalls === baseCalls + 2, "interactive call after release");
  assert.match(prompts[basePrompt + 1], /B interactive/, "priority 0 must run before priority 1");
  gates.shift()?.();
  await b;
  await waitFor(() => chatCalls === baseCalls + 3, "workflow call after interactive release");
  assert.match(prompts[basePrompt + 2], /C workflow/);
  gates.shift()?.();
  await c;
  mode = "ok";
});
