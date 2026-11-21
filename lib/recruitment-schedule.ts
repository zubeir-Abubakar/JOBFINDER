import { nowIso, one, run } from "./db";

/**
 * Persistent weekly schedules for autonomous recruitment and the daily report.
 *
 * The clock is the wall clock in Europe/Zurich, not UTC and not the host's
 * timezone, so a 09:00 run stays at 09:00 local time across the CET/CEST
 * switch. State lives in SQLite (`schedule_jobs`), so a restart cannot forget
 * the next execution; an in-memory timer only decides when to ask the database
 * again.
 *
 * Weekdays use ISO numbering (1 = Monday … 7 = Sunday). Configured weekdays are
 * persisted as JSON so they can be changed without a code change.
 */

export const RECRUITMENT_TIMEZONE = "Europe/Zurich";
export const RECRUITMENT_TIME = "09:00";
export const RECRUITMENT_WEEKDAYS = [1, 2, 3, 4, 5];
export const RECRUITMENT_SCHEDULE_KEY = "daily_recruitment";
export const REPORT_TIME = "16:00";
export const REPORT_WEEKDAYS = [1, 2, 3, 4, 5];
export const REPORT_SCHEDULE_KEY = "daily_executive_brief";
export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

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
  weekdays: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_id: string | null;
  last_status: string | null;
  last_error: string | null;
  last_checked_at: string | null;
  last_scheduled_for: string | null;
  updated_at: string;
};

const WEEKDAY_NAMES: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
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

function sameLocalParts(date: Date, parts: ZonedParts, timeZone: string): boolean {
  const actual = partsOf(date, timeZone);
  return (
    actual.year === parts.year &&
    actual.month === parts.month &&
    actual.day === parts.day &&
    actual.hour === parts.hour &&
    actual.minute === parts.minute
  );
}

/**
 * Converts a wall-clock time in `timeZone` to a real UTC instant.
 *
 * Daylight-saving policy (deterministic and tested):
 * - Ambiguous local times (the repeated hour when clocks go back) resolve to
 *   the earlier instant, so an occurrence is never executed twice.
 * - A nonexistent local time (the skipped hour when clocks go forward) is
 *   shifted forward to the first existing local minute instead of being
 *   silently dropped.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone = RECRUITMENT_TIMEZONE,
): Date {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = new Set<number>();
  for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
    offsets.add(zoneOffsetMs(new Date(target + hours * 3600_000), timeZone));
  }
  const wanted = { year, month, day, hour, minute, second: 0 };
  const matches = [...offsets]
    .map((offset) => new Date(target - offset))
    .filter((candidate) => sameLocalParts(candidate, wanted, timeZone))
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length > 0) return matches[0];

  // Nonexistent local time: walk forward one local minute at a time (the gap is
  // never more than one hour in the configured timezone).
  for (let add = 1; add <= 180; add += 1) {
    const shifted = new Date(target + add * 60_000);
    const shiftedParts = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: shifted.getUTCHours(),
      minute: shifted.getUTCMinutes(),
      second: 0,
    };
    const shiftedOffsets = new Set<number>();
    for (const hours of [-36, -24, -12, 0, 12, 24, 36]) {
      shiftedOffsets.add(zoneOffsetMs(new Date(shifted.getTime() + hours * 3600_000), timeZone));
    }
    const found = [...shiftedOffsets]
      .map((offset) => new Date(shifted.getTime() - offset))
      .filter((candidate) => sameLocalParts(candidate, shiftedParts, timeZone))
      .sort((a, b) => a.getTime() - b.getTime());
    if (found.length > 0) return found[0];
  }
  return new Date(target);
}

export function parseClockTime(value = RECRUITMENT_TIME): { hour: number; minute: number } {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return { hour: 9, minute: 0 };
  return { hour, minute };
}

/** Strict server-side validation. Invalid values are rejected, never repaired silently. */
export function isValidClockTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return Boolean(match);
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Accepts a JSON string, an array, or a comma-separated list. */
export function parseWeekdays(value: unknown): number[] {
  let raw: unknown = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.split(",");
    }
  }
  if (!Array.isArray(raw)) return [];
  const days = raw
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 1 && item <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

export function isValidWeekdays(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const parsed = parseWeekdays(value);
  return parsed.length === value.length && parsed.length > 0;
}

/** ISO weekday (1 = Monday … 7 = Sunday) in the schedule timezone. */
export function localWeekday(date: Date, timeZone = RECRUITMENT_TIMEZONE): number {
  const name = new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long" }).format(date);
  const entry = Object.entries(WEEKDAY_NAMES).find(([, label]) => label === name);
  return entry ? Number(entry[0]) : 1;
}

export function weekdayLabel(day: number): string {
  return WEEKDAY_NAMES[day] ?? String(day);
}

/**
 * Next occurrence strictly after `now` for a local time and weekday set.
 * When `weekdays` is omitted every day is eligible (legacy daily behaviour).
 */
export function nextScheduledRun(
  now: Date,
  options: { time?: string; timeZone?: string; weekdays?: number[] } = {},
): Date {
  const time = options.time ?? RECRUITMENT_TIME;
  const timeZone = options.timeZone ?? RECRUITMENT_TIMEZONE;
  const weekdays = options.weekdays && options.weekdays.length > 0 ? parseWeekdays(options.weekdays) : ALL_WEEKDAYS;
  const { hour, minute } = parseClockTime(time);
  const today = zonedParts(now, timeZone);
  for (let offset = 0; offset <= 14; offset += 1) {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const candidate = zonedTimeToUtc(
      base.getUTCFullYear(),
      base.getUTCMonth() + 1,
      base.getUTCDate(),
      hour,
      minute,
      timeZone,
    );
    if (candidate.getTime() <= now.getTime()) continue;
    if (!weekdays.includes(localWeekday(candidate, timeZone))) continue;
    return candidate;
  }
  // A search this wide cannot fail for a valid weekday set; keep a safe result.
  return new Date(now.getTime() + 24 * 3600_000);
}

/** Legacy helper. With no weekday option it means every day. */
export function nextDailyRun(now: Date, options: { time?: string; timeZone?: string; weekdays?: number[] } = {}): Date {
  return nextScheduledRun(now, options);
}

/** Local calendar date in the schedule timezone, e.g. 2026-11-18. */
export function localDateKey(date: Date = new Date(), timeZone = RECRUITMENT_TIMEZONE): string {
  const parts = partsOf(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function catchUpWindowHours(): number {
  const parsed = Number(process.env.RECRUITMENT_CATCHUP_HOURS ?? "6");
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(48, parsed) : 6;
}

function normaliseRow(row: ScheduleRow): ScheduleRow {
  return { ...row, weekdays: row.weekdays ?? JSON.stringify(RECRUITMENT_WEEKDAYS) };
}

function readRow(key: string): ScheduleRow | null {
  const row = one<ScheduleRow>("SELECT * FROM schedule_jobs WHERE key = ?", [key]);
  return row ? normaliseRow(row) : null;
}

export function ensureSchedule(now: Date = new Date()): ScheduleRow {
  const existing = readRow(RECRUITMENT_SCHEDULE_KEY);
  if (existing) return existing;
  const next = nextScheduledRun(now, { time: RECRUITMENT_TIME, weekdays: RECRUITMENT_WEEKDAYS });
  run(
    "INSERT OR IGNORE INTO schedule_jobs (key, label, time, timezone, enabled, weekdays, next_run_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)",
    [
      RECRUITMENT_SCHEDULE_KEY,
      "Autonomous recruitment runs",
      RECRUITMENT_TIME,
      RECRUITMENT_TIMEZONE,
      JSON.stringify(RECRUITMENT_WEEKDAYS),
      next.toISOString(),
      nowIso(),
    ],
  );
  const created = readRow(RECRUITMENT_SCHEDULE_KEY);
  if (!created) throw new Error("The recruitment schedule row could not be created.");
  return created;
}

export function getSchedule(now: Date = new Date()): ScheduleRow {
  return ensureSchedule(now);
}

export function getScheduleRow(key: string, now: Date = new Date()): ScheduleRow {
  if (key === RECRUITMENT_SCHEDULE_KEY) return ensureSchedule(now);
  const row = readRow(key);
  if (!row) throw new Error(`Unknown schedule: ${key}`);
  return row;
}

export function setScheduleEnabled(enabled: boolean, now: Date = new Date(), key = RECRUITMENT_SCHEDULE_KEY): ScheduleRow {
  const row = getScheduleRow(key, now);
  const weekdays = parseWeekdays(row.weekdays);
  run(
    "UPDATE schedule_jobs SET enabled = ?, next_run_at = ?, last_error = NULL, updated_at = ? WHERE key = ?",
    [
      enabled ? 1 : 0,
      enabled ? nextScheduledRun(now, { time: row.time, timeZone: row.timezone, weekdays }).toISOString() : null,
      nowIso(),
      key,
    ],
  );
  return getScheduleRow(key, now);
}

export function setScheduleClock(time: string, timeZone: string, now: Date = new Date(), key = RECRUITMENT_SCHEDULE_KEY): ScheduleRow {
  const row = getScheduleRow(key, now);
  const weekdays = parseWeekdays(row.weekdays);
  run(
    "UPDATE schedule_jobs SET time = ?, timezone = ?, next_run_at = ?, updated_at = ? WHERE key = ?",
    [time, timeZone, nextScheduledRun(now, { time, timeZone, weekdays }).toISOString(), nowIso(), key],
  );
  return getScheduleRow(key, now);
}

export function setScheduleWeekdays(weekdays: number[], now: Date = new Date(), key = RECRUITMENT_SCHEDULE_KEY): ScheduleRow {
  const row = getScheduleRow(key, now);
  if (!isValidWeekdays(weekdays)) throw new Error("Select at least one valid weekday.");
  run(
    "UPDATE schedule_jobs SET weekdays = ?, next_run_at = ?, updated_at = ? WHERE key = ?",
    [
      JSON.stringify(parseWeekdays(weekdays)),
      row.enabled === 1
        ? nextScheduledRun(now, { time: row.time, timeZone: row.timezone, weekdays }).toISOString()
        : null,
      nowIso(),
      key,
    ],
  );
  return getScheduleRow(key, now);
}

export type ScheduleConfigurationInput = {
  enabled: boolean;
  weekdays: unknown;
  time: unknown;
  timezone: unknown;
};

export type ScheduleConfigurationResult =
  | { ok: true; schedule: ScheduleRow }
  | { ok: false; error: string };

/** Validated owner update used by the settings cards. */
export function saveScheduleConfiguration(
  key: string,
  input: ScheduleConfigurationInput,
  now: Date = new Date(),
): ScheduleConfigurationResult {
  const weekdays = parseWeekdays(input.weekdays);
  if (!isValidClockTime(input.time)) return { ok: false, error: "Choose a valid 24-hour time (HH:MM)." };
  if (!isValidTimezone(input.timezone)) return { ok: false, error: "Choose a valid IANA timezone, for example Europe/Zurich." };
  // An enabled schedule must have at least one day. A disabled schedule may be
  // saved without days; the last valid selection is kept so re-enabling is
  // unambiguous.
  if (input.enabled && !isValidWeekdays(weekdays)) {
    return { ok: false, error: "Select at least one weekday when the schedule is enabled." };
  }
  if (!input.enabled && !isValidWeekdays(weekdays) && weekdays.length > 0) {
    return { ok: false, error: "Weekday values must be between 1 (Monday) and 7 (Sunday)." };
  }
  const row = getScheduleRow(key, now);
  const next = input.enabled
    ? nextScheduledRun(now, { time: input.time, timeZone: input.timezone, weekdays }).toISOString()
    : null;
  run(
    `UPDATE schedule_jobs SET enabled = ?, weekdays = ?, time = ?, timezone = ?, next_run_at = ?, updated_at = ?
     WHERE key = ?`,
    [input.enabled ? 1 : 0, JSON.stringify(weekdays.length ? weekdays : parseWeekdays(row.weekdays)), input.time, input.timezone, next, nowIso(), key],
  );
  return { ok: true, schedule: getScheduleRow(key, now) };
}

/** Records the outcome of a run and rolls the next occurrence forward. */
export function recordScheduleRun(input: {
  runId: string;
  status: string;
  error?: string | null;
  now?: Date;
  /** The occurrence that was executed, for restart-safe idempotency. */
  scheduledFor?: string | null;
  key?: string;
}): ScheduleRow {
  const now = input.now ?? new Date();
  const key = input.key ?? RECRUITMENT_SCHEDULE_KEY;
  const row = getScheduleRow(key, now);
  const next = nextScheduledRun(now, {
    time: row.time,
    timeZone: row.timezone,
    weekdays: parseWeekdays(row.weekdays),
  });
  run(
    `UPDATE schedule_jobs SET last_run_at = ?, last_run_id = ?, last_status = ?, last_error = ?, next_run_at = ?,
       last_scheduled_for = COALESCE(?, last_scheduled_for), updated_at = ? WHERE key = ?`,
    [
      now.toISOString(),
      input.runId,
      input.status,
      input.error ?? null,
      next.toISOString(),
      input.scheduledFor ?? null,
      nowIso(),
      key,
    ],
  );
  return getScheduleRow(key, now);
}

export type ScheduleSnapshot = {
  key: string;
  label: string;
  time: string;
  timezone: string;
  enabled: boolean;
  weekdays: number[];
  weekdayLabels: string[];
  runsToday: boolean;
  nextRunAt: string | null;
  due: boolean;
  overdueMs: number;
  missed: boolean;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastScheduledFor: string | null;
  /** Written by the ticker, so health is observable even across processes. */
  lastCheckedAt: string | null;
  /** True when the server process itself must be running at the scheduled time. */
  requiresRunningHost: true;
};

export function scheduleSnapshot(now: Date = new Date(), key = RECRUITMENT_SCHEDULE_KEY): ScheduleSnapshot {
  const row = getScheduleRow(key, now);
  const weekdays = parseWeekdays(row.weekdays);
  const next = row.next_run_at ? Date.parse(row.next_run_at) : NaN;
  const enabled = row.enabled === 1;
  const runsToday = enabled && weekdays.includes(localWeekday(now, row.timezone));
  const overdueMs = enabled && Number.isFinite(next) ? now.getTime() - next : 0;
  const due = runsToday && Number.isFinite(next) && overdueMs >= 0;
  const windowMs = catchUpWindowHours() * 3600_000;
  return {
    key: row.key,
    label: row.label,
    time: row.time,
    timezone: row.timezone,
    enabled,
    weekdays,
    weekdayLabels: weekdays.map(weekdayLabel),
    runsToday,
    nextRunAt: row.next_run_at,
    due,
    overdueMs: Math.max(0, overdueMs),
    // A missed run stays recoverable inside the catch-up window. Beyond it the
    // day is skipped and the reason is reported, rather than silently pretending
    // a run happened.
    missed: enabled && runsToday && Number.isFinite(next) && overdueMs > windowMs,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastScheduledFor: row.last_scheduled_for,
    lastCheckedAt: row.last_checked_at ?? null,
    requiresRunningHost: true,
  };
}

/** True when this exact scheduled occurrence already ran (restart safe). */
export function occurrenceAlreadyExecuted(key: string, scheduledFor: string | null): boolean {
  if (!scheduledFor) return false;
  const row = getScheduleRow(key);
  return row.last_scheduled_for === scheduledFor && Boolean(row.last_run_id);
}

/** Local wall-clock label for UI text, e.g. "19 Nov 2026, 09:00 (Europe/Zurich)". */
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

/** 30-minute time options for the two scheduling cards. */
export function halfHourOptions(): string[] {
  const options: string[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (const minute of [0, 30]) {
      options.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    }
  }
  return options;
}
