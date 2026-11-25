import Link from "next/link";
import fs from "node:fs";
import path from "node:path";
import { requireAdmin } from "@/lib/auth";
import { DATA_DIR, all, one } from "@/lib/db";
import { PageHead, Empty } from "@/components/ui";
import { operationalHealthSnapshot } from "@/lib/runtime-health";
import { providerHealth } from "@/lib/providers";
import { liveVoiceConfig } from "@/lib/live-voice";
import { storageStats } from "@/lib/retention";
import { getSettings } from "@/lib/settings";
import { formatBytes, formatDateTime, relativeTime } from "@/lib/format";
import { agentIdentity } from "@/lib/agent-identity";
import { agentVoiceOverrides, effectiveVoiceProfileForAgent } from "@/lib/agent-voice-settings";
import { AGENT_VOICE_PROFILES } from "@/lib/agent-voices";

export const dynamic = "force-dynamic";

export default async function AdminDiagnosticsPage() {
  await requireAdmin();
  const health = operationalHealthSnapshot();
  const providers = await providerHealth();
  const voice = liveVoiceConfig();
  const settings = getSettings();
  const stats = storageStats();

  let dbBytes = 0;
  try {
    dbBytes = fs.statSync(path.join(DATA_DIR, "at-ai-workforce.db")).size;
  } catch {}

  const backup = settings.backup ?? { enabled: true, last_backup_at: null };
  const taskCounts = all<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status");
  const outbox = all<{ status: string; c: number }>("SELECT status, COUNT(*) AS c FROM notification_outbox GROUP BY status");
  const failedTasks = all<{ id: string; agent_key: string; title: string; error: string | null; created_at: string }>(
    "SELECT id, agent_key, title, error, created_at FROM tasks WHERE status = 'failed' ORDER BY created_at DESC LIMIT 8",
  );
  const errorEvents = all<{ id: number; action: string; detail: string | null; created_at: string }>(
    "SELECT id, action, detail, created_at FROM audit_logs WHERE action LIKE '%failed%' OR action LIKE '%error%' OR action LIKE '%blocked%' OR action LIKE '%unverified%' ORDER BY id DESC LIMIT 10",
  );
  const workflows = all<{ id: string; label: string; status: string; created_at: string; error: string | null }>(
    "SELECT id, label, status, created_at, error FROM workflows ORDER BY created_at DESC LIMIT 5",
  );
  const pauses = one<{ c: number }>("SELECT COUNT(*) AS c FROM agents WHERE status = 'paused'")?.c ?? 0;
  const disabled = one<{ c: number }>("SELECT COUNT(*) AS c FROM agents WHERE enabled = 0")?.c ?? 0;
  const overrides = agentVoiceOverrides();
  const notificationFailures = Number(outbox.find((row) => row.status === "failed")?.c ?? 0);
  // A policy-blocked external route is an expected zero-spend state, not an
  // outage. Only a configured, enabled, non-policy route that is unreachable
  // needs intervention. Deterministic operations remain healthy independently.
  const providerProblem = providers.some(
    (provider) => provider.configured && provider.enabled && !provider.policyBlocked && !provider.available,
  );
  const aiRestricted = !providers.some((provider) => provider.available && !provider.policyBlocked);
  const needsAttention = health.status !== "operational" || notificationFailures > 0 || providerProblem;

  return (
    <>
      <PageHead
        title="Diagnostics"
        sub="One place for application health, the background runner, providers, delivery, voice and recent failures. Every status is read from persisted state."
        actions={<Link href="/admin/audit" className="btn">Audit explorer</Link>}
      />

      {needsAttention ? (
        <div className="alert alert-warn mb-4">
          <strong>Intervention may be needed.</strong>{" "}
          {health.status !== "operational" ? health.detail : ""}
          {notificationFailures ? ` ${notificationFailures} outbound email(s) failed.` : ""}
          {providerProblem ? " A configured AI route is unreachable." : ""}
        </div>
      ) : (
        <div className="alert alert-ok mb-4">
          <strong>No intervention needed.</strong> Database, scheduler and background workers report operational.
        </div>
      )}

      {aiRestricted ? (
        <div className="alert alert-info mb-4">
          <strong>No AI route is verified by a successful call yet.</strong>{" "}
          Gemini text, vision and Live voice use only a verified free tier; Live voice is {voice.blockedByPolicy ? `blocked (${voice.freeTierState})` : "verified free-tier"} under the same CHF 0.00 policy.
          Availability is not claimed from configuration alone. Deterministic discovery, scoring, document checks and Chief coordination continue.
        </div>
      ) : null}

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Application health</h2>
            <p className="card-sub">Checked {formatDateTime(health.checkedAt)} · instance {health.instanceId.slice(0, 12)}</p>
          </div>
          <span className={`badge ${health.status === "operational" ? "badge-good" : health.status === "degraded" ? "badge-warn" : "badge-bad"}`}>
            {health.status}
          </span>
        </div>
        <div className="card-body grid g2" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Database</span><span>{health.database.ok ? `integrity ${health.database.integrity}` : "unavailable"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Schema version</span><span className="num">{health.database.schemaVersion}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Database mode</span><span className="num">{health.database.fileMode ?? "—"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Uploads mode</span><span className="num">{health.database.uploadMode ?? "—"}</span></div>
            {health.database.permissionWarning ? (
              <div className="text-[11px]" style={{ color: "var(--danger)" }}>{health.database.permissionWarning}</div>
            ) : null}
          </div>
          <div className="stack" style={{ gap: 6 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Scheduler</span><span>{health.scheduler.enabled ? (health.scheduler.tickerRunning ? "running" : "stopped") : "disabled"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Next run</span><span>{health.recruitment.nextRunLabel || "—"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last tick</span><span>{health.scheduler.lastTickAt ? relativeTime(health.scheduler.lastTickAt) : "none"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Paused agents</span><span className="num">{pauses}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Disabled agents</span><span className="num">{disabled}</span></div>
          </div>
        </div>
      </section>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Background runner</h2>
              <p className="card-sub">Workflow state and task counts. A restart marks interrupted steps failed and pauses the run.</p>
            </div>
            <Link href="/admin/agents" className="btn btn-sm">Agents</Link>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {taskCounts.length === 0 ? <Empty title="No tasks recorded" /> : taskCounts.map((row) => (
              <div key={row.status} className="between text-[12px]"><span style={{ color: "var(--muted)" }}>{row.status}</span><span className="num">{row.c}</span></div>
            ))}
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 8 }} className="stack">
              {workflows.length === 0 ? <p className="hint">No workflows have run yet.</p> : workflows.map((workflow) => (
                <div key={workflow.id} className="between text-[11.5px]">
                  <span className="truncate" style={{ maxWidth: 260 }}>{workflow.label}</span>
                  <span className={`badge ${workflow.status === "completed" ? "badge-good" : workflow.status === "failed" ? "badge-bad" : workflow.status === "running" ? "badge-info" : "badge-warn"}`}>{workflow.status}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Database &amp; backup</h2>
              <p className="card-sub">Local SQLite with WAL. Backups use the existing admin action.</p>
            </div>
            <Link href="/admin/security" className="btn btn-sm">Backup controls</Link>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Database file</span><span className="num">{formatBytes(dbBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Upload storage</span><span>{formatBytes(stats.totalBytes)} · {stats.originalCount + stats.tailoredCount + stats.coverCount} files</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last backup</span><span>{backup.last_backup_at ? relativeTime(backup.last_backup_at) : "never"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Backup schedule</span><span>{backup.enabled ? "enabled" : "disabled"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Retention</span><span>{settings.retention_days ?? 30} days</span></div>
          </div>
        </section>
      </div>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>AI providers &amp; fallback</h2>
              <p className="card-sub">Connectivity is separate from successful inference. Configuration errors fail closed.</p>
            </div>
            <Link href="/admin/ai" className="btn btn-sm">Configure</Link>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {providers.map((provider) => (
              <div key={provider.name} className="between text-[12px]">
                <div>
                  <div>{provider.name}</div>
                  <div className="cell-sub">{provider.detail}{provider.model ? ` · ${provider.model}` : ""}</div>
                </div>
                <span className={`badge ${provider.available ? "badge-good" : provider.configured && !provider.policyBlocked ? (provider.name === "gemini" ? "badge-warn" : "badge-bad") : "badge-warn"}`}>
                  {provider.available
                    ? "verified by successful call"
                    : provider.configured && provider.policyBlocked
                      ? "blocked by policy"
                      : provider.configured && provider.name === "gemini"
                        ? "configured · awaiting verified call"
                        : provider.configured
                          ? "unreachable"
                          : "not configured"}
                </span>
              </div>
            ))}
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last successful inference</span><span>{health.providers.lastSuccessfulInferenceAt ? `${health.providers.lastSuccessfulProvider}/${health.providers.lastSuccessfulModel} · ${relativeTime(health.providers.lastSuccessfulInferenceAt)}` : "none recorded"}</span></div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Email delivery</h2>
              <p className="card-sub">Durable outbox. Gmail acceptance and recipient delivery remain separate facts.</p>
            </div>
            <Link href="/admin/email" className="btn btn-sm">Email &amp; delivery</Link>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {outbox.length === 0 ? <p className="hint">No outbound messages recorded.</p> : outbox.map((row) => (
              <div key={row.status} className="between text-[12px]">
                <span style={{ color: "var(--muted)" }}>{row.status}</span>
                <span className="num">{row.c}</span>
              </div>
            ))}
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Gmail connection</span><span>{settings.email?.connected ? settings.email.provider : "not connected"}</span></div>
          </div>
        </section>
      </div>

      <section className="card mb-4" id="voice">
        <div className="card-head">
          <div>
            <h2>Voice service</h2>
            <p className="card-sub">Gemini Live uses only the verified Gemini free tier under the CHF 0.00 policy. Chief remains the first voice contact with the Charon voice; each agent keeps its configured or admin-overridden identity.</p>
          </div>
          <span className={`badge ${voice.blockedByPolicy ? "badge-warn" : voice.configured ? "badge-good" : "badge-neutral"}`}>
            {voice.blockedByPolicy ? "blocked by policy" : voice.configured ? "free-tier verified" : "not configured"}
          </span>
        </div>
        <div className="card-body grid g2" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>External model</span><span className="num">{voice.model}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Policy</span><span>{voice.blockedByPolicy ? "blocked; no microphone audio sent" : "verified free tier · no paid fallback · CHF 0.00"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Chief voice</span><span>Charon · Gemini Live</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Local voice</span><span>not used as the primary voice</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Missing configuration</span><span>{voice.missing.length ? voice.missing.join(", ") : "none"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Admin overrides</span><span className="num">{Object.keys(overrides).length}</span></div>
            <Link href="/admin/agents#voices" className="btn btn-sm" style={{ alignSelf: "flex-start" }}>Change agent voices</Link>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            {Object.keys(AGENT_VOICE_PROFILES).map((key) => {
              const profile = effectiveVoiceProfileForAgent(key);
              return (
                <div key={key} className="between text-[11.5px]">
                  <span>{agentIdentity(key).name}</span>
                  <span style={{ color: "var(--muted)" }}>{profile.voiceName}</span>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Agent execution failures</h2>
              <p className="card-sub">Latest failed tasks with the stored error.</p>
            </div>
            <Link href="/admin/agents" className="btn btn-sm">Agent controls</Link>
          </div>
          <div className="table-wrap">
            {failedTasks.length === 0 ? (
              <Empty title="No failed tasks" />
            ) : (
              <table className="data">
                <thead><tr><th>Task</th><th>Agent</th><th>Error</th><th>When</th></tr></thead>
                <tbody>
                  {failedTasks.map((task) => (
                    <tr key={task.id}>
                      <td className="cell-title">{task.title}</td>
                      <td className="cell-sub">{agentIdentity(task.agent_key).shortName}</td>
                      <td className="cell-sub" style={{ maxWidth: 320 }}>{task.error ?? "—"}</td>
                      <td className="cell-sub">{formatDateTime(task.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Recent errors and blocks</h2>
              <p className="card-sub">Audit events that may explain a failure.</p>
            </div>
            <Link href="/admin/audit?severity=error" className="btn btn-sm">Filter audit</Link>
          </div>
          <div className="card-body">
            {errorEvents.length === 0 ? (
              <Empty title="No recent errors" />
            ) : (
              <div className="feed">
                {errorEvents.map((event) => (
                  <div key={event.id} className="feed-item">
                    <span className="feed-dot"><span className="dot" /></span>
                    <div>
                      <div className="feed-text">{event.detail ?? event.action}</div>
                      <div className="feed-time">{event.action} · {formatDateTime(event.created_at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
