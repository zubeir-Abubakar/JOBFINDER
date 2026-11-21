import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { PageHead, Stat, Empty, Flash } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { formatDate, formatDateTime, param } from "@/lib/format";
import { AUTONOMOUS_PIPELINE, statusClass, statusLabel } from "@/lib/application-status";
import { formatInZone, scheduleSnapshot } from "@/lib/recruitment-schedule";
import { qualifyingThreshold, recentRuns } from "@/lib/recruitment-run";
import { buildExecutionManifest } from "@/lib/execution-manifest";
import { dailySubmissionUsage, getRecruitmentPolicy } from "@/lib/recruitment-policy";
import { recruitmentSchedulerStatus } from "@/lib/recruitment-ticker";
import { sourceHealth, type SourceMetrics } from "@/lib/recruitment-discovery";
import { agentIdentity } from "@/lib/agent-identity";
import { handoffQueue } from "@/lib/handoff";
import {
  pauseStandingAuthorisationAction,
  resumeStandingAuthorisationAction,
  runRecruitmentDiscoveryNowAction,
  runRecruitmentNowAction,
  saveRecruitmentPolicyAction,
  toggleRecruitmentScheduleAction,
} from "@/lib/actions/recruitment";
import { executiveBriefScheduleSnapshot } from "@/lib/executive-brief";

export const dynamic = "force-dynamic";

/**
 * Autonomous Recruitment operations centre.
 *
 * Every figure comes from the persisted run/application records, so the page
 * shows what actually happened rather than what the team intended to do.
 */
export default async function RecruitmentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;
  const handoffs = handoffQueue(user.id, 20);
  const runs = recentRuns(12);
  const latest = runs[0] ?? null;
  const latestManifest = latest ? buildExecutionManifest(latest.id) : null;
  const schedule = scheduleSnapshot();
  const reportSchedule = executiveBriefScheduleSnapshot();
  const policy = getRecruitmentPolicy();
  const usage = dailySubmissionUsage();
  const scheduler = recruitmentSchedulerStatus();
  const checkedAt = schedule.lastCheckedAt ? Date.parse(schedule.lastCheckedAt) : NaN;
  const recentlyChecked = Number.isFinite(checkedAt) && Date.now() - checkedAt < 150_000;
  const schedulerLive = scheduler.running || recentlyChecked;
  const schedulerHealth = !schedule.enabled
    ? "Paused"
    : schedule.missed
      ? "Missed"
      : schedule.due
        ? "Due"
        : schedulerLive
          ? "Running"
          : "Not running";
  let sourceMetrics: SourceMetrics[] = [];
  try {
    const parsed = latest?.source_metrics ? JSON.parse(latest.source_metrics) : [];
    if (Array.isArray(parsed)) sourceMetrics = parsed as SourceMetrics[];
  } catch {
    sourceMetrics = [];
  }
  const rejected = latest
    ? all<{ title: string; company: string; eligibility: string | null; eligibility_notes: string | null; match_score: number | null }>(
        `SELECT title, company, eligibility, eligibility_notes, match_score FROM jobs
         WHERE run_id = ? AND qualified = 0 ORDER BY match_score DESC NULLS LAST LIMIT 6`,
        [latest.id],
      )
    : [];
  const runQueues = latest
    ? one<{ processing: number; quality: number; approval: number; submitted: number }>(
        `SELECT
           SUM(CASE WHEN a.status IN ('documents_preparing','preparing_documents','awaiting_documents') THEN 1 ELSE 0 END) AS processing,
           SUM(CASE WHEN a.status = 'quality_check' THEN 1 ELSE 0 END) AS quality,
           SUM(CASE WHEN a.status = 'awaiting_approval' THEN 1 ELSE 0 END) AS approval,
           SUM(CASE WHEN a.status = 'submitted' THEN 1 ELSE 0 END) AS submitted
         FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ?`,
        [latest.id],
      )
    : null;
  const rejectedTotal = latest
    ? Number(one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE run_id = ? AND qualified = 0", [latest.id])?.c ?? 0)
    : 0;
  const lastSourceChecks = sourceHealth();
  const lastSuccessfulDiscovery = lastSourceChecks
    .map((check) => check.last_success_at)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  const latestRunStartedAt = latest?.started_at ? Date.parse(latest.started_at) : NaN;
  const lastFailedSource = lastSourceChecks
    .filter((check) => check.ok !== 1)
    .filter((check) => !Number.isFinite(latestRunStartedAt) || Date.parse(check.last_checked_at) >= latestRunStartedAt)
    .sort((a, b) => b.last_checked_at.localeCompare(a.last_checked_at))[0] ?? null;
  const rejectionReason = (job: (typeof rejected)[number]): string => {
    try {
      const parsed = JSON.parse(job.eligibility_notes ?? "{}") as { blockers?: string[]; reasons?: string[] };
      return parsed.blockers?.[0] ?? parsed.reasons?.[0] ?? (job.eligibility === "eligible" ? "Below match threshold" : "Did not meet eligibility rules");
    } catch {
      return job.eligibility === "eligible" ? "Below match threshold" : "Did not meet eligibility rules";
    }
  };

  const today = one<{ discovered: number; qualified: number; prepared: number; submitted: number; intervention: number; interviews: number }>(
    `SELECT
       (SELECT COUNT(*) FROM jobs WHERE date(discovered_at) = date('now')) AS discovered,
       (SELECT COUNT(*) FROM jobs WHERE qualified = 1 AND date(discovered_at) = date('now')) AS qualified,
       (SELECT COUNT(*) FROM applications WHERE created_at IS NOT NULL AND status IN ('ready_to_submit','quality_check','submitted','submission_unverified') AND date(last_update) = date('now')) AS prepared,
       (SELECT COUNT(*) FROM applications WHERE submission_status = 'verified' AND date(submitted_at) = date('now')) AS submitted,
       (SELECT COUNT(*) FROM applications WHERE status = 'human_intervention_required') AS intervention,
       (SELECT COUNT(*) FROM applications WHERE status IN ('interview','interview_invited','interview_completed')) AS interviews`,
  ) ?? { discovered: 0, qualified: 0, prepared: 0, submitted: 0, intervention: 0, interviews: 0 };

  const pipeline = all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM applications GROUP BY status");
  const pipelineMap = new Map(pipeline.map((row) => [row.status, Number(row.n)]));
  const attention = all<{
    id: string; status: string; submission_status: string | null; title: string; company: string; updated: string;
  }>(
    `SELECT a.id, a.status, a.submission_status, j.title, j.company, a.last_update AS updated
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status IN ('human_intervention_required','submission_unverified')
     ORDER BY a.last_update DESC LIMIT 8`,
  );
  const upcoming = all<{ id: string; title: string; company: string; status: string }>(
    `SELECT a.id, j.title, j.company, a.status FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status IN ('interview','interview_invited') ORDER BY a.last_update DESC LIMIT 5`,
  );

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} />
      <PageHead
        title="Autonomous Recruitment"
        sub={`${agentIdentity("coordinator").name} runs the team on ${schedule.weekdayLabels.join(", ")} at ${schedule.time} ${schedule.timezone}. Qualifying applications (${qualifyingThreshold()}% or higher) are ${policy.active ? "prepared and automatically submitted without per-application approval" : "prepared but not submitted while automatic submission is paused"}.`}
        actions={
          <>
            <form action={runRecruitmentDiscoveryNowAction}>
              <SubmitButton className="btn btn-primary" pendingLabel="Discovering…">Run discovery now</SubmitButton>
            </form>
            <form action={runRecruitmentNowAction}>
              <SubmitButton className="btn" pendingLabel="Starting run…">Run full pipeline</SubmitButton>
            </form>
            <form action={toggleRecruitmentScheduleAction}>
              <SubmitButton className="btn" pendingLabel="Saving…">{schedule.enabled ? "Pause schedule" : "Resume schedule"}</SubmitButton>
            </form>
          </>
        }
      />

      <section className="stats mb-4">
        <Stat label="Latest postings screened" value={latestManifest?.counts.postingsScreened ?? 0} />
        <Stat label="Latest relevant" value={latestManifest?.counts.relevant ?? 0} />
        <Stat label="New today" value={today.discovered} href="/jobs" />
        <Stat label={`At or above ${qualifyingThreshold()}%`} value={today.qualified} tone="good" href="/jobs?min=85" />
        <Stat label="Prepared" value={today.prepared} href="/applications" />
        <Stat label="Submitted (verified)" value={today.submitted} tone="good" href="/applications?status=submitted" />
        <Stat label="Needs your attention" value={today.intervention} tone={today.intervention ? "warn" : undefined} href="/recruitment#attention" />
        <Stat label="Interviews" value={today.interviews} tone={today.interviews ? "good" : undefined} href="/applications?group=interviews" />
      </section>

      <section className="card mb-4" id="standing-authorisation">
        <div className="card-head">
          <div>
            <h2>Automatic submission</h2>
            <p className="card-sub">Eligible applications are submitted automatically. There is no per-application approval. The team interrupts you only for an unknown essential answer, a consequential declaration, a security challenge or an unsupported workflow.</p>
          </div>
          <span className={`badge ${policy.active ? "badge-good" : "badge-warn"}`}>
            {policy.active ? "Active" : "Paused"}
          </span>
        </div>
        <div className="card-body">
          <div className="grid g2" style={{ gap: 16 }}>
            <form action={saveRecruitmentPolicyAction} className="stack" style={{ gap: 10 }}>
              <label className="flex items-center gap-2 text-[12.5px]">
                <input type="checkbox" name="autonomous_submission" defaultChecked={policy.autonomousSubmission} /> Automatic application submission
              </label>
              <div>
                <label className="label" htmlFor="policy_min_score">Minimum match score</label>
                <input id="policy_min_score" name="min_match_score" type="number" min={85} max={100} className="input" defaultValue={policy.minMatchScore} />
                <p className="hint">The {policy.minMatchScore}% floor is enforced by the engine; it cannot be lowered here.</p>
              </div>
              <div>
                <label className="label" htmlFor="policy_max_day">Maximum verified submissions per day</label>
                <input id="policy_max_day" name="max_applications_per_day" type="number" min={1} max={10} className="input" defaultValue={policy.maxSubmissionsPerDay} />
                <p className="hint">Today: {usage.verified} of {usage.limit} used; {usage.remaining} remaining. The limit is counted in {schedule.timezone}.</p>
              </div>
              <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
                Freshness ≤ {policy.freshnessDays} days · verified and open vacancies only · duplicate applications blocked · no per-application approval.
              </div>
              <div><SubmitButton className="btn btn-primary" pendingLabel="Saving…">Save policy</SubmitButton></div>
            </form>
            <div className="stack" style={{ gap: 10 }}>
              {policy.active ? (
                <>
                  <div className="alert alert-info">
                    Automatic submission is active. Only applications that pass every eligibility, document, duplicate and safety check are sent; only employer-confirmed submissions are counted.
                  </div>
                  <form action={pauseStandingAuthorisationAction}>
                    <SubmitButton className="btn" pendingLabel="Pausing…">Pause automatic submission</SubmitButton>
                  </form>
                </>
              ) : (
                <>
                  <div className="alert alert-warn">
                    Automatic submission is paused. Packages can still be prepared and reviewed, but nothing is sent until you resume the owner-level switch.
                  </div>
                  <form action={resumeStandingAuthorisationAction}>
                    <SubmitButton className="btn btn-primary" pendingLabel="Resuming…">Resume automatic submission</SubmitButton>
                  </form>
                </>
              )}
              <p className="hint">CAPTCHAs, MFA, logins, payments, unsupported portals and consequential legal declarations always stop the workflow and create a handoff. Unknown essential answers are queued for you.</p>
            </div>
          </div>
        </div>
      </section>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Weekly schedule</h2>
              <p className="card-sub">Persisted in the database, so a restart cannot forget it. Change the two schedules in Settings.</p>
            </div>
            <span className={`badge ${schedulerHealth === "Running" ? "badge-good" : schedulerHealth === "Missed" ? "badge-bad" : schedulerHealth === "Paused" ? "badge-neutral" : "badge-warn"}`}>{schedulerHealth}</span>
          </div>
          <div className="card-body stack text-[12.5px]" style={{ gap: 8 }}>
            <div className="between"><span style={{ color: "var(--muted)" }}>Days</span><span>{schedule.weekdayLabels.join(", ")}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Recruitment time</span><span className="num">{schedule.time} · {schedule.timezone}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Daily report</span><span className="num">{reportSchedule.weekdaysList.map((day) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(", ")} · {reportSchedule.time}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Next report</span><span>{formatInZone(reportSchedule.next_run_at, reportSchedule.timezone)}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Next execution</span><span>{formatInZone(schedule.nextRunAt)}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Last execution</span><span>{formatInZone(schedule.lastRunAt)}{schedule.lastStatus ? ` · ${schedule.lastStatus.replace(/_/g, " ")}` : ""}</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Scheduler process</span><span>{schedulerLive ? "Ticker running" : "Ticker not detected"}{schedule.lastCheckedAt ? ` · checked ${formatInZone(schedule.lastCheckedAt)}` : ""}</span></div>
            {schedule.missed ? <p className="hint">The scheduled execution is outside the catch-up window; the missed run is recorded rather than executed late.</p> : null}
            <div className="between"><span style={{ color: "var(--muted)" }}>Minimum match</span><span>{qualifyingThreshold()}% (cannot be lowered automatically)</span></div>
            <div className="between"><span style={{ color: "var(--muted)" }}>Applications per day</span><span>{policy.maxSubmissionsPerDay} · {usage.remaining} remaining today</span></div>
            <p className="hint">
              This scheduler runs inside the application. Your Mac and this application (or its worker) must be running at {schedule.time} {schedule.timezone} for the run to execute; a switched-off machine cannot run it. The state survives restarts, and a missed run is recorded rather than silently skipped. <Link href="/settings#scheduling" style={{ textDecoration: "underline" }}>Edit the two schedules</Link>.
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Latest run</h2>
              <p className="card-sub">{latest ? `${latest.trigger} · ${latest.run_key}` : "No run has executed yet."}</p>
            </div>
            {latest ? <Link href={`/recruitment/runs/${latest.id}`} className="btn btn-sm">Open report</Link> : null}
          </div>
          <div className="card-body">
            {latest ? (
              <div className="stack text-[12.5px]" style={{ gap: 8 }}>
                <div className="between"><span style={{ color: "var(--muted)" }}>Status</span><span className={`badge ${latest.status === "completed" ? "badge-good" : latest.status === "failed" ? "badge-bad" : "badge-warn"}`}>{latest.status.replace(/_/g, " ")}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Discovery state</span><span>{latest.discovery_state?.replace(/_/g, " ") ?? "not recorded"}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Sources checked / ok / partial / failed</span><span>{latest.sources_checked ?? 0} / {latest.sources_succeeded ?? 0} / {latest.sources_partial ?? 0} / {latest.sources_failed ?? 0}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>New / relevant / duplicates / filtered</span><span>{latest.jobs_discovered} / {latestManifest?.counts.relevant ?? 0} / {latest.jobs_duplicates ?? 0} / {latest.jobs_filtered ?? 0}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Agents succeeded / expected</span><span>{latestManifest?.succeededAgents ?? 0} / {latestManifest?.expectedAgents ?? 8} · {latestManifest?.notExecutedAgents ?? 0} not executed · {latestManifest?.skippedAgents ?? 0} skipped</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Eligible / qualified / rejected</span><span>{latest.jobs_eligible} / {latest.jobs_qualified} / {rejectedTotal}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Prepared</span><span>{latest.packages_prepared}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Processing / quality / approval</span><span>{runQueues?.processing ?? 0} / {runQueues?.quality ?? 0} / {runQueues?.approval ?? 0}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Submitted and verified</span><span>{latest.applications_submitted}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Unverified / intervention</span><span>{latest.applications_unverified} / {latest.applications_intervention}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Started / finished</span><span>{formatDateTime(latest.started_at)} → {formatDateTime(latest.finished_at)}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Last successful discovery</span><span>{formatInZone(lastSuccessfulDiscovery)}</span></div>
                <div className="between"><span style={{ color: "var(--muted)" }}>Last failed source</span><span>{lastFailedSource ? `${lastFailedSource.source_key} · ${lastFailedSource.error ?? "unknown error"}` : latest ? "None in latest run" : "None recorded"}</span></div>
                {rejected.length > 0 ? (
                  <div className="card-quiet p-2">
                    <div className="text-[11px] font-medium mb-1">Latest run rejections</div>
                    {rejected.map((job) => (
                      <div key={`${job.title}-${job.company}`} className="text-[11px]" style={{ color: "var(--muted)" }}>
                        {job.title} — {job.company}: {rejectionReason(job)}
                      </div>
                    ))}
                  </div>
                ) : null}
                {latest.error ? <div className="alert alert-error" style={{ padding: "7px 9px", fontSize: 11 }}>{latest.error}</div> : null}
              </div>
            ) : (
              <Empty title="No autonomous run yet">Run the team now to create the first record, or wait for the next scheduled execution.</Empty>
            )}
          </div>
        </section>
      </div>

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Source contribution</h2>
            <p className="card-sub">Requests, freshness, relevance and what each configured source contributed to the latest run.</p>
          </div>
        </div>
        <div className="table-wrap">
          {sourceMetrics.length === 0 ? (
            <Empty title="No source metrics yet">Run discovery to record what each source returned.</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Time</th>
                  <th>Requests</th>
                  <th>Responses</th>
                  <th>Postings</th>
                  <th>Fresh</th>
                  <th>Relevant</th>
                  <th>Duplicates</th>
                  <th>New</th>
                  <th>Eligible</th>
                  <th>Qualified</th>
                </tr>
              </thead>
              <tbody>
                {sourceMetrics.map((metric) => (
                  <tr key={metric.key}>
                    <td className="cell-title">{metric.label}{metric.errors ? <div className="cell-sub">{metric.errors} error(s)</div> : null}</td>
                    <td><span className={`badge ${metric.status === "ok" ? "badge-good" : metric.status === "failed" ? "badge-bad" : "badge-warn"}`}>{metric.status ?? "unknown"}</span></td>
                    <td className="num">{metric.attempts ?? 0}</td>
                    <td className="num">{metric.durationMs ? `${metric.durationMs} ms` : "—"}</td>
                    <td className="num">{metric.requests}</td>
                    <td className="num">{metric.responses}</td>
                    <td className="num">{metric.postings}</td>
                    <td className="num">{metric.fresh}</td>
                    <td className="num">{metric.relevant}</td>
                    <td className="num">{metric.duplicates}</td>
                    <td className="num">{metric.inserted}</td>
                    <td className="num">{metric.eligible}</td>
                    <td className="num">{metric.qualified}</td>
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
            <h2>Daily run history</h2>
            <p className="card-sub">Every run is kept, including failed and warning runs.</p>
          </div>
        </div>
        <div className="table-wrap">
          {runs.length === 0 ? (
            <Empty title="No runs recorded">The first scheduled or manual run will appear here.</Empty>
          ) : (
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Trigger</th>
                  <th>Discovered</th>
                  <th>Qualified</th>
                  <th>Submitted</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((item) => (
                  <tr key={item.id}>
                    <td className="cell-title">{item.run_key.split("#")[0]}<div className="cell-sub">{formatDateTime(item.started_at ?? item.created_at)}</div></td>
                    <td className="cell-sub">{item.trigger}</td>
                    <td className="num">{item.jobs_discovered}</td>
                    <td className="num">{item.jobs_qualified}</td>
                    <td className="num">{item.applications_submitted}</td>
                    <td><span className={`badge ${item.status === "completed" ? "badge-good" : item.status === "failed" ? "badge-bad" : "badge-warn"}`}>{item.status.replace(/_/g, " ")}</span></td>
                    <td className="text-right"><Link href={`/recruitment/runs/${item.id}`} className="btn btn-sm">Report</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="card mb-4" id="handoffs" data-visual-id="approval-queue">
        <div className="card-head">
          <div>
            <h2>Human intervention queue</h2>
            <p className="card-sub">
              Persistent handoff packages for applications that stopped at a legitimate human step. The package includes the direct employer link, the original posting, the final CV and cover letter, prepared answers and the remaining steps. An eligible application does not enter this queue for approval.
            </p>
          </div>
          <span className={`badge ${handoffs.length ? "badge-warn" : "badge-good"}`}>{handoffs.length} item(s)</span>
        </div>
        <div className="card-body stack" style={{ gap: 10 }}>
          {handoffs.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing is waiting for a human step. Eligible applications are submitted automatically.</p>
          ) : (
            handoffs.map((item) => (
              <div key={item.applicationId} className="card-quiet p-3 stack" style={{ gap: 8 }}>
                <div className="between flex-wrap gap-2">
                  <div>
                    <div className="text-[13px] font-semibold">{item.jobTitle} — {item.employer}</div>
                    <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                      Match {item.matchScore ?? "—"}% · {item.queueStatusLabel} · blocker: {item.blocker.kind.replace(/_/g, " ")}
                    </div>
                  </div>
                  <div className="row">
                    <Link href={`/applications/${item.applicationId}`} className="btn btn-sm">Open package</Link>
                    {item.applicationUrl ? <a href={item.applicationUrl} target="_blank" rel="noreferrer" className="btn btn-sm btn-primary">Employer page</a> : null}
                    {item.postingUrl && item.postingUrl !== item.applicationUrl ? <a href={item.postingUrl} target="_blank" rel="noreferrer" className="btn btn-sm">Original posting</a> : null}
                  </div>
                </div>
                <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>{item.stopExplanation}</div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {item.cv ? <Link href={item.cv.previewHref} className="badge badge-info">CV: {item.cv.name}</Link> : <span className="badge badge-warn">CV missing</span>}
                  {item.coverLetter ? <Link href={item.coverLetter.previewHref} className="badge badge-info">Cover letter: {item.coverLetter.name}</Link> : <span className="badge badge-warn">Cover letter missing</span>}
                  {item.preparedAnswers.length ? <span className="badge badge-neutral">{item.preparedAnswers.length} prepared answer(s)</span> : null}
                </div>
                <ol className="text-[11.5px] pl-4" style={{ color: "var(--muted)", listStyle: "decimal" }}>
                  {item.remainingSteps.map((step) => <li key={step}>{step}</li>)}
                </ol>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Application pipeline</h2>
              <p className="card-sub">Counts by the status names used by the autonomous workflow.</p>
            </div>
          </div>
          <div className="card-body stack" style={{ gap: 6 }}>
            {AUTONOMOUS_PIPELINE.map((stage) => (
              <div key={stage.status} className="between text-[12.5px]">
                <span><span className={`badge ${statusClass(stage.status)}`}>{statusLabel(stage.status)}</span></span>
                <span className="num">{pipelineMap.get(stage.status) ?? 0}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="stack">
          <section className="card" id="attention">
            <div className="card-head">
              <div>
                <h2>Needs your attention</h2>
                <p className="card-sub">Applications the team deliberately did not submit, or could not verify.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {attention.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>Nothing is waiting for you.</p>
              ) : (
                attention.map((item) => (
                  <div key={item.id} className="between card-quiet p-3">
                    <div>
                      <div className="text-[12.5px] font-medium">{item.title} — {item.company}</div>
                      <div className="text-[11px]" style={{ color: "var(--muted)" }}>{item.submission_status ?? statusLabel(item.status)} · {formatDate(item.updated)}</div>
                    </div>
                    <Link href={`/applications/${item.id}`} className="btn btn-sm">Open</Link>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Upcoming interviews</h2>
                <p className="card-sub">From confirmed employer responses.</p>
              </div>
            </div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {upcoming.length === 0 ? (
                <p className="text-[12px]" style={{ color: "var(--muted)" }}>No interview stage is recorded.</p>
              ) : (
                upcoming.map((item) => (
                  <div key={item.id} className="between card-quiet p-3">
                    <div className="text-[12.5px]">{item.title} — {item.company}</div>
                    <Link href={`/applications/${item.id}`} className="btn btn-sm">Open</Link>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
