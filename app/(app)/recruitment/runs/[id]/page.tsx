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
import { buildExecutionManifest } from "@/lib/execution-manifest";
import { formatInZone } from "@/lib/recruitment-schedule";
import { agentIdentity } from "@/lib/agent-identity";
import { discoveryResearchReport } from "@/lib/recruitment-discovery";

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
  const manifest = buildExecutionManifest(id);
  const research = discoveryResearchReport(id);

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
        sub={`${runRow.trigger} · ${formatInZone(runRow.started_at)} → ${formatInZone(runRow.finished_at)} · threshold ${qualifyingThreshold()}% · execution ${runRow.id}`}
        actions={
          <>
            <span className={`badge ${runRow.status === "completed" ? "badge-good" : runRow.status === "failed" || runRow.status === "missed" ? "badge-bad" : "badge-warn"}`}>{runRow.status.replace(/_/g, " ")}</span>
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

      {manifest ? (
        <>
          <section className="card mb-4">
            <div className="card-head">
              <div>
                <h2>Execution manifest</h2>
                <p className="card-sub">The same persisted evidence drives this page, the live workflow and the administrator email.</p>
              </div>
              <span className={`badge ${manifest.status === "completed" ? "badge-good" : manifest.status === "failed" ? "badge-bad" : "badge-warn"}`}>{manifest.status.replace(/_/g, " ")}</span>
            </div>
            <div className="card-body">
              <div className="grid g4 mb-3" style={{ gap: 10 }}>
                <div className="card-quiet p-3"><div className="cell-sub">Expected</div><div className="text-[22px] font-semibold">{manifest.expectedAgents}</div></div>
                <div className="card-quiet p-3"><div className="cell-sub">Dispatched</div><div className="text-[22px] font-semibold">{manifest.dispatchedAgents}</div></div>
                <div className="card-quiet p-3"><div className="cell-sub">Succeeded</div><div className="text-[22px] font-semibold">{manifest.succeededAgents}</div></div>
                <div className="card-quiet p-3"><div className="cell-sub">Orchestration failures / skipped</div><div className="text-[22px] font-semibold">{manifest.notExecutedAgents} / {manifest.skippedAgents}</div></div>
              </div>
              <p className="text-[12px] mb-3" style={{ color: "var(--muted)" }}>{manifest.summary} Results received: {manifest.resultsReceived}; rejected: {manifest.resultsRejected}; handoffs completed: {manifest.handoffsCompleted}/{manifest.handoffsExpected}.</p>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Agent</th><th>Actual state</th><th>Assignment</th><th>Records</th><th>Duration</th><th>Output / issue</th></tr></thead>
                  <tbody>
                    {manifest.agents.map((agent) => (
                      <tr key={agent.key}>
                        <td className="cell-title">{agent.name}<div className="cell-sub">{agent.role}</div></td>
                        <td><span className={`badge ${agent.state === "COMPLETED" ? "badge-good" : agent.state === "COMPLETED_WITH_ZERO_RESULTS" ? "badge-info" : agent.state === "FAILED" ? "badge-bad" : agent.state === "RUNNING" ? "badge-info" : agent.state === "SKIPPED" ? "badge-neutral" : agent.state === "NOT_EXECUTED" ? "badge-warn" : "badge-warn"}`}>{agent.stateLabel}</span></td>
                        <td className="cell-sub">{agent.assignments.at(-1) ?? "No assignment"}</td>
                        <td className="num">{agent.recordsProcessed}</td>
                        <td className="num">{agent.durationMs === null ? "—" : `${Math.round(agent.durationMs / 1000)}s`}</td>
                        <td className="cell-sub">{agent.error ?? agent.output ?? agent.reason ?? "No output recorded"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="stats mb-4">
            <Stat label="Postings screened" value={manifest.counts.postingsScreened} />
            <Stat label="Relevant" value={manifest.counts.relevant} />
            <Stat label="New vacancies" value={manifest.counts.newJobs} />
            <Stat label="Eligible (this run)" value={manifest.counts.eligible} />
            <Stat label="Qualified (this run)" value={manifest.counts.qualified} tone="good" />
            <Stat label="Prepared" value={manifest.counts.documentsPrepared} />
            <Stat label="Ready" value={manifest.counts.applicationsReady} />
            <Stat label="Submitted (verified)" value={manifest.counts.submittedVerified} tone="good" />
            <Stat label="Unverified" value={manifest.counts.submittedUnverified} tone={manifest.counts.submittedUnverified ? "warn" : undefined} />
            <Stat label="Intervention" value={manifest.counts.interventions} tone={manifest.counts.interventions ? "warn" : undefined} />
          </section>

          <section className="card mb-4">
            <div className="card-head">
              <div>
                <h2>Read-only external evidence</h2>
                <p className="card-sub">Agent Reach page reads for the newest stored vacancies, bounded per run. Evidence is an audit input only.</p>
              </div>
              <span className={`badge ${research ? (research.ok ? "badge-good" : "badge-warn") : "badge-neutral"}`}>
                {research ? `${research.succeeded}/${research.attempted} usable` : "no evidence recorded"}
              </span>
            </div>
            <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
              {research ? (
                <>
                  <div className="between"><span style={{ color: "var(--muted)" }}>Vacancies read / attempted</span><span>{research.succeeded} / {research.attempted}</span></div>
                  <div className="between"><span style={{ color: "var(--muted)" }}>Hard cap per run</span><span>{research.cap}</span></div>
                  <div className="between"><span style={{ color: "var(--muted)" }}>Counters describe</span><span>{research.fromRun ? "this run" : "the latest recorded research pass"}</span></div>
                  <div className="between"><span style={{ color: "var(--muted)" }}>Last read</span><span>{research.lastCheckedAt ? formatDateTime(research.lastCheckedAt) : "not recorded"}</span></div>
                  {research.error ? <div className="alert alert-warn" style={{ padding: "7px 9px", fontSize: 11 }}>{research.error}</div> : null}
                  <p className="hint">These reads cannot insert a vacancy, change a match score, satisfy the {qualifyingThreshold()}% threshold, alter eligibility or reach submission. Deduplication, German-language exclusion and readiness gates run before and independently of them.</p>
                </>
              ) : (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>This run recorded no bounded research pass. Discovery and every gate ran without external evidence.</p>
              )}
            </div>
          </section>

          <section className="card mb-4">
            <div className="card-head">
              <div>
                <h2>Source outcomes</h2>
                <p className="card-sub">A failed source is never presented as a successful source with zero jobs.</p>
              </div>
            </div>
            <div className="table-wrap">
              {manifest.sources.length === 0 ? (
                <Empty title="No source metrics recorded" />
              ) : (
                <table className="data">
                  <thead><tr><th>Source</th><th>Status</th><th>Postings</th><th>Fresh</th><th>Relevant</th><th>Duplicates</th><th>New</th><th>Errors</th></tr></thead>
                  <tbody>
                    {manifest.sources.map((source) => (
                      <tr key={source.key}>
                        <td className="cell-title">{source.label}</td>
                        <td><span className={`badge ${source.status === "ok" || source.status === "empty" ? "badge-good" : source.status === "failed" ? "badge-bad" : "badge-warn"}`}>{source.status}</span></td>
                        <td className="num">{source.postings}</td>
                        <td className="num">{source.fresh}</td>
                        <td className="num">{source.relevant}</td>
                        <td className="num">{source.duplicates}</td>
                        <td className="num">{source.inserted}</td>
                        <td className="num">{source.errors}</td>
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
                <h2>Warnings and failures</h2>
                <p className="card-sub">Exact persisted detail, not just a count.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {manifest.warnings.length === 0 && manifest.failures.length === 0 ? (
                <Empty title="No warning or failure recorded" />
              ) : (
                <>
                  {manifest.failures.map((failure, index) => (
                    <div key={`failure-${index}`} className="alert alert-error" style={{ margin: 0 }}><strong>Failure:</strong> {failure}</div>
                  ))}
                  {manifest.warnings.map((warning, index) => (
                    <div key={`warning-${index}`} className="alert alert-info" style={{ margin: 0 }}><strong>Warning:</strong> {warning}</div>
                  ))}
                </>
              )}
            </div>
          </section>
        </>
      ) : null}

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
            <h2>{agentIdentity("coordinator").name} state history</h2>
            <p className="card-sub">Every state {agentIdentity("coordinator").name} passed through.</p>
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
            <p className="card-sub">Assignments, retries and {agentIdentity("coordinator").name}&apos;s decision for each one.</p>
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
                    <td className="cell-title">{agentIdentity(agent.agent_key).name}<div className="cell-sub">{agentIdentity(agent.agent_key).title}</div></td>
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
