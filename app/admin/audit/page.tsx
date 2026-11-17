import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { PageHead, Empty } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const action = param(sp.action);
  const actor = param(sp.actor);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (action) {
    clauses.push("action LIKE ?");
    params.push(`%${action}%`);
  }
  if (actor) {
    clauses.push("(actor LIKE ? OR entity_id LIKE ?)");
    params.push(`%${actor}%`, `%${actor}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = all<{ id: number; action: string; entity: string | null; entity_id: string | null; detail: string | null; actor: string | null; ip: string | null; created_at: string }>(
    `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT 250`,
    params,
  );
  const actionTypes = all<{ action: string; c: number }>("SELECT action, COUNT(*) AS c FROM audit_logs GROUP BY action ORDER BY c DESC LIMIT 20");
  const total = all<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")[0]?.c ?? 0;

  return (
    <>
      <PageHead title="Audit logs" sub={`${total} recorded events. Logins, agent actions, submissions, uploads, deletions and configuration changes.`} />

      <div className="card mb-4">
        <div className="card-body flex flex-wrap items-end gap-2" style={{ paddingTop: 16 }}>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div>
              <label className="label" htmlFor="action">Action contains</label>
              <input id="action" name="action" className="input" defaultValue={action} placeholder="application.submitted" />
            </div>
            <div>
              <label className="label" htmlFor="actor">Actor / entity</label>
              <input id="actor" name="actor" className="input" defaultValue={actor} placeholder="email or id" />
            </div>
            <button type="submit" className="btn btn-primary">Filter</button>
            <Link href="/admin/audit" className="btn">Reset</Link>
          </form>
          <div className="ml-auto flex flex-wrap gap-1">
            {actionTypes.slice(0, 6).map((type) => (
              <Link key={type.action} href={`/admin/audit?action=${encodeURIComponent(type.action)}`} className="chip">
                {type.action} · {type.c}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <section className="card">
        <div className="table-wrap">
          {rows.length === 0 ? (
            <Empty title="No audit events match" />
          ) : (
            <table className="data">
              <thead><tr><th>Action</th><th>Entity</th><th>Detail</th><th>Actor</th><th>IP</th><th>When</th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="cell-title">{row.action}</td>
                    <td className="cell-sub">{row.entity ?? "—"}{row.entity_id ? <div className="num" style={{ fontSize: 10.5 }}>{row.entity_id.slice(0, 22)}</div> : null}</td>
                    <td className="cell-sub" style={{ maxWidth: 420 }}>{row.detail ?? "—"}</td>
                    <td className="cell-sub">{row.actor ?? "system"}</td>
                    <td className="cell-sub">{row.ip ?? "—"}</td>
                    <td className="cell-sub">{formatDateTime(row.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
