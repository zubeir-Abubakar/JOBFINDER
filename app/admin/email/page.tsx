import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { refreshExecutiveBriefDeliveryAction, saveEmailConfigAction, sendExecutiveBriefNowAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";
import { accountStatus } from "@/lib/gmail";
import { notificationQueueSnapshot } from "@/lib/notify";
import { executiveBriefHistory, executiveBriefScheduleSnapshot, latestExecutiveBriefDelivery } from "@/lib/executive-brief";
import { connectGmailAction, disconnectGmailAction, syncGmailAction } from "@/lib/actions/gmail";

export const dynamic = "force-dynamic";

export default async function AdminEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdmin();
  const sp = await searchParams;
  const settings = getSettings();
  const email = settings.email ?? { provider: "gmail", connected: false, sender: "", account: "" };
  const notifications = all<{ id: number; kind: string; subject: string; channel: string; status: string; delivery_status: string | null; provider_message_id: string | null; created_at: string }>(
    "SELECT id, kind, subject, channel, status, delivery_status, provider_message_id, created_at FROM notifications ORDER BY id DESC LIMIT 15",
  );
  const gmail = accountStatus();
  const outbox = notificationQueueSnapshot();
  const briefSchedule = executiveBriefScheduleSnapshot();
  const briefHistory = executiveBriefHistory(5);
  const briefDelivery = latestExecutiveBriefDelivery();
  const briefState = param(sp.brief);
  const briefDetail = param(sp.detail);

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
      {briefState ? (
        <div className={`alert ${briefState === "failed" || briefState === "blocked" || briefState === "bounced" ? "alert-error" : briefState === "accepted_by_gmail" || briefState === "sent_folder_observed" || briefState === "delivery_confirmed" ? "alert-info" : "alert-warn"} mb-3`}>
          <strong>Executive brief state: {briefState.replace(/_/g, " ")}.</strong>
          {briefDetail ? <div className="mt-1">{briefDetail}</div> : null}
        </div>
      ) : null}
      <PageHead title="Email & reports" sub="Gmail OAuth configuration and notification delivery. No account password is ever requested or stored." />

      <div className="split">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Email provider</h2>
              <p className="card-sub">OAuth credentials must exist in the environment before delivery can be enabled.</p>
            </div>
            <span className={`badge ${gmail.connected && !gmail.needsReconnect ? "badge-good" : gmail.connected || !gmail.oauthReady ? "badge-warn" : "badge-info"}`}>
              {gmail.connected ? (gmail.needsReconnect ? `reconnect required · ${gmail.email}` : `connected · ${gmail.email}`) : gmail.oauthReady ? "ready to connect" : "configuration missing"}
            </span>
          </div>
          <div className="card-body">
            {gmail.missing.length > 0 ? (
              <div className="alert alert-error mb-3">
                <strong>Gmail OAuth is not ready.</strong>
                <ul className="mt-1" style={{ paddingLeft: 16, listStyle: "disc" }}>
                  {gmail.missing.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
            ) : null}
            {gmail.connected && gmail.needsReconnect ? (
              <div className="alert alert-warn mb-3">
                <strong>Reconnection required.</strong> The saved token is missing:{" "}
                {gmail.missingScopes.map((scope) => scope.split("/").pop()).join(", ")}. Reconnect and approve all permissions; messages and drafts stay in the database.
              </div>
            ) : null}
            <div className="row mb-3">
              {gmail.connected ? (
                <>
                  {gmail.needsReconnect ? (
                    <form action={connectGmailAction}><SubmitButton className="btn btn-primary" pendingLabel="Opening Google…">Reconnect Gmail</SubmitButton></form>
                  ) : (
                    <form action={syncGmailAction}><SubmitButton className="btn btn-primary" pendingLabel="Scanning…">Sync inbox</SubmitButton></form>
                  )}
                  <form action={disconnectGmailAction}><SubmitButton className="btn btn-danger" confirm="Disconnect Gmail for this installation?">Disconnect Gmail</SubmitButton></form>
                </>
              ) : (
                <form action={connectGmailAction}><SubmitButton className="btn btn-primary" pendingLabel="Opening Google…">Connect Gmail</SubmitButton></form>
              )}
            </div>
            <form action={saveEmailConfigAction} className="stack" style={{ gap: 10 }}>
              <div>
                <label className="label" htmlFor="provider">Provider</label>
                <select id="provider" name="provider" className="select" defaultValue={email.provider}>
                  <option value="gmail">Gmail API (OAuth 2.0)</option>
                  <option value="smtp">SMTP relay</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor="sender">Sender address</label>
                <input id="sender" name="sender" type="email" className="input" defaultValue={email.sender} placeholder="you@gmail.com" />
              </div>
              <div>
                <label className="label" htmlFor="account">Mailbox to monitor for employer replies</label>
                <input id="account" name="account" type="email" className="input" defaultValue={email.account} placeholder="you@gmail.com" />
              </div>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" name="connected" defaultChecked={email.connected} /> Mark the provider as connected
              </label>
              <div className="alert alert-info">
                Marking this connected does not send anything by itself. Notification emails use a durable outbox with deduplication and bounded retries. Gmail API acceptance is recorded as delivery “accepted”, never as confirmed inbox delivery. In-app notifications remain independent of email delivery.
              </div>
              <SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save email configuration</SubmitButton>
            </form>

            <div className="card-quiet p-3 mt-4 text-[11.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
              <strong style={{ color: "var(--ink)" }}>Gmail OAuth setup</strong>
              <ol className="mt-2" style={{ paddingLeft: 16, listStyle: "decimal" }}>
                <li>Create a Google Cloud project and enable the Gmail API.</li>
                <li>Configure an OAuth consent screen (internal, single user).</li>
                <li>Create OAuth client credentials and add the redirect URI for this host.</li>
                <li>Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI in .env, then connect from the inbox to store an encrypted refresh token.</li>
                <li>Restart the server, then enable delivery above.</li>
              </ol>
              <p className="mt-2">
                Requested scopes: gmail.readonly (read), gmail.compose (drafts), gmail.send (approval-gated sending) and openid/email (mailbox identity). Never use an app password for the primary mailbox.
              </p>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Notification log</h2>
              <p className="card-sub">Everything the tracking agent recorded.</p>
            </div>
          </div>
          <div className="card-body">
            <div className="card-quiet p-3 mb-3 text-[11.5px] leading-relaxed">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <strong>Latest executive brief delivery</strong>
                <span className={`badge ${briefDelivery.state === "delivery_confirmed" || briefDelivery.state === "sent_folder_observed" ? "badge-good" : briefDelivery.state === "accepted_by_gmail" ? "badge-info" : briefDelivery.state === "failed" || briefDelivery.state === "blocked" || briefDelivery.state === "bounced" ? "badge-warn" : "badge-info"}`}>{briefDelivery.state.replace(/_/g, " ")}</span>
              </div>
              <div>{briefDelivery.message}</div>
              <div className="mt-2"><strong>Report:</strong> {briefDelivery.reportId} · <strong>Outbox:</strong> {briefDelivery.outboxId ?? "not created"} · <strong>Notification:</strong> {briefDelivery.notificationId ?? "none"}</div>
              <div><strong>Recipient:</strong> {briefDelivery.recipient ?? "not configured"} · <strong>Sender:</strong> {briefDelivery.sender ?? "not configured"}</div>
              <div><strong>Subject:</strong> {briefDelivery.subject ?? "not generated"}</div>
              <div><strong>Gmail message:</strong> {briefDelivery.messageId ?? "none"} · <strong>Thread:</strong> {briefDelivery.threadId ?? "none"} · <strong>RFC Message-ID:</strong> {briefDelivery.rfcMessageId ?? "none"}</div>
              <div><strong>Last attempt:</strong> {briefDelivery.startedAt ? formatDateTime(briefDelivery.startedAt) : "none"} · <strong>Attempts:</strong> {briefDelivery.attempts} · <strong>Resends:</strong> {briefDelivery.resendCount}</div>
              <div><strong>Next retry:</strong> {briefDelivery.nextRetryAt ? formatDateTime(briefDelivery.nextRetryAt) : "none"} · <strong>Last error:</strong> {briefDelivery.lastError ?? "none"}</div>
              <div><strong>Sent-folder check:</strong> {briefDelivery.sentObservedAt ? `${formatDateTime(briefDelivery.sentObservedAt)} — ${briefDelivery.sentVerification ?? "observed"}` : briefDelivery.sentVerification ?? "not observed"}</div>
              <div><strong>Delivery evidence:</strong> {briefDelivery.deliveryEvidence ?? "none"}</div>
              <div><strong>Bounce evidence:</strong> {briefDelivery.bounceInfo ?? "none"}</div>
              <div><strong>Gmail API response:</strong> {briefDelivery.appResponse ?? "none"}</div>
              <div className="flex flex-wrap gap-2 mt-3">
                <form action={sendExecutiveBriefNowAction}>
                  <input type="hidden" name="mode" value="send" />
                  <SubmitButton className="btn btn-primary" pendingLabel="Sending now…">Send now</SubmitButton>
                </form>
                {briefDelivery.canResend ? (
                  <form action={sendExecutiveBriefNowAction}>
                    <input type="hidden" name="mode" value="resend" />
                    <SubmitButton className="btn" confirm="Resend only because the previous attempt definitively failed, was blocked, or bounced?" pendingLabel="Resending…">Resend last report</SubmitButton>
                  </form>
                ) : null}
                {briefDelivery.messageId && briefDelivery.state !== "delivery_confirmed" && briefDelivery.state !== "bounced" ? (
                  <form action={refreshExecutiveBriefDeliveryAction}>
                    <SubmitButton className="btn" pendingLabel="Checking Sent…">Check Gmail Sent folder</SubmitButton>
                  </form>
                ) : null}
              </div>
              <div className="mt-2" style={{ color: "var(--muted)" }}>Send Now generates the current report and processes only its outbox row immediately. It does not wait for 17:00. Duplicate prevention stays active; Resend is offered only after a definitive failure, block or bounce.</div>
            </div>
            <div className="card-quiet p-3 mb-3 text-[11.5px] leading-relaxed">
              <strong>Daily executive brief:</strong> {briefSchedule.enabled ? "enabled" : "disabled"} · {briefSchedule.time} {briefSchedule.timezone} · next {briefSchedule.next_run_at ? formatDateTime(briefSchedule.next_run_at) : "not scheduled"} · last status {briefSchedule.last_status ?? "not run"}.
              {briefSchedule.last_error ? <div className="mt-1"><strong>Last brief error:</strong> {briefSchedule.last_error}</div> : null}
              <div className="mt-1">The Coordinator is the only sender of the consolidated owner report. Routine successful applications stay in-app; blocked exceptions remain visible in the brief.</div>
            </div>
            <div className="card-quiet p-3 mb-3 text-[11.5px] leading-relaxed">
              <strong>Delivery outbox:</strong> {outbox.counts.pending} pending · {outbox.counts.retry_scheduled} retry scheduled · {outbox.counts.sending} sending · {outbox.counts.sent} accepted by Gmail · {outbox.counts.failed} failed.
              {outbox.lastError?.last_error ? <div className="mt-1"><strong>Last delivery error:</strong> {outbox.lastError.last_error}</div> : null}
              {outbox.lastAccepted ? <div className="mt-1"><strong>Last accepted:</strong> {outbox.lastAccepted.kind ?? "email"} · message {outbox.lastAccepted.provider_message_id ?? "none"} · {outbox.lastAccepted.finished_at ? formatDateTime(outbox.lastAccepted.finished_at) : "unknown"}</div> : null}
            </div>
            {briefHistory.length > 0 ? (
              <div className="mb-3">
                <div className="label">Recent executive briefs</div>
                <div className="feed">
                  {briefHistory.map((brief) => (
                    <div key={brief.id} className="feed-item">
                      <span className="feed-dot">·</span>
                      <div>
                        <div className="feed-text">{brief.subject}</div>
                        <div className="feed-time">
                          {brief.created_at ? formatDateTime(brief.created_at) : "unknown"} · delivery {brief.delivery_state}
                          {brief.attempts !== null ? ` · attempts ${brief.attempts}` : ""}
                          {brief.provider_message_id ? ` · message ${brief.provider_message_id}` : ""}
                          {brief.sent_observed_at ? ` · Sent observed ${formatDateTime(brief.sent_observed_at)}` : ""}
                          {brief.last_error ? ` · ${brief.last_error}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {notifications.length === 0 ? (
              <div className="empty">No notifications yet.</div>
            ) : (
              <div className="feed">
                {notifications.map((n) => (
                  <div key={n.id} className="feed-item">
                    <span className="feed-dot">·</span>
                    <div>
                      <div className="feed-text">{n.subject}</div>
                      <div className="feed-time">{n.kind} · {n.channel} · {n.status} · delivery {n.delivery_status ?? "not-requested"}{n.provider_message_id ? ` · ${n.provider_message_id}` : ""} · {formatDateTime(n.created_at)}</div>
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
