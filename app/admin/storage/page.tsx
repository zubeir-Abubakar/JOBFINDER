import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { storageStats, expiringDocuments } from "@/lib/retention";
import { PageHead, Flash, Stat, Progress } from "@/components/ui";
import { formatBytes, formatDate, param } from "@/lib/format";
import { saveAdminRetentionAction, adminCleanupAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function AdminStoragePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const settings = getSettings();
  const stats = storageStats();
  const expiring = expiringDocuments();
  const counts = all<{ kind: string; c: number }>("SELECT kind, COUNT(*) AS c FROM documents WHERE deleted_at IS NULL GROUP BY kind");
  const kindMap = new Map(counts.map((row) => [row.kind, row.c]));
  const deleted = all<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE deleted_at IS NOT NULL")[0]?.c ?? 0;

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} cleanup={param(sp.cleanup)} freed={param(sp.freed)} />
      <PageHead title="Storage & retention" sub="File inventory, expiry schedule and the retention policy applied to tailored documents." />

      <section className="stats mb-4">
        <Stat label="Total storage" value={formatBytes(stats.totalBytes)} note={`${kindMap.get("original_cv") ?? 0} original`} />
        <Stat label="Tailored CVs" value={kindMap.get("tailored_cv") ?? 0} note={formatBytes(stats.tailoredBytes)} />
        <Stat label="Cover letters" value={kindMap.get("cover_letter") ?? 0} note={formatBytes(stats.coverBytes)} />
        <Stat label="Expiring (7 days)" value={stats.expiringSoon.length} tone={stats.expiringSoon.length ? "warn" : undefined} />
        <Stat label="Retired records" value={deleted} note="Files deleted, records kept" />
      </section>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Retention policy</h2>
              <p className="card-sub">Applied to submitted, unpinned tailored documents only.</p>
            </div>
          </div>
          <div className="card-body">
            <form action={saveAdminRetentionAction} className="stack" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="retention_days">Retention period</label>
                <select id="retention_days" name="retention_days" className="select" defaultValue={String(settings.retention_days ?? 30)}>
                  {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" name="auto_delete_expired" defaultChecked={settings.auto_delete_expired !== false} /> Enable automatic deletion
              </label>
              <div className="row">
                <SubmitButton className="btn btn-primary">Save policy</SubmitButton>
              </div>
            </form>
            <form action={adminCleanupAction} className="mt-2">
              <SubmitButton className="btn" pendingLabel="Running retention…" confirm="Delete every eligible expired file now?">
                Run retention now
              </SubmitButton>
            </form>
            <div className="mt-4">
              <div className="between text-[12px]"><span>Storage footprint</span><span className="num">{formatBytes(stats.totalBytes)}</span></div>
              <div className="mt-1.5"><Progress value={Math.min(100, (stats.totalBytes / (50 * 1024 * 1024)) * 100)} /></div>
            </div>
            <p className="hint mt-3">
              Never auto-deleted: original CV, master profile, application history, employer records, submission confirmations and audit logs.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><div><h2>Expiring documents</h2><p className="card-sub">Next 30 by expiry date.</p></div></div>
          <div className="table-wrap">
            {expiring.length === 0 ? (
              <div className="empty">No documents carry an expiry date yet. Expiry starts after a confirmed submission.</div>
            ) : (
              <table className="data">
                <thead><tr><th>Document</th><th>Kind</th><th>Expires</th><th>Size</th></tr></thead>
                <tbody>
                  {(expiring as Array<{ id: string; display_name: string; kind: string; expires_at: string; size_bytes: number; pinned: number }>).map((doc) => (
                    <tr key={doc.id}>
                      <td className="cell-title" style={{ maxWidth: 280 }}>{doc.display_name}</td>
                      <td className="cell-sub">{doc.kind}</td>
                      <td className="cell-sub">{formatDate(doc.expires_at)}{doc.pinned ? " · pinned" : ""}</td>
                      <td className="cell-sub">{formatBytes(doc.size_bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
