"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { nowIso, one, run } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { notify } from "@/lib/notify";
import { getSetting } from "@/lib/settings";
import {
  APPLICATION_STATUSES,
  readinessAllowsSubmission,
  statusLabel,
  submissionBlockedReason,
  validateApplicationStatusTransition,
} from "@/lib/application-status";
import { BOARD_COLUMNS, BOARD_DROP_TARGETS, boardColumnForRow, type BoardColumnKey } from "@/lib/application-board";
import { emitWorkflowEvent } from "@/lib/events";
import { randomId } from "@/lib/security";
import { existingVerifiedSubmission } from "@/lib/submission";
import { recordApplicationEvent } from "@/lib/application-events";
import { latestWorkflowForUser } from "@/lib/workflow-view";

/**
 * Legacy compatibility only. Per-application approval is retired, so a package
 * that is otherwise ready is released to the automatic queue without an
 * approval flag. New packages never enter this state.
 */
export async function approveApplicationAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const app = one<{ id: string; job_id: string; status: string; readiness: string | null }>(
    "SELECT id, job_id, status, readiness FROM applications WHERE id = ?",
    [id],
  );
  if (!app) redirect("/applications?error=Application+not+found");
  if (!readinessAllowsSubmission(app!.readiness)) {
    redirect(`/applications/${id}?error=${encodeURIComponent("The readiness checklist has not passed. No approval is required, but the application is not ready to send.")}`);
  }
  run("UPDATE applications SET status = 'ready_to_submit', approved_at = NULL, last_update = ? WHERE id = ?", [nowIso(), id]);
  audit({ action: "application.released_to_automatic_queue", entity: "application", entityId: id, detail: `Job ${app!.job_id}. No per-application approval is required.`, userId: user.id });
  const workflow = latestWorkflowForUser(user);
  if (workflow) {
    emitWorkflowEvent({
      workflowId: workflow.id,
      type: "approval.granted",
      agentKey: "application",
      message: "The package was released to the automatic submission queue. Employer evidence is still required before it is counted as submitted.",
      meta: { applicationId: id },
    });
  }
  revalidatePath("/applications");
  revalidatePath("/dashboard");
  redirect(`/applications/${id}?ok=${encodeURIComponent("Released to the automatic submission queue. No per-application approval is required.")}`);
}

export type SubmissionState = { error?: string; ok?: string };

/**
 * Sends a package back for document changes. Approval is cleared so the owner
 * must review the regenerated CV and cover letter again before any submission.
 */
export async function requestDocumentChangesAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const request = String(formData.get("request") ?? "").trim().slice(0, 500);
  const app = one<{ id: string; notes: string | null; status: string }>("SELECT id, notes, status FROM applications WHERE id = ?", [id]);
  if (!app) redirect("/applications?error=Application+not+found");
  if (app.status === "submitted") redirect(`/applications/${id}?error=Submitted+applications+cannot+be+sent+back+for+changes`);
  const note = `Document changes requested ${nowIso()}: ${request || "regenerate the CV and cover letter, then re-review"}`;
  run("UPDATE applications SET status = 'documents_preparing', approved_at = NULL, notes = ?, last_update = ? WHERE id = ?", [
    app.notes ? `${app.notes}\n${note}` : note,
    nowIso(),
    id,
  ]);
  audit({ action: "application.changes_requested", entity: "application", entityId: id, detail: note, userId: user.id });
  revalidatePath("/applications");
  revalidatePath("/dashboard");
  redirect(`/applications/${id}?ok=${encodeURIComponent("Document changes recorded. Approval was cleared; regenerate the package from the vacancy, then review it again.")}`);
}


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
  const duplicate = existingVerifiedSubmission(app.job_id);
  if (duplicate) {
    return { error: `A verified submission already exists for this vacancy (${duplicate.reference ?? duplicate.id}).` };
  }
  const blocked = submissionBlockedReason({
    found: true,
    approvalMode: false,
    approvedAt: app.approved_at,
    confirmation,
    status: app.status,
  });
  if (blocked) return { error: blocked };

  const job = one<{ title: string; company: string }>("SELECT title, company FROM jobs WHERE id = ?", [app.job_id]);
  const submittedAt = nowIso();
  const retentionDays = getSetting<number>("retention_days", 30);
  const expiresAt = new Date(Date.now() + retentionDays * 86400_000).toISOString();
  const evidence = {
    source: "manual_record",
    confirmation,
    method,
    recordedBy: user.id,
    recordedAt: submittedAt,
  };

  // A manual confirmation is also submission evidence. Persisting the attempt
  // makes it count against the same daily cap as an automated send and prevents
  // the same vacancy from being submitted again by a later scheduled run.
  run(
    `INSERT INTO submission_attempts (id, application_id, job_id, run_id, channel, endpoint, status, http_status, reference, evidence, error, attempted_at)
     VALUES (?, ?, ?, NULL, 'manual', NULL, 'verified', NULL, ?, ?, NULL, ?)`,
    [`sub_${randomId()}`, id, app.job_id, confirmation, JSON.stringify(evidence).slice(0, 12000), submittedAt],
  );
  run(
    `UPDATE applications SET status = 'submitted', submission_status = 'verified', submitted_at = ?, confirmation = ?,
       confirmation_ref = ?, submission_evidence = ?, method = ?, applied_channel = ?, last_update = ? WHERE id = ?`,
    [submittedAt, confirmation, confirmation, JSON.stringify(evidence).slice(0, 12000), method, method, submittedAt, id],
  );
  run("UPDATE jobs SET status = 'applied' WHERE id = ?", [app.job_id]);
  recordApplicationEvent({
    applicationId: id,
    type: "submission.manual_recorded",
    message: `Submission recorded manually via ${method.replace(/_/g, " ")} with employer reference ${confirmation}.`,
    meta: { method, reference: confirmation, recordedBy: user.id },
  });
  run(
    "UPDATE documents SET status = 'submitted', expires_at = ? WHERE job_id = ? AND deleted_at IS NULL AND kind IN ('tailored_cv','cover_letter')",
    [expiresAt, app.job_id],
  );
  notify({
    userId: user.id,      kind: "application_submitted",
      subject: `Application submitted: ${job?.title ?? "Role"} at ${job?.company ?? "Employer"}`,
      body: `Confirmed via ${method.replace(/_/g, " ")}. Reference: ${confirmation}. Documents are retained for ${retentionDays} days unless pinned.`,
      email: false,
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

export async function answerInterventionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("intervention_id") ?? "");
  const answer = String(formData.get("answer") ?? "").trim().slice(0, 1000);
  const row = one<{ id: string; application_id: string; question: string; status: string }>(
    "SELECT id, application_id, question, status FROM application_interventions WHERE id = ?",
    [id],
  );
  if (!row) redirect("/applications?error=Question+not+found");
  if (row!.status !== "open") redirect(`/applications/${row!.application_id}?error=This+question+is+already+resolved`);
  if (!answer) redirect(`/applications/${row!.application_id}?error=Enter+an+answer+first#questions`);
  const app = one<{ id: string; status: string; readiness: string | null }>(
    "SELECT id, status, readiness FROM applications WHERE id = ?",
    [row!.application_id],
  );
  if (!app) redirect("/applications?error=Application+not+found");
  const alreadySubmitted = ["submitted", "acknowledged"].includes(app!.status);
  const readinessOk = readinessAllowsSubmission(app!.readiness);
  run("UPDATE application_interventions SET status = 'resolved', answer = ?, resolved_at = ? WHERE id = ?", [answer, nowIso(), id]);
  if (!alreadySubmitted && readinessOk) {
    run("UPDATE applications SET status = 'ready_to_submit', last_update = ? WHERE id = ?", [nowIso(), row!.application_id]);
  }
  audit({
    action: "application.question_answered",
    entity: "application",
    entityId: row!.application_id,
    detail: `${row!.question} — answer stored for this application only.`,
    userId: user.id,
  });
  revalidatePath(`/applications/${row!.application_id}`);
  revalidatePath("/recruitment");
  redirect(
    `/applications/${row!.application_id}?${readinessOk && !alreadySubmitted ? "ok" : "error"}=${encodeURIComponent(
      readinessOk && !alreadySubmitted
        ? "Answer saved. The next run may re-evaluate this application with the authorised answer."
        : "Answer saved, but the application is not in the automatic queue because its readiness checklist has not passed or it was already submitted.",
    )}#questions`,
  );
}

type StatusDecisionRow = {
  id: string;
  job_id: string;
  status: string;
  readiness: string | null;
  submitted_at: string | null;
  confirmation: string | null;
};

/**
 * Rejects a transition without touching the stored record. The rejection is
 * auditable and the caller receives an actionable explanation.
 */
function rejectStatusTransition(input: {
  userId: string;
  row: StatusDecisionRow;
  nextStatus: string;
  reason: string;
}): never {
  audit({
    action: "application.transition_rejected",
    entity: "application",
    entityId: input.row.id,
    detail: `${input.row.status} → ${input.nextStatus}: ${input.reason}`,
    userId: input.userId,
  });
  redirect(`/applications/${input.row.id}?error=${encodeURIComponent(input.reason)}`);
}

export async function updateApplicationStatusAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!(APPLICATION_STATUSES as readonly string[]).includes(status)) redirect("/applications?error=Invalid+status");
  const app = one<StatusDecisionRow>(
    "SELECT id, job_id, status, readiness, submitted_at, confirmation FROM applications WHERE id = ?",
    [id],
  );
  if (!app) redirect("/applications?error=Application+not+found");

  const decision = validateApplicationStatusTransition({
    currentStatus: app.status,
    nextStatus: status,
    submitted_at: app.submitted_at,
    confirmation: app.confirmation,
    readiness: app.readiness,
  });
  if (!decision.allowed) rejectStatusTransition({ userId: user.id, row: app, nextStatus: status, reason: decision.reason });

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

export type MoveCardResult = { ok: boolean; message: string };

function moveTargetLabel(column: BoardColumnKey): string {
  return BOARD_COLUMNS.find((candidate) => candidate.key === column)?.label ?? column;
}

/**
 * Kanban drag and drop. It is a thin transport over the same persisted record
 * and the same validateApplicationStatusTransition rule as the status form, so
 * a drop can never bypass lifecycle or submission-evidence checks.
 */
export async function moveApplicationCardAction(input: {
  id: string;
  column: string;
}): Promise<MoveCardResult> {
  const user = await requireUser();
  const id = String(input.id ?? "");
  const column = String(input.column ?? "") as BoardColumnKey;
  if (!BOARD_COLUMNS.some((candidate) => candidate.key === column)) {
    return { ok: false, message: "That board column does not exist. Nothing was changed." };
  }
  const app = one<StatusDecisionRow>(
    "SELECT id, job_id, status, readiness, submitted_at, confirmation FROM applications WHERE id = ?",
    [id],
  );
  if (!app) return { ok: false, message: "Application not found. Nothing was changed." };

  const currentColumn = boardColumnForRow(app);
  if (currentColumn === column) {
    return { ok: true, message: `The card is already in ${moveTargetLabel(column)}.` };
  }
  if (column === "needs_attention") {
    return {
      ok: false,
      message:
        "Needs attention is set by the system when a submission or package cannot be verified. Resolve the blocker on the application instead of moving the card.",
    };
  }

  const nextStatus = BOARD_DROP_TARGETS[column];
  if (!nextStatus) {
    return { ok: false, message: `Cards cannot be moved to ${moveTargetLabel(column)}. Nothing was changed.` };
  }
  const decision = validateApplicationStatusTransition({
    currentStatus: app.status,
    nextStatus,
    submitted_at: app.submitted_at,
    confirmation: app.confirmation,
    readiness: app.readiness,
  });
  if (!decision.allowed) {
    audit({
      action: "application.transition_rejected",
      entity: "application",
      entityId: id,
      detail: `board drop ${app.status} → ${column}: ${decision.reason}`,
      userId: user.id,
    });
    return { ok: false, message: decision.reason };
  }

  run("UPDATE applications SET status = ?, last_update = ? WHERE id = ?", [nextStatus, nowIso(), id]);
  audit({
    action: `application.${nextStatus}`,
    entity: "application",
    entityId: id,
    detail: `Moved from the ${currentColumn === "closed" ? "closed" : moveTargetLabel(currentColumn)} group to ${moveTargetLabel(column)} on the board.`,
    userId: user.id,
  });
  revalidatePath("/applications");
  revalidatePath(`/applications/${id}`);
  revalidatePath("/dashboard");
  return { ok: true, message: `Moved to ${moveTargetLabel(column)}. Status is now ${statusLabel(nextStatus)}.` };
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
