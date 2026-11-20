import { all, one } from "./db";
import { statusLabel } from "./application-status";
import { buildExecutionManifest, type ExecutionManifest, type ExecutionAgent } from "./execution-manifest";
import { getSetting } from "./settings";
import { getRecruitmentPolicy, startOfRecruitmentDay, type RecruitmentPolicy } from "./recruitment-policy";
import { publicAppBaseUrl } from "./app-url";
import { agentIdentity, agentSignature } from "./agent-identity";
import {
  formatInZone,
  localDateKey,
  zonedParts,
  zonedTimeToUtc,
  RECRUITMENT_TIMEZONE,
} from "./recruitment-schedule";

/**
 * Branded recruitment activity email.
 *
 * Every number in the report is read from persisted SQLite rows for the
 * Europe/Zurich calendar day. A prepared package is not a submission, an
 * unverified attempt is not a success, and an employer confirmation is only
 * listed when an actual acknowledgement email was recorded.
 */

export type EmailContent = {
  subject: string;
  html: string;
  text: string;
};

export type RecruitmentReportPeriod = {
  start: string;
  end: string;
  key: string;
  label: string;
};

type Count = { n: number };

type SubmissionRow = {
  id: string;
  application_id: string;
  channel: string;
  reference: string | null;
  attempted_at: string;
  evidence: string | null;
  app_status: string;
  confirmation: string | null;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  application_url: string | null;
};

type ConfirmationRow = {
  id: string;
  application_id: string;
  subject: string;
  sender: string | null;
  received_at: string;
  title: string;
  company: string;
};

type ApplicationRow = {
  id: string;
  status: string;
  submission_status: string | null;
  last_update: string;
  submitted_at: string | null;
  title: string;
  company: string;
  location: string | null;
};

type TaskRow = {
  id: string;
  agent_key: string;
  title: string;
  status: string;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

type FailedSubmissionRow = {
  id: string;
  application_id: string;
  status: string;
  channel: string;
  http_status: number | null;
  error: string | null;
  attempted_at: string;
  title: string;
  company: string;
};

type AgentRow = {
  key: string;
  name: string;
  role: string;
  status: string;
  current_task: string | null;
};

type AgentActivity = AgentRow & {
  completed: number;
  failed: number;
  open: number;
  latestError: string | null;
  latestTask: string | null;
};

type ReportData = {
  period: RecruitmentReportPeriod;
  generatedAt: string;
  counts: {
    discovered: number;
    analysed: number;
    suitable: number;
    documents: number;
    submitted: number;
    confirmations: number;
    pending: number;
    failed: number;
  };
  submissions: SubmissionRow[];
  confirmations: ConfirmationRow[];
  atsConfirmations: SubmissionRow[];
  pendingApplications: ApplicationRow[];
  awaitingResponse: ApplicationRow[];
  pendingTasks: TaskRow[];
  failedTasks: TaskRow[];
  failedSubmissions: FailedSubmissionRow[];
  failedRuns: Array<{ id: string; run_key: string; error: string | null; finished_at: string | null }>;
  interventions: number;
  legacyUnverified: number;
  agents: AgentActivity[];
  policy: RecruitmentPolicy;
  dryRun: boolean;
  nextRunAt: string | null;
};

function count(sql: string, params: unknown[] = []): number {
  return Number(one<Count>(sql, params)?.n ?? 0);
}

export function recruitmentReportPeriod(now: Date = new Date()): RecruitmentReportPeriod {
  const start = startOfRecruitmentDay(now);
  const parts = zonedParts(start);
  const end = zonedTimeToUtc(parts.year, parts.month, parts.day + 1, 0, 0);
  const label = new Intl.DateTimeFormat("en-GB", {
    timeZone: RECRUITMENT_TIMEZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(start);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    key: localDateKey(now),
    label,
  };
}

function agentActivity(period: RecruitmentReportPeriod): AgentActivity[] {
  const agents = all<AgentRow>(
    "SELECT key, name, role, status, current_task FROM agents ORDER BY sort, key",
  );
  const tasks = all<TaskRow>(
    `SELECT id, agent_key, title, status, error, created_at, finished_at
     FROM tasks WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC`,
    [period.start, period.end],
  );
  return agents.map((agent) => {
    const rows = tasks.filter((task) => task.agent_key === agent.key);
    const failed = rows.filter((task) => task.status === "failed");
    const identity = agentIdentity(agent.key);
    return {
      ...agent,
      name: identity.name,
      role: identity.title,
      completed: rows.filter((task) => task.status === "completed").length,
      failed: failed.length,
      open: rows.filter((task) => !["completed", "failed", "cancelled"].includes(task.status)).length,
      latestError: failed[0]?.error ?? null,
      latestTask: rows[0]?.title ?? null,
    };
  });
}

function collectReport(now: Date): ReportData {
  const period = recruitmentReportPeriod(now);
  const params = [period.start, period.end];
  const discovered = count(
    "SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ? AND discovered_at < ?",
    params,
  );
  const analysed = count(
    "SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ? AND discovered_at < ? AND match_score IS NOT NULL",
    params,
  );
  const suitable = count(
    "SELECT COUNT(*) AS n FROM jobs WHERE discovered_at >= ? AND discovered_at < ? AND qualified = 1",
    params,
  );
  const documents = count(
    `SELECT COUNT(*) AS n FROM documents
     WHERE created_at >= ? AND created_at < ? AND kind IN ('tailored_cv','cover_letter')`,
    params,
  );

  const rawSubmissions = all<SubmissionRow>(
    `SELECT sa.id, sa.application_id, sa.channel, sa.reference, sa.attempted_at, sa.evidence,
            a.status AS app_status, a.confirmation, j.title, j.company, j.location, j.url, j.application_url
     FROM submission_attempts sa
     JOIN applications a ON a.id = sa.application_id
     JOIN jobs j ON j.id = sa.job_id
     WHERE sa.status = 'verified' AND sa.attempted_at >= ? AND sa.attempted_at < ?
     ORDER BY sa.attempted_at ASC`,
    params,
  );
  const seen = new Set<string>();
  const submissions = rawSubmissions.filter((row) => {
    if (seen.has(row.application_id)) return false;
    seen.add(row.application_id);
    return true;
  });
  const confirmations = all<ConfirmationRow>(
    `SELECT em.id, em.application_id, em.subject, em.sender, em.received_at,
            j.title, j.company
     FROM email_messages em
     JOIN applications a ON a.id = em.application_id
     JOIN jobs j ON j.id = a.job_id
     WHERE em.category = 'acknowledgement'
       AND em.application_id IS NOT NULL
       AND em.received_at >= ? AND em.received_at < ?
     ORDER BY em.received_at DESC`,
    params,
  );
  const atsConfirmations = submissions.filter((row) => Boolean(row.reference));

  const pendingApplications = all<ApplicationRow>(
    `SELECT a.id, a.status, a.submission_status, a.last_update, a.submitted_at,
            j.title, j.company, j.location
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status NOT IN (
       'submitted','acknowledged','interview','interview_invited','interview_completed',
       'offer_received','rejected','rejected_by_employer','withdrawn','submission_failed',
       'rejected_ineligible','rejected_below_threshold'
     )
     ORDER BY a.last_update DESC LIMIT 50`,
  );
  const awaitingResponse = all<ApplicationRow>(
    `SELECT a.id, a.status, a.submission_status, a.last_update, a.submitted_at,
            j.title, j.company, j.location
     FROM applications a JOIN jobs j ON j.id = a.job_id
     WHERE a.status IN ('submitted','acknowledged')
       AND NOT EXISTS (
         SELECT 1 FROM email_messages em
         WHERE em.application_id = a.id AND em.category = 'acknowledgement'
       )
     ORDER BY a.submitted_at DESC LIMIT 50`,
  );
  const pendingTasks = all<TaskRow>(
    `SELECT id, agent_key, title, status, error, created_at, finished_at
     FROM tasks WHERE status NOT IN ('completed','failed','cancelled')
     ORDER BY created_at ASC LIMIT 50`,
  );
  const failedTasks = all<TaskRow>(
    `SELECT id, agent_key, title, status, error, created_at, finished_at
     FROM tasks
     WHERE status = 'failed' AND COALESCE(finished_at, created_at) >= ? AND COALESCE(finished_at, created_at) < ?
     ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 50`,
    params,
  );
  const failedSubmissions = all<FailedSubmissionRow>(
    `SELECT sa.id, sa.application_id, sa.status, sa.channel, sa.http_status, sa.error, sa.attempted_at,
            j.title, j.company
     FROM submission_attempts sa
     JOIN applications a ON a.id = sa.application_id
     JOIN jobs j ON j.id = sa.job_id
     WHERE sa.status IN ('failed','unverified')
       AND sa.attempted_at >= ? AND sa.attempted_at < ?
     ORDER BY sa.attempted_at DESC LIMIT 50`,
    params,
  );
  const failedRuns = all<{ id: string; run_key: string; error: string | null; finished_at: string | null }>(
    `SELECT id, run_key, error, finished_at FROM recruitment_runs
     WHERE status = 'failed' AND COALESCE(finished_at, created_at) >= ? AND COALESCE(finished_at, created_at) < ?
     ORDER BY COALESCE(finished_at, created_at) DESC LIMIT 20`,
    params,
  );
  const interventions = count(
    "SELECT COUNT(*) AS n FROM application_interventions WHERE status = 'open'",
  );
  const legacyUnverified = count(
    `SELECT COUNT(*) AS n FROM applications a
     WHERE a.status IN ('submitted','acknowledged')
       AND NOT EXISTS (
         SELECT 1 FROM submission_attempts sa
         WHERE sa.application_id = a.id AND sa.status = 'verified'
       )`,
  );
  const schedule = one<{ next_run_at: string | null }>(
    "SELECT next_run_at FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );

  return {
    period,
    generatedAt: now.toISOString(),
    counts: {
      discovered,
      analysed,
      suitable,
      documents,
      submitted: submissions.length,
      confirmations: confirmations.length,
      pending: pendingApplications.length + pendingTasks.length,
      failed: failedTasks.length + failedSubmissions.length + failedRuns.length,
    },
    submissions,
    confirmations,
    atsConfirmations,
    pendingApplications,
    awaitingResponse,
    pendingTasks,
    failedTasks,
    failedSubmissions,
    failedRuns,
    interventions,
    legacyUnverified,
    agents: agentActivity(period),
    policy: getRecruitmentPolicy(),
    dryRun: getSetting<boolean>("recruitment_dry_run", true),
    nextRunAt: schedule?.next_run_at ?? null,
  };
}

function channelLabel(channel: string): string {
  const labels: Record<string, string> = {
    http_form: "Configured HTTP form",
    candidate_form: "Employer candidate form",
    greenhouse: "Greenhouse ATS",
    lever: "Lever ATS",
    ashby: "Ashby ATS",
    manual: "Manual employer portal",
    email_confirmation: "Employer email confirmation",
  };
  return labels[channel] ?? statusLabel(channel);
}

function taskAgentLabel(task: { agent_key: string }): string {
  const identity = agentIdentity(task.agent_key);
  return `${identity.name} (${task.agent_key})`;
}

function submissionEvidence(row: SubmissionRow): string {
  if (row.reference) return `Employer reference: ${row.reference}`;
  return "No reference captured; treated as unverified unless an acknowledgement email exists.";
}

function confirmationStatus(row: SubmissionRow, confirmations: ConfirmationRow[]): string {
  return confirmations.some((item) => item.application_id === row.application_id)
    ? "Employer email confirmation recorded"
    : "Awaiting employer confirmation";
}

function nextActions(data: ReportData): string[] {
  const actions: string[] = [];
  if (!data.policy.active) {
    actions.push(
      "Automatic submission is paused. No application will be sent until the standing authorisation is explicitly reactivated.",
    );
  } else if (data.dryRun) {
    actions.push("A dry run is enabled. Packages can be prepared, but no employer will be contacted.");
  }
  if (data.interventions > 0) {
    actions.push(`${data.interventions} essential question(s) need your answer before a form can be completed.`);
  }
  const ready = data.pendingApplications.filter((app) => app.status === "ready_to_submit");
  if (ready.length > 0) {
    actions.push(`${ready.length} package(s) are ready for review or the next authorised submission step.`);
  }
  const review = data.pendingApplications.filter((app) =>
    ["quality_review_required", "human_intervention_required", "awaiting_approval", "approval_required"].includes(app.status),
  );
  if (review.length > 0) {
    actions.push(`${review.length} package(s) need document, approval or eligibility review.`);
  }
  if (data.awaitingResponse.length > 0) {
    actions.push(`${data.awaitingResponse.length} submitted application(s) are awaiting an employer response.`);
  }
  if (data.failedSubmissions.some((row) => row.status === "unverified")) {
    actions.push("An unverified submission is present. Confirm it with the employer or ATS; it will not be retried blindly.");
  }
  if (data.counts.failed > 0) {
    actions.push("Review failed tasks and submissions before the next run; only safe retries are allowed.");
  }
  actions.push(
    data.nextRunAt
      ? `Next scheduled recruitment run: ${formatInZone(data.nextRunAt)} (${RECRUITMENT_TIMEZONE}). The Mac and this application must be running at that time.`
      : "The next scheduled recruitment run is not available. Check the recruitment schedule.",
  );
  return actions;
}

function renderText(data: ReportData): string {
  const lines: string[] = [];
  lines.push("AT AI WORKFORCE");
  lines.push("Your Recruitment Activity Report");
  lines.push(`${data.period.label} · ${RECRUITMENT_TIMEZONE}`);
  lines.push("");
  lines.push("1. Executive summary");
  lines.push(`Jobs discovered: ${data.counts.discovered}`);
  lines.push(`Jobs analysed: ${data.counts.analysed}`);
  lines.push(`Suitable matches: ${data.counts.suitable}`);
  lines.push(`Documents generated: ${data.counts.documents}`);
  lines.push(`Applications successfully submitted: ${data.counts.submitted}`);
  lines.push(`Employer confirmations received: ${data.counts.confirmations}`);
  lines.push(`Pending work items: ${data.counts.pending}`);
  lines.push(`Failed tasks: ${data.counts.failed}`);
  if (data.legacyUnverified > 0) {
    lines.push(
      `Data note: ${data.legacyUnverified} legacy application(s) are marked submitted or acknowledged without a verified submission attempt. They are excluded from the submitted count.`,
    );
  }
  lines.push("");
  lines.push("2. Successfully submitted applications");
  if (data.submissions.length === 0) {
    lines.push("No application was submitted with recorded employer evidence in this period.");
  } else {
    for (const row of data.submissions) {
      lines.push(`- ${row.company} — ${row.title}`);
      lines.push(`  Location: ${row.location ?? "Not recorded"}`);
      lines.push(`  Submission date: ${formatInZone(row.attempted_at)}`);
      lines.push(`  Submission method: ${channelLabel(row.channel)}`);
      lines.push(`  Submission evidence: ${submissionEvidence(row)}`);
      lines.push(`  Confirmation status: ${confirmationStatus(row, data.confirmations)}`);
    }
  }
  lines.push("");
  lines.push("3. Employer confirmations");
  if (data.confirmations.length === 0 && data.atsConfirmations.length === 0) {
    lines.push("No employer confirmation email or ATS confirmation was recorded in this period.");
  }
  for (const row of data.confirmations) {
    lines.push(`- Employer email: ${row.company} — ${row.title} · ${formatInZone(row.received_at)} · ${row.subject}`);
  }
  for (const row of data.atsConfirmations) {
    lines.push(`- ATS/endpoint receipt: ${row.company} — ${row.title} · ${row.reference ?? "reference recorded"}`);
  }
  lines.push("");
  lines.push("4. Pending work");
  if (data.pendingApplications.length === 0 && data.pendingTasks.length === 0) {
    lines.push("No pending application or task was recorded.");
  }
  for (const app of data.pendingApplications) {
    lines.push(`- ${app.company} — ${app.title}: ${statusLabel(app.status)} (updated ${formatInZone(app.last_update)})`);
  }
  for (const task of data.pendingTasks) {
    lines.push(`- Task: ${taskAgentLabel(task)} · ${task.title} · ${statusLabel(task.status)}`);
  }
  for (const app of data.awaitingResponse) {
    lines.push(`- Awaiting employer response: ${app.company} — ${app.title}`);
  }
  lines.push("");
  lines.push("5. Failed tasks");
  if (data.failedTasks.length === 0 && data.failedSubmissions.length === 0 && data.failedRuns.length === 0) {
    lines.push("No failed task, submission attempt or recruitment run was recorded in this period.");
  }
  for (const task of data.failedTasks) {
    lines.push(`- ${taskAgentLabel(task)} · ${task.title}: ${task.error ?? "No error detail recorded."} Safe retry requires review.`);
  }
  for (const row of data.failedSubmissions) {
    const retry =
      row.status === "unverified"
        ? "No blind retry; confirm with the employer or ATS first."
        : "Review the stored error before any retry.";
    lines.push(
      `- ${row.company} — ${row.title}: ${statusLabel(row.status)} via ${channelLabel(row.channel)}. ${row.error ?? "No error detail recorded."} ${retry}`,
    );
  }
  for (const run of data.failedRuns) {
    lines.push(`- Recruitment run ${run.run_key}: ${run.error ?? "No error detail recorded."}`);
  }
  lines.push("");
  lines.push("6. Agent activity");
  for (const agent of data.agents) {
    lines.push(
      `- ${agent.name} (${agent.role}): ${agent.completed} completed, ${agent.failed} failed, ${agent.open} open in this period. Current state: ${statusLabel(agent.status)}.`,
    );
    if (agent.current_task) lines.push(`  Current task: ${agent.current_task}`);
    if (agent.latestError) lines.push(`  Needs attention: ${agent.latestError}`);
  }
  lines.push("");
  lines.push("7. Next actions");
  for (const action of nextActions(data)) lines.push(`- ${action}`);
  lines.push("");
  lines.push("Best regards,");
  for (const line of agentSignature("coordinator")) lines.push(line);
  lines.push("Autonomous Recruitment & Workforce Operations");
  lines.push("Automated report from AT AI Workforce.");
  lines.push(`Generated ${data.generatedAt}. Counts are from persisted records for ${data.period.label}.`);
  lines.push("No employer confirmation is claimed unless it was actually recorded.");
  return lines.join("\n");
}

/* --------------------------------- HTML ---------------------------------- */

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function p(value: unknown, style = "margin:0;color:#33465a;font-size:14px;line-height:1.6;"): string {
  return `<p style="${style}">${escapeHtml(value)}</p>`;
}

function statCell(label: string, value: number, tone = "#0d6fa8"): string {
  return `<td class="stat-cell" width="25%" style="padding:6px;vertical-align:top;">
    <div style="background:#f5f8fc;border:1px solid #dfe8f1;border-top:3px solid ${tone};border-radius:8px;padding:14px 12px;">
      <div style="font-size:11px;line-height:1.3;color:#5b6b7c;text-transform:uppercase;letter-spacing:.08em;">${escapeHtml(label)}</div>
      <div style="margin-top:6px;font-size:26px;line-height:1.1;font-weight:700;color:#0a2540;">${escapeHtml(value)}</div>
    </div>
  </td>`;
}

function sectionHeading(number: string, title: string, subtitle?: string): string {
  return `<div style="margin:0 0 12px;">
    <div style="font-size:11px;line-height:1.3;font-weight:700;letter-spacing:.12em;color:#0d6fa8;text-transform:uppercase;">${escapeHtml(number)}</div>
    <h2 style="margin:4px 0 0;font-size:19px;line-height:1.3;color:#0a2540;">${escapeHtml(title)}</h2>
    ${subtitle ? `<p style="margin:4px 0 0;font-size:13px;line-height:1.5;color:#5b6b7c;">${escapeHtml(subtitle)}</p>` : ""}
  </div>`;
}

function emptyState(message: string): string {
  return `<div style="border:1px dashed #cdd9e5;border-radius:8px;background:#f8fafc;padding:14px 16px;color:#5b6b7c;font-size:13px;line-height:1.5;">${escapeHtml(message)}</div>`;
}

function card(input: {
  title: string;
  subtitle?: string;
  tone?: string;
  rows: Array<[string, string]>;
}): string {
  const tone = input.tone ?? "#0d6fa8";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px;border:1px solid #dfe8f1;border-left:4px solid ${tone};border-radius:8px;background:#ffffff;">
    <tr><td style="padding:14px 16px;">
      <div style="font-size:15px;line-height:1.4;font-weight:700;color:#0a2540;">${escapeHtml(input.title)}</div>
      ${input.subtitle ? `<div style="margin-top:2px;font-size:12px;line-height:1.4;color:#5b6b7c;">${escapeHtml(input.subtitle)}</div>` : ""}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
        ${input.rows
          .map(
            ([label, value]) => `<tr>
              <td style="padding:3px 10px 3px 0;font-size:12px;line-height:1.5;color:#5b6b7c;width:32%;vertical-align:top;">${escapeHtml(label)}</td>
              <td style="padding:3px 0;font-size:12px;line-height:1.5;color:#1f3347;vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td>
            </tr>`,
          )
          .join("")}
      </table>
    </td></tr>
  </table>`;
}

function list(items: string[], empty: string): string {
  if (items.length === 0) return emptyState(empty);
  return `<ul style="margin:0;padding:0 0 0 18px;color:#33465a;font-size:13px;line-height:1.65;">${items
    .map((item) => `<li style="margin:0 0 5px;">${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}

function agentTable(data: ReportData): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:12px;line-height:1.5;">
    <tr style="background:#eef4fa;">
      <th align="left" style="padding:9px 10px;border-bottom:1px solid #d8e3ee;color:#0a2540;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Agent</th>
      <th align="left" style="padding:9px 10px;border-bottom:1px solid #d8e3ee;color:#0a2540;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Done</th>
      <th align="left" style="padding:9px 10px;border-bottom:1px solid #d8e3ee;color:#0a2540;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Open</th>
      <th align="left" style="padding:9px 10px;border-bottom:1px solid #d8e3ee;color:#0a2540;font-size:11px;text-transform:uppercase;letter-spacing:.06em;">Needs attention</th>
    </tr>
    ${data.agents
      .map(
        (agent) => `<tr>
          <td style="padding:10px;border-bottom:1px solid #edf2f7;vertical-align:top;">
            <div style="font-weight:700;color:#1f3347;">${escapeHtml(agent.name)}</div>
            <div style="color:#5b6b7c;font-size:11px;">${escapeHtml(agent.role)} · ${escapeHtml(statusLabel(agent.status))}</div>
          </td>
          <td style="padding:10px;border-bottom:1px solid #edf2f7;vertical-align:top;color:#1f3347;">${escapeHtml(agent.completed)}</td>
          <td style="padding:10px;border-bottom:1px solid #edf2f7;vertical-align:top;color:#1f3347;">${escapeHtml(agent.open)}</td>
          <td style="padding:10px;border-bottom:1px solid #edf2f7;vertical-align:top;color:${agent.failed || agent.latestError ? "#b42318" : "#5b6b7c"};">${escapeHtml(
            agent.latestError ?? (agent.failed ? `${agent.failed} failed task(s)` : "None"),
          )}</td>
        </tr>`,
      )
      .join("")}
  </table>`;
}

function renderHtml(data: ReportData): string {
  const [chiefName, chiefTitle, chiefCompany] = agentSignature("coordinator");
  const submittedCards =
    data.submissions.length === 0
      ? emptyState("No application was submitted with recorded employer evidence in this period.")
      : data.submissions
          .map((row) =>
            card({
              title: `${row.company} — ${row.title}`,
              subtitle: row.location ?? "Location not recorded",
              tone: "#1f7a4d",
              rows: [
                ["Submission date", formatInZone(row.attempted_at)],
                ["Submission method", channelLabel(row.channel)],
                ["Submission evidence", submissionEvidence(row)],
                ["Confirmation status", confirmationStatus(row, data.confirmations)],
              ],
            }),
          )
          .join("");

  const confirmationCards =
    data.confirmations.length === 0 && data.atsConfirmations.length === 0
      ? emptyState("No employer confirmation email or ATS confirmation was recorded in this period.")
      : data.confirmations
          .map((row) =>
            card({
              title: `${row.company} — ${row.title}`,
              subtitle: "Employer email confirmation",
              tone: "#1f7a4d",
              rows: [
                ["Received", formatInZone(row.received_at)],
                ["Subject", row.subject],
                ["Sender", row.sender ?? "Not recorded"],
              ],
            }),
          )
          .join("") +
        data.atsConfirmations
          .map((row) =>
            card({
              title: `${row.company} — ${row.title}`,
              subtitle: "ATS / endpoint receipt",
              tone: "#0d6fa8",
              rows: [
                ["Recorded", formatInZone(row.attempted_at)],
                ["Reference", row.reference ?? "Reference recorded"],
                ["Channel", channelLabel(row.channel)],
              ],
            }),
          )
          .join("");

  const pendingItems = [
    ...data.pendingApplications.map(
      (app) => `${app.company} — ${app.title}: ${statusLabel(app.status)} (updated ${formatInZone(app.last_update)})`,
    ),
    ...data.pendingTasks.map((task) => `${taskAgentLabel(task)}: ${task.title} — ${statusLabel(task.status)}`),
    ...data.awaitingResponse.map((app) => `Awaiting employer response: ${app.company} — ${app.title}`),
  ];
  const failedItems = [
    ...data.failedTasks.map(
      (task) => `${taskAgentLabel(task)} · ${task.title}: ${task.error ?? "No error detail recorded."} Review before retry.`,
    ),
    ...data.failedSubmissions.map(
      (row) =>
        `${row.company} — ${row.title}: ${statusLabel(row.status)} via ${channelLabel(row.channel)}. ${row.error ?? "No error detail recorded."} ${
          row.status === "unverified"
            ? "No blind retry; confirm with the employer or ATS first."
            : "Review the stored error before any retry."
        }`,
    ),
    ...data.failedRuns.map((run) => `Recruitment run ${run.run_key}: ${run.error ?? "No error detail recorded."}`),
  ];
  const actions = nextActions(data);
  const note =
    data.legacyUnverified > 0
      ? `<div style="margin:16px 0 0;padding:12px 14px;border:1px solid #f0d7a4;background:#fff8e8;border-radius:8px;color:#6b4e16;font-size:12px;line-height:1.5;">
          <strong>Data note:</strong> ${escapeHtml(data.legacyUnverified)} legacy application(s) are marked submitted or acknowledged without a verified submission attempt. They are excluded from the submitted count rather than being silently treated as successful.
        </div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(data.period.label)} recruitment report</title>
<style>
  body,table,td,a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .pad { padding:20px 18px !important; }
    .header-pad { padding:20px 18px !important; }
    .stat-cell { display:block !important; width:100% !important; box-sizing:border-box; }
    .agent-col { display:block !important; width:100% !important; box-sizing:border-box; }
    table { table-layout:fixed !important; width:100% !important; }
    table th, table td { padding:6px 4px !important; word-break:break-word !important; overflow-wrap:anywhere !important; }
    .state-pill { white-space:normal !important; font-size:9px !important; padding:2px 4px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;color:#1f3347;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Recruitment activity report for ${escapeHtml(data.period.label)}: ${escapeHtml(
    data.counts.discovered,
  )} discovered, ${escapeHtml(data.counts.submitted)} submitted, ${escapeHtml(data.counts.confirmations)} confirmation(s).</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:680px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(10,37,64,.08);">
      <tr><td class="header-pad" style="background:#0a2540;padding:24px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="76" valign="middle" style="width:76px;">
              <div style="background:#ffffff;border-radius:10px;padding:6px;display:inline-block;">
                <img src="cid:atw-logo" width="60" height="49" alt="AT AI Workforce" style="display:block;width:60px;height:auto;border-radius:6px;">
              </div>
            </td>
            <td valign="middle" style="padding-left:16px;">
              <div style="color:#7fdbff;font-size:11px;line-height:1.3;font-weight:700;letter-spacing:.18em;text-transform:uppercase;">AT AI WORKFORCE</div>
              <div style="margin-top:4px;color:#ffffff;font-size:22px;line-height:1.25;font-weight:700;">Your Recruitment Activity Report</div>
              <div style="margin-top:5px;color:#b9d7eb;font-size:13px;line-height:1.4;">${escapeHtml(
                data.period.label,
              )} · ${escapeHtml(RECRUITMENT_TIMEZONE)}</div>
            </td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="height:4px;background:#36c2e0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td class="pad" style="padding:28px;">
        ${sectionHeading("01", "Executive summary", "Actual persisted records for this reporting day.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 -6px;">
          <tr>
            ${statCell("Jobs discovered", data.counts.discovered, "#0d6fa8")}
            ${statCell("Jobs analysed", data.counts.analysed, "#0d6fa8")}
            ${statCell("Suitable matches", data.counts.suitable, "#1f7a4d")}
            ${statCell("Documents generated", data.counts.documents, "#0d6fa8")}
          </tr>
          <tr>
            ${statCell("Submitted", data.counts.submitted, "#1f7a4d")}
            ${statCell("Employer confirmations", data.counts.confirmations, "#1f7a4d")}
            ${statCell("Pending work", data.counts.pending, "#9a6700")}
            ${statCell("Failed tasks", data.counts.failed, "#b42318")}
          </tr>
        </table>
        ${note}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("02", "Successfully submitted applications", "Only attempts with recorded employer evidence appear here.")}
        ${submittedCards}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("03", "Employer confirmations", "Separate from the submission attempt itself.")}
        ${confirmationCards}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("04", "Pending work", "Awaiting processing, approval, documents or an employer response.")}
        ${list(pendingItems, "No pending application or task was recorded.")}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("05", "Failed tasks", "Failures and ambiguous outcomes are not counted as successful submissions.")}
        ${list(failedItems, "No failed task, submission attempt or recruitment run was recorded in this period.")}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("06", "Agent activity", "Each of the eight agents reports from its persisted task records.")}
        ${agentTable(data)}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        ${sectionHeading("07", "Next actions", "What the system will do next and what needs your intervention.")}
        ${list(actions, "No next action was recorded.")}
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        <div style="border-top:1px solid #dfe8f1;padding-top:16px;font-size:12px;line-height:1.7;color:#33465a;">
          Best regards,<br>
          <strong style="color:#0a2540;">${escapeHtml(chiefName)}</strong><br>
          ${escapeHtml(chiefTitle)}<br>
          ${escapeHtml(chiefCompany)}<br>
          <span style="color:#64748b;">Autonomous Recruitment &amp; Workforce Operations</span>
        </div>
      </td></tr>
      <tr><td style="background:#f7f9fc;border-top:1px solid #dfe8f1;padding:20px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td width="44" style="width:44px;vertical-align:top;"><img src="cid:atw-logo" width="36" height="30" alt="AT AI Workforce" style="display:block;width:36px;height:auto;border-radius:4px;"></td>
            <td style="padding-left:12px;vertical-align:top;">
              <div style="font-size:12px;line-height:1.5;color:#5b6b7c;">Automated report from <strong style="color:#0a2540;">AT AI WORKFORCE</strong>. Counts come from persisted recruitment records for ${escapeHtml(
                data.period.label,
              )}. No employer confirmation is claimed unless it was actually recorded.</div>
              <div style="margin-top:6px;font-size:11px;line-height:1.5;color:#7a8a9a;">Generated ${escapeHtml(
                data.generatedAt,
              )}. This message was sent to the configured workspace owner only.</div>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function buildDailyRecruitmentReportEmail(now: Date = new Date()): EmailContent {
  const data = collectReport(now);
  return {
    subject: `AT AI Workforce | Recruitment Activity Report | ${data.period.label}`,
    text: renderText(data),
    html: renderHtml(data),
  };
}

type ExecutionJob = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  salary: string | null;
  match_score: number | null;
  qualified: number;
  status: string;
  source_platform: string | null;
  application_url: string | null;
  url: string | null;
  published_at: string | null;
};

type ExecutionApplication = {
  id: string;
  status: string;
  submission_status: string | null;
  submitted_at: string | null;
  confirmation_ref: string | null;
  confirmation: string | null;
  last_update: string;
  title: string;
  company: string;
  location: string | null;
};

type ExecutionIntervention = {
  application_id: string;
  question: string;
  reason: string;
  title: string;
  company: string;
};

type ExecutionEmailData = {
  manifest: ExecutionManifest;
  run: {
    id: string;
    run_key: string;
    status: string;
    trigger: string;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
  };
  jobs: ExecutionJob[];
  applications: ExecutionApplication[];
  interventions: ExecutionIntervention[];
  adminName: string;
  nextRunAt: string | null;
  runUrl: string | null;
  policyActive: boolean;
  policyThreshold: number;
  dryRun: boolean;
};

function executionStateColour(state: ExecutionAgent["state"]): string {
  if (state === "COMPLETED") return "#1f7a4d";
  if (state === "COMPLETED_WITH_ZERO_RESULTS") return "#0d6fa8";
  if (state === "FAILED") return "#b42318";
  if (state === "DEGRADED" || state === "BLOCKED") return "#9a6700";
  return "#5b6b7c";
}

function durationLabel(ms: number | null): string {
  if (ms === null) return "Not recorded";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function executionDate(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: RECRUITMENT_TIMEZONE,
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(date);
}

function executionTime(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: RECRUITMENT_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function adminDisplayName(value: string | null | undefined): string {
  const first = (value ?? "").trim().split(/\s+/)[0];
  return first || "Boss";
}

function collectExecutionEmail(runId: string): ExecutionEmailData | null {
  const manifest = buildExecutionManifest(runId);
  if (!manifest) return null;
  const run = one<{
    id: string; run_key: string; status: string; trigger: string; started_at: string | null;
    finished_at: string | null; error: string | null;
  }>("SELECT id, run_key, status, trigger, started_at, finished_at, error FROM recruitment_runs WHERE id = ?", [runId]);
  if (!run) return null;
  const jobs = all<ExecutionJob>(
    `SELECT id, title, company, location, salary, match_score, qualified, status, source_platform,
            application_url, url, published_at
     FROM jobs WHERE run_id = ? ORDER BY qualified DESC, match_score DESC NULLS LAST`,
    [runId],
  );
  const applications = all<ExecutionApplication>(
    `SELECT a.id, a.status, a.submission_status, a.submitted_at, a.confirmation_ref, a.confirmation,
            a.last_update, j.title, j.company, j.location
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = ? ORDER BY a.created_at`,
    [runId],
  );
  const interventions = all<ExecutionIntervention>(
    `SELECT i.application_id, i.question, i.reason, j.title, j.company
     FROM application_interventions i JOIN jobs j ON j.id = i.job_id
     WHERE j.run_id = ? AND i.status = 'open' ORDER BY i.created_at`,
    [runId],
  );
  const owner = one<{ name: string | null }>(
    "SELECT name FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC LIMIT 1",
  );
  const schedule = one<{ next_run_at: string | null }>(
    "SELECT next_run_at FROM schedule_jobs WHERE key = 'daily_recruitment'",
  );
  const livePolicy = getRecruitmentPolicy();
  const baseUrl = publicAppBaseUrl();
  const runUrl = baseUrl ? `${baseUrl}/recruitment/runs/${encodeURIComponent(runId)}` : null;
  return {
    manifest,
    run,
    jobs,
    applications,
    interventions,
    adminName: adminDisplayName(owner?.name),
    nextRunAt: schedule?.next_run_at ?? null,
    runUrl,
    policyActive: livePolicy.active,
    policyThreshold: livePolicy.minMatchScore,
    dryRun: getSetting<boolean>("recruitment_dry_run", true),
  };
}

function zeroJobExplanation(data: ExecutionEmailData): string {
  const counts = data.manifest.counts;
  const failedSources = data.manifest.sources.filter((source) => source.status === "failed" || source.errors > 0);
  if (failedSources.length > 0 && counts.postingsScreened === 0) {
    return `No source could be read, so this run does not claim that zero vacancies exist. Failed source(s): ${failedSources.map((source) => source.label).join(", ")}.`;
  }
  if (counts.postingsScreened === 0) {
    return "The sources returned no listings at all. This is a successful empty response, not a source failure and not evidence that no vacancies exist.";
  }
  if (counts.relevant > 0 && counts.newJobs === 0) {
    return `${counts.postingsScreened.toLocaleString("en-GB")} postings were screened and ${counts.relevant} relevant match(es) were found, but all of them were already known. ${counts.duplicates} listing(s) were blocked as duplicates, so there were no new vacancies to assess. No source failed and the qualification threshold was not lowered.`;
  }
  return `${counts.postingsScreened.toLocaleString("en-GB")} postings were screened; ${counts.fresh.toLocaleString("en-GB")} were fresh and ${counts.relevant} passed the QA relevance rule. ${counts.newJobs} new vacancy(ies) were stored, so no qualified role was available to process.`;
}

function executionWarnings(data: ExecutionEmailData): Array<{
  title: string; description: string; owner: string; impact: string; recovery: string; recommendation: string;
}> {
  const rows: Array<{ title: string; description: string; owner: string; impact: string; recovery: string; recommendation: string }> = [];
  for (const failure of data.manifest.failures) {
    const affected = data.manifest.agents.find((agent) => agent.error && failure.includes(agent.error))?.name ?? "Workforce";
    rows.push({
      title: "Execution failure",
      description: failure,
      owner: affected,
      impact: "The affected operation did not complete. It is excluded from verified results.",
      recovery: "The run isolated the failure and continued where safe.",
      recommendation: "Review the stored execution details and the affected dependency before the next run.",
    });
  }
  for (const warning of data.manifest.warnings) {
    const affected = data.manifest.agents.find((agent) => agent.error && warning.includes(agent.error))?.name ?? "Workforce";
    rows.push({
      title: "Operational warning",
      description: warning,
      owner: affected,
      impact: "The run completed, but this condition reduced coverage or certainty.",
      recovery: /fallback|recovered|deterministic/i.test(warning) ? "A fallback path was used and the run continued." : "The condition was recorded; no success was inferred from it.",
      recommendation: /source|jobs\.ch|greenhouse|lever|ashby|arbeitnow|career/i.test(warning)
        ? "Check the source endpoint, response format and rate limits, then retry the source safely."
        : /AI|provider|model|inference/i.test(warning)
          ? "Check the configured AI provider and its fallback health."
          : "Inspect the execution record and resolve the recorded condition.",
    });
  }
  for (const intervention of data.interventions) {
    rows.push({
      title: "Employer question requires verified human input",
      description: `${intervention.title} at ${intervention.company}: ${intervention.question}`,
      owner: `${agentIdentity("application").name} — ${agentIdentity("application").title}`,
      impact: "This application is blocked and was not submitted.",
      recovery: intervention.reason,
      recommendation: "Answer the question in the dashboard; the next run can then re-check readiness.",
    });
  }
  return rows;
}

function executionAttention(data: ExecutionEmailData): string[] {
  const counts = data.manifest.counts;
  const items: string[] = [];
  if (data.manifest.failedAgents > 0) items.push(`${data.manifest.failedAgents} agent execution(s) failed. Review the exact error and rerun only after the cause is fixed.`);
  if (counts.submittedUnverified > 0) items.push(`${counts.submittedUnverified} submission outcome(s) are unverified. Confirm with the employer or ATS; do not retry blindly.`);
  if (counts.interventions > 0) items.push(`${counts.interventions} application question(s) need a verified answer.`);
  if (data.manifest.blockedAgents > 0) items.push(`${data.manifest.blockedAgents} agent(s) are blocked by a dependency or disabled state.`);
  if (!data.policyActive && data.manifest.counts.applicationsReady > 0) items.push("Automatic submission is not active; prepared applications will wait rather than being sent.");
  if (data.dryRun && data.manifest.counts.applicationsReady > 0) items.push("Dry run is enabled; no prepared application will be sent.");
  if (data.manifest.sources.some((source) => source.status === "failed")) items.push("At least one configured job source failed. It is not being reported as a successful zero-result source.");
  return items;
}

function executionExecutiveSummary(data: ExecutionEmailData): string {
  const c = data.manifest.counts;
  const lines: string[] = [];
  if (data.manifest.status === "failed") {
    lines.push(`This recruitment execution failed. ${data.manifest.failures[0] ?? "No failure detail was recorded."}`);
  } else {
    lines.push(
      `This recruitment execution ${data.manifest.status.replace(/_/g, " ")}. ${data.manifest.succeededAgents} of ${data.manifest.expectedAgents} agents produced a successful result.`,
    );
    lines.push(
      `${c.postingsScreened.toLocaleString("en-GB")} postings were screened, ${c.relevant} were relevant and ${c.newJobs} were new; ${c.qualified} met every qualification rule at the ${data.policyThreshold}% threshold.`,
    );
    if (c.submittedVerified > 0) lines.push(`${c.submittedVerified} application(s) were submitted and verified.`);
    else if (c.applicationsReady > 0) lines.push(`${c.applicationsReady} package(s) are prepared but not confirmed as submitted.`);
    if (c.submittedUnverified > 0) lines.push(`${c.submittedUnverified} unverified submission(s) require confirmation.`);
    if (data.manifest.warnings.length > 0) lines.push(`${data.manifest.warnings.length} warning(s) were recorded and are detailed below.`);
  }
  return lines.join(" ");
}

function renderExecutionText(data: ExecutionEmailData): string {
  const m = data.manifest;
  const lines: string[] = [];
  lines.push("AT AI WORKFORCE");
  lines.push("Recruitment execution report");
  lines.push(`${executionDate(data.run.started_at)} · ${RECRUITMENT_TIMEZONE}`);
  lines.push("");
  lines.push(`Hello ${data.adminName},`);
  lines.push("");
  lines.push("Your AT AI Workforce has completed this recruitment execution. Below is the operational record, including what each agent actually did, what was discovered, what was submitted and what needs your attention.");
  lines.push("");
  lines.push("EXECUTION");
  lines.push(`Execution ID: ${m.executionId}`);
  lines.push(
    data.runUrl
      ? `Dashboard: ${data.runUrl}`
      : "Dashboard link unavailable — no public APP_BASE_URL is configured. Use the execution ID in the local workspace.",
  );
  lines.push(`Status: ${m.status.replace(/_/g, " ")}`);
  lines.push(`Started: ${formatInZone(data.run.started_at)} (${RECRUITMENT_TIMEZONE})`);
  lines.push(`Completed: ${formatInZone(data.run.finished_at)} (${RECRUITMENT_TIMEZONE})`);
  lines.push(`Duration: ${durationLabel(m.durationMs)}`);
  lines.push(`Trigger: ${m.trigger}`);
  lines.push(`Agents expected: ${m.expectedAgents}; dispatched: ${m.dispatchedAgents}; succeeded: ${m.succeededAgents}; failed: ${m.failedAgents}; skipped: ${m.skippedAgents}; not executed: ${m.notExecutedAgents}`);
  lines.push("");
  lines.push("RECRUITMENT PERFORMANCE");
  lines.push(`Postings screened: ${m.counts.postingsScreened}`);
  lines.push(`Fresh postings: ${m.counts.fresh}`);
  lines.push(`Relevant postings: ${m.counts.relevant}`);
  lines.push(`New vacancies stored: ${m.counts.newJobs}`);
  lines.push(`Duplicate listings: ${m.counts.duplicates}`);
  lines.push(`Eligible: ${m.counts.eligible}`);
  lines.push(`Qualified at threshold: ${m.counts.qualified}`);
  lines.push(`Rejected or not qualified: ${m.counts.rejected}`);
  lines.push(`Documents prepared: ${m.counts.documentsPrepared}`);
  lines.push(`Applications prepared: ${m.counts.applicationsPrepared}`);
  lines.push(`Applications ready: ${m.counts.applicationsReady}`);
  lines.push(`Submitted and verified: ${m.counts.submittedVerified}`);
  lines.push(`Submitted but unverified: ${m.counts.submittedUnverified}`);
  lines.push(`Failed submissions: ${m.counts.submissionFailed}`);
  lines.push(`Needs administrator attention: ${m.counts.interventions}`);
  lines.push("");
  lines.push("WORKFORCE ACTIVITY");
  lines.push(`${m.summary}`);
  for (const agent of m.agents) {
    lines.push(`- ${agent.name} (${agent.role}) — ${agent.stateLabel}`);
    lines.push(`  Assignment: ${agent.assignments.at(-1) ?? "No assignment recorded"}`);
    lines.push(`  Records processed: ${agent.recordsProcessed}`);
    lines.push(`  Duration: ${durationLabel(agent.durationMs)}`);
    if (agent.output) lines.push(`  Output: ${agent.output.replace(/\s+/g, " ").slice(0, 500)}`);
    if (agent.error) lines.push(`  Error: ${agent.error}`);
    if (agent.reason) lines.push(`  Reason: ${agent.reason}`);
    lines.push(`  Handoff to ${agent.handoffTo ?? "none"}: ${agent.handoffComplete ? "completed" : "not completed"}`);
  }
  lines.push("");
  lines.push("JOB DISCOVERIES");
  if (data.jobs.length === 0) lines.push(zeroJobExplanation(data));
  for (const job of data.jobs) {
    lines.push(`- ${job.title} — ${job.company} · ${job.location ?? "Location not recorded"} · match ${job.match_score ?? "—"}% · ${job.qualified ? "qualified" : "not qualified"} · source ${job.source_platform ?? "not recorded"}`);
    const link = safeHref(job.application_url ?? job.url);
    if (link) lines.push(`  ${link}`);
  }
  lines.push("");
  lines.push("PENDING APPLICATIONS AND ADMINISTRATOR ATTENTION");
  const waiting = data.applications.filter((app) => !["submitted", "acknowledged", "rejected", "rejected_by_employer", "withdrawn"].includes(app.status));
  if (waiting.length === 0) lines.push("No application is waiting for automated processing.");
  for (const app of waiting) {
    lines.push(`- ${app.company} — ${app.title}: ${statusLabel(app.status)} · last updated ${formatInZone(app.last_update)}`);
  }
  for (const item of data.interventions) {
    lines.push(`- MANUAL ACTION: ${item.company} — ${item.title}: ${item.question} (${item.reason})`);
  }
  if (waiting.length === 0 && data.interventions.length === 0) lines.push("No administrator action is currently required for pending applications.");
  lines.push("");
  lines.push("SUCCESSFUL SUBMISSIONS");
  const verified = data.applications.filter((app) => app.submission_status === "verified" || Boolean(app.confirmation_ref));
  if (verified.length === 0) lines.push("No application was confirmed as submitted in this execution. Nothing unverified is counted as successful.");
  for (const app of verified) {
    lines.push(`- ${app.company} — ${app.title}: submitted ${formatInZone(app.submitted_at)} · reference ${app.confirmation_ref ?? app.confirmation ?? "recorded reference"}`);
  }
  lines.push("");
  lines.push("WARNINGS AND FAILURES");
  const problems = executionWarnings(data);
  if (problems.length === 0) lines.push("No warning, failure or unresolved question was recorded for this execution.");
  problems.forEach((problem, index) => {
    lines.push(`${index + 1}. ${problem.title} — ${problem.owner}`);
    lines.push(`   ${problem.description}`);
    lines.push(`   Impact: ${problem.impact}`);
    lines.push(`   Recovery: ${problem.recovery}`);
    lines.push(`   Recommended action: ${problem.recommendation}`);
  });
  lines.push("");
  lines.push("WHAT NEEDS YOUR ATTENTION");
  const attention = executionAttention(data);
  if (attention.length === 0) lines.push("No administrator action is currently required.");
  for (const item of attention) lines.push(`- ${item}`);
  lines.push("");
  lines.push("OVERALL ASSESSMENT");
  lines.push(executionExecutiveSummary(data));
  lines.push("");
  lines.push("Best regards,");
  for (const line of agentSignature("coordinator")) lines.push(line);
  lines.push("Autonomous Recruitment & Workforce Operations");
  lines.push("Automated operational report.");
  lines.push("");
  lines.push(`Execution: ${m.executionId} · Generated ${formatInZone(new Date().toISOString())} (${RECRUITMENT_TIMEZONE}).`);
  lines.push("No employer confirmation is claimed unless it was actually recorded.");
  return lines.join("\n");
}

function renderExecutionHtml(data: ExecutionEmailData): string {
  const m = data.manifest;
  const [chiefName, chiefTitle, chiefCompany] = agentSignature("coordinator");
  const metrics: Array<[string, number, string]> = [
    ["Postings screened", m.counts.postingsScreened, "#0d6fa8"],
    ["Relevant", m.counts.relevant, "#0d6fa8"],
    ["New vacancies", m.counts.newJobs, "#1f7a4d"],
    ["Duplicates blocked", m.counts.duplicates, "#5b6b7c"],
    ["Eligible", m.counts.eligible, "#0d6fa8"],
    ["Qualified", m.counts.qualified, "#1f7a4d"],
    ["CVs prepared", m.counts.documentsPrepared, "#0d6fa8"],
    ["Applications ready", m.counts.applicationsReady, "#9a6700"],
    ["Submitted + verified", m.counts.submittedVerified, "#1f7a4d"],
    ["Unverified", m.counts.submittedUnverified, m.counts.submittedUnverified ? "#9a6700" : "#5b6b7c"],
    ["Failed submissions", m.counts.submissionFailed, m.counts.submissionFailed ? "#b42318" : "#5b6b7c"],
    ["Needs attention", m.counts.interventions, m.counts.interventions ? "#b42318" : "#5b6b7c"],
  ];
  const metricRows = [0, 4, 8]
    .map(
      (start) => `<tr>${metrics
        .slice(start, start + 4)
        .map(([label, value, tone]) => statCell(label, value, tone))
        .join("")}</tr>`,
    )
    .join("");

  const agentRows = m.agents
    .map(
      (agent) => `<tr>
        <td style="padding:11px 10px;border-bottom:1px solid #edf2f7;vertical-align:top;">
          <div style="font-size:12px;font-weight:700;color:#1f3347;">${escapeHtml(agent.name)}</div>
          <div style="font-size:11px;color:#6b7c8f;">${escapeHtml(agent.role)}</div>
        </td>
        <td style="padding:11px 10px;border-bottom:1px solid #edf2f7;vertical-align:top;">
          <span class="state-pill" style="display:inline-block;padding:3px 7px;border-radius:999px;background:#f2f6fa;color:${executionStateColour(agent.state)};font-size:10px;font-weight:700;white-space:nowrap;">${escapeHtml(agent.stateLabel)}</span>
        </td>
        <td style="padding:11px 10px;border-bottom:1px solid #edf2f7;vertical-align:top;font-size:11px;line-height:1.5;color:#33465a;">
          ${escapeHtml(agent.assignments.at(-1) ?? "No assignment recorded")}<br><span style="color:#7a8a9a;">${escapeHtml(durationLabel(agent.durationMs))} · ${agent.recordsProcessed} record(s)</span>
        </td>
        <td style="padding:11px 10px;border-bottom:1px solid #edf2f7;vertical-align:top;font-size:11px;line-height:1.5;color:${agent.error ? "#b42318" : "#5b6b7c"};">
          ${escapeHtml(agent.error ?? agent.output?.replace(/\s+/g, " ").slice(0, 230) ?? agent.reason ?? "No output recorded")}
        </td>
      </tr>`,
    )
    .join("");

  const jobRows = data.jobs
    .map((job) => {
      const link = safeHref(job.application_url ?? job.url);
      const title = link
        ? `<a href="${escapeHtml(link)}" style="color:#0d6fa8;text-decoration:underline;">${escapeHtml(job.title)}</a>`
        : escapeHtml(job.title);
      return `<tr>
        <td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:12px;color:#1f3347;">${title}<div style="font-size:11px;color:#6b7c8f;">${escapeHtml(job.company)} · ${escapeHtml(job.location ?? "Location not recorded")}</div></td>
        <td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:12px;color:#1f3347;">${escapeHtml(job.match_score ?? "—")}${job.match_score === null ? "" : "%"}</td>
        <td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#5b6b7c;">${escapeHtml(job.source_platform ?? "Not recorded")}</td>
        <td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#5b6b7c;">${job.qualified ? "Qualified" : "Not qualified"}</td>
      </tr>`;
    })
    .join("");

  const waiting = data.applications.filter((app) => !["submitted", "acknowledged", "rejected", "rejected_by_employer", "withdrawn"].includes(app.status));
  const pendingRows = waiting
    .map((app) => `<tr><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:12px;color:#1f3347;">${escapeHtml(app.company)} — ${escapeHtml(app.title)}</td><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#5b6b7c;">${escapeHtml(statusLabel(app.status))}</td><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#5b6b7c;">${escapeHtml(formatInZone(app.last_update))}</td></tr>`)
    .join("");
  const interventionRows = data.interventions
    .map((item) => `<tr><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:12px;color:#b42318;">${escapeHtml(item.company)} — ${escapeHtml(item.title)}</td><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#5b6b7c;">${escapeHtml(item.question)}<br><span style="color:#9a6700;">${escapeHtml(item.reason)}</span></td><td style="padding:10px;border-bottom:1px solid #edf2f7;font-size:11px;color:#b42318;">Manual action</td></tr>`)
    .join("");

  const verified = data.applications.filter((app) => app.submission_status === "verified" || Boolean(app.confirmation_ref));
  const submissionCards = verified.length === 0
    ? emptyState("No application was confirmed as submitted in this execution. Nothing unverified is counted as successful.")
    : verified.map((app) => card({
        title: `${app.company} — ${app.title}`,
        subtitle: app.location ?? "Location not recorded",
        tone: "#1f7a4d",
        rows: [
          ["Submitted", formatInZone(app.submitted_at)],
          ["Evidence", app.confirmation_ref ?? app.confirmation ?? "Employer reference recorded"],
          ["Status", statusLabel(app.status)],
        ],
      })).join("");

  const problems = executionWarnings(data);
  const problemCards = problems.length === 0
    ? emptyState("No warning, failure or unresolved question was recorded for this execution.")
    : problems.map((problem) => card({
        title: problem.title,
        subtitle: problem.owner,
        tone: /failure/i.test(problem.title) ? "#b42318" : "#9a6700",
        rows: [
          ["Description", problem.description],
          ["Execution", m.executionId],
          ["Impact", problem.impact],
          ["Recovery", problem.recovery],
          ["Recommended action", problem.recommendation],
        ],
      })).join("");

  const attention = executionAttention(data);
  const attentionBlock = attention.length === 0
    ? emptyState("No administrator action is currently required.")
    : list(attention, "No administrator action is currently required.");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>AT AI Workforce recruitment execution report</title>
<style>
  body,table,td,a { -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0pt; mso-table-rspace:0pt; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .pad { padding:20px 16px !important; }
    .header-pad { padding:20px 16px !important; }
    .stat-cell { display:block !important; width:100% !important; box-sizing:border-box; }
    .stack-col { display:block !important; width:100% !important; box-sizing:border-box; }
    table { table-layout:fixed !important; width:100% !important; }
    table th, table td { padding:6px 4px !important; word-break:break-word !important; overflow-wrap:anywhere !important; }
    .state-pill { white-space:normal !important; font-size:9px !important; padding:2px 4px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#eef2f7;color:#1f3347;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">AT AI Workforce execution ${escapeHtml(m.executionId)}: ${escapeHtml(m.summary)} ${escapeHtml(m.counts.newJobs)} new vacancies, ${escapeHtml(m.counts.submittedVerified)} verified submissions.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" class="container" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:700px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 18px rgba(10,37,64,.08);">
      <tr><td class="header-pad" style="background:#0a2540;padding:24px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="76" valign="middle" style="width:76px;"><div style="background:#ffffff;border-radius:10px;padding:6px;display:inline-block;"><img src="cid:atw-logo" width="60" height="49" alt="AT AI Workforce logo" style="display:block;width:60px;height:auto;border-radius:6px;"></div></td>
          <td valign="middle" style="padding-left:16px;">
            <div style="color:#7fdbff;font-size:11px;line-height:1.3;font-weight:700;letter-spacing:.18em;text-transform:uppercase;">AT AI WORKFORCE</div>
            <div style="margin-top:4px;color:#ffffff;font-size:22px;line-height:1.25;font-weight:700;">Recruitment execution report</div>
            <div style="margin-top:5px;color:#b9d7eb;font-size:13px;line-height:1.4;">${escapeHtml(executionDate(data.run.started_at))} · ${escapeHtml(RECRUITMENT_TIMEZONE)}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="height:4px;background:#36c2e0;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td class="pad" style="padding:27px 28px;">
        <p style="margin:0 0 9px;font-size:16px;line-height:1.5;color:#0a2540;font-weight:700;">Hello ${escapeHtml(data.adminName)},</p>
        <p style="margin:0;color:#33465a;font-size:14px;line-height:1.7;">Your AT AI Workforce has completed this recruitment execution. Below is your full operational report: what each agent actually did, what was discovered, what was submitted and anything that needs your attention. Only persisted execution evidence is reported.</p>
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("01", "Execution at a glance", "Traceable to the execution record and the same manifest used by the dashboard.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f9fc;border:1px solid #dfe8f1;border-radius:9px;">
          <tr><td class="stack-col" width="50%" valign="top" style="padding:14px 16px;font-size:12px;line-height:1.6;color:#5b6b7c;">Execution ID<br><strong style="color:#0a2540;word-break:break-all;">${escapeHtml(m.executionId)}</strong></td><td class="stack-col" width="50%" valign="top" style="padding:14px 16px;font-size:12px;line-height:1.6;color:#5b6b7c;">Status<br><strong style="color:#0a2540;">${escapeHtml(m.status.replace(/_/g, " "))}</strong></td></tr>
          <tr><td class="stack-col" width="50%" valign="top" style="padding:0 16px 14px;font-size:12px;line-height:1.6;color:#5b6b7c;">Started<br><strong style="color:#0a2540;">${escapeHtml(executionTime(data.run.started_at))} ${escapeHtml(RECRUITMENT_TIMEZONE)}</strong></td><td class="stack-col" width="50%" valign="top" style="padding:0 16px 14px;font-size:12px;line-height:1.6;color:#5b6b7c;">Completed<br><strong style="color:#0a2540;">${escapeHtml(executionTime(data.run.finished_at))} ${escapeHtml(RECRUITMENT_TIMEZONE)}</strong></td></tr>
          <tr><td class="stack-col" width="50%" valign="top" style="padding:0 16px 14px;font-size:12px;line-height:1.6;color:#5b6b7c;">Duration<br><strong style="color:#0a2540;">${escapeHtml(durationLabel(m.durationMs))}</strong></td><td class="stack-col" width="50%" valign="top" style="padding:0 16px 14px;font-size:12px;line-height:1.6;color:#5b6b7c;">Workforce<br><strong style="color:#0a2540;">${m.succeededAgents} of ${m.expectedAgents} succeeded · ${m.notExecutedAgents} not executed</strong></td></tr>
          <tr><td colspan="2" style="padding:0 16px 14px;font-size:12px;line-height:1.6;color:#5b6b7c;">Dashboard<br>${data.runUrl ? `<a href="${escapeHtml(data.runUrl)}" style="color:#0d6fa8;text-decoration:underline;">Open this execution</a>` : `<strong style="color:#0a2540;">Link unavailable</strong><br><span style="color:#6b6b6b;">No public APP_BASE_URL is configured. Use execution ID ${escapeHtml(m.executionId)} in the local workspace.</span>`}</td></tr>
        </table>
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("02", "Recruitment performance", "Every metric is read from this execution's persisted records.")}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 -6px;">${metricRows}</table>
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("03", "Workforce activity", m.summary)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:12px;line-height:1.5;">
          <tr style="background:#eef4fa;"><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Agent</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">State</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Task / evidence</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Output / issue</th></tr>
          ${agentRows}
        </table>
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("04", "Job discoveries", data.jobs.length === 0 ? zeroJobExplanation(data) : "Only vacancies linked to this execution are listed.")}
        ${data.jobs.length === 0 ? emptyState(zeroJobExplanation(data)) : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:12px;"><tr style="background:#eef4fa;"><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Vacancy</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Match</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Source</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Status</th></tr>${jobRows}</table>`}
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("05", "Pending applications and manual action", "Automated waiting is separated from work that needs a verified human answer.")}
        ${pendingRows || interventionRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-size:12px;"><tr style="background:#eef4fa;"><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Application</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Stage / reason</th><th align="left" style="padding:9px 10px;color:#0a2540;font-size:10px;text-transform:uppercase;letter-spacing:.06em;">Action</th></tr>${pendingRows}${interventionRows}</table>` : emptyState("No pending application or administrator action was recorded.")}
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("06", "Successful submissions", "Only confirmed employer or ATS evidence appears here.")}
        ${submissionCards}
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("07", "Warnings and failures", "Exact recorded issues, their impact and the safe recovery path.")}
        ${problemCards}
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("08", "What needs your attention", "Only actionable items are listed.")}
        ${attentionBlock}
        <div style="height:24px;line-height:24px;">&nbsp;</div>
        ${sectionHeading("09", "Executive assessment", "Generated from the evidence in this execution, not from a template of success.")}
        <div style="border-left:4px solid ${m.failedAgents > 0 ? "#b42318" : "#0d6fa8"};background:#f7f9fc;border-radius:0 8px 8px 0;padding:14px 16px;color:#33465a;font-size:13px;line-height:1.7;">${escapeHtml(executionExecutiveSummary(data))}</div>
        <div style="height:26px;line-height:26px;">&nbsp;</div>
        <p style="margin:0;color:#33465a;font-size:13px;line-height:1.7;">Best regards,<br><strong style="color:#0a2540;">${escapeHtml(chiefName)}</strong><br>${escapeHtml(chiefTitle)}<br>${escapeHtml(chiefCompany)}<br><span style="color:#6b7c8f;">Autonomous Recruitment &amp; Workforce Operations<br>Automated operational report.</span></p>
      </td></tr>
      <tr><td style="background:#f7f9fc;border-top:1px solid #dfe8f1;padding:20px 28px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="48" style="width:48px;vertical-align:top;"><img src="cid:atw-logo" width="40" height="33" alt="AT AI Workforce logo" style="display:block;width:40px;height:auto;border-radius:4px;"></td>
          <td style="padding-left:12px;vertical-align:top;"><div style="font-size:12px;line-height:1.6;color:#5b6b7c;"><strong style="color:#0a2540;">AT AI Workforce</strong><br>Autonomous Recruitment &amp; Workforce Operations<br>Execution ${escapeHtml(m.executionId)} · generated ${escapeHtml(formatInZone(new Date().toISOString()))} (${escapeHtml(RECRUITMENT_TIMEZONE)})</div><div style="margin-top:5px;font-size:11px;line-height:1.5;color:#7a8a9a;">No employer confirmation is claimed unless it was actually recorded.</div></td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

export function buildRecruitmentExecutionEmail(runId: string): EmailContent | null {
  const data = collectExecutionEmail(runId);
  if (!data) return null;
  const date = executionDate(data.run.started_at);
  return {
    subject: `AT AI Workforce | Recruitment execution report | ${date} | ${data.manifest.status.replace(/_/g, " ")}`,
    text: renderExecutionText(data),
    html: renderExecutionHtml(data),
  };
}

/**
 * A branded wrapper for immediate events that do not need the full daily report.
 * The event's plain body remains the source of truth; no counts are invented.
 */
export function renderNotificationEmail(input: {
  subject: string;
  body: string;
  kind?: string;
}): EmailContent {
  const text = [
    "AT AI WORKFORCE",
    input.subject,
    "",
    input.body,
    "",
    "Automated notification from AT AI Workforce.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    input.subject,
  )}</title></head>
<body style="margin:0;padding:0;background:#eef2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f3347;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef2f7;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:#0a2540;padding:24px 28px;">
  <table role="presentation" width="100%"><tr><td width="66" valign="middle" style="width:66px;"><div style="background:#fff;border-radius:9px;padding:5px;display:inline-block;"><img src="cid:atw-logo" width="54" height="44" alt="AT AI Workforce" style="display:block;width:54px;height:auto;border-radius:5px;"></div></td>
  <td valign="middle" style="padding-left:14px;"><div style="color:#7fdbff;font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;">AT AI Workforce</div><div style="margin-top:3px;color:#fff;font-size:19px;line-height:1.3;font-weight:700;">${escapeHtml(
    input.subject,
  )}</div></td></tr></table>
</td></tr>
<tr><td style="height:4px;background:#36c2e0;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:26px 28px;"><p style="margin:0;color:#33465a;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(
    input.body,
  )}</p></td></tr>
<tr><td style="background:#f7f9fc;border-top:1px solid #dfe8f1;padding:16px 28px;color:#6b7c8f;font-size:11px;line-height:1.5;">Automated notification from AT AI Workforce. Counts and statuses come from persisted records.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject: input.subject, text, html };
}
