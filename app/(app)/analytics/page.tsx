import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHead, Stat, Empty } from "@/components/ui";
import { BarChart, Funnel, PieChart, RankingBars } from "@/components/charts";
import { getAnalytics, resolveAnalyticsRange } from "@/lib/analytics";
import { agentIdentity } from "@/lib/agent-identity";
import { formatDate, param, pct } from "@/lib/format";

export const dynamic = "force-dynamic";

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "7", label: "Last 7 days" },
  { key: "30", label: "Last 30 days" },
  { key: "all", label: "All time" },
] as const;

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const range = resolveAnalyticsRange({
    preset: param(sp.preset),
    from: param(sp.from),
    to: param(sp.to),
  });
  const data = getAnalytics(range);
  const verified = data.funnel.find((step) => step.label === "Verified submissions")?.value ?? 0;
  const prepared = data.funnel.find((step) => step.label === "Applications prepared")?.value ?? 0;
  const activeAgents = data.agentDistribution.find((slice) => slice.label === "Running")?.value ?? 0;
  const spanDays = Math.max(1, Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1);
  const trendHeading = spanDays > 92 ? "Weekly activity" : "Daily activity";

  return (
    <>
      <PageHead
        title="Analytics & reporting"
        sub="Live workforce intelligence computed from SQLite. Every chart follows the selected window; empty ranges stay empty instead of showing sample data."
        actions={
          <>
            <a href="/api/export/applications" className="btn">Export applications</a>
            <Link href="/jobs" className="btn btn-primary">Find more vacancies</Link>
          </>
        }
      />

      <section className="card mb-4 analytics-filter">
        <div className="card-body stack" style={{ paddingTop: 16 }}>
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESETS.map((preset) => {
              const href = `/analytics?${preset.key === "all" ? `preset=all&to=${range.to}` : `preset=${preset.key}`}#charts`;
              return (
                <Link key={preset.key} href={href} className={`btn btn-sm ${range.preset === preset.key ? "btn-primary" : ""}`}>
                  {preset.label}
                </Link>
              );
            })}
            <span className="ml-auto badge badge-neutral">{range.label}</span>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="preset" value="custom" />
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" className="input" defaultValue={range.from} />
            </div>
            <div>
              <label className="label" htmlFor="to">To</label>
              <input id="to" name="to" type="date" className="input" defaultValue={range.to} />
            </div>
            <button type="submit" className="btn btn-primary">Apply custom range</button>
            <Link href="/analytics" className="btn">Reset</Link>
            <span className="text-[11px] ml-auto" style={{ color: "var(--muted)" }}>
              {formatDate(range.from)} — {formatDate(range.to)}
            </span>
          </form>
        </div>
      </section>

      <section className="stats mb-4">
        <Stat label="Verified submissions" value={verified} note={`${data.outcomesTotal} application record(s) in range`} tone="good" />
        <Stat label="Packages prepared" value={prepared} note="Tailored CV or cover letter" />
        <Stat label="Tokens used" value={data.tokens.total.toLocaleString("en-GB")} note={`${data.tokens.calls} inference call(s)`} />
        <Stat label="Agents running" value={activeAgents} note="Current execution state" tone={activeAgents ? "info" : undefined} />
        <Stat label="Inference cost" value="Unverified" note="No verified price data" tone="warn" />
      </section>

      <div id="charts" />

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Agent distribution</h2>
              <p className="card-sub">Current availability combined with latest task in this range.</p>
            </div>
          </div>
          <div className="card-body">
            <PieChart data={data.agentDistribution} label="agents" emptyLabel="No agent data" />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Provider distribution</h2>
              <p className="card-sub">
                Actual inference records by provider, measured by {data.providerMetric === "tokens" ? "tokens" : "calls"}.
              </p>
            </div>
          </div>
          <div className="card-body">
            <PieChart data={data.providerDistribution} label={data.providerMetric === "tokens" ? "tokens" : "calls"} emptyLabel="No inference calls in this range" />
          </div>
        </section>
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Model usage</h2>
            <p className="card-sub">Token consumption by the model that actually served the call.</p>
          </div>
          <span className="badge badge-neutral">{data.modelUsage.length} model route(s)</span>
        </div>
        {data.modelUsage.length === 0 ? (
          <div className="card-body"><Empty title="No model usage in this range" /></div>
        ) : (
          <div className="card-body grid g2">
            <PieChart
              data={data.modelUsage.map((row, index) => ({
                label: row.model,
                value: row.totalTokens,
                detail: `${row.provider} · ${row.percentage}% of tokens`,
                tone: (["accent", "cyan", "violet", "amber", "danger"] as const)[index % 5],
              }))}
              label="tokens"
            />
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Model</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th><th>Share</th></tr>
                </thead>
                <tbody>
                  {data.modelUsage.map((row) => (
                    <tr key={`${row.provider}-${row.model}`}>
                      <td><span className="cell-title">{row.model}</span><div className="cell-sub">{row.provider}</div></td>
                      <td className="num">{row.calls}</td>
                      <td className="num">{row.inputTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.outputTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.totalTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.percentage}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Agent productivity</h2>
              <p className="card-sub">Successful, failed and other task outcomes in this range.</p>
            </div>
          </div>
          <div className="card-body">
            <PieChart data={data.productivity} label="tasks" emptyLabel="No tasks in this range" />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Task completion ranking</h2>
              <p className="card-sub">Which agents complete the most work.</p>
            </div>
          </div>
          <div className="card-body">
            <RankingBars
              data={data.productivityRanking.map((row) => ({
                label: row.name,
                value: row.completed,
                detail: `${row.failed} failed · ${row.other} other`,
              }))}
            />
          </div>
        </section>
      </div>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Recruitment funnel</h2>
              <p className="card-sub">Prepared and attempted are never counted as verified.</p>
            </div>
          </div>
          <div className="card-body">
            <Funnel steps={data.funnel} />
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Application outcomes</h2>
              <p className="card-sub">Mutually exclusive categories reconciling to {data.outcomesTotal} record(s).</p>
            </div>
          </div>
          <div className="card-body">
            <PieChart data={data.outcomes} label="applications" emptyLabel="No applications in this range" />
          </div>
        </section>
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>{range.from === range.to ? "Daily" : trendHeading}</h2>
            <p className="card-sub">Time series for vacancies, packages, verified submissions, agent tasks and token consumption. Long ranges are grouped into seven-day buckets.</p>
          </div>
        </div>
        <div className="card-body grid g2">
          {([
            ["Vacancies discovered", data.trends.vacancies, ""],
            ["Applications prepared", data.trends.prepared, ""],
            ["Verified submissions", data.trends.verified, ""],
            ["Agent task activity", data.trends.tasks, ""],
            ["Token consumption", data.trends.tokens, " tokens"],
          ] as Array<[string, Array<{ label: string; value: number }>, string]>).map(([label, series, suffix]) => (
            <div className="analytics-chart" key={String(label)}>
              <div className="between mb-2">
                <span className="text-[12.5px] font-semibold">{label as string}</span>
                <span className="text-[10.5px] num" style={{ color: "var(--muted)" }}>
                  {series.reduce((sum, point) => sum + point.value, 0).toLocaleString("en-GB")}{suffix as string}
                </span>
              </div>
              <BarChart data={series} height={132} suffix={String(suffix)} />
            </div>
          ))}
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Weekly totals</h2>
            <p className="card-sub">The selected range grouped into seven-day buckets.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Week</th><th>Vacancies</th><th>Prepared</th><th>Verified</th><th>Tasks</th><th>Tokens</th></tr>
            </thead>
            <tbody>
              {data.weekly.vacancies.map((point, index) => (
                <tr key={`${point.label}-${index}`}>
                  <td className="cell-title">{point.label}</td>
                  <td className="num">{point.value}</td>
                  <td className="num">{data.weekly.prepared[index]?.value ?? 0}</td>
                  <td className="num">{data.weekly.verified[index]?.value ?? 0}</td>
                  <td className="num">{data.weekly.tasks[index]?.value ?? 0}</td>
                  <td className="num">{(data.weekly.tokens[index]?.value ?? 0).toLocaleString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head"><div><h2>Token usage</h2><p className="card-sub">Provider-reported and estimated counts stay separate.</p></div></div>
          <div className="card-body stack" style={{ gap: 9 }}>
            {[
              ["Input tokens", data.tokens.input],
              ["Output tokens", data.tokens.output],
              ["Total tokens", data.tokens.total],
              ["Cached tokens", data.tokens.cached],
              ["Provider-reported", data.tokens.providerReported],
              ["Estimated", data.tokens.estimated],
              ["Historical / unknown source", data.tokens.unknown],
              ["Local Ollama tokens", data.tokens.local],
              ["External API tokens", data.tokens.external],
            ].map(([label, value]) => (
              <div className="between text-[12.5px]" key={String(label)}>
                <span style={{ color: "var(--muted)" }}>{label}</span>
                <span className="num font-semibold">{Number(value).toLocaleString("en-GB")}</span>
              </div>
            ))}
            <div className="card-quiet p-3 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
              Cost is <strong>unverified</strong>, not a measured zero. {data.tokens.costDetail}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Usage by agent</h2><p className="card-sub">Actual inference records; failed calls are included where recorded.</p></div></div>
          <div className="table-wrap">
            {data.tokens.byAgent.length === 0 ? <Empty title="No inference usage" /> : (
              <table className="data">
                <thead><tr><th>Agent</th><th>Calls</th><th>Input</th><th>Output</th><th>Total</th></tr></thead>
                <tbody>
                  {data.tokens.byAgent.map((row) => (
                    <tr key={row.agentKey}>
                      <td><span className="cell-title">{agentIdentity(row.agentKey).shortName}</span></td>
                      <td className="num">{row.calls}</td>
                      <td className="num">{row.inputTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.outputTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.totalTokens.toLocaleString("en-GB")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head"><div><h2>Usage by provider</h2></div></div>
          <div className="table-wrap">
            {data.tokens.byProvider.length === 0 ? <Empty title="No provider usage" /> : (
              <table className="data">
                <thead><tr><th>Provider</th><th>Calls</th><th>Total</th><th>Reported</th><th>Estimated</th></tr></thead>
                <tbody>
                  {data.tokens.byProvider.map((row, index) => (
                    <tr key={`${row.provider}-${row.model}-${index}`}>
                      <td><span className="cell-title">{row.provider === "ollama" ? "Ollama (local — no API charge)" : row.provider}</span><div className="cell-sub">{row.model}</div></td>
                      <td className="num">{row.calls}</td>
                      <td className="num">{row.totalTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.providerReportedTokens.toLocaleString("en-GB")}</td>
                      <td className="num">{row.estimatedTokens.toLocaleString("en-GB")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card" id="reports">
          <div className="card-head"><div><h2>Analytics report</h2><p className="card-sub">Generated from live records for the selected range.</p></div></div>
          <div className="card-body">
            <div className="card-quiet p-4 stack" style={{ gap: 7 }}>
              <div className="between"><span className="text-[12.5px] font-semibold">{range.label}</span><span className="badge badge-neutral">Live data</span></div>
              <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{formatDate(range.from)} — {formatDate(range.to)} · generated {new Date(data.generatedAt).toLocaleString("en-GB")}</div>
              <div className="grid g2 mt-2" style={{ gap: 8 }}>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Applications</span><span className="num">{data.outcomesTotal}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Verified</span><span className="num">{verified}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Prepared</span><span className="num">{prepared}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Tasks</span><span className="num">{data.productivity.reduce((sum, row) => sum + row.value, 0)}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Tokens</span><span className="num">{data.tokens.total.toLocaleString("en-GB")}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Cost</span><span className="num">Unverified</span></div>
              </div>
              <p className="hint mt-1">No data is fabricated. Empty categories remain visible in the legends with a zero count.</p>
            </div>
          </div>
        </section>
      </div>

      <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Agent distribution uses current availability plus the latest task in the selected window. Provider and model charts use actual inference rows, not configured assignments. The custom range is inclusive. Weekly totals use seven-day buckets from {formatDate(range.from)}. {pct(verified, Math.max(1, data.outcomesTotal))}% of application records in this range have verified submission evidence.
      </p>
    </>
  );
}
