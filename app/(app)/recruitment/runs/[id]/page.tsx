import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Stat, Empty } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { formatDateTime, param } from "@/lib/format";
import { eligibilityLabel } from "@/lib/eligibility";
import { statusLabel, statusClass } from "@/lib/application-status";
import { retryRecruitmentRunAction } from "@/lib/actions/recruitment";
import { buildRunReport, runById, runStateHistory, qualifyingThreshold } from "@/lib/recruitment-run";
import { formatInZone } from "@/lib/recruitment-schedule";

export const dynamic = "force-dynamic";

/** Full report for one daily run, readable weeks later and after a restart. */
export default async function RecruitmentRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const runRow = runById(id);
  if (!runRow) notFound();
  const report = runRow.report ?? buildRunReport(id);
  const states = runStateHistory(runRow);

  const jobs = all<{
    id: string; title: string; company: string; location: string | null; match_score: number | null; eligibility: string | null;
    eligibility_notes: string | null; qualified: number; status: string; application_url: string | null; url: string | null;
    source_platform: string | null; published_at: string | null;
  }>(
    `SELECT id, title, company, location, match_score, eligibility, eligibility_notes, qualified, status, application_url, url,
            source_platform, published_at
     FROM jobs WHERE run_id = ? ORDER BY match_score DESC NULLS LAST`,
    [id],
  );
  const applications = all<{
    id: string; status: string; submission_status: string | null; submitted_at: string | null; confirmation_ref: string | null;
    confirmation: string | null; submission_evidence: string | null; cv_document_id: string | null; cover_letter_id: string | null;
    title: string; company: string;
  }>(
    `SELECT a.id, a.status, a.submission_status, a.submitted_at, a.confirmation_ref, a.confirmation, a.submission_evidence,
            a.cv_document_id, a.cover_letter_id, j.title, j.company
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? ORDER BY a.created_at`,
    [id],
  );
  const agents = all<{ agent_key: string; assignment: string; status: string; attempt: number; output: string | null; error: string | null; coordinator_decision: string | null; started_at: string | null; finished_at: string | null }>(
    "SELECT agent_key, assignment, status, attempt, output, error, coordinator_decision, started_at, finished_at FROM recruitment_run_agents WHERE run_id = ? ORDER BY id",
    [id],
  );
  const attempts = all<{ id: string; application_id: string; channel: string; status: string; http_status: number | null; reference: string | null; error: string | null; attempted_at: string }>(
    "SELECT id, application_id, channel, status, http_status, reference, error, attempted_at FROM submission_attempts WHERE run_id = ? ORDER BY attempted_at",
    [id],
  );

  return (
    <>
      <div className="mb-4">
        <Link href="/recruitment" className="text-[12px]" style={{ color: "var(--muted)" }}>← Back to Autonomous Recruitment</Link>
      </div>
      <PageHead
        title={`Daily recruitment report — ${runRow.run_key.split("#")[0]}`}
        sub={`${runRow.trigger} · ${formatInZone(runRow.started_at)} → ${formatInZone(runRow.finished_at)} · threshold ${qualifyingThreshold()}%`}
        actions={
          <>
            <span className={`badge ${runRow.status === "completed" ? "badge-good" : runRow.status === "failed" ? "badge-bad" : "badge-warn"}`}>{runRow.status.replace(/_/g, " ")}</span>
            {runRow.status === "failed" ? (
              <form action={retryRecruitmentRunAction}>
                <input type="hidden" name="run_id" value={runRow.id} />
                <SubmitButton className="btn btn-sm" pendingLabel="Restarting…">Retry run</SubmitButton>
              </form>
            ) : null}
          </>
        }
      />

      {param(sp.ok) ? <div className="alert alert-ok mb-4">{param(sp.ok)}</div> : null}

      <section className="stats mb-4">
        <Stat label="Discovered" value={runRow.jobs_discovered} />
        <Stat label="Eligible" value={runRow.jobs_eligible} />
        <Stat label="Qualified" value={runRow.jobs_qualified} tone="good" />
        <Stat label="Prepared" value={runRow.packages_prepared} />
        <Stat label="Submitted (verified)" value={runRow.applications_submitted} tone="good" />
        <Stat label="Unverified" value={runRow.applications_unverified} tone={runRow.applications_unverified ? "warn" : undefined} />
        <Stat label="Intervention" value={runRow.applications_intervention} tone={runRow.applications_intervention ? "warn" : undefined} />
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Report</h2>
            <p className="card-sub">Stored with the run and reproduced exactly after a restart.</p>
          </div>
        </div>
        <div className="card-body">
          <pre className="text-[12px]" style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, margin: 0 }}>{report}</pre>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Coordinator state history</h2>
            <p className="card-sub">Every state the Chief Coordinator passed through.</p>
          </div>
        </div>
        <div className="card-body">
          <div className="feed">
            {states.map((state, index) => (
              <div key={index} className="feed-item">
                <span className="feed-dot">·</span>
                <div>
                  <div className="feed-text">{state.state.replace(/_/g, " ")}{state.message ? ` — ${state.message}` : ""}</div>
                  <div className="feed-time">{formatDateTime(state.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Agent execution history</h2>
            <p className="card-sub">Assignments, retries and the Coordinator's decision for each one.</p>
          </div>
        </div>
        <div className="table-wrap">
          {agents.length === 0 ? (
            <Empty title="No agent assignments recorded" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>Agent</th><th>Assignment</th><th>Status</th><th>Attempt</th><th>Output / error</th><th>Decision</th></tr>
              </thead>
              <tbody>
                {agents.map((agent, index) => (
                  <tr key={index}>
                    <td className="cell-title">{agent.agent_key}</td>
                    <td className="cell-sub">{agent.assignment}</td>
                    <td><span className={`badge ${agent.status === "completed" ? "badge-good" : agent.status === "failed" ? "badge-bad" : "badge-warn"}`}>{agent.status}</span></td>
                    <td className="num">{agent.attempt}</td>
                    <td className="cell-sub">{agent.error ?? agent.output ?? "—"}</td>
                    <td className="cell-sub">{agent.coordinator_decision ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Vacancies assessed</h2>
            <p className="card-sub">Eligibility, score and the automatic-application decision.</p>
          </div>
        </div>
        <div className="table-wrap">
          {jobs.length === 0 ? (
            <Empty title="No vacancies in this run" />
          ) : (
            <table className="data">
              <thead>
                <tr><th>Vacancy</th><th>Match</th><th>Eligibility</th><th>Qualified</th><th>Source</th><th /></tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  let eligibilityReason = "";
                  try {
                    const parsed = JSON.parse(job.eligibility_notes ?? "{}") as { blockers?: string[]; reasons?: string[] };
                    eligibilityReason = parsed.blockers?.[0] ?? parsed.reasons?.[0] ?? "";
                  } catch {}
                  return (
                    <tr key={job.id}>
                      <td className="cell-title">{job.title}<div className="cell-sub">{job.company}{job.location ? ` · ${job.location}` : ""}</div></td>
                      <td className="num">{job.match_score ?? "—"}{job.match_score !== null ? "%" : ""}</td>
                      <td className="cell-sub">{eligibilityLabel(job.eligibility)}{eligibilityReason ? <div className="text-[11px]" style={{ color: "var(--muted)" }}>{eligibilityReason}</div> : null}</td>
                      <td>{job.qualified ? <span className="badge badge-good">Yes</span> : <span className="badge badge-neutral">No</span>}</td>
                      <td className="cell-sub">{job.source_platform ?? "—"}</td>
                      <td className="text-right"><Link href={`/jobs/${job.id}`} className="btn btn-sm">Job</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Applications</h2>
            <p className="card-sub">Prepared, submitted and unverified packages with their evidence.</p>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 10 }}>
          {applications.length === 0 ? (
            <Empty title="No applications in this run" />
          ) : (
            applications.map((app) => {
              const attempt = attempts.find((item) => item.application_id === app.id);
              return (
                <div key={app.id} className="card-quiet p-3">
                  <div className="between">
                    <div>
                      <div className="text-[12.5px] font-medium">{app.title} — {app.company}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                        <span className={`badge ${statusClass(app.status)}`}>{statusLabel(app.status)}</span>
                        {app.submitted_at ? ` · submitted ${formatDateTime(app.submitted_at)}` : ""}
                        {app.confirmation_ref ? ` · reference ${app.confirmation_ref}` : ""}
                        {attempt ? ` · HTTP ${attempt.http_status ?? "—"}` : ""}
                      </div>
                    </div>
                    <div className="row">
                      {app.cv_document_id ? <a href={`/api/documents/${app.cv_document_id}`} className="btn btn-sm">CV</a> : null}
                      {app.cover_letter_id ? <a href={`/api/documents/${app.cover_letter_id}`} className="btn btn-sm">Cover letter</a> : null}
                      <Link href={`/applications/${app.id}`} className="btn btn-sm">Open</Link>
                    </div>
                  </div>
                  {app.submission_evidence ? (
                    <details className="mt-2">
                      <summary className="text-[11.5px]" style={{ color: "var(--muted)", cursor: "pointer" }}>Submission evidence</summary>
                      <pre className="text-[11px] mt-1" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{app.submission_evidence}</pre>
                    </details>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </section>
    </>
  );
}
