/**
 * Presentation model for the agent roster.
 *
 * Availability answers "can this agent work right now?".
 * Task state answers "is it doing something, and what?".
 * The last task outcome is history and must never be presented as the current
 * availability or as a permanently completed agent.
 */

export type AgentAvailabilityState = "online" | "offline" | "initialising" | "unavailable" | "degraded";
export type AgentTaskState =
  | "idle"
  | "queued"
  | "running"
  | "thinking"
  | "waiting_tool"
  | "waiting_intervention"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentAvailabilityView = {
  state: AgentAvailabilityState;
  label: string;
  detail: string;
};

export type AgentTaskView = {
  state: AgentTaskState;
  label: string;
  detail: string;
  active: boolean;
};

export type AgentLastOutcome = {
  state: "completed" | "blocked" | "failed" | "cancelled" | "none";
  label: string;
  detail: string;
  at: string | null;
};

export type AgentPresentation = {
  availability: AgentAvailabilityView;
  task: AgentTaskView;
  lastOutcome: AgentLastOutcome;
};

function availabilityView(
  enabled: boolean,
  status: string,
  availability: {
    available: boolean;
    reason: string | null;
    dependency: string | null;
    cause?: "configuration" | "health" | null;
    restricted?: boolean;
    restriction?: "ai_inference" | "email_access" | null;
  },
): AgentAvailabilityView {
  if (!enabled) {
    return { state: "offline", label: "Offline", detail: "Disabled in agent management." };
  }
  if (status === "paused") {
    return { state: "offline", label: "Offline", detail: "Paused by the owner. No task will start." };
  }
  if (status === "initialising") {
    return { state: "initialising", label: "Initialising", detail: "Agent runtime is starting." };
  }
  if (availability.available && availability.restricted) {
    return {
      state: "degraded",
      label: "Operational · AI restricted",
      detail: `${availability.dependency ?? "AI inference"}: ${availability.reason ?? "AI-assisted work is restricted; deterministic work remains available."}`,
    };
  }
  if (!availability.available) {
    const dependency = availability.dependency ?? "Dependency";
    const reason = availability.reason ?? "A required dependency is not available.";
    if (availability.cause === "health") {
      return { state: "degraded", label: "Degraded", detail: `${dependency}: ${reason}` };
    }
    return { state: "unavailable", label: "Unavailable", detail: `${dependency}: ${reason}` };
  }
  return { state: "online", label: "Online", detail: "Dependencies are available." };
}

function taskView(status: string, currentTask: string | null): AgentTaskView {
  if (status === "working" || status === "running") {
    return {
      state: "running",
      label: "Running",
      detail: currentTask ?? "Running an assigned task",
      active: true,
    };
  }
  if (status === "thinking") {
    return {
      state: "thinking",
      label: "Thinking",
      detail: currentTask ? `${currentTask} — waiting for inference` : "Waiting for inference",
      active: true,
    };
  }
  if (status === "waiting") {
    return {
      state: "waiting_tool",
      label: "Waiting for tool",
      detail: currentTask ?? "Waiting for a tool or browser result",
      active: true,
    };
  }
  if (status === "queued" || status === "planned") {
    return {
      state: "queued",
      label: "Queued",
      detail: currentTask ?? "Queued behind the current workflow step",
      active: true,
    };
  }
  if (status === "cancelled") {
    return { state: "cancelled", label: "Cancelled", detail: currentTask ?? "Task cancelled", active: false };
  }
  return { state: "idle", label: "Idle", detail: "Idle — no task assigned", active: false };
}

function lastOutcomeView(lastTask: { status: string; title: string; at: string | null } | null): AgentLastOutcome {
  if (!lastTask) return { state: "none", label: "No task history", detail: "This agent has not run yet.", at: null };
  if (lastTask.status === "completed") {
    return { state: "completed", label: "Completed", detail: lastTask.title, at: lastTask.at };
  }
  if (lastTask.status === "blocked") {
    return { state: "blocked", label: "Blocked — waiting for you", detail: lastTask.title, at: lastTask.at };
  }
  if (lastTask.status === "failed") {
    return { state: "failed", label: "Failed", detail: lastTask.title, at: lastTask.at };
  }
  if (lastTask.status === "cancelled") {
    return { state: "cancelled", label: "Cancelled", detail: lastTask.title, at: lastTask.at };
  }
  return { state: "none", label: "No completed task", detail: lastTask.title, at: lastTask.at };
}

export function agentPresentation(input: {
  enabled: boolean;
  status: string;
  currentTask: string | null;
  availability: {
    available: boolean;
    reason: string | null;
    dependency: string | null;
    cause?: "configuration" | "health" | null;
    restricted?: boolean;
    restriction?: "ai_inference" | "email_access" | null;
  };
  lastTask?: { status: string; title: string; at: string | null } | null;
}): AgentPresentation {
  return {
    availability: availabilityView(input.enabled, input.status, input.availability),
    task: taskView(input.status, input.currentTask),
    lastOutcome: lastOutcomeView(input.lastTask ?? null),
  };
}
