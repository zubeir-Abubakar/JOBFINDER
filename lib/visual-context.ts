import { all, one } from "./db";
import { getAnalytics, resolveAnalyticsRange } from "./analytics";
import { getProfileData } from "./profile";
import { getRecruitmentPolicy } from "./recruitment-policy";
import { scheduleSnapshot, formatInZone, REPORT_SCHEDULE_KEY, RECRUITMENT_SCHEDULE_KEY } from "./recruitment-schedule";
import { executiveBriefScheduleSnapshot } from "./executive-brief";
import type { VisualViewKey } from "./visual-types";

/**
 * Structured visual understanding for every agent.
 *
 * The preferred source is the actual stored data, not a screenshot. These
 * functions are account-scoped for documents and read-only for workspace data;
 * they never accept a model-supplied SQL fragment or an arbitrary identifier
 * without an ownership/existence check. A missing dataset is reported as
 * missing, never filled with sample values.
 */

export type ChartDataset = {
  label: string;
  values: number[];
  unit: string;
};

export type ChartSpec = {
  id: string;
  title: string;
  description: string;
  timeRange: { from: string; to: string; label: string };
  labels: string[];
  datasets: ChartDataset[];
  axes: { x: string; y: string };
  total: number;
  notes: string[];
};

export type TableSpec = {
  id: string;
  title: string;
  headers: string[];
  rows: Array<Array<string | number | null>>;
  total: number;
  filters: Record<string, string | null>;
  notes: string[];
};

export type PageContext = {
  view: VisualViewKey;
  title: string;
  description: string;
  capturedAt: string;
  kpis: Array<{ label: string; value: string | number; note?: string }>;
  charts: ChartSpec[];
  tables: TableSpec[];
  statuses: Array<{ label: string; value: number }>;
  filters: Record<string, string | null>;
  notes: string[];
};

function isoDayOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function analyticsCharts(preset = "7"): ChartSpec[] {
  const range = resolveAnalyticsRange({ preset });
  const data = getAnalytics(range);
  const labels = data.trends.vacancies.map((point) => point.label);
  const chart = (
    id: string,
    title: string,
    description: string,
    series: Array<{ label: string; values: Array<{ label: string; value: number }>; unit: string }>,
    notes: string[] = [],
  ): ChartSpec => ({
    id,
    title,
    description,
    timeRange: { from: range.from, to: range.to, label: range.label },
    labels,
    datasets: series.map((item) => ({ label: item.label, values: item.values.map((point) => point.value), unit: item.unit })),
    axes: { x: "Date", y: series[0]?.unit || "Count" },
    total: series.reduce((sum, item) => sum + item.values.reduce((inner, point) => inner + point.value, 0), 0),
    notes,
  });
  return [
    chart("vacancies", "Vacancies discovered", "New vacancies stored in the selected window.", [
      { label: "Vacancies discovered", values: data.trends.vacancies, unit: "vacancies" },
    ]),
    chart("prepared", "Applications prepared", "Application packages prepared in the selected window.", [
      { label: "Applications prepared", values: data.trends.prepared, unit: "packages" },
    ]),
    chart("verified", "Verified submissions", "Submissions with employer confirmation evidence; prepared or attempted is not counted here.", [
      { label: "Verified submissions", values: data.trends.verified, unit: "submissions" },
    ]),
    chart("tasks", "Agent task activity", "Recorded agent task outcomes in the selected window.", [
      { label: "Agent task activity", values: data.trends.tasks, unit: "tasks" },
    ]),
    chart("tokens", "Token consumption", "Provider-reported and estimated token usage. Unknown provenance is labelled separately.", [
      { label: "Token consumption", values: data.trends.tokens, unit: "tokens" },
    ]),
    chart("funnel", "Recruitment funnel", "Counts by recruitment stage for the selected window.", [
      { label: data.funnel.map((step) => step.label).join(" · "), values: data.funnel.map((step) => ({ label: step.label, value: step.value })), unit: "records" },
    ], ["Prepared and attempted are never counted as verified."]),
  ];
}

function jobsTable(): TableSpec {
  const rows = all<{
    id: string; title: string; company: string; location: string | null; match_score: number | null;
    match_flag: string | null; status: string; eligibility: string | null; vacancy_status: string | null;
  }>(
    `SELECT id, title, company, location, match_score, match_flag, status, eligibility, vacancy_status
     FROM jobs ORDER BY COALESCE(match_score, -1) DESC, discovered_at DESC LIMIT 25`,
  );
  const total = Number(one<{ c: number }>("SELECT COUNT(*) AS c FROM jobs")?.c ?? 0);
  return {
    id: "jobs",
    title: "Stored vacancies",
    headers: ["Title", "Company", "Location", "Match", "Flag", "Status", "Eligibility", "Vacancy"],
    rows: rows.map((row) => [
      row.title, row.company, row.location, row.match_score === null ? null : `${row.match_score}%`,
      row.match_flag, row.status, row.eligibility, row.vacancy_status,
    ]),
    total,
    filters: {},
    notes: ["Match scores are suitability estimates from the deterministic scoring engine, not document quality.", rows.length < total ? `Showing the top ${rows.length} of ${total} records.` : "All stored records are shown."],
  };
}

function applicationsTable(): TableSpec {
  const rows = all<{
    id: string; title: string; company: string; status: string; submission_status: string | null;
    match_score: number | null; submitted_at: string | null; last_update: string; blocker: string | null;
  }>(
    `SELECT a.id, j.title, j.company, a.status, a.submission_status, j.match_score, a.submitted_at, a.last_update,
            (SELECT i.reason FROM application_interventions i WHERE i.application_id = a.id AND i.status = 'open' ORDER BY i.created_at LIMIT 1) AS blocker
     FROM applications a JOIN jobs j ON j.id = a.job_id ORDER BY a.last_update DESC LIMIT 30`,
  );
  const total = Number(one<{ c: number }>("SELECT COUNT(*) AS c FROM applications")?.c ?? 0);
  return {
    id: "applications",
    title: "Application records",
    headers: ["Role", "Company", "Status", "Submission", "Match", "Submitted", "Last update", "Open blocker"],
    rows: rows.map((row) => [
      row.title, row.company, row.status, row.submission_status,
      row.match_score === null ? null : `${row.match_score}%`, row.submitted_at, row.last_update, row.blocker,
    ]),
    total,
    filters: {},
    notes: ["Only employer-verified submissions are counted as submitted.", rows.length < total ? `Showing the latest ${rows.length} of ${total} records.` : "All application records are shown."],
  };
}

function documentsTable(userId: string): TableSpec {
  const rows = all<{ id: string; kind: string; display_name: string; version: string | null; quality_status: string | null; ats_score: number | null; created_at: string }>(
    `SELECT id, kind, display_name, version, quality_status, ats_score, created_at
     FROM documents WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 30`,
    [userId],
  );
  return {
    id: "documents",
    title: "Your documents",
    headers: ["Kind", "Name", "Version", "Quality", "CV ATS", "Created"],
    rows: rows.map((row) => [row.kind, row.display_name, row.version, row.quality_status, row.ats_score, row.created_at]),
    total: rows.length,
    filters: {},
    notes: ["Metadata only. Use read_document to read the stored text of an owned document.", "A cover letter has no CV ATS compatibility score."],
  };
}

function agentStatuses(): Array<{ label: string; value: number }> {
  return all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM agents GROUP BY status").map((row) => ({ label: row.status, value: Number(row.n) }));
}

function pipelineContext() {
  const pipeline = all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM applications GROUP BY status");
  return pipeline.map((row) => ({ label: row.status, value: Number(row.n) }));
}

function dashboardContext(): PageContext {
  const jobs = one<{ total: number; strong: number; analysed: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN match_flag = 'strong' THEN 1 ELSE 0 END) AS strong,
            SUM(CASE WHEN match_score IS NOT NULL THEN 1 ELSE 0 END) AS analysed FROM jobs`,
  ) ?? { total: 0, strong: 0, analysed: 0 };
  const apps = one<{ submitted: number; verified: number; intervention: number; interviews: number }>(
    `SELECT SUM(CASE WHEN status IN ('submitted','acknowledged') THEN 1 ELSE 0 END) AS submitted,
            SUM(CASE WHEN submission_status = 'verified' THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN status = 'human_intervention_required' THEN 1 ELSE 0 END) AS intervention,
            SUM(CASE WHEN status IN ('interview_invited','interview_completed','offer_received') THEN 1 ELSE 0 END) AS interviews
     FROM applications`,
  ) ?? { submitted: 0, verified: 0, intervention: 0, interviews: 0 };
  return {
    view: "dashboard",
    title: "Application dashboard",
    description: "Primary recruitment metrics, pipeline, agent status and system health.",
    capturedAt: new Date().toISOString(),
    kpis: [
      { label: "Jobs discovered", value: Number(jobs.total), note: `${Number(jobs.strong)} strong matches` },
      { label: "Jobs analysed", value: Number(jobs.analysed) },
      { label: "Verified submissions", value: Number(apps.verified), note: `${Number(apps.submitted)} submitted/acknowledged` },
      { label: "Interviews", value: Number(apps.interviews) },
      { label: "Needs your attention", value: Number(apps.intervention) },
    ],
    charts: analyticsCharts("7"),
    tables: [applicationsTable()],
    statuses: pipelineContext(),
    filters: {},
    notes: ["Every value is read from SQLite; no sample values are used."],
  };
}

function analyticsContext(): PageContext {
  const charts = analyticsCharts("7");
  return {
    view: "analytics",
    title: "Analytics & reporting",
    description: "Recorded recruitment, agent and provider measurements for the last seven days.",
    capturedAt: new Date().toISOString(),
    kpis: charts.slice(0, 4).map((chart) => ({ label: chart.title, value: chart.total, note: chart.timeRange.label })),
    charts,
    tables: [],
    statuses: [],
    filters: { range: "Last 7 days" },
    notes: ["Empty ranges stay empty; no sample data is shown.", "Cost is unverified unless a provider publishes pricing."],
  };
}

export function viewForPath(pathname: string): VisualViewKey | undefined {
  const path = (pathname || "").split("?")[0];
  if (path === "/" || path.startsWith("/dashboard")) return "dashboard";
  if (path.startsWith("/analytics")) return "analytics";
  if (path.startsWith("/jobs")) return "jobs";
  if (path.startsWith("/applications")) return "applications";
  if (path.startsWith("/documents")) return "documents";
  if (path.startsWith("/profile")) return "profile";
  if (path.startsWith("/agents")) return "agents";
  if (path.startsWith("/inbox")) return "inbox";
  if (path.startsWith("/settings")) return "settings";
  if (path.startsWith("/recruitment")) return "dashboard";
  return undefined;
}

export function pageContext(userId: string, requested?: unknown): PageContext {
  const view = typeof requested === "string" && requested in {
    dashboard: 1, agents: 1, jobs: 1, applications: 1, documents: 1, profile: 1,
    analytics: 1, inbox: 1, assistant: 1, settings: 1, providers: 1, workflow: 1,
  } ? (requested as VisualViewKey) : "dashboard";

  if (view === "analytics") return analyticsContext();
  if (view === "dashboard" || view === "workflow") return dashboardContext();
  if (view === "jobs") {
    const table = jobsTable();
    return {
      view, title: "Job discovery", description: "Stored vacancies with their match scores and eligibility.",
      capturedAt: new Date().toISOString(),
      kpis: [{ label: "Stored vacancies", value: table.total }],
      charts: [], tables: [table], statuses: [], filters: {}, notes: table.notes,
    };
  }
  if (view === "applications") {
    const table = applicationsTable();
    return {
      view, title: "Application tracking", description: "Every application record and its current status.",
      capturedAt: new Date().toISOString(),
      kpis: [{ label: "Application records", value: table.total }],
      charts: [], tables: [table], statuses: pipelineContext(), filters: {}, notes: table.notes,
    };
  }
  if (view === "documents") {
    const table = documentsTable(userId);
    return {
      view, title: "CV and documents", description: "Your original CV and every tailored CV or cover letter.",
      capturedAt: new Date().toISOString(),
      kpis: [{ label: "Stored documents", value: table.total }],
      charts: [], tables: [table], statuses: [], filters: {}, notes: table.notes,
    };
  }
  if (view === "profile") {
    const profile = getProfileData();
    return {
      view, title: "Professional profile", description: "The stored facts used to ground generated documents.",
      capturedAt: new Date().toISOString(),
      kpis: [
        { label: "Verified skills", value: profile.skills.length },
        { label: "Experience roles", value: profile.experiences.length },
        { label: "Languages", value: profile.languages.length },
      ],
      charts: [], tables: [], statuses: [], filters: {}, notes: ["Profile facts are the only source for claims in generated documents."],
    };
  }
  if (view === "agents") {
    const agents = all<{ name: string; role: string; status: string; current_task: string | null; enabled: number }>(
      "SELECT name, role, status, current_task, enabled FROM agents ORDER BY sort",
    );
    return {
      view, title: "Agent workspace", description: "The eight agents, their roles and recorded status.",
      capturedAt: new Date().toISOString(),
      kpis: [{ label: "Agents", value: agents.length }, { label: "Working", value: agents.filter((agent) => ["working", "thinking", "waiting"].includes(agent.status)).length }],
      charts: [], tables: [{
        id: "agents", title: "Agent roster",
        headers: ["Name", "Role", "Status", "Current task", "Enabled"],
        rows: agents.map((agent) => [agent.name, agent.role, agent.status, agent.current_task, agent.enabled === 1 ? "Yes" : "No"]),
        total: agents.length, filters: {}, notes: ["Status is the recorded state, not a live model connection."],
      }], statuses: agentStatuses(), filters: {}, notes: ["Voice IDs and identities are fixed by the server."],
    };
  }
  if (view === "settings") {
    const recruitment = scheduleSnapshot();
    const report = executiveBriefScheduleSnapshot();
    const policy = getRecruitmentPolicy();
    return {
      view, title: "Settings", description: "Recruitment policy, schedules, retention and notifications.",
      capturedAt: new Date().toISOString(),
      kpis: [
        { label: "Automatic submission", value: policy.active ? "On" : "Paused" },
        { label: "Minimum match", value: `${policy.minMatchScore}%` },
        { label: "Daily cap", value: policy.maxSubmissionsPerDay },
      ],
      charts: [], tables: [], statuses: [], filters: {},
      notes: [
        `Recruitment: ${recruitment.weekdayLabels.join(", ")} at ${recruitment.time} ${recruitment.timezone}.`,
        `Daily report: ${report.weekdaysList.map((day) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][day]).join(", ")} at ${report.time} ${report.timezone}.`,
        `Next recruitment run: ${formatInZone(recruitment.nextRunAt, recruitment.timezone)}.`,
        `Next report: ${formatInZone(report.next_run_at, report.timezone)}.`,
      ],
    };
  }
  if (view === "inbox") {
    const rows = all<{ subject: string; sender: string | null; category: string; received_at: string | null }>(
      "SELECT subject, sender, category, received_at FROM email_messages ORDER BY COALESCE(received_at, created_at) DESC LIMIT 20",
    );
    return {
      view, title: "Inbox", description: "Recruiter email and notifications stored by the Email agent.",
      capturedAt: new Date().toISOString(),
      kpis: [{ label: "Stored messages", value: rows.length }],
      charts: [], tables: [{
        id: "inbox", title: "Recent messages", headers: ["Subject", "Sender", "Category", "Received"],
        rows: rows.map((row) => [row.subject, row.sender, row.category, row.received_at]), total: rows.length, filters: {},
        notes: ["Message bodies are not exposed by the page-context tool."],
      }], statuses: [], filters: {}, notes: [],
    };
  }
  return dashboardContext();
}

export function chartContext(preset = "7"): { charts: ChartSpec[]; notes: string[] } {
  return { charts: analyticsCharts(preset), notes: ["Values come from the persisted analytics range."] };
}

export function tableContext(userId: string, table?: unknown): { tables: TableSpec[] } {
  const requested = typeof table === "string" ? table : "";
  if (requested === "jobs") return { tables: [jobsTable()] };
  if (requested === "documents") return { tables: [documentsTable(userId)] };
  if (requested === "agents") {
    return { tables: [pageContext(userId, "agents").tables[0]].filter(Boolean) };
  }
  return { tables: [applicationsTable()] };
}

export type DocumentReadResult =
  | { ok: true; documentId: string; kind: string; name: string; text: string; truncated: boolean; createdAt: string }
  | { ok: false; message: string };

export function readOwnedDocument(
  userId: string,
  args: { which?: unknown; document_id?: unknown },
): DocumentReadResult {
  let row: { id: string; kind: string; display_name: string; text_content: string | null; created_at: string } | null = null;
  if (typeof args.document_id === "string" && args.document_id.trim()) {
    row = one(
      `SELECT id, kind, display_name, text_content, created_at FROM documents
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [args.document_id.trim(), userId],
    );
  } else {
    const which = typeof args.which === "string" ? args.which : "latest_cv";
    const kind = which === "latest_cover_letter" ? "cover_letter" : which === "original_cv" ? "original_cv" : "tailored_cv";
    row = one(
      `SELECT id, kind, display_name, text_content, created_at FROM documents
       WHERE user_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [userId, kind],
    );
  }
  if (!row) return { ok: false, message: "No owned document matches that request. Nothing was substituted." };
  if (!row.text_content || !row.text_content.trim()) {
    return { ok: false, message: `“${row.display_name}” has no extracted text, so its content cannot be read. The file metadata exists, but I will not pretend to have read it.` };
  }
  const limit = 8000;
  return {
    ok: true,
    documentId: row.id,
    kind: row.kind,
    name: row.display_name,
    text: row.text_content.slice(0, limit),
    truncated: row.text_content.length > limit,
    createdAt: row.created_at,
  };
}

function currency(value: number): string {
  return value.toLocaleString("en-GB");
}

function describeChart(chart: ChartSpec): string {
  const primary = chart.datasets[0];
  if (!primary || primary.values.length === 0) {
    return `${chart.title}: no underlying data is stored for ${chart.timeRange.label}.`;
  }
  const total = primary.values.reduce((sum, value) => sum + value, 0);
  const peak = primary.values.reduce((best, value, index) => (value > primary.values[best] ? index : best), 0);
  const low = primary.values.reduce((best, value, index) => (value < primary.values[best] ? index : best), 0);
  return [
    `${chart.title}: ${chart.description}`,
    `Range ${chart.timeRange.from} to ${chart.timeRange.to} (${chart.timeRange.label}); ${chart.axes.x} on the horizontal axis, ${chart.axes.y} on the vertical axis.`,
    `Total ${currency(total)} ${primary.unit} across ${primary.values.length} bucket(s). Highest ${currency(primary.values[peak])} at ${chart.labels[peak] ?? "an unlabelled bucket"}; lowest ${currency(primary.values[low])} at ${chart.labels[low] ?? "an unlabelled bucket"}.`,
  ].join(" ");
}

function comparisonReply(): string {
  const currentRange = resolveAnalyticsRange({ preset: "custom", from: isoDayOffset(-6), to: isoDayOffset(0) });
  const previousRange = resolveAnalyticsRange({ preset: "custom", from: isoDayOffset(-13), to: isoDayOffset(-7) });
  const current = getAnalytics(currentRange);
  const previous = getAnalytics(previousRange);
  const pairs = [
    ["Verified submissions", current.trends.verified.reduce((sum, point) => sum + point.value, 0), previous.trends.verified.reduce((sum, point) => sum + point.value, 0)],
    ["Applications prepared", current.trends.prepared.reduce((sum, point) => sum + point.value, 0), previous.trends.prepared.reduce((sum, point) => sum + point.value, 0)],
    ["Vacancies discovered", current.trends.vacancies.reduce((sum, point) => sum + point.value, 0), previous.trends.vacancies.reduce((sum, point) => sum + point.value, 0)],
    ["Agent tasks", current.trends.tasks.reduce((sum, point) => sum + point.value, 0), previous.trends.tasks.reduce((sum, point) => sum + point.value, 0)],
  ] as Array<[string, number, number]>;
  if (pairs.every(([, now, before]) => now === 0 && before === 0)) {
    return "There are no recorded recruitment measurements in either the last seven days or the previous seven days, so I cannot explain a change. I will not invent values.";
  }
  const lines = pairs.map(([label, now, before]) => {
    const delta = now - before;
    const direction = delta === 0 ? "unchanged" : delta > 0 ? `up ${delta}` : `down ${Math.abs(delta)}`;
    return `${label}: ${now} in the last 7 days vs ${before} in the previous 7 (${direction}).`;
  });
  const blocker = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'human_intervention_required'")?.c ?? 0;
  return [
    "Using the recorded 7-day windows rather than the visual shape of the chart:",
    ...lines,
    `${blocker} application(s) are currently blocked for human intervention.`,
    "A decrease can reflect fewer qualifying vacancies, fewer verified employer confirmations, or fewer prepared packages; the figures above distinguish those stages instead of assuming cause.",
  ].join("\n");
}

/**
 * Deterministic explanation of charts, tables, pages and documents. Returns
 * null when the question is not a visual-understanding request, so ordinary
 * conversation and existing navigation intent keep their normal path.
 */
export function explainVisualQuestion(
  userId: string,
  message: string,
  view?: string,
): { reply: string; facts: Record<string, unknown>; agentKeys: string[] } | null {
  const text = message.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;

  if (/\b(explain|read|summari[sz]e|what does)\b/.test(text) && /\b(document|cover letter)\b/.test(text) && /\b(explain|read|summari[sz]e|what does .* say)\b/.test(text)) {
    const result = readOwnedDocument(userId, { which: /cover letter/.test(text) ? "latest_cover_letter" : "latest_cv" });
    if (!result.ok) return { reply: result.message, facts: { available: false }, agentKeys: ["cv"] };
    return {
      reply: `I read the stored document “${result.name}” through your authenticated account. Its text begins: ${result.text.slice(0, 700)}${result.truncated ? " … (truncated)" : ""}. I can explain its sections, but I will not infer content that is not in this text.`,
      facts: { documentId: result.documentId, kind: result.kind, name: result.name, textLength: result.text.length, untrustedContent: true },
      agentKeys: ["cv"],
    };
  }

  if (/\b(why|what caused|reason)\b/.test(text) && /\b(decreas|drop|declin|increase|rise|changed|change)\b/.test(text)) {
    return { reply: comparisonReply(), facts: { source: "analytics_trends", comparedWindows: ["last_7_days", "previous_7_days"] }, agentKeys: ["coordinator"] };
  }

  if (/\b(this|the|that)?\s*(graph|chart|plot|trend)\b/.test(text) || /\bexplain this (graph|chart)\b/.test(text)) {
    const charts = analyticsCharts("7");
    return {
      reply: charts.map(describeChart).join("\n\n"),
      facts: { source: "analytics", charts: charts.map((chart) => ({ id: chart.id, title: chart.title, labels: chart.labels, datasets: chart.datasets, axes: chart.axes, range: chart.timeRange })) },
      agentKeys: ["coordinator"],
    };
  }

  if (/\b(table|rows|columns|records)\b/.test(text) && /\b(explain|what|show|mean|summar|which|tell)\b/.test(text)) {
    const table = tableContext(userId, /\bdocument|\bcv\b|\bcover letter/.test(text) ? "documents" : "applications").tables[0];
    if (!table || table.rows.length === 0) {
      return { reply: `The ${table?.title ?? "requested"} table has no stored rows in this workspace, so there is nothing to explain. I will not invent records.`, facts: { available: false }, agentKeys: ["application"] };
    }
    const preview = table.rows.slice(0, 8).map((row) => row.map((cell) => cell ?? "—").join(" · ")).join("\n");
    return {
      reply: `${table.title}: columns are ${table.headers.join(", ")}. ${table.total} record(s) are stored${table.rows.length < table.total ? `; showing the most recent ${table.rows.length}` : ""}. The most relevant rows are:\n${preview}\n${table.notes.join(" ")}`,
      facts: { source: table.id, headers: table.headers, rows: table.rows.slice(0, 20), total: table.total },
      agentKeys: ["application"],
    };
  }

  if (/\b(applications?|pipeline|recruitment)\b/.test(text) && /\b(what is happening|what's happening|explain|status|summary|overview)\b/.test(text)) {
    const applications = applicationsTable();
    const blocked = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE status = 'human_intervention_required'")?.c ?? 0;
    const submitted = one<{ c: number }>("SELECT COUNT(*) AS c FROM applications WHERE submission_status = 'verified'")?.c ?? 0;
    return {
      reply: `Your application records: ${applications.total} total, ${submitted} with verified employer evidence, ${blocked} blocked for human intervention. The status breakdown is ${pipelineContext().map((row) => `${row.label}: ${row.value}`).join(", ") || "empty"}. Only verified submissions are counted as sent.`,
      facts: { source: "applications", total: applications.total, verified: submitted, blocked, statuses: pipelineContext() },
      agentKeys: ["application"],
    };
  }

  if (/\b(what am i looking at|explain this page|explain this screen|what is this page|describe this page)\b/.test(text)) {
    const context = pageContext(userId, view);
    return {
      reply: `${context.title}: ${context.description} The visible key figures are ${context.kpis.map((kpi) => `${kpi.label} ${kpi.value}`).join(", ") || "not recorded"}. ${context.notes[0] ?? ""}`,
      facts: { source: "page_context", view: context.view, kpis: context.kpis, notes: context.notes },
      agentKeys: ["coordinator"],
    };
  }

  return null;
}

export { RECRUITMENT_SCHEDULE_KEY, REPORT_SCHEDULE_KEY };
