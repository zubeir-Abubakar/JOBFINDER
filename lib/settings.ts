import { all, nowIso, one, run } from "./db";

export type Settings = Record<string, any>;

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Settings = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value);
    } catch {
      out[row.key] = row.value;
    }
  }
  return out;
}

export function getSetting<T = any>(key: string, fallback: T): T {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key]);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown): void {
  run(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, JSON.stringify(value), nowIso()],
  );
}

export function isApprovalMode(): boolean {
  // Per-application approval is retired. Automatic submission is controlled by
  // the owner-level autonomous_submission switch instead.
  return false;
}

export function isAutonomousAllowed(): boolean {
  return getSetting<boolean>("autonomous_submission", true) !== false;
}
