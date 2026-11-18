import { nowIso, one, run } from "./db";

/**
 * Persistent daily schedule for the autonomous recruitment run.
 *
 * The clock is the wall clock in Europe/Zurich, not UTC and not the host's
 * timezone, so the run stays at 10:00 local time across the CET/CEST switch.
 * State lives in SQLite (`schedule_jobs`), so a restart cannot forget the next
 * execution; an in-memory timer only decides when to ask the database again.
 */

export const RECRUITMENT_TIMEZONE = "Europe/Zurich";
export const RECRUITMENT_TIME = "10:00";
export const RECRUITMENT_SCHEDULE_KEY = "daily_recruitment";

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type ScheduleRow = {
  key: string;
  label: string;
  time: string;
  timezone: string;
  enabled: number;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  updated_at: string;
};

function partsOf(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

export function zonedParts(date: Date, timeZone = RECRUITMENT_TIMEZONE): ZonedParts {
  return partsOf(date, timeZone);
}

/** Zone offset in milliseconds at a specific instant. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = partsOf(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `timeZone` to a real UTC instant. The offset is
 * sampled twice so a date on the other side of a DST transition still resolves
 * to the correct local time.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = RECRUITMENT_TIMEZONE,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstOffset = zoneOffsetMs(new Date(guess), timeZone);
  let candidate = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(candidate), timeZone);
  if (secondOffset !== firstOffset) candidate = guess - secondOffset;
  return new Date(candidate);
}

export function parseClockTime(value = RECRUITMENT_TIME): { hour: number; minute: number } {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 10, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 10, minute: 0 };
  return { hour, minute };
}

/** Next 10:00 Europe/Zurich strictly after `now`. */
export function nextDailyRun(now: Date, options: { time?: string; timeZone?: string } = {}): Date {
  const time = options.time ?? RECRUITMENT_TIME;
  const timeZone = options.timeZone ?? RECRUITMENT_TIMEZONE;
  const { hour, minute } = parseClockTime(time);
  const today = zonedParts(now, timeZone);
  const candidate = zonedTimeToUtc(today.year, today.month, today.day, hour, minute, timeZone);
  if (candidate.getTime() > now.getTime()) return candidate;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedTimeToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, timeZone);
}

/** Local calendar date in the recruitment timezone, e.g. 2026-11-18. */
export function localDateKey(date: Date = new Date(), timeZone = RECRUITMENT_TIMEZONE): string {
  const parts = partsOf(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function catchUpWindowHours(): number {
  const parsed = Number(process.env.RECRUITMENT_CATCHUP_HOURS ?? "6");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(48, parsed) : 6;
}

export function ensureSchedule(now: Date = new Date()): ScheduleRow {
  const existing = one<ScheduleRow>("SELECT * FROM schedule_jobs WHERE key = ?", [RECRUITMENT_SCHEDULE_KEY]);
  if (existing) return existing;
  const next = nextDailyRun(now);
  run(
    "INSERT OR IGNORE INTO schedule_jobs (key, label, time, timezone, enabled, next_run_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
    [RECRUITMENT_SCHEDULE_KEY, "Daily autonomous recruitment", RECRUITMENT_TIME, RECRUITMENT_TIMEZONE, next.toISOString(), nowIso()],
  );
  const created = one<ScheduleRow>("SELECT * FROM schedule_jobs WHERE key = ?", [RECRUITMENT_SCHEDULE_KEY]);
  if (!created) throw new Error("The recruitment schedule row could not be created.");
  return created;
}

export function getSchedule(now: Date = new Date()): ScheduleRow {
  return ensureSchedule(now);
}

export function setScheduleEnabled(enabled: boolean, now: Date = new Date()): ScheduleRow {
  ensureSchedule(now);
  run(
    "UPDATE schedule_jobs SET enabled = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE key = ?",
    [enabled ? 1 : 0, enabled ? nextDailyRun(now).toISOString() : null, nowIso(), RECRUITMENT_SCHEDULE_KEY],
  );
  return getSchedule(now);
}

export function setScheduleClock(time: string, timeZone: string, now: Date = new Date()): ScheduleRow {
  parseClockTime(time);
  ensureSchedule(now);
  run(
    "UPDATE schedule_jobs SET time = ?, timezone = ?, next_run_at = ?, updated_at = ? WHERE key = ?",
    [time, timeZone, nextDailyRun(now, { time, timeZone }).toISOString(), nowIso(), RECRUITMENT_SCHEDULE_KEY],
  );
  return getSchedule(now);
}

/** Records the outcome of a run and rolls the next execution forward. */
export function recordScheduleRun(input: {
  runId: string;
  status: string;
  error?: string | null;
  now?: Date;
}): ScheduleRow {
  const now = input.now ?? new Date();
  const row = ensureSchedule(now);
  const next = nextDailyRun(now, { time: row.time, timeZone: row.timezone });
  run(
    "UPDATE schedule_jobs SET last_run_at = ?, last_run_id = ?, last_status = ?, last_error = ?, next_run_at = ?, updated_at = ? WHERE key = ?",
    [now.toISOString(), input.runId, input.status, input.error ?? null, next.toISOString(), nowIso(), RECRUITMENT_SCHEDULE_KEY],
  );
  return getSchedule(now);
}

export type ScheduleSnapshot = {
  key: string;
  label: string;
  time: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string | null;
  due: boolean;
  overdueMs: number;
  missed: boolean;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  /** Written by the ticker, so health is observable even across processes. */
  lastCheckedAt: string | null;
  /** True when the server process itself must be running at the scheduled time. */
  requiresRunningHost: true;
};

export function scheduleSnapshot(now: Date = new Date()): ScheduleSnapshot {
  const row = ensureSchedule(now);
  const next = row.next_run_at ? Date.parse(row.next_run_at) : NaN;
  const enabled = row.enabled === 1;
  const overdueMs = enabled && Number.isFinite(next) ? now.getTime() - next : 0;
  const due = enabled && Number.isFinite(next) && overdueMs >= 0;
  const windowMs = catchUpWindowHours() * 3600_000;
  return {
    key: row.key,
    label: row.label,
    time: row.time,
    timezone: row.timezone,
    enabled,
    nextRunAt: row.next_run_at,
    due,
    overdueMs: Math.max(0, overdueMs),
    // A missed run stays recoverable inside the catch-up window. Beyond it the
    // day is skipped and the reason is reported, rather than silently pretending
    // a run happened.
    missed: enabled && Number.isFinite(next) && overdueMs > windowMs,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastCheckedAt: row.last_checked_at ?? null,
    requiresRunningHost: true,
  };
}

/** Local wall-clock label for UI text, e.g. "19 Nov 2026, 10:00 (Europe/Zurich)". */
export function formatInZone(value: string | null, timeZone = RECRUITMENT_TIMEZONE): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
