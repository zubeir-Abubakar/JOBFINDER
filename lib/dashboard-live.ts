import { all, one } from "./db";
import { agentIdentity, isIdentityAgentKey } from "./agent-identity";
import { agentDefinition } from "./agent-definitions";
import { cachedProviderHealth, type ProviderHealth } from "./providers";
import { PROVIDER_STATUS_FRESHNESS_MS } from "./provider-status";
import { FREE_TIER_STATE_LABEL, freeTierSummary } from "./free-tier";

/**
 * Read-only projection for the owner's command dashboard.
 *
 * Every number comes from a persisted record:
 *  - agents            -> configured roster and assignment state
 *  - tasks             -> executions, failures and task completion
 *  - provider_usage    -> tokens, calls, latency and provider attribution
 *  - cached health     -> the latest actual provider check
 *
 * Nothing is generated, estimated for display or backfilled. When a source has
 * no measurement the field is null and the UI must say so. This module never
 * calls a provider and never changes a policy decision.
 */

export type DashboardPoint = { label: string; value: number; detail?: string };

export type DashboardAgent = {
  key: string;
  name: string;
  role: string;
  title: string;
  responsibilities: string;
  isChief: boolean;
  enabled: boolean;
  status: string;
  statusLabel: string;
  statusTone: "good" | "info" | "warn" | "bad" | "neutral";
  active: boolean;
  health: "live" | "recent" | "stale" | "none";
  heartbeatAt: string | null;
  lastRunAt: string | null;
  currentTask: string | null;
  /** Agents that must complete before this agent may start. */
  upstream: string[];
  /** Agents that normally receive this agent's persisted output. */
  downstream: string[];
  taskCompletion: {
    percent: number | null;
    completed: number;
    failed: number;
    active: number;
    total: number;
  };
  tokens: {
    total: number;
    input: number;
    output: number;
    calls: number;
    providerReported: number;
    estimated: number;
    unknown: number;
    unmeasuredCalls: number;
    taskCalls: number;
    taskTokens: number;
    backgroundCalls: number;
    backgroundTokens: number;
    unresolvedCalls: number;
    unresolvedTokens: number;
  };
  /** How the agent's task records actually executed. */
  execution: {
    ai: number;
    deterministic: number;
    unrecorded: number;
  };
  latencyMs: number | null;
  lastSuccessfulCallAt: string | null;
  /** Completed task records per day for the last 14 days. */
  taskTrend: DashboardPoint[];
  recentTasks: Array<{
    id: string;
    title: string;
    status: string;
    createdAt: string;
    finishedAt: string | null;
  }>;
};

export type DashboardProvider = {
  key: string;
  label: string;
  model: string | null;
  configured: boolean;
  availability: "available" | "unavailable" | "stale" | "unknown";
  statusLabel: string;
  detail: string;
  checkedAt: string | null;
  freeTierLabel: string;
  freeTierDetail: string;
  lastSuccessAt: string | null;
  lastSuccessModel: string | null;
};

export type DashboardTokenBreakdown = {
  key: string;
  label: string;
  calls: number;
  input: number;
  output: number;
  total: number;
  providerReported: number;
  estimated: number;
  unknown: number;
};

export type DashboardAttribution = "task" | "background" | "unresolved";

/**
 * Inference is split by what it can actually be linked to. A task execution and
 * an inference call are separate events: an agent can complete deterministic
 * work without inference, and can converse without creating a task.
 */
export type DashboardUsageSplit = {
  key: DashboardAttribution;
  label: string;
  detail: string;
  calls: number;
  input: number;
  output: number;
  total: number;
};

export type DashboardSnapshot = {
  generatedAt: string;
  refreshAfterMs: number;
  agents: DashboardAgent[];
  providers: DashboardProvider[];
  tokens: {
    calls: number;
    input: number;
    output: number;
    total: number;
    providerReported: number;
    estimated: number;
    unknown: number;
    unmeasuredCalls: number;
    taskCalls: number;
    backgroundCalls: number;
    unresolvedCalls: number;
    taskLinked: DashboardUsageSplit;
    background: DashboardUsageSplit;
    unresolved: DashboardUsageSplit;
    byAttribution: DashboardUsageSplit[];
    byAgent: DashboardTokenBreakdown[];
    byProvider: DashboardTokenBreakdown[];
    daily: DashboardPoint[];
    weekly: DashboardPoint[];
    reporting: {
      totals: string;
      tasks: string;
      trend: string;
      daily: string;
      weekly: string;
      firstRecordedAt: string | null;
      lastRecordedAt: string | null;
    };
  };
  policy: {
    externalSpendChf: 0;
    paidFallback: "never";
    detail: string;
  };
};

type AgentRow = {
  key: string;
  name: string;
  role: string;
  enabled: number;
  status: string;
  current_task: string | null;
  last_run_at: string | null;
};

type TaskRow = {
  id: string;
  agent_key: string;
  title: string;
  status: string;
  heartbeat_at: string | null;
  created_at: string;
  finished_at: string | null;
};

type TaskStatRow = {
  agent_key: string;
  total: number;
  completed: number;
  failed: number;
  active: number;
};

type UsageStatRow = {
  agent_key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  measured: number;
  estimated: number;
  unknown: number;
  unmeasured_calls: number;
  task_calls: number;
  task_tokens: number;
  background_calls: number;
  background_tokens: number;
  unresolved_calls: number;
  unresolved_tokens: number;
  avg_latency: number | null;
  last_success_at: string | null;
};

type UsageSplitRow = {
  usage_class: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type ExecutionStatRow = {
  agent_key: string;
  ai: number;
  deterministic: number;
  unrecorded: number;
};

type UsageGroupRow = {
  key: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  measured: number;
  estimated: number;
  unknown: number;
};

const ACTIVE_TASK_STATUSES = new Set([
  "running",
  "working",
  "thinking",
  "waiting",
  "waiting_provider",
  "retry_scheduled",
  "waiting_intervention",
]);

const DAY_MS = 86_400_000;
const TREND_DAYS = 14;
const WEEK_BUCKETS = 8;

/**
 * Usage rows are immutable history. Exact duplicates (same provider, model,
 * agent, links, token counts, status and millisecond timestamp) are one event
 * recorded twice, so they are counted once without deleting either row.
 */
const DEDUPED_USAGE_SQL = `
  SELECT provider, model, agent_key, workflow_id, task_id, session_id, source,
         prompt_tokens, completion_tokens, total_tokens, usage_source,
         latency_ms, status, created_at
  FROM provider_usage
  WHERE id IN (
    SELECT MIN(id) FROM provider_usage
    GROUP BY provider, model, agent_key, COALESCE(workflow_id, ''), COALESCE(task_id, ''),
             COALESCE(session_id, ''), COALESCE(source, ''), prompt_tokens, completion_tokens,
             total_tokens, COALESCE(usage_source, ''), latency_ms, status, COALESCE(error, ''), created_at
  )`;

/**
 * Attribution is proven, not assumed. A call is task-linked only when its task
 * exists and belongs to the same agent. Missing agents, missing or mismatched
 * task links and unrecognised sources remain explicitly unresolved; they are
 * never moved to another agent to make a card look consistent.
 */
const CLASSIFIED_USAGE_SQL = `
  SELECT u.*,
    CASE
      WHEN u.agent_key IS NULL OR TRIM(u.agent_key) = '' THEN 'unresolved'
      WHEN a.key IS NULL THEN 'unresolved'
      WHEN u.source = 'task' AND u.task_id IS NULL THEN 'unresolved'
      WHEN u.source = 'task' AND (t.id IS NULL OR t.agent_key != u.agent_key) THEN 'unresolved'
      WHEN u.source = 'task' THEN 'task'
      WHEN u.source IN ('assistant', 'manual', 'background', 'system') THEN 'background'
      ELSE 'unresolved'
    END AS usage_class
  FROM (${DEDUPED_USAGE_SQL}) u
  LEFT JOIN agents a ON a.key = u.agent_key
  LEFT JOIN tasks t ON t.id = u.task_id`;

const ATTRIBUTION_META: Record<DashboardAttribution, { label: string; detail: string }> = {
  task: {
    label: "Task-linked inference",
    detail: "Linked to a recorded task owned by the same agent.",
  },
  background: {
    label: "Background & conversational",
    detail: "Assistant, voice, manual or background calls without a task link.",
  },
  unresolved: {
    label: "Attribution unresolved",
    detail: "Missing agent, missing or mismatched task link, or unknown source. Retained and never reassigned.",
  },
};

const STATUS_META: Record<string, { label: string; tone: DashboardAgent["statusTone"] }> = {
  idle: { label: "Idle", tone: "neutral" },
  waiting: { label: "Waiting", tone: "warn" },
  working: { label: "Working", tone: "info" },
  thinking: { label: "Thinking", tone: "info" },
  completed: { label: "Completed", tone: "good" },
  failed: { label: "Attention", tone: "bad" },
  paused: { label: "Paused", tone: "warn" },
  unavailable: { label: "Unavailable", tone: "bad" },
};

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function lastDays(now: Date, days: number): string[] {
  const end = Date.parse(`${dayKey(now)}T00:00:00Z`);
  return Array.from({ length: days }, (_, index) =>
    dayKey(new Date(end - (days - 1 - index) * DAY_MS)),
  );
}

function weekStarts(now: Date, weeks: number): string[] {
  const today = new Date(`${dayKey(now)}T00:00:00Z`);
  const mondayOffset = (today.getUTCDay() + 6) % 7;
  const thisMonday = today.getTime() - mondayOffset * DAY_MS;
  return Array.from({ length: weeks }, (_, index) =>
    dayKey(new Date(thisMonday - (weeks - 1 - index) * 7 * DAY_MS)),
  );
}

function trendFor(values: Map<string, number>, days: string[]): DashboardPoint[] {
  return days.map((key) => ({ label: dayLabel(key), value: values.get(key) ?? 0, detail: key }));
}

function weeklyFor(values: Map<string, number>, weeks: string[]): DashboardPoint[] {
  const totals = new Map(weeks.map((week) => [week, 0]));
  for (const [day, value] of values) {
    const at = Date.parse(`${day}T00:00:00Z`);
    let match: string | null = null;
    for (const week of weeks) {
      const start = Date.parse(`${week}T00:00:00Z`);
      if (at >= start && at < start + 7 * DAY_MS) {
        match = week;
        break;
      }
    }
    if (match) totals.set(match, (totals.get(match) ?? 0) + value);
  }
  return weeks.map((week) => ({
    label: new Date(`${week}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }),
    value: totals.get(week) ?? 0,
    detail: `Week of ${week}`,
  }));
}

function secondsSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now.getTime() - at) / 1000));
}

function agentHealth(input: {
  enabled: boolean;
  status: string;
  active: boolean;
  heartbeatAt: string | null;
  now: Date;
}): DashboardAgent["health"] {
  if (!input.enabled || input.status === "paused") return "none";
  if (!input.active) return "none";
  const age = secondsSince(input.heartbeatAt, input.now);
  if (age == null) return "none";
  if (age <= 120) return "live";
  if (age <= 600) return "recent";
  return "stale";
}

function statusFor(enabled: boolean, status: string): { label: string; tone: DashboardAgent["statusTone"] } {
  if (!enabled) return { label: "Disabled", tone: "neutral" };
  if (status === "paused") return { label: "Paused", tone: "warn" };
  const meta = STATUS_META[status] ?? STATUS_META.idle;
  // A completed task is history, not current availability.
  if (status === "completed") return { label: "Idle", tone: "neutral" };
  return meta;
}

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function configuredAgentRows(): AgentRow[] {
  return all<AgentRow>(
    `SELECT key, name, role, enabled, status, current_task, last_run_at
     FROM agents ORDER BY sort, key`,
  );
}

function providerConfig(key: string): { configured: boolean; label: string; model: string | null } {
  if (key === "freellmapi") {
    return {
      configured:
        process.env.FREELLMAPI_ENABLED === "true" &&
        Boolean(process.env.FREELLMAPI_API_KEY?.trim()) &&
        Boolean(process.env.FREELLMAPI_BASE_URL?.trim()) &&
        Boolean(process.env.FREELLMAPI_MODEL?.trim()),
      label: "FreeLLMAPI",
      model: process.env.FREELLMAPI_MODEL?.trim() || null,
    };
  }
  if (key === "gemini") {
    return {
      configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      label: "Gemini",
      model: process.env.GEMINI_MODEL?.trim() || null,
    };
  }
  if (key === "ollama") {
    return {
      configured:
        process.env.OLLAMA_ENABLED === "true" &&
        Boolean(process.env.OLLAMA_BASE_URL?.trim()) &&
        Boolean(process.env.OLLAMA_MODEL?.trim()),
      label: "Ollama",
      model: process.env.OLLAMA_MODEL?.trim() || null,
    };
  }
  return {
    configured:
      Boolean(process.env.OPENROUTER_API_KEY?.trim()) &&
      ((process.env.OPENROUTER_ENABLED === "true" && Boolean(process.env.OPENROUTER_MODEL?.trim())) ||
        process.env.OPENROUTER_TTS_ENABLED === "true"),
    label: "OpenRouter / HeyGen",
    model: process.env.OPENROUTER_MODEL?.trim() || process.env.OPENROUTER_TTS_MODEL?.trim() || null,
  };
}

function providerFreeTier(key: string): { label: string; detail: string } {
  if (key === "gemini" || key === "freellmapi") {
    const tiers = freeTierSummary();
    const tier = key === "gemini" ? tiers.gemini : tiers.freellmapi;
    return {
      label: FREE_TIER_STATE_LABEL[tier.state],
      detail: tier.detail,
    };
  }
  if (key === "ollama") {
    const local = freeTierSummary().ollama;
    return {
      label: local.state === "local_available" ? "LOCAL · CHF 0.00" : "LOCAL UNAVAILABLE",
      detail: local.detail,
    };
  }
  const model = process.env.OPENROUTER_MODEL?.trim() || "";
  const exactFree = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*:free$/.test(model);
  return {
    label: exactFree ? "PROVIDER VERIFIED · FREE" : "UNVERIFIED",
    detail: exactFree
      ? "OpenRouter exact free model. The key and zero-price catalogue entry are checked before inference; no paid fallback is permitted."
      : "OpenRouter needs one exact :free model id. Dynamic routers and paid models are refused.",
  };
}

function providerStatus(reading: ProviderHealth | null, now: Date): {
  availability: DashboardProvider["availability"];
  statusLabel: string;
} {
  if (!reading) return { availability: "unknown", statusLabel: "Not checked" };
  const checked = reading.checkedAt ? Date.parse(reading.checkedAt) : Number.NaN;
  const fresh = Number.isFinite(checked) && now.getTime() - checked <= PROVIDER_STATUS_FRESHNESS_MS;
  if (!fresh) return { availability: "stale", statusLabel: "Stale health result" };
  if (reading.available) return { availability: "available", statusLabel: "Healthy" };
  if (reading.policyBlocked) return { availability: "unavailable", statusLabel: "Blocked by policy" };
  return { availability: "unavailable", statusLabel: "Configured but unavailable" };
}

function buildProviders(now: Date): DashboardProvider[] {
  const snapshot = cachedProviderHealth();
  const health = snapshot?.items ?? [];
  const tiers = freeTierSummary(now.getTime());
  return ["freellmapi", "gemini", "ollama", "openrouter"]
    .map((key) => {
      const config = providerConfig(key);
      if (!config.configured) return null;
      const reading = health.find((item) => item.name === key) ?? null;
      const status = providerStatus(reading, now);
      const tier = providerFreeTier(key);
      const success = one<{ model: string; created_at: string }>(
        "SELECT model, created_at FROM provider_usage WHERE provider = ? AND status = 'ok' ORDER BY id DESC LIMIT 1",
        [key],
      );
      const provider: DashboardProvider = {
        key,
        label: config.label,
        model: reading?.model || config.model,
        configured: true,
        availability: status.availability,
        statusLabel: status.statusLabel,
        detail:
          reading?.detail ||
          `No actual health check is recorded for ${config.label}. A configured credential is not a health claim.`,
        checkedAt: reading?.checkedAt ?? null,
        freeTierLabel:
          key === "gemini"
            ? FREE_TIER_STATE_LABEL[tiers.gemini.state]
            : key === "freellmapi"
              ? FREE_TIER_STATE_LABEL[tiers.freellmapi.state]
              : tier.label,
        freeTierDetail:
          key === "gemini"
            ? tiers.gemini.detail
            : key === "freellmapi"
              ? tiers.freellmapi.detail
              : tier.detail,
        lastSuccessAt: success?.created_at ?? null,
        lastSuccessModel: success?.model ?? null,
      };
      return provider;
    })
    .filter((item): item is DashboardProvider => item !== null);
}

function tokenBreakdown(row: UsageGroupRow, label: string): DashboardTokenBreakdown {
  return {
    key: row.key,
    label,
    calls: numeric(row.calls),
    input: numeric(row.input_tokens),
    output: numeric(row.output_tokens),
    total: numeric(row.total_tokens),
    providerReported: numeric(row.measured),
    estimated: numeric(row.estimated),
    unknown: numeric(row.unknown),
  };
}

export function getDashboardSnapshot(now: Date = new Date()): DashboardSnapshot {
  const days = lastDays(now, TREND_DAYS);
  const weeks = weekStarts(now, WEEK_BUCKETS);
  const sinceDay = days[0];

  const agentRows = configuredAgentRows();
  const taskStats = new Map(
    all<TaskStatRow>(
      `SELECT agent_key,
              COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status IN ('running','working','thinking','waiting','waiting_provider','retry_scheduled','waiting_intervention') THEN 1 ELSE 0 END) AS active
       FROM tasks GROUP BY agent_key`,
    ).map((row) => [row.agent_key, row]),
  );
  const activeTasks = all<TaskRow>(
    `SELECT id, agent_key, title, status, heartbeat_at, created_at, finished_at
     FROM tasks
     WHERE status IN ('running','working','thinking','waiting','waiting_provider','retry_scheduled','waiting_intervention')
     ORDER BY created_at DESC`,
  );
  const liveTaskByAgent = new Map<string, TaskRow>();
  for (const task of activeTasks) {
    if (!liveTaskByAgent.has(task.agent_key)) liveTaskByAgent.set(task.agent_key, task);
  }
  const recentTaskRows = all<TaskRow>(
    `SELECT id, agent_key, title, status, heartbeat_at, created_at, finished_at
     FROM tasks ORDER BY created_at DESC LIMIT 64`,
  );
  const recentByAgent = new Map<string, TaskRow[]>();
  for (const task of recentTaskRows) {
    const list = recentByAgent.get(task.agent_key) ?? [];
    if (list.length < 4) list.push(task);
    recentByAgent.set(task.agent_key, list);
  }

  const usageStats = new Map(
    all<UsageStatRow>(
      `SELECT agent_key,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
              COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
              COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown,
              COALESCE(SUM(CASE WHEN status = 'ok' AND total_tokens = 0 THEN 1 ELSE 0 END), 0) AS unmeasured_calls,
              COALESCE(SUM(CASE WHEN usage_class = 'task' THEN 1 ELSE 0 END), 0) AS task_calls,
              COALESCE(SUM(CASE WHEN usage_class = 'task' THEN total_tokens ELSE 0 END), 0) AS task_tokens,
              COALESCE(SUM(CASE WHEN usage_class = 'background' THEN 1 ELSE 0 END), 0) AS background_calls,
              COALESCE(SUM(CASE WHEN usage_class = 'background' THEN total_tokens ELSE 0 END), 0) AS background_tokens,
              COALESCE(SUM(CASE WHEN usage_class = 'unresolved' THEN 1 ELSE 0 END), 0) AS unresolved_calls,
              COALESCE(SUM(CASE WHEN usage_class = 'unresolved' THEN total_tokens ELSE 0 END), 0) AS unresolved_tokens,
              AVG(CASE WHEN status = 'ok' AND latency_ms > 0 THEN latency_ms END) AS avg_latency,
              MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_success_at
       FROM (${CLASSIFIED_USAGE_SQL}) GROUP BY agent_key`,
    ).map((row) => [row.agent_key, row]),
  );

  const executionStats = new Map(
    all<ExecutionStatRow>(
      `SELECT agent_key,
              SUM(CASE WHEN execution_mode = 'ai' OR EXISTS (
                SELECT 1 FROM provider_usage u
                WHERE u.task_id = tasks.id AND u.agent_key = tasks.agent_key AND u.source = 'task'
              ) THEN 1 ELSE 0 END) AS ai,
              SUM(CASE WHEN execution_mode = 'deterministic' AND NOT EXISTS (
                SELECT 1 FROM provider_usage u
                WHERE u.task_id = tasks.id AND u.agent_key = tasks.agent_key AND u.source = 'task'
              ) THEN 1 ELSE 0 END) AS deterministic,
              SUM(CASE WHEN (execution_mode IS NULL OR execution_mode NOT IN ('ai','deterministic')) AND NOT EXISTS (
                SELECT 1 FROM provider_usage u
                WHERE u.task_id = tasks.id AND u.agent_key = tasks.agent_key AND u.source = 'task'
              ) THEN 1 ELSE 0 END) AS unrecorded
       FROM tasks GROUP BY agent_key`,
    ).map((row) => [row.agent_key, row]),
  );

  const taskDailyByAgent = new Map<string, Map<string, number>>();
  for (const row of all<{ agent_key: string; d: string; completed: number }>(
    `SELECT agent_key, date(COALESCE(finished_at, created_at)) AS d, COUNT(*) AS completed
     FROM tasks
     WHERE status = 'completed' AND date(COALESCE(finished_at, created_at)) >= ?
     GROUP BY agent_key, d`,
    [sinceDay],
  )) {
    const map = taskDailyByAgent.get(row.agent_key) ?? new Map<string, number>();
    map.set(row.d, numeric(row.completed));
    taskDailyByAgent.set(row.agent_key, map);
  }

  const agents: DashboardAgent[] = agentRows.map((row) => {
    const identity = isIdentityAgentKey(row.key) ? agentIdentity(row.key) : null;
    const task = taskStats.get(row.key);
    const execution = executionStats.get(row.key);
    const liveTask = liveTaskByAgent.get(row.key) ?? null;
    const active = Boolean(liveTask);
    const status = statusFor(row.enabled === 1, row.status);
    const usage = usageStats.get(row.key);
    const totalTasks = numeric(task?.total);
    const completedTasks = numeric(task?.completed);
    const failedTasks = numeric(task?.failed);
    const activeTasks = numeric(task?.active);
    const percent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : null;
    const latency = optionalNumber(usage?.avg_latency);
    const definition = agentDefinition(row.key);
    const relatedNames = (keys: string[] | undefined) =>
      (keys ?? []).map((key) => agentIdentity(key).name);
    return {
      key: row.key,
      name: identity?.name || row.name,
      role: identity?.role || row.role,
      title: identity?.title || row.role,
      responsibilities: identity?.responsibilities || identity?.title || row.role,
      isChief: row.key === "coordinator",
      enabled: row.enabled === 1,
      status: row.status,
      statusLabel: status.label,
      statusTone: status.tone,
      active,
      health: agentHealth({
        enabled: row.enabled === 1,
        status: row.status,
        active,
        heartbeatAt: liveTask?.heartbeat_at ?? null,
        now,
      }),
      heartbeatAt: liveTask?.heartbeat_at ?? null,
      lastRunAt: row.last_run_at,
      currentTask: liveTask?.title ?? row.current_task ?? null,
      upstream: relatedNames(definition?.upstream),
      downstream: relatedNames(definition?.downstream),
      taskCompletion: {
        percent,
        completed: completedTasks,
        failed: failedTasks,
        active: activeTasks,
        total: totalTasks,
      },
      tokens: {
        total: numeric(usage?.total_tokens),
        input: numeric(usage?.input_tokens),
        output: numeric(usage?.output_tokens),
        calls: numeric(usage?.calls),
        providerReported: numeric(usage?.measured),
        estimated: numeric(usage?.estimated),
        unknown: numeric(usage?.unknown),
        unmeasuredCalls: numeric(usage?.unmeasured_calls),
        taskCalls: numeric(usage?.task_calls),
        taskTokens: numeric(usage?.task_tokens),
        backgroundCalls: numeric(usage?.background_calls),
        backgroundTokens: numeric(usage?.background_tokens),
        unresolvedCalls: numeric(usage?.unresolved_calls),
        unresolvedTokens: numeric(usage?.unresolved_tokens),
      },
      execution: {
        ai: numeric(execution?.ai),
        deterministic: numeric(execution?.deterministic),
        unrecorded: numeric(execution?.unrecorded),
      },
      latencyMs: latency == null ? null : Math.round(latency),
      lastSuccessfulCallAt: usage?.last_success_at ?? null,
      taskTrend: trendFor(taskDailyByAgent.get(row.key) ?? new Map(), days),
      recentTasks: (recentByAgent.get(row.key) ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        createdAt: item.created_at,
        finishedAt: item.finished_at,
      })),
    };
  });

  const usageGroupSql = (group: string) =>
    all<UsageGroupRow>(
      `SELECT ${group} AS key,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
              COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
              COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown
       FROM (${DEDUPED_USAGE_SQL}) GROUP BY ${group} ORDER BY total_tokens DESC, calls DESC`,
    );

  const agentNames = new Map(agents.map((agent) => [agent.key, agent.name]));
  const agentUsage = new Map(usageGroupSql("agent_key").map((row) => [row.key, row]));
  const byAgent = agents
    .map((agent) => {
      const row = agentUsage.get(agent.key);
      return tokenBreakdown(
        row ?? {
          key: agent.key,
          calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          measured: 0,
          estimated: 0,
          unknown: 0,
        },
        agent.name,
      );
    })
    .sort((a, b) => b.total - a.total);

  // Usage whose agent id is missing or not in the roster stays visible as an
  // unassigned bucket instead of silently disappearing from the breakdown.
  const unassigned = one<UsageGroupRow>(
    `SELECT 'unassigned' AS key,
            COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
            COALESCE(SUM(completion_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
            COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
            COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown
     FROM (${CLASSIFIED_USAGE_SQL})
     WHERE agent_key IS NULL OR TRIM(agent_key) = '' OR agent_key NOT IN (SELECT key FROM agents)`,
  );
  if (unassigned && (numeric(unassigned.calls) > 0 || numeric(unassigned.total_tokens) > 0)) {
    byAgent.push(tokenBreakdown(unassigned, "Unassigned (no registered agent)"));
  }

  const providerLabels: Record<string, string> = {
    freellmapi: "FreeLLMAPI",
    gemini: "Gemini",
    ollama: "Ollama (local)",
    openrouter: "OpenRouter",
    "gemini-live": "Gemini Live",
  };
  const byProvider = usageGroupSql("provider").map((row) =>
    tokenBreakdown(row, providerLabels[row.key] ?? row.key),
  );

  const totalRow = one<{
    calls: number;
    input: number;
    output: number;
    total: number;
    measured: number;
    estimated: number;
    unknown: number;
    unmeasured: number;
  }>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS input,
            COALESCE(SUM(completion_tokens), 0) AS output,
            COALESCE(SUM(total_tokens), 0) AS total,
            COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
            COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
            COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown,
            COALESCE(SUM(CASE WHEN status = 'ok' AND total_tokens = 0 THEN 1 ELSE 0 END), 0) AS unmeasured
     FROM (${DEDUPED_USAGE_SQL})`,
  );

  const splitRows = new Map(
    all<UsageSplitRow>(
      `SELECT usage_class, COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
              COALESCE(SUM(completion_tokens), 0) AS output_tokens,
              COALESCE(SUM(total_tokens), 0) AS total_tokens
       FROM (${CLASSIFIED_USAGE_SQL}) GROUP BY usage_class`,
    ).map((row) => [row.usage_class, row]),
  );
  const splitFor = (key: DashboardAttribution): DashboardUsageSplit => {
    const row = splitRows.get(key);
    return {
      key,
      label: ATTRIBUTION_META[key].label,
      detail: ATTRIBUTION_META[key].detail,
      calls: numeric(row?.calls),
      input: numeric(row?.input_tokens),
      output: numeric(row?.output_tokens),
      total: numeric(row?.total_tokens),
    };
  };
  const taskLinked = splitFor("task");
  const background = splitFor("background");
  const unresolved = splitFor("unresolved");

  const usageWindow = one<{ first: string | null; last: string | null }>(
    `SELECT MIN(created_at) AS first, MAX(created_at) AS last FROM (${DEDUPED_USAGE_SQL})`,
  );

  const dailyValues = new Map(
    all<{ d: string; tokens: number }>(
      `SELECT date(created_at) AS d, COALESCE(SUM(total_tokens), 0) AS tokens
       FROM (${DEDUPED_USAGE_SQL}) WHERE date(created_at) >= ? GROUP BY d`,
      [sinceDay],
    ).map((row) => [row.d, numeric(row.tokens)]),
  );

  return {
    generatedAt: now.toISOString(),
    refreshAfterMs: 20_000,
    agents,
    providers: buildProviders(now),
    tokens: {
      calls: numeric(totalRow?.calls),
      input: numeric(totalRow?.input),
      output: numeric(totalRow?.output),
      total: numeric(totalRow?.total),
      providerReported: numeric(totalRow?.measured),
      estimated: numeric(totalRow?.estimated),
      unknown: numeric(totalRow?.unknown),
      unmeasuredCalls: numeric(totalRow?.unmeasured),
      taskCalls: taskLinked.calls,
      backgroundCalls: background.calls,
      unresolvedCalls: unresolved.calls,
      taskLinked,
      background,
      unresolved,
      byAttribution: [taskLinked, background, unresolved],
      byAgent,
      byProvider,
      daily: trendFor(dailyValues, days),
      weekly: weeklyFor(dailyValues, weeks),
      reporting: {
        totals: "All recorded inference calls, all time",
        tasks: "All recorded task executions, all time",
        trend: "Completed tasks, last 14 days",
        daily: "Recorded tokens, last 14 days",
        weekly: "Recorded tokens, last 8 weeks",
        firstRecordedAt: usageWindow?.first ?? null,
        lastRecordedAt: usageWindow?.last ?? null,
      },
    },
    policy: {
      externalSpendChf: 0,
      paidFallback: "never",
      detail:
        "External AI spend is capped at CHF 0.00. Gemini and FreeLLMAPI require a declared, non-exhausted free tier. OpenRouter is limited to an exact provider-verified :free model; paid fallbacks are never used.",
    },
  };
}
