import { all } from "./db";

/**
 * Additive execution contract for persisted tasks.
 *
 * The original `tasks` table remains the source of truth. These helpers add
 * explicit task typing, dependency readiness and error classification without
 * replacing existing agents, workflows or provider handling.
 */

export type TaskType =
  | "orchestration"
  | "retrieval"
  | "analysis"
  | "cv_generation"
  | "cover_letter_generation"
  | "document_validation"
  | "rendering"
  | "submission"
  | "notification"
  | "other";

export type TaskErrorClass =
  | "dependency"
  | "authentication"
  | "rate_limited"
  | "quota_exhausted"
  | "timeout"
  | "network"
  | "provider_unavailable"
  | "validation"
  | "submission_ambiguous"
  | "blocked"
  | "unknown";

/** Expected execution windows by task type. A slow but healthy task is not failed. */
export const TASK_TIMEOUT_MS: Record<TaskType, number> = {
  orchestration: 30 * 60_000,
  retrieval: 10 * 60_000,
  analysis: 10 * 60_000,
  cv_generation: 15 * 60_000,
  cover_letter_generation: 15 * 60_000,
  document_validation: 10 * 60_000,
  rendering: 10 * 60_000,
  submission: 5 * 60_000,
  notification: 5 * 60_000,
  other: 30 * 60_000,
};

export const TASK_STALL_AFTER_MS = TASK_TIMEOUT_MS.other;

export function taskTypeFor(agentKey: string, title: string): TaskType {
  const value = `${agentKey} ${title}`.toLowerCase();
  if (/\bcover\s*letter|anschreiben\b/.test(value)) return "cover_letter_generation";
  if (/\b(?:tailor(?:ed)?\s+)?cv\b|\bresume\b|\blebenslauf\b/.test(value)) return "cv_generation";
  if (/\bpdf\b|\brender(?:ing)?\b/.test(value)) return "rendering";
  if (/\b(?:quality|validate|validation|audit|preservation|ats)\b/.test(value)) return "document_validation";
  if (/\b(?:submit|submission|apply|application portal)\b/.test(value)) return "submission";
  if (/\b(?:notify|notification|email|confirmation)\b/.test(value)) return "notification";
  if (/\b(?:research|discover|discovery|fetch|retriev|source|vacanc)/.test(value)) return "retrieval";
  if (/\b(?:score|analysis|analyse|analyze|match|assess)\b/.test(value)) return "analysis";
  if (agentKey === "coordinator" || /\b(?:workflow|assign|orchestrat|coordinate)\b/.test(value)) return "orchestration";
  return "other";
}

export function taskTimeoutMs(taskType: string | null | undefined, agentKey: string, title: string): number {
  const known = taskType && taskType in TASK_TIMEOUT_MS ? (taskType as TaskType) : taskTypeFor(agentKey, title);
  return TASK_TIMEOUT_MS[known] ?? TASK_STALL_AFTER_MS;
}

export function parseDependencies(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))];
  } catch {
    return [];
  }
}

export function dependencyJson(ids: string[] | null | undefined): string | null {
  const unique = [...new Set((ids ?? []).filter((item) => typeof item === "string" && item.length > 0))];
  return unique.length > 0 ? JSON.stringify(unique) : null;
}

export function classifyTaskError(error: unknown): TaskErrorClass {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  if (!message) return "unknown";
  if (/dependency|prerequisite|blocked by|not completed/.test(message)) return "dependency";
  if (/api key|authentication|unauthori[sz]ed|\b401\b|invalid token|credential/.test(message)) return "authentication";
  if (/quota|billing|credit|insufficient funds|\b402\b/.test(message)) return "quota_exhausted";
  if (/rate.?limit|too many requests|\b429\b/.test(message)) return "rate_limited";
  if (/timed? ?out|timeout|etimedout|deadline/.test(message)) return "timeout";
  if (/econnrefused|econnreset|enotfound|network|fetch failed|socket/.test(message)) return "network";
  if (/unavailable|overload|service temporarily|\b5\d\d\b/.test(message)) return "provider_unavailable";
  if (/ambiguous|uncertain submission|timeout after submit/.test(message)) return "submission_ambiguous";
  if (/validation|invalid|quality gate|rejected|malformed|missing required/.test(message)) return "validation";
  if (/intervention|captcha|mfa|manual|blocked/.test(message)) return "blocked";
  return "unknown";
}

export type DependencyReadiness = {
  ready: boolean;
  missing: string[];
  incomplete: Array<{ id: string; status: string }>;
  failed: Array<{ id: string; status: string }>;
  reason: string | null;
};

/**
 * Dependencies are explicit task ids. A dependent task may start only after
 * every prerequisite has completed successfully. A missing, failed, blocked or
 * still-running prerequisite keeps the dependent task blocked.
 */
export function dependencyReadiness(ids: string[]): DependencyReadiness {
  if (ids.length === 0) {
    return { ready: true, missing: [], incomplete: [], failed: [], reason: null };
  }
  const rows = all<{ id: string; status: string }>(
    `SELECT id, status FROM tasks WHERE id IN (${ids.map(() => "?").join(",")})`,
    ids,
  );
  const byId = new Map(rows.map((row) => [row.id, row.status]));
  const missing = ids.filter((id) => !byId.has(id));
  const failed = ids
    .filter((id) => ["failed", "blocked", "cancelled"].includes(byId.get(id) ?? ""))
    .map((id) => ({ id, status: byId.get(id) ?? "missing" }));
  const incomplete = ids
    .filter((id) => {
      const status = byId.get(id);
      return status !== undefined && status !== "completed" && !["failed", "blocked", "cancelled"].includes(status);
    })
    .map((id) => ({ id, status: byId.get(id) ?? "unknown" }));
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing prerequisite task(s): ${missing.join(", ")}`);
  if (failed.length > 0) parts.push(`failed prerequisite task(s): ${failed.map((item) => `${item.id} (${item.status})`).join(", ")}`);
  if (incomplete.length > 0) parts.push(`prerequisite task(s) not complete: ${incomplete.map((item) => `${item.id} (${item.status})`).join(", ")}`);
  return {
    ready: parts.length === 0,
    missing,
    incomplete,
    failed,
    reason: parts.length > 0 ? `Task is blocked because ${parts.join("; ")}.` : null,
  };
}
