import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { PageHead, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { statusLabel } from "@/lib/application-status";
import { outreachDraftDetail, type OutreachAttachmentState } from "@/lib/outreach";
import { reconcileOutreachAction } from "@/lib/actions/outreach";
import { CopyButton } from "@/components/CopyButton";
import { SubmitButton } from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

function attachmentBadge(state: OutreachAttachmentState): { className: string; label: string } {
  if (state === "attached") return { className: "badge badge-good", label: "Attached · validated" };
  if (state === "quality_failed") return { className: "badge badge-bad", label: "Quality gate not passed" };
  if (state === "wrong_vacancy") return { className: "badge badge-bad", label: "Belongs to another vacancy" };
  return { className: "badge badge-warn", label: "Missing from storage" };
}

function draftStateLabel(status: string): { className: string; label: string } {
  if (status === "sent") return { className: "badge badge-good", label: "Sent by owner" };
  if (status === "draft_created") return { className: "badge badge-info", label: "Gmail draft created — not sent" };
  if (status === "draft_missing") return { className: "badge badge-warn", label: "Draft missing from Gmail" };
  if (status === "failed") return { className: "badge badge-bad", label: "Draft creation failed" };
  if (status === "blocked") return { className: "badge badge-warn", label: "Blocked" };
  return { className: "badge badge-neutral", label: "Pending" };
}

export default async function OutreachDraftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const detail = outreachDraftDetail(id);
  if (!detail) notFound();
  const { draft, body, evidence, events, quality } = detail;
  const state = draftStateLabel(draft.status);
  const cvState = attachmentBadge(draft.cv.state);
  const coverState = attachmentBadge(draft.cover.state);

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <div className="mb-4">
        <Link href="/outreach" className="text-[12px]" style={{ color: "var(--muted)" }}>
          ← Back to outreach inbox
        </Link>
      </div>
      <PageHead
        title={`${draft.jobTitle} — ${draft.company}`}
        sub={`Prepared for ${draft.contactName}${draft.contactTitle ? ` · ${draft.contactTitle}` : ""} · ${draft.recipient}`}
        actions={
          <>
            <span className={state.className}>{state.label}</span>
            <Link href={`/applications/${draft.applicationId}`} className="btn btn-sm">
              Open application
            </Link>
            {draft.gmailDraftId ? (
              <a
                href={`https://mail.google.com/mail/u/0/#drafts/${encodeURIComponent(draft.gmailDraftId)}`}
                target="_blank"
                rel="noreferrer"
                className="btn btn-sm"
              >
                Open Gmail draft
              </a>
            ) : null}
          </>
        }
      />

      <div className="alert alert-info mb-4">
        A Gmail draft is not a sent email. This record stays a draft until the owner sends it from Gmail and a sent copy is observed in the mailbox.
      </div>

      {quality ? (
        <section className="card mb-4" data-testid="outreach-quality">
          <div className="card-head">
            <div>
              <h2>Email quality check</h2>
              <p className="card-sub">
                Deterministic checks against the stored body, the verified profile and this vacancy. A failed check prevents the message from being
                presented as ready to review.
              </p>
            </div>
            <span className={`badge ${quality.ok ? "badge-good" : "badge-bad"}`}>
              {quality.ok ? `Passed ${quality.checks.length}/${quality.checks.length} · ${quality.score}/100` : `Failed · ${quality.score}/100`}
            </span>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            <p className="text-[12.5px]" style={{ margin: 0 }} data-testid="outreach-quality-summary">
              {quality.summary} The stored message is {quality.wordCount} words.
            </p>
            <ul className="text-[12px] stack" style={{ gap: 4, margin: 0, paddingLeft: 18, listStyle: "disc", color: "var(--muted)" }}>
              {quality.checks.map((check) => (
                <li key={check.id}>
                  <span className={`badge ${check.ok ? "badge-good" : "badge-bad"}`}>{check.ok ? "Pass" : "Fail"}</span>{" "}
                  <strong>{check.label}</strong> — {check.detail}
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Email content</h2>
                <p className="card-sub">Subject and body exactly as stored for this draft.</p>
              </div>
              <CopyButton text={`Subject: ${draft.subject}\n\n${body}`} />
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              <div>
                <div className="label">Subject</div>
                <div className="text-[13px]">{draft.subject}</div>
              </div>
              <div>
                <div className="label">Body</div>
                <pre
                  className="text-[12.5px]"
                  style={{ whiteSpace: "pre-wrap", fontFamily: "inherit", color: "var(--ink-soft)", margin: 0 }}
                >
                  {body || "No body was stored for this draft."}
                </pre>
              </div>
            </div>
          </section>

          <section className="card" data-testid="outreach-edit-limitation">
            <div className="card-head">
              <div>
                <h2>Editing this draft</h2>
                <p className="card-sub">Honest limitation: there is no in-app editor for a prepared email.</p>
              </div>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <p style={{ margin: 0 }}>
                Editing is not implemented in this application, so no edit control is shown here. The stored subject and body above are the version that
                passed the quality check, and the Gmail draft remains the single copy that would be sent.
              </p>
              <ol className="stack" style={{ gap: 4, margin: 0, paddingLeft: 18, listStyle: "decimal", color: "var(--muted)" }}>
                <li>Open the draft in Gmail with the button above. Gmail updates that same draft in place and keeps both PDF attachments.</li>
                <li>Make the wording changes there and save. Do not create a second draft from this page.</li>
                <li>Return here and use “Reconcile status”. It only reads the mailbox: it never sends, never rewrites the draft and never duplicates it.</li>
              </ol>
              <p style={{ margin: 0, color: "var(--muted)" }}>
                A change made in Gmail is not re-validated against the quality checks shown here, and this stored copy keeps the text that was assessed.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Attachments</h2>
                <p className="card-sub">The exact vacancy documents recorded with this draft, with their stored SHA-256 hashes.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 10 }}>
              {[
                { role: "Tailored CV", data: draft.cv, badge: cvState },
                { role: "Cover letter", data: draft.cover, badge: coverState },
              ].map((item) => (
                <div key={item.role} className="card-quiet p-3 stack" style={{ gap: 4 }}>
                  <div className="between flex-wrap gap-2">
                    <div className="text-[12.5px] font-medium">
                      {item.role} · {item.data.filename ?? "no file recorded"}
                    </div>
                    <span className={item.badge.className}>{item.badge.label}</span>
                  </div>
                  <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                    Document {item.data.documentId} · quality {item.data.quality ?? "not checked"} · SHA-256{" "}
                    <span className="num">{item.data.hash.slice(0, 32)}…</span>
                  </div>
                  <div>
                    <a href={`/api/documents/${item.data.documentId}`} className="btn btn-sm">
                      View document
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Contact evidence</h2>
                <p className="card-sub">Where this address came from and how it was verified.</p>
              </div>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Name</span><span>{draft.contactName}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Professional title</span><span>{draft.contactTitle ?? "Not published"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Email</span><span className="num">{draft.recipient}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Verification</span><span>{draft.contactVerified ? "Verified · employer-associated" : "Not verified"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Discovery method</span><span>{draft.contactMethod.replace(/_/g, " ")}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Confidence</span><span>{draft.contactConfidence}/100</span></div>
              <div className="between">
                <span style={{ color: "var(--muted)" }}>Source</span>
                {draft.contactSourceUrl ? (
                  <a href={draft.contactSourceUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
                    {draft.contactSourceUrl}
                  </a>
                ) : (
                  <span>None recorded</span>
                )}
              </div>
              {evidence ? (
                <pre
                  className="text-[11px]"
                  style={{ whiteSpace: "pre-wrap", margin: 0, color: "var(--muted)" }}
                >
                  {JSON.stringify(evidence, null, 2)}
                </pre>
              ) : null}
            </div>
          </section>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div><h2>Draft record</h2></div>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Draft ID</span><span className="num">{draft.id}</span></div>
              <div className="between">
                <span style={{ color: "var(--muted)" }}>Gmail draft ID</span>
                <span className="row gap-2">
                  <span className="num">{draft.gmailDraftId ?? "none"}</span>
                  {draft.gmailDraftId ? <CopyButton text={draft.gmailDraftId} label="Copy draft ID" /> : null}
                </span>
              </div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Application</span><Link href={`/applications/${draft.applicationId}`} style={{ textDecoration: "underline" }}>{draft.applicationId}</Link></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Application status</span><span>{statusLabel(draft.applicationStatus)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Employer replies</span><span>{draft.replies > 0 ? `${draft.replies} matched message(s)` : "None received"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Job ID</span><Link href={`/jobs/${draft.jobId}`} style={{ textDecoration: "underline" }}>{draft.jobId}</Link></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Created</span><span>{formatDateTime(draft.createdAt)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Last reconciled</span><span>{draft.lastReconciledAt ? formatDateTime(draft.lastReconciledAt) : "never"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Sent</span><span>{draft.sentAt ? formatDateTime(draft.sentAt) : "not sent"}</span></div>
              {draft.error ? <div className="alert alert-error" style={{ padding: "7px 9px", fontSize: 11 }}>{draft.error}</div> : null}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Refresh from Gmail</h2>
                <p className="card-sub">Checks the actual mailbox. It never sends and never creates a second draft.</p>
              </div>
            </div>
            <div className="card-body">
              <form action={reconcileOutreachAction}>
                <input type="hidden" name="id" value={draft.id} />
                <input type="hidden" name="return_to" value={`/outreach/${draft.id}`} />
                <SubmitButton className="btn" pendingLabel="Checking Gmail…">Reconcile status</SubmitButton>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div><h2>Outreach history</h2></div>
            </div>
            <div className="card-body">
              {events.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No outreach events recorded yet.</p>
              ) : (
                <div className="feed">
                  {events.map((event) => (
                    <div key={event.id} className="feed-item">
                      <span className="feed-dot">·</span>
                      <div>
                        <div className="feed-text">{event.message}</div>
                        <div className="feed-time">{event.type} · {formatDateTime(event.createdAt)}</div>
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
