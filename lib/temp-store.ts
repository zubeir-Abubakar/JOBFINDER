import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { all, nowIso, one, run, TEMP_DIR } from "./db";
import { randomId } from "./security";
import { getSetting, setSetting } from "./settings";
import { audit } from "./audit";

/**
 * Explicitly registered temporary objects. Cleanup only ever acts on rows in
 * this table and files inside TEMP_DIR. Permanent documents, the original CV,
 * uploads, application records and workflow history are never inspected here.
 */

export type TempKind = "tts_audio" | "transcript" | "preview" | "upload";

export type TempObjectRow = {
  id: string;
  kind: TempKind;
  relative_path: string | null;
  size_bytes: number;
  status: string;
  expires_at: string;
  created_at: string;
  meta: string | null;
};

export type TempStats = {
  activeCount: number;
  activeBytes: number;
  ttsBytes: number;
  transcriptBytes: number;
  previewBytes: number;
  uploadBytes: number;
  lastCleanupAt: string | null;
  nextCleanupAt: string | null;
  lastRemoved: number;
  lastBytes: number;
};

export function tempFilePath(fileName: string): string {
  return path.join(TEMP_DIR, path.basename(fileName));
}

export function ttlHours(): number {
  const raw = Number(process.env.TEMP_TTL_HOURS ?? 24);
  return Number.isFinite(raw) && raw > 0 ? Math.min(168, raw) : 24;
}

export function registerTempObject(input: {
  id?: string;
  kind: TempKind;
  fileName: string;
  sizeBytes: number;
  ttlHours?: number;
  meta?: Record<string, unknown>;
}): string {
  const id = input.id ?? `tmp_${randomId()}`;
  const created = new Date();
  const expires = new Date(created.getTime() + (input.ttlHours ?? ttlHours()) * 3600_000);
  run(
    `INSERT OR REPLACE INTO temp_objects (id, kind, relative_path, size_bytes, status, expires_at, created_at, meta)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [id, input.kind, path.basename(input.fileName), Math.max(0, input.sizeBytes), expires.toISOString(), created.toISOString(), input.meta ? JSON.stringify(input.meta) : null],
  );
  return id;
}

export function findTempObject(id: string): TempObjectRow | null {
  return one<TempObjectRow>("SELECT * FROM temp_objects WHERE id = ? AND status = 'active'", [id]);
}

export function nextCleanupAt(): string | null {
  const hours = Number(process.env.TEMP_CLEANUP_INTERVAL_HOURS ?? 6);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(Date.now() + Math.min(48, hours) * 3600_000).toISOString();
}

export function tempStorageStats(): TempStats {
  const rows = all<{ kind: string; bytes: number; c: number }>(
    "SELECT kind, COALESCE(SUM(size_bytes), 0) AS bytes, COUNT(*) AS c FROM temp_objects WHERE status = 'active' GROUP BY kind",
  );
  const byKind = new Map(rows.map((row) => [row.kind, row]));
  const last = getSetting<{ last_run_at?: string; last_removed?: number; last_bytes?: number }>("temp_cleanup", {});
  const total = rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  return {
    activeCount: rows.reduce((sum, row) => sum + (row.c ?? 0), 0),
    activeBytes: total,
    ttsBytes: byKind.get("tts_audio")?.bytes ?? 0,
    transcriptBytes: byKind.get("transcript")?.bytes ?? 0,
    previewBytes: byKind.get("preview")?.bytes ?? 0,
    uploadBytes: byKind.get("upload")?.bytes ?? 0,
    lastCleanupAt: last.last_run_at ?? null,
    nextCleanupAt: nextCleanupAt(),
    lastRemoved: last.last_removed ?? 0,
    lastBytes: last.last_bytes ?? 0,
  };
}

export async function cleanupTempObjects(actor: string): Promise<{ removed: number; bytes: number }> {
  const rows = all<{ id: string; relative_path: string | null; size_bytes: number }>(
    "SELECT id, relative_path, size_bytes FROM temp_objects WHERE status = 'active' AND expires_at < ? LIMIT 500",
    [nowIso()],
  );
  let bytes = 0;
  for (const row of rows) {
    if (row.relative_path) {
      try {
        await unlink(tempFilePath(row.relative_path));
      } catch {
        // Already gone: retiring the registry row is still correct.
      }
    }
    run("UPDATE temp_objects SET status = 'deleted' WHERE id = ?", [row.id]);
    bytes += row.size_bytes ?? 0;
  }
  setSetting("temp_cleanup", {
    last_run_at: nowIso(),
    last_removed: rows.length,
    last_bytes: bytes,
    next_run_at: nextCleanupAt(),
  });
  if (rows.length > 0) {
    audit({
      action: "temp.cleanup",
      entity: "temp_objects",
      detail: `${rows.length} expired temporary object(s) removed, ${(bytes / 1024).toFixed(1)} KB reclaimed`,
      actor,
    });
  }
  return { removed: rows.length, bytes };
}

/** Purge registry rows whose files disappeared, plus very old deleted rows. */
export async function pruneTempRegistry(): Promise<void> {
  await mkdir(TEMP_DIR, { recursive: true });
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  run("DELETE FROM temp_objects WHERE status = 'deleted' AND created_at < ?", [cutoff]);
}
