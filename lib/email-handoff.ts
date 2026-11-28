import { one, run, nowIso } from "./db";
import { recordApplicationEvent } from "./application-events";
import { finishQueueEntry } from "./recruitment-queue";

/**
 * Records that the owner sent an email application themselves.
 *
 * This is an owner attestation, not employer confirmation: the application is
 * marked `submitted_unverified` and the queue records `sent_by_owner`. The
 * action is idempotent and never creates a submission attempt or sends mail.
 */
export function markEmailHandoffSent(input: {
  applicationId: string;
  note?: string | null;
  now?: Date;
}): { ok: true; alreadySent: boolean; sentAt: string | null } | { ok: false; error: string } {
  const applicationId = input.applicationId.trim();
  if (!applicationId) return { ok: false, error: "No application was selected." };
  const application = one<{
    id: string;
    job_id: string;
    status: string;
    email_handoff_sent_at: string | null;
    application_email: string | null;
  }>(
    `SELECT a.id, a.job_id, a.status, a.email_handoff_sent_at, j.application_email
     FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?`,
    [applicationId],
  );
  if (!application) return { ok: false, error: "The application no longer exists." };
  if (!application.application_email) {
    return { ok: false, error: "This vacancy is not an email application." };
  }
  if (application.email_handoff_sent_at) {
    return { ok: true, alreadySent: true, sentAt: application.email_handoff_sent_at };
  }

  const now = input.now ?? new Date();
  const sentAt = now.toISOString();
  const note = (input.note ?? "").trim().slice(0, 2000) || null;
  run(
    `UPDATE applications SET email_handoff_sent_at = ?, email_handoff_note = ?,
       submitted_at = COALESCE(submitted_at, ?), status = 'submitted_unverified',
       submission_status = 'unverified', submission_state = 'sent_by_owner', last_update = ?
     WHERE id = ? AND email_handoff_sent_at IS NULL`,
    [sentAt, note, sentAt, sentAt, applicationId],
  );
  recordApplicationEvent({
    applicationId,
    type: "submission.owner_sent",
    message: note ? `The owner sent this application by email. Note: ${note}` : "The owner sent this application by email.",
    meta: { sentAt, method: "owner_email", employerConfirmed: false },
  });
  finishQueueEntry({
    jobId: application.job_id,
    state: "sent_by_owner",
    reason: note ? `Sent by the owner by email on ${sentAt}. Note: ${note}` : `Sent by the owner by email on ${sentAt}.`,
    actor: "owner",
    now,
  });
  return { ok: true, alreadySent: false, sentAt };
}
