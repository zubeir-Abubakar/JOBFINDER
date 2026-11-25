export type AgentStatus = "idle" | "waiting" | "working" | "thinking" | "completed" | "failed" | "paused" | "unavailable";

const META: Record<AgentStatus, { label: string; className: string; active: boolean }> = {
  idle: { label: "Idle", className: "badge-neutral", active: false },
  waiting: { label: "Waiting", className: "badge-info", active: true },
  working: { label: "Working", className: "badge-info", active: true },
  thinking: { label: "Thinking", className: "badge-info", active: true },
  completed: { label: "Completed", className: "badge-good", active: false },
  failed: { label: "Failed", className: "badge-bad", active: false },
  paused: { label: "Paused", className: "badge-warn", active: false },
  unavailable: { label: "Unavailable", className: "badge-bad", active: false },
};

export function normaliseStatus(status: string): AgentStatus {
  if (status === "running") return "working";
  if (status === "error") return "failed";
  if (status in META) return status as AgentStatus;
  return "idle";
}

export function statusMeta(status: string) {
  return META[normaliseStatus(status)];
}

export function isActiveStatus(status: string): boolean {
  return META[normaliseStatus(status)].active;
}

export const AGENT_STATUSES: AgentStatus[] = ["idle", "waiting", "working", "thinking", "completed", "failed", "paused", "unavailable"];

/* ------------------------- execution integrity ------------------------- */

export type TaskExecution = {
  mode: "ai" | "deterministic" | "historical";
  label: string;
  detail: string;
  tone: string;
  aiBacked: boolean;
  aiFailed: boolean;
  aiBlocked?: boolean;
};

/** Whether a completed task may be counted as a successful AI execution. */
export function countsAsAiSuccess(executionMode?: string | null, aiOutcome?: string | null): boolean {
  return executionMode === "ai" && aiOutcome === "ok";
}

/**
 * Honest description of how a task was executed. Rows written before execution
 * metadata existed stay "historical" — they are never reclassified as AI work.
 */
export function taskExecutionMeta(row: {
  execution_mode?: string | null;
  ai_outcome?: string | null;
  provider?: string | null;
  model?: string | null;
}): TaskExecution {
  if (row.execution_mode === "ai") {
    if (row.ai_outcome === "blocked") {
      return {
        mode: "ai",
        label: "AI blocked — deterministic fallback",
        detail: "The request was blocked before transmission; no model output was used.",
        tone: "badge-warn",
        aiBacked: false,
        aiFailed: false,
        aiBlocked: true,
      };
    }
    if (row.ai_outcome === "failed") {
      return {
        mode: "ai",
        label: "AI failed — deterministic fallback",
        detail: "A model call was attempted and failed; no model output was used.",
        tone: "badge-warn",
        aiBacked: true,
        aiFailed: true,
      };
    }
    return {
      mode: "ai",
      label: `AI · ${row.provider ?? "gateway"}${row.model ? ` / ${row.model}` : ""}`,
      detail: "Model output was used for this task.",
      tone: "badge-info",
      aiBacked: true,
      aiFailed: false,
    };
  }
  if (row.execution_mode === "deterministic") {
    return {
      mode: "deterministic",
      label: "Deterministic — no model",
      detail: "Executed by local rules; no inference was requested.",
      tone: "badge-neutral",
      aiBacked: false,
      aiFailed: false,
    };
  }
  return {
    mode: "historical",
    label: "Historical record",
    detail: "Recorded before execution metadata existed; model use is unknown.",
    tone: "badge-neutral",
    aiBacked: false,
    aiFailed: false,
  };
}
