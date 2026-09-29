import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate } from './format.js';
import { currentJalaliYear, dayToJalali, jalaliMonthLength, jalaliToDay } from './jalali.js';

/**
 * Journeys build plan J4 / PD-19: the Jalali input converts to and from a
 * `YYYY-MM-DD` string, never a `Date` in local time. These tests run the round
 * trip under zones on both sides of Greenwich, and render 1 Aban under a
 * negative-offset one.
 */

const ZONES = ['America/Los_Angeles', 'Pacific/Honolulu', 'UTC', 'Asia/Tehran', 'Pacific/Kiritimati'];

function inEveryZone(check: (tz: string) => void) {
  const original = process.env.TZ;
  try {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      check(tz);
    }
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

test('1 Aban 1405 is 2026-10-23 — and stays 1 Aban in every zone, both ways', () => {
  inEveryZone((tz) => {
    assert.deepEqual(dayToJalali('2026-10-23'), { jy: 1405, jm: 8, jd: 1 }, tz);
    assert.equal(jalaliToDay({ jy: 1405, jm: 8, jd: 1 }), '2026-10-23', tz);
  });
});

test('a stored day renders as 1 Aban under a negative-offset timezone — not 30 Mehr', () => {
  inEveryZone((tz) => {
    // What a `date` column looks like on the wire: midnight UTC. In Los Angeles
    // that instant is 17:00 on the 22nd — formatting it in local time would
    // print 30 Mehr. The renderer passes `timeZone: 'UTC'`.
    const fa = calendarDate('2026-10-23T00:00:00.000Z', 'fa');
    assert.match(fa, /۱ آبان ۱۴۰۵/, `${tz}: ${fa}`);
    assert.doesNotMatch(fa, /مهر/, tz);
    assert.equal(calendarDate('2026-10-23T00:00:00.000Z', 'en'), 'Oct 23, 2026', tz);
  });
});

test('the round trip is exact for every day of five years, in every zone — a Date never enters it', () => {
  inEveryZone((tz) => {
    const start = Date.UTC(2025, 0, 1);
    for (let i = 0; i < 366 * 5; i += 1) {
      const d = new Date(start + i * 86_400_000);
      const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      const parts = dayToJalali(day);
      assert.ok(parts, `${tz} ${day}`);
      assert.equal(jalaliToDay(parts), day, `${tz} ${day}`);
    }
  });
});

test('the ISO instant a date column arrives as reads as its own day', () => {
  inEveryZone((tz) => {
    assert.deepEqual(dayToJalali('2026-10-23T00:00:00.000Z'), { jy: 1405, jm: 8, jd: 1 }, tz);
  });
});

test('month lengths: 31 for Farvardin–Shahrivar, 30 for Mehr–Bahman, Esfand 29 or 30 by leap year', () => {
  for (let m = 1; m <= 6; m += 1) assert.equal(jalaliMonthLength(1405, m), 31, `month ${m}`);
  for (let m = 7; m <= 11; m += 1) assert.equal(jalaliMonthLength(1405, m), 30, `month ${m}`);
  // 1403 is a leap year in the Jalali calendar; 1404 and 1405 are not.
  assert.equal(jalaliMonthLength(1403, 12), 30);
  assert.equal(jalaliMonthLength(1404, 12), 29);
  assert.equal(jalaliMonthLength(1405, 12), 29);
});

test('what is not a day is refused, both directions', () => {
  assert.equal(dayToJalali('2026-02-30'), null);
  assert.equal(dayToJalali('2026-13-01'), null);
  assert.equal(dayToJalali('not a day'), null);
  assert.equal(dayToJalali(''), null);
  assert.equal(jalaliToDay({ jy: 1405, jm: 12, jd: 30 }), null, '1405 is not a leap year');
  assert.equal(jalaliToDay({ jy: 1403, jm: 12, jd: 30 }), '2025-03-20', '1403 is');
  assert.equal(jalaliToDay({ jy: 1405, jm: 7, jd: 31 }), null, 'Mehr has 30 days');
  assert.equal(jalaliToDay({ jy: 1405, jm: 13, jd: 1 }), null);
  assert.equal(jalaliToDay({ jy: 1405, jm: 1, jd: 0 }), null);
});

test('currentJalaliYear reads the clock in UTC', () => {
  assert.equal(currentJalaliYear(new Date(Date.UTC(2026, 9, 23))), 1405);
  assert.equal(currentJalaliYear(new Date(Date.UTC(2026, 2, 20))), 1404, 'the day before Nowruz 1405');
  assert.equal(currentJalaliYear(new Date(Date.UTC(2026, 2, 21))), 1405);
});
