import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Empty, Flash } from "@/components/ui";
import { formatDateTime, relativeTime, param } from "@/lib/format";
import {
  pauseAllAction,
  resumeAllAction,
  runDiscoveryAction,
  analyseBacklogAction,
  startWorkflowAction,
  pauseWorkflowAction,
  stopWorkflowAction,
  resumeWorkflowAction,
  retryWorkflowAction,
} from "@/lib/actions/agents";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { AgentAvatar, AgentStatusBadge } from "@/components/AgentAvatar";
import { WorkflowFlow } from "@/components/WorkflowFlow";
import { activeWorkflow, latestPausedWorkflow, recoverInterruptedRuns } from "@/lib/workflow";
import { statusMeta, taskExecutionMeta } from "@/lib/agent-status";
import { agentIdentity } from "@/lib/agent-identity";
import { agentAvailability, effectiveAgentStatus } from "@/lib/agent-availability";
import { providerHealth } from "@/lib/providers";

export const dynamic = "force-dynamic";

type AgentRow = {
  key: string;
  name: string;
  role: string;
  description: string;
  enabled: number;
  status: string;
  current_task: string | null;
  last_run_at: string | null;
  run_count: number;
  success_count: number;
  failure_count: number;
  ai_success_count?: number;
  ai_failure_count?: number;
};
type TaskRow = {
  id: string;
  workflow_id: string | null;
  agent_key: string;
  title: string;
  status: string;
  output: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  created_at: string;
  finished_at: string | null;
  execution_mode: string | null;
  ai_outcome: string | null;
};
type WorkflowRow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  recoverInterruptedRuns();
  const sp = await searchParams;
  const focus = param(sp.agent);
  const agents = all<AgentRow>("SELECT * FROM agents ORDER BY sort");
  const tasks = all<TaskRow>(
    "SELECT id, workflow_id, agent_key, title, status, output, error, provider, model, created_at, finished_at, execution_mode, ai_outcome FROM tasks ORDER BY created_at DESC LIMIT 80",
  );
  const workflows = all<WorkflowRow>(
    "SELECT id, kind, label, status, summary, error, created_at, finished_at FROM workflows ORDER BY created_at DESC LIMIT 10",
  );
  const latestByAgent = new Map<string, TaskRow>();
  for (const task of tasks) if (!latestByAgent.has(task.agent_key)) latestByAgent.set(task.agent_key, task);
  const active = activeWorkflow();
  const paused = latestPausedWorkflow();
  const health = await providerHealth();
  const gateway = health.find((item) => item.name === "freellmapi");
  const ollama = health.find((item) => item.name === "ollama");
  const pending = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NULL")?.c ?? 0;
  const filteredTasks = focus ? tasks.filter((task) => task.agent_key === focus) : tasks.slice(0, 30);
  const focusedAgent = focus ? agents.find((agent) => agent.key === focus) : null;
  const anyActive = Boolean(active) || agents.some((agent) => statusMeta(agent.status).active);
  const tasksByWorkflow = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (!task.workflow_id) continue;
    const list = tasksByWorkflow.get(task.workflow_id) ?? [];
    list.push(task);
    tasksByWorkflow.set(task.workflow_id, list);
  }

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <WorkflowFlow autoFocus={Boolean(param(sp.ok) || param(sp.error))} />
      <PageHead
        title="AI agents"
        sub="One coordinator, seven specialists. Execution is sequential and runs in the background, so the dashboard stays responsive."
        actions={
          <>
            <form action={startWorkflowAction}>
              <input type="hidden" name="pages" value="2" />
              <SubmitButton className="btn btn-primary" pendingLabel="Queuing…">
                <Icon name="agents" /> Start all agents
              </SubmitButton>
            </form>
            {active ? (
              <>
                <form action={pauseWorkflowAction}><SubmitButton className="btn">Pause workflow</SubmitButton></form>
                <form action={stopWorkflowAction}><SubmitButton className="btn btn-danger" confirm="Stop the running workflow at the next checkpoint?">Stop</SubmitButton></form>
              </>
            ) : paused ? (
              <form action={resumeWorkflowAction}><SubmitButton className="btn btn-primary" pendingLabel="Resuming…">Resume workflow</SubmitButton></form>
            ) : null}
            <form action={pauseAllAction}><SubmitButton className="btn">Pause agents</SubmitButton></form>
            <form action={resumeAllAction}><SubmitButton className="btn">Resume agents</SubmitButton></form>
          </>
        }
      />

      <div className="alert alert-info mb-4">
        {active ? (
          <>Workflow running: <strong>{active.label}</strong>. The page refreshes automatically while agents work.</>
        ) : paused ? (
          <>Workflow paused: <strong>{paused.label}</strong>. Resume to continue, or review the task log below.</>
        ) : (
          <>All agents are idle. “Start all agents” runs research → analysis → CV → ATS → cover letter → application preparation → inbox tracking.</>
        )}{" "}
        {pending > 0 ? `${pending} vacancy(ies) still need analysis. ` : ""}
        {gateway?.available
          ? `AI gateway: FreeLLMAPI connected (${gateway.model}).`
          : ollama?.available
            ? `AI gateway: FreeLLMAPI unavailable; Ollama fallback connected (${ollama.model}).`
            : gateway?.configured
              ? `AI gateway: FreeLLMAPI configured but unreachable — ${gateway.detail}`
              : "AI gateway: FreeLLMAPI is not configured."}{" "}
        Ollama fallback: {ollama?.enabled ? (ollama.available ? "ready" : ollama.detail) : "disabled"}. Spending limit CHF 0.
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Agent roster</h2>
            <p className="card-sub">Status, current assignment and the provider/model used for the latest execution.</p>
          </div>
          <form action={analyseBacklogAction}>
            <SubmitButton className="btn btn-sm" pendingLabel="Analysing…">Analyse backlog</SubmitButton>
          </form>
        </div>
        <div className="card-body grid g2">
          {agents.map((agent) => {
            const latest = latestByAgent.get(agent.key);
            const availability = agentAvailability(agent.key);
            const displayStatus = effectiveAgentStatus(agent.status, agent.enabled === 1, availability);
            return (
              <div key={agent.key} className="agent-card agent-card-rich">
                <div className="between" style={{ alignItems: "flex-start" }}>
                  <div className="flex items-center gap-2.5">
                    <AgentAvatar agentKey={agent.key} status={displayStatus} />
                    <div>
                      <div className="name">{agent.name}</div>
                      <div className="text-[10.5px] uppercase tracking-[0.08em]" style={{ color: "var(--muted)" }}>{agent.role}</div>
                    </div>
                  </div>
                  <AgentStatusBadge status={displayStatus} enabled={agent.enabled === 1} />
                </div>
                <p className="desc">{agent.description}</p>
                {!availability.available ? (
                  <div className="alert alert-error" style={{ padding: "7px 9px", fontSize: 11 }}>
                    <strong>{availability.dependency} unavailable.</strong> {availability.reason}
                  </div>
                ) : null}
                <div className="agent-meta">
                  <span>Current</span>
                  <strong>{agent.current_task ?? "Idle — no task assigned"}</strong>
                  <span>Provider</span>
                  <strong>{latest?.provider ?? "—"}</strong>
                  <span>Model</span>
                  <strong title={latest?.model ?? undefined}>{latest?.model ?? "—"}</strong>
                  <span>Last run</span>
                  <strong>{relativeTime(agent.last_run_at)}</strong>
                </div>
                <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--muted)" }}>
                  <span className="num">
                    {agent.run_count} tasks · {agent.success_count} ok · {agent.failure_count} failed · AI calls {agent.ai_success_count ?? 0} ok
                    {agent.ai_failure_count ? ` / ${agent.ai_failure_count} failed` : ""}
                  </span>
                  <Link href={`/agents?agent=${agent.key}#activity`} className="btn btn-sm">Activity</Link>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="split">
        <section className="card" id="activity">
          <div className="card-head">
            <div>
              <h2>Task activity</h2>
              <p className="card-sub">
                {focusedAgent ? `Filtered to ${focusedAgent.name}.` : "Latest 30 executions across all eight agents."}
              </p>
            </div>
            {focus ? <Link href="/agents#activity" className="btn btn-sm">Clear filter</Link> : null}
          </div>
          <div className="table-wrap">
            {filteredTasks.length === 0 ? (
              <Empty title="No tasks yet">Start all agents and every step will be recorded with its provider and result.</Empty>
            ) : (
              <table className="data">
                <thead>
                  <tr><th>Task</th><th>Agent</th><th>Status</th><th>Execution</th><th>Result</th><th>When</th></tr>
                </thead>
                <tbody>
                  {filteredTasks.map((task) => (
                    <tr key={task.id}>
                      <td style={{ minWidth: 190 }}>
                        <div className="cell-title">{task.title}</div>
                        <div className="cell-sub">{task.provider ? `${task.provider} · ${task.model}` : task.id}</div>
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <AgentAvatar agentKey={task.agent_key} status={task.status === "running" ? "working" : task.status} size={26} />
                          <span className="cell-sub">{agentIdentity(task.agent_key).shortName}</span>
                        </div>
                      </td>
                      <td><span className={`badge ${task.status === "completed" ? "badge-good" : task.status === "failed" ? "badge-bad" : task.status === "running" || task.status === "working" ? "badge-info" : "badge-neutral"}`}>{task.status}</span></td>
                      <td>
                        <span className={`badge ${taskExecutionMeta(task).tone}`} title={taskExecutionMeta(task).detail}>
                          {taskExecutionMeta(task).label}
                        </span>
                      </td>
                      <td className="cell-sub" style={{ maxWidth: 300 }}>{task.error ?? task.output ?? "—"}</td>
                      <td className="cell-sub">{formatDateTime(task.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Workflow history</h2>
              <p className="card-sub">Persistent runs. Failed or paused runs can be retried.</p>
            </div>
          </div>
          <div className="card-body">
            {workflows.length === 0 ? (
              <Empty title="No workflows have run" />
            ) : (
              <div className="feed">
                {workflows.map((workflow) => {
                  const steps = tasksByWorkflow.get(workflow.id) ?? [];
                  return (
                    <div key={workflow.id} className="feed-item">
                      <span className="feed-dot"><Icon name="agents" size={11} /></span>
                      <div className="min-w-0 w-full">
                        <div className="feed-text">{workflow.label}</div>
                        <div className="feed-time">
                          {workflow.status} · {workflow.summary ?? workflow.error ?? "no summary yet"} ·{" "}
                          {formatDateTime(workflow.finished_at ?? workflow.created_at)}
                        </div>
                        {steps.length > 0 ? (
                          <div className="workflow-steps">
                            {steps.slice(-8).map((step) => (
                              <div key={step.id} className="workflow-step">
                                <AgentAvatar agentKey={step.agent_key} status={step.status === "running" ? "working" : step.status} size={23} />
                                <span className="truncate">{agentIdentity(step.agent_key).shortName}: {step.title}</span>
                                <span className="ml-auto badge badge-neutral">{step.status}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        {(workflow.status === "failed" || workflow.status === "paused") && workflow.kind === "recruitment" ? (
                          <form action={retryWorkflowAction} className="mt-1">
                            <input type="hidden" name="workflow_id" value={workflow.id} />
                            <SubmitButton className="btn btn-sm" pendingLabel="Retrying…">Retry failed task</SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="card-quiet p-3 mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Execution log is written to SQLite. A restart marks interrupted steps as failed and pauses the run; resume from this page. Running workflows stop at the next checkpoint when paused or stopped.
            </div>
            <form action={runDiscoveryAction} className="mt-3">
              <input type="hidden" name="pages" value="1" />
              <SubmitButton className="btn btn-sm" pendingLabel="Researching…">Quick discovery only</SubmitButton>
            </form>
          </div>
        </section>
      </div>
    </>
  );
}

