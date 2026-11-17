import { requireAdmin } from "@/lib/auth";
import { PageHead, Flash } from "@/components/ui";
import { param, relativeTime } from "@/lib/format";
import { providerBudget, providerHealth, recentUsage, usageSummary } from "@/lib/providers";
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
  const flags = {
    geminiModel: process.env.GEMINI_MODEL ?? "not set",
    openRouterModel: process.env.OPENROUTER_MODEL ?? "not set",
    openRouterPaid: (process.env.OPENROUTER_ALLOW_PAID_MODELS ?? "false") === "true",
    ollamaModel: process.env.OLLAMA_MODEL ?? "not set",
    ollamaCoder: process.env.OLLAMA_CODER_MODEL ?? "not set",
    retries: process.env.AI_MAX_RETRIES ?? "2",
    sequential: (process.env.AI_SEQUENTIAL_EXECUTION ?? "true") === "true",
    paidAllowed: (process.env.AI_ALLOW_PAID_MODELS ?? "false") === "true",
  };
  const keys = {
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    googleOauth: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  };

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      <PageHead
        title="AI provider health"
        sub="Shared provider service for all eight agents. Order: Gemini → OpenRouter free models → Ollama. Paid models are blocked."
        actions={
          <form action={testProvidersAction}>
            <SubmitButton className="btn btn-primary" pendingLabel="Testing…">Test real generation</SubmitButton>
          </form>
        }
      />

      <section className="stats mb-4">
        <div className="stat"><div className="stat-label">Spending limit</div><div className="stat-value num">CHF {budget.toFixed(2)}</div><div className="stat-note">Hard cap · paid models blocked</div></div>
        <div className="stat"><div className="stat-label">Requests</div><div className="stat-value num">{summary.requests}</div><div className="stat-note">{summary.failures} failed</div></div>
        <div className="stat"><div className="stat-label">Tokens</div><div className="stat-value num">{summary.tokens.toLocaleString("en-GB")}</div><div className="stat-note">Usage is tracked per agent</div></div>
        <div className="stat"><div className="stat-label">Execution</div><div className="stat-value num">{flags.sequential ? "Sequential" : "Parallel"}</div><div className="stat-note">Max {flags.retries} retries</div></div>
      </section>

      <div className="grid g2 mb-4">
        {health.map((provider) => (
          <section key={provider.name} className="card">
            <div className="card-head">
              <div>
                <h2>{provider.label}</h2>
                <p className="card-sub">{provider.model}</p>
              </div>
              <span className={`badge ${provider.available ? "badge-good" : provider.enabled ? "badge-bad" : "badge-neutral"}`}>
                {provider.available ? "available" : provider.enabled ? "unavailable" : "disabled"}
              </span>
            </div>
            <div className="card-body stack text-[12px]" style={{ gap: 7 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Configured</span><span>{provider.configured ? "yes" : "no"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Latency</span><span>{provider.latencyMs === null ? "—" : `${provider.latencyMs} ms`}</span></div>
              <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>{provider.detail}</p>
              {provider.models.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {provider.models.slice(0, 6).map((model) => <span key={model} className="chip">{model}</span>)}
                  {provider.models.length > 6 ? <span className="chip">+{provider.models.length - 6}</span> : null}
                </div>
              ) : null}
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
                <thead><tr><th>Provider</th><th>Agent</th><th>Tokens</th><th>Latency</th><th>Status</th><th>When</th></tr></thead>
                <tbody>
                  {usage.map((row, index) => (
                    <tr key={`${row.created_at}-${index}`}>
                      <td><div className="cell-title">{row.provider}</div><div className="cell-sub">{row.model}</div></td>
                      <td className="cell-sub">{row.agent_key}</td>
                      <td className="num">{row.total_tokens}</td>
                      <td className="num">{row.latency_ms} ms</td>
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
            <div className="between"><span style={{ color: "var(--muted)" }}>Gemini model</span><span>{flags.geminiModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OpenRouter model</span><span>{flags.openRouterModel}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Ollama models</span><span style={{ textAlign: "right" }}>{flags.ollamaModel} · {flags.ollamaCoder}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>GEMINI_API_KEY</span><span className={`badge ${keys.gemini ? "badge-good" : "badge-neutral"}`}>{keys.gemini ? "set" : "not set"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>OPENROUTER_API_KEY</span><span className={`badge ${keys.openrouter ? "badge-good" : "badge-neutral"}`}>{keys.openrouter ? "set" : "not set"}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Google OAuth</span><span className={`badge ${keys.googleOauth ? "badge-good" : "badge-neutral"}`}>{keys.googleOauth ? "set" : "not set"}</span></div>
            <div className="alert alert-info">
              Paid models are rejected even if an environment flag enables them. OpenRouter must be the free router or a <code>:free</code> model; insufficient-credit responses are marked unavailable and execution continues with Ollama. If every provider fails, the workflow pauses and notifies you.
            </div>
            <p className="hint">Ollama runs one model at a time with a 4k context window and a 5-minute keep-alive to fit 8 GB unified memory.</p>
          </div>
        </section>
      </div>
    </>
  );
}
