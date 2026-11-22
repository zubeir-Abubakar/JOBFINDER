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
  modelToText,
  renderDocx,
  renderPdf,
  type DocModel,
} from "./docgen";
import { assessAts } from "./ats";
import { loadMasterCv } from "./master-cv";
import {
  deterministicCoverLetter,
  deterministicSummary,
  generateCoverLetter,
  tailorCv,
  type CoverLetterContent,
  type TailoredCv,
} from "./document-ai";
import {
  combinePackageQuality,
  extractPdfForQuality,
  validateCoverQuality,
  validateCvQuality,
  type DocumentQuality,
} from "./document-quality";
import { getSetting } from "./settings";
import { notify } from "./notify";
import { audit } from "./audit";
import { generateText, scrubProviderError } from "./providers";
import { enqueueAiJob, isQueueableAiError } from "./ai-queue";
import { agentDefinition } from "./agent-definitions";
import { agentIdentity } from "./agent-identity";
import {
  classifyTaskError,
  dependencyJson,
  dependencyReadiness,
  taskTypeFor,
  type TaskErrorClass,
  type TaskType,
} from "./task-contract";
import { agentAvailability } from "./agent-availability";
import { emitWorkflowEvent } from "./events";
import { resolveCoverLetterRequirements } from "./cover-letter-requirements";

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

export function createWorkflow(kind: string, label: string, startedBy: string | null = null): string {
  const id = `wf_${randomId()}`;
  run("INSERT INTO workflows (id, kind, label, status, started_by, created_at) VALUES (?, ?, ?, 'running', ?, ?)", [id, kind, label, startedBy, nowIso()]);
  emitWorkflowEvent({ workflowId: id, type: "workflow.started", agentKey: "coordinator", message: `${label} started. Agents execute sequentially.` });
  return id;
}

export function finishWorkflow(id: string, status: "completed" | "failed" | "paused", summary: string): void {
  run("UPDATE workflows SET status = ?, summary = ?, finished_at = ? WHERE id = ?", [status, summary, nowIso(), id]);
  emitWorkflowEvent({
    workflowId: id,
    type: status === "completed" ? "workflow.completed" : status === "failed" ? "workflow.failed" : "workflow.paused",
    agentKey: "coordinator",
    message: summary.slice(0, 500),
  });
}

export type StartTaskOptions = {
  taskType?: TaskType;
  dependsOn?: string[];
  inputRefs?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
};

/** Thrown after the blocked task record has been persisted. */
export class TaskBlockedError extends Error {
  readonly taskId: string;
  constructor(taskId: string, message: string) {
    super(message);
    this.name = "TaskBlockedError";
    this.taskId = taskId;
  }
}

function runIdForWorkflow(workflowId: string): string | null {
  return one<{ id: string }>("SELECT id FROM recruitment_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1", [workflowId])?.id ?? null;
}

export function startTask(
  agentKey: string,
  workflowId: string,
  title: string,
  detail = "",
  options: StartTaskOptions = {},
): string {
  const row = one<{ enabled: number; status: string }>("SELECT enabled, status FROM agents WHERE key = ?", [agentKey]);
  if (row && (row.enabled !== 1 || row.status === "paused")) {
    throw new Error(`${agentIdentity(agentKey).name} is paused or disabled. Resume it in Agent management before executing this step.`);
  }
  const availability = agentAvailability(agentKey);
  if (!availability.available) {
    throw new Error(`${agentIdentity(agentKey).name} is unavailable. Missing dependency: ${availability.dependency}. ${availability.reason}`);
  }
  const id = `task_${randomId()}`;
  const at = nowIso();
  const taskType = options.taskType ?? taskTypeFor(agentKey, title);
  const dependsOn = dependencyJson(options.dependsOn);
  const inputRefs = options.inputRefs ? JSON.stringify(options.inputRefs) : null;
  const readiness = dependencyReadiness(options.dependsOn ?? []);

  if (!readiness.ready) {
    const reason = readiness.reason ?? "A prerequisite task is not complete.";
    run(
      `INSERT INTO tasks
         (id, workflow_id, run_id, agent_key, title, status, detail, execution_mode, task_type, depends_on, input_refs, state_reason, error, error_class, recovery_state, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, 'blocked', ?, 'deterministic', ?, ?, ?, ?, ?, 'dependency', 'blocked', ?, ?)`,
      [
        id,
        workflowId,
        runIdForWorkflow(workflowId),
        agentKey,
        title,
        detail,
        taskType,
        dependsOn,
        inputRefs,
        reason.slice(0, 1200),
        reason.slice(0, 1200),
        options.idempotencyKey ?? null,
        at,
      ],
    );
    emitWorkflowEvent({
      workflowId,
      type: "agent.blocked",
      agentKey,
      message: `${agentIdentity(agentKey).shortName} blocked: ${reason}`,
      meta: { taskId: id, dependsOn: options.dependsOn ?? [], detail },
    });
    throw new TaskBlockedError(id, reason);
  }

  run(
    `INSERT INTO tasks
       (id, workflow_id, run_id, agent_key, title, status, detail, execution_mode, task_type, depends_on, input_refs, heartbeat_at, idempotency_key, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, 'queued', ?, 'deterministic', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workflowId,
      runIdForWorkflow(workflowId),
      agentKey,
      title,
      detail,
      taskType,
      dependsOn,
      inputRefs,
      at,
      options.idempotencyKey ?? null,
      at,
      at,
    ],
  );
  emitWorkflowEvent({ workflowId, type: "agent.queued", agentKey, message: `${agentIdentity(agentKey).shortName} queued: ${title}`, meta: { taskId: id, detail } });
  run("UPDATE tasks SET status = 'running', heartbeat_at = ? WHERE id = ?", [at, id]);
  if (agentKeyExists(agentKey)) {
    run("UPDATE agents SET status = 'working', current_task = ? WHERE key = ?", [title, agentKey]);
  }
  emitWorkflowEvent({
    workflowId,
    type: "agent.started",
    agentKey,
    message: `${agentIdentity(agentKey).shortName} started: ${title}`,
    meta: { taskId: id, detail },
  });
  return id;
}

/** Refresh the durable lease for one task without changing its state. */
export function heartbeatTask(taskId: string): void {
  run("UPDATE tasks SET heartbeat_at = ? WHERE id = ? AND status IN ('running','working','thinking','waiting_provider','retry_scheduled')", [nowIso(), taskId]);
}

function heartbeatActiveTask(agentKey: string): void {
  const task = one<{ id: string; workflow_id: string | null }>(
    "SELECT id, workflow_id FROM tasks WHERE agent_key = ? AND status IN ('running','working','thinking') ORDER BY created_at DESC LIMIT 1",
    [agentKey],
  );
  if (task) {
    heartbeatTask(task.id);
  }
}

/** A real inference request is in flight, so the agent is Thinking, not Working. */
export function markAgentThinking(agentKey: string): void {
  run("UPDATE agents SET status = 'thinking' WHERE key = ? AND status = 'working'", [agentKey]);
  const task = one<{ id: string; workflow_id: string | null }>("SELECT id, workflow_id FROM tasks WHERE agent_key = ? AND status = 'running' ORDER BY created_at DESC LIMIT 1", [agentKey]);
  if (task) heartbeatTask(task.id);
  if (task?.workflow_id) {
    emitWorkflowEvent({ workflowId: task.workflow_id, type: "agent.progress", agentKey, message: `${agentIdentity(agentKey).shortName} is requesting inference from the configured AI provider.` });
  }
}

export function markAgentWorking(agentKey: string): void {
  run("UPDATE agents SET status = 'working' WHERE key = ? AND status = 'thinking'", [agentKey]);
  heartbeatActiveTask(agentKey);
}

/** Durable non-terminal task states used by provider/document recovery. */
export function setTaskWaiting(
  taskId: string,
  agentKey: string,
  state: "waiting_provider" | "retry_scheduled" | "waiting_intervention",
  reason: string,
  nextRetryAt: string | null = null,
): void {
  run("UPDATE tasks SET status = ?, state_reason = ?, next_retry_at = ?, heartbeat_at = ?, recovery_state = ? WHERE id = ?", [state, reason.slice(0, 1200), nextRetryAt, nowIso(), state, taskId]);
  if (agentKeyExists(agentKey)) {
    run("UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'idle' END, current_task = NULL WHERE key = ?", [agentKey]);
  }
}

export function resumeTask(taskId: string, agentKey: string): void {
  run(
    `UPDATE tasks
     SET status = 'running', state_reason = NULL, next_retry_at = NULL,
         started_at = COALESCE(started_at, ?), heartbeat_at = ?,
         retry_count = retry_count + 1, recovery_state = 'resumed', error_class = NULL
     WHERE id = ?`,
    [nowIso(), nowIso(), taskId],
  );
  if (agentKeyExists(agentKey)) run("UPDATE agents SET status = 'working' WHERE key = ?", [agentKey]);
}

export function completeTask(
  taskId: string,
  agentKey: string,
  output: string,
  requiresInput = false,
  metadata: { outputRefs?: Record<string, unknown> | null; recoveryState?: string | null } = {},
): void {
  run(
    `UPDATE tasks
     SET status = 'completed', output = ?, requires_input = ?, finished_at = ?,
         heartbeat_at = NULL, error = NULL, error_class = NULL,
         output_refs = COALESCE(?, output_refs),
         recovery_state = COALESCE(?, recovery_state)
     WHERE id = ?`,
    [
      output,
      v(requiresInput),
      nowIso(),
      metadata.outputRefs ? JSON.stringify(metadata.outputRefs) : null,
      metadata.recoveryState ?? null,
      taskId,
    ],
  );
  const completedTask = one<{ workflow_id: string | null }>("SELECT workflow_id FROM tasks WHERE id = ?", [taskId]);
  if (completedTask?.workflow_id) {
    emitWorkflowEvent({
      workflowId: completedTask.workflow_id,
      type: "agent.completed",
      agentKey,
      message: `${agentIdentity(agentKey).shortName} completed ${completedTask ? "its step" : "a task"}: ${output.replace(/\s+/g, " ").slice(0, 220)}`,
      meta: { taskId },
    });
  }
  if (agentKeyExists(agentKey)) {
    // AI counters are updated by recordUsage(), which owns the link between a
    // task-bound call and the roster. This function only records task success.
    run(
      `UPDATE agents
         SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'completed' END,
             current_task = NULL,
             last_run_at = ?,
             run_count = run_count + 1,
             success_count = success_count + 1
       WHERE key = ?`,
      [nowIso(), agentKey],
    );
  }
}

export function failTask(taskId: string, agentKey: string, error: string, errorClass?: TaskErrorClass): void {
  const failedTask = one<{ workflow_id: string | null }>("SELECT workflow_id FROM tasks WHERE id = ?", [taskId]);
  run(
    "UPDATE tasks SET status = 'failed', error = ?, error_class = ?, recovery_state = 'failed', heartbeat_at = NULL, finished_at = ? WHERE id = ?",
    [error, errorClass ?? classifyTaskError(error), nowIso(), taskId],
  );
  if (failedTask?.workflow_id) {
    emitWorkflowEvent({ workflowId: failedTask.workflow_id, type: "agent.failed", agentKey, message: `${agentIdentity(agentKey).shortName} failed: ${error.slice(0, 300)}`, meta: { taskId } });
  }
  if (agentKeyExists(agentKey)) {
    run(
      "UPDATE agents SET status = CASE WHEN status = 'paused' THEN 'paused' ELSE 'failed' END, current_task = NULL, last_run_at = ?, run_count = run_count + 1, failure_count = failure_count + 1 WHERE key = ?",
      [nowIso(), agentKey],
    );
  }
  notify({ kind: "agent_failure", subject: "Agent execution failed", body: `${agentKey}: ${error}` });
}

export function planTask(
  agentKey: string,
  workflowId: string,
  title: string,
  detail = "",
  options: Pick<StartTaskOptions, "taskType" | "dependsOn" | "inputRefs" | "idempotencyKey"> = {},
): string {
  const id = `task_${randomId()}`;
  const at = nowIso();
  run(
    `INSERT INTO tasks
       (id, workflow_id, run_id, agent_key, title, status, detail, task_type, depends_on, input_refs, idempotency_key, created_at)
     VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      workflowId,
      runIdForWorkflow(workflowId),
      agentKey,
      title,
      detail,
      options.taskType ?? taskTypeFor(agentKey, title),
      dependencyJson(options.dependsOn),
      options.inputRefs ? JSON.stringify(options.inputRefs) : null,
      options.idempotencyKey ?? null,
      at,
    ],
  );
  emitWorkflowEvent({ workflowId, type: "agent.queued", agentKey, message: `${agentIdentity(agentKey).shortName} queued: ${title}`, meta: { taskId: id } });
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
  const workflowId = createWorkflow("discovery", "Job discovery run", userId);
  const coordinatorTask = startTask("coordinator", workflowId, "Plan discovery run", `Search ${pages} page(s) of configured sources`);
  const details: string[] = [];

  if (!agentEnabled("research")) {
    failTask(coordinatorTask, "coordinator", `${agentIdentity("research").name} is disabled or paused.`);
    finishWorkflow(workflowId, "failed", `${agentIdentity("research").name} unavailable`);
    return { workflowId, status: "failed", summary: `${agentIdentity("research").name} is disabled. Enable the agent in Agent management.`, details };
  }
  const researchAvailability = agentAvailability("research");
  if (!researchAvailability.available) {
    const message = `${researchAvailability.dependency}: ${researchAvailability.reason}`;
    failTask(coordinatorTask, "coordinator", message);
    finishWorkflow(workflowId, "failed", message);
    return { workflowId, status: "failed", summary: message, details };
  }

  completeTask(coordinatorTask, "coordinator", `Discovery workflow planned; ${agentIdentity("research").name} assigned.`);
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
      details.push("Analysis skipped: Ali is disabled.");
    } else {
      const analysisTask = startTask("analysis", workflowId, `Score ${research.inserted} new vacancies`, "Weighted match scoring against the verified profile");
      try {
        analysed = analysePendingJobs(research.jobs.map((j) => j.id));
        const best = one<{ id: string }>("SELECT id FROM jobs WHERE match_flag = 'strong' ORDER BY match_score DESC LIMIT 1");
        // Advisory only: the weighted score remains the stored, authoritative result.
        const note = best ? await annotateAnalysis({ workflowId, taskId: analysisTask, jobId: best.id }) : null;
        completeTask(
          analysisTask,
          "analysis",
          `${analysed} vacancies scored against the professional profile.${note?.ok ? ` AI assessment — ${note.note}` : note?.queued ? " AI narrative queued; deterministic evidence remains authoritative." : ""}`,
        );
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
      email: false,
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

type RenderedArtifact = { pdfBuffer: Buffer; docxBuffer: Buffer; text: string; pages: number };

async function renderArtifact(model: DocModel): Promise<RenderedArtifact> {
  const pdfBuffer = await renderPdf(model);
  const docxBuffer = await renderDocx(model);
  const extracted = await extractPdfForQuality(pdfBuffer);
  return { pdfBuffer, docxBuffer, text: extracted.text, pages: extracted.pages };
}

async function storeArtifact(options: {
  userId: string;
  kind: "tailored_cv" | "cover_letter";
  job: JobRow;
  model: DocModel;
  version: string;
  atsScore: number | null;
  atsReport: unknown;
  quality: DocumentQuality;
  rendered: RenderedArtifact;
}): Promise<{ pdfId: string; docxId: string }> {
  const base = documentFileBase(options.model, options.version);
  const { pdfBuffer, docxBuffer, text } = options.rendered;
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
      `INSERT INTO documents (id, user_id, kind, display_name, file_name, mime, relative_path, size_bytes, job_id, version, status, ats_score, ats_report, quality_status, quality_score, quality_report, text_content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
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
        options.quality.status,
        options.quality.score,
        JSON.stringify(options.quality),
        text,
        createdAt,
      ],
    );
  };
  insert(pdfId, "pdf", pdfName, pdfBuffer, "application/pdf");
  insert(docxId, "docx", docxName, docxBuffer, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");

  return { pdfId, docxId };
}

type AgentNoteResult =
  | { ok: true; note: string; text: string; provider: string; model: string }
  | { ok: false; queued?: boolean; jobId?: string; reason: string | null };

async function agentNote(
  agentKey: string,
  workflowId: string,
  taskId: string,
  prompt: string,
  technical = false,
  options: { queueKind?: "agent_note" | "analysis_note"; jobId?: string } = {},
): Promise<AgentNoteResult> {
  const definition = agentDefinition(agentKey);
  if (!definition) return { ok: false, reason: "No agent definition is registered." };
  markAgentThinking(agentKey);
  heartbeatTask(taskId);
  try {
    const result = await generateText({
      agentKey,
      workflowId,
      taskId,
      source: "task",
      system: definition.instructions,
      prompt,
      maxTokens: 320,
      temperature: 0.15,
      technical,
    });
    run(
      "UPDATE tasks SET provider = ?, model = ?, attempts = attempts + 1, execution_mode = 'ai', ai_outcome = 'ok' WHERE id = ?",
      [result.provider, result.model, taskId],
    );
    const text = result.text.replace(/\s+/g, " ").slice(0, 420);
    return { ok: true, note: `${result.provider}/${result.model}: ${text}`, text, provider: result.provider, model: result.model };
  } catch (error) {
    // Optional advisory work is queued when the gateway is cooling down or
    // unreachable. The deterministic task is not failed, and no work is
    // discarded; the queue keeps the task id for telemetry.
    if (isQueueableAiError(error)) {
      try {
        const job = enqueueAiJob({
          kind: options.queueKind ?? "agent_note",
          dedupeKey: `task:${taskId}:${options.queueKind ?? "agent_note"}`,
          agentKey,
          workflowId,
          taskId,
          source: "task",
          priority: 2,
          payload: {
            system: definition.instructions,
            prompt,
            maxTokens: 320,
            temperature: 0.15,
            technical,
            jobId: options.jobId ?? null,
          },
        });
        return {
          ok: false,
          queued: true,
          jobId: job.job.id,
          reason: "AI advisory queued until the gateway is available.",
        };
      } catch (queueError) {
        return {
          ok: false,
          reason: scrubProviderError(queueError instanceof Error ? queueError.message : "AI queue failed"),
        };
      }
    }
    // A non-retryable inference failure is recorded as such; it is never
    // silently treated as model output. The task still completes deterministically.
    run("UPDATE tasks SET attempts = attempts + 1, execution_mode = 'ai', ai_outcome = 'failed' WHERE id = ?", [taskId]);
    return { ok: false, reason: scrubProviderError(error instanceof Error ? error.message : "AI draft failed") };
  } finally {
    markAgentWorking(agentKey);
  }
}

/**
 * Advisory narrative for a deterministically scored vacancy. The score, flag,
 * evidence and concerns are never modified: the model only explains the facts
 * that the scoring engine already produced. The note is stored on the vacancy
 * for human review and is not used in any eligibility or submission decision.
 */
export async function annotateAnalysis(input: { workflowId: string; taskId: string; jobId: string }): Promise<AgentNoteResult> {
  const job = one<{ id: string; title: string; company: string; analysis: string | null }>(
    "SELECT id, title, company, analysis FROM jobs WHERE id = ?",
    [input.jobId],
  );
  if (!job) return { ok: false, reason: "Vacancy not found." };
  if (!job.analysis) return { ok: false, reason: "No deterministic analysis is stored for this vacancy." };
  let analysis: JobAnalysis;
  try {
    analysis = JSON.parse(job.analysis) as JobAnalysis;
  } catch {
    return { ok: false, reason: "The stored analysis could not be read." };
  }
  const result = await agentNote(
    "analysis",
    input.workflowId,
    input.taskId,
    `Vacancy: ${job.title} at ${job.company}. Deterministic score: ${analysis.score}% (${analysis.flag}). Matched: ${analysis.matched.slice(0, 10).join(", ") || "none"}. Missing: ${analysis.missing.slice(0, 8).join(", ") || "none"}. Concerns: ${analysis.concerns.slice(0, 4).join(" ") || "none"}. In three sentences, explain suitability, the strongest evidence and the concerns. Do not change the score, add facts, or propose an action.`,
    false,
    { queueKind: "analysis_note", jobId: job.id },
  );
  if (result.ok) run("UPDATE jobs SET ai_note = ? WHERE id = ?", [result.text, job.id]);
  return result;
}

/** Honest wording when no model output was used for a task. */
function aiFallbackText(result: AgentNoteResult | null): string {
  if (!result) return "Deterministic output used; no model was called for this task.";
  if (result.ok) return "";
  if (result.queued) return "Deterministic output used; the AI advisory is queued until the gateway is available.";
  return `Deterministic output used; the AI draft failed${result.reason ? `: ${result.reason}` : " for an unknown reason"}.`;
}

export type PackageOutcome = {
  ok: boolean;
  message: string;
  applicationId?: string;
  atsScore?: number;
  readinessState?: string;
  cvDocumentId?: string;
  coverDocumentId?: string;
  warnings: string[];
};

/** CV + cover letter + ATS audit + application record for one vacancy. */
export async function generateApplicationPackage(
  userId: string,
  jobId: string,
  options: { workflowId?: string; notes?: Record<string, string>; resumeStage?: "cover_only" } = {},
): Promise<PackageOutcome> {
  const job = one<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
  if (!job) return { ok: false, message: "Vacancy not found.", warnings: [] };
  if (!agentEnabled("cv") || !agentEnabled("cover")) {
    return { ok: false, message: `${agentIdentity("cv").name} or ${agentIdentity("cover").name} is disabled. Enable them in Agent management.`, warnings: [] };
  }

  const profile = getProfileData();
  if (!profile.profile.full_name || profile.skills.length === 0) {
    return { ok: false, message: "The master profile is incomplete. Add your name and skills first.", warnings: [] };
  }

  const workflowId = options.workflowId ?? createWorkflow("documents", `Application package · ${job.company}`, userId);
  const details: string[] = [];
  const coordinatorTask = options.workflowId ? null : startTask("coordinator", workflowId, "Assign document workflow", `${job.title} at ${job.company}`);

  let analysis: JobAnalysis;
  const existingAnalysis = job.analysis ? (JSON.parse(job.analysis) as JobAnalysis) : null;
  analysis = existingAnalysis ?? analyseSingleJob(job.id) ?? analyseJob({ title: job.title, company: job.company, location: job.location, description: job.description, remote: job.remote, salary: job.salary }, profile);
  if (coordinatorTask) completeTask(coordinatorTask, "coordinator", "Document workflow assigned to CV, cover letter and ATS agents.");

  let version = "";
  let cvDocs: { pdfId: string; docxId: string } | null = null;
  let cvQuality: DocumentQuality | null = null;
  let cvAts: ReturnType<typeof assessAts> | null = null;
  let cvPages = 0;
  let cvTask: string | null = null;
  let reusedValidCv = false;

  if (options.resumeStage === "cover_only") {
    const reusable = one<{
      id: string;
      version: string;
      quality_report: string | null;
      ats_report: string | null;
      text_content: string | null;
    }>(
      `SELECT id, version, quality_report, ats_report, text_content
       FROM documents
       WHERE job_id = ? AND kind = 'tailored_cv' AND mime = 'application/pdf'
         AND deleted_at IS NULL AND quality_status = 'passed'
       ORDER BY created_at DESC LIMIT 1`,
      [job.id],
    );
    if (reusable?.quality_report) {
      try {
        const quality = JSON.parse(reusable.quality_report) as DocumentQuality;
        const ats = reusable.ats_report ? (JSON.parse(reusable.ats_report) as ReturnType<typeof assessAts>) : null;
        if (quality.status === "passed" && ats) {
          const docx = one<{ id: string }>(
            "SELECT id FROM documents WHERE job_id = ? AND version = ? AND kind = 'tailored_cv' AND mime LIKE '%wordprocessing%' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
            [job.id, reusable.version],
          );
          version = reusable.version;
          cvDocs = { pdfId: reusable.id, docxId: docx?.id ?? "" };
          cvQuality = quality;
          cvAts = ats;
          cvPages = Number(quality.metrics?.pages ?? 1);
          reusedValidCv = true;
        }
      } catch {
        // A corrupt historical report cannot authorize reuse. Fall back to the
        // normal full package path instead of treating it as valid evidence.
      }
    }
  }

  if (!version) {
    const versionRow = one<{ c: number }>("SELECT COUNT(DISTINCT version) AS c FROM documents WHERE job_id = ?", [job.id]);
    version = `${(versionRow?.c ?? 0) + 1}.0`;
  }

  const master = await loadMasterCv(profile);
  if (master.roles.length === 0) {
    return { ok: false, message: "The uploaded CV could not be read. Re-upload it or complete the master profile.", warnings: [] };
  }
  const coverLetterRequirements = resolveCoverLetterRequirements({
    description: job.description,
    requirementsJson: job.requirements ?? null,
    sourceUrl: job.url,
  });
  const jobLike = {
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description ?? "",
    coverLetterRequirements,
  };

  if (!reusedValidCv) {
  cvTask = startTask("cv", workflowId, "Generate tailored CV", `Version ${version} · ${job.company}`, {
    taskType: "cv_generation",
    inputRefs: { jobId: job.id, version, masterCv: profile.profile.source_cv_id ?? null },
    idempotencyKey: `documents:${job.id}:${version}:cv`,
  });
  const aiCv = await tailorCv(master, { job: jobLike, analysis, taskId: cvTask, workflowId });
  let cvOutput: TailoredCv = aiCv;
  let cvModel = buildCvModel({ master, tailored: cvOutput, job: jobLike });
  let cvText = modelToText(cvModel);
  cvAts = assessAts({
    text: cvText,
    jobDescription: job.description ?? "",
    jobTitle: job.title,
    jobCompany: job.company,
    profile,
    sourceText: master.sourceText,
    sourceRoleCount: master.roles.length,
    analysis,
  });
  let cvArtifact = await renderArtifact(cvModel);
  cvQuality = validateCvQuality(master, cvOutput, cvArtifact.text, cvArtifact.pages, jobLike);

  if (cvQuality.status === "failed") {
    cvOutput = {
      summary: deterministicSummary(master, jobLike, analysis),
      roles: master.roles,
      tailoredWithAi: false,
      provider: cvOutput.provider,
      model: cvOutput.model,
      warnings: [...cvOutput.warnings, "AI wording failed the quality gate; the complete master CV was re-rendered without it."],
    };
    cvModel = buildCvModel({ master, tailored: cvOutput, job: jobLike });
    cvText = modelToText(cvModel);
    cvArtifact = await renderArtifact(cvModel);
    cvAts = assessAts({
      text: cvText,
      jobDescription: job.description ?? "",
      jobTitle: job.title,
      jobCompany: job.company,
      profile,
      sourceText: master.sourceText,
      sourceRoleCount: master.roles.length,
      analysis,
    });
    cvQuality = validateCvQuality(master, cvOutput, cvArtifact.text, cvArtifact.pages, jobLike);
  }

  cvDocs = await storeArtifact({
    userId,
    kind: "tailored_cv",
    job,
    model: cvModel,
    version,
    atsScore: cvAts.score,
    atsReport: cvAts,
    quality: cvQuality,
    rendered: cvArtifact,
  });
  cvPages = cvArtifact.pages;

  if (cvQuality.status === "failed") {
    const blockedAtsTask = startTask("ats", workflowId, "Quality control audit", "The CV did not reach the audit stage because preservation and layout validation failed", {
      taskType: "document_validation",
      inputRefs: { jobId: job.id, cvDocumentId: cvDocs.pdfId },
    });
    failTask(blockedAtsTask, "ats", `CV quality gate rejected the output: ${cvQuality.issues.filter((item) => item.severity === "error").map((item) => item.message).join(" ")}`, "validation");
    failTask(cvTask, "cv", "The CV did not pass preservation and layout validation.", "validation");
    run("UPDATE documents SET status = 'blocked' WHERE job_id = ? AND version = ?", [job.id, version]);
    if (!options.workflowId) finishWorkflow(workflowId, "failed", "CV quality gate rejected the package");
    notify({ userId, kind: "ats_blocked", subject: "Documents blocked by quality control", body: `${job.title} at ${job.company}: the generated CV is materially weaker than the uploaded original.` });
    return {
      ok: false,
      message: `Quality control rejected the CV: ${cvQuality.issues.find((item) => item.severity === "error")?.message ?? "validation failed"}`,
      atsScore: cvAts.score,
      cvDocumentId: cvDocs.pdfId,
      warnings: [...new Set([...cvAts.warnings, ...cvQuality.issues.map((item) => item.message)])],
    };
  }
  completeTask(
    cvTask,
    "cv",
    `CV v${version} written from the uploaded master (${master.roles.length} roles, ${master.roles.reduce((sum, role) => sum + role.bullets.length, 0)} bullets). ${cvOutput.tailoredWithAi ? "AI-tailored wording passed grounding checks." : "Deterministic master-CV fallback used."} ATS ${cvAts.score}/100, quality ${cvQuality.status} (${cvQuality.score}/100).`,
    false,
    { outputRefs: { cvDocumentId: cvDocs.pdfId, cvDocxId: cvDocs.docxId, version, pages: cvArtifact.pages, atsScore: cvAts.score } },
  );
  const atsTask = startTask(
    "ats",
    workflowId,
    "Quality control audit",
    "Compare the tailored CV with the uploaded original before the cover letter",
    { taskType: "document_validation", dependsOn: [cvTask], inputRefs: { jobId: job.id, cvDocumentId: cvDocs.pdfId } },
  );
  completeTask(
    atsTask,
    "ats",
    `CV accepted by the preservation gate: ${cvQuality.checks.filter((item) => item.passed).length}/${cvQuality.checks.length} checks passed, ${cvArtifact.pages} page(s), ${cvQuality.metrics.outputBullets}/${cvQuality.metrics.originalBullets} bullets retained.`,
    false,
    { outputRefs: { cvDocumentId: cvDocs.pdfId, pageCount: cvArtifact.pages } },
  );
  details.push(`CV v${version}: PDF + DOCX, ${cvPages} pages, ATS ${cvAts.score}/100, quality ${cvQuality.status}`);
  } else {
    details.push(`CV v${version}: existing validated CV retained; generation was not repeated.`);
  }

  let atsTask: string;
  if (reusedValidCv) {
    atsTask = startTask("ats", workflowId, "Verify reused CV", `Reusing validated CV v${version} for ${job.company}`, {
      taskType: "document_validation",
      inputRefs: { jobId: job.id, cvDocumentId: cvDocs!.pdfId, reused: true },
    });
    completeTask(
      atsTask,
      "ats",
      `Existing CV v${version} already passed its preservation and layout gate; it was reused without regeneration.`,
      false,
      { outputRefs: { cvDocumentId: cvDocs!.pdfId, pageCount: cvPages, reused: true } },
    );
  } else {
    atsTask = startTask(
      "ats",
      workflowId,
      "Quality control audit",
      "Compare the tailored CV with the uploaded original before the cover letter",
      { taskType: "document_validation", dependsOn: [cvTask!], inputRefs: { jobId: job.id, cvDocumentId: cvDocs!.pdfId } },
    );
    completeTask(
      atsTask,
      "ats",
      `CV accepted by the preservation gate: ${cvQuality!.checks.filter((item) => item.passed).length}/${cvQuality!.checks.length} checks passed, ${cvPages} page(s), ${cvQuality!.metrics.outputBullets}/${cvQuality!.metrics.originalBullets} bullets retained.`,
      false,
      { outputRefs: { cvDocumentId: cvDocs!.pdfId, pageCount: cvPages } },
    );
  }

  const coverTask = startTask("cover", workflowId, "Generate cover letter", `${job.company} — ${job.title}`, {
    taskType: "cover_letter_generation",
    dependsOn: [atsTask],
    inputRefs: { jobId: job.id, cvDocumentId: cvDocs!.pdfId, version },
    idempotencyKey: `documents:${job.id}:${version}:cover`,
  });
  const aiCover = await generateCoverLetter(master, {
    job: jobLike,
    analysis,
    taskId: coverTask,
    workflowId,
    coverLetterRequirements,
  });
  let coverOutput: CoverLetterContent = aiCover;
  let coverModel = buildCoverLetterModel({ master, cover: coverOutput, job: jobLike });
  let coverText = modelToText(coverModel);
  let coverArtifact = await renderArtifact(coverModel);
  let coverQuality = validateCoverQuality(master, coverOutput, coverArtifact.text, coverArtifact.pages, { ...jobLike, analysis });

  if (coverQuality.status === "failed") {
    coverOutput = deterministicCoverLetter(master, jobLike, analysis, coverLetterRequirements);
    coverModel = buildCoverLetterModel({ master, cover: coverOutput, job: jobLike });
    coverText = modelToText(coverModel);
    coverArtifact = await renderArtifact(coverModel);
    coverQuality = validateCoverQuality(master, coverOutput, coverArtifact.text, coverArtifact.pages, { ...jobLike, analysis });
  }

  // A cover letter is not a CV. Applying the CV ATS structural rubric here is
  // what produced the misleading Akros 57: the letter has no dedicated
  // Summary/Skills/Experience sections and is not expected to. Its measurement
  // is the document-quality gate above; the CV keeps the ATS compatibility score.
  const coverAtsReport = {
    measurement: "not_applicable",
    note: "Cover letters are evaluated for vacancy-specific evidence, targeting and readability. The CV ATS compatibility rubric is not applicable to this document type.",
    generatedAt: new Date().toISOString(),
  };
  const coverDocs = await storeArtifact({
    userId,
    kind: "cover_letter",
    job,
    model: coverModel,
    version,
    atsScore: null,
    atsReport: coverAtsReport,
    quality: coverQuality,
    rendered: coverArtifact,
  });

  if (coverQuality.status === "failed") {
    failTask(coverTask, "cover", "The cover letter did not pass evidence and layout validation.", "validation");
    run("UPDATE documents SET status = 'blocked' WHERE job_id = ? AND version = ?", [job.id, version]);
    if (!options.workflowId) finishWorkflow(workflowId, "failed", "Cover letter quality gate rejected the package");
    notify({ userId, kind: "ats_blocked", subject: "Documents blocked by quality control", body: `${job.title} at ${job.company}: the cover letter failed the evidence and layout gate.` });
    return {
      ok: false,
      message: `Quality control rejected the cover letter: ${coverQuality.issues.find((item) => item.severity === "error")?.message ?? "validation failed"}`,
      atsScore: cvAts!.score,
      cvDocumentId: cvDocs!.pdfId,
      coverDocumentId: coverDocs.pdfId,
      warnings: [...new Set([...cvAts!.warnings, ...coverQuality.issues.map((item) => item.message)])],
    };
  }
  completeTask(
    coverTask,
    "cover",
    `Cover letter v${version} generated. ${coverOutput.tailoredWithAi ? "AI wording passed evidence checks." : "Deterministic evidence-led letter used."} Document quality ${coverQuality.status} (${coverQuality.score}/100). Length ${coverQuality.coverLetter?.actualWords ?? "unknown"} words / ${coverQuality.coverLetter?.actualCharacters ?? "unknown"} characters against ${
      coverLetterRequirements.source === "recruiter" ? "the explicit recruiter instruction" : "the internal 180–320 word professional default"
    }. A CV ATS compatibility score is not applicable.`,
    false,
    { outputRefs: { coverDocumentId: coverDocs.pdfId, coverDocxId: coverDocs.docxId, version, pages: coverArtifact.pages } },
  );
  const combinedQuality = combinePackageQuality(cvQuality!, coverQuality);
  const warnings = [...new Set([
    ...cvAts!.warnings,
    ...combinedQuality.issues.filter((item) => item.severity === "warning").map((item) => item.message),
  ])];
  details.push(`Cover letter v${version}: PDF + DOCX, document quality ${coverQuality.status} (${coverQuality.score}/100)`);
  details.push(`Package quality: ${combinedQuality.status} (${combinedQuality.score}/100)`);

  // Per-application approval is retired. A package that passed both quality
  // gates goes straight to the independent readiness check; it never waits for
  // the owner to click "approve" on an otherwise eligible application.
  const bothQualityPassed = cvQuality!.status === "passed" && coverQuality.status === "passed";
  const qualityReviewState = bothQualityPassed ? "documents_ready" : "quality_review_required";
  const qualityReasons = [
    ...cvQuality!.issues.filter((item) => item.severity !== "info").map((item) => `CV: ${item.message}`),
    ...coverQuality.issues.filter((item) => item.severity !== "info").map((item) => `Cover letter: ${item.message}`),
  ];
  const readiness = {
    ready: false,
    state: qualityReviewState,
    reasons: qualityReasons.length ? qualityReasons : [`Full readiness is evaluated by ${agentIdentity("ats").name} before submission.`],
    items: [
      { key: "cv_quality", label: "CV passed its document-quality gate", passed: cvQuality!.status === "passed", detail: `${cvQuality!.status} (${cvQuality!.score}/100)` },
      { key: "cover_quality", label: "Cover letter passed its document-quality gate", passed: coverQuality.status === "passed", detail: `${coverQuality.status} (${coverQuality.score}/100)` },
    ],
    checkedAt: nowIso(),
    engine: "document-quality-v2",
  };
  const nextStatus = bothQualityPassed ? "quality_check" : "quality_review_required";
  const existingApp = one<{ id: string; status: string }>("SELECT id, status FROM applications WHERE job_id = ?", [job.id]);
  let applicationId: string;
  if (existingApp) {
    applicationId = existingApp.id;
    run(
      "UPDATE applications SET cv_document_id = ?, cover_letter_id = ?, status = CASE WHEN status IN ('submitted','acknowledged','interview_invited','interview_completed','offer_received') THEN status ELSE ? END, readiness = ?, readiness_checked_at = ?, last_update = ? WHERE id = ?",
      [cvDocs!.pdfId, coverDocs.pdfId, nextStatus, JSON.stringify(readiness).slice(0, 16000), readiness.checkedAt, nowIso(), applicationId],
    );
  } else {
    applicationId = `app_${randomId()}`;
    run(
      "INSERT INTO applications (id, job_id, status, cv_document_id, cover_letter_id, method, readiness, readiness_checked_at, last_update, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        applicationId,
        job.id,
        nextStatus,
        cvDocs!.pdfId,
        coverDocs.pdfId,
        "employer_portal",
        JSON.stringify(readiness).slice(0, 16000),
        readiness.checkedAt,
        nowIso(),
        nowIso(),
      ],
    );
  }
  run("UPDATE jobs SET status = CASE WHEN status = 'rejected' THEN status ELSE 'documents' END WHERE id = ?", [job.id]);
  run("UPDATE documents SET status = ? WHERE job_id = ? AND version = ?", [bothQualityPassed ? "ready" : "quality_review_required", job.id, version]);

  notify({
    userId,
    kind: "documents_ready",
    subject: `${bothQualityPassed ? "Documents ready" : "Documents need review"}: ${job.title} at ${job.company}`,
    body: `CV ATS compatibility ${cvAts!.score}/100. Cover letter quality ${coverQuality.status} (${coverQuality.score}/100). ${bothQualityPassed ? "Quality checks passed; full readiness is evaluated before automatic submission. No per-application approval is required." : "The cover-letter quality gate requires review before this package can become ready."}`,
    email: false,
  });
  if (!options.workflowId) finishWorkflow(workflowId, bothQualityPassed ? "completed" : "paused", `Package prepared (${flagLabel(analysis.flag)})`);
  audit({ action: "documents.generated", entity: "job", entityId: job.id, detail: `CV and cover letter v${version} generated; readiness ${qualityReviewState}`, userId });
  return {
    ok: true,
    message: `Application package generated. Suitability ${analysis.score}% · CV ATS compatibility ${cvAts!.score}/100 · cover quality ${coverQuality.status} (${coverQuality.score}/100).`,
    applicationId,
    atsScore: cvAts!.score,
    readinessState: qualityReviewState,
    cvDocumentId: cvDocs!.pdfId,
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
