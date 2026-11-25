import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A policy-blocked advisory job is terminal. It must not be retried, queued
 * again, or quietly turned into a completed task.
 */

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "atw-ai-queue-"));
process.env.APP_SECRET_KEY = "ai-queue-test-secret-key";
process.env.FREELLMAPI_ENABLED = "true";
process.env.FREELLMAPI_BASE_URL = "http://gateway.test/v1";
process.env.FREELLMAPI_API_KEY = "test-gateway-key";
process.env.FREELLMAPI_MODEL = "gateway-model";
process.env.FREELLMAPI_ALLOWED_MODELS = "gateway-model";
process.env.FREELLMAPI_MODEL_ALIASES = "";
process.env.AI_MAX_RETRIES = "2";
process.env.AI_MAX_CONCURRENCY = "1";
process.env.AI_QUEUE_MAX_ATTEMPTS = "3";
process.env.OLLAMA_ENABLED = "false";
process.env.OPENROUTER_ENABLED = "false";
delete process.env.GEMINI_API_KEY;

let fetchCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  fetchCalls += 1;
  throw new Error(`No network request is permitted: ${String(input)}`);
}) as typeof fetch;

const { getDb, nowIso, one, run } = await import("../lib/db.ts");
const { drainAiQueue, enqueueAiJob } = await import("../lib/ai-queue.ts");

getDb();
run(
  "INSERT OR IGNORE INTO workflows (id, kind, label, status, created_at) VALUES ('wf_queue', 'recruitment', 'Queue test', 'running', ?)",
  [nowIso()],
);
run(
  `INSERT INTO tasks (id, workflow_id, agent_key, title, status, created_at)
   VALUES ('task_queue', 'wf_queue', 'analysis', 'Queued analysis note', 'running', ?)`,
  [nowIso()],
);

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("an unverified external advisory job fails once and is never retried", async () => {
  fetchCalls = 0;
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

  await drainAiQueue();
  await waitFor(
    () =>
      one<{ status: string }>("SELECT status FROM ai_jobs WHERE id = ?", [queued.job.id])?.status === "failed",
    "blocked job to fail",
  );

  const job = one<{ status: string; attempts: number; last_error: string | null }>(
    "SELECT status, attempts, last_error FROM ai_jobs WHERE id = ?",
    [queued.job.id],
  );
  assert.equal(job?.status, "failed");
  assert.equal(job?.attempts, 1, "a policy block must not be retried");
  assert.match(job?.last_error ?? "", /CHF 0\.00|blocked/i);

  const task = one<{
    execution_mode: string | null;
    ai_outcome: string | null;
    state_reason: string | null;
    attempts: number;
  }>(
    "SELECT execution_mode, ai_outcome, state_reason, attempts FROM tasks WHERE id = 'task_queue'",
  );
  assert.equal(task?.execution_mode, "deterministic");
  assert.equal(task?.ai_outcome, "blocked");
  assert.equal(task?.attempts, 0, "a blocked job must not fabricate a provider attempt");
  assert.match(task?.state_reason ?? "", /CHF 0\.00|blocked/i);

  const countBefore = one<{ n: number }>("SELECT COUNT(*) AS n FROM ai_jobs")?.n ?? 0;
  await drainAiQueue();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM ai_jobs")?.n, countBefore);
  assert.equal(
    one<{ attempts: number }>("SELECT attempts FROM ai_jobs WHERE id = ?", [queued.job.id])?.attempts,
    1,
  );
  assert.equal(fetchCalls, 0, "no external inference request may be transmitted");
});
