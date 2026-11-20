import { getDb } from "./db";

/**
 * Durable API throttling.
 *
 * The previous limiter used a process-local Map, so a restart or a second
 * process reset the window. This implementation stores the counter in SQLite
 * and uses BEGIN IMMEDIATE so concurrent requests cannot both observe an
 * under-limit count and then both increment it.
 *
 * This is intentionally a single-host primitive. It coordinates processes that
 * share the same SQLite file; it is not a distributed rate limiter for
 * horizontally scaled deployments.
 */

export const API_RATE_LIMIT_MAX_KEYS = 20_000;

export type ApiRateLimitResult = {
  limited: boolean;
  retryAfter: number;
  count: number;
  limit: number;
  durable: boolean;
};

export function consumeApiRateLimit(input: {
  key: string;
  limit?: number;
  windowMs?: number;
  now?: Date;
}): ApiRateLimitResult {
  const limit = Math.max(1, Math.floor(input.limit ?? 180));
  const windowMs = Math.max(1_000, Math.floor(input.windowMs ?? 60_000));
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const resetAt = new Date(nowMs + windowMs).toISOString();
  const db = getDb();

  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    // Keep the table bounded without deleting an active counter. This is cheap
    // because reset_at is indexed and the proxy calls it once per API request.
    db.prepare("DELETE FROM api_rate_limits WHERE reset_at <= ?").run(nowIso);

    const row = db
      .prepare("SELECT count, reset_at FROM api_rate_limits WHERE key = ?")
      .get(input.key) as { count: number; reset_at: string } | undefined;

    const expired = !row || !Number.isFinite(Date.parse(row.reset_at)) || Date.parse(row.reset_at) <= nowMs;
    const count = expired ? 1 : Number(row.count) + 1;
    const nextReset = expired ? resetAt : row.reset_at;

    db.prepare(
      `INSERT INTO api_rate_limits (key, count, reset_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         count = excluded.count,
         reset_at = excluded.reset_at,
         updated_at = excluded.updated_at`,
    ).run(input.key, count, nextReset, nowIso);

    // Bound cardinality even when every key is still inside its window.
    const size = db.prepare("SELECT COUNT(*) AS c FROM api_rate_limits").get() as { c: number };
    if (Number(size.c) > API_RATE_LIMIT_MAX_KEYS) {
      db.prepare(
        `DELETE FROM api_rate_limits
         WHERE key IN (
           SELECT key FROM api_rate_limits ORDER BY updated_at ASC LIMIT ?
         )`,
      ).run(Number(size.c) - API_RATE_LIMIT_MAX_KEYS);
    }

    db.exec("COMMIT");
    transactionOpen = false;

    const retryAfter = Math.max(1, Math.ceil((Date.parse(nextReset) - nowMs) / 1000));
    return { limited: count > limit, retryAfter: count > limit ? retryAfter : 0, count, limit, durable: true };
  } catch {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction is already gone. Do not hide the original failure.
      }
    }
    // A locked/unavailable database must not turn every API route into a 500.
    // Availability wins here; the request still passes through authentication
    // and the route's own authorization checks.
    return { limited: false, retryAfter: 0, count: 0, limit, durable: false };
  }
}

export function resetApiRateLimits(): void {
  getDb().exec("DELETE FROM api_rate_limits");
}

export function apiRateLimitCount(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS c FROM api_rate_limits").get() as { c: number };
  return Number(row.c);
}
