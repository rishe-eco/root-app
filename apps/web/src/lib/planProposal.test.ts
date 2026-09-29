import test from 'node:test';
import assert from 'node:assert/strict';
import { addJalaliMonths, evenShares, proposeRows, type Labeller } from './planProposal.js';

/** Journeys build plan J4 — the desk form's proposal. The server never regenerates rows from a split; this only fills the form. */

const labeller = (lang: string): Labeller => ({
  lump: () => `${lang}:lump`,
  installment: (n, of) => `${lang}:${n}/${of}`,
  month: (m, y) => `${lang}:${y}-${m}`,
});
const base = { phases: [], start: null, today: '2026-10-23', fa: labeller('fa'), en: labeller('en') } as const;
const sum = (rows: Array<{ amount: string }>) => rows.reduce((s, r) => s + BigInt(r.amount), 0n);

test('evenShares always add up to the total to the last Toman — the remainder goes to the first rows', () => {
  assert.deepEqual(evenShares(100n, 3), [34n, 33n, 33n]);
  assert.deepEqual(evenShares(9n, 3), [3n, 3n, 3n]);
  assert.deepEqual(evenShares(2n, 5), [1n, 1n, 0n, 0n, 0n]);
  for (const [total, count] of [[180_000_000n, 7], [1n, 1], [999_999_999_999n, 36], [10n, 4]] as const) {
    assert.equal(evenShares(total, count).reduce((a, b) => a + b, 0n), total, `${total}/${count}`);
  }
  assert.deepEqual(evenShares(10n, 0), []);
});

test('a lump sum proposes one row for the whole fee; count is ignored', () => {
  const rows = proposeRows({ ...base, split: 'LUMP_SUM', total: 180_000_000n, count: 9 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, '180000000');
  assert.deepEqual([rows[0].labelFa, rows[0].labelEn], ['fa:lump', 'en:lump']);
});

test('installments propose N rows that add up; they link to the phases only when there are exactly as many', () => {
  const four = proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 4, phases: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  assert.equal(sum(four), 100n);
  assert.deepEqual(four.map((r) => r.phaseId), ['a', 'b', 'c', 'd']);
  assert.deepEqual(four.map((r) => r.labelEn), ['en:1/4', 'en:2/4', 'en:3/4', 'en:4/4']);
  const mismatched = proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 3, phases: [{ id: 'a' }, { id: 'b' }] });
  assert.deepEqual(mismatched.map((r) => r.phaseId), [null, null, null]);
});

test('monthly proposes N rows labelled by Jalali month from the planned start, crossing the year at Esfand', () => {
  // 2026-12-15 is 24 Azar 1405.
  const rows = proposeRows({ ...base, split: 'MONTHLY', total: 300n, count: 6, start: '2026-12-15' });
  assert.deepEqual(rows.map((r) => r.labelEn), ['en:1405-9', 'en:1405-10', 'en:1405-11', 'en:1405-12', 'en:1406-1', 'en:1406-2']);
  assert.equal(sum(rows), 300n);
  // No start: from today's month (1 Aban 1405).
  const fromToday = proposeRows({ ...base, split: 'MONTHLY', total: 30n, count: 2 });
  assert.deepEqual(fromToday.map((r) => r.labelEn), ['en:1405-8', 'en:1405-9']);
});

test('no total to divide leaves the amounts blank for sales to fill; rows and labels are still proposed', () => {
  const rows = proposeRows({ ...base, split: 'INSTALLMENTS', total: null, count: 2 });
  assert.deepEqual(rows.map((r) => r.amount), ['', '']);
  assert.equal(rows.length, 2);
  assert.deepEqual(proposeRows({ ...base, split: 'LUMP_SUM', total: 0n, count: 1 }).map((r) => r.amount), ['']);
});

test('the row count is clamped to what a plan can hold, and the term defaults to a week', () => {
  assert.equal(proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 500 }).length, 36);
  assert.equal(proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 0 }).length, 1);
  assert.equal(proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 2 })[0].paymentTermDays, 7);
  assert.equal(proposeRows({ ...base, split: 'INSTALLMENTS', total: 100n, count: 2, termDays: 0 })[0].paymentTermDays, 0);
});

test('addJalaliMonths carries into the next year and never lands on month 0', () => {
  assert.deepEqual(addJalaliMonths(1405, 12, 1), { jy: 1406, jm: 1 });
  assert.deepEqual(addJalaliMonths(1405, 1, 0), { jy: 1405, jm: 1 });
  assert.deepEqual(addJalaliMonths(1405, 11, 14), { jy: 1407, jm: 1 });
});
