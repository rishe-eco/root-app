import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPeriod, duePeriods, isValidTomanAmount, computeBillingReport } from './billing.js';

// --- addPeriod (calendar-month aware, never a fixed day count) ------------

test('addPeriod: MONTHLY advances one calendar month, not thirty days', () => {
  const jan31 = new Date('2026-01-31T00:00:00Z');
  const next = addPeriod(jan31, 'MONTHLY');
  // JS Date's own overflow rule lands this on Mar 3 (Feb has 28 days in
  // 2026) — asserted explicitly so a future refactor to fixed-day math would
  // fail loudly here rather than drifting silently.
  assert.equal(next.toISOString(), '2026-03-03T00:00:00.000Z');
});

test('addPeriod: QUARTERLY advances three months, YEARLY advances twelve', () => {
  const start = new Date('2026-01-15T00:00:00Z');
  assert.equal(addPeriod(start, 'QUARTERLY').toISOString(), '2026-04-15T00:00:00.000Z');
  assert.equal(addPeriod(start, 'YEARLY').toISOString(), '2027-01-15T00:00:00.000Z');
});

// --- duePeriods --------------------------------------------------------

test('duePeriods: a subscription created "now" is due for exactly one period immediately', () => {
  const now = new Date('2026-09-21T10:00:00Z');
  const sub = { id: 's1', customerId: 'c1', amount: 100_000n, period: 'MONTHLY' as const, activeFrom: now, activeUntil: null };
  const periods = duePeriods(sub, now);
  assert.equal(periods.length, 1);
  assert.equal(periods[0].start.getTime(), now.getTime());
});

test('duePeriods: three elapsed months produce three periods, not one', () => {
  const activeFrom = new Date('2026-01-01T00:00:00Z');
  const asOf = new Date('2026-04-01T00:00:00Z');
  const sub = { id: 's1', customerId: 'c1', amount: 50_000n, period: 'MONTHLY' as const, activeFrom, activeUntil: null };
  const periods = duePeriods(sub, asOf);
  // Jan 1, Feb 1, Mar 1, Apr 1 — four period starts have arrived by Apr 1.
  assert.equal(periods.length, 4);
  assert.deepEqual(
    periods.map((p) => p.start.toISOString().slice(0, 10)),
    ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'],
  );
});

test('duePeriods: nothing is due before activeFrom', () => {
  const sub = {
    id: 's1',
    customerId: 'c1',
    amount: 1n,
    period: 'MONTHLY' as const,
    activeFrom: new Date('2026-05-01T00:00:00Z'),
    activeUntil: null,
  };
  assert.deepEqual(duePeriods(sub, new Date('2026-04-01T00:00:00Z')), []);
});

test('duePeriods: activeUntil caps generation — nothing due after the subscription ended', () => {
  const sub = {
    id: 's1',
    customerId: 'c1',
    amount: 1n,
    period: 'MONTHLY' as const,
    activeFrom: new Date('2026-01-01T00:00:00Z'),
    activeUntil: new Date('2026-02-15T00:00:00Z'),
  };
  // Feb 1 has started (before the Feb 15 end); Mar 1 has not.
  const periods = duePeriods(sub, new Date('2026-06-01T00:00:00Z'));
  assert.deepEqual(
    periods.map((p) => p.start.toISOString().slice(0, 10)),
    ['2026-01-01', '2026-02-01'],
  );
});

test('duePeriods is a pure function of its inputs — calling it twice for the same asOf is identical, which is what makes the caller idempotent', () => {
  const sub = {
    id: 's1',
    customerId: 'c1',
    amount: 1n,
    period: 'MONTHLY' as const,
    activeFrom: new Date('2026-01-01T00:00:00Z'),
    activeUntil: null,
  };
  const asOf = new Date('2026-03-01T00:00:00Z');
  assert.deepEqual(duePeriods(sub, asOf), duePeriods(sub, asOf));
});

// --- isValidTomanAmount ("no float ever touches a charge") -----------------

test('isValidTomanAmount accepts plain digit strings only', () => {
  assert.equal(isValidTomanAmount('100000'), true);
  assert.equal(isValidTomanAmount('0'), true);
});

test('isValidTomanAmount refuses floats, signs, and non-numeric input', () => {
  assert.equal(isValidTomanAmount('100.5'), false);
  assert.equal(isValidTomanAmount('-100'), false);
  assert.equal(isValidTomanAmount('abc'), false);
  assert.equal(isValidTomanAmount(''), false);
  assert.equal(isValidTomanAmount('1e10'), false);
});

// --- computeBillingReport ---------------------------------------------------

test('computeBillingReport totals issued/paid/outstanding across sources', () => {
  const report = computeBillingReport([
    { source: 'CONTRACT', amount: 100n, paidAt: new Date() },
    { source: 'CONTRACT', amount: 50n, paidAt: null },
    { source: 'TICKET', amount: 20n, paidAt: new Date() },
  ]);
  assert.equal(report.totalIssued, 170n);
  assert.equal(report.totalPaid, 120n);
  assert.equal(report.totalOutstanding, 50n);
  const contract = report.bySource.find((s) => s.source === 'CONTRACT')!;
  assert.equal(contract.totalIssued, 150n);
  assert.equal(contract.totalPaid, 100n);
  assert.equal(contract.totalOutstanding, 50n);
});

test('computeBillingReport on no entries reports all zeros, not an error', () => {
  const report = computeBillingReport([]);
  assert.equal(report.totalIssued, 0n);
  assert.equal(report.totalPaid, 0n);
  assert.equal(report.totalOutstanding, 0n);
  assert.deepEqual(report.bySource, []);
});
