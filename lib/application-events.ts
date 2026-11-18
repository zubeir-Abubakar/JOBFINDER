import { nowIso, run } from "./db";

/** Per-application timeline used by the application detail page. */
export function recordApplicationEvent(input: {
  applicationId: string;
  type: string;
  message?: string | null;
  meta?: Record<string, unknown> | null;
}): void {
  run(
    "INSERT INTO application_events (application_id, type, message, meta, created_at) VALUES (?, ?, ?, ?, ?)",
    [
      input.applicationId,
      input.type,
      input.message ?? null,
      input.meta ? JSON.stringify(input.meta).slice(0, 8000) : null,
      nowIso(),
    ],
  );
}
