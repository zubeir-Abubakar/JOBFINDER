import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Stat, Empty } from "@/components/ui";
import { BarChart, Funnel } from "@/components/charts";
import { formatDate, param, pct } from "@/lib/format";
import { statusLabel } from "@/lib/application-status";

export const dynamic = "force-dynamic";

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 29 * 86400_000);
  const from = param(sp.from) || dayKey(defaultFrom);
  const to = param(sp.to) || dayKey(today);
  const period = param(sp.report) || "daily";

  const discoveredByDay = all<{ d: string; c: number }>(
    "SELECT date(discovered_at) AS d, COUNT(*) AS c FROM jobs WHERE date(discovered_at) BETWEEN ? AND ? GROUP BY d ORDER BY d",
    [from, to],
  );
  const dayMap = new Map(discoveredByDay.map((r) => [r.d, r.c]));
  const days: Array<{ label: string; value: number }> = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const span = Math.min(60, Math.max(1, Math.round((end.getTime() - cursor.getTime()) / 86400_000) + 1));
  for (let i = 0; i < span; i += 1) {
    const key = dayKey(cursor);
    days.push({ label: key.slice(5), value: dayMap.get(key) ?? 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const weekly: Array<{ label: string; value: number }> = [];
  for (let i = 7; i >= 0; i -= 1) {
    const start = new Date(today.getTime() - (i + 1) * 7 * 86400_000);
    const finish = new Date(today.getTime() - i * 7 * 86400_000);
    const count = one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM applications WHERE submitted_at >= ? AND submitted_at < ?",
      [start.toISOString(), finish.toISOString()],
    )?.c ?? 0;
    weekly.push({ label: `W-${i}`, value: count });
  }

  const monthly: Array<{ label: string; value: number }> = [];
  for (let i = 5; i >= 0; i -= 1) {
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    const finish = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i + 1, 1));
    const count = one<{ c: number }>(
      "SELECT COUNT(*) AS c FROM applications WHERE submitted_at >= ? AND submitted_at < ?",
      [start.toISOString(), finish.toISOString()],
    )?.c ?? 0;
    monthly.push({ label: start.toLocaleDateString("en-GB", { month: "short" }), value: count });
  }

  const statusRows = all<{ status: string; c: number }>(
    "SELECT status, COUNT(*) AS c FROM applications GROUP BY status ORDER BY c DESC",
  );
  const submitted = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at IS NOT NULL")?.c ?? 0;
  const interviews = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('interview_invited','interview_completed','offer_received')")?.c ?? 0;
  const offers = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'offer_received'")?.c ?? 0;
  const rejected = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected'")?.c ?? 0;
  const responded = one<{ c: number }>(
    "SELECT COUNT(*) AS c FROM applications WHERE status IN ('acknowledged','interview_invited','interview_completed','offer_received','rejected')",
  )?.c ?? 0;

  const funnel = [
    { label: "Vacancies discovered", value: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0 },
    { label: "Vacancies analysed", value: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NOT NULL")?.c ?? 0 },
    { label: "Suitable matches", value: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag IN ('strong','possible')")?.c ?? 0 },
    { label: "Application packages", value: one<{ c: number }>("SELECT COUNT(DISTINCT job_id) AS c FROM documents WHERE kind = 'tailored_cv' AND deleted_at IS NULL")?.c ?? 0 },
    { label: "Submitted", value: submitted },
    { label: "Interviews", value: interviews },
    { label: "Offers", value: offers },
  ];

  const topTitles = all<{ title: string; c: number; submitted: number }>(
    `SELECT j.title, COUNT(*) AS c, SUM(CASE WHEN a.submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted
     FROM applications a JOIN jobs j ON j.id = a.job_id GROUP BY lower(j.title) ORDER BY c DESC LIMIT 6`,
  );
  const topLocations = all<{ location: string; c: number }>(
    `SELECT COALESCE(j.location, 'Unknown') AS location, COUNT(*) AS c FROM applications a JOIN jobs j ON j.id = a.job_id
     GROUP BY lower(COALESCE(j.location,'Unknown')) ORDER BY c DESC LIMIT 6`,
  );
  const sourcePerformance = all<{ source: string; total: number; submitted: number }>(
    `SELECT j.source, COUNT(*) AS total, SUM(CASE WHEN a.submitted_at IS NOT NULL THEN 1 ELSE 0 END) AS submitted
     FROM applications a JOIN jobs j ON j.id = a.job_id GROUP BY j.source ORDER BY total DESC`,
  );
  const cvPerformance = all<{ version: string | null; ats: number | null; c: number }>(
    `SELECT d.version, d.ats_score AS ats, COUNT(a.id) AS c FROM documents d
     LEFT JOIN applications a ON a.cv_document_id = d.id AND a.submitted_at IS NOT NULL
     WHERE d.kind = 'tailored_cv' AND d.deleted_at IS NULL GROUP BY d.id ORDER BY d.created_at DESC LIMIT 8`,
  );

  const reportWindow = period === "weekly" ? 7 : period === "monthly" ? 30 : 1;
  const since = new Date(Date.now() - reportWindow * 86400_000).toISOString();
  const report = {
    discovered: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE discovered_at >= ?", [since])?.c ?? 0,
    strong: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag = 'strong' AND discovered_at >= ?", [since])?.c ?? 0,
    prepared: one<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE created_at >= ? AND kind = 'tailored_cv'", [since])?.c ?? 0,
    submitted: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submitted_at >= ?", [since])?.c ?? 0,
    awaiting: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'awaiting_approval'")?.c ?? 0,
    failures: one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed' AND created_at >= ?", [since])?.c ?? 0,
    responses: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('acknowledged','interview_invited','interview_completed','offer_received','rejected') AND last_update >= ?", [since])?.c ?? 0,
  };

  return (
    <>
      <PageHead
        title="Analytics & reporting"
        sub="Every chart is computed from your database. Where there is no data, the chart stays empty rather than showing sample numbers."
        actions={
          <>
            <a href="/api/export/applications" className="btn">Export applications</a>
            <Link href="/jobs" className="btn btn-primary">Find more vacancies</Link>
          </>
        }
      />

      <form method="get" className="card mb-4">
        <div className="card-body flex flex-wrap items-end gap-2" style={{ paddingTop: 16 }}>
          <div>
            <label className="label" htmlFor="from">From</label>
            <input id="from" name="from" type="date" className="input" defaultValue={from} />
          </div>
          <div>
            <label className="label" htmlFor="to">To</label>
            <input id="to" name="to" type="date" className="input" defaultValue={to} />
          </div>
          <button type="submit" className="btn btn-primary">Apply date filter</button>
          <Link href="/analytics" className="btn">Reset</Link>
          <span className="ml-auto text-[11px]" style={{ color: "var(--muted)" }}>Counting {span} day(s)</span>
        </div>
      </form>

      <section className="stats mb-4">
        <Stat label="Submitted" value={submitted} tone="good" />
        <Stat label="Interview conversion" value={`${pct(interviews, submitted)}%`} note={`${interviews} of ${submitted}`} tone={interviews ? "good" : undefined} />
        <Stat label="Employer response rate" value={`${pct(responded, submitted)}%`} note={`${responded} responded`} />
        <Stat label="Rejection rate" value={`${pct(rejected, submitted)}%`} note={`${rejected} rejected`} tone={rejected ? "bad" : undefined} />
        <Stat label="Offers" value={offers} tone={offers ? "good" : undefined} />
      </section>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Jobs discovered per day</h2>
              <p className="card-sub">{formatDate(from)} — {formatDate(to)}</p>
            </div>
          </div>
          <div className="card-body">
            {discoveredByDay.length === 0 ? <Empty title="No discoveries in this range" /> : <BarChart data={days} />}
          </div>
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Applications per week</h2>
              <p className="card-sub">Last 8 weeks, confirmed submissions only</p>
            </div>
          </div>
          <div className="card-body"><BarChart data={weekly} /></div>
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Applications per month</h2>
              <p className="card-sub">Last 6 calendar months</p>
            </div>
          </div>
          <div className="card-body"><BarChart data={monthly} /></div>
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Recruitment funnel</h2>
              <p className="card-sub">From discovery to offer</p>
            </div>
          </div>
          <div className="card-body"><Funnel steps={funnel} /></div>
        </section>
      </div>

      <div className="grid g2 mb-4">
        <section className="card">
          <div className="card-head"><div><h2>Application status distribution</h2></div></div>
          <div className="card-body">
            {statusRows.length === 0 ? <Empty title="No applications recorded" /> : (
              <div className="stack" style={{ gap: 8 }}>
                {statusRows.map((row) => (
                  <div key={row.status} className="between">
                    <span className="text-[12.5px]">{statusLabel(row.status)}</span>
                    <div className="flex items-center gap-2">
                      <div style={{ width: 120 }} className="bar"><span style={{ width: `${pct(row.c, statusRows.reduce((s, r) => s + r.c, 0))}%` }} /></div>
                      <span className="num text-[12px]" style={{ minWidth: 24, textAlign: "right" }}>{row.c}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Performance by source and version</h2><p className="card-sub">Which channels and CV versions convert</p></div></div>
          <div className="card-body stack" style={{ gap: 14 }}>
            <div>
              <div className="label">Sources</div>
              {sourcePerformance.length === 0 ? <p className="text-[12px]" style={{ color: "var(--muted)" }}>No data yet.</p> : sourcePerformance.map((row) => (
                <div key={row.source} className="between text-[12.5px] py-1">
                  <span>{row.source}</span>
                  <span className="num" style={{ color: "var(--muted)" }}>{row.submitted}/{row.total} submitted</span>
                </div>
              ))}
            </div>
            <div>
              <div className="label">Most recent tailored CVs</div>
              {cvPerformance.length === 0 ? <p className="text-[12px]" style={{ color: "var(--muted)" }}>No tailored documents yet.</p> : cvPerformance.map((row, i) => (
                <div key={i} className="between text-[12.5px] py-1">
                  <span>Version {row.version ?? "—"} · ATS {row.ats ?? "—"}/100</span>
                  <span className="num" style={{ color: "var(--muted)" }}>{row.c} linked application(s)</span>
                </div>
              ))}
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Most successful job titles</h2></div></div>
          <div className="card-body">
            {topTitles.length === 0 ? <Empty title="Not enough data" /> : topTitles.map((row) => (
              <div key={row.title} className="between text-[12.5px] py-1">
                <span className="truncate" style={{ maxWidth: "70%" }}>{row.title}</span>
                <span className="num" style={{ color: "var(--muted)" }}>{row.submitted}/{row.c} submitted</span>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><div><h2>Most active locations</h2></div></div>
          <div className="card-body">
            {topLocations.length === 0 ? <Empty title="Not enough data" /> : topLocations.map((row) => (
              <div key={row.location} className="between text-[12.5px] py-1">
                <span className="truncate" style={{ maxWidth: "70%" }}>{row.location}</span>
                <span className="num" style={{ color: "var(--muted)" }}>{row.c}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card" id="reports">
        <div className="card-head">
          <div>
            <h2>Reports</h2>
            <p className="card-sub">Generated from live records. Choose a window.</p>
          </div>
          <div className="row">
            {["daily", "weekly", "monthly"].map((p) => (
              <Link key={p} href={`/analytics?report=${p}#reports`} className={`btn btn-sm ${period === p ? "btn-primary" : ""}`}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </Link>
            ))}
          </div>
        </div>
        <div className="card-body">
          <div className="card-quiet p-4">
            <div className="between">
              <div>
                <div className="text-[13.5px] font-semibold">{period.charAt(0).toUpperCase() + period.slice(1)} recruitment report</div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>Window: last {reportWindow} day(s) · generated {new Date().toLocaleString("en-GB")}</div>
              </div>
              <span className="badge badge-neutral">Live data</span>
            </div>
            <div className="grid g3 mt-4" style={{ gap: 10 }}>
              {[
                ["Jobs discovered", report.discovered],
                ["Strong matches", report.strong],
                ["CVs prepared", report.prepared],
                ["Applications submitted", report.submitted],
                ["Awaiting approval", report.awaiting],
                ["Failed tasks", report.failures],
                ["Employer responses", report.responses],
              ].map(([label, value]) => (
                <div key={String(label)} className="between text-[12.5px]">
                  <span style={{ color: "var(--muted)" }}>{label}</span>
                  <span className="num font-semibold">{value as number}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
