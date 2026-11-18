import { all, nowIso, one, run } from "./db";

/**
 * Records an in-app notification. Email is an independent, explicit delivery
 * path; connecting Gmail must never make this row claim that an email was sent.
 */
export function notify(input: { userId?: string | null; kind: string; subject: string; body: string }): void {
  const channel = "in-app";
  run(
    "INSERT INTO notifications (user_id, kind, subject, body, channel, status, created_at) VALUES (?, ?, ?, ?, ?, 'unread', ?)",
    [input.userId ?? null, input.kind, input.subject, input.body, channel, nowIso()],
  );
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
