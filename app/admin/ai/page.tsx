import { requireAdmin } from "@/lib/auth";
import { PageHead, Flash } from "@/components/ui";
import { param, relativeTime } from "@/lib/format";
import { aiCounterReconciliation, aiUsageBySource, freeLlmConfigured, freeLlmPolicyIssue, gatewayCooldownStatus, ollamaEndpointLabel, providerHealth, recentUsage, usageSummary } from "@/lib/providers";
import { FREE_TIER_ELIGIBILITY_LABEL, FREE_TIER_STATE_LABEL, geminiLiveFreeTierStatus } from "@/lib/free-tier";
import { getSetting } from "@/lib/settings";
import { agentRouteTable } from "@/lib/agent-models";
import { providerHealthSnapshot } from "@/lib/provider-health";
import { evaluateAiPolicy, policyDashboard } from "@/lib/ai-spending-policy";
import { one } from "@/lib/db";
import { testOllamaAction, testProvidersAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function AdminAiPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const health = await providerHealth(true);
  const summary = usageSummary();
  const usage = recentUsage(15);
  const gateway = health.find((provider) => provider.name === "freellmapi");
  const ollama = health.find((provider) => provider.name === "ollama");
  const gemini = health.find((provider) => provider.name === "gemini");
  const openrouter = health.find((provider) => provider.name === "openrouter");
  const geminiPolicy = evaluateAiPolicy({ provider: "gemini", model: process.env.GEMINI_MODEL ?? null });
  const geminiAuthorised = geminiPolicy.allowed;
  const liveFreeTier = geminiLiveFreeTierStatus();
  const liveLastSession = getSetting<string | null>("live_voice_last_session", null);
  const cooldown = gatewayCooldownStatus();
  const routeHealth = providerHealthSnapshot();
  const lastSuccess = one<{ provider: string; model: string; created_at: string }>(
    "SELECT provider, model, created_at FROM provider_usage WHERE status = 'ok' ORDER BY id DESC LIMIT 1",
  );
  const lastFailure = one<{ provider: string; error: string | null; created_at: string }>(
    "SELECT provider, error, created_at FROM provider_usage WHERE status = 'error' ORDER BY id DESC LIMIT 1",
  );
  const lastFallback = one<{
    provider: string;
    model: string;
    error: string | null;
    fallback_from: string | null;
    fallback_reason: string | null;
    created_at: string;
  }>(
    "SELECT provider, model, error, fallback_from, fallback_reason, created_at FROM provider_usage WHERE fallback_reason IS NOT NULL ORDER BY id DESC LIMIT 1",
  );
  const policyIssue = freeLlmPolicyIssue();
  const ollamaGeneralInstalled = ollama?.available ? ollama.models.includes(process.env.OLLAMA_MODEL ?? "") : null;
  const ollamaCoderInstalled = ollama?.available ? ollama.models.includes(process.env.OLLAMA_CODER_MODEL ?? "") : null;
  const localPolicy = evaluateAiPolicy({ provider: "ollama", model: process.env.OLLAMA_MODEL ?? null });
  const fallbackConfigured = Boolean(process.env.OLLAMA_ENABLED === "true" && process.env.OLLAMA_MODEL && process.env.OLLAMA_CODER_MODEL);
  const fallbackEnabled = fallbackConfigured && localPolicy.allowed && ollama?.available === true && ollamaGeneralInstalled === true;
  const enforcement = policyDashboard();
  const freeTier = enforcement.free_tier;
  const agentRoutes = agentRouteTable();
  const activeProvider = gemini?.available ? gemini : gateway?.available ? gateway : ollama?.available && localPolicy.allowed ? ollama : null;
  const activeModel = activeProvider?.name === "gemini"
    ? process.env.GEMINI_MODEL ?? "not set"
    : activeProvider?.name === "freellmapi"
      ? process.env.FREELLMAPI_MODEL ?? "not set"
      : activeProvider?.name === "ollama"
        ? process.env.OLLAMA_MODEL ?? "not set"
        : "—";
  const aiCounts = one<{ ok: number; failed: number }>(
    "SELECT COALESCE(SUM(ai_success_count), 0) AS ok, COALESCE(SUM(ai_failure_count), 0) AS failed FROM agents",
  ) ?? { ok: 0, failed: 0 };
  const reconciliation = aiCounterReconciliation();
  const drift = reconciliation.reduce((total, row) => total + Math.abs(row.driftOk) + Math.abs(row.driftFailed), 0);
  const taskUsage = reconciliation.reduce(
    (total, row) => ({ ok: total.ok + Number(row.usageOk), failed: total.failed + Number(row.usageFailed) }),
    { ok: 0, failed: 0 },
  );
  const sourceUsage = aiUsageBySource().filter((row) => row.source !== "task");
  const flags = {
    primary: process.env.AI_PRIMARY_PROVIDER ?? "freellmapi",
    freeLlmModel: process.env.FREELLMAPI_MODEL ?? "not set",
    freeLlmBase: process.env.FREELLMAPI_BASE_URL ?? "not set",
    allowedModels: process.env.FREELLMAPI_ALLOWED_MODELS ?? "",
    modelAliases: process.env.FREELLMAPI_MODEL_ALIASES ?? "",
    retries: process.env.AI_MAX_RETRIES ?? "2",
    sequential: (process.env.AI_SEQUENTIAL_EXECUTION ?? "true") === "true",
    paidAllowed: (process.env.AI_ALLOW_PAID_MODELS ?? "false") === "true",
    ollamaEnabled: (process.env.OLLAMA_ENABLED ?? "false") === "true",
    ollamaBase: ollamaEndpointLabel(),
    ollamaModel: process.env.OLLAMA_MODEL ?? "not set",
    ollamaCoderModel: process.env.OLLAMA_CODER_MODEL ?? "not set",
    openRouterEnabled: (process.env.OPENROUTER_ENABLED ?? "false") === "true",
    openRouterModel: process.env.OPENROUTER_MODEL ?? "not set",
    openRouterAssigned: process.env.OPENROUTER_ASSIGNED_AGENTS ?? "",
    openRouterTtsEnabled: (process.env.OPENROUTER_TTS_ENABLED ?? "false") === "true",
    openRouterTtsModel: process.env.OPENROUTER_TTS_MODEL ?? "not set",
    openRouterTtsVoice: process.env.OPENROUTER_TTS_VOICE ?? "not set",
    openRouterTtsExpiresAt: process.env.OPENROUTER_TTS_EXPIRES_AT ?? "not set",
    geminiModel: process.env.GEMINI_MODEL ?? "not set",
    geminiLiveModel: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live",
    geminiLiveVoice: process.env.GEMINI_LIVE_VOICE ?? "Charon",
    visionModel: process.env.VISION_MODEL ?? process.env.GEMINI_MODEL ?? "not set",
    geminiAuthorised,
    geminiFreeTierVerified: (process.env.GEMINI_FREE_TIER_VERIFIED ?? "false") === "true",
    freeLlmFreeTierVerified: (process.env.FREELLMAPI_FREE_TIER_VERIFIED ?? "false") === "true",
  };
  const keys = {
    freeLlm: Boolean(process.env.FREELLMAPI_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    googleOauth: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  };

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      <PageHead
        title="AI provider health"
        sub="Verified free-tier capacity from Gemini and FreeLLMAPI is used first. A confirmed quota exhaustion moves to the other verified free tier, then loopback Ollama; paid models, paid endpoints and paid fallbacks are never used."
        actions={
          <>
            <form action={testOllamaAction}>
              <SubmitButton className="btn" pendingLabel="Probing Ollama…">Test Ollama connection</SubmitButton>
            </form>
            <form action={testProvidersAction}>
              <SubmitButton className="btn btn-primary" pendingLabel="Checking policy…">Test inference policy</SubmitButton>
            </form>
          </>
        }
      />

      <section className="card mb-4" style={{ borderColor: geminiAuthorised ? "var(--good)" : "var(--danger)" }}>
        <div className="card-head">
          <div>
            <h2>Policy: {enforcement.policy}</h2>
            <p className="card-sub">
              Gemini free tier: {FREE_TIER_STATE_LABEL[freeTier.gemini.state]} ({FREE_TIER_ELIGIBILITY_LABEL[freeTier.gemini.eligibility]}). FreeLLMAPI free tier: {FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]} ({FREE_TIER_ELIGIBILITY_LABEL[freeTier.freellmapi.eligibility]}).
              External spend is fixed at CHF 0.00; exhaustion pauses a provider and never upgrades the request to paid access. OpenRouter is limited to an exact provider-verified free model, and Chief speech uses only the exact HeyGen free model.
            </p>
          </div>
          <span className={`badge ${geminiAuthorised ? "badge-good" : "badge-bad"}`}>{geminiAuthorised ? "Gemini authorised" : "Gemini blocked"}</span>
        </div>
        <div className="card-body grid g2 text-[12px]" style={{ gap: 10 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Gemini text / vision free tier</span><span className={`badge ${geminiAuthorised ? "badge-good" : "badge-bad"}`}>{geminiAuthorised ? `${FREE_TIER_STATE_LABEL[freeTier.gemini.state]} · ${flags.geminiModel}` : FREE_TIER_STATE_LABEL[freeTier.gemini.state]}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>FreeLLMAPI free tier</span><span className={`badge ${freeTier.freellmapi.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]} · {flags.freeLlmModel}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Gemini Live voice free tier</span><span className={`badge ${liveFreeTier.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[liveFreeTier.state]} · {flags.geminiLiveModel}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Authorised local route</span><span className={`badge ${localPolicy.allowed ? "badge-good" : "badge-warn"}`}>{localPolicy.allowed ? `loopback Ollama · ${localPolicy.model}` : "none"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Policy decisions recorded</span><span className="num">{enforcement.total_decisions}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Blocked decisions</span><span className="num">{enforcement.blocked_decisions}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Network transmissions authorised</span><span className="num">{enforcement.transmitted_decisions}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>AI-dependent tasks waiting</span><span className="num">{enforcement.blocked_tasks.length}</span></div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Free-tier capacity · CHF 0.00 external spend</h2>
            <p className="card-sub">Free-tier capacity is used first. Confirmed exhaustion blocks that provider until its quota resets or availability is independently verified; it is never converted to a paid request.</p>
          </div>
          <span className={`badge ${freeTier.gemini.allowed || freeTier.freellmapi.allowed ? "badge-good" : "badge-warn"}`}>
            {freeTier.gemini.allowed || freeTier.freellmapi.allowed ? "free tier available" : "no external free tier"}
          </span>
        </div>
        <div className="card-body grid g2 text-[12px]" style={{ gap: 10 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Gemini</span><span className={`badge ${freeTier.gemini.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[freeTier.gemini.state]} · {FREE_TIER_ELIGIBILITY_LABEL[freeTier.gemini.eligibility]}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>FreeLLMAPI</span><span className={`badge ${freeTier.freellmapi.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]} · {FREE_TIER_ELIGIBILITY_LABEL[freeTier.freellmapi.eligibility]}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Ollama</span><span className={`badge ${freeTier.ollama.state === "local_available" ? "badge-good" : "badge-warn"}`}>{freeTier.ollama.state === "local_available" ? "LOCAL AVAILABLE" : "UNAVAILABLE"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Gemini reset</span><span>{freeTier.gemini.reset_at ? relativeTime(freeTier.gemini.reset_at) : "not exhausted"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>FreeLLMAPI reset</span><span>{freeTier.freellmapi.reset_at ? relativeTime(freeTier.freellmapi.reset_at) : "not exhausted"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Remaining capacity</span><span>not exposed by either provider</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Paid fallback permitted</span><span className="badge badge-good">never</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>External spend limit</span><span className="num">CHF {freeTier.external_spend_limit_chf.toFixed(2)}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last quota / rate-limit error</span><span style={{ textAlign: "right" }}>{freeTier.gemini.last_error?.message ?? freeTier.freellmapi.last_error?.message ?? "none recorded"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last free-tier success</span><span>{freeTier.gemini.last_success_at ? `Gemini · ${relativeTime(freeTier.gemini.last_success_at)}` : freeTier.freellmapi.last_success_at ? `FreeLLMAPI · ${relativeTime(freeTier.freellmapi.last_success_at)}` : "none recorded"}</span></div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div><h2>Agent free-tier assignments</h2><p className="card-sub">Configured model and preferred route per agent. Deterministic scoring, document gates and submission policy never depend on a model.</p></div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Agent</th><th>Preferred provider</th><th>Model</th><th>Gap / detail</th></tr></thead>
            <tbody>
              {agentRoutes.map((route) => (
                <tr key={route.agentKey}>
                  <td><div className="cell-title">{route.name}</div><div className="cell-sub">{route.agentKey}</div></td>
                  <td><span className={`badge ${route.gap ? "badge-bad" : "badge-good"}`}>{route.provider}</span></td>
                  <td className="num">{route.model ?? "not configured"}</td>
                  <td className="cell-sub">{route.gap ?? route.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="stats mb-4">
        <div className="stat"><div className="stat-label">Gemini billing</div><div className="stat-value">{geminiAuthorised ? "Free tier only" : "Blocked"}</div><div className="stat-note">CHF 0.00 external spend · no paid fallback</div></div>
        <div className="stat"><div className="stat-label">Requests</div><div className="stat-value num">{summary.requests}</div><div className="stat-note">{summary.failures} failed</div></div>
        <div className="stat"><div className="stat-label">Tokens</div><div className="stat-value num">{summary.tokens.toLocaleString("en-GB")}</div><div className="stat-note">Tracked per agent</div></div>
        <div className="stat"><div className="stat-label">Execution</div><div className="stat-value num">{flags.sequential ? "Sequential" : "Parallel"}</div><div className="stat-note">Bounded retries · local fallback</div></div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>AI telemetry reconciliation</h2>
            <p className="card-sub">Roster counters are a projection of task-bound provider calls. Conversation and health checks are recorded separately.</p>
          </div>
          <span className={`badge ${drift ? "badge-bad" : "badge-good"}`}>{drift ? `${drift} drift` : "in sync"}</span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 7 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Roster counters</span><span className="num">{aiCounts.ok} ok · {aiCounts.failed} failed</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Task-bound usage rows</span><span className="num">{taskUsage.ok} ok · {taskUsage.failed} failed</span></div>
          {sourceUsage.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {sourceUsage.map((row) => (
                <span key={`${row.source}-${row.status}`} className="chip">
                  {row.source.replace(/_/g, " ")}: {row.calls} {row.status}
                </span>
              ))}
            </div>
          ) : null}
          <div className="text-[11px] leading-relaxed" style={{ color: drift ? "var(--danger)" : "var(--muted)" }}>
            {drift
              ? "A counter does not match its recorded task calls. Restarting the server recomputes counters from provider_usage."
              : "Every task-bound model call is linked to a task id, and the roster counters equal those rows exactly."}
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Inference routing</h2>
            <p className="card-sub">Each agent prefers its assigned free-tier route, then the other verified free tier, then loopback Ollama. Authentication, configuration and paid-model failures fail closed.</p>
          </div>
          <span className={`badge ${activeProvider ? "badge-good" : "badge-bad"}`}>{activeProvider ? (activeProvider.name === "gemini" ? "Gemini route ready" : "local fallback ready") : "no healthy route"}</span>
        </div>
        <div className="card-body grid g2" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 7 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Authorised execution type</span><span>{activeProvider ? (activeProvider.name === "ollama" ? "local inference" : "verified free-tier external") : "none"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Active model</span><span className="num">{activeModel}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>External spend</span><span className="badge badge-good">CHF 0.00 · free tier only</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Cooldown status</span><span>{cooldown.remainingMs > 0 ? `${Math.ceil(cooldown.remainingMs / 1000)}s remaining` : "none"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last successful inference</span><span>{lastSuccess ? `${lastSuccess.provider}/${lastSuccess.model} · ${relativeTime(lastSuccess.created_at)}` : "none"}</span></div>
          </div>
          <div className="stack" style={{ gap: 7 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last provider failure</span><span>{lastFailure ? `${lastFailure.provider} · ${relativeTime(lastFailure.created_at)}` : "none"}</span></div>
            {lastFailure?.error ? <div className="text-[11px] leading-relaxed" style={{ color: "var(--danger)" }}>{lastFailure.error}</div> : null}
            {cooldown.remainingMs > 0 ? <div className="text-[11px] leading-relaxed" style={{ color: "var(--warn)" }}>Cooling down until {cooldown.until ? relativeTime(cooldown.until) : "soon"}. Reason: {cooldown.reason ?? "provider failure"}.</div> : null}
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last recorded fallback</span><span>{lastFallback ? `${lastFallback.fallback_from ?? "primary"} → ${lastFallback.provider}/${lastFallback.model}` : "none"}</span></div>
            {lastFallback?.fallback_reason ? <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>Reason: {lastFallback.fallback_reason}</div> : null}
            <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              A confirmed free-quota exhaustion moves to the other verified free tier, then loopback Ollama. Authentication, malformed-request and paid-model failures fail closed. Every blocked request is audited with network_transmitted = 0.
            </div>
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Blocked work and policy decisions</h2>
            <p className="card-sub">AI-dependent tasks remain blocked until an authorised inference route exists. No blocked request is transmitted or retried.</p>
          </div>
          <span className="badge badge-bad">{enforcement.blocked_decisions} blocked decision(s)</span>
        </div>
        <div className="card-body grid g2" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 7 }}>
            <div className="cell-title">Waiting for an authorised route</div>
            {enforcement.blocked_tasks.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>No blocked AI task is waiting.</p>
            ) : (
              enforcement.blocked_tasks.map((task) => (
                <div key={task.id} className="between" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div>
                    <div className="cell-title">{task.title}</div>
                    <div className="cell-sub">{task.agent_key} · {task.state_reason ?? "blocked by zero-spend policy"}</div>
                  </div>
                  <span className="badge badge-bad">blocked</span>
                </div>
              ))
            )}
          </div>
          <div className="stack" style={{ gap: 7 }}>
            <div className="cell-title">Recent blocked requests</div>
            {enforcement.recent_blocked.length === 0 ? (
              <p style={{ color: "var(--muted)" }}>No policy decision has been recorded yet.</p>
            ) : (
              enforcement.recent_blocked.map((decision) => (
                <div key={decision.correlation_id} className="between" style={{ alignItems: "flex-start", gap: 12 }}>
                  <div>
                    <div className="cell-title">{decision.provider} / {decision.model ?? "model not set"}</div>
                    <div className="cell-sub">{decision.block_reason ?? "External inference blocked"} · {relativeTime(decision.created_at)}</div>
                  </div>
                  <span className="badge badge-bad">not sent</span>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Route health</h2>
            <p className="card-sub">Persisted per-model failure state. Cooling routes are not retried until their cooldown expires.</p>
          </div>
          <span className={`badge ${routeHealth.length ? "badge-warn" : "badge-good"}`}>
            {routeHealth.length ? `${routeHealth.length} route(s) limited` : "all clear"}
          </span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 7 }}>
          {routeHealth.length === 0 ? (
            <p style={{ color: "var(--muted)" }}>No failed or cooling Gemini/FreeLLMAPI/Ollama route is recorded.</p>
          ) : (
            routeHealth.map((route) => (
              <div key={`${route.provider}-${route.model}`} className="between" style={{ alignItems: "flex-start", gap: 12 }}>
                <div>
                  <div className="cell-title">{route.provider} / {route.model}</div>
                  <div className="cell-sub">{route.kind?.replace(/_/g, " ") ?? route.status}{route.reason ? ` · ${route.reason.slice(0, 180)}` : ""}</div>
                </div>
                <span className={`badge ${route.remainingMs > 0 ? "badge-warn" : "badge-bad"}`}>
                  {route.remainingMs > 0
                    ? `${Math.ceil(route.remainingMs / 1000)}s cooldown`
                    : route.status.replace(/_/g, " ")}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card mb-4" style={{ borderColor: geminiAuthorised ? "var(--good)" : "var(--warn)" }}>
        <div className="card-head">
          <div>
            <h2>Google Gemini · free-tier text and vision</h2>
            <p className="card-sub">Text <span className="num">{flags.geminiModel}</span> · vision <span className="num">{flags.visionModel}</span> · Chief voice Charon via Live <span className="num">{flags.geminiLiveModel}</span></p>
          </div>
          <span className={`badge ${geminiAuthorised ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[freeTier.gemini.state]}</span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 8 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Text and vision policy</span><span className={`badge ${geminiAuthorised ? "badge-good" : "badge-bad"}`}>{geminiAuthorised ? "allowed · verified free tier" : "blocked before transmission"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Gemini Live voice policy</span><span className={`badge ${liveFreeTier.allowed ? "badge-good" : "badge-bad"}`}>{liveFreeTier.allowed ? "verified free tier · allowed" : "blocked before transmission"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Chief voice identity</span><span className="badge badge-good">Charon · Gemini Live</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last Live session started</span><span>{liveLastSession ? relativeTime(liveLastSession) : "none recorded"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Verified by successful call</span><span className={`badge ${gemini?.available ? "badge-good" : "badge-warn"}`}>{gemini?.available ? "yes" : "not yet"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Health detail</span><span style={{ textAlign: "right" }}>{gemini?.detail ?? "No health result."}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last successful Gemini call</span><span>{usage.find((row) => row.provider === "gemini" && row.status === "ok") ? `${usage.find((row) => row.provider === "gemini" && row.status === "ok")!.model} · ${relativeTime(usage.find((row) => row.provider === "gemini" && row.status === "ok")!.created_at)}` : "none recorded"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last Gemini failure</span><span>{usage.find((row) => row.provider === "gemini" && row.status === "error")?.error ?? "none recorded"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Billing</span><span className="badge badge-good">free tier · external spend CHF 0.00</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_API_KEY</span><span className={`badge ${keys.gemini ? "badge-good" : "badge-bad"}`}>{keys.gemini ? "set" : "not set"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_FREE_TIER_VERIFIED</span><span className={`badge ${flags.geminiFreeTierVerified ? "badge-good" : "badge-warn"}`}>{flags.geminiFreeTierVerified ? "true" : "false"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_PAID_AUTHORISED (legacy)</span><span className="badge badge-neutral">ignored · cannot authorise paid voice</span></div>
          <p className="hint">Gemini Live uses the same free-tier-only gate as text: the account must be declared free-tier and the Live model must carry a published free-tier price. Chief remains Charon and the first voice contact; no paid voice fallback or local speech substitute is claimed.</p>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>FreeLLMAPI · free-tier gateway</h2>
            <p className="card-sub">{flags.freeLlmBase} · pinned model {flags.freeLlmModel || "not set"}</p>
          </div>
          <span className={`badge ${freeTier.freellmapi.allowed ? "badge-good" : gateway?.configured ? "badge-warn" : "badge-neutral"}`}>
            {freeTier.freellmapi.allowed ? "FREE TIER AVAILABLE" : FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]}
          </span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 8 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Actual execution type</span><span>external gateway · pinned free-tier model only</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>External routing possible</span><span className="badge badge-warn">gateway-side only · pinned id enforced</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Free-tier verification</span><span className={`badge ${flags.freeLlmFreeTierVerified ? "badge-good" : "badge-bad"}`}>{flags.freeLlmFreeTierVerified ? "declared + model-policy checked" : "unverified"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Inference decision</span><span className={`badge ${freeTier.freellmapi.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]} · CHF 0.00</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Metadata check</span><span>{gateway?.detail ?? "No result."}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last health check</span><span>{gateway?.checkedAt ? relativeTime(gateway.checkedAt) : "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Configured model</span><span className="num">{flags.freeLlmModel}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Resolved model (last call)</span><span className="num">{usage.find((row) => row.provider === "freellmapi" && row.status === "ok")?.model ?? "no successful call yet"}</span></div>
          <div className="between">
            <span style={{ color: "var(--muted)" }}>Model policy</span>
            <span className={`badge ${policyIssue || !freeTier.freellmapi.allowed ? "badge-bad" : "badge-good"}`}>{policyIssue ? "name policy rejected" : freeTier.freellmapi.allowed ? "name policy passes · free tier available" : `name policy passes · ${FREE_TIER_STATE_LABEL[freeTier.freellmapi.state]}`}</span>
          </div>            <div className="between">
              <span style={{ color: "var(--muted)" }}>AI task calls</span>
            <span className="num">{aiCounts.ok} ok{aiCounts.failed ? ` · ${aiCounts.failed} failed` : ""}</span>
          </div>
          <div className="between">
            <span style={{ color: "var(--muted)" }}>Cost basis</span>
            <span className="badge badge-good" title="Only declared free-tier capacity is used; the external spend limit stays CHF 0.00">
              free tier only · CHF 0.00 · {summary.unverified} of {summary.requests} calls unverified
            </span>
          </div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Model returned by catalogue</span><span className="num">{gateway?.model ?? "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Latency</span><span className="num">{gateway?.latencyMs == null ? "—" : `${gateway.latencyMs} ms`}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Models available</span><span className="num">{gateway?.models.length ?? 0}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_API_KEY</span><span className={`badge ${keys.freeLlm ? "badge-good" : "badge-bad"}`}>{keys.freeLlm ? "set" : "not set"}</span></div>
          {gateway && gateway.models.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {gateway.models.slice(0, 8).map((model) => <span key={model} className="chip">{model}</span>)}
              {gateway.models.length > 8 ? <span className="chip">+{gateway.models.length - 8}</span> : null}
            </div>
          ) : null}
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Ollama · local fallback</h2>
            <p className="card-sub">{flags.ollamaBase} · general <span className="num">{flags.ollamaModel}</span> · coding <span className="num">{flags.ollamaCoderModel}</span></p>
          </div>            <span className={`badge ${ollama?.available ? "badge-good" : ollama?.configured ? "badge-warn" : "badge-neutral"}`}>
            {ollama?.available ? "healthy" : ollama?.configured ? "configured but unavailable" : "not configured"}
          </span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 8 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Health check</span><span>{ollama?.detail ?? "No result."}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last health check</span><span>{ollama?.checkedAt ? relativeTime(ollama.checkedAt) : "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Enabled</span><span className={`badge ${flags.ollamaEnabled ? "badge-good" : "badge-warn"}`}>{flags.ollamaEnabled ? "yes" : "no"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>General model installed</span><span className={`badge ${ollamaGeneralInstalled === true ? "badge-good" : ollamaGeneralInstalled === false ? "badge-bad" : "badge-neutral"}`}>{ollamaGeneralInstalled === null ? "unknown" : ollamaGeneralInstalled ? "yes" : "no"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Coding model installed</span><span className={`badge ${ollamaCoderInstalled === true ? "badge-good" : ollamaCoderInstalled === false ? "badge-bad" : "badge-neutral"}`}>{ollamaCoderInstalled === null ? "unknown" : ollamaCoderInstalled ? "yes" : "no"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Latency</span><span className="num">{ollama?.latencyMs == null ? "—" : `${ollama.latencyMs} ms`}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Installed models</span><span className="num">{ollama?.available ? ollama.models.length : "not checked"}</span></div>
          {ollama && ollama.models.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {ollama.models.slice(0, 12).map((model) => <span key={model} className="chip">{model}</span>)}
              {ollama.models.length > 12 ? <span className="chip">+{ollama.models.length - 12}</span> : null}
            </div>
          ) : null}
          {ollama?.detail?.includes("ollama pull") ? (
            <div className="alert alert-info"><code>{ollama.detail}</code></div>
          ) : null}
          <p className="hint">Local-only fallback. A remote deployment needs a separately reachable, authenticated Ollama endpoint; do not expose port 11434 publicly. No model is downloaded automatically.</p>
        </div>
      </section>

      <div className="grid g2 mb-4">
        {openrouter ? (
          <section className="card">
            <div className="card-head">
              <div>
                <h2>{openrouter.label}</h2>
                <p className="card-sub">{openrouter.model || "no text model configured"}</p>
              </div>
              <span className={`badge ${openrouter.available ? "badge-good" : "badge-warn"}`}>
                {openrouter.available ? "provider verified" : "blocked"}
              </span>
            </div>
            <div className="card-body stack text-[12px]" style={{ gap: 7 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Enabled</span><span>{openrouter.enabled ? "yes" : "no"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Assigned agents</span><span>{flags.openRouterAssigned || "none"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>HeyGen speech</span><span>{openrouter.tts?.valid ? "available" : "blocked"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Free speech expiry</span><span>{openrouter.tts?.expiresAt ?? flags.openRouterTtsExpiresAt}</span></div>
              <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>{openrouter.detail}</p>
            </div>
          </section>
        ) : null}
      </div>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <div><h2>Provider usage</h2><p className="card-sub">Every generation attempt, including failures. Prompts and completions are not logged.</p></div>
          </div>
          <div className="table-wrap">
            {usage.length === 0 ? (
              <div className="empty">No provider calls yet. Run a workflow or use “Test real generation”.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Provider</th><th>Agent</th><th>Attribution</th><th>Tokens</th><th>Latency</th><th>Cost</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {usage.map((row, index) => (
                    <tr key={`${row.created_at}-${index}`}>
                      <td><div className="cell-title">{row.provider}</div><div className="cell-sub">{row.model}</div>{row.fallback_reason ? <div className="cell-sub">fallback: {row.fallback_reason.slice(0, 140)}</div> : null}</td>
                      <td className="cell-sub">{row.agent_key}</td>
                      <td className="cell-sub">
                        <div>{row.task_id ?? "—"}</div>
                        <div className="text-[10px]" style={{ color: "var(--muted)" }}>{row.source ?? "unattributed"}</div>
                      </td>
                      <td className="num">{row.total_tokens}</td>
                      <td className="num">{row.latency_ms} ms</td>
                      <td className="cell-sub">
                        {row.cost_status ?? "unverified"}
                        {row.routed_platform ? ` · ${row.routed_platform}` : ""}
                      </td>
                      <td><span className={`badge ${row.status === "ok" ? "badge-good" : "badge-bad"}`}>{row.status}</span></td>
                      <td className="cell-sub">{relativeTime(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Policy & credentials</h2><p className="card-sub">Environment-managed. Secrets are never rendered.</p></div></div>
          <div className="card-body stack text-[12px]" style={{ gap: 8 }}>
            <div className="between"><span style={{ color: "var(--muted)" }}>AI_PRIMARY_PROVIDER</span><span>{flags.primary}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_MODEL</span><span className="num">{flags.geminiModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>VISION_MODEL</span><span className="num">{flags.visionModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_FREE_TIER_VERIFIED</span><span className={`badge ${flags.geminiFreeTierVerified ? "badge-good" : "badge-warn"}`}>{flags.geminiFreeTierVerified ? "true" : "false"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_PAID_AUTHORISED (legacy)</span><span className="badge badge-neutral">ignored · paid voice never permitted</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI Live free tier</span><span className={`badge ${liveFreeTier.allowed ? "badge-good" : "badge-bad"}`}>{FREE_TIER_STATE_LABEL[liveFreeTier.state]} · {FREE_TIER_ELIGIBILITY_LABEL[liveFreeTier.eligibility]}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_FREE_TIER_VERIFIED</span><span className={`badge ${flags.freeLlmFreeTierVerified ? "badge-good" : "badge-warn"}`}>{flags.freeLlmFreeTierVerified ? "true" : "false"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_MODEL</span><span>{flags.freeLlmModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_ALLOWED_MODELS</span><span style={{ textAlign: "right" }}>{flags.allowedModels || "none (nothing permitted)"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Declared resolution aliases</span><span style={{ textAlign: "right" }}>{flags.modelAliases || "none (exact id only)"}</span></div>              <div className="between"><span style={{ color: "var(--muted)" }}>Ollama fallback</span><span className={`badge ${fallbackEnabled ? "badge-good" : fallbackConfigured ? "badge-warn" : "badge-neutral"}`}>{fallbackEnabled ? `ready · ${flags.ollamaModel}` : fallbackConfigured ? "configured · not ready" : "disabled"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Ollama coder fallback</span><span className={`badge ${ollamaCoderInstalled === true ? "badge-good" : ollamaCoderInstalled === false ? "badge-bad" : "badge-neutral"}`}>{ollamaCoderInstalled === true ? `${flags.ollamaCoderModel} · installed` : ollamaCoderInstalled === false ? `${flags.ollamaCoderModel} · missing` : `${flags.ollamaCoderModel} · unknown`}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OpenRouter</span><span className={`badge ${openrouter?.available ? "badge-good" : flags.openRouterEnabled ? "badge-warn" : "badge-neutral"}`}>{openrouter?.available ? "available · provider verified" : flags.openRouterEnabled ? "configured · blocked" : "disabled"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OPENROUTER_MODEL</span><span className="num">{flags.openRouterModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OpenRouter assignments</span><span>{flags.openRouterAssigned || "none (existing eight unchanged)"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>HeyGen free speech</span><span className={`badge ${openrouter?.tts?.valid ? "badge-good" : flags.openRouterTtsEnabled ? "badge-bad" : "badge-neutral"}`}>{openrouter?.tts?.valid ? "available · provider verified" : flags.openRouterTtsEnabled ? "blocked" : "disabled"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OPENROUTER_TTS_MODEL</span><span className="num">{flags.openRouterTtsModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>HeyGen voice / expiry</span><span>{flags.openRouterTtsVoice} · {flags.openRouterTtsExpiresAt}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_API_KEY</span><span className={`badge ${keys.gemini && geminiAuthorised ? "badge-good" : keys.gemini ? "badge-warn" : "badge-neutral"}`}>{keys.gemini ? (geminiAuthorised ? "set · free tier" : "set · free-tier unverified") : "not set"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_LIVE_MODEL</span><span className="num">{flags.geminiLiveModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_LIVE_VOICE</span><span>{flags.geminiLiveVoice}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Google OAuth</span><span className={`badge ${keys.googleOauth ? "badge-good" : "badge-neutral"}`}>{keys.googleOauth ? "set" : "not set"}</span></div>
            <div className="alert alert-info">
              Only verified free-tier capacity is used; the external spend limit remains <strong>CHF 0.00</strong>.
              <code>auto</code> routing is refused because the upstream model is chosen after the request; a single catalogued model must be pinned in
              <code>FREELLMAPI_MODEL</code> and explicitly listed in <code>FREELLMAPI_ALLOWED_MODELS</code>. That allowlist can only narrow the permitted set — known
              billable vendor ids are refused even when listed ({flags.paidAllowed ? "AI_ALLOW_PAID_MODELS is currently true, which changes nothing" : "AI_ALLOW_PAID_MODELS is false"}).
              A resolved id that is neither the pinned id nor a declared resolution alias is discarded. Gemini free tier and FreeLLMAPI free tier require an explicit verification flag;
              if either free-tier status is uncertain the route is blocked before transmission. A confirmed quota exhaustion pauses that provider and never becomes a paid request.
              Genuine route failures move to the other verified free tier, then loopback Ollama; authentication, configuration and paid-model failures fail closed. No CHF charge is invented.
              OpenRouter text is opt-in per agent through <code>OPENROUTER_ASSIGNED_AGENTS</code>; only an exact catalogued <code>:free</code> model is allowed, and the authenticated key plus zero pricing are checked before transmission. Chief speech uses only <code>heygen/heygen-voice-1-turbo:free</code>, restricted to the <code>heygen</code> provider; it retires on 30 November 2026 and is never upgraded to the paid model.
            </div>
            <p className="hint">Ollama uses OLLAMA_MODEL for general inference and OLLAMA_CODER_MODEL only for coding-specific calls. Only loopback endpoints (localhost, 127.0.0.1, ::1) are authorised; a non-loopback Ollama URL is blocked. Never expose port 11434 publicly.</p>
          </div>
        </section>
      </div>
    </>
  );
}
