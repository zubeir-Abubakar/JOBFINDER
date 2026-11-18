"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { run } from "@/lib/db";
import { audit } from "@/lib/audit";
import { executeRun, runById, startDailyRun } from "@/lib/recruitment-run";
import { getSchedule, setScheduleEnabled } from "@/lib/recruitment-schedule";
import {
  activateStandingAuthorisation,
  pauseStandingAuthorisation,
  saveRecruitmentPolicy,
} from "@/lib/recruitment-policy";

export async function runRecruitmentNowAction(): Promise<void> {
  const user = await requireUser();
  const result = await startDailyRun({ trigger: "manual", userId: user.id });
  revalidatePath("/recruitment");
  revalidatePath("/dashboard");
  redirect(`/recruitment?${result.ok ? "ok" : "error"}=${encodeURIComponent(result.message)}`);
}

/**
 * Safe manual trigger: discovery, eligibility, scoring and the stored report
 * only. No documents are prepared and nothing is submitted to an employer.
 */
export async function runRecruitmentDiscoveryNowAction(): Promise<void> {
  const user = await requireUser();
  const result = await startDailyRun({ trigger: "manual", userId: user.id, discoveryOnly: true });
  audit({ action: "recruitment.discovery_run", entity: "recruitment_run", entityId: result.runId ?? null, userId: user.id });
  revalidatePath("/recruitment");
  redirect(`/recruitment?${result.ok ? "ok" : "error"}=${encodeURIComponent(result.message)}`);
}

export async function saveRecruitmentPolicyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  saveRecruitmentPolicy({
    autonomousSubmission: formData.get("autonomous_submission") === "on",
    minMatchScore: formData.get("min_match_score"),
    maxSubmissionsPerDay: formData.get("max_applications_per_day"),
    userId: user.id,
  });
  revalidatePath("/recruitment");
  redirect("/recruitment?ok=Standing+policy+saved.#standing-authorisation");
}

/** The explicit owner action required before any real submission can leave the app. */
export async function activateStandingAuthorisationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (formData.get("confirm") !== "on") {
    redirect("/recruitment?error=Confirm+that+you+authorise+automatic+submission+first.#standing-authorisation");
  }
  activateStandingAuthorisation(user.id);
  revalidatePath("/recruitment");
  redirect("/recruitment?ok=Standing+authorisation+activated.+Straightforward+qualifying+applications+may+now+be+submitted+automatically.#standing-authorisation");
}

export async function pauseStandingAuthorisationAction(): Promise<void> {
  const user = await requireUser();
  pauseStandingAuthorisation(user.id);
  revalidatePath("/recruitment");
  redirect("/recruitment?ok=Standing+authorisation+paused.+Nothing+will+be+sent+until+you+reactivate+it.#standing-authorisation");
}

export async function toggleRecruitmentScheduleAction(): Promise<void> {
  const user = await requireUser();
  const schedule = getSchedule();
  const next = setScheduleEnabled(schedule.enabled !== 1);
  audit({
    action: next.enabled ? "recruitment.schedule_enabled" : "recruitment.schedule_disabled",
    entity: "schedule",
    entityId: next.key,
    userId: user.id,
  });
  revalidatePath("/recruitment");
  redirect(`/recruitment?ok=${encodeURIComponent(next.enabled ? "Daily schedule enabled." : "Daily schedule paused.")}`);
}

/** Re-runs a failed run. Successful runs are never re-executed. */
export async function retryRecruitmentRunAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("run_id") ?? "");
  const existing = runById(id);
  if (!existing) redirect("/recruitment?error=Run+not+found");
  if (existing.status !== "failed") {
    redirect(`/recruitment?error=${encodeURIComponent("Only a failed run can be retried. Open the report to review it.")}`);
  }
  run("UPDATE recruitment_runs SET status = 'scheduled', error = NULL, failures = 0, finished_at = NULL WHERE id = ?", [id]);
  audit({ action: "recruitment.run_retried", entity: "recruitment_run", entityId: id, userId: user.id });
  void executeRun(id, { userId: user.id }).catch(() => {
    // The run records its own failure; the redirect must not be blocked by it.
  });
  revalidatePath("/recruitment");
  redirect(`/recruitment?ok=${encodeURIComponent("Run restarted. The report will update when it finishes.")}`);
}
