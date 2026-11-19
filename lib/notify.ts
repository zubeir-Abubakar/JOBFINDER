import crypto from "node:crypto";
import { all, nowIso, one, run } from "./db";
import { getSetting, setSetting } from "./settings";

/**
 * In-app notifications and durable email delivery are separate facts.
 *
 * `notify()` records the in-app row immediately. When Gmail is selected and
 * connected, it also inserts one deduplicated row in `notification_outbox`.
 * Only the outbox worker may mark an email accepted by Gmail, and Gmail API
 * acceptance is still not claimed as inbox delivery.
 */

export type NotificationInput = {
  userId?: string | null;
  kind: string;
  subject: string;
  body: string;
  dedupeKey?: string;
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
  status: "pending" | "sending" | "sent" | "failed" | "retry_scheduled";
  attempts: number;
  available_at: string;
  provider: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  delivery: string | null;
  last_error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const EMAIL_EVENTS = new Set([
  "recruitment_run",
  "recruitment_run_failed",
  "recruitment_partial",
  "job_discovery_completed",
  "strong_match",
  "documents_ready",
  "application_submitted",
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
  if (kind === "recruitment_run" || kind === "recruitment_run_failed" || kind === "recruitment_partial") {
    return getSetting<boolean>("notify_daily_report", true);
  }
  if (["agent_failure", "provider_quota_exhausted", "provider_fallback", "scheduler_failure", "recruitment_missed", "workflow_error"].includes(kind)) {
    return getSetting<boolean>("notify_agent_failure", true);
  }
  return getSetting<boolean>("notify_immediate", true);
}

function recipient(): string | null {
  const email = getSetting<{ provider?: string; connected?: boolean; sender?: string; account?: string }>("email", {});
  if (email.provider !== "gmail") return null;
  const account = one<{ id: number; email: string }>("SELECT id, email FROM gmail_accounts WHERE id = 1");
  if (!account) return null;
  const profile = one<{ email: string | null }>("SELECT email FROM profiles WHERE id = 1");
  const address = (profile?.email || email.account || email.sender || account.email || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : null;
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

function enqueue(input: NotificationInput, notificationId: number): { queued: boolean; reason?: string } {
  if (!emailEnabled(input.kind)) return { queued: false, reason: "email event disabled" };
  const to = recipient();
  if (!to) return { queued: false, reason: "Gmail is not connected" };
  const dedupe = input.dedupeKey ?? fallbackDedupe(input);
  const existing = one<OutboxRow>("SELECT * FROM notification_outbox WHERE dedupe_key = ?", [dedupe]);
  if (existing) return { queued: false, reason: `duplicate ${existing.status}` };
  run(
    `INSERT INTO notification_outbox
       (id, dedupe_key, notification_id, user_id, kind, recipient, subject, body, status, attempts, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    [
      `mailout_${crypto.randomBytes(12).toString("hex")}`,
      dedupe,
      notificationId,
      input.userId ?? null,
      input.kind,
      to,
      input.subject,
      input.body,
      nowIso(),
      nowIso(),
    ],
  );
  startNotificationQueue();
  return { queued: true };
}

/** Record the in-app notification, then optionally enqueue one email delivery. */
export function notify(input: NotificationInput): { notificationId: number; emailQueued: boolean; emailReason: string | null } {
  if (input.dedupeKey) {
    const duplicate = one<{ id: number }>("SELECT id FROM notifications WHERE dedupe_key = ? ORDER BY id DESC LIMIT 1", [input.dedupeKey]);
    if (duplicate) return { notificationId: duplicate.id, emailQueued: false, emailReason: "duplicate in-app notification" };
  }
  run(
    "INSERT INTO notifications (user_id, kind, subject, body, channel, status, dedupe_key, delivery_status, created_at) VALUES (?, ?, ?, ?, 'in-app', 'unread', ?, 'not-requested', ?)",
    [input.userId ?? null, input.kind, input.subject, input.body, input.dedupeKey ?? null, nowIso()],
  );
  const notificationId = Number(one<{ id: number }>("SELECT last_insert_rowid() AS id")?.id ?? 0);
  const queued = enqueue(input, notificationId);
  if (queued.queued) {
    run("UPDATE notifications SET channel = 'in-app + email', delivery_status = 'pending' WHERE id = ?", [notificationId]);
  } else if (queued.reason && !queued.reason.startsWith("duplicate")) {
    run("UPDATE notifications SET delivery_status = ? WHERE id = ?", [queued.reason, notificationId]);
  }
  return { notificationId, emailQueued: queued.queued, emailReason: queued.reason ?? null };
}

type SendResult = { messageId: string; threadId: string | null };
type Sender = (input: { to: string; subject: string; body: string }) => Promise<SendResult>;

function backoffMs(attempt: number): number {
  return Math.round(Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + Math.random() * 0.4));
}

/**
 * Durable delivery worker. The sender is injectable so tests can prove state
 * transitions and duplicate prevention without contacting Gmail.
 */
export async function drainNotificationQueue(options: { send?: Sender; now?: Date; limit?: number } = {}): Promise<{
  attempted: number;
  sent: number;
  retryScheduled: number;
  failed: number;
}> {
  const now = options.now ?? new Date();
  // A process killed mid-send is recovered rather than stranded forever.
  run(
    "UPDATE notification_outbox SET status = 'retry_scheduled', available_at = ? WHERE status = 'sending' AND started_at < ?",
    [nowIso(), new Date(now.getTime() - 5 * 60_000).toISOString()],
  );
  const send: Sender =
    options.send ??
    (async (message) => {
      const { sendGmailEmail } = await import("./gmail");
      const result = await sendGmailEmail(message.to, message.subject, message.body);
      if (result.status !== "accepted" || !result.messageId) throw new Error(result.detail);
      return { messageId: result.messageId, threadId: result.threadId };
    });

  let attempted = 0;
  let sent = 0;
  let retryScheduled = 0;
  let failed = 0;
  for (let i = 0; i < Math.max(1, Math.min(10, options.limit ?? 5)); i += 1) {
    const row = one<OutboxRow>(
      "SELECT * FROM notification_outbox WHERE status IN ('pending','retry_scheduled') AND available_at <= ? ORDER BY created_at LIMIT 1",
      [now.toISOString()],
    );
    if (!row) break;
    run("UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, started_at = ? WHERE id = ?", [
      nowIso(),
      row.id,
    ]);
    attempted += 1;
    const attempts = row.attempts + 1;
    try {
      const result = await send({ to: row.recipient, subject: row.subject, body: row.body });
      run(
        `UPDATE notification_outbox SET status = 'sent', provider = 'gmail', provider_message_id = ?, provider_thread_id = ?,
           delivery = 'accepted', last_error = NULL, finished_at = ? WHERE id = ?`,
        [result.messageId, result.threadId, nowIso(), row.id],
      );
      run("UPDATE notifications SET delivery_status = 'accepted', provider_message_id = ? WHERE id = ?", [
        result.messageId,
        row.notification_id,
      ]);
      sent += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Notification delivery failed.").slice(0, 800);
      const permanent = /invalid_grant|revoked|permission|scope|not connected|missing configuration|invalid recipient/i.test(message);
      if (permanent || attempts >= 5) {
        run(
          "UPDATE notification_outbox SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?",
          [message, nowIso(), row.id],
        );
        run("UPDATE notifications SET delivery_status = 'failed' WHERE id = ?", [row.notification_id]);
        failed += 1;
      } else {
        const available = new Date(now.getTime() + backoffMs(attempts)).toISOString();
        run(
          "UPDATE notification_outbox SET status = 'retry_scheduled', last_error = ?, available_at = ? WHERE id = ?",
          [message, available, row.id],
        );
        run("UPDATE notifications SET delivery_status = 'retry_scheduled' WHERE id = ?", [row.notification_id]);
        retryScheduled += 1;
      }
      setSetting("email_delivery_last", {
        provider: "gmail",
        status: permanent ? "failed" : "retry_scheduled",
        kind: row.kind,
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
  }
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

export function notificationQueueSnapshot() {
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, retry_scheduled: 0 };
  for (const row of all<{ status: keyof typeof counts; n: number }>(
    "SELECT status, COUNT(*) AS n FROM notification_outbox GROUP BY status",
  )) {
    counts[row.status] = Number(row.n);
  }
  const latest = all<OutboxRow>("SELECT * FROM notification_outbox ORDER BY created_at DESC LIMIT 10");
  const lastError = one<{ last_error: string | null; kind: string | null; created_at: string | null }>(
    "SELECT last_error, kind, created_at FROM notification_outbox WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1",
  );
  const lastAccepted = one<{ provider_message_id: string | null; kind: string | null; finished_at: string | null }>(
    "SELECT provider_message_id, kind, finished_at FROM notification_outbox WHERE status = 'sent' ORDER BY finished_at DESC LIMIT 1",
  );
  return { counts, latest, lastError, lastAccepted, configured: Boolean(recipient()) };
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
