import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { all, one } from "@/lib/db";
import { getProfileData, profileCompleteness } from "@/lib/profile";
import { getSetting } from "@/lib/settings";
import { unreadNotifications } from "@/lib/notify";
import { cleanupExpiredDocuments } from "@/lib/retention";
import { PageHead, HeroStat, Stat, Empty, Flash } from "@/components/ui";
import { relativeTime, param } from "@/lib/format";
import { startAutonomousRecruitmentAction } from "@/lib/actions/recruitment";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/icons";
import { statusLabel, statusClass } from "@/lib/application-status";
import { boardColumnForRow } from "@/lib/application-board";
import { getDashboardSnapshot } from "@/lib/dashboard-live";
import { AgentCommandDashboard } from "@/components/AgentCommandDashboard";
import { outreachDashboard, outreachQualityForDraft, type OutreachAttachmentState } from "@/lib/outreach";

export const dynamic = "force-dynamic";

const APPLIED_STATUSES = "'submitted','acknowledged','interview','interview_invited','interview_completed','offer_received'";

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

  const activeOpportunities =
    one<{ c: number }>(
      `SELECT COUNT(*) AS c FROM jobs j
       WHERE j.match_flag IN ('strong','possible')
         AND NOT EXISTS (
           SELECT 1 FROM applications a WHERE a.job_id = j.id
             AND a.status IN (${APPLIED_STATUSES},'rejected','rejected_by_employer','withdrawn')
         )`,
    )?.c ?? 0;
  // Overview uses the same authoritative classification as the Applications
  // board, so its counts reconcile with the cards instead of drifting apart.
  const ownerApplications = all<{
    id: string;
    status: string;
    submitted_at: string | null;
    confirmation: string | null;
    last_update: string;
    title: string;
    company: string;
  }>(
    `SELECT a.id, a.status, a.submitted_at, a.confirmation, a.last_update, j.title, j.company
     FROM applications a JOIN jobs j ON j.id = a.job_id
     ORDER BY a.last_update DESC`,
  );
  const classifiedApplications = ownerApplications.map((row) => ({ ...row, column: boardColumnForRow(row) }));
  const submitted = classifiedApplications.filter((row) => row.column === "applied").length;
  const interviews = classifiedApplications.filter(
    (row) => row.column === "applied" && (row.status === "interview_invited" || row.status === "interview_completed"),
  ).length;
  const attentionRows = classifiedApplications.filter((row) => row.column === "needs_attention");
  const attentionCount = attentionRows.length;
  const openQuestions =
    one<{ c: number }>("SELECT COUNT(*) AS c FROM application_interventions WHERE status = 'open'")?.c ?? 0;

  const attention = attentionRows.slice(0, 4);
  const notifications = unreadNotifications(3) as Array<{ id: number; subject: string; body: string; created_at: string }>;

  // Only an administrator can act on system-level warnings, so owners never see a dead link.
  const failedToday =
    user.role === "admin"
      ? one<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE status = 'failed' AND created_at >= ?", [
          new Date(Date.now() - 86400_000).toISOString(),
        ])?.c ?? 0
      : 0;
  const pausedWorkflow =
    user.role === "admin"
      ? one<{ id: string; label: string }>("SELECT id, label FROM workflows WHERE status = 'paused' ORDER BY created_at DESC LIMIT 1")
      : null;

  // Live workforce projection: persisted roster, task ledger, provider usage
  // and the last actual health check. Unavailable measurements stay null.
  const workforce = getDashboardSnapshot();

  // Outreach is counted from the outreach ledger, never from a template. The
  // dashboard shows the same record the outreach inbox reads, so a draft can
  // never be presented here as a sent email.
  const outreach = outreachDashboard();
  const outreachPreview = outreach.drafts.slice(0, 3);
  const outreachQuality = new Map(
    outreach.drafts.map((draft) => [draft.id, outreachQualityForDraft(draft.id)] as const),
  );
  const outreachQualityFailures = [...outreachQuality.values()].filter((assessment) => assessment?.ok === false).length;
  const attachmentLabel = (state: OutreachAttachmentState): { className: string; label: string } =>
    state === "attached"
      ? { className: "badge badge-good", label: "Attached" }
      : state === "quality_failed"
        ? { className: "badge badge-bad", label: "Quality failed" }
        : state === "wrong_vacancy"
          ? { className: "badge badge-bad", label: "Wrong vacancy" }
          : { className: "badge badge-warn", label: "Missing" };

  return (
    <>
      <Flash ok={param(sp.ok)} error={param(sp.error)} saved={param(sp.saved)} />

      <PageHead
        title={`Good ${new Date().getHours() < 12 ? "morning" : new Date().getHours() < 18 ? "afternoon" : "evening"}, ${user.name.split(" ")[0]}`}
        sub="Your opportunities, confirmed submissions and the few things that need you."
        actions={
          <>
            <Link href="/capabilities" className="btn" data-testid="dashboard-capabilities">
              Capabilities
            </Link>
            <form action={startAutonomousRecruitmentAction}>
              <input type="hidden" name="return_to" value="/dashboard" />
              <SubmitButton pendingLabel="Starting run…" className="btn btn-primary">
                <Icon name="jobs" /> Start recruitment run
              </SubmitButton>
            </form>
          </>
        }
      />

      <section className="kpi-hero" aria-label="Primary recruitment metrics" data-visual-id="dashboard-metrics">
        <HeroStat
          href="/jobs?flag=strong&sort=score#vacancies"
          label="Active opportunities"
          value={activeOpportunities}
          note="Suitable vacancies not yet applied to"
          icon="target"
          tone="cyan"
        />
        <HeroStat
          href="/applications?column=applied#board"
          label="Applications submitted"
          value={submitted}
          note="Employer-confirmed only"
          icon="applications"
          tone="accent"
        />
        <HeroStat
          href="/applications?status=interview_invited#board"
          label="Interviews"
          value={interviews}
          note="Invited or completed"
          icon="users"
          tone="violet"
        />
        <HeroStat
          href="/applications?column=needs_attention#board"
          label="Needs attention"
          value={attentionCount}
          note={attentionCount ? "Blocked or unverified" : "Nothing needs your review"}
          icon="shield"
          tone="amber"
        />
      </section>

      <section className="card mb-4" data-testid="dashboard-outreach-card" data-visual-id="dashboard-outreach">
        <div className="card-head">
          <div>
            <h2>Hiring Manager Outreach</h2>
            <p className="card-sub">
              Prepared Gmail drafts and verified employer contacts from the outreach ledger. A prepared draft is not a sent email: a draft moves
              to <strong>Sent</strong> only when a sent copy is observed in the connected mailbox.
            </p>
          </div>
          <div className="row gap-2">
            {outreachQualityFailures > 0 ? (
              <Link
                href="/outreach?quality=failed"
                className="badge badge-bad"
                data-testid="dashboard-outreach-quality-failed"
                title="Only drafts whose deterministic quality check failed"
              >
                {outreachQualityFailures} with a failed quality check
              </Link>
            ) : null}
            <Link href="/outreach" className="btn btn-sm btn-primary" data-testid="dashboard-outreach-open">
              View prepared emails
            </Link>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <section className="stats" aria-label="Outreach counters">
            <Stat label="Prepared email drafts" value={outreach.counters.draftsPrepared} href="/outreach" />
            <Stat
              label="Verified employer contacts"
              value={outreach.counters.verifiedContacts}
              tone={outreach.counters.verifiedContacts ? "good" : undefined}
              href="/outreach"
            />
            <Stat
              label="Drafts awaiting review"
              value={outreach.counters.awaitingReview}
              tone={outreach.counters.awaitingReview ? "warn" : undefined}
              href="/outreach"
            />
            <Stat
              label="Emails actually sent by you"
              value={outreach.counters.emailsSent}
              tone={outreach.counters.emailsSent ? "good" : undefined}
              href="/outreach"
            />
            <Stat label="Employer replies received" value={outreach.counters.repliesReceived} href="/outreach" />
            <Stat
              label="Drafts requiring intervention"
              value={outreach.counters.needsIntervention}
              tone={outreach.counters.needsIntervention ? "bad" : undefined}
              href="/outreach"
            />
          </section>

          {outreachPreview.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--muted)" }} data-testid="dashboard-outreach-empty">
              No outreach draft is stored yet, so every counter is zero. A draft is created only when a verified employer-associated address and a
              validated CV plus cover letter exist for a qualified vacancy. Nothing is invented to fill this card.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data responsive-cards" data-testid="dashboard-outreach-drafts">
                <thead>
                  <tr>
                    <th>Employer &amp; role</th>
                    <th>Recipient</th>
                    <th>Attachments</th>
                    <th>Email state</th>
                    <th>Quality</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {outreachPreview.map((draft) => {
                    const cv = attachmentLabel(draft.cv.state);
                    const cover = attachmentLabel(draft.cover.state);
                    const quality = outreachQuality.get(draft.id) ?? null;
                    return (
                      <tr key={draft.id}>
                        <td data-label="Employer & role">
                          <Link href={`/outreach/${draft.id}`} className="cell-title">{draft.company}</Link>
                          <div className="cell-sub">{draft.jobTitle}</div>
                        </td>
                        <td data-label="Recipient">
                          <div className="cell-title">{draft.contactName}</div>
                          <div className="cell-sub num">{draft.recipient}</div>
                        </td>
                        <td data-label="Attachments">
                          <div className="flex flex-wrap gap-1">
                            <span className={cv.className}>CV · {cv.label}</span>
                            <span className={cover.className}>Cover · {cover.label}</span>
                          </div>
                        </td>
                        <td data-label="Email state">
                          <span className={`badge ${draft.status === "sent" ? "badge-good" : draft.status === "draft_created" ? "badge-info" : "badge-warn"}`}>
                            {draft.status === "sent" ? "Sent by owner" : draft.status === "draft_created" ? "Draft — not sent" : draft.status === "draft_missing" ? "Draft missing" : draft.status === "failed" ? "Draft failed" : "Pending"}
                          </span>
                        </td>
                        <td data-label="Quality">
                          {quality ? (
                            <span
                              className={`badge ${quality.ok ? "badge-good" : "badge-bad"}`}
                              title={quality.summary}
                            >
                              {quality.ok ? `Passed · ${quality.wordCount} words` : "Check failed — not ready to review"}
                            </span>
                          ) : (
                            <span className="badge badge-neutral">Not assessed</span>
                          )}
                        </td>
                        <td data-label="Actions" className="text-right">
                          <Link href={`/outreach/${draft.id}`} className="btn btn-sm">Open and review</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="hint">
            Counts come from <code>outreach_drafts</code>, <code>outreach_contacts</code> and the matched mailbox messages. Drafted, sent and
            replied are separate states, and no draft is counted as sent.
          </p>
        </div>
      </section>

      <AgentCommandDashboard initialSnapshot={workforce} />

      {completeness < 100 || !profile.profile.email ? (
        <div className="alert alert-info mb-4">
          Your profile is {completeness}% complete. {!profile.profile.email ? "Add an email address so generated documents carry contact details. " : ""}
          <Link href="/profile" style={{ textDecoration: "underline" }}>Finish your profile</Link>.
        </div>
      ) : null}

      {attention.length > 0 ? (
        <section className="card mb-4" data-visual-id="attention-required">
          <div className="card-head">
            <div>
              <h2>Needs your attention</h2>
              <p className="card-sub">
                {attentionCount} blocked or unverified {attentionCount === 1 ? "application" : "applications"}
                {openQuestions ? ` · ${openQuestions} open question${openQuestions === 1 ? "" : "s"}` : ""}. Each one links to the exact blocker.
              </p>
            </div>
            <Link href="/applications?column=needs_attention#board" className="btn btn-sm">Open board</Link>
          </div>
          <div className="card-body">
            <table className="data responsive-cards">
              <thead>
                <tr><th>Vacancy</th><th>Status</th><th>Last update</th><th aria-label="Open" /></tr>
              </thead>
              <tbody>
                {attention.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Vacancy">
                      <Link className="cell-title" href={`/applications/${row.id}`}>{row.title}</Link>
                      <div className="cell-sub">{row.company}</div>
                    </td>
                    <td data-label="Status"><span className={`badge ${statusClass(row.status)}`}>{statusLabel(row.status)}</span></td>
                    <td data-label="Last update" className="cell-sub">{relativeTime(row.last_update)}</td>
                    <td data-label="Open" className="text-right"><Link href={`/applications/${row.id}`} className="btn btn-sm">Resolve</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {notifications.length > 0 ? (
        <section className="card mb-4">
          <div className="card-head">
            <div>
              <h2>Unread notifications</h2>
              <p className="card-sub">Immediate events that may need a decision.</p>
            </div>
            <Link href="/settings#notifications" className="btn btn-ghost btn-sm">Notification settings</Link>
          </div>
          <div className="card-body">
            <div className="feed">
              {notifications.map((notification) => (
                <div key={notification.id} className="feed-item">
                  <span className="feed-dot"><Icon name="mail" size={11} /></span>
                  <div>
                    <div className="feed-text">{notification.subject}</div>
                    <div className="feed-time">{notification.body.slice(0, 130)} · {relativeTime(notification.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {user.role === "admin" && (failedToday > 0 || pausedWorkflow) ? (
        <div className="alert alert-warn mb-4">
          <Icon name="shield" size={14} />{" "}
          {failedToday > 0 ? `${failedToday} task${failedToday === 1 ? "" : "s"} failed in the last 24 hours. ` : ""}
          {pausedWorkflow ? `Workflow “${pausedWorkflow.label}” is paused. ` : ""}
          <Link href="/admin/diagnostics" style={{ textDecoration: "underline" }}>Open Admin diagnostics</Link>.
        </div>
      ) : null}

      {attention.length === 0 && notifications.length === 0 ? (
        <Empty title="You are up to date">
          Suitable vacancies are being prepared automatically. Confirmed submissions, interviews and genuine blockers will appear here.
        </Empty>
      ) : null}
    </>
  );
}
