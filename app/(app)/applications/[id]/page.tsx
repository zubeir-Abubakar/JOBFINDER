import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Empty, Flash } from "@/components/ui";
import { formatDate, formatDateTime, param } from "@/lib/format";
import { statusLabel, statusClass, APPLICATION_STATUSES, isApplicationSubmitted } from "@/lib/application-status";
import { answerInterventionAction, approveApplicationAction, requestDocumentChangesAction, updateApplicationStatusAction, saveApplicationNotesAction } from "@/lib/actions/applications";
import { SubmissionForm } from "@/components/SubmissionForm";
import { SubmitButton } from "@/components/SubmitButton";
import { getSetting } from "@/lib/settings";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DocumentWorkspace } from "@/components/DocumentWorkspace";

export const dynamic = "force-dynamic";

export default async function ApplicationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
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
    notes: string | null;
    last_update: string;
    created_at: string;
    title: string;
    company: string;
    location: string | null;
    url: string | null;
    match_score: number | null;
    match_flag: string | null;
    salary: string | null;
    employment_type: string | null;
  }>(
    `SELECT a.*, j.title, j.company, j.location, j.url, j.match_score, j.match_flag, j.salary, j.employment_type
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [id],
  );
  if (!app) notFound();

  const cv = app.cv_document_id ? one<{ id: string; display_name: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null; kind: string }>("SELECT id, display_name, ats_score, quality_status, quality_score, version, kind FROM documents WHERE id = ?", [app.cv_document_id]) : null;
  const cover = app.cover_letter_id ? one<{ id: string; display_name: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null; kind: string }>("SELECT id, display_name, ats_score, quality_status, quality_score, version, kind FROM documents WHERE id = ?", [app.cover_letter_id]) : null;
  const siblings = all<{ id: string; display_name: string; mime: string; ats_score: number | null; quality_status: string | null; quality_score: number | null; version: string | null }>(
    "SELECT id, display_name, mime, ats_score, quality_status, quality_score, version FROM documents WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
    [app.job_id],
  );
  const timeline = all<{ action: string; detail: string | null; created_at: string }>(
    "SELECT action, detail, created_at FROM audit_logs WHERE entity = 'application' AND entity_id = ? ORDER BY id DESC LIMIT 20",
    [id],
  );
  const interventions = all<{ id: string; field: string | null; question: string; reason: string; kind: string }>(
    "SELECT id, field, question, reason, kind FROM application_interventions WHERE application_id = ? AND status = 'open' ORDER BY created_at",
    [id],
  );
  const approvalMode = getSetting<boolean>("approval_mode", true);
  const reviewDocs = siblings
    .filter((doc) => doc.id === app.cv_document_id || doc.id === app.cover_letter_id)
    .sort((a, b) => (a.id === app.cv_document_id ? -1 : b.id === app.cv_document_id ? 1 : 0))
    .map((doc) => ({
      id: doc.id,
      label: doc.id === app.cv_document_id ? "Tailored CV" : "Cover letter",
      mime: doc.mime,
      ats: doc.ats_score,
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
              {app.title} at {app.company} · {app.match_score ?? "—"}% match · ATS {cv?.ats_score ?? "—"}/100 · Quality {cv?.quality_status ?? "not checked"}{cv?.quality_score !== null && cv?.quality_score !== undefined ? ` (${cv.quality_score}/100)` : ""}. Review the CV and cover letter here before approving.
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
                    Application Agent · {app.submitted_at
                      ? `recorded ${formatDateTime(app.submitted_at)} via ${(app.method ?? "").replace(/_/g, " ")}`
                      : `not submitted${approvalMode ? " — approval mode is on" : ""}`}
                  </p>
                </div>
              </div>
            </div>
            <div className="card-body">
              {isApplicationSubmitted(app) ? (
                <div className="card-quiet p-3">
                  <div className="label" style={{ marginBottom: 2 }}>Employer confirmation</div>
                  <div className="text-[13px]">{app.confirmation ?? "No reference stored"}</div>
                  <p className="hint">Submission is verified by this reference and stored with the application record.</p>
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
                  {!app.approved_at ? (
                    <form action={approveApplicationAction}>
                      <input type="hidden" name="id" value={app.id} />
                      <SubmitButton className="btn btn-primary" pendingLabel="Approving…">Approve application package</SubmitButton>
                    </form>
                  ) : (
                    <div className="alert alert-ok">Approved {formatDateTime(app.approved_at)}. Submit through the employer channel, then record the confirmation.</div>
                  )}
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
                    <SubmissionForm applicationId={app.id} approved={Boolean(app.approved_at)} />
                  </div>
                  <p className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                    Automated portal submission is not configured in this deployment. Employer portals commonly require logins, CAPTCHAs or MFA; this platform
                    never bypasses those controls, so submissions are confirmed manually and then recorded here.
                  </p>
                </div>
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
                      <div className="text-[12.5px] font-medium">{doc!.kind === "tailored_cv" ? "Tailored CV" : "Cover letter"} · v{doc!.version}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        ATS self-check {doc!.ats_score ?? "—"}/100 · quality {doc!.quality_status ?? "not checked"}{doc!.quality_score !== null ? ` (${doc!.quality_score}/100)` : ""}
                      </div>
                    </div>
                    <a href={`/api/documents/${doc!.id}`} className="btn btn-sm">Download</a>
                  </div>
                ))
              )}
              {siblings.length > 2 ? (
                <details className="mt-1">
                  <summary className="text-[11.5px]" style={{ color: "var(--muted)", cursor: "pointer" }}>All {siblings.length} files for this vacancy</summary>
                  <div className="stack mt-2" style={{ gap: 6 }}>
                    {siblings.map((doc) => (
                      <div key={doc.id} className="between card-quiet px-3 py-2">
                        <span className="text-[11.5px]">{doc.display_name}{doc.quality_status ? ` · ${doc.quality_status}` : ""}</span>
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
                <p className="card-sub">Audit records for this application.</p>
              </div>
            </div>
            <div className="card-body">
              {timeline.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No events recorded yet.</p>
              ) : (
                <div className="feed">
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
              <p className="hint">Selecting Submitted is blocked here; use the confirmation form instead.</p>
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
              <div className="between"><span style={{ color: "var(--muted)" }}>Approved</span><span>{app.approved_at ? "Yes" : "No"}</span></div>
              <div className="between"><span style={{ color: "var(--muted)" }}>Submitted</span><span>{app.submitted_at ? "Yes" : "No"}</span></div>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
