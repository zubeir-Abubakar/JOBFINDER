/**
 * Business calendar days.
 *
 * The owner and the recruitment schedule operate in Europe/Zurich, so every
 * "today" boundary in analytics is a Zurich calendar day, not a UTC day. A
 * Zurich day is 23 hours long when the clocks go forward and 25 hours long when
 * they go back; both are handled by resolving the local midnight to its real UTC
 * instant instead of assuming a fixed offset.
 *
 * All stored timestamps are ISO-8601 UTC strings, so comparisons against the
 * returned instants are exact.
 */

export const BUSINESS_TIMEZONE = "Europe/Zurich";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

/** Offset of the zone at this instant, in milliseconds east of UTC. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

/** The calendar day (YYYY-MM-DD) that `date` falls on in the business zone. */
export function businessDayKey(date: Date, timeZone: string = BUSINESS_TIMEZONE): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Calendar arithmetic on a day string. Independent of any zone or offset. */
export function businessDayAdd(day: string, amount: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date) + amount * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The first instant of a Zurich calendar day.
 *
 * The offset is looked up at the candidate instant and corrected until stable,
 * which is what makes a spring-forward day start at 23:00Z (CET) and the next
 * day start at 22:00Z (CEST).
 */
export function businessDayStart(day: string, timeZone: string = BUSINESS_TIMEZONE): Date {
  const [year, month, date] = day.split("-").map(Number);
  const localMidnightAsUtc = Date.UTC(year, month - 1, date, 0, 0, 0, 0);
  let instant = localMidnightAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const corrected = localMidnightAsUtc - zoneOffsetMs(new Date(instant), timeZone);
    if (corrected === instant) break;
    instant = corrected;
  }
  return new Date(instant);
}

/** The first instant AFTER the given day (exclusive upper bound). */
export function businessDayEnd(day: string, timeZone: string = BUSINESS_TIMEZONE): Date {
  return businessDayStart(businessDayAdd(day, 1), timeZone);
}

/** Inclusive day strings to an exact instant range for stored ISO timestamps. */
export function businessDayBounds(
  from: string,
  to: string,
  timeZone: string = BUSINESS_TIMEZONE,
): { startIso: string; endIso: string; start: Date; end: Date } {
  const start = businessDayStart(from, timeZone);
  const end = businessDayEnd(to, timeZone);
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

export function isValidBusinessDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}
