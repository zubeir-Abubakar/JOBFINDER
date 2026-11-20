"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AgentAvatar } from "./AgentAvatar";
import { agentIdentity } from "@/lib/agent-identity";
import { WORKFLOW_STAGES as STAGES, type WorkflowStage } from "@/lib/workflow-stages";
import { formatDateTime } from "@/lib/format";
import { Icon } from "./icons";
import type { ExecutionAgent, ExecutionManifest } from "@/lib/execution-manifest";

type FlowTask = {
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
type FlowWorkflow = {
  id: string;
  kind: string;
  label: string;
  status: string;
  summary: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};
type FlowApproval = { id: string; title: string; company: string; match_score: number | null } | null;
type Snapshot = { workflow: FlowWorkflow | null; tasks: FlowTask[]; approval: FlowApproval; active: boolean; execution: ExecutionManifest | null };
type FlowEvent = { id: number; type: string; agent_key: string | null; message: string | null; created_at: string };
type FlowStatus =
  | "pending"
  | "queued"
  | "working"
  | "completed"
  | "completed_zero"
  | "failed"
  | "degraded"
  | "skipped"
  | "not_executed"
  | "paused"
  | "waiting_approval"
  | "cancelled";

const EVENT_TYPES = [
  "workflow.started",
  "workflow.completed",
  "workflow.paused",
  "workflow.failed",
  "workflow.cancelled",
  "agent.queued",
  "agent.started",
  "agent.progress",
  "agent.completed",
  "agent.failed",
  "agent.retrying",
  "approval.required",
  "approval.granted",
];

function duration(task: FlowTask): string {
  if (!task.started_at) return "—";
  const end = task.finished_at ? new Date(task.finished_at).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(task.started_at).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function statusLabel(status: FlowStatus): string {
  const labels: Record<FlowStatus, string> = {
    pending: "Pending",
    queued: "Queued",
    working: "Running",
    completed: "Completed",
    completed_zero: "Completed · zero results",
    failed: "Failed",
    degraded: "Degraded",
    skipped: "Skipped",
    not_executed: "Not executed",
    paused: "Paused",
    waiting_approval: "Waiting for approval",
    cancelled: "Cancelled",
  };
  return labels[status];
}

function stageTone(status: FlowStatus): string {
  if (status === "working") return "badge-info";
  if (status === "completed" || status === "completed_zero") return "badge-good";
  if (status === "failed") return "badge-bad";
  if (status === "paused" || status === "waiting_approval" || status === "degraded") return "badge-warn";
  return "badge-neutral";
}

function executionStatus(agent: ExecutionAgent | undefined): FlowStatus {
  if (!agent) return "not_executed";
  if (agent.state === "RUNNING") return "working";
  if (agent.state === "COMPLETED") return "completed";
  if (agent.state === "COMPLETED_WITH_ZERO_RESULTS") return "completed_zero";
  if (agent.state === "FAILED") return "failed";
  if (agent.state === "DEGRADED") return "degraded";
  if (agent.state === "SKIPPED") return "skipped";
  if (agent.state === "BLOCKED" || agent.state === "DISABLED") return "paused";
  return "not_executed";
}

export function WorkflowFlow({ autoFocus = false }: { autoFocus?: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [events, setEvents] = useState<FlowEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const seen = useRef<Set<number>>(new Set());
  const sourceRef = useRef<EventSource | null>(null);
  const sectionRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/workflows/latest", { cache: "no-store" }).catch(() => null);
    if (!response?.ok) return;
    const data = (await response.json()) as Snapshot;
    setSnapshot(data);
    return data;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoFocus) return;
    const timer = window.setTimeout(() => {
      const node = sectionRef.current;
      if (!node) return;
      node.scrollIntoView({ behavior: "smooth", block: "start" });
      node.focus({ preventScroll: true });
    }, 420);
    return () => window.clearTimeout(timer);
  }, [autoFocus]);

  useEffect(() => {
    const workflowId = snapshot?.workflow?.id;
    if (!workflowId) return;
    sourceRef.current?.close();
    seen.current = new Set();
    const source = new EventSource(`/api/workflows/${workflowId}/events`);
    sourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const handler = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as FlowEvent;
        if (seen.current.has(event.id)) return;
        seen.current.add(event.id);
        setEvents((prev) => [...prev.slice(-14), event]);
        if (/^(agent\.(completed|failed)|workflow\.(completed|paused|failed|cancelled)|approval\.)/.test(event.type)) {
          void refresh();
        }
      } catch {
        // Ignore malformed frames.
      }
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
    return () => {
      source.close();
      sourceRef.current = null;
      setConnected(false);
    };
  }, [snapshot?.workflow?.id, refresh]);

  const control = useCallback(
    async (action: string) => {
      if (!snapshot?.workflow) return;
      setBusy(action);
      setMessage("");
      try {
        const response = await fetch(`/api/workflows/${snapshot.workflow.id}/control`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const payload = (await response.json().catch(() => ({}))) as { message?: string; error?: string; workflowId?: string };
        setMessage(payload.message ?? payload.error ?? "Request recorded.");
        await refresh();
      } finally {
        setBusy("");
      }
    },
    [snapshot?.workflow, refresh],
  );

  if (!snapshot) {
    return (
      <section className="card mb-4 flow-card" id="live-agents" ref={sectionRef as React.RefObject<HTMLElement>} tabIndex={-1}>
        <div className="card-head">
          <div>
            <h2>Live AI agents working</h2>
            <p className="card-sub">Waiting for the workflow snapshot…</p>
          </div>
          <span className="badge badge-neutral">Connecting</span>
        </div>
      </section>
    );
  }

  if (!snapshot.workflow) {
    return (
      <section className="card mb-4 flow-card" id="live-agents" ref={sectionRef as React.RefObject<HTMLElement>} tabIndex={-1}>
        <div className="card-head">
          <div>
            <h2>Live AI agents working</h2>
            <p className="card-sub">No workflow has run yet. Start a job search to watch the eight-agent pipeline execute with real task records.</p>
          </div>
          <span className="badge badge-neutral">Idle</span>
        </div>
        <div className="card-body">
          <div className="flow-idle">
            <span className="flow-idle-icon"><Icon name="agents" size={20} /></span>
            <div>
              <strong>The pipeline is ready.</strong>
              <p>Nothing is simulated. Each node illuminates only when a real agent task starts, and every connector reflects live progress.</p>
            </div>
          </div>
        </div>
      </section>
    );
  }

  const workflow = snapshot.workflow;
  const latestByAgent = new Map<string, FlowTask>();
  for (const task of snapshot.tasks) latestByAgent.set(task.agent_key, task);
  const manifestByAgent = new Map<string, ExecutionAgent>();
  for (const agent of snapshot.execution?.agents ?? []) manifestByAgent.set(agent.key, agent);

  const statusFor = (agentKey: string): FlowStatus => {
    const execution = manifestByAgent.get(agentKey);
    if (execution) return executionStatus(execution);
    const task = latestByAgent.get(agentKey);
    if (workflow.status === "stopped" || workflow.status === "cancelled") {
      return task?.status === "completed" || task?.status === "failed" ? (task.status as FlowStatus) : "cancelled";
    }
    if (!task) {
      return workflow.status === "completed" ? "not_executed" : workflow.status === "paused" ? "paused" : "pending";
    }
    if (task.status === "running" || task.status === "working") return workflow.status === "paused" ? "paused" : "working";
    if (task.status === "completed" || task.status === "failed") return task.status as FlowStatus;
    if (task.status === "planned") return workflow.status === "paused" ? "paused" : "queued";
    return "pending";
  };

  const approvalStatus: FlowStatus = snapshot.approval ? "waiting_approval" : workflow.status === "completed" ? "completed" : "pending";
  const isComplete = workflow.status === "completed";
  const isPaused = workflow.status === "paused";
  const isRunning = workflow.status === "running" || workflow.status === "queued";

  const stageStatus = (stage: WorkflowStage): FlowStatus => {
    if (stage.approvalGate && snapshot.approval) return "waiting_approval";
    const statuses = stage.agents.map(statusFor);
    if (statuses.some((status) => status === "working")) return "working";
    if (statuses.some((status) => status === "failed")) return "failed";
    if (statuses.some((status) => status === "degraded")) return "degraded";
    if (statuses.length > 0 && statuses.every((status) => status === "completed" || status === "completed_zero")) {
      return statuses.some((status) => status === "completed_zero") ? "completed_zero" : "completed";
    }
    if (isPaused) return "paused";
    if (statuses.some((status) => status === "queued")) return "queued";
    if (statuses.some((status) => status === "completed" || status === "completed_zero")) return "degraded";
    if (statuses.length > 0 && statuses.every((status) => status === "skipped")) return "skipped";
    if (statuses.some((status) => status === "skipped")) return "skipped";
    if (statuses.some((status) => status === "not_executed")) return "not_executed";
    return "pending";
  };

  return (
    <section className="card mb-4 flow-card" id="live-agents" ref={sectionRef as unknown as React.RefObject<HTMLElement>} tabIndex={-1}>
      <div className="card-head flow-card-head">
        <div className="min-w-0">
          <div className="flow-kicker">
            <span className={`flow-live ${connected && isRunning ? "live" : ""}`} aria-hidden />
            {isRunning ? "Live execution" : "Latest execution"}
          </div>
          <h2 className="flex items-center gap-2">Live AI agents working</h2>
          <p className="card-sub truncate">
            {workflow.label} · started {formatDateTime(workflow.created_at)}
            {workflow.finished_at ? ` · finished ${formatDateTime(workflow.finished_at)}` : ""}
          </p>
          {snapshot.execution ? (
            <p className="card-sub" style={{ marginTop: 5 }}>
              Execution <span className="num">{snapshot.execution.executionId}</span> · {snapshot.execution.succeededAgents}/{snapshot.execution.expectedAgents} succeeded ·{" "}
              {snapshot.execution.dispatchedAgents} dispatched · {snapshot.execution.skippedAgents} skipped · {snapshot.execution.notExecutedAgents} not executed ·{" "}
              {snapshot.execution.counts.newJobs} new of {snapshot.execution.counts.postingsScreened} screened
            </p>
          ) : null}
        </div>
        <div className="flow-controls">
          <span className={`badge ${isComplete ? "badge-good" : isPaused ? "badge-warn" : workflow.status === "failed" ? "badge-bad" : isRunning ? "badge-info" : "badge-neutral"}`}>
            {workflow.status}
          </span>
          {isRunning ? (
            <>
              <button type="button" className="btn btn-sm" disabled={busy !== ""} onClick={() => void control("pause")}>
                {busy === "pause" ? "Pausing…" : "Pause"}
              </button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy !== ""} onClick={() => void control("stop")}>
                {busy === "stop" ? "Stopping…" : "Cancel"}
              </button>
            </>
          ) : isPaused ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={busy !== ""} onClick={() => void control("resume")}>
              {busy === "resume" ? "Resuming…" : "Resume"}
            </button>
          ) : workflow.status === "failed" ? (
            <button type="button" className="btn btn-sm" disabled={busy !== ""} onClick={() => void control("retry")}>
              {busy === "retry" ? "Retrying…" : "Retry safely"}
            </button>
          ) : null}
        </div>
      </div>

      {message ? <div className="alert alert-info flow-message">{message}</div> : null}

      <div className="card-body">
        <div className="flow-stage-track" role="list" aria-label="Agent execution stages">
          {STAGES.map((stage, index) => {
            const status = stageStatus(stage);
            const isReview = Boolean(stage.approvalGate);
            return (
              <div className="flow-stage-item" role="listitem" key={stage.key}>
                {index > 0 ? <div className={`flow-stage-connector ${status === "working" || status === "waiting_approval" ? "flowing" : ""}`} aria-hidden /> : null}
                <div className={`flow-stage-node ${isReview ? "is-review" : ""}`} data-status={status} data-active={status === "working" || status === "waiting_approval" ? "true" : "false"}>
                  <div className="flow-stage-head">
                    <span className="flow-stage-index num">0{index + 1}</span>
                    <div className="flow-stage-title">
                      <div className="flow-stage-name">{stage.label}</div>
                      <div className="flow-stage-hint">{stage.hint}</div>
                    </div>
                    <span className={`badge ${stageTone(status)}`}>{statusLabel(status)}</span>
                  </div>

                  {isReview ? (
                    <div className="flow-approval-block">
                      <div className="flow-gate-row">
                        <span className={`flow-gate ${snapshot.approval ? "is-waiting" : ""}`} aria-hidden>
                          <Icon name="shield" size={16} />
                        </span>
                        <div>
                          <div className="flow-agent-name">Human approval gate</div>
                          <div className="flow-agent-state">{snapshot.approval ? "Package ready for your review" : "Submission stays blocked until approved"}</div>
                        </div>
                      </div>
                      {snapshot.approval ? (
                        <>
                          <div className="flow-approval-title">
                            {snapshot.approval.title} <span>at {snapshot.approval.company}</span>
                          </div>
                          <div className="flow-approval-meta">
                            <span className="score-pill">{snapshot.approval.match_score ?? "—"}<small>% match</small></span>
                            <Link href={`/applications/${snapshot.approval.id}`} className="btn btn-sm btn-primary">
                              Review &amp; approve <Icon name="arrow" size={12} />
                            </Link>
                          </div>
                        </>
                      ) : (
                        <div className="flow-note">No package is currently waiting.</div>
                      )}
                    </div>
                  ) : null}

                  <div className="flow-agent-stack">
                    {stage.agents.map((key) => {
                      const task = latestByAgent.get(key);
                      const executionAgent = manifestByAgent.get(key);
                      const status = statusFor(key);
                      const identity = agentIdentity(key);
                      const avatarStatus = status === "working"
                        ? "working"
                        : status === "failed"
                          ? "failed"
                          : status === "completed" || status === "completed_zero"
                            ? "completed"
                            : "idle";
                      return (
                        <details key={key} className="flow-agent-row" data-status={status}>
                          <summary>
                            <AgentAvatar agentKey={key} status={avatarStatus} size={28} />
                            <span className="flow-agent-copy">
                              <span className="flow-agent-name">{identity.name}</span>
                              <span className="flow-agent-title">{identity.title}</span>
                              <span className="flow-agent-state">
                                {executionAgent
                                  ? executionAgent.state === "NOT_EXECUTED" || executionAgent.state === "SKIPPED"
                                    ? `${executionAgent.stateLabel} · ${executionAgent.reason ?? "No assignment recorded"}`
                                    : executionAgent.assignments.at(-1) ?? `${statusLabel(status)} · no assignment text recorded`
                                  : task?.title ?? `${statusLabel(status)} · not assigned in this run`}
                              </span>
                            </span>
                            <span className={`flow-agent-dot ${status}`} aria-label={statusLabel(status)} />
                            <span className="flow-agent-chevron" aria-hidden>⌄</span>
                          </summary>
                          {executionAgent ? (
                            <div className="flow-agent-details">
                              <div><span>Actual state</span><strong>{executionAgent.stateLabel}</strong></div>
                              <div><span>Execution ID</span><strong className="num">{snapshot.execution?.executionId ?? "—"}</strong></div>
                              <div><span>Records processed</span><strong className="num">{executionAgent.recordsProcessed}</strong></div>
                              <div><span>Duration</span><strong className="num">{executionAgent.durationMs === null ? "—" : `${Math.round(executionAgent.durationMs / 1000)}s`}</strong></div>
                              <div><span>Started</span><strong>{formatDateTime(executionAgent.startedAt)}</strong></div>
                              <div><span>Finished</span><strong>{formatDateTime(executionAgent.finishedAt)}</strong></div>
                              <div><span>Retry count</span><strong className="num">{executionAgent.retryCount}</strong></div>
                              <div><span>Dependencies</span><strong>{executionAgent.dependsOn.length ? executionAgent.dependsOn.map((dependency) => agentIdentity(dependency).name).join(", ") : "None"}</strong></div>
                              <div><span>Handoff from</span><strong>{executionAgent.handoffFrom ? agentIdentity(executionAgent.handoffFrom).name : "None"}</strong></div>
                              <div><span>Handoff to</span><strong>{executionAgent.handoffTo ? agentIdentity(executionAgent.handoffTo).name : "None"} · {executionAgent.handoffComplete ? "completed" : "not completed"}</strong></div>
                              {executionAgent.error ? <div className="flow-error">{executionAgent.error}</div> : null}
                              {executionAgent.output ? <div className="flow-output">{executionAgent.output}</div> : null}
                              {executionAgent.reason && !executionAgent.output ? <div className="flow-output">{executionAgent.reason}</div> : null}
                            </div>
                          ) : null}
                          {task ? (
                            <div className="flow-agent-details">
                              <div><span>Task status</span><strong>{task.status}</strong></div>
                              <div><span>Started</span><strong>{formatDateTime(task.started_at)}</strong></div>
                              <div><span>Finished</span><strong>{formatDateTime(task.finished_at)}</strong></div>
                              <div><span>Duration</span><strong className="num">{duration(task)}</strong></div>
                              <div><span>Retry count</span><strong className="num">{executionAgent?.retryCount ?? 0}</strong></div>
                              <div><span>Dependencies</span><strong>{executionAgent?.dependsOn.length ? executionAgent.dependsOn.map((dependency) => agentIdentity(dependency).name).join(", ") : "None"}</strong></div>
                              <div><span>Execution</span><strong>{task.execution_mode === "ai" ? `AI · ${task.ai_outcome ?? "unknown"} · ${task.provider ?? "—"} / ${task.model ?? "—"}` : task.execution_mode === "deterministic" ? "Deterministic (no model call)" : "Historical (origin unknown)"}</strong></div>
                              {task.error ? <div className="flow-error">{task.error}</div> : null}
                              {task.output ? <div className="flow-output">{task.output}</div> : null}
                            </div>
                          ) : null}
                        </details>
                      );
                    })}
                    {isReview ? (
                      <div className="flow-review-footer">
                        <span className="flow-review-icon"><Icon name="check" size={12} /></span>
                        <span>Only your approval can release a package.</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {workflow.summary || workflow.error ? (
          <div className={`alert ${workflow.error ? "alert-error" : "alert-info"} mt-3`}>{workflow.error ?? workflow.summary}</div>
        ) : null}

        <details className="flow-log-drawer">
          <summary>
            <span className="flow-log-title"><Icon name="logs" size={13} /> System &amp; event log</span>
            <span className="flow-log-meta">{connected ? "streaming" : "reconnecting"} · <span className="num">{events.length}</span> recent event(s)</span>
            <span className="flow-log-chevron" aria-hidden><Icon name="chevron" size={14} /></span>
          </summary>
          <div className="flow-events">
            <div className="flow-log-note">Raw persisted events, replay-safe from SQLite. Hidden until you need the execution detail.</div>
            {events.length === 0 ? (
              <p className="flow-log-empty">No new events on this connection yet.</p>
            ) : (
              <div className="flow-event-list">
                {events.slice(-7).map((event) => (
                  <div key={event.id} className="flow-event">
                    <span className={`flow-event-dot ${event.type.endsWith("failed") ? "bad" : event.type.includes("completed") ? "good" : ""}`} />
                    <span className="flow-event-type">{event.type}</span>
                    <span className="flow-event-msg">{event.message ?? ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      </div>
    </section>
  );
}
