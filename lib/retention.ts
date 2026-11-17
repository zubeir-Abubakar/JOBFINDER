import { unlink } from "node:fs/promises";
import path from "node:path";
import { all, nowIso, one, run, UPLOAD_DIR, v } from "./db";
import { getSetting, setSetting } from "./settings";
import { audit } from "./audit";

export type StorageStats = {
  totalBytes: number;
  originalBytes: number;
  tailoredBytes: number;
  coverBytes: number;
  originalCount: number;
  tailoredCount: number;
  coverCount: number;
  expiringSoon: Array<{ id: string; display_name: string; kind: string; expires_at: string; size_bytes: number }>;
  deletedFiles: Array<{ relative_path: string; size_bytes: number }>;
};

export function storageStats(): StorageStats {
  const rows = all<{ kind: string; size_bytes: number; id: string; display_name: string; expires_at: string | null }>(
    "SELECT id, kind, size_bytes, display_name, expires_at FROM documents WHERE deleted_at IS NULL",
  );
  const stats: StorageStats = {
    totalBytes: 0,
    originalBytes: 0,
    tailoredBytes: 0,
    coverBytes: 0,
    originalCount: 0,
    tailoredCount: 0,
    coverCount: 0,
    expiringSoon: [],
    deletedFiles: [],
  };
  const soon = Date.now() + 7 * 86400_000;
  for (const row of rows) {
    stats.totalBytes += row.size_bytes ?? 0;
    if (row.kind === "original_cv") {
      stats.originalBytes += row.size_bytes ?? 0;
      stats.originalCount += 1;
    } else if (row.kind === "tailored_cv") {
      stats.tailoredBytes += row.size_bytes ?? 0;
      stats.tailoredCount += 1;
    } else {
      stats.coverBytes += row.size_bytes ?? 0;
      stats.coverCount += 1;
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < soon && new Date(row.expires_at).getTime() > Date.now()) {
      stats.expiringSoon.push({ id: row.id, display_name: row.display_name, kind: row.kind, expires_at: row.expires_at, size_bytes: row.size_bytes });
    }
  }
  return stats;
}

/**
 * Applies the retention policy. Only tailored documents that were submitted,
 * are past their expiry date and are not pinned get removed. The original CV,
 * professional profile, application history and audit records are never touched.
 */
export async function cleanupExpiredDocuments(actor: string): Promise<{ deleted: number; bytes: number }> {
  const enabled = getSetting<boolean>("auto_delete_expired", true);
  if (!enabled) {
    audit({ action: "retention.skipped", entity: "documents", detail: "Automatic deletion is disabled", actor });
    return { deleted: 0, bytes: 0 };
  }
  const rows = all<{ id: string; relative_path: string; size_bytes: number; kind: string }>(
    `SELECT id, relative_path, size_bytes, kind FROM documents
     WHERE deleted_at IS NULL AND pinned = 0 AND expires_at IS NOT NULL AND expires_at < ?
       AND kind IN ('tailored_cv','cover_letter') AND status = 'submitted'`,
    [nowIso()],
  );
  let bytes = 0;
  for (const row of rows) {
    const safe = path.basename(row.relative_path);
    try {
      await unlink(path.join(UPLOAD_DIR, safe));
    } catch {
      // File may already be gone; the database record is still retired.
    }
    run("UPDATE documents SET deleted_at = ? WHERE id = ?", [nowIso(), row.id]);
    bytes += row.size_bytes ?? 0;
  }
  setSetting("deletion", { last_run_at: nowIso(), last_deleted: rows.length });
  if (rows.length > 0) {
    audit({
      action: "documents.expired",
      entity: "documents",
      detail: `${rows.length} expired tailored document(s) removed under the retention policy`,
      actor,
    });
  }
  return { deleted: rows.length, bytes };
}

export function expiringDocuments() {
  return all(
    "SELECT * FROM documents WHERE deleted_at IS NULL AND expires_at IS NOT NULL ORDER BY expires_at ASC LIMIT 30",
  );
}

export function pinDocument(id: string, pinned: boolean): void {
  run("UPDATE documents SET pinned = ? WHERE id = ?", [v(pinned), id]);
}

export function markDeleted(id: string): void {
  run("UPDATE documents SET deleted_at = ? WHERE id = ?", [nowIso(), id]);
}

export function storageSettingDays(): number {
  return getSetting<number>("retention_days", 30);
}

export function totalRecordCount(table: string): number {
  const allowed = ["jobs", "applications", "documents", "users", "tasks", "audit_logs", "skills", "experiences"];
  if (!allowed.includes(table)) return 0;
  return one<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`)?.c ?? 0;
}
