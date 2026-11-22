"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AgentTopologySnapshot,
  TopologyAgent,
  TopologyConnection,
  TopologyEvent,
  TopologyRun,
  TopologyTask,
} from "@/lib/agent-topology";
import { switchAgentAction } from "@/lib/actions/chat";
import type { IdentityAgentKey } from "@/lib/agent-identity";

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
  "agent.blocked",
  "agent.retrying",
  "approval.required",
  "approval.granted",
] as const;

const NODE_COORDS: Record<IdentityAgentKey, { x: number; y: number }> = {
  coordinator: { x: 500, y: 350 },
  research: { x: 500, y: 82 },
  analysis: { x: 825, y: 200 },
  cv: { x: 875, y: 462 },
  ats: { x: 700, y: 620 },
  cover: { x: 300, y: 620 },
  application: { x: 125, y: 462 },
  email: { x: 175, y: 200 },
};

type FilterKey = "all" | "working" | "waiting" | "completed" | "failed";

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "all", label: "All agents" },
  { key: "working", label: "Working" },
  { key: "waiting", label: "Waiting" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

function durationLabel(start: string | null, endMs: number | null, nowMs: number): string {
  if (!start) return "—";
  const started = Date.parse(start);
  if (!Number.isFinite(started)) return "—";
  const finish = endMs ?? nowMs;
  const seconds = Math.max(0, Math.floor((finish - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining.toString().padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

function clockLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function shortClock(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function matchesFilter(agent: TopologyAgent, filter: FilterKey): boolean {
  if (filter === "all") return true;
  if (filter === "working") return agent.state === "working" || agent.state === "processing";
  return agent.state === filter;
}

function clipText(value: string | null | undefined, max = 170): string {
  if (!value) return "";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
}

function curatedEventLabel(event: TopologyEvent): string {
  return event.type.replace(/\./g, " ");
}

function Portrait({
  agent,
  size,
  className = "",
}: {
  agent: TopologyAgent;
  size: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    setFailed(false);
    // An image can fail before hydration attaches onError. Check the mounted
    // element as well so a broken persisted asset still gets the safe fallback.
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth === 0) setFailed(true);
  }, [agent.key, agent.portrait]);

  return (
    <span
      className={`topology-portrait ${className}`}
      style={{ width: size, height: size }}
      data-portrait-key={agent.key}
    >
      {failed ? (
        <span
          className="topology-portrait-fallback"
          role="img"
          aria-label={`${agent.name} portrait unavailable; initials ${agent.initials}`}
        >
          {agent.initials}
        </span>
      ) : (
        <img
          ref={imageRef}
          src={agent.portrait}
          alt={`${agent.name} portrait`}
          width={320}
          height={320}
          loading="eager"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
      <span className="topology-portrait-ring" aria-hidden="true" />
      <span className="topology-status-dot" aria-hidden="true" />
    </span>
  );
}

function ActivityIndicator({ state }: { state: TopologyAgent["state"] }) {
  if (state === "working") {
    return (
      <span className="topology-pulse" aria-label="Working" role="img">
        <span />
        <span />
        <span />
      </span>
    );
  }
  if (state === "processing") {
    return (
      <span className="topology-processing" aria-label="Processing" role="img">
        <span />
      </span>
    );
  }
  return null;
}

function AgentNode({
  agent,
  elapsed,
  onSelect,
}: {
  agent: TopologyAgent;
  elapsed: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`topology-node state-${agent.state}`}
      style={{
        left: `${NODE_COORDS[agent.key].x / 10}%`,
        top: `${NODE_COORDS[agent.key].y / 7}%`,
      }}
      data-testid={`topology-agent-${agent.key}`}
      data-agent-key={agent.key}
      data-state={agent.state}
      onClick={onSelect}
      aria-label={`${agent.name}, ${agent.role}, ${agent.stateLabel}. ${agent.activity}`}
      aria-haspopup="dialog"
    >
      <span className="topology-node-head">
        <Portrait agent={agent} size={64} />
        <span className="topology-node-heading">
          <span className="topology-node-name">{agent.name}</span>
          <span className="topology-node-role">{agent.role}</span>
        </span>
      </span>
      <span className="topology-node-state-row">
        <span className="topology-state-label">
          <span className="topology-state-dot" aria-hidden="true" />
          {agent.stateLabel}
        </span>
        <ActivityIndicator state={agent.state} />
      </span>
      <span className="topology-node-activity">{clipText(agent.activity, 140) || "No active task."}</span>
      <span className="topology-node-meta">
        <span>{agent.startedAt ? `Started ${shortClock(agent.startedAt)}` : "No task start"}</span>
        <span>{agent.active ? elapsed : agent.finishedAt ? elapsed : "—"}</span>
      </span>
    </button>
  );
}

function ConnectionLines({
  specialists,
  connections,
}: {
  specialists: TopologyAgent[];
  connections: TopologyConnection[];
}) {
  const byAgent = new Map(connections.map((connection) => [connection.agentKey, connection]));

  return (
    <>
      <svg
        className="topology-links"
        viewBox="0 0 1000 700"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="topology-line" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#47d7ff" stopOpacity="0.06" />
            <stop offset="1" stopColor="#47d7ff" stopOpacity="0.34" />
          </linearGradient>
          <filter id="topology-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {specialists.map((agent) => {
          const target = NODE_COORDS[agent.key];
          const start = NODE_COORDS.coordinator;
          const d = `M ${start.x} ${start.y} C ${start.x + (target.x - start.x) * 0.42} ${start.y + (target.y - start.y) * 0.08}, ${start.x + (target.x - start.x) * 0.78} ${start.y + (target.y - start.y) * 0.56}, ${target.x} ${target.y}`;
          const connection = byAgent.get(agent.key);
          return (
            <g key={agent.key}>
              <path className="topology-edge-base" d={d} />
              <path
                className={`topology-edge ${connection?.active ? "is-active" : ""} ${connection?.direction === "agent-to-chief" ? "is-reverse" : ""}`}
                d={d}
                data-agent-key={agent.key}
                data-active={connection?.active ? "true" : "false"}
              >
                {connection?.label ? <title>{connection.label}</title> : null}
              </path>
            </g>
          );
        })}
      </svg>
      <ul className="sr-only" aria-label="Recorded Chief and specialist connections">
        {connections
          .filter((connection) => connection.active)
          .map((connection) => (
            <li key={connection.agentKey}>{connection.label ?? `${connection.agentKey} active`}</li>
          ))}
      </ul>
    </>
  );
}

function RunPanel({
  run,
  now,
  workflowLabel,
}: {
  run: TopologyRun | null;
  now: number;
  workflowLabel: string | null;
}) {
  if (!run) {
    return (
      <aside className="topology-run-panel" aria-label="Run information" data-testid="topology-run-panel">
        <div className="topology-panel-kicker">Run information</div>
        <h3>No recruitment run recorded</h3>
        <p className="topology-panel-copy">
          The live view is showing the persisted roster only. There is no current run, task count or vacancy count to
          report.
        </p>
        <Link href="/recruitment" className="topology-panel-link">Open recruitment runs</Link>
      </aside>
    );
  }

  const elapsed = durationLabel(
    run.startedAt,
    run.finishedAt ? Date.parse(run.finishedAt) : now,
    now,
  );
  const counts = [
    ["Completed", run.counts.completed],
    ["Running", run.counts.running],
    ["Waiting", run.counts.waiting],
    ["Failed", run.counts.failed],
  ] as const;

  return (
    <aside className="topology-run-panel" aria-label="Run information" data-testid="topology-run-panel">
      <div className="topology-panel-top">
        <div>
          <div className="topology-panel-kicker">Run information</div>
          <h3>{run.type}</h3>
        </div>
        <span className={`topology-run-status ${run.active ? "is-live" : ""}`}>{run.status.replace(/_/g, " ")}</span>
      </div>
      <div className="topology-run-rows">
        <div><span>Run ID</span><strong className="num" title={run.id}>{run.runKey}</strong></div>
        <div><span>Scope</span><strong>{run.scope === "incremental" ? "Incremental" : "Full"}</strong></div>
        <div><span>Trigger</span><strong>{run.trigger.replace(/_/g, " ")}</strong></div>
        <div><span>Started</span><strong>{clockLabel(run.startedAt)}</strong></div>
        <div><span>Elapsed</span><strong className="num">{elapsed}</strong></div>
        <div><span>Workflow</span><strong>{workflowLabel ?? "—"}</strong></div>
        <div><span>New jobs</span><strong className="num">{run.jobsDiscovered}</strong></div>
        <div><span>Updated jobs</span><strong className="num">{run.jobsUpdated}</strong></div>
      </div>
      <div className="topology-run-counts">
        {counts.map(([label, value]) => (
          <div key={label}>
            <strong className="num">{value}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {run.error ? <p className="topology-run-error">{run.error}</p> : null}
      <Link href={`/recruitment/runs/${run.id}`} className="topology-panel-link">Open run report</Link>
    </aside>
  );
}

function Timeline({ events, streamLabel }: { events: TopologyEvent[]; streamLabel: string }) {
  return (
    <section className="topology-timeline" aria-label="Live activity timeline">
      <header className="topology-timeline-head">
        <div>
          <div className="topology-panel-kicker">Live activity</div>
          <h3>Persisted orchestration timeline</h3>
        </div>
        <span className="topology-timeline-signal">{streamLabel}</span>
      </header>
      {events.length === 0 ? (
        <p className="topology-timeline-empty">
          No workflow events have been persisted for this run yet. This view does not invent activity.
        </p>
      ) : (
        <ol className="topology-timeline-list">
          {events.map((event) => (
            <li key={event.id} className={`topology-event tone-${event.tone}`} data-event-id={event.id}>
              <span className="topology-event-dot" aria-hidden="true" />
              <div className="topology-event-main">
                <div className="topology-event-meta">
                  <span>{event.agentName ?? "System"}</span>
                  <span>{curatedEventLabel(event)}</span>
                  <time dateTime={event.createdAt}>{clockLabel(event.createdAt)}</time>
                </div>
                <p>{event.message}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TaskHistory({ tasks }: { tasks: TopologyTask[] }) {
  if (tasks.length === 0) return <p className="topology-drawer-empty">No task records for this agent.</p>;
  return (
    <div className="topology-history-list">
      {tasks.map((task) => (
        <div key={task.id} className="topology-history-item">
          <div>
            <strong>{task.title}</strong>
            <span className={`topology-task-status is-${task.status}`}>{task.status.replace(/_/g, " ")}</span>
          </div>
          <p>{clipText(task.error ?? task.output ?? task.stateReason ?? task.detail, 180) || "No result recorded."}</p>
          <span>{clockLabel(task.finishedAt ?? task.startedAt ?? task.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

function AgentDrawer({
  agent,
  now,
  onClose,
}: {
  agent: TopologyAgent;
  now: number;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [agent.key]);

  return createPortal(
    <div
      className="topology-drawer-layer"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        className="topology-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="topology-drawer-title"
        data-testid="topology-agent-drawer"
      >
        <header className="topology-drawer-head">
          <div>
            <div className="topology-panel-kicker">Agent details</div>
            <h2 id="topology-drawer-title">{agent.name}</h2>
            <p>{agent.title}</p>
          </div>
          <button ref={closeRef} type="button" className="topology-drawer-close" onClick={onClose} aria-label="Close agent details">
            ×
          </button>
        </header>
        <div className="topology-drawer-profile">
          <Portrait agent={agent} size={92} />
          <div>
            <span className={`topology-state-pill state-${agent.state}`}>
              <span className="topology-state-dot" aria-hidden="true" />
              {agent.stateLabel}
            </span>
            <p>{agent.activity}</p>
            <div className="topology-drawer-facts">
              <span>Voice <strong>{agent.voiceName}</strong></span>
              <span>Started <strong>{clockLabel(agent.startedAt)}</strong></span>
              <span>Elapsed <strong className="num">{durationLabel(agent.startedAt, agent.finishedAt ? Date.parse(agent.finishedAt) : null, now)}</strong></span>
            </div>
          </div>
        </div>
        <section className="topology-drawer-section">
          <h3>Current task</h3>
          {agent.task ? (
            <div className="topology-current-task">
              <strong>{agent.task.title}</strong>
              <span>{agent.task.stateReason ?? agent.task.detail ?? "No task detail recorded."}</span>
              {agent.task.dependsOn.length > 0 ? (
                <span>Waiting on {agent.task.dependsOn.length} prerequisite task(s).</span>
              ) : null}
              {agent.task.heartbeatAt ? <span>Last heartbeat {clockLabel(agent.task.heartbeatAt)}</span> : null}
            </div>
          ) : (
            <p className="topology-drawer-empty">No task is assigned in the selected run.</p>
          )}
        </section>
        <section className="topology-drawer-section">
          <h3>Recent executions</h3>
          <TaskHistory tasks={agent.recentTasks} />
        </section>
        <section className="topology-drawer-section">
          <h3>Recent events and handoffs</h3>
          {agent.recentEvents.length === 0 ? (
            <p className="topology-drawer-empty">No persisted events for this agent in the selected run.</p>
          ) : (
            <div className="topology-history-list">
              {agent.recentEvents.map((event) => (
                <div key={event.id} className="topology-history-item">
                  <div>
                    <strong>{curatedEventLabel(event)}</strong>
                    <span>{clockLabel(event.createdAt)}</span>
                  </div>
                  <p>{event.message}</p>
                </div>
              ))}
            </div>
          )}
        </section>
        <div className="topology-drawer-actions">
          <Link href={`/agents/list?agent=${agent.key}#activity`} className="btn">Full task history</Link>
          <form action={switchAgentAction}>
            <input type="hidden" name="agent" value={agent.key} />
            <button type="submit" className="btn btn-primary">Open conversation</button>
          </form>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

export function AgentTopology({ initialSnapshot }: { initialSnapshot: AgentTopologySnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [selectedKey, setSelectedKey] = useState<IdentityAgentKey | null>(null);
  const [now, setNow] = useState(() => Date.parse(initialSnapshot.generatedAt) || Date.now());
  const [lastSync, setLastSync] = useState(() => Date.parse(initialSnapshot.generatedAt) || Date.now());
  const [fetchState, setFetchState] = useState<"ok" | "error">("ok");
  const [streamState, setStreamState] = useState<"polling" | "live" | "reconnecting">("polling");
  const requestSequence = useRef(0);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventId = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const response = await fetch("/api/agents/topology", { cache: "no-store" });
      if (!response.ok) throw new Error(`Topology snapshot returned ${response.status}`);
      const next = (await response.json()) as AgentTopologySnapshot;
      if (sequence !== requestSequence.current) return;
      setSnapshot(next);
      setNow(Date.now());
      setLastSync(Date.now());
      setFetchState("ok");
    } catch {
      if (sequence === requestSequence.current) setFetchState("error");
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh();
    }, 240);
  }, [refresh]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  useEffect(() => {
    const workflowId = snapshot.workflow?.id;
    if (!workflowId) {
      setStreamState("polling");
      return;
    }
    lastEventId.current = 0;
    const source = new EventSource(`/api/workflows/${workflowId}/events`);
    const handler = (raw: Event) => {
      const event = raw as MessageEvent;
      const id = Number(event.lastEventId);
      if (Number.isFinite(id) && id > 0) lastEventId.current = id;
      scheduleRefresh();
    };
    source.onopen = () => setStreamState("live");
    source.onerror = () => setStreamState("reconnecting");
    for (const type of EVENT_TYPES) source.addEventListener(type, handler as EventListener);
    return () => {
      source.close();
      setStreamState("polling");
    };
  }, [snapshot.workflow?.id, scheduleRefresh]);

  useEffect(() => {
    if (!selectedKey) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedKey]);

  const needsClock =
    Boolean(snapshot.run?.active) ||
    snapshot.agents.some((agent) => agent.state === "working" || agent.state === "processing" || agent.state === "waiting");

  useEffect(() => {
    if (!needsClock) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [needsClock]);

  const visibleSpecialists = useMemo(
    () => snapshot.specialists.filter((agent) => matchesFilter(agent, filter)),
    [snapshot.specialists, filter],
  );
  const visibleKeys = useMemo(
    () => new Set(visibleSpecialists.map((agent) => agent.key)),
    [visibleSpecialists],
  );
  const visibleConnections = useMemo(
    () => snapshot.connections.filter((connection) => visibleKeys.has(connection.agentKey)),
    [snapshot.connections, visibleKeys],
  );
  const selectedAgent = selectedKey ? snapshot.agents.find((agent) => agent.key === selectedKey) ?? null : null;

  const filterCounts: Record<FilterKey, number> = {
    all: snapshot.specialists.length,
    working: snapshot.stats.working + snapshot.stats.processing,
    waiting: snapshot.stats.waiting,
    completed: snapshot.stats.completed,
    failed: snapshot.stats.failed,
  };
  const streamLabel =
    fetchState === "error"
      ? "Snapshot unavailable · retrying"
      : streamState === "live"
        ? "Event stream live"
        : streamState === "reconnecting"
          ? "Reconnecting · snapshot polling"
          : "Snapshot polling";
  const headerStatus = snapshot.run
    ? snapshot.run.active
      ? snapshot.run.status.replace(/_/g, " ")
      : `Last run ${snapshot.run.status.replace(/_/g, " ")}`
    : "Idle — no run recorded";

  return (
    <div className="topology-shell" data-testid="agent-topology" data-stream-state={streamState}>
      <header className="topology-topbar">
        <div>
          <div className="topology-eyebrow">Central command hub</div>
          <h2>{snapshot.coordinator.name} and the specialist workforce</h2>
          <p>
            {snapshot.workflow?.label ?? "No workflow selected"} · {headerStatus}
          </p>
        </div>
        <div className="topology-topbar-status">
          <span className={`topology-live-badge ${snapshot.run?.active ? "is-live" : ""}`}>
            <span className="topology-live-dot" aria-hidden="true" />
            {snapshot.run?.active ? "Run in progress" : "No active run"}
          </span>
          <span className="topology-sync-note" aria-live="polite">
            {streamLabel} · last sync {shortClock(new Date(lastSync).toISOString())}
          </span>
        </div>
      </header>

      <div className="topology-toolbar">
        <div className="topology-filters" role="group" aria-label="Filter agents by state">
          {FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={filter === item.key ? "is-active" : ""}
              aria-pressed={filter === item.key}
              onClick={() => setFilter(item.key)}
              data-filter={item.key}
            >
              {item.label}
              <span>{filterCounts[item.key]}</span>
            </button>
          ))}
        </div>
        <div className="topology-legend" aria-label="Connection legend">
          <span><i className="legend-dot is-live" /> Active assignment</span>
          <span><i className="legend-line" /> Persisted connection</span>
        </div>
      </div>

      <div className="topology-grid">
        <section className="topology-stage" aria-label="Central Chief topology">
          <ConnectionLines specialists={visibleSpecialists} connections={visibleConnections} />

          <button
            type="button"
            className={`topology-chief state-${snapshot.coordinator.state}`}
            data-testid="topology-agent-coordinator"
            data-agent-key="coordinator"
            data-state={snapshot.coordinator.state}
            onClick={() => setSelectedKey("coordinator")}
            aria-label={`${snapshot.coordinator.name}, ${snapshot.coordinator.stateLabel}. ${snapshot.coordinator.activity}`}
            aria-haspopup="dialog"
          >
            <span className="topology-chief-halo" aria-hidden="true" />
            <Portrait agent={snapshot.coordinator} size={124} className="topology-chief-portrait" />
            <span className="topology-chief-name">{snapshot.coordinator.name}</span>
            <span className="topology-chief-role">Chief Coordinator</span>
            <span className="topology-chief-state">
              <span className="topology-state-dot" aria-hidden="true" />
              {snapshot.coordinator.stateLabel}
            </span>
            <span className="topology-chief-voice">{snapshot.coordinator.voiceName}</span>
            <span className="topology-chief-activity">{clipText(snapshot.coordinator.activity, 120)}</span>
            <span className="topology-chief-run">
              {snapshot.run ? `${snapshot.run.type} · ${snapshot.run.runKey}` : "No run association"}
            </span>
          </button>

          <div className="topology-specialists">
            {visibleSpecialists.map((agent) => (
              <AgentNode
                key={agent.key}
                agent={agent}
                elapsed={durationLabel(
                  agent.startedAt,
                  agent.finishedAt ? Date.parse(agent.finishedAt) : agent.active ? now : null,
                  now,
                )}
                onSelect={() => setSelectedKey(agent.key)}
              />
            ))}
          </div>
          {visibleSpecialists.length === 0 ? (
            <p className="topology-filter-empty">No specialist agent currently matches this state filter.</p>
          ) : null}
        </section>

        <RunPanel run={snapshot.run} now={now} workflowLabel={snapshot.workflow?.label ?? null} />
      </div>

      <Timeline events={snapshot.events} streamLabel={streamLabel} />

      {selectedAgent ? (
        <AgentDrawer agent={selectedAgent} now={now} onClose={() => setSelectedKey(null)} />
      ) : null}
    </div>
  );
}
