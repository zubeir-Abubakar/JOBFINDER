import { all, nowIso, run, v } from "./db";

export function audit(entry: {
  userId?: string | null;
  actor?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  detail?: string | null;
  ip?: string | null;
}): void {
  run(
    "INSERT INTO audit_logs (user_id, actor, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      v(entry.userId ?? null),
      v(entry.actor ?? null),
      entry.action,
      v(entry.entity ?? null),
      v(entry.entityId ?? null),
      v(entry.detail ?? null),
      v(entry.ip ?? null),
      nowIso(),
    ],
  );
}

export function recentAudit(limit = 100, actions?: string[]) {
  if (actions?.length) {
    const placeholders = actions.map(() => "?").join(",");
    return all(
      `SELECT * FROM audit_logs WHERE action IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
      [...actions, limit],
    );
  }
  return all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?", [limit]);
}
