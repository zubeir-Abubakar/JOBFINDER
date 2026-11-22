import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Empty } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { type AuditSeverity, auditCategory, auditPageHref, auditSeverity, buildAuditQuery } from "@/lib/audit-query";
import { AGENT_IDENTITY_KEYS, agentIdentity } from "@/lib/agent-identity";

export const dynamic = "force-dynamic";

type AuditRow = {
  id: number;
  action: string;
  entity: string | null;
  entity_id: string | null;
  detail: string | null;
  actor: string | null;
  ip: string | null;
  created_at: string;
  user_id: string | null;
};

const severityClass: Record<AuditSeverity, string> = {
  error: "badge-bad",
  warning: "badge-warn",
  info: "badge-neutral",
};

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const q = param(sp.q).trim();
  const category = param(sp.category);
  const severity = param(sp.severity);
  const agentKey = param(sp.agent);
  const from = param(sp.from);
  const to = param(sp.to);
  const agent = agentKey ? agentIdentity(agentKey) : null;

  const query = buildAuditQuery({
    q,
    category,
    severity,
    agentKey: agent ? agentKey : undefined,
    agentName: agent?.name,
    from: from ? `${from}T00:00:00.000Z` : undefined,
    to: to ? `${to}T23:59:59.999Z` : undefined,
    page: Number(param(sp.page) || 1),
  });

  const total = one<{ c: number }>(`SELECT COUNT(*) AS c FROM audit_logs ${query.where}`, query.params)?.c ?? 0;
  const rows = all<AuditRow>(
    `SELECT * FROM audit_logs ${query.where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...query.params, query.pageSize, query.offset],
  );
  const actionTypes = all<{ action: string; c: number }>("SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC LIMIT 60");
  const categories = [...new Set(actionTypes.map((row) => auditCategory(row.action)))].sort();
  const totalEvents = one<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")?.c ?? 0;
  const pages = Math.max(1, Math.ceil(total / query.pageSize));
  const filterValues: Record<string, string | undefined> = { q, category, severity, agent: agentKey, from, to };
  const activeFilters = [q, category, severity, agentKey, from, to].filter(Boolean).length;

  return (
    <>
      <PageHead
        title="Audit explorer"
        sub={`${totalEvents} recorded events. Complete history; filters change the view, never the records.`}
        actions={<Link href="/admin/diagnostics" className="btn">Diagnostics</Link>}
      />

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Find events</h2>
            <p className="card-sub">
              {activeFilters ? `${activeFilters} filter${activeFilters === 1 ? "" : "s"} applied · ${total} matching` : "Recent events are shown by default."}
            </p>
          </div>
          {activeFilters ? <Link href="/admin/audit" className="btn btn-sm">Clear filters</Link> : null}
        </div>
        <form method="get" className="filter-panel" style={{ paddingTop: 0 }}>
          <div className="filter-grid">
            <div>
              <label className="label" htmlFor="q">Search</label>
              <input id="q" name="q" className="input" defaultValue={q} placeholder="Action, description, actor or reference ID" />
            </div>
            <div>
              <label className="label" htmlFor="category">Category</label>
              <select id="category" name="category" className="select" defaultValue={category}>
                <option value="">All categories</option>
                {categories.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="severity">Severity</label>
              <select id="severity" name="severity" className="select" defaultValue={severity}>
                <option value="">All</option>
                <option value="error">Errors and blocks</option>
                <option value="warning">Warnings</option>
                <option value="info">Informational</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="agent">Agent</label>
              <select id="agent" name="agent" className="select" defaultValue={agentKey}>
                <option value="">All agents</option>
                {AGENT_IDENTITY_KEYS.map((key) => <option key={key} value={key}>{agentIdentity(key).name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" className="input" defaultValue={from} />
            </div>
            <div>
              <label className="label" htmlFor="to">To</label>
              <input id="to" name="to" type="date" className="input" defaultValue={to} />
            </div>
            <div className="filter-actions">
              <button type="submit" className="btn btn-primary">Apply filters</button>
              <Link href="/admin/audit" className="btn">Reset</Link>
            </div>
          </div>
        </form>
      </section>

      {rows.length === 0 ? (
        <section className="card"><Empty title="No audit events match" /></section>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {rows.map((row) => {
            const level = auditSeverity(row.action);
            return (
              <details key={row.id} className="card audit-event">
                <summary className="audit-summary">
                  <span className={`badge ${severityClass[level]}`}>{level}</span>
                  <span className="audit-action">{row.action}</span>
                  <span className="audit-detail">{row.detail ?? row.entity ?? "—"}</span>
                  <span className="audit-actor">{row.actor ?? "system"}</span>
                  <span className="audit-time">{formatDateTime(row.created_at)}</span>
                </summary>
                <div className="card-body audit-body">
                  <div className="grid g2" style={{ gap: 8 }}>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Event ID</span><span className="num">{row.id}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Category</span><span>{auditCategory(row.action)}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Entity</span><span>{row.entity ?? "—"}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Reference ID</span><span className="num" style={{ wordBreak: "break-all" }}>{row.entity_id ?? "—"}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Actor</span><span>{row.actor ?? "system"}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>User ID</span><span className="num" style={{ wordBreak: "break-all" }}>{row.user_id ?? "—"}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>IP address</span><span className="num">{row.ip ?? "—"}</span></div>
                    <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Recorded</span><span>{formatDateTime(row.created_at)}</span></div>
                  </div>
                  {row.detail ? <p className="text-[12px] mt-3" style={{ whiteSpace: "pre-wrap" }}>{row.detail}</p> : null}
                </div>
              </details>
            );
          })}
        </div>
      )}

      <div className="between mt-4">
        <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
          Page {query.page} of {pages} · {total} matching · {query.pageSize} per page
        </span>
        <div className="row">
          {query.page > 1 ? <Link className="btn btn-sm" href={auditPageHref(filterValues, query.page - 1)}>Previous</Link> : null}
          {query.page < pages ? <Link className="btn btn-sm" href={auditPageHref(filterValues, query.page + 1)}>Next</Link> : null}
        </div>
      </div>
    </>
  );
}
