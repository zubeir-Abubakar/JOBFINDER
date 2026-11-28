import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { PageHead, Stat, Flash } from "@/components/ui";
import { formatDateTime, param } from "@/lib/format";
import { statusClass, statusLabel } from "@/lib/application-status";
import { outreachDashboard, outreachQualityForDraft, type OutreachAttachmentState, type OutreachDraftRecord } from "@/lib/outreach";

export const dynamic = "force-dynamic";

/**
 * Owner outreach inbox.
 *
 * Every row is a persisted outreach draft. Drafted, sent and replied are three
 * different states, and a Gmail draft is never shown as a sent email.
 */

function attachmentBadge(state: OutreachAttachmentState): { className: string; label: string } {
  if (state === "attached") return { className: "badge badge-good", label: "Attached · validated" };
  if (state === "quality_failed") return { className: "badge badge-bad", label: "Quality gate failed" };
  if (state === "wrong_vacancy") return { className: "badge badge-bad", label: "Wrong vacancy" };
  return { className: "badge badge-warn", label: "Missing" };
}

function emailStateBadge(status: OutreachDraftRecord["status"]): { className: string; label: string } {
  if (status === "sent") return { className: "badge badge-good", label: "Sent by owner" };
  if (status === "draft_created") return { className: "badge badge-info", label: "Draft — not sent" };
  if (status === "draft_missing") return { className: "badge badge-warn", label: "Draft missing from Gmail" };
  if (status === "failed") return { className: "badge badge-bad", label: "Draft creation failed" };
  if (status === "blocked") return { className: "badge badge-warn", label: "Blocked" };
  return { className: "badge badge-neutral", label: "Pending" };
}

export default async function OutreachInboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const sp = await searchParams;
  const view = outreachDashboard();
  const counters = view.counters;
  const quality = new Map(view.drafts.map((draft) => [draft.id, outreachQualityForDraft(draft.id)] as const));
  const requested = param(sp.quality);
  const qualityFilter = requested === "failed" || requested === "passed" ? requested : "all";
  const rows = view.drafts.filter((draft) => {
    if (qualityFilter === "all") return true;
    const assessment = quality.get(draft.id) ?? null;
    if (!assessment) return false;
    return qualityFilter === "failed" ? !assessment.ok : assessment.ok;
  });

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Outreach inbox"
        sub="Every prepared hiring-manager email, the evidence behind its recipient, and whether it has actually been sent."
        actions={
          <>
            <Link href="/dashboard#outreach" className="btn btn-sm">
              Back to dashboard
            </Link>
            <Link href="/recruitment#outreach" className="btn btn-sm">
              Recruitment runs
            </Link>
          </>
        }
      />

      <section className="stats mb-4" aria-label="Outreach counters" data-testid="outreach-inbox-counters">
        <Stat label="Prepared email drafts" value={counters.draftsPrepared} tone={counters.draftsPrepared ? "info" : undefined} />
        <Stat label="Verified employer contacts" value={counters.verifiedContacts} tone={counters.verifiedContacts ? "good" : undefined} />
        <Stat label="Drafts awaiting review" value={counters.awaitingReview} tone={counters.awaitingReview ? "warn" : undefined} />
        <Stat label="Emails sent by you" value={counters.emailsSent} tone={counters.emailsSent ? "good" : undefined} />
        <Stat label="Employer replies received" value={counters.repliesReceived} />
        <Stat label="Drafts needing intervention" value={counters.needsIntervention} tone={counters.needsIntervention ? "bad" : undefined} />
      </section>

      <div className="alert alert-info mb-4">
        Drafted, sent and replied are separate states. <strong>A draft is not a sent email.</strong> Nothing is sent by this application: the
        owner sends from Gmail, and the record changes only when a sent copy is observed in the mailbox.
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Prepared messages</h2>
            <p className="card-sub">
              Sorted by draft creation time. Each row links to the full email, its attachments, the contact evidence and the outreach history.
            </p>
          </div>
          <span className={`badge ${counters.needsIntervention ? "badge-warn" : "badge-neutral"}`}>
            {counters.needsIntervention ? `${counters.needsIntervention} needing intervention` : "No intervention required"}
          </span>
        </div>
        <div className="card-body">
          <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="outreach-quality-filter">
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }}>
              Quality filter:
            </span>
            {([
              { key: "all", label: `All (${view.drafts.length})`, href: "/outreach" },
              {
                key: "failed",
                label: `Quality check failed (${view.drafts.filter((draft) => quality.get(draft.id)?.ok === false).length})`,
                href: "/outreach?quality=failed",
              },
              {
                key: "passed",
                label: `Quality passed (${view.drafts.filter((draft) => quality.get(draft.id)?.ok === true).length})`,
                href: "/outreach?quality=passed",
              },
            ] as const).map((option) => (
              <Link
                key={option.key}
                href={option.href}
                className={`btn btn-sm ${qualityFilter === option.key ? "btn-primary" : ""}`}
                aria-current={qualityFilter === option.key ? "page" : undefined}
                data-testid={`outreach-filter-${option.key}`}
              >
                {option.label}
              </Link>
            ))}
            <span className="text-[11.5px]" style={{ color: "var(--muted)" }} data-testid="outreach-filter-summary">
              Showing {rows.length} of {view.drafts.length} prepared message(s).
            </span>
          </div>

          {view.drafts.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--muted)" }} data-testid="outreach-inbox-empty">
              No outreach draft is stored yet. Zero is shown rather than a sample count. A draft exists only after a verified
              employer-associated address and a validated CV plus cover letter are available for a qualified vacancy.
            </p>
          ) : rows.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--muted)" }} data-testid="outreach-filter-empty">
              No prepared message matches this quality filter. The counters above still describe the whole ledger.{" "}
              <Link href="/outreach" style={{ textDecoration: "underline" }}>Show all prepared messages</Link>.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data responsive-cards" data-testid="outreach-inbox-table">
                <thead>
                  <tr>
                    <th>Employer</th>
                    <th>Role</th>
                    <th>Recipient</th>
                    <th>Email address</th>
                    <th>Subject</th>
                    <th>Created</th>
                    <th>CV</th>
                    <th>Cover letter</th>
                    <th>Gmail draft</th>
                    <th>Application</th>
                    <th>Email sent?</th>
                    <th>Reply?</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((draft) => {
                    const cv = attachmentBadge(draft.cv.state);
                    const cover = attachmentBadge(draft.cover.state);
                    const state = emailStateBadge(draft.status);
                    const assessment = quality.get(draft.id) ?? null;
                    return (
                      <tr key={draft.id} data-testid={`outreach-row-${draft.id}`}>
                        <td data-label="Employer">
                          <Link href={`/outreach/${draft.id}`} className="cell-title">{draft.company}</Link>
                          {draft.contactVerified ? <div className="cell-sub">Verified contact</div> : null}
                        </td>
                        <td data-label="Role" className="cell-sub">{draft.jobTitle}</td>
                        <td data-label="Recipient">
                          <div className="cell-title">{draft.contactName}</div>
                          <div className="cell-sub">{draft.contactTitle ?? "Title not published"}</div>
                        </td>
                        <td data-label="Email address" className="cell-sub num">{draft.recipient}</td>
                        <td data-label="Subject" className="cell-sub" style={{ maxWidth: 260 }}>{draft.subject}</td>
                        <td data-label="Created" className="cell-sub">{formatDateTime(draft.createdAt)}</td>
                        <td data-label="CV"><span className={cv.className}>{cv.label}</span></td>
                        <td data-label="Cover letter"><span className={cover.className}>{cover.label}</span></td>
                        <td data-label="Gmail draft">
                          <span className={state.className}>{state.label}</span>
                          {draft.gmailDraftId ? <div className="cell-sub num">{draft.gmailDraftId}</div> : null}
                          {assessment ? (
                            <div className="cell-sub">
                              <span className={`badge ${assessment.ok ? "badge-good" : "badge-bad"}`} title={assessment.summary}>
                                {assessment.ok ? `Quality passed · ${assessment.wordCount} words` : "Quality check failed"}
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td data-label="Application">
                          <span className={`badge ${statusClass(draft.applicationStatus)}`}>{statusLabel(draft.applicationStatus)}</span>
                        </td>
                        <td data-label="Email sent?">
                          <span className={`badge ${draft.sentAt ? "badge-good" : "badge-neutral"}`}>{draft.sentAt ? "Yes" : "No — draft only"}</span>
                        </td>
                        <td data-label="Reply?">
                          <span className={`badge ${draft.replies > 0 ? "badge-good" : "badge-neutral"}`}>
                            {draft.replies > 0 ? `${draft.replies} message(s)` : "None"}
                          </span>
                        </td>
                        <td data-label="Actions" className="text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <Link href={`/outreach/${draft.id}`} className="btn btn-sm btn-primary">
                              Open and review
                            </Link>
                            <Link href={`/applications/${draft.applicationId}`} className="btn btn-sm">
                              Application
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint" style={{ marginTop: 10 }}>
            Counts are read from <code>outreach_drafts</code>, <code>outreach_contacts</code> and matched <code>email_messages</code>. A draft with a
            failed quality check is not presented as ready to review.
          </p>
        </div>
      </section>
    </>
  );
}
