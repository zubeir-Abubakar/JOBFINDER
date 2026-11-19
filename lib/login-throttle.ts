import { one } from "./db";

/**
 * Login throttling is derived from durable audit rows, not process memory.
 * A restart or a second app process therefore cannot reset the attempt window.
 */
export const LOGIN_THROTTLE_WINDOW_MS = 15 * 60_000;

export type LoginThrottleState = {
  blocked: boolean;
  attempts: number;
  limit: number;
  retryAfterSeconds: number;
};

export function loginThrottleState(input: {
  email: string;
  ip: string;
  limit: number;
  now?: Date;
}): LoginThrottleState {
  const now = input.now ?? new Date();
  const limit = Math.min(20, Math.max(3, Math.floor(input.limit)));
  const since = new Date(now.getTime() - LOGIN_THROTTLE_WINDOW_MS).toISOString();
  const row = one<{ attempts: number; oldest: string | null }>(
    `SELECT COUNT(*) AS attempts, MIN(created_at) AS oldest
     FROM audit_logs
     WHERE action = 'login.failed'
       AND created_at >= ?
       AND (lower(entity_id) = ? OR ip = ?)`,
    [since, input.email.trim().toLowerCase(), input.ip],
  );
  const attempts = Number(row?.attempts ?? 0);
  const blocked = attempts >= limit;
  const oldest = row?.oldest ? Date.parse(row.oldest) : NaN;
  const retryAfterSeconds =
    blocked && Number.isFinite(oldest)
      ? Math.max(0, Math.ceil((oldest + LOGIN_THROTTLE_WINDOW_MS - now.getTime()) / 1000))
      : 0;
  return { blocked, attempts, limit, retryAfterSeconds };
}
