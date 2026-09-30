import test from 'node:test';
import assert from 'node:assert/strict';
import type { GraphQLError } from 'graphql';
import type { ScopeKind, ScopeStatus } from '@prisma/client';
import {
  addMonths,
  assertCanClose,
  checkHandoverNote,
  closeBlockers,
  HANDOVER_NOTE_MAX,
  isAgreedDeliverable,
  supportPeriod,
} from './delivery.js';

/**
 * Journeys build plan J11 — what a close waits for, as tables. The integration
 * suite (`j11.test.ts`) proves the mutation calls these; this proves the rules.
 */

const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as GraphQLError).extensions?.code as string | undefined;
  }
  return undefined;
};

test('checkHandoverNote: a note says something, and not too much', () => {
  assert.equal(checkHandoverNote('The repository was transferred to the customer’s organisation.'), null);
  assert.equal(checkHandoverNote(''), 'HANDOVER_NOTE_REQUIRED');
  assert.equal(checkHandoverNote('   \n\t'), 'HANDOVER_NOTE_REQUIRED', 'whitespace is not a note — the CHECK says the same');
  assert.equal(checkHandoverNote('x'.repeat(HANDOVER_NOTE_MAX)), null);
  assert.equal(checkHandoverNote('x'.repeat(HANDOVER_NOTE_MAX + 1)), 'HANDOVER_NOTE_TOO_LONG');
  // The bound is on what is kept, not on the padding around it.
  assert.equal(checkHandoverNote(`  ${'x'.repeat(HANDOVER_NOTE_MAX)}  `), null);
});

test('isAgreedDeliverable: this contract’s deliverable, agreed or beyond — never a page, a declined one or a sibling’s', () => {
  const d = (over: Partial<Parameters<typeof isAgreedDeliverable>[0]> = {}) => ({
    kind: 'DELIVERABLE' as ScopeKind,
    status: 'AGREED' as ScopeStatus,
    contractId: 'c1',
    ...over,
  });
  assert.equal(isAgreedDeliverable(d(), 'c1'), true);
  for (const status of ['IN_BUILD', 'IN_DEMO', 'ACCEPTED'] as const) {
    assert.equal(isAgreedDeliverable(d({ status }), 'c1'), true, status);
  }
  // Declined and traded ones were taken out of the deal (Appendix 1's own rule).
  for (const status of ['DECLINED', 'TRADED', 'PROPOSED'] as const) {
    assert.equal(isAgreedDeliverable(d({ status }), 'c1'), false, status);
  }
  assert.equal(isAgreedDeliverable(d({ kind: 'FEATURE' }), 'c1'), false);
  assert.equal(isAgreedDeliverable(d({ kind: 'PAGE' }), 'c1'), false);
  assert.equal(isAgreedDeliverable(d({ kind: 'EXTRA' }), 'c1'), false);
  assert.equal(isAgreedDeliverable(d({ contractId: 'other' }), 'c1'), false);
  assert.equal(isAgreedDeliverable(d({ contractId: null }), 'c1'), false);
});

const phase = (id: string, number: number, statuses: Array<'ACCEPTED' | 'IN_DEMO' | 'DECLINED' | 'TRADED'> = []) => ({
  id,
  number,
  scopeItems: statuses.map((status) => ({ status })),
});

const item = (id: string, over: Partial<Parameters<typeof closeBlockers>[0]['items'][number]> = {}) => ({
  id,
  kind: 'DELIVERABLE' as ScopeKind,
  status: 'AGREED' as ScopeStatus,
  contractId: 'c1',
  position: 0,
  handedOverAt: null as Date | null,
  ...over,
});

const base = {
  contractId: 'c1',
  sequence: 'AGREEMENT_FIRST' as const,
  phases: [phase('p1', 1), phase('p2', 2)],
  approvals: [
    { step: 'DEMO' as const, phaseId: 'p1' },
    { step: 'DEMO' as const, phaseId: 'p2' },
  ],
  items: [] as Array<ReturnType<typeof item>>,
};

test('closeBlockers (new road): a DEMO approval per phase — the row, not the items', () => {
  assert.deepEqual(closeBlockers(base), { noPhases: false, phasesNotAccepted: [], deliverablesPending: [] });
  assert.deepEqual(
    closeBlockers({ ...base, approvals: [{ step: 'DEMO', phaseId: 'p1' }] }).phasesNotAccepted,
    [2],
  );
  assert.deepEqual(closeBlockers({ ...base, approvals: [] }).phasesNotAccepted, [1, 2]);
  // Another step's approval, or a demo approval with no phase, is not a phase's acceptance.
  assert.deepEqual(
    closeBlockers({
      ...base,
      approvals: [
        { step: 'DESIGN', phaseId: null },
        { step: 'AGREEMENT', phaseId: null },
        { step: 'DEMO', phaseId: null },
      ],
    }).phasesNotAccepted,
    [1, 2],
  );
  // The items being ACCEPTED does not stand in for the approval on this road.
  assert.deepEqual(
    closeBlockers({ ...base, approvals: [], phases: [phase('p1', 1, ['ACCEPTED'])] }).phasesNotAccepted,
    [1],
  );
});

test('closeBlockers (new road): phases are listed in order whatever order they arrive in', () => {
  const out = closeBlockers({ ...base, phases: [phase('p3', 3), phase('p1', 1), phase('p2', 2)], approvals: [] });
  assert.deepEqual(out.phasesNotAccepted, [1, 2, 3]);
});

test('closeBlockers: a contract with no phase has delivered nothing', () => {
  const out = closeBlockers({ ...base, phases: [], approvals: [] });
  assert.equal(out.noPhases, true);
  assert.equal(codeOf(() => assertCanClose(out)), 'PHASES_NOT_ACCEPTED');
});

test('closeBlockers (legacy road): the wizard’s own reading — every counted item accepted, and at least one', () => {
  const legacy = { ...base, sequence: 'DESIGN_FIRST' as const, approvals: [] };
  assert.deepEqual(
    closeBlockers({ ...legacy, phases: [phase('p1', 1, ['ACCEPTED', 'ACCEPTED']), phase('p2', 2, ['ACCEPTED'])] }).phasesNotAccepted,
    [],
  );
  assert.deepEqual(
    closeBlockers({ ...legacy, phases: [phase('p1', 1, ['ACCEPTED', 'IN_DEMO']), phase('p2', 2, ['ACCEPTED'])] }).phasesNotAccepted,
    [1],
  );
  // Declined and traded items are out of the count, as they are for the wizard.
  assert.deepEqual(
    closeBlockers({ ...legacy, phases: [phase('p1', 1, ['ACCEPTED', 'DECLINED', 'TRADED'])] }).phasesNotAccepted,
    [],
  );
  // A phase with nothing in it has accepted nothing.
  assert.deepEqual(closeBlockers({ ...legacy, phases: [phase('p1', 1, [])] }).phasesNotAccepted, [1]);
  // And a DEMO approval on a legacy contract is ignored, as the wizard ignores it.
  assert.deepEqual(
    closeBlockers({ ...legacy, phases: [phase('p1', 1, ['IN_DEMO'])], approvals: [{ step: 'DEMO', phaseId: 'p1' }] }).phasesNotAccepted,
    [1],
  );
});

test('closeBlockers: pending deliverables are this contract’s agreed, unhanded ones — in the registry’s order', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  const out = closeBlockers({
    ...base,
    items: [
      item('late', { position: 5 }),
      item('first', { position: 1 }),
      item('done', { position: 2, handedOverAt: now }),
      item('declined', { position: 3, status: 'DECLINED' }),
      item('traded', { position: 4, status: 'TRADED' }),
      item('theirs', { position: 6, contractId: 'c2' }),
      item('a-feature', { position: 7, kind: 'FEATURE' }),
    ],
  });
  assert.deepEqual(out.deliverablesPending, ['first', 'late']);
});

test('assertCanClose: phases are refused before deliverables', () => {
  const both = { noPhases: false, phasesNotAccepted: [2], deliverablesPending: ['d1'] };
  assert.equal(codeOf(() => assertCanClose(both)), 'PHASES_NOT_ACCEPTED');
  assert.equal(codeOf(() => assertCanClose({ ...both, phasesNotAccepted: [] })), 'DELIVERABLES_PENDING');
  assert.equal(codeOf(() => assertCanClose({ ...both, phasesNotAccepted: [], deliverablesPending: [] })), undefined);
});

test('addMonths: the same day-of-month, clamped to a shorter month, across a year end', () => {
  assert.equal(addMonths('2026-10-01', 3), '2027-01-01');
  assert.equal(addMonths('2026-10-15', 12), '2027-10-15');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29', 'a leap year');
  assert.equal(addMonths('2026-08-31', 1), '2026-09-30');
  assert.equal(addMonths('2026-11-30', 15), '2028-02-29');
});

test('supportPeriod: months counted from the day of delivery (UTC), a calendar day each end', () => {
  assert.deepEqual(supportPeriod(new Date('2026-10-01T09:30:00Z'), 3), { months: 3, from: '2026-10-01', until: '2027-01-01' });
  // The day is the UTC day (PD-19), not the local one: 23:30 UTC is still the 1st.
  assert.deepEqual(supportPeriod(new Date('2026-10-01T23:30:00Z'), 1), { months: 1, from: '2026-10-01', until: '2026-11-01' });
  // Before delivery there is a promise and no dates.
  assert.deepEqual(supportPeriod(null, 6), { months: 6, from: null, until: null });
  // No promise, no period — never a "0 months" record.
  assert.equal(supportPeriod(new Date('2026-10-01T00:00:00Z'), null), null);
  assert.equal(supportPeriod(new Date('2026-10-01T00:00:00Z'), 0), null);
  assert.equal(supportPeriod(null, 0), null);
});
