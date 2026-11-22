import { all, getDb, nowIso } from "./db";

/**
 * Persisted workflow events. The browser never invents progress: every event is
 * written to SQLite first and then pushed to any live SSE subscribers, so a
 * refresh can reconstruct the run from the database.
 */

export type WorkflowEventType =
  | "workflow.started"
  | "workflow.completed"
  | "workflow.paused"
  | "workflow.failed"
  | "workflow.cancelled"
  | "agent.queued"
  | "agent.started"
  | "agent.progress"
  | "agent.completed"
  | "agent.failed"
  | "agent.blocked"
  | "agent.retrying"
  | "approval.required"
  | "approval.granted";

export type WorkflowEvent = {
  id: number;
  workflow_id: string;
  agent_key: string | null;
  type: WorkflowEventType;
  message: string | null;
  meta: string | null;
  created_at: string;
};

type Listener = (event: WorkflowEvent) => void;
type EventGlobal = typeof globalThis & { __atwEventSubs?: Map<string, Set<Listener>> };
const g = globalThis as EventGlobal;

export function emitWorkflowEvent(input: {
  workflowId: string;
  type: WorkflowEventType;
  agentKey?: string | null;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}): WorkflowEvent | null {
  if (!input.workflowId) return null;
  const created_at = nowIso();
  const meta = input.meta ? JSON.stringify(input.meta) : null;
  const result = getDb()
    .prepare("INSERT INTO workflow_events (workflow_id, agent_key, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(input.workflowId, input.agentKey ?? null, input.type, input.message ?? null, meta, created_at);
  const event: WorkflowEvent = {
    id: Number(result.lastInsertRowid),
    workflow_id: input.workflowId,
    agent_key: input.agentKey ?? null,
    type: input.type,
    message: input.message ?? null,
    meta,
    created_at,
  };
  for (const listener of g.__atwEventSubs?.get(input.workflowId) ?? []) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never break the workflow writer.
    }
  }
  return event;
}

export function listWorkflowEvents(workflowId: string, afterId = 0, limit = 500): WorkflowEvent[] {
  return all<WorkflowEvent>(
    "SELECT id, workflow_id, agent_key, type, message, meta, created_at FROM workflow_events WHERE workflow_id = ? AND id > ? ORDER BY id ASC LIMIT ?",
    [workflowId, Math.max(0, afterId), Math.min(1000, Math.max(1, limit))],
  );
}

export function subscribeWorkflowEvents(workflowId: string, listener: Listener): () => void {
  g.__atwEventSubs ??= new Map();
  const set = g.__atwEventSubs.get(workflowId) ?? new Set<Listener>();
  set.add(listener);
  g.__atwEventSubs.set(workflowId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) g.__atwEventSubs?.delete(workflowId);
  };
}
