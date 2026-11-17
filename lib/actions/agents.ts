"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { one, run } from "@/lib/db";
import { requireUser, requireAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { pauseAllAgents, runDiscovery, analysePendingJobs } from "@/lib/agents";
import { pauseRunningWorkflow, resumeLatestWorkflow, retryWorkflow, startRecruitmentWorkflow, stopRunningWorkflow } from "@/lib/workflow";

export async function startWorkflowAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const pages = Math.min(5, Math.max(1, Number(formData.get("pages") ?? 2) || 2));
  const result = await startRecruitmentWorkflow(user.id, { pages, autoPackage: true });
  revalidatePath("/agents");
  revalidatePath("/dashboard");
  redirect(`/agents?${result.ok ? "ok" : "error"}=${encodeURIComponent(result.message)}`);
}

export async function pauseWorkflowAction(): Promise<void> {
  const user = await requireUser();
  const message = await pauseRunningWorkflow();
  audit({ action: "workflow.pause_requested", entity: "workflow", detail: message, userId: user.id });
  revalidatePath("/agents");
  redirect(`/agents?ok=${encodeURIComponent(message)}`);
}

export async function stopWorkflowAction(): Promise<void> {
  const user = await requireUser();
  const message = await stopRunningWorkflow();
  audit({ action: "workflow.stop_requested", entity: "workflow", detail: message, userId: user.id });
  revalidatePath("/agents");
  redirect(`/agents?ok=${encodeURIComponent(message)}`);
}

export async function resumeWorkflowAction(): Promise<void> {
  const user = await requireUser();
  const result = await resumeLatestWorkflow(user.id);
  revalidatePath("/agents");
  redirect(`/agents?${result.ok ? "ok" : "error"}=${encodeURIComponent(result.message)}`);
}

export async function retryWorkflowAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("workflow_id") ?? "");
  const result = await retryWorkflow(user.id, id);
  revalidatePath("/agents");
  redirect(`/agents?${result.ok ? "ok" : "error"}=${encodeURIComponent(result.message)}`);
}

export async function pauseAllAction(): Promise<void> {
  const user = await requireUser();
  const count = pauseAllAgents(true);
  audit({ action: "agents.paused", entity: "agents", detail: `${count} agents paused from dashboard`, userId: user.id });
  revalidatePath("/dashboard");
  revalidatePath("/agents");
  redirect("/agents?ok=All+agents+paused");
}

export async function resumeAllAction(): Promise<void> {
  const user = await requireUser();
  const count = pauseAllAgents(false);
  audit({ action: "agents.resumed", entity: "agents", detail: `${count} agents resumed from dashboard`, userId: user.id });
  revalidatePath("/dashboard");
  revalidatePath("/agents");
  redirect("/agents?ok=All+agents+resumed");
}

export async function runDiscoveryAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const pages = Math.min(5, Math.max(1, Number(formData.get("pages") ?? 2) || 2));
  const outcome = await runDiscovery(user.id, pages);
  revalidatePath("/agents");
  revalidatePath("/dashboard");
  revalidatePath("/jobs");
  const message = encodeURIComponent([outcome.summary, ...outcome.details].join(" · "));
  redirect(`/agents?${outcome.status === "completed" ? "ok" : "error"}=${message}`);
}

export async function analyseBacklogAction(): Promise<void> {
  const user = await requireUser();
  const count = analysePendingJobs();
  audit({ action: "jobs.analysed_batch", entity: "jobs", detail: `${count} vacancies analysed`, userId: user.id });
  revalidatePath("/agents");
  revalidatePath("/jobs");
  redirect(`/agents?ok=${encodeURIComponent(`${count} vacancies analysed.`)}`);
}

/** Enabling or disabling an agent is an administrative action. */
export async function toggleAgentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const agent = one<{ enabled: number; status: string }>("SELECT enabled, status FROM agents WHERE key = ?", [key]);
  if (!agent) redirect("/admin/agents?error=Agent+not+found");
  const nextEnabled = agent.enabled ? 0 : 1;
  run("UPDATE agents SET enabled = ?, status = ? WHERE key = ?", [nextEnabled, nextEnabled ? "idle" : "disabled", key]);
  audit({ action: "agent.toggled", entity: "agent", entityId: key, detail: nextEnabled ? "Enabled" : "Disabled", userId: admin.id });
  revalidatePath("/admin/agents");
  revalidatePath("/agents");
  redirect("/admin/agents?saved=1");
}

export async function saveAgentConfigAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const config = String(formData.get("config") ?? "{}");
  try {
    JSON.parse(config);
  } catch {
    redirect("/admin/agents?error=Configuration+must+be+valid+JSON");
  }
  run("UPDATE agents SET config = ? WHERE key = ?", [config, key]);
  audit({ action: "agent.config_updated", entity: "agent", entityId: key, userId: admin.id });
  revalidatePath("/admin/agents");
  redirect("/admin/agents?saved=1");
}

export async function setAgentStatusAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const key = String(formData.get("key") ?? "");
  const status = String(formData.get("status") ?? "idle");
  if (!["idle", "paused"].includes(status)) redirect("/admin/agents?error=Invalid+status");
  run("UPDATE agents SET status = ?, current_task = NULL WHERE key = ?", [status, key]);
  audit({ action: "agent.status_set", entity: "agent", entityId: key, detail: status, userId: admin.id });
  revalidatePath("/admin/agents");
  redirect("/admin/agents?saved=1");
}
