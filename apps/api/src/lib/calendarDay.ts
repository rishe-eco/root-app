/**
 * Calendar days on the wire (journeys build plan PD-19). A deadline, a phase's
 * planned end, an invoice's due date is a *day*, stored as a Postgres `date`
 * and carried across the API as `YYYY-MM-DD` — never as an instant. The only
 * two conversions live here so no resolver hand-rolls one: a string in, a
 * `Date` at midnight **UTC** out (which is exactly what Prisma writes into a
 * `date` column, and what it reads back), and the reverse.
 *
 * Nothing here touches the local time zone. `new Date('2026-10-23')` parses as
 * UTC midnight by the spec, but `new Date(2026, 9, 23)` and `getDate()` do not,
 * and the difference is a day off in half the world — so the constructor used
 * below is `Date.UTC`, and the readers are `getUTC*`.
 */

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The years a project could plausibly name — a typo (`0202`, `20260`) fails
 *  the shape test; a `1999` is refused here as a day in the past nobody means. */
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

/** `YYYY-MM-DD` → midnight UTC, or null when it is not a real calendar day
 *  (`2026-02-30` is a shape match and not a date: the round trip catches it). */
export function parseCalendarDay(text: string): Date | null {
  const m = DAY.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  const same = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return same ? date : null;
}

/** A `date` column's value → `YYYY-MM-DD`, in UTC. */
export function calendarDayString(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
