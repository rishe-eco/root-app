import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, calendarOf, formatDayText, monthGrid, parseDayText, partsIn, shiftMonth, weekdayOf } from './day.js';

test('typing: Jalali below year 1700 and Gregorian from it name the same day, in any digits', () => {
  assert.equal(parseDayText('1405/08/26'), '2026-11-17');
  assert.equal(parseDayText('2026-11-17'), '2026-11-17');
  assert.equal(parseDayText('۱۴۰۵/۰۸/۲۶'), '2026-11-17');
  assert.equal(parseDayText('١٤٠٥/٠٨/٢٦'), '2026-11-17');
  assert.equal(parseDayText('1405-8-26'), '2026-11-17', 'single-digit month, other separator');
  assert.equal(parseDayText(' 2026.11.17 '), '2026-11-17');
});

test('typing: 30 Esfand exists only in a Jalali leap year (1403), and an unreal day is null, never rolled over', () => {
  assert.equal(parseDayText('1403/12/30'), '2025-03-20');
  assert.equal(parseDayText('1404/12/30'), null, '1404 is a common year');
  assert.equal(parseDayText('1405/07/31'), null, 'Mehr has 30 days');
  assert.equal(parseDayText('1405/13/01'), null);
  assert.equal(parseDayText('2026-02-30'), null);
  assert.equal(parseDayText('2024-02-29'), '2024-02-29');
  assert.equal(parseDayText('2025-02-29'), null);
  for (const junk of ['', '   ', 'tomorrow', '1405/08', '1405/08/26/1', '26/08/1405']) assert.equal(parseDayText(junk), null, junk);
});

test('the field shows Jalali with Persian digits in fa and the ISO day in en; the two parse back to the stored day', () => {
  assert.equal(formatDayText('2026-11-17', 'fa'), '۱۴۰۵/۰۸/۲۶');
  assert.equal(formatDayText('2026-11-17', 'en'), '2026-11-17');
  assert.equal(formatDayText('2026-11-17T00:00:00.000Z', 'en'), '2026-11-17');
  assert.equal(formatDayText('not a day', 'fa'), '');
  for (const locale of ['fa', 'en'] as const) assert.equal(parseDayText(formatDayText('2025-03-20', locale)), '2025-03-20');
});

test('day arithmetic crosses months and years without a zone', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(weekdayOf('2026-11-17'), 2, 'a Tuesday');
  assert.equal(calendarOf('fa'), 'jalali');
  assert.equal(calendarOf('en'), 'gregorian');
});

test('shiftMonth clamps to the shorter month, in each calendar', () => {
  assert.equal(shiftMonth('2026-01-31', 1, 'gregorian'), '2026-02-28');
  assert.equal(shiftMonth('2026-12-15', 1, 'gregorian'), '2027-01-15');
  // 31 Shahrivar 1405 + 1 month → 30 Mehr (Mehr has 30 days).
  const shahrivar31 = parseDayText('1405/06/31')!;
  assert.deepEqual(partsIn(shiftMonth(shahrivar31, 1, 'jalali'), 'jalali'), { year: 1405, month: 7, day: 30 });
  assert.deepEqual(partsIn(shiftMonth(parseDayText('1405/01/10')!, -1, 'jalali'), 'jalali'), { year: 1404, month: 12, day: 10 });
});

test('the month grid: whole weeks, the right first column, every day once', () => {
  const nov = monthGrid('2026-11-17', 'gregorian', 'en');
  assert.ok(nov.every((w) => w.length === 7));
  assert.deepEqual(nov.flat().filter(Boolean).length, 30);
  assert.equal(nov[0].findIndex(Boolean), 0, '1 Nov 2026 is a Sunday: the first column of an English week');
  const aban = monthGrid('2026-11-17', 'jalali', 'fa');
  assert.equal(aban.flat().filter(Boolean).length, 30, 'Aban has 30 days');
  // 1 Aban 1405 = 2026-10-23, a Friday: the last column of a Saturday-first week.
  assert.equal(aban[0].findIndex(Boolean), 6);
  assert.equal(aban.flat().find(Boolean), '2026-10-23');
});
