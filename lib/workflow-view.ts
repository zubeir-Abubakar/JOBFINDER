import { all, one } from "./db";

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
  created_at: string;
  finished_at: string | null;
};

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
};

function latestApproval(): FlowApproval {
  return one<NonNullable<FlowApproval>>(
    `SELECT a.id, a.status, a.approved_at, a.job_id, j.title, j.company, j.match_score
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status = 'awaiting_approval'
     ORDER BY a.last_update DESC LIMIT 1`,
  );
}

export function workflowSnapshot(workflowId: string): WorkflowSnapshot {
  const workflow = one<FlowWorkflow>(
    "SELECT id, kind, label, status, summary, error, created_at, finished_at FROM workflows WHERE id = ?",
    [workflowId],
  );
  if (!workflow) return { workflow: null, tasks: [], approval: null, active: false };
  const tasks = all<FlowTask>(
    `SELECT id, agent_key, title, detail, status, output, error, provider, model, execution_mode, ai_outcome, created_at, started_at, finished_at
     FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC`,
    [workflowId],
  );
  return {
    workflow,
    tasks,
    approval: workflow.status === "completed" ? latestApproval() : null,
    active: workflow.status === "running" || workflow.status === "queued",
  };
}

export function latestWorkflowSnapshot(): WorkflowSnapshot {
  const latest = one<{ id: string }>("SELECT id FROM workflows ORDER BY created_at DESC LIMIT 1");
  if (!latest) {
    return { workflow: null, tasks: [], approval: latestApproval(), active: false };
  }
  return workflowSnapshot(latest.id);
}
