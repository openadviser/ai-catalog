// The spec's date rules, applied to a source's dates (TIME-1, TIME-5, TIME-6).
//
// A source date without a time of day means 00:00 in the zone the source states for
// it, or in UTC when it states none. "Through D" ends at 00:00 on the day after D;
// "starting D" begins at 00:00 on D. The rule applied is recorded on the reading:
// `date-only-utc`, `date-only-zoned`, `stated-instant` or `undated`.
//
// A change read with no stated effective date is flagged `undated`; the release
// workflow (C4) makes it effective at the release's `publishedAt`, never earlier.

import { NeedsReview } from "./evidence.ts";
import type { DateRule, Instant } from "./reading.ts";

export interface Dated {
  instant?: Instant;
  rule: DateRule;
}

export interface DateOnly {
  year: number;
  month: number;
  day: number;
}

const MONTHS = new Map(
  [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].map((name, i) => [name, i + 1]),
);

const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ISO_DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const LONG_DATE = /^([A-Za-z]+) ([0-9]{1,2}), ([0-9]{4})$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function validDate(d: DateOnly): boolean {
  return d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= daysInMonth(d.year, d.month);
}

/** Parses a source date: ISO `2027-01-01` or the page's "January 1, 2027" form. */
export function parseDateOnly(text: string): DateOnly {
  const iso = ISO_DATE.exec(text.trim());
  if (iso !== null) {
    const d = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
    if (!validDate(d)) throw new NeedsReview("bad-date", `${text}: not a Gregorian date`);
    return d;
  }
  const long = LONG_DATE.exec(text.trim());
  if (long !== null) {
    const month = MONTHS.get((long[1] ?? "").toLowerCase());
    if (month !== undefined) {
      const d = { year: Number(long[3]), month, day: Number(long[2]) };
      if (!validDate(d)) throw new NeedsReview("bad-date", `${text}: not a Gregorian date`);
      return d;
    }
  }
  throw new NeedsReview("bad-date", `${JSON.stringify(text)}: not a date this reader understands`);
}

function wholeSecond(date: globalThis.Date): Instant {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function zonedFormatter(zone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new NeedsReview("bad-zone", `${zone}: not an IANA zone this runtime knows`);
  }
}

/** The offset in ms of `zone` at the UTC instant `at` (zone local minus UTC). */
function zoneOffset(zone: string, at: number): number {
  const parts = zonedFormatter(zone).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second"),
  );
  return asUtc - at;
}

/** The UTC instant of 00:00 in `zone` on `date`. "UTC" and omitted zones read in UTC. */
export function zonedMidnightUtc(date: DateOnly, zone?: string): Instant {
  if (zone === undefined || zone === "UTC") {
    return wholeSecond(new globalThis.Date(Date.UTC(date.year, date.month - 1, date.day)));
  }
  const utc = Date.UTC(date.year, date.month - 1, date.day);
  let guess = utc;
  for (let i = 0; i < 3; i += 1) {
    const next = utc - zoneOffset(zone, guess);
    if (next === guess) break;
    guess = next;
  }
  return wholeSecond(new globalThis.Date(guess));
}

function nextDay(date: DateOnly): DateOnly {
  const after = new Date(Date.UTC(date.year, date.month - 1, date.day) + 86_400_000);
  return { year: after.getUTCFullYear(), month: after.getUTCMonth() + 1, day: after.getUTCDate() };
}

/** "Through D" ends at 00:00 on the day after D, in the zone stated or in UTC. */
export function throughDate(text: string, zone?: string): Dated {
  const rule: DateRule = zone === undefined ? "date-only-utc" : "date-only-zoned";
  return { instant: zonedMidnightUtc(nextDay(parseDateOnly(text)), zone), rule };
}

/** "Starting D" begins at 00:00 on D, in the zone stated or in UTC. */
export function startingDate(text: string, zone?: string): Dated {
  const rule: DateRule = zone === undefined ? "date-only-utc" : "date-only-zoned";
  return { instant: zonedMidnightUtc(parseDateOnly(text), zone), rule };
}

/** A source that states no date at all. */
export function undated(): Dated {
  return { rule: "undated" };
}

/** A source states the instant itself; checked against TIME-1's whole-second form. */
export function statedInstant(text: string): Dated {
  const trimmed = text.trim();
  const ms = INSTANT.test(trimmed) ? new globalThis.Date(trimmed).getTime() : NaN;
  if (
    Number.isNaN(ms) ||
    new globalThis.Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z") !== trimmed
  ) {
    throw new NeedsReview(
      "bad-instant",
      `${JSON.stringify(text)}: not a valid whole-second UTC instant`,
    );
  }
  return { instant: trimmed, rule: "stated-instant" };
}
