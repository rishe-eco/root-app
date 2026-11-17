import type { Locale } from '@/i18n';
import { dayToJalali, jalaliMonthLength, jalaliToDay } from './jalali';

/**
 * The text and calendar side of the one date field (`DayInput`, DX1, desk UX
 * review 24) — pure functions over **`YYYY-MM-DD` strings and integers**, never
 * a `Date` in local time (PD-19; see `jalali.ts`). The two calendars are the
 * same days written two ways, so everything here is "which calendar" plus a day.
 *
 * ## Typing
 *
 * `parseDayText` takes what a person types — Persian, Arabic-Indic or Latin
 * digits; `/`, `-`, `.` or `٫` between the parts — and reads the **year to
 * choose the calendar**: below 1700 it is Jalali (1405/08/26), from 1700 it is
 * Gregorian (2026-11-17). So typing works in both panels, whichever calendar
 * the panel shows; the day it names is the same day. A shape that is not a
 * real day in its calendar (Esfand 30 of a common year, 31 Shahrivar's
 * neighbour 31 Mehr, 30 February) is `null`, never rolled over.
 *
 * ## The grid
 *
 * `monthGrid` lays one month out as weeks for the popover: the first column is
 * Saturday in Persian (the Iranian week) and Sunday in English, and the cells
 * before the first day are `null`.
 */

export type Calendar = 'jalali' | 'gregorian';

/** The calendar a panel shows: Jalali in Persian, Gregorian in English. */
export const calendarOf = (locale: Locale): Calendar => (locale === 'fa' ? 'jalali' : 'gregorian');

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Persian and Arabic-Indic digits → Latin, and every separator → `/`. */
function normalize(text: string): string {
  return text
    .trim()
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/[-./\\٫،\s]+/g, '/');
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A Gregorian day → `YYYY-MM-DD`, or null when it is not a real day. */
export function gregorianToDay(gy: number, gm: number, gd: number): string | null {
  if (!Number.isInteger(gy) || !Number.isInteger(gm) || !Number.isInteger(gd)) return null;
  const check = new Date(Date.UTC(gy, gm - 1, gd));
  if (check.getUTCFullYear() !== gy || check.getUTCMonth() !== gm - 1 || check.getUTCDate() !== gd) return null;
  return `${pad(gy, 4)}-${pad(gm)}-${pad(gd)}`;
}

/** What a person typed → the `YYYY-MM-DD` day it names, or null. */
export function parseDayText(text: string): string | null {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalize(text));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return y < 1700 ? jalaliToDay({ jy: y, jm: mo, jd: d }) : gregorianToDay(y, mo, d);
}

/** A day as the text the field shows: `1405/08/26` (Persian digits) in fa, `2026-11-17` in en. */
export function formatDayText(day: string, locale: Locale): string {
  if (locale === 'fa') {
    const j = dayToJalali(day);
    if (!j) return '';
    const text = `${pad(j.jy, 4)}/${pad(j.jm)}/${pad(j.jd)}`;
    return text.replace(/\d/g, (d) => PERSIAN_DIGITS[Number(d)]);
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(day.slice(0, 10)) ? day.slice(0, 10) : '';
}

/** `YYYY-MM-DD` ± n days, by integer arithmetic on UTC. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type MonthParts = { year: number; month: number; day: number };

/** A day's year, month and day in a calendar. */
export function partsIn(day: string, cal: Calendar): MonthParts {
  if (cal === 'jalali') {
    const j = dayToJalali(day)!;
    return { year: j.jy, month: j.jm, day: j.jd };
  }
  const [year, month, d] = day.split('-').map(Number);
  return { year, month, day: d };
}

const dayFrom = (cal: Calendar, year: number, month: number, d: number): string =>
  (cal === 'jalali' ? jalaliToDay({ jy: year, jm: month, jd: d }) : gregorianToDay(year, month, d))!;

export function monthLength(cal: Calendar, year: number, month: number): number {
  return cal === 'jalali' ? jalaliMonthLength(year, month) : new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The same day-of-month `delta` months away, clamped to the month's length. */
export function shiftMonth(day: string, delta: number, cal: Calendar): string {
  const p = partsIn(day, cal);
  const index = p.year * 12 + (p.month - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12 + 12) % 12 + 1;
  return dayFrom(cal, year, month, Math.min(p.day, monthLength(cal, year, month)));
}

/** The month containing `day`, as weeks of seven cells; days outside it are null. */
export function monthGrid(day: string, cal: Calendar, locale: Locale): Array<Array<string | null>> {
  const p = partsIn(day, cal);
  const firstDay = dayFrom(cal, p.year, p.month, 1);
  const weekStart = locale === 'fa' ? 6 : 0; // Saturday in Persian, Sunday in English
  const lead = (weekday: number) => (weekday - weekStart + 7) % 7;
  const cells: Array<string | null> = Array.from({ length: lead(weekdayOf(firstDay)) }, () => null);
  for (let d = 1; d <= monthLength(cal, p.year, p.month); d += 1) cells.push(dayFrom(cal, p.year, p.month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
