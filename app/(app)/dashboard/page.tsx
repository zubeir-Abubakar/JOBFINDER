import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { getProfileData, profileCompleteness } from "@/lib/profile";
import { jobPipeline } from "@/lib/jobs";
import { getSetting } from "@/lib/settings";
import { unreadNotifications } from "@/lib/notify";
import { cleanupExpiredDocuments } from "@/lib/retention";
import { PageHead, HeroStat, Stat, Empty, Flash, Progress } from "@/components/ui";
import { relativeTime, formatDateTime, formatDate, param } from "@/lib/format";
import { pauseAllAction, resumeAllAction, startWorkflowAction } from "@/lib/actions/agents";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { AgentAvatar, AgentStatusBadge } from "@/components/AgentAvatar";
import { agentAvailability, effectiveAgentStatus } from "@/lib/agent-availability";
import { taskExecutionMeta } from "@/lib/agent-status";
import { freeLlmPolicyIssue, providerHealth } from "@/lib/providers";
import { WorkflowFlow } from "@/components/WorkflowFlow";
import { AiQueuePanel } from "@/components/AiQueuePanel";
import { activeWorkflow } from "@/lib/workflow";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const sp = await searchParams;

  // Retention is applied opportunistically, at most once per day.
  const deletion = getSetting<{ last_run_at: string | null }>("deletion", { last_run_at: null });
  if (!deletion.last_run_at || Date.now() - new Date(deletion.last_run_at).getTime() > 86400_000) {
    await cleanupExpiredDocuments(user.email);
  }

  const profile = getProfileData();
  const completeness = profileCompleteness(profile);
  const pipeline = jobPipeline();

  const jobTotals = {
    total: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0,
    analysed: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_score IS NOT NULL")?.c ?? 0,
    suitable: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag IN ('strong','possible')")?.c ?? 0,
    strong: one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs WHERE match_flag = 'strong'")?.c ?? 0,
  };
  const docTotals = {
    cv: one<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE kind = 'tailored_cv' AND deleted_at IS NULL")?.c ?? 0,
    cover: one<{ c: number }>("SELECT COUNT(*) AS c FROM documents WHERE kind = 'cover_letter' AND deleted_at IS NULL")?.c ?? 0,
  };
  const appTotals = {
    submitted: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received')")?.c ?? 0,
    awaiting: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'awaiting_approval'")?.c ?? 0,
    rejected: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'rejected'")?.c ?? 0,
    interviews: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('interview_invited','interview_completed')")?.c ?? 0,
    pending: one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status IN ('submitted','acknowledged')")?.c ?? 0,
  };

  const agents = all<{
    key: string;
    name: string;
    role: string;
    status: string;
    current_task: string | null;
    last_run_at: string | null;
    run_count: number;
    failure_count: number;
    ai_success_count: number;
    ai_failure_count: number;
    enabled: number;
  }>(
    "SELECT key, name, role, status, current_task, last_run_at, run_count, failure_count, ai_success_count, ai_failure_count, enabled FROM agents ORDER BY sort",
  );
  const activity = all<{ action: string; detail: string | null; created_at: string; actor: string | null }>(
    "SELECT action, detail, created_at, actor FROM audit_logs ORDER BY id DESC LIMIT 10",
  );
  const notifications = unreadNotifications(4);
  const topMatches = all<{ id: string; title: string; company: string; match_score: number; match_flag: string }>(
    "SELECT id, title, company, match_score, match_flag FROM jobs WHERE match_flag IN ('strong','possible') ORDER BY match_score DESC LIMIT 4",
  );
  const workflow = one<{ label: string; status: string; summary: string | null; finished_at: string | null }>(
    "SELECT label, status, summary, finished_at FROM workflows ORDER BY created_at DESC LIMIT 1",
  );
  const paused = agents.filter((a) => a.status === "paused").length;
  const active = activeWorkflow();
  const health = await providerHealth();
  const gateway = health.find((item) => item.name === "freellmapi");
  const ollama = health.find((item) => item.name === "ollama");
  const fallbackEnabled = (process.env.OLLAMA_ENABLED ?? "false") === "true" && Boolean(process.env.OLLAMA_MODEL);
  const policyIssue = freeLlmPolicyIssue();
  const lastAi = all<{ ai_outcome: string | null; provider: string | null; model: string | null; created_at: string }>(
    "SELECT ai_outcome, provider, model, created_at FROM tasks WHERE execution_mode = 'ai' ORDER BY created_at DESC LIMIT 1",
  )[0] ?? null;
  const lastTasks = all<{ agent_key: string; execution_mode: string | null; ai_outcome: string | null; provider: string | null; model: string | null }>(
    "SELECT agent_key, execution_mode, ai_outcome, provider, model FROM tasks ORDER BY created_at DESC LIMIT 80",
  );
  const lastExecution = new Map<string, { execution_mode: string | null; ai_outcome: string | null; provider: string | null; model: string | null }>();
  for (const task of lastTasks) if (!lastExecution.has(task.agent_key)) lastExecution.set(task.agent_key, task);
  const aiTotals = agents.reduce(
    (total, agent) => ({ ok: total.ok + agent.ai_success_count, failed: total.failed + agent.ai_failure_count }),
    { ok: 0, failed: 0 },
  );

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />

      <PageHead
        title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${user.name.split(" ")[0]}`}
        sub="Live recruitment operation: every figure below is read from your database, not a sample."
        actions={
          <>
            <form action={startWorkflowAction}>
              <input type="hidden" name="pages" value="2" />
              <SubmitButton pendingLabel="Queuing agents…" className="btn btn-primary">
                <Icon name="jobs" /> Start job search
              </SubmitButton>
            </form>
            <Link href="/assistant" className="btn">
              <Icon name="chat" /> AI assistant
            </Link>
          </>
        }
      />

      <section className="kpi-hero" aria-label="Primary recruitment metrics">
        <HeroStat
          href="/jobs#vacancies"
          label="Jobs discovered"
          value={jobTotals.total}
          note={`${pipeline.new} waiting for analysis`}
          icon="jobs"
          tone="cyan"
        />
        <HeroStat
          href="/jobs?flag=strong&sort=score#vacancies"
          label="Strong matches"
          value={jobTotals.strong}
          note={`${jobTotals.suitable} suitable across ${jobTotals.analysed} analysed`}
          icon="target"
          tone="accent"
        />
        <HeroStat
          href="/applications?group=interviews#applications"
          label="Interviews"
          value={appTotals.interviews}
          note="Invited or completed"
          icon="users"
          tone="violet"
        />
        <HeroStat
          href="/applications?status=awaiting_approval#applications"
          label="Awaiting approval"
          value={appTotals.awaiting}
          note={appTotals.awaiting ? "Review before anything is sent" : "Nothing needs your review"}
          icon="shield"
          tone="amber"
        />
      </section>

      <section className="stats stats-secondary mb-4" aria-label="Supporting recruitment metrics">
        <Stat href="/jobs?analysed=1&sort=score#vacancies" label="Jobs analysed" value={jobTotals.analysed} note={`${jobTotals.suitable} suitable`} />
        <Stat href="/documents?kind=tailored_cv#tailored-documents" label="CVs generated" value={docTotals.cv} note="Tailored per vacancy" />
        <Stat href="/documents?kind=cover_letter#tailored-documents" label="Cover letters" value={docTotals.cover} note="Generated" />
        <Stat href="/applications?group=sent#applications" label="Applications sent" value={appTotals.submitted} note="Confirmed submissions" tone="good" />
        <Stat href="/applications?group=pending#applications" label="Awaiting response" value={appTotals.pending} note="No reply yet" />
        <Stat href="/applications?status=rejected#applications" label="Rejected" value={appTotals.rejected} note="Employer decisions" tone={appTotals.rejected ? "bad" : undefined} />
        <Stat href="/profile" label="Profile complete" value={`${completeness}%`} note={completeness < 100 ? "Finish your profile" : "Verified profile"} tone={completeness >= 80 ? "good" : "warn"} />
      </section>

      {completeness < 60 || !profile.profile.email ? (
        <div className="alert alert-info mb-4">
          Your master profile is {completeness}% complete. {!profile.profile.email ? "Add an email address so generated documents carry contact details. " : ""}
          <Link href="/profile" style={{ textDecoration: "underline" }}>Complete your profile</Link> or{" "}
          <Link href="/documents#upload" style={{ textDecoration: "underline" }}>upload your original CV</Link>.
        </div>
      ) : null}

      <section className="card mb-4">
        <div className="card-head">
          <div>
            <h2>Recruitment pipeline</h2>
            <p className="card-sub">Vacancies and applications by stage, from real records.</p>
          </div>
          <Link href="/applications" className="btn btn-sm">Open tracker <Icon name="arrow" size={12} /></Link>
        </div>
        <div className="card-body">
          <div className="pipeline">
            {[
              ["New opportunities", pipeline.new],
              ["Under analysis", pipeline.analysing],
              ["Strong matches", jobTotals.strong],
              ["Documents prepared", pipeline.documents],
              ["Awaiting approval", pipeline.awaiting],
              ["Submitted", pipeline.submitted],
              ["Interview stage", pipeline.interview],
              ["Rejected", pipeline.rejected],
            ].map(([label, value]) => (
              <div key={String(label)} className="pipeline-step">
                <div className="n num">{value as number}</div>
                <div className="l">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <WorkflowFlow />

      <details className="card system-details mb-4" id="system-health">
        <summary className="system-details-summary">
          <span className="system-details-mark"><Icon name="settings" size={16} /></span>
          <span className="system-details-copy">
            <span className="system-details-title">System health &amp; AI gateway</span>
            <span className="system-details-sub">Inference route, queue telemetry and model policy. Kept out of the main workflow view.</span>
          </span>
          <span className={`badge ${gateway?.available ? "badge-good" : ollama?.available ? "badge-good" : gateway?.configured ? "badge-bad" : "badge-warn"}`}>
            {gateway?.available ? "primary connected" : ollama?.available ? "fallback ready" : gateway?.configured ? "unreachable" : "not configured"}
          </span>
          <span className="system-details-chevron" aria-hidden="true"><Icon name="chevron" size={15} /></span>
        </summary>
        <div className="system-details-body">
          <section className="card system-inner">
            <div className="card-head">
              <div>
                <h2>AI gateway</h2>
                <p className="card-sub">FreeLLMAPI is primary. Ollama is the local fallback for recoverable failures; configuration and auth errors fail closed.</p>
              </div>
              <span className={`badge ${gateway?.available ? "badge-good" : ollama?.available ? "badge-good" : gateway?.configured ? "badge-bad" : "badge-warn"}`}>
                {gateway?.available ? "primary connected" : ollama?.available ? "fallback ready" : gateway?.configured ? "unreachable" : "not configured"}
              </span>
            </div>
            <div className="card-body grid g2" style={{ gap: 12 }}>
              <div className="stack" style={{ gap: 6 }}>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Primary gateway</span><span>FreeLLMAPI</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Model policy</span><span className="num">{gateway?.model ?? "—"}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Latency</span><span className="num">{gateway?.latencyMs == null ? "—" : `${gateway.latencyMs} ms`}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Catalogue</span><span className="num">{gateway?.models.length ?? 0} models</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Fallback</span><span className={`badge ${fallbackEnabled ? "badge-good" : "badge-warn"}`}>{fallbackEnabled ? "Ollama enabled" : "disabled"}</span></div>
                <div className="between text-[12px]"><span style={{ color: "var(--muted)" }}>Fallback status</span><span>{ollama?.available ? `connected · ${ollama.model}` : ollama?.detail ?? "not checked"}</span></div>
              </div>
              <div className="stack" style={{ gap: 6 }}>
                <div className="between text-[12px]">
                  <span style={{ color: "var(--muted)" }}>Model policy</span>
                  <span className={`badge ${policyIssue ? "badge-bad" : "badge-good"}`}>{policyIssue ? "blocked" : "permitted"}</span>
                </div>
                <div className="between text-[12px]">
                  <span style={{ color: "var(--muted)" }}>Upstream pricing</span>
                  <span className="badge badge-warn">unverified</span>
                </div>
                <div className="between text-[12px]">
                  <span style={{ color: "var(--muted)" }}>Last AI attempt</span>
                  <span>{lastAi ? `${lastAi.ai_outcome === "ok" ? "succeeded" : "failed"} · ${lastAi.provider ?? "—"}` : "none yet"}</span>
                </div>
                <div className="text-[11.5px] leading-relaxed" style={{ color: gateway?.available || ollama?.available ? "var(--muted)" : "var(--danger)" }}>
                  {gateway?.detail ?? "No health result yet."}
                  {ollama && !gateway?.available ? ` Fallback: ${ollama.detail}` : ""}
                </div>
                {policyIssue ? <div className="text-[11px] leading-relaxed" style={{ color: "var(--danger)" }}>{policyIssue}</div> : null}
                <div className="text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
                  Fallback: {fallbackEnabled ? "Ollama local models for recoverable FreeLLMAPI failures" : "disabled"}; Gemini Live is voice-only. AI-backed task successes: {aiTotals.ok}
                  {aiTotals.failed ? ` · failed model calls: ${aiTotals.failed}` : ""}.
                </div>
              </div>
            </div>
          </section>
          <AiQueuePanel embedded />
        </div>
      </details>

      <div className="split mb-4">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Agent activity</h2>
              <p className="card-sub">
                {active
                  ? `Live workflow: ${active.label}`
                  : workflow
                    ? `No workflow is running · last run ${workflow.status} ${workflow.finished_at ? relativeTime(workflow.finished_at) : ""} (historical)`
                    : "No workflow has run yet"}
                {paused > 0 ? ` · ${paused} agent(s) paused` : ""}
              </p>
            </div>
            <div className="row">
              <form action={pauseAllAction}>
                <SubmitButton className="btn btn-sm" pendingLabel="Pausing…">Pause all</SubmitButton>
              </form>
              <form action={resumeAllAction}>
                <SubmitButton className="btn btn-sm" pendingLabel="Resuming…">Resume</SubmitButton>
              </form>
            </div>
          </div>
          <div className="card-body grid g2">
            {agents.map((agent) => {
              const availability = agentAvailability(agent.key);
              const displayStatus = effectiveAgentStatus(agent.status, agent.enabled === 1, availability);
              const exec = taskExecutionMeta(lastExecution.get(agent.key) ?? {});
              return (
                <div key={agent.key} className="agent-card">
                  <div className="between" style={{ alignItems: "flex-start", gap: 10 }}>
                    <div className="flex items-center gap-2.5">
                      <AgentAvatar agentKey={agent.key} status={displayStatus} />
                      <div>
                        <div className="name">{agent.name}</div>
                        <div className="text-[10px] uppercase tracking-[0.07em]" style={{ color: "var(--muted)" }}>{agent.role}</div>
                      </div>
                    </div>
                    <AgentStatusBadge status={displayStatus} enabled={agent.enabled === 1} />
                  </div>
                  <div className="desc">{agent.current_task ?? (displayStatus === "idle" ? "Idle — ready for a task" : agent.role)}</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className={`badge ${exec.tone}`} title={exec.detail} style={{ fontSize: 9.5 }}>
                      {exec.label}
                    </span>
                    {!active ? (
                      <span className="badge badge-neutral" title="No workflow is running; this is the last recorded state." style={{ fontSize: 9.5 }}>
                        historical
                      </span>
                    ) : null}
                  </div>
                  {!availability.available ? (
                    <div className="text-[10.5px] leading-relaxed" style={{ color: "var(--danger)" }}>
                      {availability.dependency}: {availability.reason}
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--muted)" }}>
                    <span>
                      {agent.run_count} tasks{agent.failure_count ? ` · ${agent.failure_count} failed` : ""} · AI calls {agent.ai_success_count} ok
                      {agent.ai_failure_count ? ` / ${agent.ai_failure_count} failed` : ""}
                    </span>
                    <span>{relativeTime(agent.last_run_at)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Recent activity</h2>
                <p className="card-sub">Audit trail across agents and documents.</p>
              </div>
              <Link href="/analytics" className="btn btn-ghost btn-sm">Reports</Link>
            </div>
            <div className="card-body">
              {activity.length === 0 ? (
                <Empty title="No activity yet">Run a job search or upload your CV to begin.</Empty>
              ) : (
                <div className="feed">
                  {activity.map((event, i) => (
                    <div key={i} className="feed-item">
                      <span className="feed-dot"><Icon name="logs" size={11} /></span>
                      <div>
                        <div className="feed-text">{event.detail ?? event.action.replace(/\./g, " ")}</div>
                        <div className="feed-time">{event.action.replace(/\./g, " · ")} · {relativeTime(event.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Notifications</h2>
                <p className="card-sub">Immediate events needing attention.</p>
              </div>
              <Link href="/settings#notifications" className="btn btn-ghost btn-sm">Configure</Link>
            </div>
            <div className="card-body">
              {notifications.length === 0 ? (
                <Empty title="Nothing unread" />
              ) : (
                <div className="feed">
                  {(notifications as Array<{ id: number; subject: string; body: string; created_at: string; channel: string }>).map((n) => (
                    <div key={n.id} className="feed-item">
                      <span className="feed-dot"><Icon name="mail" size={11} /></span>
                      <div>
                        <div className="feed-text">{n.subject}</div>
                        <div className="feed-time">{n.body.slice(0, 110)} · {relativeTime(n.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="split">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>Strongest open matches</h2>
              <p className="card-sub">Scored against your verified profile.</p>
            </div>
            <Link href="/jobs" className="btn btn-sm">All vacancies</Link>
          </div>
          <div className="card-body">
            {topMatches.length === 0 ? (
              <Empty title="No analysed matches yet">
                Start a job search. The research agent stores real vacancies, then the analysis agent scores them.
              </Empty>
            ) : (
              <table className="data">
                <thead>
                  <tr>
                    <th>Role</th>
                    <th>Match</th>
                    <th>Flag</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {topMatches.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <div className="cell-title">{job.title}</div>
                        <div className="cell-sub">{job.company}</div>
                      </td>
                      <td className="num">{job.match_score}%</td>
                      <td>
                        <span className={`badge ${job.match_flag === "strong" ? "badge-good" : "badge-info"}`}>{job.match_flag}</span>
                      </td>
                      <td className="text-right">
                        <Link href={`/jobs/${job.id}`} className="btn btn-sm">Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <h2>Quick actions</h2>
              <p className="card-sub">Every button performs a real operation.</p>
            </div>
          </div>
          <div className="card-body stack" style={{ gap: 8 }}>
            <form action={startWorkflowAction}>
              <input type="hidden" name="pages" value="2" />
              <SubmitButton className="btn w-full justify-start" pendingLabel="Queuing agents…">
                <Icon name="jobs" /> Start job search
              </SubmitButton>
            </form>
            <Link href="/documents#upload" className="btn justify-start"><Icon name="docs" /> Upload original CV</Link>
            <Link href="/applications" className="btn justify-start"><Icon name="applications" /> View applications</Link>
            <Link href="/assistant" className="btn justify-start"><Icon name="chat" /> Open AI assistant</Link>
            <Link href="/analytics#reports" className="btn justify-start"><Icon name="analytics" /> Generate daily report</Link>
            <div className="between card-quiet p-3">
              <div>
                <div className="text-[12.5px] font-semibold">Approval mode</div>
                <div className="text-[11px]" style={{ color: "var(--muted)" }}>
                  {getSetting<boolean>("approval_mode", true) ? "Each application needs your approval" : "Submissions may proceed without review"}
                </div>
              </div>
              <Link href="/settings#automation" className="btn btn-sm">Change</Link>
            </div>
          </div>
        </section>
      </div>

      <p className="mt-6 text-[11px] leading-relaxed" style={{ color: "var(--muted)" }}>
        Last data refresh {formatDateTime(new Date().toISOString())} · Database: local SQLite · Retention: {getSetting<number>("retention_days", 30)} days
        {getSetting<boolean>("auto_delete_expired", true) ? "" : " (automatic deletion disabled)"}. Job discovery uses the{" "}
        <a href="https://www.arbeitnow.com" target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Arbeitnow</a> public job board API.
      </p>
    </>
  );
}
