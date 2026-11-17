import { requireAdmin } from "@/lib/auth";
import { all } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { saveEmailConfigAction } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/SubmitButton";
import { accountStatus } from "@/lib/gmail";
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
  const notifications = all<{ id: number; kind: string; subject: string; channel: string; status: string; created_at: string }>(
    "SELECT id, kind, subject, channel, status, created_at FROM notifications ORDER BY id DESC LIMIT 15",
  );
  const gmail = accountStatus();

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />
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
                Marking this connected does not send anything by itself. Delivery requires the OAuth credentials below and a mail-sending implementation for this
                deployment. Until then, notifications are recorded in-app only and no email is claimed as sent.
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
            {notifications.length === 0 ? (
              <div className="empty">No notifications yet.</div>
            ) : (
              <div className="feed">
                {notifications.map((n) => (
                  <div key={n.id} className="feed-item">
                    <span className="feed-dot">·</span>
                    <div>
                      <div className="feed-text">{n.subject}</div>
                      <div className="feed-time">{n.kind} · {n.channel} · {n.status} · {formatDateTime(n.created_at)}</div>
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
