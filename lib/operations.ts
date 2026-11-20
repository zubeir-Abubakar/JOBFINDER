import { all, one, schemaVersion } from "./db";
import { AGENT_DEFINITIONS, agentDefinition, type AgentKey } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import { agentAvailability } from "./agent-availability";
import { configuredTextProvider, gatewayCooldownStatus, providerHealth, providerStatusSnapshot, type ProviderHealth } from "./providers";
import { getRecruitmentPolicy, dailySubmissionUsage } from "./recruitment-policy";
import { formatInZone, scheduleSnapshot } from "./recruitment-schedule";
import { sourceHealth } from "./recruitment-discovery";
import { accountStatus, gmailMissing } from "./gmail";
import { getSetting } from "./settings";
import { voiceProfileForAgent } from "./agent-voices";
import { capabilitiesForAgent, permissionBrief, type AgentCapability } from "./agent-capabilities";
import { notificationQueueSnapshot } from "./notify";
import { recoverySnapshot } from "./recruitment-recovery";
import { nextProviderRetryAt, providerHealthSnapshot } from "./provider-health";
import { deliveryStateMessage } from "./notify";
import { latestExecutiveBriefDelivery } from "./executive-brief";
import { operationalHealthSnapshot } from "./runtime-health";

/**
 * Read-only operational intelligence.
 *
 * Every value is read from the live database, provider health checks or the
 * current process. The coordinator never has to invent agent counts, model
 * assignments, token totals, permissions or recruitment state.
 */

export type OperationalAgent = {
  key: AgentKey;
  name: string;
  role: string;
  description: string;
  enabled: boolean;
  status: string;
  currentTask: string | null;
  lastCompletedTask: string | null;
  lastTaskAt: string | null;
  lastActivityAt: string | null;
  provider: string | null;
  model: string | null;
  configuredProvider: string | null;
  configuredModel: string | null;
  configuredProviderStatus: string;
  providerStatus: string;
  fallbackActive: boolean;
  lastError: string | null;
  lastProviderError: string | null;
  lastProviderErrorAt: string | null;
  lastSuccessfulInferenceAt: string | null;
  /** Upstream platform/model reported by FreeLLMAPI for the latest call. */
  lastRoutedPlatform: string | null;
  lastRoutedModel: string | null;
  /** Failed task-bound attempts today; each one caused a bounded retry. */
  retryCount: number;
  fallbackHistory: Array<{ at: string; model: string; reason: string | null }>;
  lastTaskOutcome: string | null;
  lastTaskTitle: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  aiSuccessCount: number;
  aiFailureCount: number;
  tokenUsageToday: number;
  tools: string[];
  voice: ReturnType<typeof voiceProfileForAgent>;
  availability: { available: boolean; dependency: string | null; reason: string | null };
  capabilities: AgentCapability[];
  usageSource: string | null;
};

export type OperationalProvider = {
  name: string;
  label: string;
  configured: boolean;
  available: boolean | null;
  model: string;
  detail: string;
  latencyMs: number | null;
  checkedAt: string | null;
  active: boolean;
};

export type TokenTotals = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  providerReportedTokens: number;
  estimatedTokens: number;
  unknownSourceTokens: number;
  failedRequests: number;
  localTokens: number;
  externalTokens: number;
  costChf: number;
  costStatus: "unverified";
  costDetail: string;
};

export type OperationalSnapshot = {
  generatedAt: string;
  server: { status: "operational"; uptimeSeconds: number; node: string; pid: number };
  database: { ok: boolean; schemaVersion: number; detail: string };
  agents: OperationalAgent[];
  activeAgentCount: number;
  idleAgentCount: number;
  agentCount: number;
  providers: OperationalProvider[];
  providerRoute: ReturnType<typeof providerStatusSnapshot>;
  gatewayCooldown: ReturnType<typeof gatewayCooldownStatus>;
  providerCooldowns: ReturnType<typeof providerHealthSnapshot>;
  nextProviderRetryAt: string | null;
  notifications: ReturnType<typeof notificationQueueSnapshot>;
  executiveBrief: ReturnType<typeof latestExecutiveBriefDelivery>;
  recovery: ReturnType<typeof recoverySnapshot>;
  runtime: ReturnType<typeof operationalHealthSnapshot>;
  emailTest: { status?: string; messageId?: string | null; delivery?: string | null; detail?: string; at?: string } | null;
  geminiLive: {
    configured: boolean;
    model: string;
    lastSessionAt: string | null;
    detail: string;
    connectedClaim: "configured" | "not configured";
  };
  tokens: {
    today: TokenTotals;
    byAgent: Array<{ agentKey: string; name: string; totalTokens: number; requests: number }>;
    byProvider: Array<{ provider: string; totalTokens: number; requests: number; local: boolean }>;
    lastRequest: { provider: string; model: string; promptTokens: number; completionTokens: number; totalTokens: number; at: string } | null;
    context: { lastPromptTokens: number | null; contextLimit: null; detail: string };
  };
  recruitment: {
    policy: ReturnType<typeof getRecruitmentPolicy>;
    dailyUsage: ReturnType<typeof dailySubmissionUsage>;
    approvalMode: boolean;
    submissionEndpointConfigured: boolean;
    counts: {
      jobs: number;
      jobsToday: number;
      eligible: number;
      qualified: number;
      rejected: number;
      strong: number;
      prepared: number;
      awaitingApproval: number;
      attempted: number;
      submittedVerified: number;
      unverified: number;
      blocked: number;
      interventionsOpen: number;
    };
    lastRun: {
      id: string;
      status: string;
      trigger: string;
      startedAt: string | null;
      finishedAt: string | null;
      discovered: number;
      eligible: number;
      qualified: number;
      prepared: number;
      submitted: number;
      unverified: number;
      interventions: number;
      failures: number;
      warnings: number;
      error: string | null;
      agents: Array<{
        agentKey: string;
        assignment: string;
        status: string;
        provider: string | null;
        model: string | null;
        error: string | null;
        finishedAt: string | null;
      }>;
    } | null;
    scheduler: ReturnType<typeof scheduleSnapshot> & { running: boolean };
    sources: Array<{ key: string; name: string; enabled: boolean; healthy: number; failing: number; lastError: string | null }>;
    recentBlocked: Array<{ applicationId: string; question: string; reason: string; status: string; createdAt: string }>;
  };
  health: {
    status: "operational" | "degraded" | "down";
    detail: string;
    openInterventions: number;
    failedTasksToday: number;
    recentErrors: Array<{ agentKey: string; title: string; error: string | null; at: string }>;
    notificationProvider: { provider: "gmail"; connected: boolean; configured: boolean; detail: string; lastSyncAt: string | null; lastAcceptedAt: string | null; lastError: string | null };
    backup: { enabled: boolean; lastBackupAt: string | null; status: "healthy" | "stale" | "never" | "disabled"; detail: string };
  };
  permissions: {
    summary: string;
    byAgent: Array<{ agentKey: string; name: string; capabilities: AgentCapability[] }>;
  };
  credentials: {
    freeLlmApiKeyConfigured: boolean;
    ollamaEnabled: boolean;
    geminiLiveKeyConfigured: boolean;
    gmailConnected: boolean;
    submissionEndpointConfigured: boolean;
    detail: string;
  };
};

function latestTasks(): Map<string, {
  id: string;
  title: string;
  status: string;
  provider: string | null;
  model: string | null;
  created_at: string;
  finished_at: string | null;
  error: string | null;
  execution_mode: string | null;
  ai_outcome: string | null;
}> {
  const rows = all<{
    id: string; agent_key: string; title: string; status: string; provider: string | null; model: string | null;
    created_at: string; finished_at: string | null; error: string | null; execution_mode: string | null; ai_outcome: string | null;
  }>("SELECT id, agent_key, title, status, provider, model, created_at, finished_at, error, execution_mode, ai_outcome FROM tasks ORDER BY created_at DESC LIMIT 160");
  const map = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!map.has(row.agent_key)) map.set(row.agent_key, row);
  return map;
}

type UsageRow = {
  agent_key: string;
  provider: string;
  model: string;
  total_tokens: number;
  status: string;
  error: string | null;
  created_at: string;
  usage_source: string | null;
  routed_platform: string | null;
  routed_model: string | null;
};

function latestUsage(): Map<string, { last: UsageRow; success: UsageRow | null; error: UsageRow | null }> {
  // Gemini Live is voice telemetry, not a text route. Historical Gemini and
  // OpenRouter text rows are retained in the database but cannot masquerade as
  // the current text assignment or current provider error.
  const rows = all<UsageRow>(
    "SELECT agent_key, provider, model, total_tokens, status, error, created_at, usage_source, routed_platform, routed_model FROM provider_usage WHERE provider IN ('freellmapi','ollama') ORDER BY id DESC LIMIT 800",
  );
  const map = new Map<string, { last: UsageRow; success: UsageRow | null; error: UsageRow | null }>();
  for (const row of rows) {
    const current = map.get(row.agent_key);
    if (!current) {
      map.set(row.agent_key, { last: row, success: row.status === "ok" ? row : null, error: row.status !== "ok" ? row : null });
      continue;
    }
    if (!current.success && row.status === "ok") current.success = row;
    if (!current.error && row.status !== "ok") current.error = row;
  }
  return map;
}

function startOfToday(): string {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function tokenTotals(where = "created_at >= ?", params: unknown[] = [startOfToday()]): TokenTotals {
  const row = one<{
    requests: number; prompt: number; completion: number; total: number; cached: number;
    measured: number; estimated: number; unknown: number; failed: number; local: number; external: number; cost: number;
  }>(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(prompt_tokens), 0) AS prompt,
            COALESCE(SUM(completion_tokens), 0) AS completion,
            COALESCE(SUM(total_tokens), 0) AS total,
            COALESCE(SUM(cached_tokens), 0) AS cached,
            COALESCE(SUM(CASE WHEN usage_source = 'provider' THEN total_tokens ELSE 0 END), 0) AS measured,
            COALESCE(SUM(CASE WHEN usage_source = 'estimated' THEN total_tokens ELSE 0 END), 0) AS estimated,
            COALESCE(SUM(CASE WHEN usage_source IS NULL OR usage_source NOT IN ('provider','estimated') THEN total_tokens ELSE 0 END), 0) AS unknown,
            COALESCE(SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END), 0) AS failed,
            COALESCE(SUM(CASE WHEN provider = 'ollama' THEN total_tokens ELSE 0 END), 0) AS local,
            COALESCE(SUM(CASE WHEN provider != 'ollama' THEN total_tokens ELSE 0 END), 0) AS external,
            COALESCE(SUM(cost_chf), 0) AS cost
     FROM provider_usage WHERE ${where}`,
    params,
  );
  return {
    requests: Number(row?.requests ?? 0),
    promptTokens: Number(row?.prompt ?? 0),
    completionTokens: Number(row?.completion ?? 0),
    totalTokens: Number(row?.total ?? 0),
    cachedTokens: Number(row?.cached ?? 0),
    providerReportedTokens: Number(row?.measured ?? 0),
    estimatedTokens: Number(row?.estimated ?? 0),
    unknownSourceTokens: Number(row?.unknown ?? 0),
    failedRequests: Number(row?.failed ?? 0),
    localTokens: Number(row?.local ?? 0),
    externalTokens: Number(row?.external ?? 0),
    costChf: Number(row?.cost ?? 0),
    costStatus: "unverified",
    costDetail: "FreeLLMAPI publishes no pricing metadata. Cost is unverified; Ollama local inference is not a paid API cost.",
  };
}

function providerHealthFor(health: ProviderHealth[], provider: string | null): string {
  if (!provider) return "not used yet";
  const item = health.find((entry) => entry.name === provider);
  if (!item) return "unknown";
  if (item.available) return item.name === "ollama" ? "connected (local fallback)" : "connected";
  if (item.configured) return "configured but unavailable";
  return "not configured";
}

function currentStatus(row: { enabled: number; status: string }, availability: { available: boolean }): string {
  if (row.enabled !== 1) return "disabled";
  if (row.status === "paused") return "paused";
  if (["working", "thinking", "waiting"].includes(row.status)) return row.status;
  if (!availability.available) return "unavailable";
  // Completed and failed are task outcomes, never the current availability.
  // With no active assignment the agent is idle; its last outcome is separate.
  return "idle";
}

export async function getOperationalSnapshot(options: { forceHealth?: boolean } = {}): Promise<OperationalSnapshot> {
  const health = await providerHealth(Boolean(options.forceHealth));
  const tasks = latestTasks();
  const usage = latestUsage();
  const agentRows = all<{
    key: string; name: string; role: string; description: string; enabled: number; status: string;
    current_task: string | null; last_run_at: string | null; run_count: number; success_count: number; failure_count: number;
    ai_success_count: number; ai_failure_count: number;
  }>(
    "SELECT key, name, role, description, enabled, status, current_task, last_run_at, run_count, success_count, failure_count, ai_success_count, ai_failure_count FROM agents ORDER BY sort",
  );
  const byAgentToday = all<{ agent_key: string; tokens: number; requests: number }>(
    `SELECT agent_key, COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests
     FROM provider_usage WHERE created_at >= ? GROUP BY agent_key ORDER BY tokens DESC`,
    [startOfToday()],
  );
  const byAgentMap = new Map(byAgentToday.map((row) => [row.agent_key, row]));
  const retryToday = new Map(
    all<{ agent_key: string; attempts: number }>(
      `SELECT agent_key, COUNT(*) AS attempts FROM provider_usage
       WHERE status = 'error' AND source = 'task' AND created_at >= ?
       GROUP BY agent_key`,
      [startOfToday()],
    ).map((row) => [row.agent_key, Number(row.attempts)]),
  );
  const fallbackRows = all<UsageRow>(
    `SELECT agent_key, provider, model, total_tokens, status, error, created_at, usage_source,
            routed_platform, routed_model
     FROM provider_usage
     WHERE provider = 'ollama' AND status = 'ok' AND created_at >= ?
     ORDER BY id DESC LIMIT 240`,
    [startOfToday()],
  );
  const fallbackHistory = new Map<string, OperationalAgent["fallbackHistory"]>();
  for (const row of fallbackRows) {
    const history = fallbackHistory.get(row.agent_key) ?? [];
    if (history.length < 3) history.push({ at: row.created_at, model: row.model, reason: row.error });
    fallbackHistory.set(row.agent_key, history);
  }
  const byProvider = all<{ provider: string; tokens: number; requests: number }>(
    `SELECT provider, COALESCE(SUM(total_tokens), 0) AS tokens, COUNT(*) AS requests
     FROM provider_usage WHERE created_at >= ? GROUP BY provider ORDER BY tokens DESC`,
    [startOfToday()],
  );
  const route = providerStatusSnapshot();
  const configured = configuredTextProvider();
  const fl = health.find((entry) => entry.name === "freellmapi");
  const ollama = health.find((entry) => entry.name === "ollama");

  const agents: OperationalAgent[] = agentRows.map((row) => {
    const definition = agentDefinition(row.key);
    const task = tasks.get(row.key) ?? null;
    const history = usage.get(row.key) ?? null;
    const use = history?.last ?? null;
    const availability = agentAvailability(row.key);
    const usageRow = byAgentMap.get(row.key);
    return {
      key: row.key as AgentKey,
      name: agentIdentity(row.key).name,
      role: agentIdentity(row.key).title,
      description: agentIdentity(row.key).responsibilities,
      enabled: row.enabled === 1,
      status: currentStatus(row, availability),
      currentTask: row.current_task,
      lastCompletedTask: task?.status === "completed" ? task.title : null,
      lastTaskAt: task?.finished_at ?? task?.created_at ?? null,
      lastActivityAt: row.last_run_at ?? use?.created_at ?? null,
      provider: use?.provider ?? null,
      model: use?.model ?? null,
      configuredProvider: configured.provider,
      configuredModel: configured.model,
      configuredProviderStatus: providerHealthFor(health, configured.provider),
      providerStatus: providerHealthFor(health, use?.provider ?? null),
      fallbackActive: Boolean(route.activeProvider && configured.provider && route.activeProvider !== configured.provider),
      lastError: task?.status === "failed" ? task.error : null,
      lastProviderError: history?.error?.error ?? null,
      lastProviderErrorAt: history?.error?.created_at ?? null,
      lastSuccessfulInferenceAt: history?.success?.created_at ?? null,
      lastRoutedPlatform: use?.routed_platform ?? null,
      lastRoutedModel: use?.routed_model ?? null,
      retryCount: retryToday.get(row.key) ?? 0,
      fallbackHistory: fallbackHistory.get(row.key) ?? [],
      lastTaskOutcome: task?.status ?? null,
      lastTaskTitle: task?.title ?? null,
      runCount: Number(row.run_count),
      successCount: Number(row.success_count),
      failureCount: Number(row.failure_count),
      aiSuccessCount: Number(row.ai_success_count),
      aiFailureCount: Number(row.ai_failure_count),
      tokenUsageToday: Number(usageRow?.tokens ?? 0),
      tools: definition?.tools ?? [],
      voice: voiceProfileForAgent(row.key),
      availability: {
        available: availability.available,
        dependency: availability.dependency,
        reason: availability.reason,
        cause: availability.cause ?? null,
      },
      capabilities: capabilitiesForAgent(row.key).map((capability) => ({ ...capability, usedInLastTask: null })),
      usageSource: use?.usage_source ?? null,
    };
  });

  const active = agents.filter((agent) => ["working", "thinking", "waiting"].includes(agent.status)).length;
  const idle = agents.filter((agent) => agent.status === "idle").length;

  const tokensToday = tokenTotals();
  const lastUsage = one<{ provider: string; model: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; created_at: string }>(
    "SELECT provider, model, prompt_tokens, completion_tokens, total_tokens, created_at FROM provider_usage WHERE provider IN ('freellmapi','ollama') ORDER BY id DESC LIMIT 1",
  );
  const providerCooldowns = providerHealthSnapshot();
  const notificationQueue = notificationQueueSnapshot();
  const executiveBrief = latestExecutiveBriefDelivery();
  const recoveryQueue = recoverySnapshot();
  const runtime = operationalHealthSnapshot();
  const emailTest = getSetting<OperationalSnapshot["emailTest"]>("email_test_last", null);

  const db = (() => {
    try {
      one("SELECT 1");
      return { ok: true, schemaVersion: schemaVersion(), detail: "SQLite reachable in WAL mode." };
    } catch (error) {
      return { ok: false, schemaVersion: 0, detail: error instanceof Error ? error.message : "Database check failed." };
    }
  })();

  const policy = getRecruitmentPolicy();
  const dailyUsage = dailySubmissionUsage();
  const schedule = scheduleSnapshot();
  const jobCounts = one<{ total: number; today: number; eligible: number; qualified: number; rejected: number; strong: number }>(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN date(discovered_at) = date('now') THEN 1 ELSE 0 END), 0) AS today,
            COALESCE(SUM(CASE WHEN eligibility_checked_at IS NOT NULL AND qualified = 1 THEN 1 ELSE 0 END), 0) AS eligible,
            COALESCE(SUM(CASE WHEN qualified = 1 THEN 1 ELSE 0 END), 0) AS qualified,
            COALESCE(SUM(CASE WHEN status = 'rejected' OR match_flag IN ('weak','not_suitable') THEN 1 ELSE 0 END), 0) AS rejected,
            COALESCE(SUM(CASE WHEN match_flag = 'strong' THEN 1 ELSE 0 END), 0) AS strong
     FROM jobs`,
  ) ?? { total: 0, today: 0, eligible: 0, qualified: 0, rejected: 0, strong: 0 };
  const appCounts = one<{ prepared: number; awaiting: number; attempted: number; verified: number; unverified: number; blocked: number }>(
    `SELECT COALESCE(SUM(CASE WHEN cv_document_id IS NOT NULL OR cover_letter_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS prepared,
            COALESCE(SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END), 0) AS awaiting,
            COALESCE(SUM(CASE WHEN submission_status IS NOT NULL AND submission_status != 'simulated' THEN 1 ELSE 0 END), 0) AS attempted,
            COALESCE(SUM(CASE WHEN submission_status = 'verified' OR (status = 'submitted' AND confirmation IS NOT NULL) THEN 1 ELSE 0 END), 0) AS verified,
            COALESCE(SUM(CASE WHEN submission_status = 'unverified' OR status = 'submission_unverified' THEN 1 ELSE 0 END), 0) AS unverified,
            COALESCE(SUM(CASE WHEN status = 'human_intervention_required' OR submission_status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked
     FROM applications`,
  ) ?? { prepared: 0, awaiting: 0, attempted: 0, verified: 0, unverified: 0, blocked: 0 };
  const interventions = one<{ c: number }>("SELECT COUNT(*) AS c FROM application_interventions WHERE status = 'open'")?.c ?? 0;
  const blocked = all<{ application_id: string; question: string; reason: string; status: string; created_at: string }>(
    "SELECT application_id, question, reason, status, created_at FROM application_interventions ORDER BY created_at DESC LIMIT 8",
  );
  const lastRun = one<{
    id: string; status: string; trigger: string; started_at: string | null; finished_at: string | null;
    jobs_discovered: number; jobs_eligible: number; jobs_qualified: number; packages_prepared: number;
    applications_submitted: number; applications_unverified: number; applications_intervention: number;
    failures: number; warnings: number; error: string | null;
  }>(
    `SELECT id, status, trigger, started_at, finished_at, jobs_discovered, jobs_eligible, jobs_qualified,
            packages_prepared, applications_submitted, applications_unverified, applications_intervention,
            failures, warnings, error
     FROM recruitment_runs ORDER BY created_at DESC LIMIT 1`,
  );
  const lastRunAgents = lastRun
    ? all<{ agent_key: string; assignment: string; status: string; provider: string | null; model: string | null; error: string | null; finished_at: string | null }>(
        "SELECT agent_key, assignment, status, provider, model, error, finished_at FROM recruitment_run_agents WHERE run_id = ? ORDER BY id DESC LIMIT 30",
        [lastRun.id],
      )
    : [];
  const sourceHealthRows = sourceHealth();
  const sources = all<{ key: string; name: string; enabled: number; url: string | null }>(
    "SELECT key, name, enabled, url FROM job_sources ORDER BY key",
  ).map((source) => {
    const checks = sourceHealthRows.filter((row) => row.source_key === source.key || row.source_key.startsWith(`${source.key}:`));
    return {
      key: source.key,
      name: source.name,
      enabled: source.enabled === 1,
      healthy: checks.filter((row) => row.ok === 1).length,
      failing: checks.filter((row) => row.ok !== 1).length,
      lastError: checks.find((row) => row.ok !== 1 && row.error)?.error ?? null,
    };
  });

  const failedTasks = all<{ agent_key: string; title: string; error: string | null; created_at: string }>(
    "SELECT agent_key, title, error, created_at FROM tasks WHERE status = 'failed' ORDER BY created_at DESC LIMIT 8",
  );
  const failedToday = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed' AND created_at >= ?",
    [startOfToday()],
  )?.c ?? 0;
  const gmail = accountStatus();
  const gmailIssues = gmailMissing();
  const backupSetting = getSetting<{ enabled?: boolean; last_backup_at?: string | null }>("backup", { enabled: true, last_backup_at: null });
  const backupEnabled = backupSetting.enabled !== false;
  const backupAge = backupSetting.last_backup_at ? Date.now() - Date.parse(backupSetting.last_backup_at) : Number.POSITIVE_INFINITY;
  const backupStatus: "healthy" | "stale" | "never" | "disabled" = !backupEnabled
    ? "disabled"
    : !backupSetting.last_backup_at || !Number.isFinite(backupAge)
      ? "never"
      : backupAge > 7 * 86400_000
        ? "stale"
        : "healthy";
  const backup = {
    enabled: backupEnabled,
    lastBackupAt: backupSetting.last_backup_at ?? null,
    status: backupStatus,
    detail: !backupEnabled
      ? "Automatic backup is disabled."
      : backupStatus === "never"
        ? "No completed backup has been recorded."
        : backupStatus === "stale"
          ? "The last recorded backup is older than seven days."
          : "A backup was recorded within the last seven days.",
  };
  const notificationProvider = {
    provider: "gmail" as const,
    connected: gmail.connected,
    configured: gmail.enabled && gmailIssues.length === 0,
    detail: !gmail.enabled ? "Gmail is disabled." : gmail.connected ? "Gmail account connected for reading, drafts and notification delivery." : "Gmail is not connected.",
    lastSyncAt: gmail.lastSyncAt,
    lastAcceptedAt: notificationQueue.lastAccepted?.finished_at ?? null,
    lastError: notificationQueue.lastError?.last_error ?? null,
  };

  const providers: OperationalProvider[] = health.map((item) => ({
    name: item.name,
    label: item.label,
    configured: item.configured,
    available: item.available,
    model: item.model,
    detail: item.detail,
    latencyMs: item.latencyMs,
    checkedAt: item.checkedAt ?? null,
    active: route.activeProvider === item.name,
  }));
  const liveConfigured = Boolean(process.env.GEMINI_API_KEY?.trim());
  const liveModel = (process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live").trim() || "gemini-3.8-live";
  const liveLast = getSetting<string | null>("live_voice_last_session", null);

  const overviewStatus: OperationalSnapshot["health"]["status"] = !db.ok
    ? "down"
    : route.available === true && agents.some((agent) => agent.availability.available)
      ? "operational"
      : "degraded";
  const healthDetail = overviewStatus === "operational"
    ? `${agents.length} agents registered; ${active} active, ${idle} idle. ${route.activeProvider ? `${route.activeProvider} is the active text route.` : "Text provider availability is not confirmed."}`
    : overviewStatus === "down"
      ? db.detail
      : "One or more dependencies are degraded; inspect provider and agent details.";

  return {
    generatedAt: new Date().toISOString(),
    server: { status: "operational", uptimeSeconds: Math.round(process.uptime()), node: process.version, pid: process.pid },
    database: db,
    agents,
    activeAgentCount: active,
    idleAgentCount: idle,
    agentCount: agents.length,
    providers,
    providerRoute: route,
    gatewayCooldown: gatewayCooldownStatus(),
    providerCooldowns,
    nextProviderRetryAt: nextProviderRetryAt(),
    notifications: notificationQueue,
    executiveBrief,
    recovery: recoveryQueue,
    runtime,
    emailTest,
    geminiLive: {
      configured: liveConfigured,
      model: liveModel,
      lastSessionAt: liveLast,
      detail: liveConfigured ? `Gemini Live is configured for ${liveModel}. An active socket is not claimed without a live session.` : "GEMINI_API_KEY is not configured; live voice is unavailable.",
      connectedClaim: liveConfigured ? "configured" : "not configured",
    },
    tokens: {
      today: tokensToday,
      byAgent: byAgentToday.map((row) => ({ agentKey: row.agent_key, name: agentIdentity(row.agent_key).shortName, totalTokens: Number(row.tokens), requests: Number(row.requests) })),
      byProvider: byProvider.map((row) => ({ provider: row.provider, totalTokens: Number(row.tokens), requests: Number(row.requests), local: row.provider === "ollama" })),
      lastRequest: lastUsage ? {
        provider: lastUsage.provider,
        model: lastUsage.model,
        promptTokens: Number(lastUsage.prompt_tokens),
        completionTokens: Number(lastUsage.completion_tokens),
        totalTokens: Number(lastUsage.total_tokens),
        at: lastUsage.created_at,
      } : null,
      context: {
        lastPromptTokens: lastUsage ? Number(lastUsage.prompt_tokens) : null,
        contextLimit: null,
        detail: "The providers do not expose a stable remaining-context counter. The last prompt token count is shown; no remaining-capacity figure is invented.",
      },
    },
    recruitment: {
      policy,
      dailyUsage,
      approvalMode: getSetting<boolean>("approval_mode", true),
      submissionEndpointConfigured: Boolean(process.env.RECRUITMENT_SUBMISSION_ENDPOINT?.trim()),
      counts: {
        jobs: Number(jobCounts.total),
        jobsToday: Number(jobCounts.today),
        eligible: Number(jobCounts.eligible),
        qualified: Number(jobCounts.qualified),
        rejected: Number(jobCounts.rejected),
        strong: Number(jobCounts.strong),
        prepared: Number(appCounts.prepared),
        awaitingApproval: Number(appCounts.awaiting),
        attempted: Number(appCounts.attempted),
        submittedVerified: Number(appCounts.verified),
        unverified: Number(appCounts.unverified),
        blocked: Number(appCounts.blocked),
        interventionsOpen: interventions,
      },
      lastRun: lastRun ? {
        id: lastRun.id,
        status: lastRun.status,
        trigger: lastRun.trigger,
        startedAt: lastRun.started_at,
        finishedAt: lastRun.finished_at,
        discovered: Number(lastRun.jobs_discovered),
        eligible: Number(lastRun.jobs_eligible),
        qualified: Number(lastRun.jobs_qualified),
        prepared: Number(lastRun.packages_prepared),
        submitted: Number(lastRun.applications_submitted),
        unverified: Number(lastRun.applications_unverified),
        interventions: Number(lastRun.applications_intervention),
        // Older runs predate accurate failure accounting. Use the stronger of
        // the stored counter and the terminal failed assignments so the
        // Coordinator never reports "0 failures" beside a failed coordinator row.
        failures: Math.max(Number(lastRun.failures), lastRunAgents.filter((row) => row.status === "failed").length),
        warnings: Number(lastRun.warnings),
        error: lastRun.error,
        agents: lastRunAgents.map((row) => ({
          agentKey: row.agent_key,
          assignment: row.assignment,
          status: row.status,
          provider: row.provider,
          model: row.model,
          error: row.error,
          finishedAt: row.finished_at,
        })),
      } : null,
      scheduler: { ...schedule, running: Boolean(getSetting<boolean>("recruitment_scheduler_running", true)) },
      sources,
      recentBlocked: blocked.map((row) => ({
        applicationId: row.application_id,
        question: row.question,
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at,
      })),
    },
    health: {
      status: overviewStatus,
      detail: healthDetail,
      openInterventions: interventions,
      failedTasksToday: Number(failedToday),
      recentErrors: failedTasks.map((row) => ({ agentKey: row.agent_key, title: row.title, error: row.error, at: row.created_at })),
      notificationProvider,
      backup,
    },
    permissions: {
      summary: permissionBrief(),
      byAgent: agents.map((agent) => ({ agentKey: agent.key, name: agent.name, title: agent.role, capabilities: agent.capabilities })),
    },
    credentials: {
      freeLlmApiKeyConfigured: Boolean(process.env.FREELLMAPI_API_KEY?.trim()),
      ollamaEnabled: (process.env.OLLAMA_ENABLED ?? "false") === "true",
      geminiLiveKeyConfigured: liveConfigured,
      gmailConnected: gmail.connected,
      submissionEndpointConfigured: Boolean(process.env.RECRUITMENT_SUBMISSION_ENDPOINT?.trim()),
      detail: "Only configuration booleans are exposed. Credential values are never returned.",
    },
  };
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}

/** Compact factual brief for a model prompt. */
export function operationsBrief(snapshot: OperationalSnapshot): string {
  const agentLines = snapshot.agents.map((agent) => {
    return `${agent.name} [${agent.key}] — role ${agent.role}; availability ${agent.availability.available ? "online" : `unavailable (${agent.availability.dependency}: ${agent.availability.reason})`}; task ${agent.status}${agent.currentTask ? ` on "${agent.currentTask}"` : " — no task assigned"}; last outcome ${agent.lastTaskOutcome ?? "none"}${agent.lastTaskTitle ? ` (${agent.lastTaskTitle})` : ""}; configured ${agent.configuredProvider ?? "not configured"}/${agent.configuredModel ?? "no model"} (${agent.configuredProviderStatus}); actual ${agent.provider ?? "not used yet"}/${agent.model ?? "no model"} (${agent.providerStatus}); last success ${agent.lastSuccessfulInferenceAt ?? "never"}; last provider error ${agent.lastProviderError ?? "none"}; upstream ${agent.lastRoutedPlatform ?? "not reported"}/${agent.lastRoutedModel ?? "not reported"}; retries today ${agent.retryCount}; fallback history ${agent.fallbackHistory.length ? agent.fallbackHistory.map((entry) => `${entry.model} at ${entry.at}`).join(", ") : "none"}; voice ${agent.voice.voiceId}; tokens today ${agent.tokenUsageToday.toLocaleString("en-GB")}; tools: ${agent.tools.join(", ") || "none"}.`;
  }).join("\n");
  const providerLines = snapshot.providers.map((provider) => {
    return `${provider.label}: configured=${provider.configured}, available=${provider.available === null ? "unchecked" : provider.available}, model=${provider.model}, ${provider.detail}${provider.active ? " ACTIVE" : ""}.`;
  }).join("\n");
  const agentTokens = snapshot.tokens.byAgent.map((row) => `${row.name}=${row.totalTokens.toLocaleString("en-GB")}`).join(", ") || "none";
  const providerTokens = snapshot.tokens.byProvider.map((row) => `${row.provider}=${row.totalTokens.toLocaleString("en-GB")}${row.local ? " (local)" : ""}`).join(", ") || "none";
  const scheduler = snapshot.recruitment.scheduler;
  const sources = snapshot.recruitment.sources.map((source) => `${source.name}=${source.enabled ? "enabled" : "disabled"} (${source.healthy} healthy, ${source.failing} failing${source.lastError ? `; ${source.lastError}` : ""})`).join("; ") || "none";
  return [
    `Generated at ${snapshot.generatedAt}. Server ${snapshot.server.status}, uptime ${snapshot.server.uptimeSeconds}s. Database ${snapshot.database.ok ? `OK, schema v${snapshot.database.schemaVersion}` : snapshot.database.detail}.`,
    `Workforce: ${snapshot.agentCount} registered; ${snapshot.activeAgentCount} active, ${snapshot.idleAgentCount} idle.`,
    agentLines,
    `Provider route: ${snapshot.providerRoute.activeProvider ?? "none"} / ${snapshot.providerRoute.activeModel ?? "no model"}; ${snapshot.providerRoute.detail}${snapshot.providerRoute.fallbackEnabled ? " Fallback enabled." : " Fallback disabled."}`,
    providerLines,
    `Gemini Live: ${snapshot.geminiLive.detail}${snapshot.geminiLive.lastSessionAt ? ` Last session: ${snapshot.geminiLive.lastSessionAt}.` : ""}`,
    `Tokens today: ${snapshot.tokens.today.totalTokens.toLocaleString("en-GB")} total (${snapshot.tokens.today.promptTokens.toLocaleString("en-GB")} input, ${snapshot.tokens.today.completionTokens.toLocaleString("en-GB")} output; ${snapshot.tokens.today.providerReportedTokens.toLocaleString("en-GB")} provider-reported, ${snapshot.tokens.today.estimatedTokens.toLocaleString("en-GB")} estimated, ${snapshot.tokens.today.unknownSourceTokens.toLocaleString("en-GB")} historical/unknown source). Local Ollama tokens ${snapshot.tokens.today.localTokens.toLocaleString("en-GB")}; external tokens ${snapshot.tokens.today.externalTokens.toLocaleString("en-GB")}. Cost is unverified, not zero.`,
    `Tokens by agent: ${agentTokens}. By provider: ${providerTokens}.`,
    `Recruitment: standing authorisation ${snapshot.recruitment.policy.active ? "ACTIVE" : "inactive"}; daily limit ${snapshot.recruitment.policy.maxSubmissionsPerDay}; verified today ${snapshot.recruitment.dailyUsage.verified}; approval mode ${snapshot.recruitment.approvalMode ? "on" : "off"}; threshold ${snapshot.recruitment.policy.minMatchScore}%. Counts: ${snapshot.recruitment.counts.jobs} vacancies, ${snapshot.recruitment.counts.qualified} qualified, ${snapshot.recruitment.counts.prepared} prepared, ${snapshot.recruitment.counts.awaitingApproval} awaiting approval, ${snapshot.recruitment.counts.submittedVerified} verified submissions, ${snapshot.recruitment.counts.unverified} unverified, ${snapshot.recruitment.counts.blocked} blocked, ${snapshot.recruitment.counts.interventionsOpen} open interventions.`,
    `Scheduler: ${scheduler.enabled ? "enabled" : "disabled"}; next ${formatInZone(scheduler.nextRunAt, scheduler.timezone)}; last status ${scheduler.lastStatus ?? "never"}; last error ${scheduler.lastError ?? "none"}.`,
    `Sources: ${sources}.`,
    `Health: ${snapshot.health.status}; ${snapshot.health.detail} Failed tasks today ${snapshot.health.failedTasksToday}. Notification provider: ${snapshot.health.notificationProvider.detail} Backup: ${snapshot.health.backup.status} — ${snapshot.health.backup.detail}`,
    `Latest recruitment run: ${snapshot.recruitment.lastRun ? `${snapshot.recruitment.lastRun.id} ${snapshot.recruitment.lastRun.status}, failures ${snapshot.recruitment.lastRun.failures}, warnings ${snapshot.recruitment.lastRun.warnings}, error ${snapshot.recruitment.lastRun.error ?? "none"}` : "none"}. Recovery pending ${snapshot.recovery.pending}; next retry ${snapshot.nextProviderRetryAt ?? snapshot.recovery.nextRetryAt ?? "none"}.`,
    `Runtime: database ${snapshot.runtime.database.integrity} v${snapshot.runtime.database.schemaVersion}; scheduler worker ${snapshot.runtime.scheduler.worker?.effectiveStatus ?? "missing"}; workers ${snapshot.runtime.workers.map((worker) => `${worker.name}=${worker.effectiveStatus}`).join(", ") || "none"}; running tasks ${snapshot.runtime.queues.runningTasks.length}; failed tasks today ${snapshot.runtime.agents.failedTasksToday}; notification failures ${snapshot.runtime.recruitment.notificationFailures}; submission failures ${snapshot.runtime.recruitment.submissionFailures}; unknown ${snapshot.runtime.recruitment.submissionUnknown}; last successful inference ${snapshot.runtime.providers.lastSuccessfulInferenceAt ?? "never"}.`,
    `Notification outbox: pending ${snapshot.notifications.counts.pending}, retry ${snapshot.notifications.counts.retry_scheduled}, accepted-by-Gmail ${snapshot.notifications.counts.sent}, failed ${snapshot.notifications.counts.failed}; last accepted ${snapshot.notifications.lastAccepted?.finished_at ?? "never"}; last error ${snapshot.notifications.lastError?.last_error ?? "none"}.`,
    `Executive Brief delivery: state=${snapshot.executiveBrief.state}; report=${snapshot.executiveBrief.reportId}; outbox=${snapshot.executiveBrief.outboxId ?? "none"}; gmailMessage=${snapshot.executiveBrief.messageId ?? "none"}; sentFolderObserved=${snapshot.executiveBrief.sentObservedAt ?? "no"}; evidence=${snapshot.executiveBrief.deliveryEvidence ?? "none"}; error=${snapshot.executiveBrief.lastError ?? "none"}. ${deliveryStateMessage(snapshot.executiveBrief.state, snapshot.executiveBrief.lastError ?? snapshot.executiveBrief.detail)}`,
    `Permissions: ${snapshot.permissions.summary}`,
  ].join("\n");
}

function agentByName(snapshot: OperationalSnapshot, value: string): OperationalAgent | null {
  const target = value.trim().toLowerCase();
  if (!target) return null;
  return snapshot.agents.find((agent) =>
    agent.key === target || agent.name.toLowerCase() === target || agent.voice.voiceId.toLowerCase() === target,
  ) ?? snapshot.agents.find((agent) => agent.name.toLowerCase().includes(target) || agent.role.toLowerCase().includes(target)) ?? null;
}

/** Deterministic answers for direct operational questions; used with or without an LLM. */
export function answerFromOperations(
  message: string,
  snapshot: OperationalSnapshot,
  focusAgentKey?: AgentKey,
): string | null {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const asked = text.match(/\b(coordinator|research|analysis|cv|ats|cover|application|email)\b/)?.[1];
  const focusAgent = focusAgentKey
    ? agentByName(snapshot, focusAgentKey)
    : asked
      ? agentByName(snapshot, asked)
      : null;

  if (/\b(why|what)\b.*\b(run|recruitment)\b.*\b(fail|failed|partial|warning)|\b(latest|today'?s) run\b/.test(text)) {
    const r = snapshot.recruitment.lastRun;
    if (!r) return "No recruitment run has been recorded yet.";
    const failed = r.agents.filter((agent) => agent.status === "failed");
    const waiting = r.agents.filter((agent) => ["running", "queued", "retry_scheduled", "waiting_provider", "waiting_intervention"].includes(agent.status));
    return [
      `Latest run ${r.id} (${r.trigger}) is ${r.status}. Started ${r.startedAt ?? "unknown"}; finished ${r.finishedAt ?? "not finished"}. ${r.failures} failure(s), ${r.warnings} warning(s). Recorded run error: ${r.error ?? "none"}.`,
      `Stages: ${r.discovered} discovered, ${r.eligible} eligible, ${r.qualified} qualified, ${r.prepared} prepared, ${r.submitted} verified submissions, ${r.interventions} needing intervention.`,
      `Failed assignments: ${failed.length ? failed.map((agent) => `${agent.agentKey} — ${agent.assignment}: ${agent.error ?? "no error recorded"}`).join("; ") : "none"}.`,
      `Non-terminal assignments: ${waiting.length ? waiting.map((agent) => `${agent.agentKey} ${agent.status}`).join("; ") : "none"}. Recovery queue: ${snapshot.recovery.pending} pending, ${snapshot.recovery.waitingIntervention} waiting for intervention.`,
    ].join("\n");
  }

  if (/\b(quota|exhausted|rate.?limited|rate.?limit|cooldown|fallback|retry|waiting provider)\b/.test(text)) {
    const cooling = snapshot.providerCooldowns.filter((route) => route.remainingMs > 0);
    const ollama = snapshot.tokens.byProvider.find((row) => row.provider === "ollama");
    const lastFailed = snapshot.recruitment.lastRun?.agents.filter((agent) => agent.status === "failed") ?? [];
    return [
      `Provider routes cooling down: ${cooling.length ? cooling.map((route) => `${route.provider}/${route.model} ${route.kind ?? "failure"} for ${Math.ceil(route.remainingMs / 1000)}s (${route.reason ?? "no detail"})`).join("; ") : "none"}.`,
      `Latest run assignments that failed: ${lastFailed.length ? lastFailed.map((agent) => `${agent.agentKey}: ${agent.error ?? "no detail"}`).join("; ") : "none"}.`,
      `Ollama fallback usage today: ${ollama ? `${ollama.requests} request(s), ${ollama.totalTokens.toLocaleString("en-GB")} local tokens` : "none recorded"}.`,
      `Next provider retry: ${snapshot.nextProviderRetryAt ?? "none scheduled"}. Recovery retry: ${snapshot.recovery.nextRetryAt ?? "none scheduled"}.`,
    ].join("\n");
  }

  if (/\b(gmail|email|notification|daily report|executive brief|delivery)\b/.test(text) && /\b(sent|delivery|delivered|authenticated|auth|error|status|report|accepted|bounce|queued|folder)\b/.test(text)) {
    const brief = snapshot.executiveBrief;
    return [
      deliveryStateMessage(brief.state, brief.lastError ?? brief.detail),
      `Executive Brief: report ${brief.reportId}; outbox ${brief.outboxId ?? "not created"}; state ${brief.state}; Gmail message ${brief.messageId ?? "none"}; thread ${brief.threadId ?? "none"}; attempts ${brief.attempts}.`,
      `Sent-folder verification: ${brief.sentObservedAt ? `observed at ${brief.sentObservedAt} — ${brief.sentVerification ?? "presence recorded"}` : brief.sentVerification ?? "not observed"}. Delivery evidence: ${brief.deliveryEvidence ?? "none"}.`,
      `Last error: ${brief.lastError ?? "none"}. Next retry: ${brief.nextRetryAt ?? "none"}. Bounce evidence: ${brief.bounceInfo ?? "none"}.`,
      `Gmail: ${snapshot.health.notificationProvider.connected ? "connected" : "not connected"}; OAuth configuration ${snapshot.health.notificationProvider.configured ? "ready" : "incomplete"}. ${snapshot.health.notificationProvider.detail}`,
      `Outbox: ${snapshot.notifications.counts.pending} pending, ${snapshot.notifications.counts.retry_scheduled} retry scheduled, ${snapshot.notifications.counts.sent} accepted by Gmail, ${snapshot.notifications.counts.failed} failed.`,
    ].join("\n");
  }

  if (focusAgent && /\b(your|you|current status|working on|current task|assigned voice|provider|model|voice)\b/.test(text)) {
    return `${focusAgent.name} — ${focusAgent.role}: availability ${focusAgent.availability.available ? "online" : `unavailable (${focusAgent.availability.dependency}: ${focusAgent.availability.reason})`}; task ${focusAgent.status}${focusAgent.currentTask ? ` on “${focusAgent.currentTask}”` : " — no task assigned"}; last outcome ${focusAgent.lastTaskOutcome ?? "none"}${focusAgent.lastTaskTitle ? ` (${focusAgent.lastTaskTitle})` : ""}. Configured provider ${focusAgent.configuredProvider ?? "not configured"}${focusAgent.configuredModel ? ` / ${focusAgent.configuredModel}` : ""} (${focusAgent.configuredProviderStatus}). Actual provider ${focusAgent.provider ?? "not used yet"}${focusAgent.model ? ` / ${focusAgent.model}` : ""} (${focusAgent.providerStatus}). Assigned voice ${focusAgent.voice.voiceName}; tools: ${focusAgent.tools.join(", ") || "none"}. Tokens today ${focusAgent.tokenUsageToday.toLocaleString("en-GB")}; measurement ${focusAgent.usageSource === "provider" ? "provider-reported" : focusAgent.usageSource === "estimated" ? "estimated" : "unknown/not yet measured"}.`;
  }

  if (
    /\b(which|who)\b.*\b(agents?|workforce)\b.*\b(running|active|busy|idle|failed|working|waiting|offline|unavailable)\b/.test(text) ||
    /\b(which agent has failed|which agents are (running|idle|active)|what are the agents doing)\b/.test(text)
  ) {
    const describe = (agent: OperationalAgent) => `${agent.name} — ${agent.status}${agent.currentTask ? `: ${agent.currentTask}` : ""}${agent.lastTaskOutcome === "failed" ? `; last task failed: ${agent.lastTaskTitle ?? "unknown"}` : ""}`;
    const running = snapshot.agents.filter((agent) => ["working", "thinking", "waiting", "running"].includes(agent.status));
    const idle = snapshot.agents.filter((agent) => agent.status === "idle");
    const failed = snapshot.agents.filter((agent) => agent.lastTaskOutcome === "failed");
    return [
      `Running or waiting (${running.length}): ${running.map(describe).join("; ") || "none"}.`,
      `Idle — no task assigned (${idle.length}): ${idle.map((agent) => agent.name).join("; ") || "none"}.`,
      `Last task failed (${failed.length}): ${failed.map(describe).join("; ") || "none"}.`,
    ].join("\n");
  }

  if (/\b(how many agents|agent count|number of agents)\b/.test(text)) {
    return `${snapshot.agentCount} agents are registered. ${snapshot.activeAgentCount} are active and ${snapshot.idleAgentCount} are idle.`;
  }
  if (
    /\b(list|name|what are|which)\b.*\b(agents?|workforce)\b/.test(text) &&
    !/\b(working|active|busy|failed|idle|models?|providers?|voices?|tokens?|permissions?|tools?|status)\b/.test(text)
  ) {
    return snapshot.agents.map((agent) => `• ${agent.name} (${agent.key}) — ${agent.role}; ${agent.status}${agent.currentTask ? `: ${agent.currentTask}` : ""}; ${agent.provider ?? "provider not used yet"}${agent.model ? `/${agent.model}` : ""}; voice ${agent.voice.voiceId}.`).join("\n");
  }
  if (/\b(responsib|role of|what does each|what do the agents)\b/.test(text)) {
    return snapshot.agents.map((agent) => `• ${agent.name}: ${agent.description}`).join("\n");
  }
  if (/\b(provider|model|freellmapi|ollama|gemini live|fallback|external api|connected)\b/.test(text)) {
    if (asked) {
      const agent = agentByName(snapshot, asked);
      if (agent) return `${agent.name}: configured ${agent.configuredProvider ?? "no provider"}${agent.configuredModel ? ` / ${agent.configuredModel}` : ""} (${agent.configuredProviderStatus}); actual latest ${agent.provider ?? "not used yet"}${agent.model ? ` / ${agent.model}` : ""} (${agent.providerStatus}). Voice identity: ${agent.voice.voiceId}. Fallback active: ${agent.fallbackActive ? "yes" : "no"}.`;
    }
    const providerLines = snapshot.providers.map((provider) => `• ${provider.label}: ${provider.available === null ? "not checked" : provider.available ? "available" : "unavailable"}; configured ${provider.configured ? "yes" : "no"}; model ${provider.model}; ${provider.detail}${provider.active ? " ACTIVE" : ""}`);
    if (/\bollama\b/.test(text) && /\b(which|agents?|use|using)\b/.test(text)) {
      const ollamaAgents = snapshot.agents.filter((agent) => agent.provider === "ollama" || agent.configuredProvider === "ollama");
      return ollamaAgents.length > 0
        ? `Agents using Ollama: ${ollamaAgents.map((agent) => `${agent.name} (configured ${agent.configuredProvider ?? "none"}/${agent.configuredModel ?? "no model"}; actual latest ${agent.provider ?? "not used yet"}/${agent.model ?? "no model"})`).join("; ")}. Ollama is local and is not an external API charge.`
        : "No agent has used or been configured for Ollama in the live records.";
    }
    if (/\bexternal api/.test(text)) {
      const externalAgents = snapshot.agents.filter((agent) => agent.provider && agent.provider !== "ollama");
      return externalAgents.length > 0
        ? `Agents with external-API inference records: ${externalAgents.map((agent) => `${agent.name} (${agent.provider}/${agent.model ?? "no model"})`).join("; ")}. Remote provider token cost remains unverified.`
        : "No agent has an external-API inference record yet.";
    }
    const assignmentLines = snapshot.agents.map((agent) => {
      const configured = agent.configuredProvider ? `${agent.configuredProvider}/${agent.configuredModel ?? "no model"}` : "not configured";
      const actual = agent.provider ? `${agent.provider}/${agent.model ?? "no model"}` : "not used yet";
      return `• ${agent.name}: configured ${configured} (${agent.configuredProviderStatus}); actual latest ${actual} (${agent.providerStatus}); last success ${agent.lastSuccessfulInferenceAt ?? "never"}; last provider error ${agent.lastProviderError ?? "none"}.`;
    });
    return [
      `Active text route: ${snapshot.providerRoute.activeProvider ?? "none"}${snapshot.providerRoute.activeModel ? ` / ${snapshot.providerRoute.activeModel}` : ""}. Fallback ${snapshot.providerRoute.fallbackEnabled ? "enabled" : "disabled"}.`,
      ...providerLines,
      "Per-agent assignment (configured vs actual):",
      ...assignmentLines,
      `Gemini Live: ${snapshot.geminiLive.detail}${snapshot.geminiLive.lastSessionAt ? ` Last session ${snapshot.geminiLive.lastSessionAt}.` : ""}`,
    ].join("\n");
  }
  if (/\b(token|tokens|usage|cost|spend|expenditure|context capacity|free or paid|local inference|api tokens)\b/.test(text)) {
    const t = snapshot.tokens.today;
    const ranking = [...snapshot.tokens.byAgent].sort((a, b) => b.totalTokens - a.totalTokens);
    const summary = `Today: ${t.totalTokens.toLocaleString("en-GB")} tokens across ${t.requests} requests (${t.promptTokens.toLocaleString("en-GB")} input, ${t.completionTokens.toLocaleString("en-GB")} output). Provider-reported ${t.providerReportedTokens.toLocaleString("en-GB")}; estimated ${t.estimatedTokens.toLocaleString("en-GB")}; historical/unknown source ${t.unknownSourceTokens.toLocaleString("en-GB")}. Local Ollama ${t.localTokens.toLocaleString("en-GB")}; external ${t.externalTokens.toLocaleString("en-GB")}. Cost is unverified, not a measured zero.`;
    if (/\b(most|each agent|per agent|by agent|which agent)\b/.test(text)) {
      return `${summary} By agent: ${ranking.map((row) => `${row.name} ${row.totalTokens.toLocaleString("en-GB")} (${row.requests} calls)`).join("; ") || "none recorded"}.`;
    }
    return `${summary} Last prompt ${snapshot.tokens.context.lastPromptTokens ?? "unavailable"}; remaining context is not exposed by the provider.`;
  }
  const recruitmentIntent = /\b(recruit|scheduler|next run|submission|applications?|vacanc\w*|verified|unverified|blocked|discovery|source)\b/.test(text);
  if (!recruitmentIntent && /\b(health|healthy|system status|database|scheduler|next run|operational|degraded)\b/.test(text)) {
    const s = snapshot.recruitment.scheduler;
    return `System health is ${snapshot.runtime.status}. ${snapshot.runtime.detail} Database schema v${snapshot.runtime.database.schemaVersion} (${snapshot.runtime.database.integrity}). Scheduler ${s.enabled ? "enabled" : "disabled"}; next run ${formatInZone(s.nextRunAt, s.timezone)}; last status ${s.lastStatus ?? "never"}; ticker ${snapshot.runtime.scheduler.tickerRunning ? "running" : "not running"}; persisted worker ${snapshot.runtime.scheduler.worker?.effectiveStatus ?? "missing"}. Workers: ${snapshot.runtime.workers.map((worker) => `${worker.name} ${worker.effectiveStatus}`).join(", ") || "none"}. Notification provider: ${snapshot.health.notificationProvider.detail} Backup ${snapshot.health.backup.status}: ${snapshot.health.backup.detail} Gemini Live: ${snapshot.geminiLive.detail}`;
  }
  if (/\b(permissions?|capabilit(?:y|ies)|tools?|allowed|prohibit|can .* access|can .* send|can .* modify|shell|credentials?)\b/.test(text)) {
    return snapshot.permissions.summary;
  }
  if (/\b(recruit|standing authorisation|standing authorization|daily limit|approval mode|scheduler|next run|submission|applications?|application prepared|verified|unverified|blocked|vacanc\w*|discovery|source)\b/.test(text)) {
    const r = snapshot.recruitment;
    return [
      `Standing authorisation: ${r.policy.active ? "ACTIVE" : "inactive"} (activated ${r.policy.activatedAt ?? "never"}). Daily limit ${r.policy.maxSubmissionsPerDay}; verified today ${r.dailyUsage.verified}; remaining ${r.dailyUsage.remaining}. Approval mode ${r.approvalMode ? "on" : "off"}; threshold ${r.policy.minMatchScore}%.`,
      `Vacancies: ${r.counts.jobs} stored (${r.counts.jobsToday} today), ${r.counts.eligible} eligibility-checked, ${r.counts.qualified} qualified, ${r.counts.rejected} rejected.`,
      `Applications: ${r.counts.prepared} prepared, ${r.counts.attempted} attempted, ${r.counts.submittedVerified} verified submissions, ${r.counts.unverified} unverified, ${r.counts.blocked} blocked, ${r.counts.interventionsOpen} open interventions. Prepared is not submitted; unverified is not successful.`,
      `Scheduler ${r.scheduler.enabled ? "enabled" : "disabled"}; next ${formatInZone(r.scheduler.nextRunAt, r.scheduler.timezone)}.`,
      `CAPTCHA, MFA, login-required and paid forms are never bypassed; those applications queue for intervention.`,
    ].join("\n");
  }
  if (/\b(error|failed|failure|intervention|why was .* blocked|blocked)\b/.test(text)) {
    const errors = snapshot.health.recentErrors.slice(0, 3).map((error) => `• ${agentIdentity(error.agentKey).shortName}: ${error.title} — ${error.error ?? "no error recorded"}`).join("\n");
    const blocked = snapshot.recruitment.recentBlocked.slice(0, 3).map((row) => `• ${row.question}: ${row.reason}`).join("\n");
    return `Failed tasks today: ${snapshot.health.failedTasksToday}. Open interventions: ${snapshot.health.openInterventions}.${errors ? `\nRecent errors:\n${errors}` : ""}${blocked ? `\nRecent blocks:\n${blocked}` : ""}`;
  }
  return null;
}
