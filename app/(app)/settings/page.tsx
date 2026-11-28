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
import { MfaSettings } from "@/components/MfaSettings";
import { avatarUrlFor } from "@/lib/account";
import { updateAccountNameAction, uploadAccountAvatarAction, removeAccountAvatarAction } from "@/lib/actions/account";
import { configuredTextProvider, providerStatusSnapshot } from "@/lib/providers";
import {
  saveProfessionalPreferencesAction,
  saveAutomationAction,
  saveDocumentSettingsAction,
  saveNotificationSettingsAction,
  saveRecruitmentScheduleAction,
  saveReportScheduleAction,
  clearExpiredDocumentsAction,
  cleanTempCacheAction,
  testEmailAction,
} from "@/lib/actions/settings";
import { scheduleSnapshot, halfHourOptions, formatInZone, weekdayLabel } from "@/lib/recruitment-schedule";
import { executiveBriefScheduleSnapshot } from "@/lib/executive-brief";
import { Icon } from "@/components/icons";
import { tempStorageStats } from "@/lib/temp-store";
import { effectiveMinMatchScore } from "@/lib/scoring";
import { relativeTime } from "@/lib/format";
import type { ResendSendResult } from "@/lib/resend";

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
  const aiRoute = configuredTextProvider();
  const aiRuntime = providerStatusSnapshot();
  const fallbackLabel = !aiRuntime.fallbackEnabled
    ? "not configured"
    : aiRuntime.fallbackAvailable === true
      ? "ready"
      : aiRuntime.fallbackAvailable === false
        ? "unavailable"
        : "awaiting health check";
  const security = settings.security ?? { session_days: 7, remember_days: 30, max_login_attempts: 8 };
  const emailConfig = settings.email ?? { connected: false, provider: "gmail", sender: "", account: "" };
  const emailTest =
    settings.email_test_last && typeof settings.email_test_last === "object"
      ? (settings.email_test_last as ResendSendResult)
      : null;
  const stats = storageStats();
  const cache = tempStorageStats();
  const account = one<{ created_at: string; last_login_at: string | null }>("SELECT created_at, last_login_at FROM users WHERE id = ?", [user.id]);
  const mfa = one<{ mfa_enabled: number }>("SELECT mfa_enabled FROM users WHERE id = ?", [user.id]);
  const sessions = countSessions(user.id);
  const avatarUrl = avatarUrlFor(user);
  const recruitmentSchedule = scheduleSnapshot();
  const reportSchedule = executiveBriefScheduleSnapshot();
  const timeOptions = halfHourOptions();
  const weekdayOptions = [1, 2, 3, 4, 5, 6, 7];

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
        actions={
          <>
            <a href="#account" className="btn">Account & security</a>
            <a href="/diagnostics" className="btn">Mobile diagnostics</a>
          </>
        }
      />

      <div className="tabs">
        <a className="tab active" href="#professional">Professional</a>
        <a className="tab" href="#scheduling">Scheduling</a>
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

      <section className="card mb-4" id="ai-routing">
        <div className="card-head">
          <div>
            <h2>AI runtime</h2>
            <p className="card-sub">Effective provider routing from the running server. Credentials are never shown.</p>
          </div>
          <span className={`badge ${aiRuntime.fallbackEnabled ? "badge-good" : "badge-neutral"}`}>
            {fallbackLabel === "ready" ? "local fallback ready" : fallbackLabel}
          </span>
        </div>
        <div className="card-body grid g2 text-[12px]" style={{ gap: 10 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Primary text route</span><span>{aiRoute.provider ?? "none"} · <span className="num">{aiRoute.model ?? "not set"}</span></span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Local fallback</span><span>{aiRuntime.fallbackEnabled ? `loopback Ollama · ${aiRuntime.fallbackModel ?? "not set"}` : "disabled or not loopback"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Fallback health</span><span>{fallbackLabel}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Fallback triggers</span><span>timeout, rate limit, unavailable model or provider outage</span></div>
          <div className="between" style={{ gridColumn: "1 / -1" }}><span style={{ color: "var(--muted)" }}>Fail closed</span><span>authentication, malformed request and policy failures are never sent to another provider</span></div>
          <p className="hint" style={{ gridColumn: "1 / -1" }}>{aiRoute.detail}</p>
        </div>
      </section>

      <section className="card mb-4" id="automation">
        <div className="card-head">
          <div>
            <h2>Automation &amp; submission</h2>
            <p className="card-sub">Eligible applications are submitted automatically after every eligibility, document, duplicate and safety check passes. There is no per-application approval step; consequential declarations, CAPTCHAs, MFA and unsupported portals still stop the workflow for you.</p>
          </div>
        </div>
        <div className="card-body">
          <form action={saveAutomationAction} className="grid g2" style={{ gap: 12 }}>
            <label className="flex items-center gap-2 text-[12.5px]">
              <input type="checkbox" name="autonomous_submission" defaultChecked={settings.autonomous_submission !== false} /> Submit eligible applications automatically (no per-application approval)
            </label>
            <div>
              <label className="label" htmlFor="min_match_score">Minimum match score to prepare documents</label>
              <input id="min_match_score" name="min_match_score" type="number" min={effectiveMinMatchScore(settings.min_match_score)} max={100} className="input" defaultValue={effectiveMinMatchScore(settings.min_match_score)} />
              <p className="hint">The scoring engine enforces {effectiveMinMatchScore(settings.min_match_score)}%: the value can be raised but never set below that floor.</p>
            </div>
            <div>
              <label className="label" htmlFor="max_applications_per_day">Maximum applications per day</label>
              <input id="max_applications_per_day" name="max_applications_per_day" type="number" min={1} max={3} className="input" defaultValue={settings.max_applications_per_day ?? 3} />
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
              A candidate-facing form can be completed only when every answer is in your verified profile. CAPTCHAs, MFA, logins, payments and legal declarations are never
              bypassed; an unknown essential answer queues the application. No application is counted as submitted without employer confirmation. AI provider: {aiRoute.provider ?? "deterministic rules"} · {aiRoute.model ?? "rules"}.
            </div>
            <div className="flex items-end">
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save automation</SubmitButton>
            </div>
          </form>
        </div>
      </section>

      <section id="scheduling" className="mb-4">
        <div className="between mb-3 schedule-head">
          <div>
            <h2 className="text-[15px] font-semibold">Automation schedule</h2>
            <p className="card-sub">Two independent weekly schedules. Times are local to Europe/Zurich and survive restarts and daylight-saving changes.</p>
          </div>
          <span className="badge badge-neutral"><Icon name="clock" size={12} /> Europe/Zurich</span>
        </div>
        <div className="schedule-grid">
          <form action={saveRecruitmentScheduleAction} className="card schedule-card" data-testid="recruitment-schedule-card">
            <div className="card-head">
              <div className="flex items-center gap-2.5">
                <span className="schedule-icon"><Icon name="jobs" size={17} /></span>
                <div>
                  <h3 className="text-[13.5px] font-semibold">Recruitment runs</h3>
                  <p className="card-sub">Choose when your agents should discover, assess, prepare and submit job applications.</p>
                </div>
              </div>
              <span className={`badge ${recruitmentSchedule.enabled ? (recruitmentSchedule.runsToday ? "badge-good" : "badge-neutral") : "badge-warn"}`}>
                {recruitmentSchedule.enabled ? (recruitmentSchedule.runsToday ? "Active today" : "Rest day today") : "Disabled"}
              </span>
            </div>
            <div className="card-body stack" style={{ gap: 12 }}>
              <label className="schedule-toggle">
                <input type="checkbox" name="enabled" defaultChecked={recruitmentSchedule.enabled} />
                <span>Enable scheduled recruitment</span>
              </label>
              <div>
                <span className="label">Days</span>
                <div className="weekday-picker" role="group" aria-label="Recruitment weekdays">
                  {weekdayOptions.map((day) => (
                    <label key={`recruitment-${day}`} className={`weekday-chip ${recruitmentSchedule.weekdays.includes(day) ? "is-on" : ""}`}>
                      <input type="checkbox" name="weekdays" value={day} defaultChecked={recruitmentSchedule.weekdays.includes(day)} />
                      <span>{weekdayLabel(day).slice(0, 3)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="schedule-time-row">
                <div>
                  <label className="label" htmlFor="recruitment-time">Start time</label>
                  <select id="recruitment-time" name="time" className="select" defaultValue={recruitmentSchedule.time}>
                    {timeOptions.map((option) => <option key={`recruitment-time-${option}`} value={option}>{option}</option>)}
                  </select>
                </div>
                <div>
                  <span className="label">Timezone</span>
                  <span className="schedule-timezone">Europe/Zurich<input type="hidden" name="timezone" value="Europe/Zurich" /></span>
                </div>
              </div>
              <p className="hint" data-testid="recruitment-next-run">
                One automated run per day at {recruitmentSchedule.time} {recruitmentSchedule.timezone} ({recruitmentSchedule.weekdayLabels.join(", ")}). Next run: {formatInZone(recruitmentSchedule.nextRunAt, recruitmentSchedule.timezone)}. On unselected days no scheduled discovery, document generation or inference runs; manual requests still work.
              </p>
              <div><SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save recruitment schedule</SubmitButton></div>
            </div>
          </form>

          <form action={saveReportScheduleAction} className="card schedule-card" data-testid="report-schedule-card">
            <div className="card-head">
              <div className="flex items-center gap-2.5">
                <span className="schedule-icon"><Icon name="mail" size={17} /></span>
                <div>
                  <h3 className="text-[13.5px] font-semibold">Daily report</h3>
                  <p className="card-sub">Choose when Chief should send your daily recruitment and agent activity report.</p>
                </div>
              </div>
              <span className={`badge ${reportSchedule.enabled ? (reportSchedule.scheduledToday ? "badge-good" : "badge-neutral") : "badge-warn"}`}>
                {reportSchedule.enabled ? (reportSchedule.scheduledToday ? "Due today" : "Not today") : "Disabled"}
              </span>
            </div>
            <div className="card-body stack" style={{ gap: 12 }}>
              <label className="schedule-toggle">
                <input type="checkbox" name="enabled" defaultChecked={reportSchedule.enabled === 1} />
                <span>Enable the daily report</span>
              </label>
              <div>
                <span className="label">Days</span>
                <div className="weekday-picker" role="group" aria-label="Daily report weekdays">
                  {weekdayOptions.map((day) => (
                    <label key={`report-${day}`} className={`weekday-chip ${reportSchedule.weekdaysList.includes(day) ? "is-on" : ""}`}>
                      <input type="checkbox" name="weekdays" value={day} defaultChecked={reportSchedule.weekdaysList.includes(day)} />
                      <span>{weekdayLabel(day).slice(0, 3)}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="schedule-time-row">
                <div>
                  <label className="label" htmlFor="report-time">Delivery time</label>
                  <select id="report-time" name="time" className="select" defaultValue={reportSchedule.time}>
                    {timeOptions.map((option) => <option key={`report-time-${option}`} value={option}>{option}</option>)}
                  </select>
                </div>
                <div>
                  <span className="label">Timezone</span>
                  <span className="schedule-timezone">Europe/Zurich<input type="hidden" name="timezone" value="Europe/Zurich" /></span>
                </div>
              </div>
              <p className="hint" data-testid="report-next-run">
                Next report: {formatInZone(reportSchedule.next_run_at, reportSchedule.timezone)}. The report uses recorded activity only and is never sent twice for the same occurrence.
              </p>
              <div><SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save report schedule</SubmitButton></div>
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
                <p className="hint">
                  Currently{" "}
                  {emailConfig.connected
                    ? "Gmail is connected for explicit test delivery. In-app notifications are recorded independently."
                    : "in-app only — no email provider connected"}
                  . The test uses this saved address; save Notifications before testing.
                </p>
              </div>
              {[
                ["notify_daily_report", "Daily executive brief (one consolidated Coordinator report)", settings.notify_daily_report !== false],
                ["notify_weekly_report", "Weekly summary", settings.notify_weekly_report !== false],
                ["notify_immediate", "Exception alerts (blocked applications, failed submissions, interviews)", settings.notify_immediate !== false],
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
              <SubmitButton className="btn btn-sm" pendingLabel="Sending…">Send test email</SubmitButton>
            </form>
            {emailTest ? (
              <div
                className={`alert ${emailTest.status === "accepted" ? "alert-ok" : emailTest.status === "api_error" ? "alert-warn" : "alert-error"} mt-3`}
              >
                <strong>
                  {emailTest.status === "accepted"
                    ? "Resend accepted the test message."
                    : emailTest.status === "authentication_failed"
                      ? "Resend rejected the API key."
                      : emailTest.status === "missing_configuration"
                        ? "Resend is not configured."
                        : emailTest.status === "invalid_recipient"
                          ? "Notification recipient is invalid."
                          : emailTest.status === "permission_denied"
                            ? "Resend denied this send."
                            : emailTest.status === "invalid_request"
                              ? "Resend rejected the sender or message content."
                              : "Resend could not be reached."}
                </strong>
                <div className="mt-1">{emailTest.detail}</div>
                <div className="mt-1 text-[11px]" style={{ color: "var(--muted)" }}>
                  Provider: Resend · Recipient: {emailTest.recipientMasked || "not configured"}
                  {emailTest.messageId ? <> · Provider message ID: {emailTest.messageId}</> : null}
                  {emailTest.status === "accepted" ? " · Inbox delivery not independently confirmed" : null}
                  {emailTest.at ? <> · {relativeTime(emailTest.at)}</> : null}
                </div>
              </div>
            ) : (
              <p className="hint mt-2">Only the saved notification recipient is used. The app never sends a test to an employer.</p>
            )}
          </div>
        </section>
      </div>

      <MfaSettings enabled={mfa?.mfa_enabled === 1} />

      <div className="split">
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
