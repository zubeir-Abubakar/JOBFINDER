import { requireAdmin } from "@/lib/auth";
import { PageHead, Flash } from "@/components/ui";
import { param, relativeTime } from "@/lib/format";
import { aiCounterReconciliation, aiUsageBySource, freeLlmPolicyIssue, providerBudget, providerHealth, recentUsage, usageSummary } from "@/lib/providers";
import { one } from "@/lib/db";
import { testProvidersAction } from "@/lib/actions/admin";
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
  const budget = providerBudget();
  const gateway = health.find((provider) => provider.name === "freellmapi");
  const legacy = health.filter((provider) => provider.name !== "freellmapi");
  const policyIssue = freeLlmPolicyIssue();
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
    openRouterEnabled: (process.env.OPENROUTER_ENABLED ?? "false") === "true",
    geminiLiveModel: process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live",
    geminiLiveVoice: process.env.GEMINI_LIVE_VOICE ?? "Charon",
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
        sub="FreeLLMAPI remains the only text-agent gateway. Gemini is used only by the separate real-time Live voice session; no text-agent fallback was added."
        actions={
          <form action={testProvidersAction}>
            <SubmitButton className="btn btn-primary" pendingLabel="Testing…">Test real generation</SubmitButton>
          </form>
        }
      />

      <section className="stats mb-4">
        <div className="stat"><div className="stat-label">Budget cap</div><div className="stat-value num">CHF {budget.toFixed(2)}</div><div className="stat-note">No billing path · cost unverified</div></div>
        <div className="stat"><div className="stat-label">Requests</div><div className="stat-value num">{summary.requests}</div><div className="stat-note">{summary.failures} failed</div></div>
        <div className="stat"><div className="stat-label">Tokens</div><div className="stat-value num">{summary.tokens.toLocaleString("en-GB")}</div><div className="stat-note">Tracked per agent</div></div>
        <div className="stat"><div className="stat-label">Execution</div><div className="stat-value num">{flags.sequential ? "Sequential" : "Parallel"}</div><div className="stat-note">Max {flags.retries} retries</div></div>
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
            <h2>FreeLLMAPI · primary gateway</h2>
            <p className="card-sub">{flags.freeLlmBase} · pinned model {flags.freeLlmModel || "not set"}</p>
          </div>
          <span className={`badge ${gateway?.available ? "badge-good" : gateway?.configured ? "badge-bad" : "badge-warn"}`}>
            {gateway?.available ? "connected" : gateway?.configured ? "unreachable" : "not configured"}
          </span>
        </div>
        <div className="card-body stack text-[12px]" style={{ gap: 8 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Health check</span><span>{gateway?.detail ?? "No result."}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last health check</span><span>{gateway?.checkedAt ? relativeTime(gateway.checkedAt) : "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Configured model</span><span className="num">{flags.freeLlmModel}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Resolved model (last call)</span><span className="num">{usage.find((row) => row.provider === "freellmapi" && row.status === "ok")?.model ?? "no successful call yet"}</span></div>
          <div className="between">
            <span style={{ color: "var(--muted)" }}>Model policy</span>
            <span className={`badge ${policyIssue ? "badge-bad" : "badge-good"}`}>{policyIssue ? "blocked" : "permitted"}</span>
          </div>            <div className="between">
              <span style={{ color: "var(--muted)" }}>AI task calls</span>
            <span className="num">{aiCounts.ok} ok{aiCounts.failed ? ` · ${aiCounts.failed} failed` : ""}</span>
          </div>
          <div className="between">
            <span style={{ color: "var(--muted)" }}>Cost basis</span>
            <span className="badge badge-warn" title="FreeLLMAPI publishes no pricing metadata, so spend cannot be verified">
              unverified · {summary.unverified} of {summary.requests} calls
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

      <div className="grid g2 mb-4">
        {legacy.map((provider) => (
          <section key={provider.name} className="card">
            <div className="card-head">
              <div>
                <h2>{provider.label}</h2>
                <p className="card-sub">{provider.model}</p>
              </div>
              <span className="badge badge-neutral">disabled by policy</span>
            </div>
            <div className="card-body stack text-[12px]" style={{ gap: 7 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Enabled</span><span>{provider.enabled ? "yes (unused)" : "no"}</span></div>
              <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>
                {provider.name === "gemini"
                  ? "Direct text fallback is disabled. This key is used only by the separate Gemini Live voice session."
                  : provider.detail}
              </p>
            </div>
          </section>
        ))}
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
                      <td><div className="cell-title">{row.provider}</div><div className="cell-sub">{row.model}</div></td>
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
            <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_MODEL</span><span>{flags.freeLlmModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>FREELLMAPI_ALLOWED_MODELS</span><span style={{ textAlign: "right" }}>{flags.allowedModels || "none (nothing permitted)"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Declared resolution aliases</span><span style={{ textAlign: "right" }}>{flags.modelAliases || "none (exact id only)"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Ollama</span><span className={`badge ${flags.ollamaEnabled ? "badge-warn" : "badge-good"}`}>{flags.ollamaEnabled ? "enabled (unused)" : "disabled"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OpenRouter</span><span className={`badge ${flags.openRouterEnabled ? "badge-warn" : "badge-good"}`}>{flags.openRouterEnabled ? "enabled (unused)" : "disabled"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_API_KEY</span><span className={`badge ${keys.gemini ? "badge-good" : "badge-neutral"}`}>{keys.gemini ? "set (Live voice)" : "not set"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_LIVE_MODEL</span><span className="num">{flags.geminiLiveModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_LIVE_VOICE</span><span>{flags.geminiLiveVoice}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Google OAuth</span><span className={`badge ${keys.googleOauth ? "badge-good" : "badge-neutral"}`}>{keys.googleOauth ? "set" : "not set"}</span></div>
            <div className="alert alert-info">
              FreeLLMAPI publishes no pricing metadata, so spend is recorded as <strong>unverified</strong>, never as verified zero.
              <code>auto</code> routing is refused because the upstream model is chosen after the request; a single catalogued model must be pinned in
              <code>FREELLMAPI_MODEL</code> and explicitly listed in <code>FREELLMAPI_ALLOWED_MODELS</code>. That allowlist can only narrow the permitted set — known
              billable vendor ids are refused even when listed ({flags.paidAllowed ? "AI_ALLOW_PAID_MODELS is currently true, which changes nothing" : "AI_ALLOW_PAID_MODELS is false"}).
              A resolved id that is neither the pinned id nor a declared resolution alias is discarded. If the gateway is unavailable the workflow pauses; nothing falls back to Gemini, OpenRouter or Ollama.
              The Gemini key is used only by the separate real-time Live voice session; it does not change the shared text-agent model.
            </div>
            <p className="hint">Ollama is disabled, so no local model is loaded and no local inference runs.</p>
          </div>
        </section>
      </div>
    </>
  );
}
