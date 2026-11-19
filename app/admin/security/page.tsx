import { requireAdmin } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { saveSecurityAction, runBackupAction, purgeSessionsAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function AdminSecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const settings = getSettings();
  const security = settings.security ?? { session_days: 7, remember_days: 30, max_login_attempts: 8 };
  const failedLogins = all<{ detail: string | null; entity_id: string | null; created_at: string; ip: string | null }>(
    "SELECT detail, entity_id, created_at, ip FROM audit_logs WHERE action IN ('login.failed','login.blocked') ORDER BY id DESC LIMIT 12",
  );
  const counts = {
    users: one<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0,
    disabled: one<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE status != 'active'")?.c ?? 0,
    sessions: one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE expires_at > datetime('now')")?.c ?? 0,
    events: one<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")?.c ?? 0,
  };

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      {param(sp.backup) ? <div className="alert alert-ok mb-4">Database backup written: {param(sp.backup)}</div> : null}
      <PageHead title="Security" sub="Session policy, authentication events, backups and account state." />

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Session policy</h2>
              <p className="card-sub">Applies to new sign-ins. Sessions are stored hashed in the database.</p>
            </div>
          </div>
          <div className="card-body">
            <form action={saveSecurityAction} className="grid g2" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="session_days">Standard session length (days)</label>
                <input id="session_days" name="session_days" type="number" min={1} max={30} className="input" defaultValue={security.session_days} />
              </div>
              <div>
                <label className="label" htmlFor="remember_days">Remember-me length (days)</label>
                <input id="remember_days" name="remember_days" type="number" min={1} max={90} className="input" defaultValue={security.remember_days} />
              </div>
              <div>
                <label className="label" htmlFor="max_login_attempts">Max login attempts per window</label>
                <input id="max_login_attempts" name="max_login_attempts" type="number" min={3} max={20} className="input" defaultValue={security.max_login_attempts} />
                <p className="hint">Enforced from failed sign-in audit events for the account or IP over a rolling 15-minute window. Restarts do not reset it.</p>
              </div>
              <div className="flex items-end">
                <SubmitButton className="btn btn-primary">Save session policy</SubmitButton>
              </div>
            </form>
            <div className="row mt-3">
              <form action={runBackupAction}>
                <SubmitButton className="btn" pendingLabel="Backing up…">Run database backup (VACUUM INTO)</SubmitButton>
              </form>
              <form action={purgeSessionsAction}>
                <SubmitButton className="btn">Purge expired sessions</SubmitButton>
              </form>
            </div>
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head"><div><h2>Posture</h2></div></div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Password hashing</span><span>scrypt · 64-byte key · per-password salt</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Session storage</span><span>SHA-256 token hash in SQLite</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Cookie</span><span>HttpOnly · SameSite=Lax · Secure in production</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Role enforcement</span><span>Server-side on every page and action</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>File access</span><span>Authenticated download route only</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Active sessions</span><span className="num">{counts.sessions}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Users / disabled</span><span className="num">{counts.users} / {counts.disabled}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Audit events</span><span className="num">{counts.events}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Signed in as</span><span>{admin.email}</span></div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><div><h2>Recent failed sign-ins</h2></div></div>
            <div className="card-body">
              {failedLogins.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No failed attempts recorded.</p>
              ) : (
                <div className="feed">
                  {failedLogins.map((entry, i) => (
                    <div key={i} className="feed-item">
                      <span className="feed-dot">!</span>
                      <div>
                        <div className="feed-text">{entry.entity_id ?? "unknown account"} · {entry.detail}</div>
                        <div className="feed-time">{entry.ip ?? "local"} · {formatDateTime(entry.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
