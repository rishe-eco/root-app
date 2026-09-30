import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canIssuePlanned,
  dueDayFor,
  firstInvoicePaidAt,
  formatInvoiceNumber,
  isOverdue,
  isValidPaymentTerm,
  issuedFields,
  plannedInvoiceState,
  utcDayStart,
  type ApprovalRow,
  type PlanEntry,
  type PlannedInvoiceRow,
} from './invoice.js';

/**
 * Journeys build plan J13 — the invoice rules as tables. The clock is passed
 * in; nothing here touches a database (the sequence itself, the CHECK and the
 * concurrent double issue are `j13.test.ts`'s).
 */

const NOW = new Date('2026-10-10T15:30:00Z');
const at = (iso: string) => new Date(`${iso}T00:00:00Z`);

// ---- the number ---------------------------------------------------------------

test('formatInvoiceNumber: INV- and six Latin digits, growing past a million rather than truncating', () => {
  assert.equal(formatInvoiceNumber(1), 'INV-000001');
  assert.equal(formatInvoiceNumber(123), 'INV-000123');
  assert.equal(formatInvoiceNumber(999_999), 'INV-999999');
  assert.equal(formatInvoiceNumber(1_000_000), 'INV-1000000');
  // The sequence hands back a bigint.
  assert.equal(formatInvoiceNumber(42n), 'INV-000042');
  assert.match(formatInvoiceNumber(7), /^INV-[0-9]{6}$/, 'never Persian digits (house rule 14)');
});

// ---- the term and the due day ------------------------------------------------------

test('a term is a whole number of days from 0 to 365', () => {
  for (const ok of [0, 1, 7, 365]) assert.equal(isValidPaymentTerm(ok), true, String(ok));
  for (const bad of [-1, 366, 1.5, Number.NaN]) assert.equal(isValidPaymentTerm(bad), false, String(bad));
});

test('the due day is the issue day plus the term, as midnight UTC — a calendar day, not an instant (PD-19)', () => {
  assert.deepEqual(dueDayFor(new Date('2026-10-10T23:59:59Z'), 7), at('2026-10-17'));
  assert.deepEqual(dueDayFor(new Date('2026-10-10T00:00:01Z'), 7), at('2026-10-17'), 'the time of day never moves it');
  assert.deepEqual(dueDayFor(new Date('2026-10-10T12:00:00Z'), 0), at('2026-10-10'), 'a zero term is due the day it is issued');
  assert.deepEqual(dueDayFor(new Date('2026-12-28T12:00:00Z'), 10), at('2027-01-07'), 'across a year end');
  assert.deepEqual(dueDayFor(new Date('2026-02-20T12:00:00Z'), 10), at('2026-03-02'), 'across a short month');
  assert.deepEqual(utcDayStart(new Date('2026-10-10T20:30:00Z')), at('2026-10-10'));
});

test('issuedFields: the four columns of an issued invoice, from one call', () => {
  const issuedAt = new Date('2026-10-10T09:00:00Z');
  assert.deepEqual(issuedFields({ number: 17n, issuedAt, termDays: 14 }), {
    invoiceNumber: 'INV-000017',
    issuedAt,
    paymentTermDays: 14,
    dueAt: at('2026-10-24'),
  });
});

// ---- overdue -----------------------------------------------------------------------

test('isOverdue: issued, unpaid and its due day is before today (UTC) — never on the day itself', () => {
  const issued = at('2026-09-01');
  const table: Array<{ name: string; entry: { issuedAt: Date | null; dueAt: Date | null; paidAt: Date | null }; overdue: boolean }> = [
    { name: 'due yesterday', entry: { issuedAt: issued, dueAt: at('2026-10-09'), paidAt: null }, overdue: true },
    { name: 'due today is the last day to pay', entry: { issuedAt: issued, dueAt: at('2026-10-10'), paidAt: null }, overdue: false },
    { name: 'due tomorrow', entry: { issuedAt: issued, dueAt: at('2026-10-11'), paidAt: null }, overdue: false },
    { name: 'paid, however late', entry: { issuedAt: issued, dueAt: at('2026-09-05'), paidAt: at('2026-10-01') }, overdue: false },
    { name: 'a draft is never overdue', entry: { issuedAt: null, dueAt: null, paidAt: null }, overdue: false },
    { name: 'a row missing its due day (impossible past the CHECK) is not called overdue', entry: { issuedAt: issued, dueAt: null, paidAt: null }, overdue: false },
  ];
  for (const row of table) assert.equal(isOverdue(row.entry, NOW), row.overdue, row.name);
});

test('isOverdue at 00:00:01 UTC on the day after the due day flips, and 23:59:59 on the due day does not', () => {
  const entry = { issuedAt: at('2026-09-01'), dueAt: at('2026-10-10'), paidAt: null };
  assert.equal(isOverdue(entry, new Date('2026-10-10T23:59:59Z')), false);
  assert.equal(isOverdue(entry, new Date('2026-10-11T00:00:01Z')), true);
});

// ---- the plan rule -----------------------------------------------------------------

const plan: PlannedInvoiceRow[] = [
  { id: 'p1', ordinal: 1, phaseId: null },
  { id: 'p2', ordinal: 2, phaseId: 'ph1' },
  { id: 'p3', ordinal: 3, phaseId: null },
];
const entry = (plannedInvoiceId: string, paid: boolean, issued = true): PlanEntry & { dueAt: Date | null } => ({
  plannedInvoiceId,
  issuedAt: issued ? at('2026-10-01') : null,
  paidAt: paid ? at('2026-10-05') : null,
  dueAt: at('2026-10-08'),
});
const demoApproved = (phaseId: string): ApprovalRow => ({ step: 'DEMO', phaseId });

test('the first invoice needs only the signature', () => {
  assert.deepEqual(canIssuePlanned(plan, 0, [], [], true), { ok: true });
  assert.deepEqual(canIssuePlanned(plan, 0, [], [], false), { ok: false, reason: 'NOT_SIGNED' });
});

test('an invoice after the first needs the one before it issued and paid', () => {
  const demo = [demoApproved('ph1')];
  assert.deepEqual(canIssuePlanned(plan, 1, [], demo, true), { ok: false, reason: 'PREVIOUS_UNPAID' }, 'previous not even issued');
  assert.deepEqual(canIssuePlanned(plan, 1, [entry('p1', false)], demo, true), { ok: false, reason: 'PREVIOUS_UNPAID' }, 'issued, unpaid');
  assert.deepEqual(canIssuePlanned(plan, 1, [entry('p1', true)], demo, true), { ok: true });
});

test('signature is checked before payment, and payment before the phase — the order the customer would meet them', () => {
  assert.deepEqual(canIssuePlanned(plan, 1, [], [], false), { ok: false, reason: 'NOT_SIGNED' });
  assert.deepEqual(canIssuePlanned(plan, 1, [entry('p1', false)], [], true), { ok: false, reason: 'PREVIOUS_UNPAID' });
});

test('a phase-tied invoice needs that phase’s DEMO approval — not another phase’s, not another step’s', () => {
  const paid = [entry('p1', true)];
  assert.deepEqual(canIssuePlanned(plan, 1, paid, [], true), { ok: false, reason: 'PHASE_NOT_ACCEPTED' });
  assert.deepEqual(canIssuePlanned(plan, 1, paid, [demoApproved('other')], true), { ok: false, reason: 'PHASE_NOT_ACCEPTED' });
  assert.deepEqual(canIssuePlanned(plan, 1, paid, [{ step: 'AGREEMENT', phaseId: null }, { step: 'DESIGN', phaseId: 'ph1' }], true), {
    ok: false,
    reason: 'PHASE_NOT_ACCEPTED',
  });
  assert.deepEqual(canIssuePlanned(plan, 1, paid, [demoApproved('ph1')], true), { ok: true });
});

test('an invoice that has its entry is ALREADY_ISSUED, before anything else is asked', () => {
  assert.deepEqual(canIssuePlanned(plan, 0, [entry('p1', false)], [], false), { ok: false, reason: 'ALREADY_ISSUED' });
});

test('out of order is PREVIOUS_UNPAID: the third cannot be issued while the second is not', () => {
  assert.deepEqual(canIssuePlanned(plan, 2, [entry('p1', true)], [demoApproved('ph1')], true), { ok: false, reason: 'PREVIOUS_UNPAID' });
  assert.deepEqual(canIssuePlanned(plan, 2, [entry('p1', true), entry('p2', true)], [demoApproved('ph1')], true), { ok: true });
});

test('an index outside the plan is a programming error, never "ok"', () => {
  assert.throws(() => canIssuePlanned(plan, 3, [], [], true), RangeError);
});

test('plannedInvoiceState: the five states, and what an unissued row waits on', () => {
  const state = (index: number, entries: Array<PlanEntry & { dueAt: Date | null }>, approvals: ApprovalRow[] = [], signed = true) =>
    plannedInvoiceState(plan, index, entries, approvals, signed, NOW);
  assert.deepEqual(state(0, [], [], false), { state: 'NOT_YET_ISSUABLE', blockedBy: 'NOT_SIGNED' });
  assert.deepEqual(state(0, []), { state: 'ISSUABLE', blockedBy: null });
  assert.deepEqual(state(0, [{ ...entry('p1', false), dueAt: at('2026-10-20') }]), { state: 'ISSUED', blockedBy: null });
  assert.deepEqual(state(0, [{ ...entry('p1', false), dueAt: at('2026-10-09') }]), { state: 'OVERDUE', blockedBy: null });
  assert.deepEqual(state(0, [{ ...entry('p1', true), dueAt: at('2026-10-09') }]), { state: 'PAID', blockedBy: null }, 'paid beats overdue');
  assert.deepEqual(state(1, [entry('p1', true)]), { state: 'NOT_YET_ISSUABLE', blockedBy: 'PHASE_NOT_ACCEPTED' });
  assert.deepEqual(state(1, [entry('p1', false)]), { state: 'NOT_YET_ISSUABLE', blockedBy: 'PREVIOUS_UNPAID' });
});

// ---- "started" ---------------------------------------------------------------------

test('firstInvoicePaidAt: the first planned invoice’s payment, and nothing for an empty plan', () => {
  assert.equal(firstInvoicePaidAt([], []), null, 'no plan, no first invoice');
  assert.equal(firstInvoicePaidAt(plan, []), null, 'not issued');
  assert.equal(firstInvoicePaidAt(plan, [entry('p1', false)]), null, 'issued, unpaid');
  assert.deepEqual(firstInvoicePaidAt(plan, [entry('p1', true)]), at('2026-10-05'));
  assert.equal(firstInvoicePaidAt(plan, [entry('p2', true)]), null, 'the second being paid is not the first');
  // Ordinal, not array position, decides which is first.
  const shuffled = [plan[2], plan[0], plan[1]];
  assert.deepEqual(firstInvoicePaidAt(shuffled, [entry('p1', true)]), at('2026-10-05'));
});
