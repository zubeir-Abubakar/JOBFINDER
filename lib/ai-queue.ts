import { all, nowIso, one, run } from "./db";
import { randomId } from "./security";
import {
  AiRateLimitedError,
  ProvidersUnavailableError,
  aiSlotSnapshot,
  clearGatewayCooldown,
  gatewayCooldownStatus,
  generateText,
  isRateLimitMessage,
  scrubProviderError,
  setGatewayCooldown,
} from "./providers";

/**
 * Durable advisory AI queue.
 *
 * Only optional model work belongs here: agent notes, analysis narratives and
 * email classifications. Deterministic scoring, status changes and fallback
 * text never wait for this queue. A queued job keeps its task id, so telemetry
 * is still attributed to the task that asked for it when it eventually runs.
 */

export type AiJobKind = "agent_note" | "analysis_note" | "email_classification";
export type AiJobStatus = "queued" | "processing" | "completed" | "rate_limited" | "failed";

export type AiJobRow = {
  id: string;
  dedupe_key: string;
  kind: AiJobKind;
  agent_key: string;
  workflow_id: string | null;
  task_id: string | null;
  source: string;
  priority: number;
  status: AiJobStatus;
  payload: string;
  attempts: number;
  available_at: string;
  last_error: string | null;
  provider: string | null;
  model: string | null;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

type EnqueueInput = {
  kind: AiJobKind;
  dedupeKey: string;
  agentKey: string;
  workflowId?: string | null;
  taskId?: string | null;
  source?: "task" | "manual";
  priority?: number;
  payload: Record<string, unknown>;
  availableAt?: string;
};

type JobPayload = {
  system?: string;
  prompt?: string;
  maxTokens?: number;
  temperature?: number;
  technical?: boolean;
  jobId?: string;
  messageId?: string;
  subject?: string;
  body?: string;
};

type QueueGlobal = typeof globalThis & {
  __atwAiQueue?: { started: boolean; pumping: boolean; timer?: ReturnType<typeof setTimeout> };
};

const q = globalThis as QueueGlobal;

function state() {
  q.__atwAiQueue ??= { started: false, pumping: false };
  return q.__atwAiQueue;
}

const EMAIL_SYSTEM =
  "You classify recruitment email. Reply with exactly one label and nothing else: interview_invitation, rejection, recruiter_question, acknowledgement, or unrelated. Never guess when the message is ambiguous; use unrelated.";
const EMAIL_CATEGORIES = new Set([
  "interview_invitation",
  "rejection",
  "recruiter_question",
  "acknowledgement",
  "unrelated",
]);

function maxAttempts(): number {
  const parsed = Number(process.env.AI_QUEUE_MAX_ATTEMPTS ?? "12");
  return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : 12;
}

function schedulePump(delayMs: number): void {
  const current = state();
  if (current.timer) clearTimeout(current.timer);
  current.timer = setTimeout(() => {
    current.timer = undefined;
    void pumpAiQueue();
  }, Math.max(50, delayMs));
  current.timer.unref?.();
}

function markTaskAi(
  taskId: string | null,
  ok: boolean,
  provider: string | null,
  model: string | null,
  text?: string,
): void {
  if (!taskId) return;
  if (ok) {
    run(
      "UPDATE tasks SET execution_mode = 'ai', ai_outcome = 'ok', provider = COALESCE(?, provider), model = COALESCE(?, model), attempts = attempts + 1 WHERE id = ?",
      [provider, model, taskId],
    );
    if (text) {
      run(
        "UPDATE tasks SET output = substr(COALESCE(output, '') || ?, 1, 6000) WHERE id = ?",
        [` AI advisory (${provider ?? "freellmapi"}/${model ?? "pinned"}): ${text.replace(/\s+/g, " ").slice(0, 300)}`, taskId],
      );
    }
  } else {
    run(
      "UPDATE tasks SET execution_mode = 'ai', ai_outcome = CASE WHEN ai_outcome = 'ok' THEN 'ok' ELSE 'failed' END, attempts = attempts + 1 WHERE id = ?",
      [taskId],
    );
  }
}

async function executeJob(job: AiJobRow): Promise<{ text: string; provider: string; model: string }> {
  const payload = JSON.parse(job.payload) as JobPayload;
  const source: "task" | "manual" = job.source === "manual" ? "manual" : "task";

  if (job.kind === "email_classification") {
    if (payload.messageId) {
      const existing = one<{ ai_category: string | null }>(
        "SELECT ai_category FROM email_messages WHERE id = ?",
        [payload.messageId],
      );
      if (existing?.ai_category) {
        // The job is idempotent: a completed classification is returned
        // instead of asking the model again.
        return { text: existing.ai_category, provider: "freellmapi", model: job.model ?? "" };
      }
    }
    const result = await generateText({
      agentKey: job.agent_key,
      workflowId: job.workflow_id,
      taskId: job.task_id,
      source,
      priority: 2,
      system: EMAIL_SYSTEM,
      prompt: `Subject: ${(payload.subject ?? "").slice(0, 300)}\n\nMessage: ${(payload.body ?? "").slice(0, 1200)}`,
      maxTokens: 8,
      temperature: 0,
    });
    const label = result.text.toLowerCase().replace(/[^a-z_]/g, "").trim();
    if (!EMAIL_CATEGORIES.has(label)) {
      throw new Error(`AI returned an invalid email category: ${label.slice(0, 40) || "(empty)"}.`);
    }
    if (payload.messageId) {
      run("UPDATE email_messages SET ai_category = ?, ai_classified_at = ? WHERE id = ?", [
        label,
        nowIso(),
        payload.messageId,
      ]);
    }
    markTaskAi(job.task_id, true, result.provider, result.model);
    return { text: label, provider: result.provider, model: result.model };
  }

  const result = await generateText({
    agentKey: job.agent_key,
    workflowId: job.workflow_id,
    taskId: job.task_id,
    source,
    priority: 2,
    system: payload.system ?? "Return a concise advisory note using only the supplied facts.",
    prompt: payload.prompt ?? "",
    maxTokens: payload.maxTokens ?? 320,
    temperature: payload.temperature ?? 0.15,
    technical: payload.technical ?? false,
  });
  if (job.kind === "analysis_note" && payload.jobId) {
    run("UPDATE jobs SET ai_note = ? WHERE id = ?", [result.text.slice(0, 2000), payload.jobId]);
  }
  markTaskAi(job.task_id, true, result.provider, result.model, result.text);
  return { text: result.text, provider: result.provider, model: result.model };
}

/**
 * Enqueue once per logical job. The unique dedupe key is the source of truth:
 * a second attempt while the first is queued, processing or completed returns
 * the existing row and never creates a duplicate model call.
 */
export function enqueueAiJob(input: EnqueueInput): { job: AiJobRow; created: boolean } {
  const existing = one<AiJobRow>("SELECT * FROM ai_jobs WHERE dedupe_key = ?", [input.dedupeKey]);
  if (existing) {
    startAiQueue();
    return { job: existing, created: false };
  }
  const id = `aij_${randomId()}`;
  const now = nowIso();
  try {
    run(
      `INSERT INTO ai_jobs (id, dedupe_key, kind, agent_key, workflow_id, task_id, source, priority, status, payload, attempts, available_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
      [
        id,
        input.dedupeKey,
        input.kind,
        input.agentKey,
        input.workflowId ?? null,
        input.taskId ?? null,
        input.source ?? "task",
        Math.max(0, Math.min(2, Math.floor(input.priority ?? 2))),
        JSON.stringify(input.payload),
        input.availableAt ?? now,
        now,
      ],
    );
  } catch (error) {
    // A concurrent enqueue can win the unique key race; return that row.
    const raced = one<AiJobRow>("SELECT * FROM ai_jobs WHERE dedupe_key = ?", [input.dedupeKey]);
    if (raced) return { job: raced, created: false };
    throw error;
  }
  const job = one<AiJobRow>("SELECT * FROM ai_jobs WHERE id = ?", [id]);
  if (!job) throw new Error("AI job was inserted but could not be read back.");
  startAiQueue();
  return { job, created: true };
}

export function startAiQueue(): void {
  const current = state();
  if (!current.started) {
    current.started = true;
    // A process restart must not strand work that was in-flight. The job is
    // requeued, not failed, so no pending advisory work is discarded.
    run(
      "UPDATE ai_jobs SET status = 'queued', available_at = ?, last_error = COALESCE(last_error, 'Interrupted by server restart; requeued.') WHERE status = 'processing'",
      [nowIso()],
    );
  }
  schedulePump(0);
}

async function pumpAiQueue(): Promise<void> {
  const current = state();
  if (current.pumping) return;
  current.pumping = true;
  try {
    for (;;) {
      const cooling = gatewayCooldownStatus();
      if (cooling.remainingMs > 0) {
        schedulePump(cooling.remainingMs + 100);
        return;
      }

      const job = one<AiJobRow>(
        "SELECT * FROM ai_jobs WHERE status IN ('queued', 'rate_limited') AND available_at <= ? ORDER BY priority ASC, created_at ASC LIMIT 1",
        [nowIso()],
      );
      if (!job) {
        const next = one<{ at: string | null }>(
          "SELECT MIN(available_at) AS at FROM ai_jobs WHERE status IN ('queued', 'rate_limited')",
        );
        if (next?.at) {
          const wait = Date.parse(next.at) - Date.now();
          if (Number.isFinite(wait)) schedulePump(wait + 100);
        }
        return;
      }

      run(
        "UPDATE ai_jobs SET status = 'processing', started_at = COALESCE(started_at, ?), last_error = NULL WHERE id = ?",
        [nowIso(), job.id],
      );
      try {
        const result = await executeJob(job);
        run(
          "UPDATE ai_jobs SET status = 'completed', provider = ?, model = ?, result = ?, last_error = NULL, finished_at = ? WHERE id = ?",
          [result.provider, result.model, result.text.slice(0, 4000), nowIso(), job.id],
        );
        clearGatewayCooldown();
      } catch (error) {
        const message = scrubProviderError(error instanceof Error ? error.message : "AI job failed");
        const attempts = job.attempts + 1;

        if (error instanceof AiRateLimitedError) {
          setGatewayCooldown(error.retryAfterMs, message);
          run(
            "UPDATE ai_jobs SET status = 'rate_limited', attempts = ?, available_at = ?, last_error = ? WHERE id = ?",
            [attempts, new Date(Date.now() + error.retryAfterMs).toISOString(), message, job.id],
          );
          schedulePump(error.retryAfterMs + 100);
          return;
        }

        const retryable =
          error instanceof ProvidersUnavailableError ||
          isRateLimitMessage(message) ||
          /unreachable|fetch failed|timed? ?out|ECONNREFUSED|socket/i.test(message);
        if (retryable && attempts < maxAttempts()) {
          const backoff = Math.min(5 * 60_000, 15_000 * 2 ** Math.min(attempts - 1, 4));
          run(
            "UPDATE ai_jobs SET status = 'rate_limited', attempts = ?, available_at = ?, last_error = ? WHERE id = ?",
            [attempts, new Date(Date.now() + backoff).toISOString(), message, job.id],
          );
          schedulePump(backoff + 100);
          return;
        }

        run(
          "UPDATE ai_jobs SET status = 'failed', attempts = ?, last_error = ?, finished_at = ? WHERE id = ?",
          [attempts, message, nowIso(), job.id],
        );
        markTaskAi(job.task_id, false, null, null);
      }
    }
  } finally {
    current.pumping = false;
  }
}

/** Exposed for the startup hook and deterministic tests. */
export async function drainAiQueue(): Promise<void> {
  startAiQueue();
  await pumpAiQueue();
}

export type AiQueueSnapshot = {
  counts: Record<AiJobStatus, number>;
  jobs: AiJobRow[];
  cooldown: ReturnType<typeof gatewayCooldownStatus>;
  slots: ReturnType<typeof aiSlotSnapshot>;
  maxAttempts: number;
};

export function aiQueueSnapshot(): AiQueueSnapshot {
  startAiQueue();
  const counts: Record<AiJobStatus, number> = {
    queued: 0,
    processing: 0,
    completed: 0,
    rate_limited: 0,
    failed: 0,
  };
  for (const row of all<{ status: AiJobStatus; n: number }>(
    "SELECT status, COUNT(*) AS n FROM ai_jobs GROUP BY status",
  )) {
    if (row.status in counts) counts[row.status] = Number(row.n);
  }
  const jobs = all<AiJobRow>(
    "SELECT * FROM ai_jobs ORDER BY created_at DESC LIMIT 8",
  );
  return {
    counts,
    jobs,
    cooldown: gatewayCooldownStatus(),
    slots: aiSlotSnapshot(),
    maxAttempts: maxAttempts(),
  };
}

/** True when an advisory call can be handed to the queue rather than failed. */
export function isQueueableAiError(error: unknown): boolean {
  return error instanceof AiRateLimitedError || error instanceof ProvidersUnavailableError || isRateLimitMessage(
    error instanceof Error ? error.message : "",
  );
}
