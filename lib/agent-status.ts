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
