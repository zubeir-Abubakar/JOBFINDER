import os from "node:os";
import { all, getDb, nowIso, one, run } from "./db";

/**
 * Durable runtime coordination for background work.
 *
 * The schedule and the queues are already persisted in SQLite. What was still
 * process-local was the claim: two application instances could both decide a
 * queue row or a schedule tick was due. `runtime_locks` provides an atomic
 * owner lease, and `runtime_workers` records the last heartbeat from each named
 * worker so the health view can distinguish running, stopped and stale workers.
 */

export const RUNTIME_LOCK_TTL_MS = 120_000;
export const WORKER_STALE_AFTER_MS = 120_000;

/**
 * Stable for the life of this process, including Next.js development hot
 * reloads. A random suffix created a new identity whenever this module was
 * re-evaluated, leaving healthy idle workers recorded under an old identity.
 * Host + PID is unique for the live process and does not change on reload.
 */
const processInstanceId =
  process.env.INSTANCE_ID?.trim() || `${os.hostname()}:${process.pid}`;

export type RuntimeLockRow = {
  key: string;
  owner: string;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  meta: string | null;
};

export type RuntimeWorkerRow = {
  name: string;
  instance_id: string;
  status: string;
  started_at: string;
  heartbeat_at: string;
  stopped_at: string | null;
  detail: string | null;
  updated_at: string;
};

export type RuntimeWorkerView = RuntimeWorkerRow & {
  effectiveStatus: "running" | "stopped" | "stale";
  heartbeatAgeSeconds: number;
};

export function runtimeInstanceId(): string {
  return processInstanceId;
}

type HeartbeatGlobal = typeof globalThis & {
  __atwRuntimeHeartbeat?: { timer?: ReturnType<typeof setInterval>; names: Set<string> };
};

function heartbeatState() {
  const g = globalThis as HeartbeatGlobal;
  g.__atwRuntimeHeartbeat ??= { names: new Set<string>() };
  return g.__atwRuntimeHeartbeat!;
}

/**
 * An idle queue is still a live worker. Activity-only heartbeats made a healthy
 * but quiet outbox look stale after two minutes, so every started worker gets a
 * lightweight process-local liveness pulse. The timer is unref'd and is stopped
 * when the last worker stops.
 */
function ensureRuntimeHeartbeat(): void {
  const state = heartbeatState();
  if (state.timer) return;
  state.timer = setInterval(() => {
    const at = nowIso();
    for (const name of state.names) {
      run(
        "UPDATE runtime_workers SET heartbeat_at = ?, status = 'running', stopped_at = NULL, updated_at = ? WHERE name = ? AND instance_id = ?",
        [at, at, name, processInstanceId],
      );
    }
  }, 30_000);
  state.timer.unref?.();
}

function clearRuntimeHeartbeatIfIdle(): void {
  const state = heartbeatState();
  if (state.names.size > 0 || !state.timer) return;
  clearInterval(state.timer);
  state.timer = undefined;
}

export function startRuntimeWorker(name: string, detail: string | null = null): void {
  const at = nowIso();
  run(
    `INSERT INTO runtime_workers (name, instance_id, status, started_at, heartbeat_at, stopped_at, detail, updated_at)
     VALUES (?, ?, 'running', ?, ?, NULL, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       instance_id = excluded.instance_id,
       status = 'running',
       started_at = excluded.started_at,
       heartbeat_at = excluded.heartbeat_at,
       stopped_at = NULL,
       detail = excluded.detail,
       updated_at = excluded.updated_at`,
    [name, processInstanceId, at, at, detail, at],
  );
  heartbeatState().names.add(name);
  ensureRuntimeHeartbeat();
}

export function heartbeatRuntimeWorker(name: string, detail: string | null = null): void {
  const at = nowIso();
  const db = getDb();
  const result = db
    .prepare(
      `UPDATE runtime_workers SET status = 'running', heartbeat_at = ?, detail = COALESCE(?, detail), stopped_at = NULL, updated_at = ?
       WHERE name = ? AND instance_id = ?`,
    )
    .run(at, detail, at, name, processInstanceId);
  if (Number(result.changes) === 0) {
    startRuntimeWorker(name, detail);
    return;
  }
  // A heartbeat is also proof that this process still owns a live worker.
  // Re-arm the shared timer so an idle queue cannot remain marked stale after
  // a prior timer shutdown, a module reload, or an initial startup heartbeat.
  heartbeatState().names.add(name);
  ensureRuntimeHeartbeat();
}

export function stopRuntimeWorker(name: string, detail: string | null = null): void {
  const at = nowIso();
  run(
    `UPDATE runtime_workers SET status = 'stopped', stopped_at = ?, heartbeat_at = ?, detail = COALESCE(?, detail), updated_at = ?
     WHERE name = ? AND instance_id = ?`,
    [at, at, detail, at, name, processInstanceId],
  );
  heartbeatState().names.delete(name);
  clearRuntimeHeartbeatIfIdle();
}

export function runtimeWorkerSnapshot(now: Date = new Date()): RuntimeWorkerView[] {
  const rows = all<RuntimeWorkerRow>(
    "SELECT name, instance_id, status, started_at, heartbeat_at, stopped_at, detail, updated_at FROM runtime_workers ORDER BY name",
  );
  return rows.map((row) => {
    const heartbeat = Date.parse(row.heartbeat_at);
    const heartbeatAgeSeconds = Number.isFinite(heartbeat)
      ? Math.max(0, Math.round((now.getTime() - heartbeat) / 1000))
      : WORKER_STALE_AFTER_MS / 1000 + 1;
    const effectiveStatus: RuntimeWorkerView["effectiveStatus"] =
      row.status !== "running"
        ? "stopped"
        : !Number.isFinite(heartbeat) || heartbeatAgeSeconds * 1000 > WORKER_STALE_AFTER_MS
          ? "stale"
          : "running";
    return { ...row, effectiveStatus, heartbeatAgeSeconds };
  });
}

/**
 * Acquire or renew a named lease. BEGIN IMMEDIATE makes the read/conditional
 * write atomic with respect to another process using the same SQLite database.
 * An unexpired lease owned by another instance is never stolen.
 */
export function acquireRuntimeLock(
  key: string,
  ttlMs = RUNTIME_LOCK_TTL_MS,
  owner = processInstanceId,
  meta: Record<string, unknown> | null = null,
): boolean {
  const db = getDb();
  const now = new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + Math.max(1_000, ttlMs)).toISOString();
  let transactionOpen = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const existing = db.prepare("SELECT owner, expires_at FROM runtime_locks WHERE key = ?").get(key) as
      | { owner: string; expires_at: string }
      | undefined;
    const heldByAnother =
      Boolean(existing) &&
      existing!.owner !== owner &&
      Number.isFinite(Date.parse(existing!.expires_at)) &&
      Date.parse(existing!.expires_at) > now.getTime();
    if (heldByAnother) {
      db.exec("ROLLBACK");
      transactionOpen = false;
      return false;
    }
    db.prepare(
      `INSERT INTO runtime_locks (key, owner, acquired_at, heartbeat_at, expires_at, meta)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         owner = excluded.owner,
         acquired_at = excluded.acquired_at,
         heartbeat_at = excluded.heartbeat_at,
         expires_at = excluded.expires_at,
         meta = excluded.meta`,
    ).run(key, owner, at, at, expiresAt, meta ? JSON.stringify(meta).slice(0, 4000) : null);
    db.exec("COMMIT");
    transactionOpen = false;
    return true;
  } catch {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The lease was not acquired; the caller will retry on the next tick.
      }
    }
    return false;
  }
}

export function refreshRuntimeLock(
  key: string,
  ttlMs = RUNTIME_LOCK_TTL_MS,
  owner = processInstanceId,
): boolean {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1_000, ttlMs)).toISOString();
  const result = getDb()
    .prepare("UPDATE runtime_locks SET heartbeat_at = ?, expires_at = ? WHERE key = ? AND owner = ?")
    .run(now.toISOString(), expiresAt, key, owner);
  return Number(result.changes) === 1;
}

export function releaseRuntimeLock(key: string, owner = processInstanceId): void {
  run("DELETE FROM runtime_locks WHERE key = ? AND owner = ?", [key, owner]);
}

export function runtimeLockSnapshot(now: Date = new Date()): Array<RuntimeLockRow & { active: boolean; ageSeconds: number }> {
  const rows = all<RuntimeLockRow>(
    "SELECT key, owner, acquired_at, heartbeat_at, expires_at, meta FROM runtime_locks ORDER BY key",
  );
  return rows.map((row) => {
    const acquired = Date.parse(row.acquired_at);
    return {
      ...row,
      active: Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > now.getTime(),
      ageSeconds: Number.isFinite(acquired) ? Math.max(0, Math.round((now.getTime() - acquired) / 1000)) : 0,
    };
  });
}

export function runtimeLockActive(key: string, now: Date = new Date()): boolean {
  const row = one<{ expires_at: string }>("SELECT expires_at FROM runtime_locks WHERE key = ?", [key]);
  return Boolean(row && Number.isFinite(Date.parse(row.expires_at)) && Date.parse(row.expires_at) > now.getTime());
}

export function runtimeSnapshot(now: Date = new Date()) {
  return {
    instanceId: processInstanceId,
    workers: runtimeWorkerSnapshot(now),
    locks: runtimeLockSnapshot(now),
  };
}
