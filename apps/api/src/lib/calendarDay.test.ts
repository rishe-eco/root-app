import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDayString, parseCalendarDay } from './calendarDay.js';

/** Journeys build plan PD-19 — a calendar day on the wire is `YYYY-MM-DD`, in UTC. */

test('parseCalendarDay: a real day is midnight UTC, whatever zone the process runs in', () => {
  const day = parseCalendarDay('2026-10-23');
  assert.ok(day);
  assert.equal(day.toISOString(), '2026-10-23T00:00:00.000Z');
});

test('calendarDayString is the exact inverse, in UTC', () => {
  for (const text of ['2026-10-23', '2026-01-01', '2026-12-31', '2028-02-29', '2000-01-01']) {
    assert.equal(calendarDayString(parseCalendarDay(text)!), text);
  }
});

test('parseCalendarDay refuses what is not a calendar day', () => {
  for (const bad of ['', '2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '2027-02-29', '26-10-23', '2026/10/23', '2026-10-23T00:00:00Z', ' 2026-10-23', '1999-12-31', '2201-01-01', 'today']) {
    assert.equal(parseCalendarDay(bad), null, JSON.stringify(bad));
  }
});
