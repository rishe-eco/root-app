import { isValidJalaaliDate, jalaaliMonthLength, toGregorian, toJalaali } from 'jalaali-js';

/**
 * The Jalali calendar for a date *input* (journeys build plan J4, PD-16, PD-19).
 * `Intl` can format a Persian date but cannot parse one, so the three-select
 * input (`DayInput`) converts through `jalaali-js` — and **only ever through a
 * `YYYY-MM-DD` string, never a `Date` in local time**. A `Date` built from a
 * Jalali day in the browser's zone is the day before, somewhere west of
 * Greenwich, and is exactly the bug PD-19 exists to prevent: 1 Aban becoming
 * 30 Mehr at 20:30. `jalaali-js` works in plain integers, so the whole round
 * trip is integers and a string:
 *
 *   `'2026-10-23'` ⇄ `{ jy: 1405, jm: 8, jd: 1 }`
 *
 * No zone is consulted anywhere in this file. (Rendering a stored day is
 * `calendarDate` in `format.ts`, which passes `timeZone: 'UTC'`.)
 */

export type JalaliParts = { jy: number; jm: number; jd: number };

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` → the Jalali day it is, or null when it is not a real day.
 *  Accepts the date part of an ISO instant too (`2026-10-23T00:00:00.000Z` — how
 *  a `date` column arrives), and reads only the date part: it is already the
 *  day, in UTC, and reading it back through a `Date` would put the machine's
 *  zone in. */
export function dayToJalali(day: string): JalaliParts | null {
  const m = DAY.exec(day.slice(0, 10));
  if (!m) return null;
  const [gy, gm, gd] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Reject 2026-02-30: shape-valid, not a day. `Date.UTC` normalizes it, so
  // the round trip through it tells.
  const check = new Date(Date.UTC(gy, gm - 1, gd));
  if (check.getUTCFullYear() !== gy || check.getUTCMonth() !== gm - 1 || check.getUTCDate() !== gd) return null;
  return toJalaali(gy, gm, gd);
}

/** A Jalali day → `YYYY-MM-DD`, or null when it is not a real Jalali day
 *  (30 Esfand of a common year, day 31 of Mehr–Esfand, month 13). */
export function jalaliToDay({ jy, jm, jd }: JalaliParts): string | null {
  if (!isValidJalaaliDate(jy, jm, jd)) return null;
  const { gy, gm, gd } = toGregorian(jy, jm, jd);
  return `${String(gy).padStart(4, '0')}-${String(gm).padStart(2, '0')}-${String(gd).padStart(2, '0')}`;
}

/** Days in a Jalali month — 31 for the first six, 30 for the next five, and
 *  Esfand's 29 or 30 by leap year. What the day select offers, and what a
 *  month change clamps a chosen day to. */
export function jalaliMonthLength(jy: number, jm: number): number {
  return jalaaliMonthLength(jy, jm);
}

/** The Jalali year a `YYYY-MM-DD` day falls in — for where the year select starts. */
export function jalaliYearOf(day: string): number | null {
  return dayToJalali(day)?.jy ?? null;
}

/** Today's Jalali year, from the machine's clock in UTC (a year select's
 *  centre needs no more precision than that). */
export function currentJalaliYear(now: Date = new Date()): number {
  return toJalaali(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()).jy;
}
