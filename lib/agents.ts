import { writeFile } from "node:fs/promises";
import path from "node:path";
import { all, nowIso, one, run, UPLOAD_DIR, v } from "./db";
import { randomId } from "./security";
import { getProfileData } from "./profile";
import { analyseJob, flagLabel, type JobAnalysis } from "./scoring";
import { researchJobs, type JobRow } from "./jobs";
import {
  buildCoverLetterModel,
  buildCvModel,
  documentFileBase,
  jobFromRow,
  modelToText,
  renderDocx,
  renderPdf,
  type DocModel,
} from "./docgen";
import { assessAts } from "./ats";
import { getSetting } from "./settings";
import { notify } from "./notify";
import { audit } from "./audit";
import { generateText } from "./providers";
import { agentDefinition } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import { agentAvailability } from "./agent-availability";

export type WorkflowOutcome = {
  workflowId: string;
  status: "completed" | "failed" | "paused";
  summary: string;
  details: string[];
  jobId?: string;
  applicationId?: string;
};

function agentKeyExists(key: string): boolean {
  return Boolean(one("SELECT key FROM agents WHERE key = ?", [key]));
}

export function agentEnabled(key: string): boolean {
  const row = one<{ enabled: number; status: string }>("SELECT enabled, status FROM agents WHERE key = ?", [key]);
  return Boolean(row && row.enabled === 1 && row.status !== "paused");
}

export function createWorkflow(kind: string, label: string): string {
  const id = `wf_${randomId()}`;
  run("INSERT INTO workflows (id, kind, label, status, created_at) VALUES (?, ?, ?, 'running', ?)", [id, kind, label, nowIso()]);
  return id;
}

export function finishWorkflow(id: string, status: "completed" | "failed" | "paused", summary: string): void {
  run("UPDATE workflows SET status = ?, summary = ?, finished_at = ? WHERE id = ?", [status, summary, nowIso(), id]);
}

export function startTask(agentKey: string, workflowId: string, title: string, detail = ""): string {
  const row = one<{ enabled: number; status: string }>("SELECT enabled, status FROM agents WHERE key = ?", [agentKey]);
  if (row && (row.enabled !== 1 || row.status === "paused")) {
    throw new Error(`${agentIdentity(agentKey).name} is paused or disabled. Resume it in Agent management before executing this step.`);
  }
  const availability = agentAvailability(agentKey);
  if (!availability.available) {
    throw new Error(`${agentIdentity(agentKey).name} is unavailable. Missing dependency: ${availability.dependency}. ${availability.reason}`);
  }
  const id = `task_${randomId()}`;
  run(
    "INSERT INTO tasks (id, workflow_id, agent_key, title, status, detail, created_at, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?)",
    [id, workflowId, agentKey, title, detail, nowIso(), nowIso()],
  );
  if (agentKeyExists(agentKey)) {
    run("UPDATE agents SET status = 'working', current_task = ? WHERE key = ?", [title, agentKey]);
  }
  return id;
}

/** A real inference request is in flight, so the agent is Thinking, not Working. */
export function markAgentThinking(agentKey: string): void {
  run("UPDATE agents SET status = 'thinking' WHERE key = ? AND status = 'working'", [agentKey]);
}

export function markAgentWorking(agentKey: string): void {
  run("UPDATE agents SET status = 'working' WHERE key = ? AND status = 'thinking'", [agentKey]);
}

export function completeTask(taskId: string, agentKey: string, output: string, requiresInput = false): void {
  run("UPDATE tasks SET status = 'completed', output = ?, requires_input = ?, finished_at = ? WHERE id = ?", [
    output,
    v(requiresInput),
    nowIso(),
    taskId,
  ]);
  if (agentKeyExists(agentKey)) {
    run(
      "UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'completed' END, current_task = NULL, last_run_at = ?, run_count = run_count + 1, success_count = success_count + 1 WHERE key = ?",
      [nowIso(), agentKey],
    );
  }
}

export function failTask(taskId: string, agentKey: string, error: string): void {
  run("UPDATE tasks SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", [error, nowIso(), taskId]);
  if (agentKeyExists(agentKey)) {
    run(
      "UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'failed' END, current_task = NULL, last_run_at = ?, run_count = run_count + 1, failure_count = failure_count + 1 WHERE key = ?",
      [nowIso(), agentKey],
    );
  }
  notify({ kind: "agent_failure", subject: "Agent execution failed", body: `${agentKey}: ${error}` });
}

export function planTask(agentKey: string, workflowId: string, title: string, detail = ""): string {
  const id = `task_${randomId()}`;
  run("INSERT INTO tasks (id, workflow_id, agent_key, title, status, detail, created_at) VALUES (?, ?, ?, ?, 'planned', ?, ?)", [
    id,
    workflowId,
    agentKey,
    title,
    detail,
    nowIso(),
  ]);
  return id;
}

export function pauseAllAgents(paused: boolean): number {
  const res = getSetting<{ paused_at?: string }>("agent_run_state", {});
  run(
    "UPDATE agents SET status = CASE WHEN enabled = 1 THEN ? ELSE 'disabled' END, current_task = NULL",
    [paused ? "paused" : "idle"],
  );
  run("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'agent_run_state'", [
    JSON.stringify({ ...res, paused_at: paused ? nowIso() : null }),
    nowIso(),
  ]);
  const count = one<{ c: number }>("SELECT COUNT(*) AS c FROM agents WHERE enabled = 1")?.c ?? 0;
  audit({ action: paused ? "agents.paused" : "agents.resumed", entity: "agents", detail: `${count} agents ${paused ? "paused" : "resumed"}` });
  return count;
}

/** Pause or resume one agent without touching its task or workflow history. */
export function setAgentPaused(key: string, paused: boolean): boolean {
  const agent = one<{ enabled: number }>("SELECT enabled FROM agents WHERE key = ?", [key]);
  if (!agent || agent.enabled !== 1) return false;
  run("UPDATE agents SET status = ?, current_task = CASE WHEN ? = 1 THEN NULL ELSE current_task END WHERE key = ?", [
    paused ? "paused" : "idle",
    paused ? 1 : 0,
    key,
  ]);
  audit({
    action: paused ? "agent.paused" : "agent.resumed",
    entity: "agent",
    entityId: key,
    detail: paused ? "Explicit administrator pause" : "Administrator resumed the agent",
  });
  return true;
}

export function agentsPaused(): boolean {
  return one<{ c: number }>("SELECT COUNT(*) AS c FROM agents WHERE enabled = 1 AND status != 'paused'")?.c === 0;
}

/* ------------------------------- discovery ------------------------------- */

export async function runDiscovery(userId: string, pages = 2): Promise<WorkflowOutcome> {
  if (agentsPaused()) {
    return { workflowId: "", status: "paused", summary: "All agents are paused. Resume them before starting a search.", details: [] };
  }
  const workflowId = createWorkflow("discovery", "Job discovery run");
  const coordinatorTask = startTask("coordinator", workflowId, "Plan discovery run", `Search ${pages} page(s) of configured sources`);
  const details: string[] = [];

  if (!agentEnabled("research")) {
    failTask(coordinatorTask, "coordinator", "The Job Research Agent is disabled or paused.");
    finishWorkflow(workflowId, "failed", "Research agent unavailable");
    return { workflowId, status: "failed", summary: "The Job Research Agent is disabled. Enable it in Agent management.", details };
  }
  const researchAvailability = agentAvailability("research");
  if (!researchAvailability.available) {
    const message = `${researchAvailability.dependency}: ${researchAvailability.reason}`;
    failTask(coordinatorTask, "coordinator", message);
    finishWorkflow(workflowId, "failed", message);
    return { workflowId, status: "failed", summary: message, details };
  }

  completeTask(coordinatorTask, "coordinator", "Discovery workflow planned; research agent assigned.");
  const researchTask = startTask(
    "research",
    workflowId,
    "Search job sources for QA vacancies",
    "Arbeitnow public feed · QA titles · Switzerland or remote",
  );

  let research;
  try {
    research = await researchJobs(pages, 40);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown discovery error";
    failTask(researchTask, "research", message);
    finishWorkflow(workflowId, "failed", message);
    return { workflowId, status: "failed", summary: `Discovery failed: ${message}`, details };
  }

  if (research.error && research.inserted === 0) {
    failTask(researchTask, "research", research.error);
    finishWorkflow(workflowId, "failed", research.error);
    return { workflowId, status: "failed", summary: research.error, details };
  }

  const rejectionSummary = Object.entries(research.rejectionReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([reason, count]) => `${count} ${reason.toLowerCase()}`)
    .join(", ");
  completeTask(
    researchTask,
    "research",
    `${research.fetched} source postings fetched over ${research.pages} page(s); ${research.inserted} new, ${research.duplicates} duplicate(s), ${research.filteredOut} rejected.${rejectionSummary ? ` Rejections: ${rejectionSummary}.` : ""} Only validated source records were stored.`,
  );
  details.push(`${research.fetched} fetched · ${research.inserted} new · ${research.duplicates} duplicates · ${research.filteredOut} rejected`);
  if (rejectionSummary) details.push(`Rejected: ${rejectionSummary}`);

  let analysed = 0;
  if (research.inserted > 0) {
    if (!agentEnabled("analysis")) {
      details.push("Analysis skipped: the Job Analysis Agent is disabled.");
    } else {
      const analysisTask = startTask("analysis", workflowId, `Score ${research.inserted} new vacancies`, "Weighted match scoring against the verified profile");
      try {
        analysed = analysePendingJobs(research.jobs.map((j) => j.id));
        completeTask(analysisTask, "analysis", `${analysed} vacancies scored against the professional profile.`);
        details.push(`${analysed} vacancies analysed`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Analysis failed";
        failTask(analysisTask, "analysis", message);
        details.push(`Analysis failed: ${message}`);
      }
    }
  }

  const strong = all<{ id: string; title: string; company: string; match_score: number }>(
    "SELECT id, title, company, match_score FROM jobs WHERE match_flag = 'strong' ORDER BY match_score DESC LIMIT 5",
  );
  if (strong.length > 0) {
    notify({
      userId,
      kind: "strong_match",
      subject: `${strong.length} strong match${strong.length === 1 ? "" : "es"} found`,
      body: strong.map((j) => `${j.title} at ${j.company} — ${j.match_score}%`).join("\n"),
    });
  }

  const summary = `${research.inserted} new vacancies discovered, ${analysed} analysed.`;
  finishWorkflow(workflowId, "completed", summary);
  audit({ action: "workflow.discovery", entity: "workflow", entityId: workflowId, detail: summary, userId });
  return { workflowId, status: "completed", summary, details };
}

export function analysePendingJobs(jobIds?: string[]): number {
  const profile = getProfileData();
  const rows = jobIds?.length
    ? all<JobRow>("SELECT * FROM jobs WHERE id IN (" + jobIds.map(() => "?").join(",") + ")", jobIds)
    : all<JobRow>("SELECT * FROM jobs WHERE match_score IS NULL AND status != 'rejected' LIMIT 100");
  let count = 0;
  for (const row of rows) {
    const analysis = analyseJob(
      {
        title: row.title,
        company: row.company,
        location: row.location,
        description: row.description,
        remote: row.remote,
        tags: [],
        salary: row.salary,
      },
      profile,
    );
    run("UPDATE jobs SET match_score = ?, match_flag = ?, analysis = ?, ai_note = NULL, language_text = ? WHERE id = ?", [
      analysis.score,
      analysis.flag,
      JSON.stringify(analysis),
      analysis.languages.join(", ") || null,
      row.id,
    ]);
    count += 1;
  }
  return count;
}

export function analyseSingleJob(jobId: string): JobAnalysis | null {
  const row = one<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
  if (!row) return null;
  const profile = getProfileData();
  const analysis = analyseJob(
    { title: row.title, company: row.company, location: row.location, description: row.description, remote: row.remote, salary: row.salary },
    profile,
  );
  run("UPDATE jobs SET match_score = ?, match_flag = ?, analysis = ?, ai_note = NULL, language_text = ? WHERE id = ?", [
    analysis.score,
    analysis.flag,
    JSON.stringify(analysis),
    analysis.languages.join(", ") || null,
    jobId,
  ]);
  return analysis;
}

/* ------------------------------- documents ------------------------------- */

async function storeArtifact(options: {
  userId: string;
  kind: "tailored_cv" | "cover_letter";
  job: JobRow;
  model: DocModel;
  version: string;
  atsScore: number;
  atsReport: unknown;
  text: string;
}): Promise<{ pdfId: string; docxId: string }> {
  const base = documentFileBase(getProfileData(), jobFromRow(options.job as unknown as Record<string, unknown>), options.kind === "tailored_cv" ? "cv" : "cover_letter", options.version);
  const pdfBuffer = await renderPdf(options.model);
  const docxBuffer = await renderDocx(options.model);
  const pdfName = `${base}.pdf`;
  const docxName = `${base}.docx`;
  const createdAt = nowIso();

  await writeFile(path.join(UPLOAD_DIR, pdfName), pdfBuffer);
  await writeFile(path.join(UPLOAD_DIR, docxName), docxBuffer);

  const label = options.kind === "tailored_cv" ? "Tailored CV" : "Cover letter";
  const pdfId = `doc_${randomId()}`;
  const docxId = `doc_${randomId()}`;

  const insert = (id: string, format: "pdf" | "docx", fileName: string, bytes: Buffer, mime: string) => {
    run(
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, ats_score, ats_report, text_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      [
        id,
        options.userId,
        options.kind,
        `${label} · ${options.job.company} — ${options.job.title} (${format.toUpperCase()}, v${options.version})`,
        fileName,
        mime,
        fileName,
        bytes.length,
        options.job.id,
        options.version,
        options.atsScore,
        JSON.stringify(options.atsReport),
        options.text,
        createdAt,
      ],
    );
  };
  insert(pdfId, "pdf", pdfName, pdfBuffer, "application/pdf");
  insert(docxId, "docx", docxName, docxBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  return { pdfId, docxId };
}

async function agentNote(agentKey: string, workflowId: string, taskId: string, prompt: string, technical = false): Promise<string | null> {
  const definition = agentDefinition(agentKey);
  if (!definition) return null;
  markAgentThinking(agentKey);
  try {
    const result = await generateText({
      agentKey,
      workflowId,
      system: definition.instructions,
      prompt,
      maxTokens: 320,
      temperature: 0.15,
      technical,
    });
    run("UPDATE tasks SET provider = ?, model = ?, attempts = attempts + 1 WHERE id = ?", [result.provider, result.model, taskId]);
    return `${result.provider}/${result.model}: ${result.text.replace(/\s+/g, " ").slice(0, 420)}`;
  } catch {
    return null;
  } finally {
    markAgentWorking(agentKey);
  }
}

export type PackageOutcome = {
  ok: boolean;
  message: string;
  applicationId?: string;
  atsScore?: number;
  cvDocumentId?: string;
  coverDocumentId?: string;
  warnings: string[];
};

/** CV + cover letter + ATS audit + application record for one vacancy. */
export async function generateApplicationPackage(
  userId: string,
  jobId: string,
  options: { workflowId?: string; notes?: Record<string, string> } = {},
): Promise<PackageOutcome> {
  const job = one<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
  if (!job) return { ok: false, message: "Vacancy not found.", warnings: [] };
  if (!agentEnabled("cv") || !agentEnabled("cover")) {
    return { ok: false, message: "The CV or Cover Letter Agent is disabled. Enable them in Agent management.", warnings: [] };
  }

  const profile = getProfileData();
  if (!profile.profile.full_name || profile.skills.length === 0) {
    return { ok: false, message: "The master profile is incomplete. Add your name and skills first.", warnings: [] };
  }

  const workflowId = options.workflowId ?? createWorkflow("documents", `Application package · ${job.company}`);
  const details: string[] = [];
  const coordinatorTask = options.workflowId ? null : startTask("coordinator", workflowId, "Assign document workflow", `${job.title} at ${job.company}`);

  let analysis: JobAnalysis;
  const existingAnalysis = job.analysis ? (JSON.parse(job.analysis) as JobAnalysis) : null;
  analysis = existingAnalysis ?? analyseSingleJob(job.id) ?? analyseJob({ title: job.title, company: job.company, location: job.location, description: job.description, remote: job.remote, salary: job.salary }, profile);
  if (coordinatorTask) completeTask(coordinatorTask, "coordinator", "Document workflow assigned to CV, cover letter and ATS agents.");

  const versionRow = one<{ c: number }>("SELECT COUNT(DISTINCT version) AS c FROM documents WHERE job_id = ?", [job.id]);
  const version = `${(versionRow?.c ?? 0) + 1}.0`;

  const cvTask = startTask("cv", workflowId, "Generate tailored CV", `Version ${version} · ${job.company}`);
  const cvModel = buildCvModel(profile, jobFromRow(job as unknown as Record<string, unknown>), analysis);
  const cvText = modelToText(cvModel);
  const cvAts = assessAts(cvText, job.description ?? "", profile);
  const cvDocs = await storeArtifact({
    userId,
    kind: "tailored_cv",
    job,
    model: cvModel,
    version,
    atsScore: cvAts.score,
    atsReport: cvAts,
    text: cvText,
  });
  const cvNote = options.workflowId
    ? await agentNote(
        "cv",
        workflowId,
        cvTask,
        `Vacancy: ${job.title} at ${job.company}. Verified skills: ${profile.skills.map((s) => s.name).join(", ")}. Current summary: ${profile.profile.summary ?? ""}. Produce one ATS-aligned summary paragraph using only these facts.`,
      )
    : null;
  completeTask(
    cvTask,
    "cv",
    `Tailored CV generated in PDF and DOCX (v${version}), ATS self-check ${cvAts.score}/100.${cvNote ? ` AI suggestion — ${cvNote}` : " Deterministic tailoring used."}`,
  );
  details.push(`CV v${version}: PDF + DOCX, ATS ${cvAts.score}/100`);

  // Quality control runs on the CV before a cover letter is produced. A CV that
  // references unsupported facts can never proceed to the next stage.
  const atsTask = startTask("ats", workflowId, "Quality control audit", "Compare the tailored CV with the verified profile before the cover letter");
  const unsupported = cvAts.checks.find((c) => c.label === "No unsupported claims");
  if (unsupported && !unsupported.ok) {
    failTask(atsTask, "ats", "Documents reference technologies the profile does not support.");
    run("UPDATE documents SET status = 'blocked' WHERE job_id = ? AND version = ?", [job.id, version]);
    if (!options.workflowId) finishWorkflow(workflowId, "failed", "ATS audit blocked the package");
    notify({ userId, kind: "ats_blocked", subject: "Documents blocked by quality control", body: `${job.title} at ${job.company}: ${unsupported.detail}` });
    return {
      ok: false,
      message: `Quality control blocked the documents: ${unsupported.detail}`,
      atsScore: cvAts.score,
      warnings: cvAts.warnings,
      cvDocumentId: cvDocs.pdfId,
    };
  }
  completeTask(
    atsTask,
    "ats",
    `CV approved: ${cvAts.score}/100, keyword coverage ${cvAts.keywordCoverage}%. Deterministic checks passed; the ATS gate does not delegate pass/fail decisions to a language model.`,
  );

  const coverTask = startTask("cover", workflowId, "Generate cover letter", `${job.company} — ${job.title}`);
  const coverModel = buildCoverLetterModel(profile, jobFromRow(job as unknown as Record<string, unknown>), analysis);
  const coverText = modelToText(coverModel);
  const coverAts = assessAts(coverText, job.description ?? "", profile);
  const coverDocs = await storeArtifact({
    userId,
    kind: "cover_letter",
    job,
    model: coverModel,
    version,
    atsScore: coverAts.score,
    atsReport: coverAts,
    text: coverText,
  });
  const coverNote = options.workflowId
    ? await agentNote(
        "cover",
        workflowId,
        coverTask,
        `Vacancy: ${job.title} at ${job.company} (${job.location ?? "Switzerland"}). Verified experience: ${profile.experiences.map((e) => `${e.title} at ${e.company}`).join("; ")}. Matched skills: ${analysis.matched.slice(0, 8).join(", ")}. Draft 150 words, no invented facts.`,
      )
    : null;
  completeTask(
    coverTask,
    "cover",
    `Cover letter generated in PDF and DOCX (v${version}), ATS ${coverAts.score}/100.${coverNote ? ` AI draft — ${coverNote}` : " Deterministic letter used."}`,
  );
  const warnings = [...new Set([...cvAts.warnings, ...coverAts.warnings])];
  details.push(`Cover letter v${version}: PDF + DOCX`);

  const approval = getSetting<boolean>("approval_mode", true);
  const existingApp = one<{ id: string; status: string }>("SELECT id, status FROM applications WHERE job_id = ?", [job.id]);
  let applicationId: string;
  if (existingApp) {
    applicationId = existingApp.id;
    run(
      "UPDATE applications SET cv_document_id = ?, cover_letter_id = ?, status = CASE WHEN status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN status ELSE ? END, last_update = ? WHERE id = ?",
      [cvDocs.pdfId, coverDocs.pdfId, approval ? "awaiting_approval" : "documents_preparing", nowIso(), applicationId],
    );
  } else {
    applicationId = `app_${randomId()}`;
    run(
      "INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, method, last_update, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        applicationId,
        job.id,
        approval ? "awaiting_approval" : "documents_preparing",
        cvDocs.pdfId,
        coverDocs.pdfId,
        "employer_portal",
        nowIso(),
        nowIso(),
      ],
    );
  }
  run("UPDATE jobs SET status = CASE WHEN status = 'rejected' THEN status ELSE 'documents' END WHERE id = ?", [job.id]);
  run("UPDATE documents SET status = ? WHERE job_id = ? AND version = ?", [approval ? "awaiting_approval" : "ready", job.id, version]);

  notify({
    userId,
    kind: "documents_ready",
    subject: `Documents ready: ${job.title} at ${job.company}`,
    body: `ATS self-check ${cvAts.score}/100. ${approval ? "Awaiting your approval before submission." : "Approval mode is off — review before submitting."}`,
  });
  if (!options.workflowId) finishWorkflow(workflowId, "completed", `Package prepared (${flagLabel(analysis.flag)})`);
  audit({ action: "documents.generated", entity: "job", entityId: job.id, detail: `CV and cover letter v${version} generated`, userId });
  return {
    ok: true,
    message: `Application package generated. ATS self-check ${cvAts.score}/100.`,
    applicationId,
    atsScore: cvAts.score,
    cvDocumentId: cvDocs.pdfId,
    coverDocumentId: coverDocs.pdfId,
    warnings,
  };
}

export async function runCoordinatorCycle(userId: string): Promise<WorkflowOutcome> {
  const discovery = await runDiscovery(userId, 2);
  return discovery;
}

export function recentTasks(limit = 40) {
  return all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", [limit]);
}

export function tasksForWorkflow(workflowId: string) {
  return all("SELECT * FROM tasks WHERE workflow_id = ? ORDER BY created_at ASC", [workflowId]);
}

export function recentWorkflows(limit = 10) {
  return all("SELECT * FROM workflows ORDER BY created_at DESC LIMIT ?", [limit]);
}
