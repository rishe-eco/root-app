import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PLAN_ROWS, checkPlanRows, planMatchesFee, planTotal } from './plan.js';

/** Journeys build plan J4 — the payment plan's arithmetic and its refusals. */

const rows = (...amounts: bigint[]) => ({ invoices: amounts.map((amount) => ({ amount })) });

test('planTotal sums the rows exactly, in bigint — no float ever sees a Toman', () => {
  assert.equal(planTotal(rows()), 0n);
  assert.equal(planTotal(rows(60_000_000n, 40_000_000n)), 100_000_000n);
  // Past 2^53: a float would round this, a bigint does not.
  assert.equal(planTotal(rows(9_007_199_254_740_993n, 1n)), 9_007_199_254_740_994n);
});

test('planMatchesFee: equal totals match; a fee of nothing matches nothing', () => {
  assert.equal(planMatchesFee(rows(60n, 40n), 100n), true);
  assert.equal(planMatchesFee(rows(60n, 39n), 100n), false);
  assert.equal(planMatchesFee(rows(60n, 41n), 100n), false);
  // No fee: "not set yet" is not "correct" — the gate that reads this must not pass on it.
  assert.equal(planMatchesFee(rows(60n, 40n), null), false);
  assert.equal(planMatchesFee(rows(), null), false);
  // An empty plan against a fee is a mismatch by arithmetic.
  assert.equal(planMatchesFee(rows(), 100n), false);
});

const row = (over: Partial<Parameters<typeof checkPlanRows>[0][number]> = {}) => ({
  labelFa: 'پیش‌پرداخت',
  labelEn: 'Deposit',
  amount: '60000000',
  paymentTermDays: 7,
  ...over,
});

test('checkPlanRows: good rows pass — including a term of zero (“on delivery”)', () => {
  assert.equal(checkPlanRows([row(), row({ amount: '40000000', paymentTermDays: 0 })]), null);
});

test('checkPlanRows: each refusal, in the order the form’s columns run', () => {
  assert.equal(checkPlanRows([]), 'PLAN_ROWS_REQUIRED');
  assert.equal(checkPlanRows(Array.from({ length: MAX_PLAN_ROWS + 1 }, () => row())), 'TOO_MANY_ROWS');
  assert.equal(checkPlanRows(Array.from({ length: MAX_PLAN_ROWS }, () => row())), null);
  assert.equal(checkPlanRows([row({ labelFa: '  ' })]), 'LABEL_REQUIRED');
  assert.equal(checkPlanRows([row({ labelEn: '' })]), 'LABEL_REQUIRED');
  for (const amount of ['0', '-1', '1.5', '', '1e3', 'abc', '01']) {
    assert.equal(checkPlanRows([row({ amount })]), 'INVALID_AMOUNT', amount);
  }
  assert.equal(checkPlanRows([row({ paymentTermDays: -1 })]), 'INVALID_TERM');
  assert.equal(checkPlanRows([row({ paymentTermDays: 366 })]), 'INVALID_TERM');
  assert.equal(checkPlanRows([row({ paymentTermDays: 2.5 })]), 'INVALID_TERM');
  // A label problem is reported before an amount problem on the same row.
  assert.equal(checkPlanRows([row({ labelEn: '', amount: '0' })]), 'LABEL_REQUIRED');
});
