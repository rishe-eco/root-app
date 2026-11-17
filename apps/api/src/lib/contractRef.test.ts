import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRef, jalaliYear, nextRefFrom, REF_PATTERN } from './contractRef.js';

// Nowruz 1405 fell on 2026-03-21 in Tehran (UTC+3:30, no daylight saving since
// 2022). The expected years are read from Intl itself, as the card asks, and
// pinned to the known values so a broken ICU build fails loudly.
const tehran = (iso: string) => new Date(`${iso}+03:30`);

test('the Jalali year turns at Nowruz in Tehran, not at UTC midnight', () => {
  assert.equal(jalaliYear(tehran('2026-03-20T12:00:00')), 1404);
  assert.equal(jalaliYear(tehran('2026-03-21T12:00:00')), 1405);
  // One minute either side of Tehran midnight on the day it turns.
  assert.equal(jalaliYear(tehran('2026-03-20T23:59:00')), 1404);
  assert.equal(jalaliYear(tehran('2026-03-21T00:01:00')), 1405);
  // 2026-03-20T21:00Z is already 00:30 on the 21st in Tehran.
  assert.equal(jalaliYear(new Date('2026-03-20T21:00:00Z')), 1405);
  const viaIntl = new Intl.DateTimeFormat('en-u-ca-persian-nu-latn', { year: 'numeric', timeZone: 'Asia/Tehran' })
    .format(tehran('2026-03-21T12:00:00'))
    .match(/\d+/)![0];
  assert.equal(jalaliYear(tehran('2026-03-21T12:00:00')), Number(viaIntl));
});

test('numbering: first of the year, next after the highest, other formats and years ignored', () => {
  const now = tehran('2026-11-17T12:00:00'); // 1405
  assert.equal(nextRefFrom([], now), 'R-1405-001');
  assert.equal(nextRefFrom(['R-1405-001', 'R-1405-002'], now), 'R-1405-003');
  // The highest wins, not the count: a gap is not refilled.
  assert.equal(nextRefFrom(['R-1405-001', 'R-1405-007'], now), 'R-1405-008');
  assert.equal(nextRefFrom(['RC-2026-014', 'R-1404-090', 'R-1405-xyz', 'X-R-1405-050'], now), 'R-1405-001');
});

test('the number rolls past 999 to four digits', () => {
  assert.equal(formatRef(1405, 5), 'R-1405-005');
  assert.equal(formatRef(1405, 999), 'R-1405-999');
  assert.equal(formatRef(1405, 1000), 'R-1405-1000');
  assert.equal(nextRefFrom(['R-1405-999'], tehran('2026-11-17T12:00:00')), 'R-1405-1000');
  assert.equal(nextRefFrom(['R-1405-1000'], tehran('2026-11-17T12:00:00')), 'R-1405-1001');
});

test('what a reference may be', () => {
  for (const ok of ['R-1405-001', 'RC-2026-014', 'a', 'A'.repeat(40)]) assert.ok(REF_PATTERN.test(ok), ok);
  for (const bad of ['', 'A'.repeat(41), 'has space', 'ref_1', 'شماره', 'a/b']) assert.ok(!REF_PATTERN.test(bad), bad);
});
