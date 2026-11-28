import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Empty, Flash } from "@/components/ui";
import { formatDate, formatDateTime, param } from "@/lib/format";
import {
  statusLabel,
  statusClass,
  APPLICATION_STATUSES,
  statusRequiresVerifiedSubmission,
  submissionConfirmationSource,
  submissionConfirmationSourceLabel,
  submissionEvidenceLabel,
  submissionEvidenceState,
} from "@/lib/application-status";
import { answerInterventionAction, requestDocumentChangesAction, updateApplicationStatusAction, saveApplicationNotesAction } from "@/lib/actions/applications";
import { handoffForApplication } from "@/lib/handoff";
import { SubmissionForm } from "@/components/SubmissionForm";
import { SubmitButton } from "@/components/SubmitButton";
import { getSetting } from "@/lib/settings";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";
import { agentIdentity } from "@/lib/agent-identity";
import { GermanRequirementCard } from "@/components/GermanRequirementCard";
import { outreachForApplication } from "@/lib/outreach";

export const dynamic = "force-dynamic";

export default async function ApplicationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const app = one<{
    id: string;
    job_id: string;
    status: string;
    cv_document_id: string | null;
    cover_letter_id: string | null;
    method: string | null;
    confirmation: string | null;
    approved_at: string | null;
    submitted_at: string | null;
    submission_evidence: string | null;
    submission_state: string | null;
    email_handoff_sent_at: string | null;
    email_handoff_note: string | null;
    application_email: string | null;
    notes: string | null;
    last_update: string;
    created_at: string;
    readiness: string | null;
    readiness_checked_at: string | null;
    title: string;
    company: string;
    location: string | null;
    url: string | null;
    match_score: number | null;
    match_flag: string | null;
    salary: string | null;
    employment_type: string | null;
    description: string | null;
    eligibility: string | null;
    german_requirement: string | null;
    language_evidence: string | null;
  }>(
    `     SELECT a.*, j.title, j.company, j.location, j.url, j.match_score, j.match_flag, j.salary, j.employment_type, j.description,
            j.eligibility, j.german_requirement, j.language_evidence, j.application_email
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [id],
  );
  if (!app) notFound();

  type ReadinessView = { state?: string; ready?: boolean; reasons?: string[]; items?: Array<{ label: string; passed: boolean; detail: string }> };
  let readiness: ReadinessView | null = null;
  try {
    readiness = app.readiness ? (JSON.parse(app.readiness) as ReadinessView) : null;
  } catch {
    readiness = null;
  }
  const readinessLabel = readiness?.state ? readiness.state.replace(/_/g, " ") : readiness?.ready ? "ready for submission" : "not assessed";
  const evidenceState = submissionEvidenceState(app);
  const confirmationSource = submissionConfirmationSource({ evidence: app.submission_evidence });
  const confirmationLabel = submissionEvidenceLabel({
    submitted_at: app.submitted_at,
    confirmation: app.confirmation,
    evidence: app.submission_evidence,
  });

  const cv = app.cv_document_id ? one<{ id: string; display_name: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null; kind: string }>("SELECT id, display_name, ats_score, quality_status, quality_score, version, kind FROM documents WHERE id = ?", [app.cv_document_id]) : null;
  const cover = app.cover_letter_id ? one<{ id: string; display_name: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null; kind: string }>("SELECT id, display_name, ats_score, quality_status, quality_score, version, kind FROM documents WHERE id = ?", [app.cover_letter_id]) : null;
  const siblings = all<{ id: string; display_name: string; mime: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null }>(
    "SELECT id, display_name, mime, ats_score, quality_status, quality_score, version FROM documents WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [app.job_id],
  );
  const outreachDrafts = outreachForApplication(id);
  const auditTimeline = all<{ action: string; detail: string | null; created_at: string }>(
    "SELECT action, detail, created_at FROM audit_logs WHERE entity = 'application' AND entity_id = ? ORDER BY id DESC LIMIT 20",
    [id],
  );
  // The application timeline lives in `application_events`; audit records add
  // operational context. Merge both so the owner-sent receipt appears on the
  // same timeline as preparation and submission history.
  const applicationTimeline = all<{ action: string; detail: string | null; created_at: string }>(
    "SELECT type AS action, message AS detail, created_at FROM application_events WHERE application_id = ? ORDER BY id DESC LIMIT 20",
    [id],
  );
  const timeline = [...applicationTimeline, ...auditTimeline]
    // The dedicated receipt entry below already renders this event with its note.
    .filter((event) => event.action !== "submission.owner_sent")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 20);
  const interventions = all<{ id: string; field: string | null; question: string; reason: string; kind: string }>(
    "SELECT id, field, question, reason, kind FROM application_interventions WHERE application_id = ? AND status = 'open' ORDER BY created_at",
    [id],
  );
  const handoff = handoffForApplication(user.id, id);
  const reviewDocs = siblings
    .filter((doc) => doc.id === app.cv_document_id || doc.id === app.cover_letter_id)
    .sort((a, b) => (a.id === app.cv_document_id ? -1 : b.id === app.cv_document_id ? 1 : 0))
    .map((doc) => ({
      id: doc.id,
      label: doc.id === app.cv_document_id ? "Tailored CV" : "Cover letter",
      mime: doc.mime,
      // ATS compatibility is a CV measurement. A cover letter is assessed by
      // its own quality gate and must not borrow the CV score.
      ats: doc.id === app.cv_document_id ? doc.ats_score : null,
      version: doc.version,
      quality: doc.quality_status,
      qualityScore: doc.quality_score,
    }));

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <div className="mb-4">
        <Link href="/applications" className="text-[12px]" style={{ color: "var(--muted)" }}>← Back to applications</Link>
      </div>
      <PageHead
        title={`${app.title} — ${app.company}`}
        sub={`${app.location ?? "Location not stated"}${app.employment_type ? ` · ${app.employment_type}` : ""}${app.salary ? ` · ${app.salary}` : ""}`}
        actions={
          <>
            <span className={`badge ${statusClass(app.status)}`}>{statusLabel(app.status)}</span>
            <Link href={`/jobs/${app.job_id}`} className="btn">View vacancy</Link>
            {app.url ? <a href={app.url} target="_blank" rel="noreferrer" className="btn">Original posting</a> : null}
          </>
        }
      />

      <section className="card mb-4" id="review-workspace">
        <div className="card-head">
          <div>
            <h2>Document review workspace</h2>
            <p className="card-sub">
              {app.title} at {app.company} · suitability {app.match_score ?? "—"}% · CV ATS compatibility {cv?.ats_score ?? "—"}/100 · CV quality {cv?.quality_status ?? "not checked"}{cv?.quality_score !== null && cv?.quality_score !== undefined ? ` (${cv.quality_score}/100)` : ""} · cover quality {cover?.quality_status ?? "not checked"}{cover?.quality_score !== null && cover?.quality_score !== undefined ? ` (${cover.quality_score}/100)` : ""}. These are separate measurements, not interchangeable scores.
            </p>
            <p className="hint" style={{ marginTop: 6 }}>
              Readiness: <strong>{readinessLabel}</strong>
              {app.readiness_checked_at ? ` · checked ${formatDateTime(app.readiness_checked_at)}` : ""}
              {readiness?.reasons?.length ? ` — ${readiness.reasons.slice(0, 3).join(" ")}` : ""}
            </p>
          </div>
          <div className="row">
            <span className={`badge ${statusClass(app.status)}`}>{statusLabel(app.status)}</span>
            <Link href={`/jobs/${app.job_id}`} className="btn btn-sm">Vacancy evidence</Link>
          </div>
        </div>
        <DocumentWorkspace documents={reviewDocs} />
      </section>

      <div className="split">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div className="flex items-center gap-3">
                <AgentAvatar agentKey="application" status={app.submitted_at ? "completed" : "idle"} size={38} />
                <div>
                  <h2>Submission</h2>
                  <p className="card-sub">
                    {agentIdentity("application").name} — {agentIdentity("application").title} ·{" "}
                    {evidenceState === "verified"
                      ? `${confirmationSource === "owner_recorded" ? "employer-confirmed — recorded by owner" : confirmationSource === "automated_employer" ? "employer-confirmed — automated portal response" : "employer-confirmed"}${app.submitted_at ? ` ${formatDateTime(app.submitted_at)}` : ""}${app.method ? ` via ${app.method.replace(/_/g, " ")}` : ""}`
                      : evidenceState === "partial"
                        ? "a submission was attempted, but no employer confirmation is verified"
                        : "no verified submission evidence is stored for this application"}
                  </p>
                  {evidenceState !== "verified" && statusRequiresVerifiedSubmission(app.status) ? (
                    <div className="alert alert-warn mt-2" style={{ padding: "7px 10px", fontSize: 12 }}>
                      This record is marked {statusLabel(app.status)}, but no employer confirmation is stored. It is not counted as applied and is
                      listed under Needs attention until a confirmation reference is recorded or the status is corrected.
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="card-body">
              {evidenceState === "verified" ? (
                <div className="card-quiet p-3">
                  <div className="label" style={{ marginBottom: 2 }}>Employer confirmation</div>
                  <div className="text-[13px]">{app.confirmation ?? "No reference stored"}</div>
                  <p className="hint">
                    {confirmationSource === "owner_recorded"
                      ? "You recorded this employer confirmation from the employer's message or portal. It is not an automated portal verification, and the stored evidence keeps that distinction."
                      : confirmationSource === "automated_employer"
                        ? "The employer endpoint or portal returned this reference, and it is stored with the application record."
                        : "Submission is verified by this reference and stored with the application record. The confirmation channel was not recorded."}
                  </p>
                </div>
              ) : (
                <div className="stack" style={{ gap: 14 }}>
                  {interventions.length > 0 ? (
                    <div className="card-quiet p-3" id="questions">
                      <div className="label" style={{ marginBottom: 6 }}>The form needs your answer</div>
                      <p className="hint" style={{ marginTop: 0 }}>
                        The team stopped before sending because these answers are not in your verified profile. Answers are stored for this application only;
                        they are never invented from model output.
                      </p>
                      {interventions.map((item) => (
                        <form key={item.id} action={answerInterventionAction} className="stack mt-3" style={{ gap: 6 }}>
                          <input type="hidden" name="intervention_id" value={item.id} />
                          <div className="text-[12.5px] font-medium">{item.question}</div>
                          <div className="text-[11px]" style={{ color: "var(--muted)" }}>{item.reason}</div>
                          <input name="answer" className="input" maxLength={1000} placeholder="Your verified answer" required />
                          <div><SubmitButton className="btn btn-sm btn-primary" pendingLabel="Saving…">Save answer</SubmitButton></div>
                        </form>
                      ))}
                    </div>
                  ) : null}
                  {app.status === "quality_review_required" ? (
                    <div className="alert alert-warn" style={{ padding: "8px 10px", fontSize: 12 }}>
                      Quality review is required before this package can be sent. Regenerate the documents after correcting the findings above.
                    </div>
                  ) : app.status === "submission_unverified" || app.status === "submission_unknown" ? (
                    <div className="alert alert-warn" style={{ padding: "8px 10px", fontSize: 12 }}>
                      A submission was attempted, but the employer&apos;s confirmation has not been verified. This record is not counted as applied and is
                      listed under Needs attention. Record the confirmation reference below only if the employer actually confirmed the application.
                    </div>
                  ) : app.status === "human_intervention_required" ? (
                    <div className="alert alert-warn" style={{ padding: "8px 10px", fontSize: 12 }}>
                      Automatic submission stopped at a legitimate human step. The handoff package below contains the employer link, documents, prepared answers and remaining steps. There is no approval flag to clear.
                    </div>
                  ) : app.status === "ready_to_submit" ? (
                    <div className="alert alert-ok">Ready for automatic submission. No per-application approval is required; the next eligible run will send it, or you can complete the employer form yourself.</div>
                  ) : (
                    <div className="alert alert-info" style={{ padding: "8px 10px", fontSize: 12 }}>
                      This package is prepared for automatic submission. It does not wait for your approval; it waits for the independent readiness check and a supported employer channel.
                    </div>
                  )}

                  {handoff ? (
                    <div className="card-quiet p-3 stack" id="handoff" style={{ gap: 8 }}>
                      <div className="label" style={{ marginBottom: 0 }}>Human intervention package</div>
                      <div className="text-[12px]">{handoff.stopExplanation}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {handoff.applicationUrl ? <a href={handoff.applicationUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">Employer application page</a> : <span className="badge badge-warn">No application URL recorded</span>}
                        {handoff.postingUrl && handoff.postingUrl !== handoff.applicationUrl ? <a href={handoff.postingUrl} target="_blank" rel="noreferrer" className="btn btn-sm">Original posting</a> : null}
                        {handoff.cv ? <Link href={handoff.cv.previewHref} className="btn btn-sm">CV · {handoff.cv.name}</Link> : null}
                        {handoff.coverLetter ? <Link href={handoff.coverLetter.previewHref} className="btn btn-sm">Cover letter · {handoff.coverLetter.name}</Link> : null}
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        Blocker: {handoff.blocker.kind.replace(/_/g, " ")} · Disovered {handoff.discoveredAt ? formatDate(handoff.discoveredAt) : "unknown"} · Prepared {handoff.preparedAt ? formatDate(handoff.preparedAt) : "not yet"} · Match {handoff.matchScore ?? "—"}%.
                      </div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>{handoff.matchExplanation}</div>
                      {handoff.preparedAnswers.length > 0 ? (
                        <div className="stack" style={{ gap: 4 }}>
                          <div className="text-[11px] font-medium">Prepared answers</div>
                          {handoff.preparedAnswers.map((answer) => (
                            <div key={`${answer.question}-${answer.answeredAt}`} className="text-[11px]" style={{ color: "var(--muted)" }}>
                              {answer.question}: {answer.answer}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <ol className="text-[11.5px] pl-4" style={{ color: "var(--muted)", listStyle: "decimal" }}>
                        {handoff.remainingSteps.map((step) => <li key={step}>{step}</li>)}
                      </ol>
                    </div>
                  ) : null}
                  <div className="decision-row">
                    <form action={updateApplicationStatusAction}>
                      <input type="hidden" name="id" value={app.id} />
                      <input type="hidden" name="status" value="rejected" />
                      <SubmitButton className="btn btn-sm btn-danger" confirm="Mark this application as rejected? Nothing is sent to the employer.">Reject application</SubmitButton>
                    </form>
                    <details className="decision-changes">
                      <summary className="btn btn-sm">Request document changes</summary>
                      <form action={requestDocumentChangesAction} className="stack mt-2" style={{ gap: 6 }}>
                        <input type="hidden" name="id" value={app.id} />
                        <input name="request" className="input" maxLength={500} placeholder="What should change? e.g. emphasise test automation leadership" />
                        <SubmitButton className="btn btn-sm" confirm="Send this package back for document changes? Approval will be cleared until you approve the new version.">Record change request</SubmitButton>
                      </form>
                    </details>
                  </div>

                  <div className="card-quiet p-3">
                    <div className="label" style={{ marginBottom: 6 }}>Record a confirmed submission</div>
                    <SubmissionForm applicationId={app.id} approved />
                  </div>
                  <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    Automated portal submission is not configured in this deployment. Employer portals commonly require logins, CAPTCHAs or MFA; this platform
                    never bypasses those controls, so submissions are confirmed manually and then recorded here.
                  </p>
                </div>
              )}
            </div>
          </section>

          <section className="card" id="outreach">
            <div className="card-head">
              <div>
                <h2>Hiring-manager outreach</h2>
                <p className="card-sub">Separate from the application channel. A Gmail draft is never shown as a sent email.</p>
              </div>
              <span className="badge badge-neutral">{outreachDrafts.length} draft{outreachDrafts.length === 1 ? "" : "s"}</span>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {outreachDrafts.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>
                  No Gmail outreach draft is stored. No contact or draft is claimed unless persisted evidence exists.
                </p>
              ) : (
                outreachDrafts.map((draft) => (
                  <div key={draft.id} className="card-quiet p-3 stack" style={{ gap: 4 }}>
                    <div className="between">
                      <div className="text-[12.5px] font-medium">{draft.contactName}{draft.contactTitle ? ` · ${draft.contactTitle}` : ""}</div>
                      <span className={`badge ${draft.status === "sent" ? "badge-good" : draft.status === "failed" ? "badge-warn" : "badge-neutral"}`}>
                        {draft.status === "draft_created" ? "Gmail draft created — not sent" : draft.status === "sent" ? "Email sent by owner" : draft.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{draft.recipient} · {draft.subject}</div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      CV hash {draft.cvSha256.slice(0, 12)}… · cover hash {draft.coverSha256.slice(0, 12)}… · created {formatDateTime(draft.createdAt)}
                      {draft.gmailDraftId ? ` · Gmail draft ${draft.gmailDraftId}` : ""}
                      {draft.sentAt ? ` · sent ${formatDateTime(draft.sentAt)}` : " · no send recorded"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Documents used</h2>
                <p className="card-sub">The exact versions attached to this application.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {[cv, cover].filter(Boolean).length === 0 ? (
                <Empty title="No documents linked">
                  Generate a package from the vacancy page to create tailored documents.
                </Empty>
              ) : (
                [cv, cover].filter(Boolean).map((doc) => (
                  <div key={doc!.id} className="between card-quiet p-3">
                    <div>
                      <div className="text-[12.5px] font-medium">{app.company} — {app.title} · {doc!.kind === "tailored_cv" ? "Tailored CV" : "Cover letter"} · v{doc!.version}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {doc!.kind === "tailored_cv" ? `CV ATS compatibility ${doc!.ats_score ?? "—"}/100` : "Cover-letter ATS score not applicable"} · quality {doc!.quality_status ?? "not checked"}{doc!.quality_score !== null ? ` (${doc!.quality_score}/100)` : ""}
                      </div>
                    </div>
                    <a href={`/api/documents/${doc!.id}`} className="btn btn-sm">Download</a>
                  </div>
                ))
              )}
              {siblings.length > 2 ? (
                <details className="mt-1">
                  <summary className="text-[11.5px]" style={{ color: "var(--muted)", cursor: "pointer" }}>All {siblings.length} version-labelled files for this vacancy</summary>
                  <div className="stack mt-2" style={{ gap: 6 }}>
                    {siblings.map((doc) => (
                      <div key={doc.id} className="between card-quiet px-3 py-2">
                        <span className="text-[11.5px]">{doc.version ? `v${doc.version} · ` : ""}{doc.display_name}{doc.quality_status ? ` · ${doc.quality_status}` : ""}</span>
                        <a href={`/api/documents/${doc.id}`} className="btn btn-sm">Download</a>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Notes</h2>
                <p className="card-sub">Internal only — never included in documents.</p>
              </div>
            </div>
            <div className="card-body">
              <form action={saveApplicationNotesAction} className="stack" style={{ gap: 8 }}>
                <input type="hidden" name="id" value={app.id} />
                <textarea name="notes" className="textarea" rows={4} defaultValue={app.notes ?? ""} placeholder="Recruiter contact, interview notes, follow-up dates…" />
                <SubmitButton className="btn">Save notes</SubmitButton>
              </form>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>History</h2>
                <p className="card-sub">Application and audit timeline for this application.</p>
              </div>
            </div>
            <div className="card-body">
              {timeline.length === 0 && !app.email_handoff_sent_at ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No events recorded yet.</p>
              ) : (
                <div className="feed">
                  {app.email_handoff_sent_at ? (
                    <div className="feed-item">
                      <span className="feed-dot" style={{ color: "var(--accent)" }}>✉</span>
                      <div>
                        <div className="feed-text">
                          <strong>Email application sent by you</strong>
                          {app.application_email ? ` to ${app.application_email}` : ""}.
                          {app.email_handoff_note ? ` ${app.email_handoff_note}` : ""}
                        </div>
                        <div className="feed-time">
                          Owner attestation · {formatDateTime(app.email_handoff_sent_at)} · not employer confirmation
                        </div>
                      </div>
                    </div>
                  ) : null}
                  {timeline.map((event, i) => (
                    <div key={i} className="feed-item">
                      <span className="feed-dot">·</span>
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

        <div className="stack">
          <section className="card" id="vacancy">
            <div className="card-head">
              <div>
                <h2>Vacancy &amp; assessment</h2>
                <p className="card-sub">{app.company} · {app.title}</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              <div className="between text-[12.5px]"><span style={{ color: "var(--muted)" }}>Match score</span><span>{app.match_score ?? "—"}% · {app.match_flag ?? "not analysed"}</span></div>
              <div className="between text-[12.5px]"><span style={{ color: "var(--muted)" }}>Location</span><span>{app.location ?? "Not stated"}</span></div>
              <div className="between text-[12.5px]"><span style={{ color: "var(--muted)" }}>Employment</span><span>{app.employment_type ?? "Not stated"}</span></div>
              <div className="between text-[12.5px]"><span style={{ color: "var(--muted)" }}>Salary</span><span>{app.salary ?? "Not stated"}</span></div>
              <div className="row">
                {app.url ? <a href={app.url} target="_blank" rel="noreferrer" className="btn btn-sm">Original source URL</a> : <span className="badge badge-neutral">No source URL recorded</span>}
                <Link href={`/jobs/${app.job_id}`} className="btn btn-sm">Eligibility &amp; match evidence</Link>
              </div>
              <details className="mt-1">
                <summary className="text-[11.5px]" style={{ color: "var(--muted)", cursor: "pointer" }}>Original job description</summary>
                <p className="text-[11.5px] mt-2" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto", color: "var(--ink-soft)" }}>
                  {app.description ?? "No description was stored for this vacancy."}
                </p>
              </details>
            </div>
          </section>

          <GermanRequirementCard
            status={app.german_requirement}
            evidence={app.language_evidence}
            eligibility={app.eligibility}
          />

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Update status</h2>
                <p className="card-sub">Record employer responses as they arrive.</p>
              </div>
            </div>
            <div className="card-body">
              <form action={updateApplicationStatusAction} className="stack" style={{ gap: 8 }}>
                <input type="hidden" name="id" value={app.id} />
                <select name="status" className="select" defaultValue={app.status}>
                  {APPLICATION_STATUSES.filter((s) => s !== "submitted").map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </select>
                <SubmitButton className="btn">Save status</SubmitButton>
              </form>
              <p className="hint">
                Applied and post-submission statuses (Acknowledged, Interview, Offer) require a stored employer confirmation. Without one the server
                rejects the change and keeps the current status; use the confirmation form above to record real evidence.
              </p>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div><h2>Record summary</h2></div>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              <div className="between"><span style={{ color: "var(--muted)" }}>Application ID</span><span className="num">{app.id}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Created</span><span>{formatDate(app.created_at)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Last update</span><span>{formatDateTime(app.last_update)}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Match score</span><span>{app.match_score ?? "—"}%</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Submission</span><span>{confirmationLabel}</span></div>
              {evidenceState === "verified" ? (
                <div className="between"><span style={{ color: "var(--muted)" }}>Verification source</span><span>{submissionConfirmationSourceLabel({ evidence: app.submission_evidence })}</span></div>
              ) : null}
              {evidenceState === "verified" ? (
                <div className="between"><span style={{ color: "var(--muted)" }}>Confirmation</span><span className="num">{app.confirmation}</span></div>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
