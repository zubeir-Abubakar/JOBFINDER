import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHead, Empty, Flash } from "@/components/ui";
import { formatDate, relativeTime, param } from "@/lib/format";
import { statusLabel, statusClass, APPLICATION_STATUSES } from "@/lib/application-status";
import { Icon } from "@/components/icons";
import { ApplicationBoard, type BoardColumnView } from "@/components/ApplicationBoard";
import {
  BOARD_COLUMNS,
  applyBoardSearch,
  boardColumnForRow,
  boardCounts,
  groupBoardRows,
  sortBoardRows,
  splitBoardRows,
  type BoardColumnKey,
  type BoardSort,
} from "@/lib/application-board";

export const dynamic = "force-dynamic";

/** The board reads one bounded dataset; counts are derived from exactly these rows. */
const ROW_LIMIT = 1000;
const COLUMN_LIMIT = 40;

type ApplicationRow = {
  id: string;
  status: string;
  submitted_at: string | null;
  confirmation: string | null;
  last_update: string;
  notes: string | null;
  title: string;
  company: string;
  location: string | null;
  match_score: number | null;
  job_id: string;
};

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const q = param(sp.q).trim();
  const status = param(sp.status);
  const sortParam = param(sp.sort);
  const sort: BoardSort = sortParam === "match" ? "match" : sortParam === "company" ? "company" : "recent";
  const requestedColumn = ["considering", "to_apply", "applied", "needs_attention"].includes(param(sp.column))
    ? (param(sp.column) as BoardColumnKey)
    : null;

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q) {
    clauses.push("(j.title LIKE ? OR j.company LIKE ? OR j.location LIKE ? OR a.notes LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (status && (APPLICATION_STATUSES as readonly string[]).includes(status)) {
    clauses.push("a.status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const order =
    sort === "match"
      ? "j.match_score IS NULL, j.match_score DESC, a.last_update DESC"
      : sort === "company"
        ? "j.company COLLATE NOCASE ASC, j.title COLLATE NOCASE ASC"
        : "a.last_update DESC";

  const rows = all<ApplicationRow>(
    `SELECT a.id, a.status, a.submitted_at, a.confirmation, a.last_update, a.notes,
            j.title, j.company, j.location, j.match_score, j.id AS job_id
     FROM applications a JOIN jobs j ON j.id = a.job_id
     ${where}
     ORDER BY ${order}
     LIMIT ?`,
    [...params, ROW_LIMIT],
  );

  // One dataset produces the visible cards, every column header and the record
  // total. There are no separate aggregate queries to drift out of sync.
  const searched = applyBoardSearch(rows, q);
  const scoped = requestedColumn ? searched.filter((row) => boardColumnForRow(row) === requestedColumn) : searched;
  const counts = boardCounts(scoped);
  const { open, closed } = splitBoardRows(scoped);
  const grouped = groupBoardRows(sortBoardRows(open, sort));

  const columns: BoardColumnView[] = BOARD_COLUMNS.map((column) => ({
    key: column.key,
    label: column.label,
    hint: column.hint,
    count: counts[column.key],
    cards: grouped[column.key].slice(0, COLUMN_LIMIT).map((row) => ({
      id: row.id,
      title: row.title,
      company: row.company,
      location: row.location,
      status: row.status,
      statusLabel: statusLabel(row.status),
      statusTone: statusClass(row.status),
      matchScore: row.match_score,
      lastUpdateLabel: relativeTime(row.last_update),
      verifiedSubmission: Boolean(row.submitted_at && row.confirmation),
    })),
  }));
  const displayedCards = columns.reduce((sum, column) => sum + column.cards.length, 0);
  const activeFilters = [q, status, requestedColumn, sort !== "recent"].filter(Boolean).length;
  const scopeLabel = requestedColumn
    ? `${BOARD_COLUMNS.find((column) => column.key === requestedColumn)?.label} column`
    : "the board";

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Applications"
        sub="One card per vacancy. The Applied column only contains employer-confirmed submissions; preparing documents never counts as applying."
        actions={
          <>
            <a href="/api/export/applications" className="btn"><Icon name="docs" /> Export CSV</a>
            <Link href="/jobs" className="btn btn-primary">Find vacancies</Link>
          </>
        }
      />

      <details className="card filter-shell mb-4" open={activeFilters > 0}>
        <summary className="filter-summary">
          <span className="filter-summary-icon"><Icon name="filter" size={15} /></span>
          <span className="filter-summary-copy">
            <span className="filter-summary-title">Search and filter</span>
            <span className="filter-summary-sub">
              {activeFilters ? `${activeFilters} filter${activeFilters === 1 ? "" : "s"} applied` : "Employer, role, status or sort order"}
            </span>
          </span>
          <span className="filter-chevron" aria-hidden="true"><Icon name="chevron" size={15} /></span>
        </summary>
        <form method="get" className="filter-panel">
          <div className="filter-grid filter-grid-compact">
            <div className="filter-grow">
              <label className="label" htmlFor="q">Search</label>
              <input id="q" name="q" className="input" defaultValue={q} placeholder="Employer, role, location or notes" />
            </div>
            <div>
              <label className="label" htmlFor="status">Status</label>
              <select id="status" name="status" className="select" defaultValue={status}>
                <option value="">All statuses</option>
                {APPLICATION_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="sort">Sort</label>
              <select id="sort" name="sort" className="select" defaultValue={sort}>
                <option value="recent">Last update</option>
                <option value="match">Match score</option>
                <option value="company">Employer</option>
              </select>
            </div>
            {requestedColumn ? <input type="hidden" name="column" value={requestedColumn} /> : null}
            <div className="filter-actions">
              <button type="submit" className="btn btn-primary">Apply</button>
              <Link href="/applications" className="btn">Clear</Link>
            </div>
          </div>
        </form>
      </details>

      <div className="between mb-2">
        <p className="text-[11.5px]" style={{ color: "var(--muted)" }}>
          {counts.total} matching application record{counts.total === 1 ? "" : "s"} in {scopeLabel}.
          {" "}Showing {displayedCards} open card{displayedCards === 1 ? "" : "s"}
          {closed.length ? ` and ${closed.length} closed record${closed.length === 1 ? "" : "s"}` : ""}.
          {counts.total >= ROW_LIMIT ? " Only the 1000 most recently updated records are in scope." : ""}
        </p>
        {requestedColumn ? (
          <Link href="/applications" className="btn btn-sm">Show all columns</Link>
        ) : null}
      </div>

      <div data-visual-id="application-tracker">
        <ApplicationBoard columns={columns} />
      </div>

      {closed.length > 0 ? (
        <details className="card mt-4" id="closed">
          <summary className="filter-summary">
            <span className="filter-summary-copy">
              <span className="filter-summary-title">Closed records ({counts.closed})</span>
              <span className="filter-summary-sub">Rejected or withdrawn. Kept for history and never counted as active.</span>
            </span>
            <span className="filter-chevron" aria-hidden="true"><Icon name="chevron" size={15} /></span>
          </summary>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Vacancy</th><th>Status</th><th>Last update</th><th aria-label="Open" /></tr></thead>
              <tbody>
                {closed.slice(0, 50).map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link href={`/applications/${row.id}`} className="cell-title">{row.title}</Link>
                      <div className="cell-sub">{row.company}</div>
                    </td>
                    <td><span className={`badge ${statusClass(row.status)}`}>{statusLabel(row.status)}</span></td>
                    <td className="cell-sub">{formatDate(row.last_update)}</td>
                    <td className="text-right"><Link href={`/applications/${row.id}`} className="btn btn-sm">Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {counts.total === 0 ? (
        <Empty title="No applications match">
          Clear the filters, or generate a package from a shortlisted vacancy. Eligible applications are submitted automatically after every check passes.
        </Empty>
      ) : null}
    </>
  );
}
