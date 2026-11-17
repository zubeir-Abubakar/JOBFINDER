import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHead, Empty, Flash } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { param, relativeTime } from "@/lib/format";
import { accountStatus, inboxMessages } from "@/lib/gmail";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  connectGmailAction,
  createGmailDraftAction,
  disconnectGmailAction,
  sendApprovedDraftAction,
  syncGmailAction,
} from "@/lib/actions/gmail";

export const dynamic = "force-dynamic";

const CATEGORY: Record<string, { label: string; badge: string }> = {
  interview_invitation: { label: "Interview invitation", badge: "badge-good" },
  rejection: { label: "Rejection", badge: "badge-bad" },
  recruiter_question: { label: "Recruiter question", badge: "badge-warn" },
  acknowledgement: { label: "Acknowledgement", badge: "badge-info" },
  unrelated: { label: "Unrelated", badge: "badge-neutral" },
  unclassified: { label: "Unclassified", badge: "badge-neutral" },
};

function draftTemplate(category: string, sender: string | null) {
  const name = (sender ?? "").replace(/<.*>/, "").trim();
  if (category === "interview_invitation") {
    return `Dear ${name || "Hiring Team"},\n\nThank you for the invitation. I am available for a conversation and can accommodate the proposed time. Please let me know any preparation details or documents you need.\n\nKind regards,\nAbubakar Towfiq`;
  }
  if (category === "recruiter_question") {
    return `Dear ${name || "Hiring Team"},\n\nThank you for your message. I am happy to provide the requested information and will send it shortly.\n\nKind regards,\nAbubakar Towfiq`;
  }
  return `Dear ${name || "Hiring Team"},\n\nThank you for your message.\n\nKind regards,\nAbubakar Towfiq`;
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const status = accountStatus();
  const messages = inboxMessages(30);

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Inbox & tracking"
        sub="Recruiter replies are read through Gmail OAuth, matched to applications and prepared as drafts. Nothing is sent without your approval."
        actions={
          <>
            {status.connected ? (
              <>
                {status.needsReconnect ? (
                  <form action={connectGmailAction}>
                    <SubmitButton className="btn btn-primary" pendingLabel="Opening Google…">Reconnect Gmail</SubmitButton>
                  </form>
                ) : (
                  <form action={syncGmailAction}>
                    <SubmitButton className="btn btn-primary" pendingLabel="Scanning…">Sync inbox</SubmitButton>
                  </form>
                )}
                <form action={disconnectGmailAction}>
                  <SubmitButton className="btn btn-danger" confirm="Disconnect Gmail? Existing message metadata and drafts stay in the local database.">Disconnect</SubmitButton>
                </form>
              </>
            ) : (
              <form action={connectGmailAction}>
                <SubmitButton className="btn btn-primary" pendingLabel="Opening Google…">Connect Gmail</SubmitButton>
              </form>
            )}
            <Link href="/applications" className="btn">Application tracker</Link>
          </>
        }
      />

      <section className="card mb-4">
        <div className="card-head">
          <div className="flex items-center gap-3">
            <AgentAvatar agentKey="email" status={status.connected && !status.needsReconnect ? "idle" : "unavailable"} size={38} />
            <div>
              <h2>Gmail connection</h2>
              <p className="card-sub">Email &amp; Tracking Agent · OAuth 2.0 · encrypted refresh token · read-only mail access plus draft creation; sending only after your explicit approval.</p>
            </div>
          </div>
          <span className={`badge ${status.connected && !status.needsReconnect ? "badge-good" : status.connected || !status.oauthReady ? "badge-warn" : "badge-info"}`}>
            {status.connected ? (status.needsReconnect ? "reconnect required" : "connected") : status.oauthReady ? "ready to connect" : "configuration missing"}
          </span>
        </div>
        <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
          <div className="between"><span style={{ color: "var(--muted)" }}>Mailbox</span><span>{status.email ?? "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Last sync</span><span>{status.lastSyncAt ? relativeTime(status.lastSyncAt) : "never"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Token storage</span><span>{status.connected ? (status.tokenEncrypted ? "AES-256-GCM encrypted" : "unencrypted — reconnect") : "—"}</span></div>
          <div className="between"><span style={{ color: "var(--muted)" }}>Redirect URI</span><span style={{ wordBreak: "break-all", textAlign: "right" }}>{status.redirectUri ?? "not configured"}</span></div>
          <div style={{ color: "var(--muted)" }}>
            Scopes: {status.scopes.map((s) => s.replace("https://www.googleapis.com/auth/gmail.", "")).join(", ")}. Sending is limited to the explicit approval button on a draft.
          </div>
          {status.missing.length > 0 ? (
            <div className="alert alert-error">
              <strong>Gmail cannot connect yet.</strong>
              <ul className="mt-1" style={{ paddingLeft: 16, listStyle: "disc" }}>
                {status.missing.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </div>
          ) : null}
          {status.connected && status.needsReconnect ? (
            <div className="alert alert-warn">
              <strong>Gmail needs to be reconnected.</strong> The saved token is missing:{" "}
              {status.missingScopes.map((scope) => scope.split("/").pop()).join(", ")}. Reconnect and approve every requested permission. Existing synced messages and drafts are kept.
            </div>
          ) : null}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Recruiter correspondence</h2>
            <p className="card-sub">{messages.length === 0 ? "No synced messages yet." : `${messages.length} recent message(s), newest first.`}</p>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 12 }}>
          {messages.length === 0 ? (
            <Empty title="No messages">Connect Gmail and run a sync. Interview invitations, rejections and recruiter questions are matched to your applications.</Empty>
          ) : (
            messages.map((message) => {
              const category = CATEGORY[message.category] ?? CATEGORY.unclassified;
              return (
                <article key={message.id} className="mail-card">
                  <div className="between" style={{ alignItems: "flex-start", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div className="cell-title">{message.subject}</div>
                      <div className="cell-sub">{message.sender ?? "unknown sender"} · {message.received_at ? relativeTime(message.received_at) : "unknown date"}</div>
                    </div>
                    <span className={`badge ${category.badge}`}>{category.label}</span>
                  </div>
                  <p className="text-[12px] leading-relaxed" style={{ color: "var(--muted)" }}>{message.snippet}</p>
                  {message.application_id ? (
                    <Link href={`/applications/${message.application_id}`} className="text-[11.5px]" style={{ color: "var(--accent)" }}>
                      Matched application →
                    </Link>
                  ) : null}
                  {message.draft_status === "sent" ? (
                    <div className="alert alert-ok" style={{ marginTop: 6 }}>Approved reply sent.</div>
                  ) : (
                    <details className="mt-1">
                      <summary className="btn btn-sm" style={{ listStyle: "none", cursor: "pointer" }}>
                        {message.draft_id ? "Review draft" : "Prepare reply draft"}
                      </summary>
                      <form action={createGmailDraftAction} className="stack mt-2" style={{ gap: 8 }}>
                        <input type="hidden" name="email_id" value={message.id} />
                        <textarea
                          name="body"
                          rows={7}
                          className="textarea"
                          defaultValue={message.draft_body ?? draftTemplate(message.category, message.sender)}
                          spellCheck
                        />
                        <div className="row">
                          <SubmitButton className="btn btn-primary" pendingLabel="Creating draft…">{message.draft_id ? "Replace Gmail draft" : "Create Gmail draft"}</SubmitButton>
                          <span className="text-[11px]" style={{ color: "var(--muted)" }}>Drafts are not sent.</span>
                        </div>
                      </form>
                      {message.draft_id ? (
                        <form action={sendApprovedDraftAction} className="mt-2">
                          <input type="hidden" name="email_id" value={message.id} />
                          <SubmitButton className="btn" confirm="Send this approved Gmail draft now? This is the only action that sends email." pendingLabel="Sending…">
                            Approve &amp; send
                          </SubmitButton>
                        </form>
                      ) : null}
                    </details>
                  )}
                </article>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
