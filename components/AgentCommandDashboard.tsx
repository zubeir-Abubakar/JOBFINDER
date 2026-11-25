"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "./AgentAvatar";
import { Icon } from "./icons";
import type {
  DashboardAgent,
  DashboardPoint,
  DashboardProvider,
  DashboardSnapshot,
  DashboardTokenBreakdown,
} from "@/lib/dashboard-live";

const TONES = ["cyan", "green", "blue", "violet", "teal", "magenta", "mint", "purple"] as const;

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toLocaleString("en-GB");
}

function full(value: number): string {
  return value.toLocaleString("en-GB");
}

function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/**
 * Tokens and task executions are separate ledgers. This sentence explains the
 * card without implying that a token count is evidence of a task execution, or
 * that a deterministic task with no inference is missing instrumentation.
 */
function inferenceNote(agent: DashboardAgent): string {
  if (agent.tokens.calls === 0) {
    return agent.execution.deterministic > 0
      ? "No AI inference — deterministic execution"
      : "No AI inference recorded";
  }
  if (agent.tokens.total === 0) return "AI inference attempted · token usage unavailable";
  const parts = [
    `${full(agent.tokens.taskCalls)} task-linked`,
    `${full(agent.tokens.backgroundCalls)} background`,
  ];
  if (agent.tokens.unresolvedCalls > 0) parts.push(`${full(agent.tokens.unresolvedCalls)} unresolved`);
  return `AI inference recorded · ${parts.join(" · ")}`;
}

function dayStamp(iso: string | null): string {
  if (!iso) return "unknown";
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "unknown";
}

function inferenceTitle(agent: DashboardAgent): string {
  return [
    `${full(agent.tokens.calls)} recorded AI calls, all time.`,
    `${full(agent.tokens.taskCalls)} linked to tasks owned by this agent.`,
    `${full(agent.tokens.backgroundCalls)} background or conversational calls without a task.`,
    agent.tokens.unresolvedCalls > 0
      ? `${full(agent.tokens.unresolvedCalls)} calls have unresolved attribution and were not reassigned.`
      : "No unresolved attribution recorded.",
    agent.execution.deterministic > 0
      ? `${full(agent.execution.deterministic)} task executions were deterministic and required no inference.`
      : "No deterministic task executions recorded.",
  ].join(" ");
}

function heartbeatLabel(agent: DashboardAgent): string {
  if (!agent.active) return "No active heartbeat";
  if (!agent.heartbeatAt) return "Heartbeat not recorded";
  if (agent.health === "live") return "Heartbeat live";
  if (agent.health === "recent") return "Heartbeat recent";
  if (agent.health === "stale") return "Heartbeat stale";
  return "Heartbeat";
}

function absoluteTime(iso: string | null | undefined, empty: string): string {
  if (!iso) return empty;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "unknown";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getUTCDate())} ${months[at.getUTCMonth()]} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/**
 * Relative time is deliberately computed only after hydration. The server and
 * the first client render use the same absolute UTC timestamp, so date text
 * cannot cause a hydration mismatch; the readable "ago" label follows.
 */
function TimeValue({ iso, empty = "never" }: { iso: string | null | undefined; empty?: string }) {
  const [label, setLabel] = useState(() => absoluteTime(iso, empty));
  useEffect(() => {
    const update = () => setLabel(iso ? ago(iso) : empty);
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [iso, empty]);
  return <>{label}</>;
}

function Sparkline({
  id,
  points,
  tone,
}: {
  id: string;
  points: DashboardPoint[];
  tone: string;
}) {
  const max = Math.max(1, ...points.map((point) => point.value));
  const step = points.length > 1 ? 160 / (points.length - 1) : 160;
  const coords = points.map((point, index) => {
    const x = index * step;
    const y = 40 - (point.value / max) * 34;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const empty = points.every((point) => point.value === 0);
  if (empty) return <div className="cmd-chart-empty">No completed tasks in 14 days</div>;
  return (
    <svg
      className="cmd-sparkline"
      viewBox="0 0 160 44"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Completed tasks per day for the last 14 days. Peak ${full(max)} tasks.`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`var(--cmd-${tone})`} stopOpacity="0.42" />
          <stop offset="100%" stopColor={`var(--cmd-${tone})`} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={`M0,44 L${coords.join(" L")} L160,44 Z`} fill={`url(#${id})`} />
      <polyline
        points={coords.join(" ")}
        fill="none"
        stroke={`var(--cmd-${tone})`}
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
      {points.map((point, index) => (
        <circle key={point.detail ?? index} cx={index * step} cy={40 - (point.value / max) * 34} r="1.6" fill={`var(--cmd-${tone})`}>
          <title>{`${point.detail ?? point.label}: ${full(point.value)} completed task${point.value === 1 ? "" : "s"}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function ProgressRing({ value }: { value: number | null }) {
  const radius = 25;
  const circumference = 2 * Math.PI * radius;
  const percent = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="cmd-ring" role="img" aria-label={value == null ? "Task completion not tracked" : `Task completion ${percent}%`}>
      <svg viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--line)" strokeWidth="5" />
        {value != null ? (
          <circle
            cx="32"
            cy="32"
            r={radius}
            fill="none"
            stroke="var(--cmd-accent)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
            transform="rotate(-90 32 32)"
          />
        ) : null}
      </svg>
      <div className="cmd-ring-value">
        <strong>{value == null ? "—" : `${percent}%`}</strong>
        <span>{value == null ? "Not tracked" : "complete"}</span>
      </div>
    </div>
  );
}

function TokenBars({ points, label }: { points: DashboardPoint[]; label: string }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  const empty = points.every((point) => point.value === 0);
  if (empty) return <div className="cmd-chart-empty">No token usage recorded</div>;
  return (
    <div className="cmd-bars" role="img" aria-label={`${label}. ${points.map((point) => `${point.label}: ${full(point.value)}`).join(", ")}`}>
      <div className="cmd-bars-plot">
        {points.map((point, index) => (
          <div className="cmd-bar-column" key={point.detail ?? point.label} title={`${point.label}: ${full(point.value)} tokens`}>
            <span style={{ height: `${Math.max(2, (point.value / max) * 100)}%` }} />
            {index % 2 === 0 ? <small>{point.label}</small> : <small aria-hidden>&nbsp;</small>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Breakdown({
  rows,
  empty,
}: {
  rows: DashboardTokenBreakdown[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.total));
  const visible = rows.filter((row) => row.total > 0 || row.calls > 0);
  if (visible.length === 0) return <div className="cmd-chart-empty">{empty}</div>;
  return (
    <div className="cmd-breakdown">
      {visible.map((row) => (
        <div className="cmd-breakdown-row" key={row.key}>
          <div className="cmd-breakdown-top">
            <strong title={row.label}>{row.label}</strong>
            <span className="num">{full(row.total)}</span>
          </div>
          <div className="cmd-bar-track">
            <span style={{ width: `${Math.max(2, (row.total / max) * 100)}%` }} />
          </div>
          <div className="cmd-breakdown-meta">
            <span>{full(row.input)} in · {full(row.output)} out</span>
            <span>{full(row.calls)} calls</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProviderStrip({ providers }: { providers: DashboardProvider[] }) {
  if (providers.length === 0) {
    return (
      <div className="cmd-chart-empty">
        No AI provider is configured. Inference is blocked and external spend remains CHF 0.00.
      </div>
    );
  }
  return (
    <div className="cmd-health-grid">
      {providers.map((provider) => (
        <div className={`cmd-provider state-${provider.availability}`} key={provider.key} title={provider.detail}>
          <div className="cmd-provider-head">
            <span className={`cmd-health-dot state-${provider.availability}`} aria-hidden />
            <strong>{provider.label}</strong>
            <span className="cmd-provider-model">{provider.model ?? "No model"}</span>
          </div>
          <div className="cmd-provider-status">
            <span>{provider.statusLabel}</span>
            <span className="cmd-provider-tier">{provider.freeTierLabel}</span>
          </div>
          <div className="cmd-provider-meta">
            <span>
              Health check: <TimeValue iso={provider.checkedAt} empty="not checked" />
            </span>
            <span>
              Last success:{" "}
              {provider.lastSuccessAt ? (
                <>
                  <TimeValue iso={provider.lastSuccessAt} />
                  {provider.lastSuccessModel ? ` · ${provider.lastSuccessModel}` : ""}
                </>
              ) : (
                "none recorded"
              )}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentCard({
  agent,
  tone,
  index,
  open,
  onToggle,
}: {
  agent: DashboardAgent;
  tone: string;
  index: number;
  open: boolean;
  onToggle: () => void;
}) {
  const percent = agent.taskCompletion.percent;
  const detailId = `agent-details-${agent.key}`;
  return (
    <article
      className={`cmd-agent-card tone-${tone} ${agent.isChief ? "is-chief" : ""}`}
      aria-labelledby={`agent-name-${agent.key}`}
    >
      <div className="cmd-agent-topline" aria-hidden />
      <header className="cmd-agent-head">
        <AgentAvatar agentKey={agent.key} status={agent.status} size={44} />
        <div className="cmd-agent-id">
          <div className="cmd-agent-name-row">
            <h3 id={`agent-name-${agent.key}`}>{agent.name}</h3>
            {agent.isChief ? <span className="cmd-chief-tag">Central authority</span> : null}
          </div>
          <span className="cmd-agent-role">{agent.role}</span>
        </div>
        <div className="cmd-agent-tokens" title="All recorded AI inference tokens for this agent, all time">
          <strong>{compact(agent.tokens.total)}</strong>
          <span>tokens · all time</span>
        </div>
      </header>

      <div className="cmd-agent-status-row">
        <span className={`cmd-status tone-${agent.statusTone}`}>
          <span className={`dot ${agent.active ? "dot-live" : ""}`} /> {agent.statusLabel}
        </span>
        <span className={`cmd-heartbeat health-${agent.health}`}>
          {heartbeatLabel(agent)}
          {agent.active && agent.heartbeatAt ? <> · <TimeValue iso={agent.heartbeatAt} /></> : null}
        </span>
      </div>

      <div className="cmd-agent-panels">
        <div className="cmd-mini-panel">
          <div className="cmd-mini-head">
            <span>Task progress · 14d</span>
            <span>{full(agent.taskCompletion.completed)} done</span>
          </div>
          <Sparkline id={`spark-${agent.key}-${index}`} points={agent.taskTrend} tone={tone} />
        </div>
        <div className="cmd-mini-panel cmd-progress-panel">
          <div className="cmd-mini-head">
            <span>Task completion</span>
          </div>
          <ProgressRing value={percent} />
          <div className="cmd-progress-caption">
            {agent.taskCompletion.total === 0
              ? "No task records"
              : `${agent.taskCompletion.completed}/${agent.taskCompletion.total} tasks`}
          </div>
        </div>
      </div>

      <div className="cmd-current-task">
        <span>Current task</span>
        <strong title={agent.currentTask ?? undefined}>{agent.currentTask ?? "No active task"}</strong>
      </div>

      <dl className="cmd-metrics">
        <div>
          <dt>Completed</dt>
          <dd>{full(agent.taskCompletion.completed)}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{full(agent.taskCompletion.failed)}</dd>
        </div>
        <div>
          <dt>Active</dt>
          <dd>{full(agent.taskCompletion.active)}</dd>
        </div>
        <div>
          <dt>Total execs</dt>
          <dd>{full(agent.taskCompletion.total)}</dd>
        </div>
        <div>
          <dt>AI calls</dt>
          <dd>{full(agent.tokens.calls)}</dd>
        </div>
        <div>
          <dt>Task-linked</dt>
          <dd>{full(agent.tokens.taskCalls)}</dd>
        </div>
        <div>
          <dt>Background</dt>
          <dd>{full(agent.tokens.backgroundCalls)}</dd>
        </div>
        <div>
          <dt>Unresolved</dt>
          <dd>{full(agent.tokens.unresolvedCalls)}</dd>
        </div>
        <div>
          <dt>In / out</dt>
          <dd>{compact(agent.tokens.input)} / {compact(agent.tokens.output)}</dd>
        </div>
        <div>
          <dt>Total tokens</dt>
          <dd>{full(agent.tokens.total)}</dd>
        </div>
      </dl>

      <div className="cmd-agent-foot">
        <span className="cmd-token-provenance" title={inferenceTitle(agent)}>
          {inferenceNote(agent)}
        </span>
        <button
          type="button"
          className="cmd-details-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={onToggle}
        >
          Details
          <Icon name="chevron" size={13} />
        </button>
      </div>

      {open ? (
        <div className="cmd-agent-details" id={detailId}>
          <p>{agent.responsibilities}</p>
          <dl>
            <div><dt>Role</dt><dd>{agent.title}</dd></div>
            <div><dt>Last run</dt><dd>{agent.lastRunAt ? <TimeValue iso={agent.lastRunAt} /> : "No run recorded"}</dd></div>
            <div><dt>Last successful call</dt><dd>{agent.lastSuccessfulCallAt ? <TimeValue iso={agent.lastSuccessfulCallAt} /> : "No successful call"}</dd></div>
            <div><dt>Reports to</dt><dd>{agent.upstream.length > 0 ? agent.upstream.join(", ") : "No upstream agent"}</dd></div>
            <div><dt>Hands off to</dt><dd>{agent.downstream.length > 0 ? agent.downstream.join(", ") : "No downstream agent"}</dd></div>
            <div>
              <dt>Task-linked calls</dt>
              <dd>{full(agent.tokens.taskCalls)} calls · {full(agent.tokens.taskTokens)} tokens</dd>
            </div>
            <div>
              <dt>Background calls</dt>
              <dd>{full(agent.tokens.backgroundCalls)} calls · {full(agent.tokens.backgroundTokens)} tokens</dd>
            </div>
            <div>
              <dt>Attribution unresolved</dt>
              <dd>
                {agent.tokens.unresolvedCalls > 0
                  ? `${full(agent.tokens.unresolvedCalls)} calls · ${full(agent.tokens.unresolvedTokens)} tokens, retained and not reassigned`
                  : "None recorded"}
              </dd>
            </div>
            <div>
              <dt>Execution modes</dt>
              <dd>
                {full(agent.execution.ai)} AI · {full(agent.execution.deterministic)} deterministic
                {agent.execution.unrecorded > 0 ? ` · ${full(agent.execution.unrecorded)} unrecorded` : ""}
              </dd>
            </div>
            <div>
              <dt>Token measurement</dt>
              <dd>
                {agent.tokens.total === 0 && agent.tokens.calls > 0
                  ? "Not measured · provider returned no token counts"
                  : `${full(agent.tokens.providerReported)} provider-reported · ${full(agent.tokens.estimated)} estimated · ${full(agent.tokens.unknown)} unmeasured`}
              </dd>
            </div>
          </dl>
          <div className="cmd-recent">
            <span className="cmd-kicker">Recent task records</span>
            {agent.recentTasks.length === 0 ? (
              <p className="cmd-empty-line">No task history.</p>
            ) : (
              <ul>
                {agent.recentTasks.map((task) => (
                  <li key={task.id}>
                    <span className={`dot tone-${task.status === "failed" ? "bad" : task.status === "completed" ? "good" : "info"}`} />
                    <span className="truncate" title={task.title}>{task.title}</span>
                    <small>{task.status} · <TimeValue iso={task.finishedAt ?? task.createdAt} /></small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function AgentCommandDashboard({ initialSnapshot }: { initialSnapshot: DashboardSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [openAgent, setOpenAgent] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      if (document.hidden || inFlight.current) return;
      inFlight.current = true;
      setRefreshing(true);
      try {
        const response = await fetch("/api/dashboard/live", {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`Live refresh returned HTTP ${response.status}.`);
        const next = (await response.json()) as DashboardSnapshot;
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
          setStale(false);
        }
      } catch (refreshError) {
        if (!cancelled) {
          setError(refreshError instanceof Error ? refreshError.message : "Live refresh failed.");
          setStale(true);
        }
      } finally {
        if (!cancelled) setRefreshing(false);
        inFlight.current = false;
      }
    }

    const timer = window.setInterval(refresh, Math.max(15_000, snapshot.refreshAfterMs));
    const onVisibility = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [snapshot.refreshAfterMs]);

  const { agents, tokens, providers } = snapshot;

  return (
    <section className="cmd-shell" id="your-agents" aria-labelledby="your-agents-title">
      <div className="cmd-section-head">
        <div>
          <span className="cmd-eyebrow">Live orchestration</span>
          <h2 id="your-agents-title">Your Agents</h2>
          <p>
            Every configured agent, read from the persisted roster and execution ledger. Chief coordinates the
            specialists; unavailable measurements are marked instead of estimated.
          </p>
        </div>
        <div className="cmd-live-tools">
          <span className={`cmd-live-pill ${stale ? "is-stale" : ""}`} aria-live="polite">
            <span className={`dot ${stale ? "" : "dot-live"}`} />
            {stale ? "Live refresh paused" : refreshing ? "Refreshing" : "Live"}
            <small>· <TimeValue iso={snapshot.generatedAt} /></small>
          </span>
          <Link href="/agents/list" className="btn btn-sm">Manage agents</Link>
        </div>
      </div>

      {error ? (
        <div className="alert alert-warn mb-3" role="status">
          {error} Showing the last successful snapshot from <TimeValue iso={snapshot.generatedAt} />. No data was changed.
        </div>
      ) : null}

      {agents.length === 0 ? (
        <div className="card cmd-empty">
          <h3>No agents are configured</h3>
          <p>The roster is empty, so no agent cards are shown. Configure agents before starting a recruitment run.</p>
        </div>
      ) : (
        <div className="cmd-agent-grid">
          {agents.map((agent, index) => (
            <AgentCard
              key={agent.key}
              agent={agent}
              tone={TONES[index % TONES.length]}
              index={index}
              open={openAgent === agent.key}
              onToggle={() => setOpenAgent((current) => (current === agent.key ? null : agent.key))}
            />
          ))}
        </div>
      )}

      <section className="cmd-panel" aria-labelledby="system-health-title">
        <div className="cmd-panel-head">
          <div>
            <h3 id="system-health-title">System Health &amp; APIs</h3>
            <p>Actual checks only. A configured credential is not reported as healthy.</p>
          </div>
          <span className="cmd-panel-note">Free-tier enforcement · CHF 0.00</span>
        </div>
        <ProviderStrip providers={providers} />
        <p className="cmd-panel-foot">
          Availability comes from the latest recorded health check. No API key, environment variable or auth header is
          exposed. Free-tier state is a declared gate plus model checks, not machine-verified quota attestation.
        </p>
      </section>

      <section className="cmd-panel cmd-token-panel" aria-labelledby="token-analytics-title">
        <div className="cmd-panel-head">
          <div>
            <h3 id="token-analytics-title">Token analytics</h3>
            <p>Persisted usage from provider responses, attributed to the agent, provider, model and execution that produced it.</p>
          </div>
          <span className="cmd-panel-note">All recorded history · {full(tokens.calls)} calls</span>
        </div>

        <p className="cmd-reporting-period">
          Reporting period: <strong>{tokens.reporting.totals}</strong>. Task executions: {" "}
          {tokens.reporting.tasks.toLowerCase()}. Charts show {tokens.reporting.daily.toLowerCase()} and {" "}
          {tokens.reporting.weekly.toLowerCase()}.
          {tokens.reporting.firstRecordedAt
            ? ` First recorded call ${dayStamp(tokens.reporting.firstRecordedAt)}; latest ${dayStamp(tokens.reporting.lastRecordedAt)}.`
            : " No inference has been recorded yet."}
        </p>

        <div className="cmd-token-totals">
          <div><span>Total tokens</span><strong>{full(tokens.total)}</strong></div>
          <div><span>Input</span><strong>{full(tokens.input)}</strong></div>
          <div><span>Output</span><strong>{full(tokens.output)}</strong></div>
          <div><span>AI calls</span><strong>{full(tokens.calls)}</strong></div>
          <div><span>Task-linked calls</span><strong>{full(tokens.taskCalls)}</strong></div>
          <div><span>Background calls</span><strong>{full(tokens.backgroundCalls)}</strong></div>
          <div><span>Unresolved calls</span><strong>{full(tokens.unresolvedCalls)}</strong></div>
          <div><span>Provider-reported</span><strong>{full(tokens.providerReported)}</strong></div>
        </div>

        <div className="cmd-attribution-grid">
          {tokens.byAttribution.map((row) => (
            <div className={`cmd-attribution-card tone-${row.key}`} key={row.key}>
              <span className="cmd-kicker">{row.label}</span>
              <strong>{full(row.total)} <small>tokens</small></strong>
              <span>
                {full(row.calls)} {row.calls === 1 ? "call" : "calls"} · {full(row.input)} in · {full(row.output)} out
              </span>
              <small>{row.detail}</small>
            </div>
          ))}
        </div>

        {tokens.unmeasuredCalls > 0 || tokens.unknown > 0 || tokens.unresolved.calls > 0 ? (
          <p className="cmd-provenance-note">
            {tokens.unresolved.calls > 0
              ? `${full(tokens.unresolved.calls)} call${tokens.unresolved.calls === 1 ? "" : "s"} have unresolved attribution and are shown separately; historical rows were not reassigned. `
              : ""}
            {tokens.unknown > 0 ? `${full(tokens.unknown)} tokens have no recorded provenance. ` : ""}
            {tokens.unmeasuredCalls > 0
              ? `${full(tokens.unmeasuredCalls)} successful call${tokens.unmeasuredCalls === 1 ? "" : "s"} returned no measurable token usage; those tokens cannot currently be counted.`
              : ""}
          </p>
        ) : null}

        <div className="cmd-analytics-grid">
          <div className="cmd-chart-card">
            <div className="cmd-mini-head"><span>Daily usage · 14 days</span><span>tokens</span></div>
            <TokenBars points={tokens.daily} label="Daily token usage for the last 14 days" />
          </div>
          <div className="cmd-chart-card">
            <div className="cmd-mini-head"><span>Weekly usage · 8 weeks</span><span>tokens</span></div>
            <TokenBars points={tokens.weekly} label="Weekly token usage for the last 8 weeks" />
          </div>
          <div className="cmd-breakdown-card">
            <div className="cmd-mini-head"><span>Per provider</span><span>tokens</span></div>
            <Breakdown rows={tokens.byProvider} empty="No provider token usage recorded" />
          </div>
          <div className="cmd-breakdown-card">
            <div className="cmd-mini-head"><span>Per agent</span><span>tokens</span></div>
            <Breakdown rows={tokens.byAgent} empty="No agent token usage recorded" />
          </div>
        </div>

        <div className="cmd-policy-strip">
          <Icon name="shield" size={14} />
          <span>
            <strong>CHF {snapshot.policy.externalSpendChf.toFixed(2)} external spend.</strong>{" "}
            Paid fallback: {snapshot.policy.paidFallback}. Free tiers only; unverified or exhausted routes are blocked
            before transmission.
          </span>
        </div>
      </section>
    </section>
  );
}
