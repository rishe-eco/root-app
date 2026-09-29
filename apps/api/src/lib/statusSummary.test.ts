import test from 'node:test';
import assert from 'node:assert/strict';
import { computeWizard, type WizardState } from './steps.js';
import { computeStatusSummary, nextMoveOn, type MoveFacts, type StatusSummaryInput } from './statusSummary.js';
import type { AttentionItem } from './attention.js';

/**
 * Journeys build plan J3 — the status area's derivations, as tables, with the
 * clock passed in.
 */

const NOW = new Date('2026-09-29T12:00:00Z');
const ago = (days: number, hours = 0) => new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000);

const facts = (over: Partial<MoveFacts> = {}): MoveFacts => ({
  designPublished: false,
  contractPublished: false,
  publishedDemoPhaseIds: [],
  ...over,
});

const wizardOf = (over: Partial<WizardState> = {}) =>
  computeWizard({ sequence: 'AGREEMENT_FIRST', designPath: null, phases: [], approvals: [], finished: [], ...over });

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  kind: 'DRAFT_TO_REVIEW',
  variant: 'contract',
  contractId: 'c1',
  phaseId: null,
  waitingOn: 'CUSTOMER',
  role: null,
  since: ago(1),
  params: {},
  internal: false,
  money: false,
  ...over,
});

const input = (over: Partial<StatusSummaryInput> = {}): StatusSummaryInput => ({
  now: NOW,
  sequence: 'AGREEMENT_FIRST',
  wizard: wizardOf(),
  attention: [],
  signedAt: null,
  plannedStartAt: null,
  plannedEndAt: null,
  progressAt: [],
  facts: facts(),
  ...over,
});

test('a fresh new-road contract: at the first step, Root’s move, not started, no progress to report', () => {
  assert.deepEqual(computeStatusSummary(input()), {
    started: false,
    startedAt: null,
    currentStep: 'REQUIREMENTS',
    currentPhaseId: null,
    currentPhaseNumber: null,
    nextMoveOn: 'ROOT',
    waitingOnRoot: 0,
    waitingOnCustomer: 0,
    plannedStartAt: null,
    plannedEndAt: null,
    overdueCount: 0,
    lastProgressAt: null,
    daysSinceProgress: null,
  });
});

test('started is signed: the date is the signature (or the agreement approval), until J13 adds the first paid invoice', () => {
  const s = computeStatusSummary(input({ signedAt: ago(3) }));
  assert.equal(s.started, true);
  assert.deepEqual(s.startedAt, ago(3));
});

test('daysSinceProgress: whole days from the latest of every source; null when there is none', () => {
  const table: Array<{ name: string; progressAt: Date[]; days: number | null; last: Date | null }> = [
    { name: 'none', progressAt: [], days: null, last: null },
    { name: 'one source, today', progressAt: [ago(0, 2)], days: 0, last: ago(0, 2) },
    { name: 'the latest of several wins', progressAt: [ago(9), ago(2), ago(30)], days: 2, last: ago(2) },
    { name: 'a partial day rounds down', progressAt: [ago(3, 23)], days: 3, last: ago(3, 23) },
    { name: 'a date in the future (clock skew) never goes negative', progressAt: [ago(-1)], days: 0, last: ago(-1) },
  ];
  for (const row of table) {
    const s = computeStatusSummary(input({ progressAt: row.progressAt }));
    assert.equal(s.daysSinceProgress, row.days, row.name);
    assert.deepEqual(s.lastProgressAt, row.last, row.name);
  }
});

test('waiting counts and overdue count come from the attention the viewer was given', () => {
  const s = computeStatusSummary(
    input({
      attention: [
        item(),
        item({ kind: 'ROUND_PUBLISHED', variant: 'default' }),
        item({ kind: 'COMMITMENT_OVERDUE', variant: 'customer' }),
        item({ kind: 'COMMITMENT_OVERDUE', variant: 'root', waitingOn: 'ROOT', internal: true }),
      ],
    }),
  );
  assert.equal(s.waitingOnCustomer, 3);
  assert.equal(s.waitingOnRoot, 1);
  assert.equal(s.overdueCount, 2);
});

test('the current step and phase come from the wizard, and nothing current means no move', () => {
  const twoPhases = [
    { id: 'p1', number: 1 },
    { id: 'p2', number: 2 },
  ];
  const mid = computeStatusSummary(
    input({
      sequence: 'DESIGN_FIRST',
      wizard: wizardOf({
        sequence: 'DESIGN_FIRST',
        phases: twoPhases,
        finished: [
          { step: 'DESIGN', phaseId: null, at: null },
          { step: 'AGREEMENT', phaseId: null, at: ago(5) },
          { step: 'DEMO', phaseId: 'p1', at: null },
        ],
      }),
    }),
  );
  assert.deepEqual([mid.currentStep, mid.currentPhaseId, mid.currentPhaseNumber], ['DEMO', 'p2', 2]);

  const done = computeStatusSummary(
    input({
      wizard: wizardOf({
        approvals: [{ step: 'AGREEMENT', phaseId: null, approvedAt: ago(9) }],
        finished: [
          { step: 'DESIGN', phaseId: null, at: null },
          { step: 'DEMO', phaseId: null, at: null },
          { step: 'SUMMARY', phaseId: null, at: null },
        ],
      }),
    }),
  );
  assert.deepEqual([done.currentStep, done.nextMoveOn], [null, null]);
});

test('planned dates pass straight through (visibility is the resolver’s, mayReadPlannedDates)', () => {
  const s = computeStatusSummary(input({ plannedStartAt: new Date('2026-10-01'), plannedEndAt: new Date('2026-12-01') }));
  assert.deepEqual([s.plannedStartAt, s.plannedEndAt], [new Date('2026-10-01'), new Date('2026-12-01')]);
});

// ---- whose move ------------------------------------------------------------------------

const step = (name: string, phaseId: string | null = null) =>
  ({ step: name, phaseId, phaseNumber: phaseId ? 1 : null }) as Parameters<typeof nextMoveOn>[1];

test('nextMoveOn: the legacy road, read off what has been published', () => {
  const table: Array<{ name: string; step: ReturnType<typeof step>; facts: MoveFacts; want: 'CUSTOMER' | 'ROOT' }> = [
    { name: 'design, nothing published', step: step('DESIGN'), facts: facts(), want: 'ROOT' },
    { name: 'design, published', step: step('DESIGN'), facts: facts({ designPublished: true }), want: 'CUSTOMER' },
    { name: 'agreement, no text published', step: step('AGREEMENT'), facts: facts({ designPublished: true }), want: 'ROOT' },
    { name: 'agreement, text published', step: step('AGREEMENT'), facts: facts({ contractPublished: true }), want: 'CUSTOMER' },
    { name: 'demo, not published', step: step('DEMO', 'p1'), facts: facts({ publishedDemoPhaseIds: ['p2'] }), want: 'ROOT' },
    { name: 'demo, published', step: step('DEMO', 'p1'), facts: facts({ publishedDemoPhaseIds: ['p1'] }), want: 'CUSTOMER' },
  ];
  for (const row of table) {
    assert.equal(nextMoveOn('DESIGN_FIRST', row.step, row.facts), row.want, row.name);
  }
});

test('nextMoveOn: every new-road step is Root’s until its own stage says otherwise', () => {
  const everything = facts({ designPublished: true, contractPublished: true, publishedDemoPhaseIds: ['p1'] });
  for (const name of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO', 'SUMMARY']) {
    assert.equal(nextMoveOn('AGREEMENT_FIRST', step(name, name === 'DEMO' ? 'p1' : null), everything), 'ROOT', name);
  }
});
