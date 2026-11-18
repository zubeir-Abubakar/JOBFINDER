import { requireUser, countSessions } from "@/lib/auth";
import { getProfileData } from "@/lib/profile";
import { getSettings } from "@/lib/settings";
import { one } from "@/lib/db";
import { storageStats } from "@/lib/retention";
import { PageHead, Flash } from "@/components/ui";
import { formatBytes, formatDate } from "@/lib/format";
import { param } from "@/lib/format";
import { PasswordForm } from "@/components/PasswordForm";
import { SubmitButton } from "@/components/SubmitButton";
import { UserAvatar } from "@/components/UserAvatar";
import { avatarUrlFor } from "@/lib/account";
import { updateAccountNameAction, uploadAccountAvatarAction, removeAccountAvatarAction } from "@/lib/actions/account";
import {
  saveProfessionalPreferencesAction,
  saveAutomationAction,
  saveDocumentSettingsAction,
  saveNotificationSettingsAction,
  clearExpiredDocumentsAction,
  cleanTempCacheAction,
  testEmailAction,
} from "@/lib/actions/settings";
import { tempStorageStats } from "@/lib/temp-store";
import { relativeTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const profile = getProfileData();
  const settings = getSettings();
  const prefs = profile.preferences;
  const ai = settings.ai ?? {};
  const security = settings.security ?? { session_days: 7, remember_days: 30, max_login_attempts: 8 };
  const emailConfig = settings.email ?? { connected: false, provider: "gmail", sender: "", account: "" };
  const stats = storageStats();
  const cache = tempStorageStats();
  const account = one<{ created_at: string; last_login_at: string | null }>("SELECT created_at, last_login_at FROM users WHERE id = ?", [user.id]);
  const sessions = countSessions(user.id);
  const avatarUrl = avatarUrlFor(user);

  return (
    <>
      <Flash
        ok={param(sp.ok)}
        error={param(sp.error)}
        saved={param(sp.saved)}
        cleanup={param(sp.cleanup)}
        freed={param(sp.freed)}
      />
      <PageHead
        title="Settings"
        sub="Recruitment preferences, automation guardrails, documents and notifications for your workspace."
        actions={<a href="#account" className="btn">Account & security</a>}
      />

      <div className="tabs">
        <a className="tab active" href="#professional">Professional</a>
        <a className="tab" href="#automation">Automation</a>
        <a className="tab" href="#documents">Documents</a>
        <a className="tab" href="#cache">Cache</a>
        <a className="tab" href="#notifications">Notifications</a>
        <a className="tab" href="#account">Account</a>
        <a className="tab" href="#security">Security</a>
      </div>

      <section className="card mb-4" id="cache">
        <div className="card-head">
          <div>
            <h2>Temporary cache</h2>
            <p className="card-sub">Registered temporary objects only. Permanent documents, the original CV, uploads and workflow history are never eligible.</p>
          </div>
          <span className="badge badge-neutral">{formatBytes(cache.activeBytes)}</span>
        </div>
        <div className="card-body">
          <div className="grid g2" style={{ gap: 10 }}>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Temporary objects</span><span className="num">{cache.activeCount}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Spoken audio cache</span><span className="num">{formatBytes(cache.ttsBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Transcripts</span><span className="num">{formatBytes(cache.transcriptBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Preview artefacts</span><span className="num">{formatBytes(cache.previewBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Temporary uploads</span><span className="num">{formatBytes(cache.uploadBytes)}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last cleanup</span><span>{cache.lastCleanupAt ? relativeTime(cache.lastCleanupAt) : "not run yet"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Next scheduled cleanup</span><span>{cache.nextCleanupAt ? relativeTime(cache.nextCleanupAt).replace(" ago", "") : "disabled"}</span></div>
            <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Last reclaimed</span><span>{cache.lastRemoved} file(s) · {formatBytes(cache.lastBytes)}</span></div>
          </div>
          <form action={cleanTempCacheAction} className="mt-3">
            <SubmitButton className="btn" confirm="Delete expired temporary cache entries now? Permanent CVs, cover letters and records are not touched.">
              Clean temporary cache now
            </SubmitButton>
          </form>
          <p className="hint">Default retention is 24 hours, cleaned at startup and every 6 hours. Only rows in the temp-object registry inside ./data/temp are removed.</p>
        </div>
      </section>

      <section className="card mb-4" id="professional">
        <div className="card-head">
          <div>
            <h2>Professional preferences</h2>
            <p className="card-sub">Drives research filtering and the language and location dimensions of the match score.</p>
          </div>
        </div>
        <div className="card-body">
          <form action={saveProfessionalPreferencesAction} className="grid g2" style={{ gap: 12 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label className="label" htmlFor="titles">Preferred job titles</label>
              <textarea id="titles" name="titles" className="textarea" rows={2} defaultValue={prefs.titles.join(", ")} />
              <p className="hint">Comma separated. Used as guidance, never as a hard filter.</p>
            </div>
            <div>
              <label className="label" htmlFor="locations">Preferred locations</label>
              <input id="locations" name="locations" className="input" defaultValue={prefs.locations.join(", ")} />
            </div>
            <div>
              <label className="label" htmlFor="industries">Preferred industries</label>
              <input id="industries" name="industries" className="input" defaultValue={(prefs.industries ?? []).join(", ")} />
            </div>
            <div>
              <label className="label" htmlFor="languages">Languages you can work in</label>
              <input id="languages" name="languages" className="input" defaultValue={(prefs.languages ?? profile.languages).join(", ")} />
            </div>
            <div>
              <label className="label" htmlFor="min_salary">Minimum salary (CHF, optional)</label>
              <input id="min_salary" name="min_salary" type="number" min={0} className="input" defaultValue={prefs.min_salary ?? ""} />
            </div>
            <div>
              <label className="label" htmlFor="employment_types">Employment types</label>
              <input id="employment_types" name="employment_types" className="input" defaultValue={(prefs.employment_types ?? []).join(", ")} />
            </div>
            <div>
              <label className="label" htmlFor="remote_preference">Remote preference</label>
              <select id="remote_preference" name="remote_preference" className="select" defaultValue={prefs.remote_preference}>
                <option value="any">No preference</option>
                <option value="hybrid_or_remote">Hybrid or remote</option>
                <option value="remote_only">Remote only</option>
                <option value="onsite">On-site</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="german_required">German requirements</label>
              <select id="german_required" name="german_required" className="select" defaultValue={prefs.german_required}>
                <option value="avoid">Flag roles requiring German</option>
                <option value="evaluate">Evaluate language level case by case</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="french">French requirements</label>
              <select id="french" name="french" className="select" defaultValue={prefs.french}>
                <option value="evaluate">Evaluate against the posting</option>
                <option value="avoid">Flag roles requiring French</option>
              </select>
            </div>
            <div className="flex items-end">
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save preferences</SubmitButton>
            </div>
          </form>
        </div>
      </section>

      <section className="card mb-4" id="automation">
        <div className="card-head">
          <div>
            <h2>Automation & approval</h2>
            <p className="card-sub">Approval mode is on by default. Autonomous submission requires a configured portal adapter and never bypasses security controls.</p>
          </div>
        </div>
        <div className="card-body">
          <form action={saveAutomationAction} className="grid g2" style={{ gap: 12 }}>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" name="approval_mode" defaultChecked={settings.approval_mode !== false} /> Require my approval before submission
            </label>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" name="autonomous_submission" defaultChecked={settings.autonomous_submission === true} /> Allow autonomous submission when every condition passes
            </label>
            <div>
              <label className="label" htmlFor="min_match_score">Minimum match score to prepare documents</label>
              <input id="min_match_score" name="min_match_score" type="number" min={0} max={100} className="input" defaultValue={settings.min_match_score ?? 60} />
            </div>
            <div>
              <label className="label" htmlFor="max_applications_per_day">Maximum applications per day</label>
              <input id="max_applications_per_day" name="max_applications_per_day" type="number" min={1} max={50} className="input" defaultValue={settings.max_applications_per_day ?? 5} />
            </div>
            <div>
              <label className="label" htmlFor="search_frequency">Search frequency</label>
              <select id="search_frequency" name="search_frequency" className="select" defaultValue={settings.search_frequency ?? "daily"}>
                <option value="manual">Manual only</option>
                <option value="daily">Daily</option>
                <option value="twice_daily">Twice daily</option>
                <option value="weekly">Weekly</option>
              </select>
              <p className="hint">Scheduled runs require the background runner (see README). Manual runs work immediately.</p>
            </div>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" name="duplicate_detection" defaultChecked={settings.duplicate_detection !== false} /> Block duplicate vacancies and applications
            </label>
            <div className="alert alert-info" style={{ gridColumn: "1 / -1" }}>
              Portal automation is not connected in this deployment. Nothing is submitted automatically, and no application is marked submitted without an employer
              confirmation reference. AI provider: {ai.provider ?? "rules"} · {ai.model ?? "at-rules-v1"}.
            </div>
            <div className="flex items-end">
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save automation</SubmitButton>
            </div>
          </form>
        </div>
      </section>

      <div className="split mb-4">
        <section className="card" id="documents">
          <div className="card-head">
            <div>
              <h2>Documents & retention</h2>
              <p className="card-sub">Tailored files expire after submission; the original CV and profile are kept indefinitely.</p>
            </div>
          </div>
          <div className="card-body">
            <form action={saveDocumentSettingsAction} className="stack" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="retention_days">Retention after confirmed submission</label>
                <select id="retention_days" name="retention_days" className="select" defaultValue={String(settings.retention_days ?? 30)}>
                  {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} days</option>)}
                </select>
              </div>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" name="auto_delete_expired" defaultChecked={settings.auto_delete_expired !== false} /> Automatically delete expired tailored documents and cover letters
              </label>
              <div className="row">
                <SubmitButton className="btn btn-primary">Save document settings</SubmitButton>
              </div>
            </form>
            <form action={clearExpiredDocumentsAction} className="mt-3">
              <SubmitButton className="btn" pendingLabel="Cleaning…" confirm="Apply the retention policy now and delete eligible files?">
                Clear expired documents now
              </SubmitButton>
            </form>
            <div className="card-quiet p-3 mt-3 text-[11.5px]" style={{ color: "var(--muted)" }}>
              {stats.tailoredCount + stats.coverCount} generated file(s) · {formatBytes(stats.totalBytes)} stored · {stats.expiringSoon.length} expiring within 7 days.
              Pinned documents and packages awaiting submission are never auto-deleted.
            </div>
          </div>
        </section>

        <section className="card" id="notifications">
          <div className="card-head">
            <div>
              <h2>Notifications</h2>
              <p className="card-sub">In-app notifications are always recorded. Email delivery depends on the configured provider.</p>
            </div>
          </div>
          <div className="card-body">
            <form action={saveNotificationSettingsAction} className="stack" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="email">Notification email</label>
                <input id="email" name="email" type="email" className="input" defaultValue={profile.profile.email ?? user.email} />
                <p className="hint">Currently {emailConfig.connected ? `delivery via ${emailConfig.provider}` : "in-app only — no email provider connected"}.</p>
              </div>
              {[
                ["notify_daily_report", "Daily report", settings.notify_daily_report !== false],
                ["notify_weekly_report", "Weekly summary", settings.notify_weekly_report !== false],
                ["notify_immediate", "Immediate events (strong match, document ready, submission)", settings.notify_immediate !== false],
                ["notify_agent_failure", "Agent failure alerts", settings.notify_agent_failure !== false],
                ["notify_interview", "Interview invitations", settings.notify_interview !== false],
              ].map(([name, label, checked]) => (
                <label key={String(name)} className="flex items-center gap-2 text-[12.5px]">
                  <input type="checkbox" name={String(name)} defaultChecked={Boolean(checked)} /> {label}
                </label>
              ))}
              <SubmitButton className="btn btn-primary">Save notifications</SubmitButton>
            </form>
            <form action={testEmailAction} className="mt-2">
              <SubmitButton className="btn btn-sm">Send test email</SubmitButton>
            </form>
          </div>
        </section>
      </div>

      <div className="split" id="security">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Change password</h2>
              <p className="card-sub">Scrypt-hashed, never stored in plain text.</p>
            </div>
          </div>
          <div className="card-body">
            <PasswordForm />
          </div>
        </section>
        <section className="card" id="account">
          <div className="card-head">
            <div>
              <h2>Account</h2>
              <p className="card-sub">Your name and photo appear throughout the workspace.</p>
            </div>
            <span className="badge badge-neutral">{user.role === "admin" ? "Administrator" : "Owner"}</span>
          </div>
          <div className="card-body">
            <div className="account-profile">
              <UserAvatar name={user.name} src={avatarUrl} size={76} />
              <div className="min-w-0">
                <div className="text-[13.5px] font-semibold">{user.name}</div>
                <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{user.email}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <form action={uploadAccountAvatarAction} encType="multipart/form-data" className="account-avatar-form">
                    <input
                      id="avatar"
                      name="avatar"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                      className="input"
                      required
                    />
                    <SubmitButton className="btn btn-sm" pendingLabel="Uploading…">Upload photo</SubmitButton>
                  </form>
                  {avatarUrl ? (
                    <form action={removeAccountAvatarAction}>
                      <SubmitButton className="btn btn-sm btn-danger" confirm="Remove your profile photo?">Remove</SubmitButton>
                    </form>
                  ) : null}
                </div>
                <p className="hint">JPG, PNG or WebP · maximum 3 MB. A square photo works best.</p>
              </div>
            </div>

            <form action={updateAccountNameAction} className="account-name-form mt-4">
              <div>
                <label className="label" htmlFor="account_name">Account name</label>
                <input
                  id="account_name"
                  name="name"
                  className="input"
                  defaultValue={user.name}
                  maxLength={80}
                  autoComplete="name"
                  required
                />
              </div>
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save name</SubmitButton>
            </form>
            <p className="hint">This updates your workspace identity and professional profile name. Email address and role cannot be changed here.</p>

            <div className="stack text-[12.5px] mt-4" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Email</span><span>{user.email}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Role</span><span className="badge badge-neutral">{user.role === "admin" ? "Administrator" : "Owner"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Account created</span><span>{formatDate(account?.created_at)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Last sign-in</span><span>{account?.last_login_at ? formatDate(account.last_login_at) : "—"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Active sessions</span><span className="num">{sessions}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Session length</span><span>{security.session_days} days (remember me {security.remember_days})</span></div>
              <p className="hint">Data deletion: delete individual documents from My CV & documents, or ask the administrator to remove the account. Application history and audit records are
                retained deliberately for accountability.</p>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
