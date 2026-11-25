import crypto from "node:crypto";
import { all, getDb, nowIso, one, run } from "./db";
import { getSetting, setSetting } from "./settings";
import { heartbeatRuntimeWorker, startRuntimeWorker, stopRuntimeWorker } from "./runtime-state";
import { renderNotificationEmail } from "./email-template";

/**
 * In-app notifications and durable email delivery are separate facts.
 *
 * `notify()` records the in-app row immediately. When Gmail is selected and
 * connected, it also inserts one deduplicated row in `notification_outbox`.
 * Only the outbox worker may record Gmail API acceptance, and acceptance is
 * never promoted to recipient inbox delivery without independent evidence.
 *
 * `notification_outbox.status` is the worker lifecycle. `delivery` is the
 * evidence state. Keeping those dimensions separate prevents a successful
 * queue claim or an API 200 from being described as "delivered".
 */

export type DeliveryState =
  | "generated"
  | "queued"
  | "sending"
  | "accepted_by_gmail"
  | "sent_folder_observed"
  | "delivery_confirmed"
  | "bounced"
  | "failed"
  | "blocked";

export type NotificationInput = {
  userId?: string | null;
  kind: string;
  subject: string;
  body: string;
  /** Full email body when it differs from the concise in-app body. */
  emailBody?: string | null;
  /** Optional pre-rendered branded HTML. Generic HTML is generated otherwise. */
  html?: string | null;
  dedupeKey?: string;
  /** Stable report identity, separate from the outbox record identity. */
  reportId?: string | null;
  /** Immediate callers process their own row; do not schedule a competing timer. */
  deferQueue?: boolean;
  /**
   * Record the in-app row but suppress the email copy. Routine successes use
   * this so the Coordinator's daily brief remains the consolidated owner-facing
   * operational report. Critical exception alerts leave this true.
   */
  email?: boolean;
};

export type OutboxRow = {
  id: string;
  dedupe_key: string;
  notification_id: number | null;
  user_id: string | null;
  kind: string;
  recipient: string;
  subject: string;
  body: string;
  html_body: string | null;
  status: "pending" | "sending" | "sent" | "failed" | "retry_scheduled";
  attempts: number;
  available_at: string;
  provider: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  delivery: string | null;
  report_id: string | null;
  sender: string | null;
  rfc_message_id: string | null;
  gmail_response: string | null;
  sent_observed_at: string | null;
  sent_verification: string | null;
  delivery_evidence: string | null;
  bounce_info: string | null;
  resend_count: number;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export type OutboxSendResult = {
  messageId: string;
  threadId: string | null;
  rfcMessageId?: string | null;
  sentObserved?: boolean;
  sentFolderDetail?: string | null;
  sentFolderCheckedAt?: string | null;
  deliveryEvidence?: string | null;
  bounceDetected?: boolean;
  bounceEvidence?: string | null;
};

export type OutboxSender = (input: {
  to: string;
  subject: string;
  body: string;
  html?: string | null;
  rfcMessageId?: string | null;
  from?: string | null;
}) => Promise<OutboxSendResult>;

export class EmailDeliveryError extends Error {
  code: string;
  retryable: boolean;
  blocked: boolean;

  constructor(message: string, options: { code?: string; retryable?: boolean; blocked?: boolean } = {}) {
    super(message);
    this.name = "EmailDeliveryError";
    this.code = options.code ?? "delivery_error";
    this.retryable = options.retryable ?? false;
    this.blocked = options.blocked ?? false;
  }
}

const EMAIL_EVENTS = new Set([
  "daily_executive_brief",
  "recruitment_run",
  "recruitment_run_failed",
  "recruitment_partial",
  "job_discovery_completed",
  "strong_match",
  "documents_ready",
  "application_submitted",
  "employer_confirmation",
  "application_intervention",
  "application_approval_required",
  "application_failed",
  "application_submission_unverified",
  "provider_quota_exhausted",
  "provider_fallback",
  "agent_failure",
  "scheduler_failure",
  "recruitment_missed",
  "workflow_error",
  "ats_blocked",
  "interview",
  "rejection",
  "recruiter_question",
]);

type QueueGlobal = typeof globalThis & {
  __atwNotificationQueue?: { started: boolean; processing: boolean; timer?: ReturnType<typeof setTimeout> };
};
const q = globalThis as QueueGlobal;

function queueState() {
  q.__atwNotificationQueue ??= { started: false, processing: false };
  return q.__atwNotificationQueue;
}

function emailEnabled(kind: string): boolean {
  if (!EMAIL_EVENTS.has(kind)) return false;
  if (kind === "daily_executive_brief" || kind === "recruitment_run" || kind === "recruitment_run_failed" || kind === "recruitment_partial") {
    return getSetting<boolean>("notify_daily_report", true);
  }
  if (["agent_failure", "provider_quota_exhausted", "provider_fallback", "scheduler_failure", "recruitment_missed", "workflow_error"].includes(kind)) {
    return getSetting<boolean>("notify_agent_failure", true);
  }
  return getSetting<boolean>("notify_immediate", true);
}

export function notificationRecipient(): string | null {
  const email = getSetting<{ provider?: string; connected?: boolean; sender?: string; account?: string }>("email", {});
  if (email.provider !== "gmail") return null;
  const account = one<{ id: number; email: string }>("SELECT id, email FROM gmail_accounts WHERE id = 1");
  if (!account) return null;
  const profile = one<{ email: string | null }>("SELECT email FROM profiles WHERE id = 1");
  const address = (profile?.email || email.account || email.sender || account.email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
}

/** Actual connected mailbox, never a user-supplied From header. */
export function notificationSender(): string | null {
  const account = one<{ email: string }>("SELECT email FROM gmail_accounts WHERE id = 1");
  const email = getSetting<{ sender?: string }>("email", {});
  return (account?.email || email.sender || "").trim() || null;
}

function newRfcMessageId(sender: string | null): string {
  const domain = sender?.match(/@([^>\s]+)$/)?.[1] ?? "atw.local";
  return `<atw-${crypto.randomUUID()}@${domain}>`;
}

export function deliveryStateForRow(row: Pick<OutboxRow, "status" | "delivery"> | null | undefined): DeliveryState {
  if (!row) return "generated";
  const stored = (row.delivery ?? "").trim();
  if (stored === "delivery_confirmed") return "delivery_confirmed";
  if (stored === "bounced") return "bounced";
  if (stored === "blocked") return "blocked";
  if (stored === "failed") return "failed";
  if (stored === "sent_folder_observed") return "sent_folder_observed";
  if (stored === "accepted" || stored === "accepted_by_gmail") return "accepted_by_gmail";
  if (stored === "queued" || stored === "generated") return row.status === "sending" ? "sending" : "queued";
  if (row.status === "sending") return "sending";
  if (row.status === "pending" || row.status === "retry_scheduled") return "queued";
  if (row.status === "sent") return "accepted_by_gmail";
  return "failed";
}

/** The exact wording the Coordinator is permitted to use for each state. */
export function deliveryStateMessage(state: DeliveryState, detail?: string | null): string {
  const reason = (detail ?? "").trim().replace(/[.\s]+$/, "");
  switch (state) {
    case "generated":
      return "Your Executive Brief has been generated.";
    case "queued":
      return "Your Executive Brief has been added to the email outbox. Sending has not yet been confirmed.";
    case "sending":
      return "Your email is currently being submitted to Gmail.";
    case "accepted_by_gmail":
      return "Gmail has accepted your message for processing. Recipient delivery has not yet been independently confirmed.";
    case "sent_folder_observed":
      return "The message has been found in the connected Gmail Sent folder. Recipient inbox delivery is not yet confirmed.";
    case "delivery_confirmed":
      return "Delivery has been independently confirmed by available delivery evidence.";
    case "blocked":
      return `Your email was not sent. The sending process was blocked because: ${reason || "the delivery prerequisites were not met"}.`;
    case "failed":
      return `Your email could not be sent. Reason: ${reason || "no delivery error was recorded"}.`;
    case "bounced":
      return `The email was rejected or bounced. Reason: ${reason || "a delivery-status notice was recorded"}.`;
  }
}

function fallbackDedupe(input: NotificationInput): string {
  const day = new Date().toISOString().slice(0, 10);
  const digest = crypto
    .createHash("sha256")
    .update(`${input.userId ?? "owner"}|${input.kind}|${input.subject}|${input.body}|${day}`)
    .digest("hex")
    .slice(0, 24);
  return `${input.kind}:${digest}`;
}

function enqueue(input: NotificationInput, notificationId: number): {
  queued: boolean;
  reason?: string;
  outboxId: string | null;
  state: DeliveryState;
} {
  if (!emailEnabled(input.kind)) return { queued: false, reason: "email event disabled", outboxId: null, state: "blocked" };
  if (input.email === false) return { queued: false, reason: "email copy suppressed; recorded in-app", outboxId: null, state: "blocked" };
  const to = notificationRecipient();
  if (!to) return { queued: false, reason: "Gmail is not connected", outboxId: null, state: "blocked" };
  const dedupe = input.dedupeKey ?? fallbackDedupe(input);
  const existing = one<OutboxRow>("SELECT * FROM notification_outbox WHERE dedupe_key = ?", [dedupe]);
  if (existing) {
    return {
      queued: false,
      reason: `duplicate ${existing.status}`,
      outboxId: existing.id,
      state: deliveryStateForRow(existing),
    };
  }
  const emailBody = input.emailBody ?? input.body;
  const html = input.html ?? renderNotificationEmail({ subject: input.subject, body: emailBody, kind: input.kind }).html;
  const sender = notificationSender();
  const outboxId = `mailout_${crypto.randomBytes(12).toString("hex")}`;
  const now = nowIso();
  run(
    `INSERT INTO notification_outbox
       (id, dedupe_key, notification_id, user_id, kind, recipient, subject, body, html_body, status, attempts,
        available_at, delivery, report_id, sender, rfc_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, 'queued', ?, ?, ?, ?)`,
    [
      outboxId,
      dedupe,
      notificationId,
      input.userId ?? null,
      input.kind,
      to,
      input.subject,
      emailBody,
      html,
      now,
      input.reportId ?? null,
      sender,
      newRfcMessageId(sender),
      now,
    ],
  );
  if (!input.deferQueue) startNotificationQueue();
  return { queued: true, outboxId, state: "queued" };
}

/** Record the in-app notification, then optionally enqueue one email delivery. */
export function notify(input: NotificationInput): {
  notificationId: number;
  emailQueued: boolean;
  emailReason: string | null;
  outboxId: string | null;
  deliveryState: DeliveryState;
} {
  if (input.dedupeKey) {
    const duplicate = one<{ id: number }>("SELECT id FROM notifications WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1", [input.dedupeKey]);
    if (duplicate) {
      const outbox = one<OutboxRow>("SELECT * FROM notification_outbox WHERE dedupe_key = ?", [input.dedupeKey]);
      return {
        notificationId: duplicate.id,
        emailQueued: false,
        emailReason: "duplicate in-app notification",
        outboxId: outbox?.id ?? null,
        deliveryState: deliveryStateForRow(outbox),
      };
    }
  }
  run(
    "INSERT INTO notifications (user_id, kind, subject, body, channel, status, dedupe_key, delivery_status, report_id, created_at) VALUES (?, ?, ?, ?, 'in-app', 'unread', ?, 'not-requested', ?, ?)",
    [input.userId ?? null, input.kind, input.subject, input.body, input.dedupeKey ?? null, input.reportId ?? null, nowIso()],
  );
  const notificationId = Number(one<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
  const queued = enqueue(input, notificationId);
  if (queued.queued) {
    run("UPDATE notifications SET channel = 'in-app + email', delivery_status = 'queued' WHERE id = ?", [notificationId]);
  } else if (queued.reason && !queued.reason.startsWith("duplicate")) {
    run("UPDATE notifications SET delivery_status = ? WHERE id = ?", [queued.state, notificationId]);
  }
  return {
    notificationId,
    emailQueued: queued.queued,
    emailReason: queued.reason ?? null,
    outboxId: queued.outboxId,
    deliveryState: queued.state,
  };
}

function backoffMs(attempt: number): number {
  return Math.round(Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + Math.random() * 0.4));
}

function classifyFailure(message: string, error: unknown): { permanent: boolean; blocked: boolean } {
  if (error instanceof EmailDeliveryError) {
    return {
      permanent: error.blocked || !error.retryable,
      blocked: error.blocked,
    };
  }
  const blocked = /invalid_grant|revoked|permission|scope|not connected|missing configuration|invalid recipient|no stored refresh token/i.test(message);
  const permanent = blocked || /unverified without a message id/i.test(message);
  return { permanent, blocked };
}

/**
 * Durable delivery worker. The sender is injectable so tests can prove state
 * transitions and duplicate prevention without contacting Gmail.
 */
export async function drainNotificationQueue(options: {
  send?: OutboxSender;
  now?: Date;
  limit?: number;
  outboxId?: string;
} = {}): Promise<{
  attempted: number;
  sent: number;
  retryScheduled: number;
  failed: number;
}> {
  const now = options.now ?? new Date();
  // A process killed mid-send is recovered rather than stranded forever. It is
  // still not retried blindly: the stored RFC Message-ID is checked against the
  // Sent label before the next API send.
  run(
    "UPDATE notification_outbox SET status = 'retry_scheduled', delivery = 'queued', available_at = ? WHERE status = 'sending' AND started_at < ?",
    [nowIso(), new Date(now.getTime() - 5 * 60_000).toISOString()],
  );
  const send: OutboxSender =
    options.send ??
    (async (message) => {
      const { sendGmailEmail } = await import("./gmail");
      const result = await sendGmailEmail(message.to, message.subject, message.body, {
        html: message.html,
        rfcMessageId: message.rfcMessageId,
        from: message.from,
      });
      if (result.status === "accepted" && result.messageId) {
        return {
          messageId: result.messageId,
          threadId: result.threadId,
          rfcMessageId: result.rfcMessageId,
          sentObserved: result.sentObserved,
          sentFolderDetail: result.sentFolderDetail,
          sentFolderCheckedAt: result.sentFolderCheckedAt,
          deliveryEvidence: result.sentFolderDetail,
          bounceDetected: result.bounceDetected,
          bounceEvidence: result.bounceEvidence,
        };
      }
      const blocked = ["missing_configuration", "authentication_failed", "permission_denied", "invalid_recipient"].includes(result.status);
      throw new EmailDeliveryError(result.detail, {
        code: result.status,
        retryable: result.status === "api_error",
        blocked,
      });
    });

  let attempted = 0;
  let sent = 0;
  let retryScheduled = 0;
  let failed = 0;
  for (let i = 0; i < Math.max(1, Math.min(10, options.limit ?? 5)); i += 1) {
    const row = one<OutboxRow>(
      `SELECT * FROM notification_outbox
       WHERE status IN ('pending','retry_scheduled') AND available_at <= ?
       ${options.outboxId ? "AND id = ?" : ""}
       ORDER BY created_at LIMIT 1`,
      options.outboxId ? [now.toISOString(), options.outboxId] : [now.toISOString()],
    );
    if (!row) break;
    const claimed = getDb()
      .prepare("UPDATE notification_outbox SET status = 'sending', delivery = 'sending', attempts = attempts + 1, started_at = ? WHERE id = ? AND status IN ('pending','retry_scheduled')")
      .run(nowIso(), row.id);
    if (Number(claimed.changes) !== 1) continue;
    attempted += 1;
    const attempts = row.attempts + 1;
    try {
      // On a retry, prove whether a prior ambiguous attempt already reached the
      // Sent folder before making a second Gmail send request.
      let result: OutboxSendResult | null = null;
      if (!options.send && attempts > 1 && row.rfc_message_id) {
        const { findGmailSentByRfcMessageId } = await import("./gmail");
        const found = await findGmailSentByRfcMessageId(row.rfc_message_id).catch(() => null);
        if (found) {
          result = {
            messageId: found.id,
            threadId: found.threadId,
            rfcMessageId: row.rfc_message_id,
            sentObserved: true,
            sentFolderDetail: "The earlier attempt with this RFC Message-ID is present in Gmail Sent; no second message was submitted.",
            sentFolderCheckedAt: nowIso(),
            deliveryEvidence: "Recovered from the connected Gmail Sent folder by RFC Message-ID.",
            bounceDetected: false,
          };
        }
      }
      result ??= await send({
        to: row.recipient,
        subject: row.subject,
        body: row.body,
        html: row.html_body,
        rfcMessageId: row.rfc_message_id,
        from: row.sender,
      });
      const bounced = Boolean(result.bounceDetected);
      const delivery: DeliveryState = bounced
        ? "bounced"
        : result.sentObserved
          ? "sent_folder_observed"
          : "accepted_by_gmail";
      const finishedAt = nowIso();
      run(
        `UPDATE notification_outbox SET status = ?, provider = 'gmail', provider_message_id = ?, provider_thread_id = ?,
           delivery = ?, rfc_message_id = COALESCE(?, rfc_message_id), gmail_response = ?,
           sent_observed_at = ?, sent_verification = ?, delivery_evidence = ?, bounce_info = ?,
           last_error = ?, finished_at = ? WHERE id = ?`,
        [
          bounced ? "failed" : "sent",
          result.messageId,
          result.threadId,
          delivery,
          result.rfcMessageId ?? null,
          JSON.stringify({
            messageId: result.messageId,
            threadId: result.threadId,
            acceptedAt: finishedAt,
            sentObserved: Boolean(result.sentObserved),
            bounceDetected: bounced,
          }),
          result.sentObserved ? result.sentFolderCheckedAt ?? finishedAt : null,
          result.sentFolderDetail ?? null,
          result.deliveryEvidence ?? result.sentFolderDetail ?? "Gmail API acceptance only; no independent delivery evidence is available.",
          result.bounceEvidence ?? null,
          bounced ? result.bounceEvidence ?? "A delivery-status notice was recorded." : null,
          finishedAt,
          row.id,
        ],
      );
      run("UPDATE notifications SET delivery_status = ?, provider_message_id = ? WHERE id = ?", [
        delivery,
        result.messageId,
        row.notification_id,
      ]);
      if (bounced) failed += 1;
      else sent += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Notification delivery failed.").slice(0, 800);
      const { permanent, blocked } = classifyFailure(message, error);
      if (permanent || attempts >= 5) {
        const delivery: DeliveryState = blocked ? "blocked" : "failed";
        run(
          "UPDATE notification_outbox SET status = 'failed', delivery = ?, last_error = ?, finished_at = ? WHERE id = ?",
          [delivery, message, nowIso(), row.id],
        );
        run("UPDATE notifications SET delivery_status = ? WHERE id = ?", [delivery, row.notification_id]);
        failed += 1;
      } else {
        const available = new Date(now.getTime() + backoffMs(attempts)).toISOString();
        run(
          "UPDATE notification_outbox SET status = 'retry_scheduled', delivery = 'queued', last_error = ?, available_at = ? WHERE id = ?",
          [message, available, row.id],
        );
        run("UPDATE notifications SET delivery_status = 'retry_scheduled' WHERE id = ?", [row.notification_id]);
        retryScheduled += 1;
      }
      setSetting("email_delivery_last", {
        provider: "gmail",
        state: permanent ? (blocked ? "blocked" : "failed") : "queued",
        kind: row.kind,
        reportId: row.report_id,
        outboxId: row.id,
        recipientMasked: row.recipient.replace(/^(.).*(@.*)$/, "$1***$2"),
        error: message,
        at: nowIso(),
      });
    }
  }
  return { attempted, sent, retryScheduled, failed };
}

export function startNotificationQueue(): void {
  const state = queueState();
  if (!state.started) {
    state.started = true;
    startRuntimeWorker("notification_outbox", "Durable Gmail notification outbox");
  }
  heartbeatRuntimeWorker("notification_outbox");
  if (state.timer || state.processing) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void processNotificationQueue();
  }, 250);
  state.timer.unref?.();
}

async function processNotificationQueue(): Promise<void> {
  const state = queueState();
  if (state.processing) return;
  state.processing = true;
  heartbeatRuntimeWorker("notification_outbox");
  try {
    await drainNotificationQueue();
  } finally {
    state.processing = false;
    const pending = one<{ at: string | null }>(
      "SELECT MIN(available_at) AS at FROM notification_outbox WHERE status IN ('pending','retry_scheduled')",
    );
    if (pending?.at) {
      const wait = Number.isFinite(Date.parse(pending.at))
        ? Math.max(1_000, Date.parse(pending.at) - Date.now() + 100)
        : 60_000;
      const timer = setTimeout(() => {
        queueState().timer = undefined;
        void processNotificationQueue();
      }, Math.min(wait, 5 * 60_000));
      timer.unref?.();
      queueState().timer = timer;
    }
  }
}

export function stopNotificationQueue(): void {
  const state = queueState();
  if (state.timer) clearTimeout(state.timer);
  state.timer = undefined;
  state.started = false;
  stopRuntimeWorker("notification_outbox", "Stopped with the application process");
}

export function notificationQueueSnapshot() {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, retry_scheduled: 0 };
  for (const row of all<{ status: keyof typeof counts; n: number }>(
    "SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status",
  )) {
    counts[row.status] = Number(row.n);
  }
  const deliveryCounts: Record<DeliveryState, number> = {
    generated: 0,
    queued: 0,
    sending: 0,
    accepted_by_gmail: 0,
    sent_folder_observed: 0,
    delivery_confirmed: 0,
    bounced: 0,
    failed: 0,
    blocked: 0,
  };
  for (const row of all<OutboxRow>("SELECT status, delivery FROM notification_outbox")) {
    deliveryCounts[deliveryStateForRow(row)] += 1;
  }
  const latest = all<OutboxRow>("SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT 10");
  const lastError = one<{ last_error: string | null; kind: string | null; created_at: string | null }>(
    "SELECT last_error, kind, created_at FROM notification_outbox WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  );
  const lastAccepted = one<{
    provider_message_id: string | null;
    kind: string | null;
    finished_at: string | null;
    delivery: string | null;
    report_id: string | null;
  }>(
    "SELECT provider_message_id, kind, finished_at, delivery, report_id FROM notification_outbox WHERE delivery IN ('accepted_by_gmail','sent_folder_observed','delivery_confirmed') ORDER BY finished_at DESC LIMIT 1",
  );
  return { counts, deliveryCounts, latest, lastError, lastAccepted, configured: Boolean(notificationRecipient()) };
}

export function outboxById(id: string): OutboxRow | null {
  return one<OutboxRow>("SELECT * FROM notification_outbox WHERE id = ?", [id]);
}

export function outboxByDedupeKey(dedupeKey: string): OutboxRow | null {
  return one<OutboxRow>("SELECT * FROM notification_outbox WHERE dedupe_key = ?", [dedupeKey]);
}

/**
 * Recheck the Sent label without sending. Safe to call repeatedly; it cannot
 * create another message or downgrade confirmed delivery.
 */
export async function refreshOutboxSentObservation(
  outboxId: string,
  verify?: (messageId: string, rfcMessageId: string | null) => Promise<{
    observed: boolean;
    messageId: string | null;
    threadId: string | null;
    labels?: string[];
    method?: string | null;
    detail: string;
    checkedAt: string;
  }>,
): Promise<{ state: DeliveryState; row: OutboxRow | null; detail: string; checkedAt: string }> {
  const row = outboxById(outboxId);
  if (!row) return { state: "generated", row: null, detail: "No outbox record exists.", checkedAt: nowIso() };
  const current = deliveryStateForRow(row);
  if (!row.provider_message_id) {
    return { state: current, row, detail: "There is no Gmail message ID to verify.", checkedAt: nowIso() };
  }
  if (current === "delivery_confirmed" || current === "bounced") {
    return { state: current, row, detail: "The recorded terminal delivery evidence was not overwritten.", checkedAt: nowIso() };
  }
  const check = verify
    ? await verify(row.provider_message_id, row.rfc_message_id)
    : await import("./gmail").then((gmail) => gmail.verifyGmailSentMessage(row.provider_message_id as string, row.rfc_message_id));
  if (!check.observed) {
    run("UPDATE notification_outbox SET sent_verification = ? WHERE id = ?", [
      `${check.checkedAt}: ${check.detail}`.slice(0, 1000),
      outboxId,
    ]);
    return { state: current, row: outboxById(outboxId), detail: check.detail, checkedAt: check.checkedAt };
  }
  run(
    `UPDATE notification_outbox SET delivery = 'sent_folder_observed', sent_observed_at = ?, sent_verification = ?,
       delivery_evidence = ?, provider_message_id = COALESCE(provider_message_id, ?),
       provider_thread_id = COALESCE(provider_thread_id, ?) WHERE id = ?`,
    [
      check.checkedAt,
      `${check.checkedAt}: ${check.detail}`.slice(0, 1000),
      (check.detail ?? "Present in Gmail Sent.").slice(0, 1500),
      check.messageId,
      check.threadId,
      outboxId,
    ],
  );
  run("UPDATE notifications SET delivery_status = 'sent_folder_observed' WHERE id = ?", [row.notification_id]);
  return { state: "sent_folder_observed", row: outboxById(outboxId), detail: check.detail, checkedAt: check.checkedAt };
}

/**
 * Record an explicit external event. This is the only path to
 * `delivery_confirmed`; callers must supply the independent evidence.
 */
export function recordOutboxDeliveryState(
  outboxId: string,
  state: "delivery_confirmed" | "bounced",
  evidence: string,
): OutboxRow | null {
  const row = outboxById(outboxId);
  if (!row) return null;
  if (!evidence.trim()) throw new Error("Delivery evidence is required; no confirmation is manufactured.");
  const now = nowIso();
  if (state === "bounced") {
    run(
      "UPDATE notification_outbox SET status = 'failed', delivery = 'bounced', bounce_info = ?, delivery_evidence = ?, last_error = ?, finished_at = ? WHERE id = ?",
      [evidence.slice(0, 1500), evidence.slice(0, 1500), evidence.slice(0, 800), now, outboxId],
    );
  } else {
    run(
      "UPDATE notification_outbox SET delivery = 'delivery_confirmed', delivery_evidence = ?, finished_at = ? WHERE id = ?",
      [evidence.slice(0, 1500), now, outboxId],
    );
  }
  run("UPDATE notifications SET delivery_status = ? WHERE id = ?", [state, row.notification_id]);
  return outboxById(outboxId);
}

/**
 * Deliberate resend only. Reuses the same outbox row and report identity, keeps
 * a resend counter, and creates a new RFC Message-ID so evidence from the old
 * attempt cannot be mistaken for the new one.
 */
export function resetOutboxForResend(input: {
  outboxId: string;
  to: string;
  subject: string;
  body: string;
  html: string;
  sender: string | null;
  reportId: string;
  now?: Date;
  deferQueue?: boolean;
}): OutboxRow | null {
  const row = outboxById(input.outboxId);
  if (!row) return null;
  const now = input.now ?? new Date();
  const at = now.toISOString();
  run(
    `UPDATE notification_outbox SET status = 'pending', delivery = 'queued', recipient = ?, subject = ?, body = ?,
       html_body = ?, sender = ?, report_id = ?, rfc_message_id = ?, attempts = 0, resend_count = resend_count + 1,
       available_at = ?, provider = NULL, provider_message_id = NULL, provider_thread_id = NULL,
       gmail_response = NULL, sent_observed_at = NULL, sent_verification = NULL, delivery_evidence = NULL,
       bounce_info = NULL, last_error = NULL, started_at = NULL, finished_at = NULL WHERE id = ?`,
    [
      input.to,
      input.subject,
      input.body,
      input.html,
      input.sender,
      input.reportId,
      newRfcMessageId(input.sender),
      at,
      input.outboxId,
    ],
  );
  run(
    "UPDATE notifications SET subject = ?, body = ?, delivery_status = 'queued', provider_message_id = NULL, report_id = ? WHERE id = ?",
    [input.subject, input.body, input.reportId, row.notification_id],
  );
  if (!input.deferQueue) startNotificationQueue();
  return outboxById(input.outboxId);
}

export function unreadNotifications(limit = 6) {
  return all("SELECT * FROM notifications WHERE status = 'unread' ORDER BY id DESC LIMIT ?", [limit]);
}

export function unreadNotificationCount(): number {
  return one<{ c: number }>("SELECT COUNT(*) AS c FROM notifications WHERE status = 'unread'")?.c ?? 0;
}

export function allNotifications(limit = 50) {
  return all("SELECT * FROM notifications ORDER BY id DESC LIMIT ?", [limit]);
}

export function markNotificationsRead(): void {
  run("UPDATE notifications SET status = 'read', read_at = ? WHERE status = 'unread'", [nowIso()]);
}
