// TIME-1: RFC 3339 UTC instants and dates, with the calendar checked.

const INSTANT = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/;
const INSTANT_AT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$/;
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function validDate(year: number, month: number, day: number): boolean {
  return year >= 1970 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/**
 * Whether `year-month-day` (written as in a release version, `YYYY.MM.DD.N`) is a Gregorian date.
 * VER-1 asks for a valid date and no more, so unlike TIME-1 it does not stop at 1970.
 */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

/** Epoch milliseconds of a date, or `undefined` when it is not a Gregorian date in 1970..9999. */
export function parseDate(text: string): number | undefined {
  const m = DATE.exec(text);
  if (m === null) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  if (!validDate(year, month, day)) return undefined;
  return Date.UTC(year, month - 1, day);
}

function parseWith(pattern: RegExp, text: string): number | undefined {
  const m = pattern.exec(text);
  if (m === null) return undefined;
  const [year, month, day, hour, minute, second] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
  ] as const;
  if (!validDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined;
  const millis = m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0"));
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

/** Epoch milliseconds of an instant in whole seconds, or `undefined` when it is invalid. */
export function parseInstant(text: string): number | undefined {
  return parseWith(INSTANT, text);
}

/** Epoch milliseconds of the instant a call is priced at: up to three fractional digits. */
export function parseInstantAt(text: string): number | undefined {
  return parseWith(INSTANT_AT, text);
}
