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
  pauseWorkflowAction,
  stopWorkflowAction,
  resumeWorkflowAction,
  retryWorkflowAction,
} from "@/lib/actions/agents";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { AgentAvailabilityBadge, AgentAvatar, AgentTaskBadge } from "@/components/AgentAvatar";
import { WorkflowFlow } from "@/components/WorkflowFlow";
import { activeWorkflow, latestPausedWorkflow, recoverInterruptedRuns } from "@/lib/workflow";
import { taskExecutionMeta } from "@/lib/agent-status";
import { AGENT_IDENTITY_KEYS, agentIdentity, agentNameList } from "@/lib/agent-identity";
import { agentPresentation } from "@/lib/agent-presentation";
import { getOperationalSnapshot } from "@/lib/operations";
import { switchAgentAction } from "@/lib/actions/chat";
import { startAutonomousRecruitmentAction } from "@/lib/actions/recruitment";

export const dynamic = "force-dynamic";
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
  const user = await requireUser();
  recoverInterruptedRuns();
  const sp = await searchParams;
  const focus = param(sp.agent);
  const snapshot = await getOperationalSnapshot();
  const agents = snapshot.agents;
  const workflowScope =
    user.role === "admin"
      ? ""
      : "WHERE (w.started_by = ? OR (w.started_by IS NULL AND (SELECT COUNT(*) FROM users WHERE role = 'owner' AND status = 'active') = 1) OR t.workflow_id IS NULL)";
  const scopeParams = user.role === "admin" ? [] : [user.id];
  const tasks = all<TaskRow>(
    `SELECT t.id, t.workflow_id, t.agent_key, t.title, t.status, t.output, t.error, t.provider, t.model, t.created_at, t.finished_at, t.execution_mode, t.ai_outcome
     FROM tasks t LEFT JOIN workflows w ON w.id = t.workflow_id ${workflowScope} ORDER BY t.created_at DESC LIMIT 80`,
    scopeParams,
  );
  const workflows = all<WorkflowRow>(
    `SELECT w.id, w.kind, w.label, w.status, w.summary, w.error, w.created_at, w.finished_at
     FROM workflows w ${workflowScope.replace(" OR t.workflow_id IS NULL", "")} ORDER BY w.created_at DESC LIMIT 10`,
    scopeParams,
  );
  const active = activeWorkflow(user);
  const paused = latestPausedWorkflow(user);
  const gateway = snapshot.providers.find((item) => item.name === "freellmapi");
  const ollama = snapshot.providers.find((item) => item.name === "ollama");
  const pending = one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NULL")?.c ?? 0;
  const filteredTasks = focus ? tasks.filter((task) => task.agent_key === focus) : tasks.slice(0, 30);
  const focusedAgent = focus ? agents.find((agent) => agent.key === focus) : null;
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
        sub={`${agentIdentity("coordinator").name} coordinates ${agentNameList(AGENT_IDENTITY_KEYS.filter((key) => key !== "coordinator"))}. Execution is sequential and runs in the background, so the dashboard stays responsive.`}
        actions={
          <>
            <form action={startAutonomousRecruitmentAction}>
              <input type="hidden" name="return_to" value="/agents" />
              <SubmitButton className="btn btn-primary" pendingLabel="Starting autonomous run…">
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
        Ollama fallback: {ollama?.configured ? (ollama.available ? "ready" : ollama.detail) : "disabled"}. Spending limit CHF 0.
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Agent roster</h2>
            <p className="card-sub">Availability, current task and last outcome are separate. Configured is the shared text route; Actual is the provider/model that served the latest inference.</p>
          </div>
          <form action={analyseBacklogAction}>
            <SubmitButton className="btn btn-sm" pendingLabel="Analysing…">Analyse backlog</SubmitButton>
          </form>
        </div>
        <div className="card-body grid g2">
          {agents.map((agent) => {
            const presentation = agentPresentation({
              enabled: agent.enabled,
              status: agent.status,
              currentTask: agent.currentTask,
              availability: agent.availability,
              lastTask: agent.lastTaskOutcome && agent.lastTaskTitle
                ? { status: agent.lastTaskOutcome, title: agent.lastTaskTitle, at: agent.lastTaskAt }
                : null,
            });
            const avatarStatus = presentation.task.state === "idle"
              ? agent.availability.available ? "idle" : "unavailable"
              : agent.status;
            const actualProvider = agent.provider
              ? `${agent.provider} / ${agent.model ?? "model not recorded"}`
              : "Not used yet";
            const configuredProvider = agent.configuredProvider
              ? `${agent.configuredProvider} / ${agent.configuredModel ?? "model not configured"}`
              : "Not configured";
            const upstream = agent.lastRoutedPlatform || agent.lastRoutedModel
              ? `${agent.lastRoutedPlatform ?? "upstream"} / ${agent.lastRoutedModel ?? "model not reported"}`
              : "Not reported";
            const fallbackHistory = agent.fallbackHistory.length
              ? agent.fallbackHistory.map((entry) => `${entry.model} · ${relativeTime(entry.at)}`).join("; ")
              : "None today";
            return (
              <div key={agent.key} className="agent-card agent-card-rich">
                <div className="between" style={{ alignItems: "flex-start", gap: 10 }}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <AgentAvatar agentKey={agent.key} status={avatarStatus} />
                    <div className="min-w-0">
                      <div className="name">{agent.name}</div>
                      <div className="text-[10.5px] uppercase tracking-[0.08em]" style={{ color: "var(--muted)" }}>{agent.role}</div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <AgentAvailabilityBadge
                      state={presentation.availability.state}
                      label={presentation.availability.label}
                      detail={presentation.availability.detail}
                    />
                    <AgentTaskBadge
                      state={presentation.task.state}
                      label={presentation.task.label}
                      detail={presentation.task.detail}
                    />
                  </div>
                </div>
                <p className="desc">{agent.description}</p>
                {presentation.availability.state === "unavailable" || presentation.availability.state === "degraded" ? (
                  <div className={`alert ${presentation.availability.state === "degraded" ? "alert-info" : "alert-error"}`} style={{ padding: "7px 9px", fontSize: 11 }}>
                    <strong>{presentation.availability.label}.</strong> {presentation.availability.detail}
                  </div>
                ) : null}
                <div className="agent-current">
                  <span className="agent-current-label">Current task</span>
                  <strong>{presentation.task.detail}</strong>
                </div>
                <div className="agent-meta agent-meta-rich">
                  <span>Last outcome</span>
                  <strong title={presentation.lastOutcome.detail}>
                    {presentation.lastOutcome.label} · {presentation.lastOutcome.detail}
                    {presentation.lastOutcome.at ? ` · ${relativeTime(presentation.lastOutcome.at)}` : ""}
                  </strong>
                  <span>Configured</span>
                  <strong title={configuredProvider}>{configuredProvider}</strong>
                  <span>Actual</span>
                  <strong title={actualProvider}>{actualProvider}</strong>
                  <span>Upstream</span>
                  <strong title={upstream}>{upstream}</strong>
                  <span>Health</span>
                  <strong>
                    {agent.configuredProviderStatus}
                    {agent.fallbackActive ? " · fallback active" : ""}
                  </strong>
                  <span>Last success</span>
                  <strong>{relativeTime(agent.lastSuccessfulInferenceAt)}</strong>
                  <span>Last activity</span>
                  <strong>{relativeTime(agent.lastActivityAt)}</strong>
                  <span>Provider error</span>
                  <strong title={agent.lastProviderError ?? undefined}>
                    {agent.lastProviderError ? relativeTime(agent.lastProviderErrorAt) : "None recorded"}
                  </strong>
                  <span>Retries today</span>
                  <strong>{agent.retryCount}</strong>
                  <span>Fallback history</span>
                  <strong title={fallbackHistory}>{fallbackHistory}</strong>
                </div>
                {agent.lastProviderError ? (
                  <div className="text-[10.5px] leading-relaxed" style={{ color: "var(--danger)" }}>
                    {agent.lastProviderError}
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: "var(--muted)" }}>
                  <span className="num">
                    {agent.runCount} tasks · {agent.successCount} ok · {agent.failureCount} failed · AI {agent.aiSuccessCount} ok
                    {agent.aiFailureCount ? ` / ${agent.aiFailureCount} failed` : ""} · {agent.retryCount} retry attempt(s) today · {agent.tokenUsageToday.toLocaleString("en-GB")} tokens today
                  </span>
                  <div className="flex items-center gap-1.5">
                    <form action={switchAgentAction}>
                      <input type="hidden" name="agent" value={agent.key} />
                      <SubmitButton className="btn btn-sm" pendingLabel="Connecting…">Talk</SubmitButton>
                    </form>
                    <Link href={`/agents?agent=${agent.key}#activity`} className="btn btn-sm">Activity</Link>
                  </div>
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

