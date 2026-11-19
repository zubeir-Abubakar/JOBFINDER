import { all, one } from "./db";
import { getRecruitmentPolicy } from "./recruitment-policy";

/**
 * Database-backed analytics.
 *
 * All aggregations are read-only. Applications prepared or attempted are never
 * relabelled as verified submissions, and an unknown cost is never displayed as
 * zero. Date filters are applied to every series.
 */

export type AnalyticsPreset = "today" | "7" | "30" | "all" | "custom";

export type AnalyticsRange = {
  from: string;
  to: string;
  preset: AnalyticsPreset;
  label: string;
};

export type PieSlice = {
  label: string;
  value: number;
  detail: string;
  tone?: "accent" | "cyan" | "violet" | "amber" | "danger" | "muted";
};

export type TimePoint = { label: string; value: number; detail?: string };

export type ModelUsage = {
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  percentage: number;
};

export type TokenBreakdown = {
  provider: string;
  model: string;
  agentKey: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  providerReportedTokens: number;
  estimatedTokens: number;
  unknownTokens: number;
};

export type AnalyticsData = {
  range: AnalyticsRange;
  generatedAt: string;
  agentDistribution: PieSlice[];
  providerDistribution: PieSlice[];
  providerMetric: "tokens" | "calls";
  modelUsage: ModelUsage[];
  productivity: PieSlice[];
  productivityRanking: Array<{ name: string; completed: number; failed: number; other: number }>;
  funnel: TimePoint[];
  outcomes: PieSlice[];
  outcomesTotal: number;
  trends: {
    vacancies: TimePoint[];
    prepared: TimePoint[];
    verified: TimePoint[];
    tasks: TimePoint[];
    tokens: TimePoint[];
  };
  weekly: {
    vacancies: TimePoint[];
    prepared: TimePoint[];
    verified: TimePoint[];
    tasks: TimePoint[];
    tokens: TimePoint[];
  };
  tokens: {
    calls: number;
    input: number;
    output: number;
    total: number;
    cached: number;
    providerReported: number;
    estimated: number;
    unknown: number;
    local: number;
    external: number;
    failedCalls: number;
    cost: "unverified";
    costDetail: string;
    byAgent: TokenBreakdown[];
    byProvider: TokenBreakdown[];
    byModel: TokenBreakdown[];
  };
};

const DAY_MS = 86_400_000;

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function addDays(day: string, amount: number): string {
  return dayKey(new Date(Date.parse(`${day}T00:00:00Z`) + amount * DAY_MS));
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS));
}

function earliestRecordDay(): string | null {
  const row = one<{ d: string | null }>(
    `SELECT MIN(d) AS d FROM (
       SELECT MIN(date(discovered_at)) AS d FROM jobs
       UNION ALL SELECT MIN(date(created_at)) AS d FROM applications
       UNION ALL SELECT MIN(date(created_at)) AS d FROM tasks
       UNION ALL SELECT MIN(date(created_at)) AS d FROM provider_usage
       UNION ALL SELECT MIN(date(created_at)) AS d FROM documents
     )`,
  );
  return row?.d ?? null;
}

export function resolveAnalyticsRange(input: {
  preset?: string | string[];
  from?: string | string[];
  to?: string | string[];
  today?: Date;
}): AnalyticsRange {
  const presetRaw = Array.isArray(input.preset) ? input.preset[0] : input.preset;
  const fromRaw = Array.isArray(input.from) ? input.from[0] : input.from;
  const toRaw = Array.isArray(input.to) ? input.to[0] : input.to;
  const requested = (presetRaw || "").toLowerCase();
  const preset: AnalyticsPreset =
    requested === "today" || requested === "7" || requested === "30" || requested === "all" || requested === "custom"
      ? (requested as AnalyticsPreset)
      : "30";
  const now = input.today ?? new Date();
  const today = dayKey(now);
  const to = toRaw && validDay(toRaw) ? toRaw : today;
  let from = fromRaw && validDay(fromRaw) ? fromRaw : addDays(to, -29);

  if (preset === "today") from = to;
  else if (preset === "7") from = addDays(to, -6);
  else if (preset === "30") from = addDays(to, -29);
  else if (preset === "all") from = earliestRecordDay() ?? addDays(to, -29);

  if (from > to) from = to;
  const label =
    preset === "today"
      ? "Today"
      : preset === "7"
        ? "Last 7 days"
        : preset === "30"
          ? "Last 30 days"
          : preset === "all"
            ? "All time"
            : "Custom range";

  return { from, to, preset, label };
}

function providerLabel(provider: string): string {
  if (provider === "freellmapi") return "FreeLLMAPI";
  if (provider === "ollama") return "Ollama (local)";
  if (provider === "gemini") return "Gemini";
  if (provider === "openrouter") return "OpenRouter";
  return provider;
}

function providerTone(provider: string): PieSlice["tone"] {
  if (provider === "freellmapi") return "accent";
  if (provider === "ollama") return "cyan";
  if (provider === "gemini") return "violet";
  if (provider === "openrouter") return "amber";
  return "muted";
}

function groupedByDay(sql: string, from: string, to: string): Map<string, number> {
  const rows = all<{ d: string; c: number }>(sql, [from, to]);
  return new Map(rows.map((row) => [row.d, Number(row.c)]));
}

function buildSeries(
  from: string,
  to: string,
  values: Map<string, number>,
  stepDays: number,
  weekly = false,
): TimePoint[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const buckets: TimePoint[] = [];
  for (let cursor = start; cursor <= end; cursor += stepDays * DAY_MS) {
    const bucketStart = dayKey(new Date(cursor));
    const bucketEnd = Math.min(end, cursor + (stepDays - 1) * DAY_MS);
    let total = 0;
    for (const [day, value] of values) {
      const at = Date.parse(`${day}T00:00:00Z`);
      if (at >= cursor && at <= bucketEnd) total += value;
    }
    const label = weekly
      ? `${new Date(cursor).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}`
      : new Date(cursor).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
    buckets.push({ label, value: total, detail: weekly ? `Week of ${bucketStart}` : bucketStart });
  }
  return buckets;
}

function montlyOrDailySeries(
  from: string,
  to: string,
  values: Map<string, number>,
  weekly: boolean,
): TimePoint[] {
  return buildSeries(from, to, values, weekly ? 7 : 1, weekly);
}

function safePercent(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
}

function tokenBreakdown(
  rows: Array<{
    provider: string;
    model: string;
    agent_key: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    measured: number;
    estimated: number;
    unknown: number;
  }>,
): TokenBreakdown[] {
  return rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    agentKey: row.agent_key,
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    providerReportedTokens: Number(row.measured),
    estimatedTokens: Number(row.estimated),
    unknownTokens: Number(row.unknown),
    percentage: 0,
  }));
}

export function getAnalytics(range: AnalyticsRange): AnalyticsData {
  const { from, to } = range;
  const policy = getRecruitmentPolicy();
  const span = daysBetween(from, to) + 1;
  const weekly = span > 92;
  const chartStep = weekly ? 7 : 1;

  // A. Current availability plus the latest task inside the selected window.
  const taskRows = all<{ agent_key: string; status: string; created_at: string }>(
    "SELECT agent_key, status, created_at FROM tasks WHERE date(created_at) BETWEEN ? AND ? ORDER BY created_at DESC",
    [from, to],
  );
  const latestTaskByAgent = new Map<string, { status: string; created_at: string }>();
  for (const task of taskRows) if (!latestTaskByAgent.has(task.agent_key)) latestTaskByAgent.set(task.agent_key, task);
  const agentRows = all<{ key: string; name: string; status: string }>("SELECT key, name, status FROM agents ORDER BY sort");
  const agentCounts = { running: 0, waiting: 0, completed: 0, failed: 0, idle: 0 };
  for (const agent of agentRows) {
    if (["working", "thinking", "running"].includes(agent.status)) agentCounts.running += 1;
    else if (agent.status === "waiting") agentCounts.waiting += 1;
    else {
      const latest = latestTaskByAgent.get(agent.key);
      if (latest?.status === "failed") agentCounts.failed += 1;
      else if (latest?.status === "completed") agentCounts.completed += 1;
      else agentCounts.idle += 1;
    }
  }
  const agentDistribution: PieSlice[] = [
    { label: "Running", value: agentCounts.running, detail: "Currently executing or thinking", tone: "cyan" },
    { label: "Waiting", value: agentCounts.waiting, detail: "Waiting for a tool or intervention", tone: "amber" },
    { label: "Idle", value: agentCounts.idle, detail: "No active task in this window", tone: "muted" },
    { label: "Completed latest task", value: agentCounts.completed, detail: "Last task completed; agent is idle", tone: "accent" },
    { label: "Failed latest task", value: agentCounts.failed, detail: "Last task failed; agent is idle", tone: "danger" },
  ];

  // B. Actual inference usage by provider.
  const providerRows = all<{ provider: string; calls: number; tokens: number }>(
    `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(total_tokens), 0) AS tokens
     FROM provider_usage WHERE date(created_at) BETWEEN ? AND ? GROUP BY provider ORDER BY calls DESC`,
    [from, to],
  );
  // Every actual inference call is represented, even when an older provider
  // returned no token metadata. Token totals are reconciled separately below.
  const providerMetric: "tokens" | "calls" = "calls";
  const providerDistribution: PieSlice[] = providerRows.map((row) => ({
    label: providerLabel(row.provider),
    value: Number(row.calls),
    detail: `${Number(row.calls).toLocaleString("en-GB")} call(s) · ${Number(row.tokens).toLocaleString("en-GB")} tokens`,
    tone: providerTone(row.provider),
  }));

  // C. Model usage, including input/output and percentage of total tokens.
  const modelRows = all<{
    provider: string; model: string; calls: number; input_tokens: number; output_tokens: number; total_tokens: number;
  }>(
    `SELECT provider, model, COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
            COALESCE(SUM(completion_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens
     FROM provider_usage WHERE date(created_at) BETWEEN ? AND ?
     GROUP BY provider, model ORDER BY total_tokens DESC, calls DESC`,
    [from, to],
  );
  const allModelTokens = modelRows.reduce((sum, row) => sum + Number(row.total_tokens), 0);
  const modelUsage: ModelUsage[] = modelRows.map((row) => ({
    provider: providerLabel(row.provider),
    model: row.model,
    calls: Number(row.calls),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    percentage: safePercent(Number(row.total_tokens), allModelTokens),
  }));

  // D. Task outcomes and per-agent completion ranking.
  const taskStatusRows = all<{ agent_key: string; status: string; c: number }>(
    "SELECT agent_key, status, COUNT(*) AS c FROM tasks WHERE date(created_at) BETWEEN ? AND ? GROUP BY agent_key, status",
    [from, to],
  );
  const productivityMap = new Map<string, { completed: number; failed: number; other: number }>();
  const totals = { completed: 0, failed: 0, other: 0 };
  for (const row of taskStatusRows) {
    const item = productivityMap.get(row.agent_key) ?? { completed: 0, failed: 0, other: 0 };
    if (row.status === "completed") {
      item.completed += Number(row.c);
      totals.completed += Number(row.c);
    } else if (row.status === "failed") {
      item.failed += Number(row.c);
      totals.failed += Number(row.c);
    } else {
      item.other += Number(row.c);
      totals.other += Number(row.c);
    }
    productivityMap.set(row.agent_key, item);
  }
  const productivity: PieSlice[] = [
    { label: "Successful tasks", value: totals.completed, detail: "Completed task records", tone: "accent" },
    { label: "Failed tasks", value: totals.failed, detail: "Recorded failures", tone: "danger" },
    { label: "Other outcomes", value: totals.other, detail: "Queued, cancelled or in progress", tone: "muted" },
  ];
  const names = new Map(agentRows.map((row) => [row.key, row.name]));
  const productivityRanking = [...productivityMap.entries()]
    .map(([key, value]) => ({ name: names.get(key) ?? key, ...value }))
    .sort((a, b) => b.completed - a.completed || b.failed - a.failed);

  // E. Recruitment funnel. Verified means confirmation evidence, never merely
  // prepared or attempted.
  const discovered = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ?",
    [from, to],
  )?.c ?? 0;
  const classified = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ? AND match_score IS NOT NULL",
    [from, to],
  )?.c ?? 0;
  const eligible = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ? AND eligibility = 'eligible'",
    [from, to],
  )?.c ?? 0;
  const qualified = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ? AND qualified = 1 AND COALESCE(match_score, 0) >= ?",
    [from, to, policy.minMatchScore],
  )?.c ?? 0;
  const prepared = one<{ c: number }>(
    `SELECT COUNT(DISTINCT job_id) AS c FROM documents
     WHERE kind IN ('tailored_cv','cover_letter') AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?`,
    [from, to],
  )?.c ?? 0;
  const attempted = one<{ c: number }>(
    `SELECT COUNT(DISTINCT id) AS c FROM (
       SELECT application_id AS id FROM submission_attempts WHERE date(attempted_at) BETWEEN ? AND ?
       UNION SELECT id FROM applications WHERE date(submitted_at) BETWEEN ? AND ?
     )`,
    [from, to, from, to],
  )?.c ?? 0;
  const verified = one<{ c: number }>(
    `SELECT COUNT(DISTINCT id) AS c FROM (
       SELECT application_id AS id FROM submission_attempts
         WHERE status = 'verified' AND date(attempted_at) BETWEEN ? AND ?
       UNION SELECT id FROM applications
         WHERE (submission_status = 'verified' OR (status = 'submitted' AND confirmation IS NOT NULL))
           AND (date(submitted_at) BETWEEN ? AND ? OR date(last_update) BETWEEN ? AND ?)
     )`,
    [from, to, from, to, from, to],
  )?.c ?? 0;
  const funnel: TimePoint[] = [
    { label: "Vacancies discovered", value: Number(discovered) },
    { label: "Vacancies classified", value: Number(classified) },
    { label: "Eligible vacancies", value: Number(eligible) },
    { label: `Qualified matches (≥${policy.minMatchScore}%)`, value: Number(qualified) },
    { label: "Applications prepared", value: Number(prepared) },
    { label: "Applications attempted", value: Number(attempted) },
    { label: "Verified submissions", value: Number(verified) },
  ];

  // F. Mutually exclusive application outcomes.
  const applicationRows = all<{
    status: string; submission_status: string | null; submitted_at: string | null; confirmation: string | null;
  }>(
    "SELECT status, submission_status, submitted_at, confirmation FROM applications WHERE date(last_update) BETWEEN ? AND ?",
    [from, to],
  );
  const outcomeCounts = { verified: 0, unverified: 0, blocked: 0, awaiting: 0, inProgress: 0 };
  for (const app of applicationRows) {
    if (app.submission_status === "blocked" || app.submission_status === "failed") outcomeCounts.blocked += 1;
    else if (app.status === "human_intervention_required" || app.status === "awaiting_approval" || app.submission_status === "awaiting_approval") outcomeCounts.awaiting += 1;
    else if (app.submission_status === "unverified" || app.status === "submission_unverified") outcomeCounts.unverified += 1;
    else if (app.submission_status === "verified" || (app.status === "submitted" && Boolean(app.confirmation)) || (app.status === "acknowledged" && Boolean(app.submitted_at))) outcomeCounts.verified += 1;
    else if (app.status === "acknowledged" || app.status === "submitted") outcomeCounts.unverified += 1;
    else outcomeCounts.inProgress += 1;
  }
  const outcomes: PieSlice[] = [
    { label: "Verified submissions", value: outcomeCounts.verified, detail: "Employer confirmation recorded", tone: "accent" },
    { label: "Unverified submissions", value: outcomeCounts.unverified, detail: "Attempted or acknowledged without confirmation evidence", tone: "amber" },
    { label: "Blocked submissions", value: outcomeCounts.blocked, detail: "Policy or portal blocker", tone: "danger" },
    { label: "Awaiting intervention", value: outcomeCounts.awaiting, detail: "Needs an owner answer or approval", tone: "violet" },
    { label: "In progress", value: outcomeCounts.inProgress, detail: "Prepared or being prepared; not submitted", tone: "muted" },
  ];
  const outcomesTotal = applicationRows.length;

  // G. Daily/weekly time series, from the same range.
  const vacanciesByDay = groupedByDay(
    "SELECT date(discovered_at) AS d, COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ? GROUP BY d",
    from,
    to,
  );
  const preparedByDay = groupedByDay(
    "SELECT date(created_at) AS d, COUNT(DISTINCT job_id) AS c FROM documents WHERE kind IN ('tailored_cv','cover_letter') AND deleted_at IS NULL AND date(created_at) BETWEEN ? AND ? GROUP BY d",
    from,
    to,
  );
  const verifiedByDay = groupedByDay(
    "SELECT date(submitted_at) AS d, COUNT(DISTINCT id) AS c FROM applications WHERE submitted_at IS NOT NULL AND (submission_status = 'verified' OR (status = 'submitted' AND confirmation IS NOT NULL)) AND date(submitted_at) BETWEEN ? AND ? GROUP BY d",
    from,
    to,
  );
  const tasksByDay = groupedByDay(
    "SELECT date(created_at) AS d, COUNT(*) AS c FROM tasks WHERE date(created_at) BETWEEN ? AND ? GROUP BY d",
    from,
    to,
  );
  const tokensByDay = groupedByDay(
    "SELECT date(created_at) AS d, COALESCE(SUM(total_tokens), 0) AS c FROM provider_usage WHERE date(created_at) BETWEEN ? AND ? GROUP BY d",
    from,
    to,
  );
  const trends = {
    vacancies: montlyOrDailySeries(from, to, vacanciesByDay, weekly),
    prepared: montlyOrDailySeries(from, to, preparedByDay, weekly),
    verified: montlyOrDailySeries(from, to, verifiedByDay, weekly),
    tasks: montlyOrDailySeries(from, to, tasksByDay, weekly),
    tokens: montlyOrDailySeries(from, to, tokensByDay, weekly),
  };
  const weeklySeries = {
    vacancies: montlyOrDailySeries(from, to, vacanciesByDay, true),
    prepared: montlyOrDailySeries(from, to, preparedByDay, true),
    verified: montlyOrDailySeries(from, to, verifiedByDay, true),
    tasks: montlyOrDailySeries(from, to, tasksByDay, true),
    tokens: montlyOrDailySeries(from, to, tokensByDay, true),
  };

  // H. Token totals, provenance and cost.
  const tokenRow = one<{
    calls: number; input: number; output: number; total: number; cached: number; measured: number; estimated: number;
    unknown: number; local: number; external: number; failed: number;
  }>(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS input,
            COALESCE(SUM(completion_tokens), 0) AS output,
            COALESCE(SUM(total_tokens), 0) AS total,
            COALESCE(SUM(cached_tokens), 0) AS cached,
            COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
            COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
            COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown,
            COALESCE(SUM(CASE WHEN provider = 'ollama' THEN total_tokens ELSE 0 END), 0) AS local,
            COALESCE(SUM(CASE WHEN provider != 'ollama' THEN total_tokens ELSE 0 END), 0) AS external,
            COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failed
     FROM provider_usage WHERE date(created_at) BETWEEN ? AND ?`,
    [from, to],
  );
  const breakdownSql = (group: string) => all<{
    provider: string; model: string; agent_key: string; calls: number; input_tokens: number; output_tokens: number;
    total_tokens: number; measured: number; estimated: number; unknown: number;
  }>(
    `SELECT provider, model, agent_key, COUNT(*) AS calls,
            COALESCE(SUM(prompt_tokens), 0) AS input_tokens,
            COALESCE(SUM(completion_tokens), 0) AS output_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
            COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
            COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown
     FROM provider_usage WHERE date(created_at) BETWEEN ? AND ?
     GROUP BY ${group} ORDER BY total_tokens DESC, calls DESC`,
    [from, to],
  );
  const tokenTotal = Number(tokenRow?.total ?? 0);
  const byAgent = tokenBreakdown(breakdownSql("agent_key")).map((row) => ({
    ...row,
    percentage: safePercent(row.totalTokens, tokenTotal),
  }));
  const byProvider = tokenBreakdown(breakdownSql("provider")).map((row) => ({
    ...row,
    percentage: safePercent(row.totalTokens, tokenTotal),
  }));
  const byModel = tokenBreakdown(breakdownSql("provider, model")).map((row) => ({
    ...row,
    percentage: safePercent(row.totalTokens, tokenTotal),
  }));

  return {
    range,
    generatedAt: new Date().toISOString(),
    agentDistribution,
    providerDistribution,
    providerMetric,
    modelUsage,
    productivity,
    productivityRanking,
    funnel,
    outcomes,
    outcomesTotal,
    trends,
    weekly: weeklySeries,
    tokens: {
      calls: Number(tokenRow?.calls ?? 0),
      input: Number(tokenRow?.input ?? 0),
      output: Number(tokenRow?.output ?? 0),
      total: tokenTotal,
      cached: Number(tokenRow?.cached ?? 0),
      providerReported: Number(tokenRow?.measured ?? 0),
      estimated: Number(tokenRow?.estimated ?? 0),
      unknown: Number(tokenRow?.unknown ?? 0),
      local: Number(tokenRow?.local ?? 0),
      external: Number(tokenRow?.external ?? 0),
      failedCalls: Number(tokenRow?.failed ?? 0),
      cost: "unverified",
      costDetail: "No provider in this deployment publishes a verified price. Local Ollama tokens are not an external API charge.",
      byAgent,
      byProvider,
      byModel,
    },
  };
}

export function analyticsRangeQuery(range: AnalyticsRange): string {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}&preset=${encodeURIComponent(range.preset)}`;
}
