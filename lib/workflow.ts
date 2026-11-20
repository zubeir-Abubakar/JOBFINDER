import { all, nowIso, one, run } from "./db";
import {
  analysePendingJobs,
  annotateAnalysis,
  completeTask,
  createWorkflow,
  failTask,
  finishWorkflow,
  generateApplicationPackage,
  pauseAllAgents,
  startTask,
  agentsPaused,
} from "./agents";
import { researchJobs } from "./jobs";
import { ProvidersUnavailableError } from "./providers";
import { getSetting } from "./settings";
import { notify } from "./notify";
import { audit } from "./audit";
import { emitWorkflowEvent } from "./events";
import { workflowAccessibleTo, type WorkflowActor } from "./workflow-view";
import { agentIdentity } from "./agent-identity";
import { workflowOrderLabel } from "./workflow-stages";

/**
 * Sequential workflow runner. One recruitment workflow executes at a time so an
 * 8 GB machine never loads competing model calls. Each stage persists its task
 * record, so the dashboard can show progress while the browser is free.
 */

export type StartResult = { ok: boolean; workflowId?: string; message: string };

type QueueItem = { workflowId: string; job: () => Promise<void> };
type WorkflowGlobal = typeof globalThis & {
  __atwQueue?: QueueItem[];
  __atwDraining?: boolean;
  __atwRecovered?: boolean;
};

const g = globalThis as WorkflowGlobal;

class PauseSignal extends Error {}
class StopSignal extends Error {}

function schedule(item: QueueItem) {
  g.__atwQueue ??= [];
  g.__atwQueue.push(item);
  void drain();
}

async function drain() {
  if (g.__atwDraining) return;
  g.__atwDraining = true;
  try {
    while (g.__atwQueue && g.__atwQueue.length > 0) {
      const item = g.__atwQueue.shift()!;
      try {
        await item.job();
      } catch (error) {
        finishWorkflow(item.workflowId, "failed", error instanceof Error ? error.message : "Workflow runner crashed.");
      }
    }
  } finally {
    g.__atwDraining = false;
  }
}

export function recoverInterruptedRuns(): void {
  if (g.__atwRecovered) return;
  g.__atwRecovered = true;
  const ts = nowIso();
  run("UPDATE tasks SET status = 'failed', error = COALESCE(error, 'Interrupted by a server restart'), finished_at = ? WHERE status IN ('running','working')", [ts]);
  run("UPDATE workflows SET status = 'paused', error = 'Interrupted by a server restart. Resume or retry.', finished_at = ? WHERE status IN ('running','queued')", [ts]);
}

function control(workflowId: string) {
  const row = one<{ pause_requested: number; stop_requested: number }>(
    "SELECT pause_requested, stop_requested FROM workflows WHERE id = ?",
    [workflowId],
  );
  if (row?.stop_requested) throw new StopSignal("Workflow stopped by the user.");
  if (row?.pause_requested) throw new PauseSignal("Workflow paused by the user.");
}

function runningWorkflow(actor?: WorkflowActor) {
  const row = one<{ id: string; label: string; status: string; started_by: string | null }>(
    "SELECT id, label, status, started_by FROM workflows WHERE status IN ('running','queued') ORDER BY created_at DESC LIMIT 1",
  );
  if (!row || (actor && !workflowAccessibleTo(actor, row))) return null;
  return row;
}

export function activeWorkflow(actor?: WorkflowActor) {
  return runningWorkflow(actor);
}

export function latestPausedWorkflow(actor?: WorkflowActor) {
  const rows = all<{ id: string; kind: string; label: string; params: string | null; started_by: string | null }>(
    "SELECT id, kind, label, params, started_by FROM workflows WHERE status = 'paused' ORDER BY created_at DESC LIMIT 50",
  );
  return rows.find((row) => !actor || workflowAccessibleTo(actor, row)) ?? null;
}

export function workflowActor(userId: string): WorkflowActor {
  const row = one<{ role: string }>("SELECT role FROM users WHERE id = ?", [userId]);
  return { id: userId, role: row?.role === "admin" ? "admin" : "owner" };
}

export async function startRecruitmentWorkflow(
  userId: string,
  options: { pages?: number; autoPackage?: boolean } = {},
): Promise<StartResult> {
  recoverInterruptedRuns();
  const running = runningWorkflow();
  if (running) return { ok: false, message: `A workflow is already running (${running.label}). Stop it before starting another.` };
  if (agentsPaused()) return { ok: false, message: "All agents are paused. Resume them before starting a workflow." };
  if (!getSetting<boolean>("approval_mode", true) && !getSetting<boolean>("autonomous_submission", false)) {
    // No special handling: approval is still the safe default; this branch only
    // records that automation settings were read.
  }
  const pages = Math.min(5, Math.max(1, options.pages ?? 2));
  const autoPackage = options.autoPackage !== false;
  const workflowId = createWorkflow("recruitment", "Recruitment operations run", userId);
  run("UPDATE workflows SET params = ? WHERE id = ?", [
    JSON.stringify({ pages, autoPackage }),
    workflowId,
  ]);
  schedule({ workflowId, job: () => runRecruitment(userId, workflowId, pages, autoPackage) });
  audit({ action: "workflow.started", entity: "workflow", entityId: workflowId, detail: `Manual single-vacancy workflow, ${pages} page(s)`, userId });
  return {
    ok: true,
    workflowId,
    message: "Manual single-vacancy workflow queued. This legacy operation prepares one vacancy; use the recruitment page for the autonomous multi-vacancy run.",
  };
}

export async function pauseRunningWorkflow(actor: WorkflowActor): Promise<string> {
  const running = runningWorkflow(actor);
  if (!running) return "No workflow is running.";
  run("UPDATE workflows SET pause_requested = 1 WHERE id = ?", [running.id]);
  pauseAllAgents(true);
  notify({ kind: "workflow_paused", subject: "Workflow paused", body: `${agentIdentity("coordinator").name} will stop at the next safe checkpoint.` });
  return "Pause requested. The current step finishes, then the workflow pauses.";
}

export async function stopRunningWorkflow(actor: WorkflowActor): Promise<string> {
  const running = runningWorkflow(actor);
  if (!running) return "No workflow is running.";
  run("UPDATE workflows SET stop_requested = 1 WHERE id = ?", [running.id]);
  pauseAllAgents(true);
  notify({ kind: "workflow_stopped", subject: "Workflow stopped", body: `${agentIdentity("coordinator").name} will stop at the next safe checkpoint and no new documents will be produced.` });
  return "Stop requested. Remaining stages will not run.";
}

export async function resumeLatestWorkflow(actor: WorkflowActor): Promise<StartResult> {
  const paused = latestPausedWorkflow(actor);
  if (!paused) return { ok: false, message: "There is no paused workflow to resume." };
  const params = (() => {
    try {
      return JSON.parse(paused.params ?? "{}") as { pages?: number; autoPackage?: boolean };
    } catch {
      return {};
    }
  })();
  pauseAllAgents(false);
  run("UPDATE workflows SET summary = COALESCE(summary, 'Resumed') WHERE id = ?", [paused.id]);
  if (paused.kind !== "recruitment") return { ok: false, message: "Only recruitment workflows can be resumed. Retry the document workflow from the vacancy page." };
  return startRecruitmentWorkflow(actor.id, { pages: params.pages, autoPackage: params.autoPackage });
}

export async function retryWorkflow(actor: WorkflowActor, workflowId: string): Promise<StartResult> {
  const workflow = one<{ kind: string; params: string | null; started_by: string | null }>(
    "SELECT kind, params, started_by FROM workflows WHERE id = ?",
    [workflowId],
  );
  if (!workflow || !workflowAccessibleTo(actor, workflow)) return { ok: false, message: "Workflow not found." };
  if (workflow.kind !== "recruitment") return { ok: false, message: "Only recruitment workflows support retry. Regenerate package documents from the vacancy." };
  const params = workflow.params ? (JSON.parse(workflow.params) as { pages?: number; autoPackage?: boolean }) : {};
  return startRecruitmentWorkflow(actor.id, { pages: params.pages, autoPackage: params.autoPackage });
}

function topVacancy() {
  return one<{ id: string; title: string; company: string; match_score: number; match_flag: string }>(
    "SELECT id, title, company, match_score, match_flag FROM jobs WHERE match_flag IN ('strong','possible') AND status NOT IN ('applied') ORDER BY match_score DESC LIMIT 1",
  );
}

async function runRecruitment(userId: string, workflowId: string, pages: number, autoPackage: boolean): Promise<void> {
  try {
    run("UPDATE workflows SET status = 'running', error = NULL WHERE id = ?", [workflowId]);

    // 1. Chief Coordinator plans the run. If every provider is down the workflow
    // pauses instead of silently pretending the agents executed.
    const planTask = startTask("coordinator", workflowId, "Plan recruitment workflow", "Assign research, analysis, documents and tracking");
    // Operational plans are deterministic. A generative model may phrase a plan
    // as an invented role or task, so it is never used as the source of workflow
    // assignments; AI remains advisory inside the document stages.
    const plan = `Execution order: ${workflowOrderLabel()}. Search ${pages} source page(s), score only validated vacancies against the verified profile, prepare at most one application package${autoPackage ? "" : " (package generation disabled)"}, and stop for explicit application and email approval.`;
    completeTask(planTask, "coordinator", plan);
    control(workflowId);

    // 2. Research from the real job feed only. This stage is deliberately
    // deterministic: generated text must never name a vacancy that was not
    // returned by the connector.
    const researchTask = startTask("research", workflowId, "Search job sources for QA vacancies", `${pages} page(s) · Switzerland or remote`);
    const research = await researchJobs(pages, 40);
    let researchProblem: string | null = null;
    if (research.error && research.inserted === 0) {
      researchProblem = research.error;
      failTask(researchTask, "research", research.error);
    }
    const rejectionSummary = Object.entries(research.rejectionReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([reason, count]) => `${count} ${reason.toLowerCase()}`)
      .join(", ");
    if (!researchProblem) {
      completeTask(
        researchTask,
        "research",
        `${research.fetched} source postings fetched; ${research.inserted} new, ${research.duplicates} duplicate(s), ${research.filteredOut} rejected.${rejectionSummary ? ` Rejections: ${rejectionSummary}.` : ""} No vacancy is created from generated text.`,
      );
    }
    control(workflowId);

    // 3. Analysis against the verified profile. Scoring and evidence are
    // deterministic; generated text cannot add or change a requirement.
    const analysisTask = startTask("analysis", workflowId, "Score new vacancies", "Weighted profile match");
    // If the feed is temporarily unreachable, continue with any existing backlog
    // instead of silently discarding the workflow. The failed research task is
    // recorded and reported above.
    const scored = research.inserted > 0 ? analysePendingJobs(research.jobs.map((j) => j.id)) : analysePendingJobs();
    const top = topVacancy();
    // Advisory narrative only. The weighted score and evidence stay
    // deterministic and no downstream decision reads the model text.
    const analysisNote = top ? await annotateAnalysis({ workflowId, taskId: analysisTask, jobId: top.id }) : null;
    completeTask(
      analysisTask,
      "analysis",
      `${scored} vacancies scored deterministically. Best match: ${top ? `${top.title} at ${top.company} (${top.match_score}%)` : "none yet"}. Evidence is stored with the vacancy.${analysisNote?.ok ? ` AI assessment — ${analysisNote.note}` : analysisNote?.queued ? " AI narrative queued; deterministic evidence remains authoritative." : analysisNote ? " AI narrative unavailable; the deterministic evidence remains authoritative." : ""}`,
    );
    if (researchProblem && !top) {
      finishWorkflow(workflowId, "failed", researchProblem);
      return;
    }
    control(workflowId);

    if (!top || !autoPackage) {
      completeTask(
        startTask("coordinator", workflowId, "Summarise run", "No package requested"),
        "coordinator",
        research.inserted > 0 ? "Discovery and analysis complete. No application package requested." : "No new vacancies. Workflow finished without documents.",
      );
      finishWorkflow(workflowId, "completed", `${research.inserted} new vacancies, ${scored} analysed.`);
      return;
    }

    // 4–6. CV, ATS gate, cover letter and application preparation.
    const selectedTask = startTask("coordinator", workflowId, "Select strongest opportunity", `${top.title} at ${top.company}`);
    completeTask(selectedTask, "coordinator", `Selected ${top.title} at ${top.company} (${top.match_score}%). Sequential document stages follow.`);
    control(workflowId);
    const pkg = await generateApplicationPackage(userId, top.id, { workflowId });
    if (!pkg.ok) {
      finishWorkflow(workflowId, "paused", pkg.message);
      notify({ userId, kind: "workflow_paused", subject: "Workflow paused during documents", body: pkg.message });
      return;
    }
    emitWorkflowEvent({
      workflowId,
      type: "approval.required",
      agentKey: "application",
      message: `Package ready for ${top.title} at ${top.company}. Human approval is required before any submission.`,
      meta: { applicationId: pkg.applicationId ?? null },
    });
    control(workflowId);

    // 7. Application agent prepares the checklist — never submits. The checklist
    // is built from actual package records, not model-generated operations.
    const appTask = startTask("application", workflowId, "Prepare application package", `${top.title} at ${top.company}`);
    completeTask(
      appTask,
      "application",
      `Package ready and awaiting approval. Checklist: CV and cover letter generated with ATS review recorded; application method ${pkg.applicationId ? "recorded on the package" : "not recorded"}; submission requires explicit owner approval. No application was submitted.`,
    );

    // 8. Email & tracking agent.
    const emailTask = startTask("email", workflowId, "Synchronise recruiter correspondence", "Gmail read-only + draft creation");
    const email = getSetting<{ connected: boolean }>("email", { connected: false });
    let tracking = "Gmail is not connected. Tracking was recorded in-app only; connect Gmail in the inbox to read recruiter replies.";
    if (email.connected) {
      try {
        const { syncInbox } = await import("./gmail");
        const result = await syncInbox(15, { workflowId, taskId: emailTask, source: "task" });
        tracking = `Scanned ${result.scanned} message(s); ${result.inserted} new, ${result.matched} matched to applications. AI classified ${result.aiClassified}/${result.aiChecked} new message(s)${result.aiQueued ? ` (${result.aiQueued} queued)` : ""}${result.aiFailed ? ` (${result.aiFailed} failed)` : ""}; application statuses still use the deterministic rules only.`;
        completeTask(emailTask, "email", tracking);
      } catch (error) {
        tracking = `Email tracking failed: ${error instanceof Error ? error.message : "Gmail sync failed."}`;
        failTask(emailTask, "email", tracking);
      }
    } else {
      completeTask(emailTask, "email", tracking);
    }

    const summary = `${research.inserted} new vacancies, ${scored} analysed. Package prepared for ${top.title} at ${top.company}; approval required before submission. ${tracking}`;
    finishWorkflow(workflowId, "completed", summary);
    notify({ userId, kind: "workflow_completed", subject: "Recruitment workflow complete", body: summary });
    audit({ action: "workflow.completed", entity: "workflow", entityId: workflowId, detail: summary, userId });
  } catch (error) {
    if (error instanceof PauseSignal) {
      run("UPDATE workflows SET status = 'paused', pause_requested = 0, summary = ? WHERE id = ?", ["Paused at a safe checkpoint.", workflowId]);
      emitWorkflowEvent({ workflowId, type: "workflow.paused", agentKey: "coordinator", message: "Workflow paused at a safe checkpoint. Resume when ready." });
      notify({ userId, kind: "workflow_paused", subject: "Workflow paused", body: "Agents stopped at a safe checkpoint. Resume when ready." });
      return;
    }
    if (error instanceof StopSignal) {
      run("UPDATE workflows SET status = 'stopped', stop_requested = 0, summary = ? WHERE id = ?", ["Stopped by the user.", workflowId]);
      emitWorkflowEvent({ workflowId, type: "workflow.cancelled", agentKey: "coordinator", message: "Workflow cancelled by the owner. Remaining stages were not executed." });
      return;
    }
    const message = error instanceof ProvidersUnavailableError ? error.message : error instanceof Error ? error.message : "Unknown workflow error";
    run("UPDATE workflows SET status = 'paused', error = ?, summary = ? WHERE id = ?", [message, "Paused after an execution error.", workflowId]);
    notify({ userId, kind: "workflow_error", subject: "Workflow paused after an error", body: message });
  }
}

export function workflowTasks(workflowId: string) {
  return all<{ id: string; agent_key: string; title: string; status: string; output: string | null; error: string | null; provider: string | null; model: string | null }>(
    "SELECT id, agent_key, title, status, output, error, provider, model FROM tasks WHERE workflow_id = ? ORDER BY created_at",
    [workflowId],
  );
}
