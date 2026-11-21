import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Stat, Empty, Flash } from "@/components/ui";
import { formatDate, param } from "@/lib/format";
import { statusLabel, statusClass, APPLICATION_STATUSES } from "@/lib/application-status";
import { Icon } from "@/components/icons";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 15;

/** Grouped status filters so dashboard totals and this list always agree. */
const APPLICATION_GROUPS: Record<string, { label: string; statuses: string[] }> = {
  sent: {
    label: "Applications sent",
    statuses: ["submitted", "acknowledged", "interview_invited", "interview_completed", "offer_received"],
  },
  pending: { label: "Awaiting response", statuses: ["submitted", "acknowledged"] },
  interviews: { label: "Interview stage", statuses: ["interview_invited", "interview_completed"] },
};

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const status = param(sp.status) || "all";
  const groupKey = param(sp.group);
  const group = groupKey && APPLICATION_GROUPS[groupKey] ? { key: groupKey, ...APPLICATION_GROUPS[groupKey] } : null;
  const search = param(sp.q);
  const page = Math.max(1, Number(param(sp.page) || 1));
  const offset = (page - 1) * PAGE_SIZE;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (status !== "all") {
    clauses.push("a.status = ?");
    params.push(status);
  } else if (group) {
    clauses.push(`a.status IN (${group.statuses.map(() => "?").join(", ")})`);
    params.push(...group.statuses);
  }
  if (search) {
    clauses.push("(j.title LIKE ? OR j.company LIKE ? OR a.notes LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const total = one<{ c: number }>(`SELECT COUNT(*) AS c FROM applications a JOIN jobs j ON j.id = a.job_id ${where}`, params)?.c ?? 0;
  const rows = all<{ id: string; status: string; method: string | null; submitted_at: string | null; last_update: string; approved_at: string | null; title: string; company: string; location: string | null; match_score: number | null; job_id: string }>(
    `SELECT a.id, a.status, a.method, a.submitted_at, a.last_update, a.approved_at, j.title, j.company, j.location, j.match_score, j.id AS job_id
     FROM applications a JOIN jobs j ON j.id = a.job_id ${where}
     ORDER BY a.last_update DESC LIMIT ? OFFSET ?`,
    [...params, PAGE_SIZE, offset],
  );

  const counts = {
    total: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0,
    submitted: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('submitted','acknowledged')")?.c ?? 0,
    awaiting: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'human_intervention_required'")?.c ?? 0,
    interviews: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('interview_invited','interview_completed','offer_received')")?.c ?? 0,
    rejected: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected'")?.c ?? 0,
  };
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeFilters = (search ? 1 : 0) + (status !== "all" ? 1 : 0) + (group ? 1 : 0);

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Application tracker"
        sub="One record per vacancy. A submission is only marked as sent when an employer confirmation is recorded."
        actions={
          <>
            <a href="/api/export/applications" className="btn"><Icon name="docs" /> Export CSV</a>
            <Link href="/jobs" className="btn btn-primary">Find vacancies</Link>
          </>
        }
      />

      <section className="stats mb-4" data-visual-id="approval-queue">
        <Stat label="Total records" value={counts.total} />
        <Stat label="Submitted" value={counts.submitted} tone="good" />
        <Stat label="Needs attention" value={counts.awaiting} tone={counts.awaiting ? "warn" : undefined} />
        <Stat label="Interviews" value={counts.interviews} tone={counts.interviews ? "good" : undefined} />
        <Stat label="Rejected" value={counts.rejected} tone={counts.rejected ? "bad" : undefined} />
      </section>

      <details className="card filter-shell mb-4">
        <summary className="filter-summary">
          <span className="filter-summary-icon"><Icon name="filter" size={15} /></span>
          <span className="filter-summary-copy">
            <span className="filter-summary-title">Track applications</span>
            <span className="filter-summary-sub">{activeFilters ? `${activeFilters} filter${activeFilters === 1 ? "" : "s"} applied` : "Search by employer, role or status"}</span>
          </span>
          <span className="filter-pill-row" aria-hidden="true">
            {search ? <span className="filter-pill">{search}</span> : null}
            {group ? <span className="filter-pill">{group.label}</span> : null}
            {status !== "all" ? <span className="filter-pill">{statusLabel(status)}</span> : null}
          </span>
          <span className="filter-chevron" aria-hidden="true"><Icon name="chevron" size={15} /></span>
        </summary>
        <form method="get" className="filter-panel">
          <div className="filter-grid filter-grid-compact">
            <div className="filter-grow">
              <label className="label" htmlFor="q">Search</label>
              <input id="q" name="q" className="input" defaultValue={search} placeholder="Employer, role or notes" />
            </div>
            <div>
              <label className="label" htmlFor="status">Status</label>
              <select id="status" name="status" className="select" defaultValue={status}>
                <option value="all">All statuses</option>
                {APPLICATION_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}
              </select>
            </div>
            <div className="filter-actions">
              <button type="submit" className="btn btn-primary">Apply filters</button>
              <Link href="/applications" className="btn">Reset</Link>
            </div>
          </div>
        </form>
      </details>

      <section className="card" id="applications" data-visual-id="application-tracker">
        {group ? (
          <div className="card-head">
            <div>
              <h2>
                {group.label} <span className="num" style={{ color: "var(--muted)", fontWeight: 500 }}>({total})</span>
              </h2>
              <p className="card-sub">Filtered view opened from your dashboard.</p>
            </div>
            <Link href="/applications" className="btn btn-sm">Clear filter</Link>
          </div>
        ) : null}
        <div className="table-wrap">
          {rows.length === 0 ? (
            <Empty title="No applications yet">
              Generate a package for a shortlisted vacancy. Eligible applications are submitted automatically after every check passes; only legitimate blockers wait for you.
            </Empty>
          ) : (
            <table className="data application-table">
              <thead>
                <tr>
                  <th>Employer / role</th>
                  <th>Status</th>
                  <th>Submitted</th>
                  <th>Method</th>
                  <th>Match</th>
                  <th>Last update</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Employer / role">
                      <Link href={`/applications/${row.id}`} className="cell-title">{row.title}</Link>
                      <div className="cell-sub">{row.company}{row.location ? ` · ${row.location}` : ""}</div>
                    </td>
                    <td data-label="Status">
                      <span className={`badge ${statusClass(row.status)}`}>{statusLabel(row.status)}</span>
                      {row.approved_at && !row.submitted_at ? <span className="badge badge-good ml-1">Approved</span> : null}
                    </td>
                    <td className="cell-sub" data-label="Submitted">{row.submitted_at ? formatDate(row.submitted_at) : "—"}</td>
                    <td className="cell-sub" data-label="Method">{row.method ? row.method.replace(/_/g, " ") : "—"}</td>
                    <td className="num" data-label="Match">{row.match_score ?? "—"}{row.match_score ? "%" : ""}</td>
                    <td className="cell-sub" data-label="Last update">{formatDate(row.last_update)}</td>
                    <td className="text-right" data-label="Action"><Link href={`/applications/${row.id}`} className="btn btn-sm">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {pages > 1 ? (
          <div className="between px-5 py-3" style={{ borderTop: "1px solid var(--line)" }}>
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>Page {page} of {pages} · {total} records</span>
            <div className="row">
              {page > 1 ? <Link className="btn btn-sm" href={`/applications?page=${page - 1}&status=${status}&q=${encodeURIComponent(search)}${group ? `&group=${group.key}` : ""}`}>Previous</Link> : null}
              {page < pages ? <Link className="btn btn-sm" href={`/applications?page=${page + 1}&status=${status}&q=${encodeURIComponent(search)}${group ? `&group=${group.key}` : ""}`}>Next</Link> : null}
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
