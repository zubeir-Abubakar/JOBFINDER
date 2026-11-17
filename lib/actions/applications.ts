"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, one, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { getSetting } from "@/lib/settings";
import { APPLICATION_STATUSES, statusLabel } from "@/lib/application-status";

export async function approveApplicationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const app = one<{ id: string; job_id: string; status: string }>("SELECT id, job_id, status FROM applications WHERE id = ?", [id]);
  if (!app) redirect("/applications?error=Application+not+found");
  if (app.status !== "awaiting_approval") redirect("/applications?error=Only+packages+awaiting+approval+can+be+approved");
  run("UPDATE applications SET approved_at = ?, last_update = ? WHERE id = ?", [nowIso(), nowIso(), id]);
  audit({ action: "application.approved", entity: "application", entityId: id, detail: `Job ${app.job_id}`, userId: user.id });
  revalidatePath("/applications");
  revalidatePath("/dashboard");
  redirect(`/applications/${id}?ok=${encodeURIComponent("Approved. Submit through the employer channel, then record the confirmation reference.")}`);
}

export type SubmissionState = { error?: string; ok?: string };

/**
 * Records a submission that has already been confirmed by the employer's portal
 * or email reply. The platform does not claim a submission without a reference.
 */
export async function recordSubmissionAction(_prev: SubmissionState | undefined, formData: FormData): Promise<SubmissionState> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  const method = String(formData.get("method") ?? "employer_portal");
  const app = one<{ id: string; job_id: string; approved_at: string | null; status: string }>(
    "SELECT id, job_id, approved_at, status FROM applications WHERE id = ?",
    [id],
  );
  if (!app) return { error: "Application not found." };
  if (getSetting<boolean>("approval_mode", true) && !app.approved_at) {
    return { error: "Approval mode is on. Approve the package before recording a submission." };
  }
  if (!confirmation) return { error: "Enter the confirmation reference or message shown by the employer portal." };
  if (app.status === "submitted") return { error: "This application is already recorded as submitted." };

  const job = one<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = ?", [app.job_id]);
  const submittedAt = nowIso();
  const retentionDays = getSetting<number>("retention_days", 30);
  const expiresAt = new Date(Date.now() + retentionDays * 86400_000).toISOString();

  run(
    "UPDATE applications SET status = 'submitted', submitted_at = ?, confirmation = ?, method = ?, last_update = ? WHERE id = ?",
    [submittedAt, confirmation, method, submittedAt, id],
  );
  run("UPDATE jobs SET status = 'applied' WHERE id = ?", [app.job_id]);
  run(
    "UPDATE documents SET status = 'submitted', expires_at = ? WHERE job_id = ? AND deleted_at IS NULL AND kind IN ('tailored_cv','cover_letter')",
    [expiresAt, app.job_id],
  );
  notify({
    userId: user.id,
    kind: "application_submitted",
    subject: `Application submitted: ${job?.title ?? "Role"} at ${job?.company ?? "Employer"}`,
    body: `Confirmed via ${method.replace(/_/g, " ")}. Reference: ${confirmation}. Documents are retained for ${retentionDays} days unless pinned.`,
  });
  audit({
    action: "application.submitted",
    entity: "application",
    entityId: id,
    detail: `${job?.title} at ${job?.company} — reference ${confirmation}`,
    userId: user.id,
  });
  revalidatePath("/applications");
  revalidatePath("/dashboard");
  return { ok: "Submission recorded with confirmation reference. Documents now follow the retention policy." };
}

export async function updateApplicationStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) redirect("/applications?error=Invalid+status");
  if (status === "submitted") {
    redirect(`/applications/${id}?error=${encodeURIComponent("Use the submission form with the employer's confirmation reference.")}`);
  }
  const app = one<{ id: string; job_id: string }>("SELECT id, job_id FROM applications WHERE id = ?", [id]);
  if (!app) redirect("/applications?error=Application+not+found");
  run("UPDATE applications SET status = ?, last_update = ? WHERE id = ?", [status, nowIso(), id]);
  const job = one<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = ?", [app.job_id]);
  if (status === "interview_invited") {
    notify({
      userId: user.id,
      kind: "interview",
      subject: `Interview invitation: ${job?.title} at ${job?.company}`,
      body: "An interview stage was recorded for this application. Prepare with the vacancy analysis and your tailored documents.",
    });
  }
  audit({ action: `application.${status}`, entity: "application", entityId: id, detail: job ? `${job.title} at ${job.company}` : undefined, userId: user.id });
  revalidatePath("/applications");
  revalidatePath(`/applications/${id}`);
  revalidatePath("/dashboard");
  redirect(`/applications/${id}?ok=${encodeURIComponent(`Status updated to ${statusLabel(status)}.`)}`);
}

export async function saveApplicationNotesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const notes = String(formData.get("notes") ?? "").slice(0, 4000);
  run("UPDATE applications SET notes = ?, last_update = ? WHERE id = ?", [notes, nowIso(), id]);
  audit({ action: "application.notes_updated", entity: "application", entityId: id, userId: user.id });
  revalidatePath(`/applications/${id}`);
  redirect(`/applications/${id}?ok=${encodeURIComponent("Notes saved.")}`);
}
