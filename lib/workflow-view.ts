import { all, one } from "./db";
import { executionManifestForWorkflow, type ExecutionManifest } from "./execution-manifest";

export type FlowTask = {
  id: string;
  agent_key: string;
  title: string;
  detail: string | null;
  status: string;
  output: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  execution_mode: string | null;
  ai_outcome: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type FlowWorkflow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  summary: string | null;
  error: string | null;
  started_by: string | null;
  created_at: string;
  finished_at: string | null;
};

export type WorkflowActor = { id: string; role: string };

/**
 * New workflows are scoped to their creator. A null owner is a legacy/system
 * workflow and remains readable only by an administrator, or by the sole owner
 * of a single-owner deployment. This preserves existing installations without
 * exposing legacy work to a second owner account.
 */
export function workflowAccessibleTo(actor: WorkflowActor, workflow: Pick<FlowWorkflow, "started_by">): boolean {
  if (actor.role === "admin") return true;
  if (workflow.started_by === actor.id) return true;
  if (workflow.started_by !== null) return false;
  const owners = all<{ id: string }>("SELECT id FROM users WHERE role = 'owner' AND status = 'active'");
  return owners.length === 1 && owners[0].id === actor.id;
}

export type FlowApproval = {
  id: string;
  status: string;
  approved_at: string | null;
  job_id: string;
  title: string;
  company: string;
  match_score: number | null;
} | null;

export type WorkflowSnapshot = {
  workflow: FlowWorkflow | null;
  tasks: FlowTask[];
  approval: FlowApproval;
  active: boolean;
  execution: ExecutionManifest | null;
};

function latestApproval(workflowId: string): FlowApproval {
  return one<NonNullable<FlowApproval>>(
    `SELECT a.id, a.status, a.approved_at, a.job_id, j.title, j.company, j.match_score
     FROM applications a
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN recruitment_runs r ON r.id = COALESCE(NULLIF(a.run_id, ''), NULLIF(j.run_id, ''))
     WHERE a.status = 'awaiting_approval' AND r.workflow_id = ?
     ORDER BY a.last_update DESC LIMIT 1`,
    [workflowId],
  );
}

export function workflowSnapshot(workflowId: string): WorkflowSnapshot {
  const workflow = one<FlowWorkflow>(
    "SELECT id, kind, label, status, summary, error, started_by, created_at, finished_at FROM workflows WHERE id = ?",
    [workflowId],
  );
  if (!workflow) return { workflow: null, tasks: [], approval: null, active: false, execution: null };
  const tasks = all<FlowTask>(
    `SELECT id, agent_key, title, detail, status, output, error, provider, model, execution_mode, ai_outcome, created_at, started_at, finished_at
     FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`,
    [workflowId],
  );
  return {
    workflow,
    tasks,
    approval: workflow.status === "completed" ? latestApproval(workflowId) : null,
    active: workflow.status === "running" || workflow.status === "queued",
    execution: executionManifestForWorkflow(workflowId),
  };
}

export function latestWorkflowSnapshot(): WorkflowSnapshot {
  const latest = one<{ id: string }>("SELECT id FROM workflows ORDER BY created_at DESC LIMIT 1");
  if (!latest) {
    return { workflow: null, tasks: [], approval: null, active: false, execution: null };
  }
  return workflowSnapshot(latest.id);
}

export function workflowSnapshotForUser(actor: WorkflowActor, workflowId: string): WorkflowSnapshot | null {
  const snapshot = workflowSnapshot(workflowId);
  if (!snapshot.workflow || !workflowAccessibleTo(actor, snapshot.workflow)) return null;
  return snapshot;
}

export function latestWorkflowSnapshotForUser(actor: WorkflowActor): WorkflowSnapshot {
  const rows = all<{ id: string }>("SELECT id FROM workflows ORDER BY created_at DESC LIMIT 100");
  for (const row of rows) {
    const snapshot = workflowSnapshotForUser(actor, row.id);
    if (snapshot?.workflow) return snapshot;
  }
  return { workflow: null, tasks: [], approval: null, active: false, execution: null };
}

export function latestWorkflowForUser(actor: WorkflowActor): FlowWorkflow | null {
  return latestWorkflowSnapshotForUser(actor).workflow;
}
