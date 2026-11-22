import Link from "next/link";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "@/lib/auth";
import { DATA_DIR, all, one } from "@/lib/db";
import { PageHead, Stat } from "@/components/ui";
import { formatBytes, formatDateTime, relativeTime } from "@/lib/format";
import { storageStats } from "@/lib/retention";
import { getSettings } from "@/lib/settings";
import { runBackupAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function AdminOverviewPage() {
  await requireAdmin();
  const settings = getSettings();
  const stats = storageStats();
  const dbFile = path.join(DATA_DIR, "at-ai-workforce.db");
  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(dbFile).size;
  } catch {}
  const counts = {
    users: one<{ c: number }>("SELECT COUNT(*) AS c FROM users")?.c ?? 0,
    admins: one<{ c: number }>("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")?.c ?? 0,
    jobs: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0,
    applications: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0,
    documents: one<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE deleted_at IS NULL")?.c ?? 0,
    audit: one<{ c: number }>("SELECT COUNT(*) AS c FROM audit_logs")?.c ?? 0,
    running: one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE status = 'running'")?.c ?? 0,
    failed: one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed'")?.c ?? 0,
    sessions: one<{ c: number }>("SELECT COUNT(*) AS c FROM sessions WHERE expires_at > datetime('now')")?.c ?? 0,
  };
  const agents = all<{ key: string; name: string; enabled: number; status: string; run_count: number; failure_count: number; last_run_at: string | null }>(
    "SELECT key, name, enabled, status, run_count, failure_count, last_run_at FROM agents ORDER BY sort",
  );
  const audit = all<{ action: string; detail: string | null; created_at: string; actor: string | null }>(
    "SELECT action, detail, created_at, actor FROM audit_logs ORDER BY id DESC LIMIT 12",
  );
  const backup = settings.backup ?? { enabled: true, last_backup_at: null };

  return (
    <>
      <PageHead
        title="System overview"
        sub="Administrator console. Health, execution and storage figures are read from the running system."
        actions={
          <>
            <form action={runBackupAction}>
              <SubmitButton className="btn" pendingLabel="Backing up…">Run database backup</SubmitButton>
            </form>
            <Link href="/admin/audit" className="btn">Audit logs</Link>
          </>
        }
      />

      <section className="stats mb-4">
        <Stat label="Users" value={counts.users} note={`${counts.admins} administrator(s)`} />
        <Stat label="Sessions" value={counts.sessions} note="Unexpired" />
        <Stat label="Vacancies" value={counts.jobs} />
        <Stat label="Applications" value={counts.applications} />
        <Stat label="Documents" value={counts.documents} note={formatBytes(stats.totalBytes)} />
        <Stat label="Running tasks" value={counts.running} tone={counts.running ? "info" : undefined} />
        <Stat label="Failed tasks" value={counts.failed} tone={counts.failed ? "bad" : undefined} />
        <Stat label="Audit events" value={counts.audit} />
        <Stat label="Database size" value={formatBytes(dbBytes)} note="SQLite + WAL" />
        <Stat label="Last backup" value={backup.last_backup_at ? relativeTime(backup.last_backup_at) : "never"} tone={backup.last_backup_at ? "good" : "warn"} />
      </section>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Diagnostics</h2>
              <p className="card-sub">Health, background runner, providers, delivery and voice status are consolidated in one page.</p>
            </div>
            <Link href="/admin/diagnostics" className="btn btn-sm">Open diagnostics</Link>
          </div>
          <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
            <div className="between"><span style={{ color: "var(--muted)" }}>Application server</span><span>Next.js · Node {process.version}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Database</span><span>SQLite · WAL</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Storage</span><span>{formatBytes(stats.totalBytes)}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Execution</span><span>Sequential, single process</span></div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Agents</h2>
              <p className="card-sub">Toggle or configure under Agent management.</p>
            </div>
            <Link href="/admin/agents" className="btn btn-sm">Manage</Link>
          </div>
          <div className="card-body">
            {agents.map((agent) => (
              <div key={agent.key} className="between py-2" style={{ borderBottom: "1px solid var(--line)" }}>
                <div>
                  <div className="text-[12.5px] font-medium">{agent.name}</div>
                  <div className="text-[11px]" style={{ color: "var(--muted)" }}>{agent.run_count} runs · {agent.failure_count} failed · {relativeTime(agent.last_run_at)}</div>
                </div>
                <span className={`badge ${agent.enabled === 0 ? "badge-neutral" : agent.status === "failed" ? "badge-bad" : agent.status === "paused" ? "badge-warn" : agent.status === "working" || agent.status === "thinking" ? "badge-info" : agent.status === "completed" ? "badge-good" : "badge-neutral"}`}>
                  {agent.enabled === 0 ? "disabled" : agent.status}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Recent audit events</h2>
            <p className="card-sub">Logins, agent actions, uploads, deletions and configuration changes.</p>
          </div>
          <Link href="/admin/audit" className="btn btn-sm">Full log</Link>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Action</th><th>Detail</th><th>Actor</th><th>When</th></tr></thead>
            <tbody>
              {audit.map((entry, index) => (
                <tr key={index}>
                  <td className="cell-title">{entry.action}</td>
                  <td className="cell-sub">{entry.detail ?? "—"}</td>
                  <td className="cell-sub">{entry.actor ?? "system"}</td>
                  <td className="cell-sub">{formatDateTime(entry.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
