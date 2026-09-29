import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractSequence, StepKind } from '@prisma/client';
import {
  LOCKS_WITH_AGREEMENT,
  SEQUENCE_FOR_NEW_CONTRACTS,
  assertStepOpen,
  computeWizard,
  currentStepOf,
  legacyFinished,
  stepsFor,
  type Approval,
  type Finished,
  type WizardState,
} from './steps.js';

/**
 * Journeys build plan J3 — the wizard's one rule file, as tables. Pure: no
 * database. `j3.test.ts` proves the loader hands these functions the right
 * rows; this proves what they do with them.
 */

const T = (day: number) => new Date(Date.UTC(2026, 8, day));
const P1 = { id: 'p1', number: 1 };
const P2 = { id: 'p2', number: 2 };

const approval = (step: StepKind, day: number, phaseId: string | null = null): Approval => ({
  step,
  phaseId,
  approvedAt: T(day),
});

const state = (over: Partial<WizardState> = {}): WizardState => ({
  sequence: 'AGREEMENT_FIRST',
  designPath: null,
  phases: [],
  approvals: [],
  finished: [],
  ...over,
});

const shape = (s: WizardState) => computeWizard(s).map((w) => `${w.step}${w.phaseId ? `:${w.phaseId}` : ''}=${w.status}`);

// ---- stepsFor ------------------------------------------------------------------

test('stepsFor: the road for each sequence, design path and phase count', () => {
  const table: Array<{ name: string; sequence: ContractSequence; path: 'PREMADE' | 'CUSTOM' | null; phases: typeof P1[]; want: string[] }> = [
    {
      name: 'new road, no phases yet: one placeholder demo, no mockup',
      sequence: 'AGREEMENT_FIRST',
      path: null,
      phases: [],
      want: ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'DEMO', 'SUMMARY'],
    },
    {
      name: 'new road, pre-made design: no mockup',
      sequence: 'AGREEMENT_FIRST',
      path: 'PREMADE',
      phases: [P1],
      want: ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'DEMO:p1', 'SUMMARY'],
    },
    {
      name: 'new road, custom design: mockup joins after design',
      sequence: 'AGREEMENT_FIRST',
      path: 'CUSTOM',
      phases: [P1, P2],
      want: ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO:p1', 'DEMO:p2', 'SUMMARY'],
    },
    {
      name: 'legacy road: design, agreement, a demo per phase — no summary, no placeholder',
      sequence: 'DESIGN_FIRST',
      path: null,
      phases: [P1, P2],
      want: ['DESIGN', 'AGREEMENT', 'DEMO:p1', 'DEMO:p2'],
    },
    {
      name: 'legacy road with no phases is just design and agreement (today’s page)',
      sequence: 'DESIGN_FIRST',
      path: null,
      phases: [],
      want: ['DESIGN', 'AGREEMENT'],
    },
    {
      name: 'the design path means nothing on the legacy road',
      sequence: 'DESIGN_FIRST',
      path: 'CUSTOM',
      phases: [P1],
      want: ['DESIGN', 'AGREEMENT', 'DEMO:p1'],
    },
  ];
  for (const row of table) {
    const got = stepsFor(row.sequence, row.path, row.phases).map((s) => `${s.step}${s.phaseId ? `:${s.phaseId}` : ''}`);
    assert.deepEqual(got, row.want, row.name);
  }
});

test('stepsFor: phases come out in number order whatever order they were given', () => {
  const got = stepsFor('AGREEMENT_FIRST', null, [P2, P1]).filter((s) => s.step === 'DEMO');
  assert.deepEqual(got.map((s) => [s.phaseId, s.phaseNumber]), [['p1', 1], ['p2', 2]]);
});

test('stepsFor: the placeholder demo has no phase, so it can never carry an approval', () => {
  const [demo] = stepsFor('AGREEMENT_FIRST', null, []).filter((s) => s.step === 'DEMO');
  assert.deepEqual(demo, { step: 'DEMO', phaseId: null, phaseNumber: null });
});

// ---- computeWizard: the new road --------------------------------------------------

test('a new-road contract with no data: the first step is current, everything after is upcoming', () => {
  assert.deepEqual(shape(state()), [
    'REQUIREMENTS=CURRENT',
    'SCOPE=UPCOMING',
    'DRAFT=UPCOMING',
    'AGREEMENT=UPCOMING',
    'DESIGN=UPCOMING',
    'DEMO=UPCOMING',
    'SUMMARY=UPCOMING',
  ]);
});

test('the agreement approved: the three steps that lock with it are done, design is current', () => {
  const w = computeWizard(state({ approvals: [approval('AGREEMENT', 5)] }));
  assert.deepEqual(w.map((s) => `${s.step}=${s.status}/${s.locked}`), [
    'REQUIREMENTS=DONE/true',
    'SCOPE=DONE/true',
    'DRAFT=DONE/true',
    'AGREEMENT=DONE/true',
    'DESIGN=CURRENT/false',
    'DEMO=UPCOMING/false',
    'SUMMARY=UPCOMING/false',
  ]);
  // Locked with the agreement's own moment, for all four.
  for (const s of w.slice(0, 4)) assert.deepEqual(s.lockedAt, T(5), s.step);
});

test('LOCKS_WITH_AGREEMENT is exactly the brief, the scope and the draft', () => {
  assert.deepEqual([...LOCKS_WITH_AGREEMENT].sort(), ['DRAFT', 'REQUIREMENTS', 'SCOPE']);
});

test('a step with its own approval locks with that approval alone', () => {
  const w = computeWizard(
    state({
      approvals: [approval('AGREEMENT', 5), approval('DESIGN', 9)],
      phases: [P1],
    }),
  );
  const design = w.find((s) => s.step === 'DESIGN')!;
  assert.equal(design.locked, true);
  assert.deepEqual(design.lockedAt, T(9));
  assert.equal(design.status, 'DONE');
  assert.equal(w.find((s) => s.step === 'DEMO')!.status, 'CURRENT');
  assert.equal(w.find((s) => s.step === 'DEMO')!.locked, false);
});

test('a demo locks per phase: approving phase 1 leaves phase 2 open and current', () => {
  const w = computeWizard(
    state({
      phases: [P1, P2],
      approvals: [approval('AGREEMENT', 1), approval('DESIGN', 2), approval('DEMO', 3, 'p1')],
    }),
  );
  const demos = w.filter((s) => s.step === 'DEMO');
  assert.deepEqual(demos.map((d) => [d.phaseId, d.status, d.locked]), [
    ['p1', 'DONE', true],
    ['p2', 'CURRENT', false],
  ]);
});

test('a demo approval for one phase never satisfies the placeholder or another phase', () => {
  const w = computeWizard(state({ phases: [P2], approvals: [approval('DEMO', 3, 'p1')] }));
  assert.equal(w.find((s) => s.step === 'DEMO')!.locked, false);
});

test('an approval on an earlier-numbered gap does not skip the road: current is the FIRST step not done', () => {
  // DESIGN approved without the agreement (a stray row): the agreement steps
  // are still not done, so the road is still at REQUIREMENTS.
  const w = computeWizard(state({ approvals: [approval('DESIGN', 4)] }));
  assert.equal(currentStepOf(w)!.step, 'REQUIREMENTS');
  assert.equal(w.find((s) => s.step === 'DESIGN')!.status, 'DONE');
  assert.equal(w.filter((s) => s.status === 'CURRENT').length, 1);
});

test('finished signals (J4–J6, J11) complete a step without locking it', () => {
  const finished: Finished[] = [{ step: 'REQUIREMENTS', phaseId: null, at: T(2) }];
  const w = computeWizard(state({ finished }));
  const req = w[0];
  assert.equal(req.status, 'DONE');
  assert.equal(req.locked, false);
  assert.deepEqual(req.finishedAt, T(2));
  assert.equal(w[1].status, 'CURRENT');
});

test('finishedAt: the signal’s own time, else the lock’s, else null', () => {
  const w = computeWizard(
    state({
      approvals: [approval('AGREEMENT', 8)],
      finished: [{ step: 'SCOPE', phaseId: null, at: T(3) }],
    }),
  );
  assert.deepEqual(w.find((s) => s.step === 'SCOPE')!.finishedAt, T(3));
  assert.deepEqual(w.find((s) => s.step === 'DRAFT')!.finishedAt, T(8));
  assert.equal(w.find((s) => s.step === 'DESIGN')!.finishedAt, null);
});

test('every step done: no current step', () => {
  const w = computeWizard(
    state({
      phases: [P1],
      approvals: [approval('AGREEMENT', 1), approval('DESIGN', 2), approval('DEMO', 3, 'p1')],
      finished: [{ step: 'SUMMARY', phaseId: null, at: T(4) }],
    }),
  );
  assert.equal(currentStepOf(w), null);
  assert.ok(w.every((s) => s.status === 'DONE'));
});

test('SUMMARY never takes input; every other step does', () => {
  const w = computeWizard(state({ phases: [P1] }));
  assert.deepEqual(w.filter((s) => !s.takesInput).map((s) => s.step), ['SUMMARY']);
});

test('iterationsUsed and allowance are null until J8–J10 give a step an allowance', () => {
  for (const s of computeWizard(state())) {
    assert.equal(s.iterationsUsed, null);
    assert.equal(s.allowance, null);
  }
});

// ---- computeWizard: the legacy road -----------------------------------------------

test('DESIGN_FIRST: nothing done yet — design is current, exactly the page as it stands', () => {
  assert.deepEqual(shape(state({ sequence: 'DESIGN_FIRST' })), ['DESIGN=CURRENT', 'AGREEMENT=UPCOMING']);
});

test('DESIGN_FIRST reads its progress from the legacy signals, and is never locked', () => {
  const table: Array<{ name: string; finished: Finished[]; want: string[] }> = [
    {
      name: 'design complete, contract not signed: the agreement is current',
      finished: [{ step: 'DESIGN', phaseId: null, at: null }],
      want: ['DESIGN=DONE', 'AGREEMENT=CURRENT', 'DEMO:p1=UPCOMING'],
    },
    {
      name: 'signed: the demo is current',
      finished: [
        { step: 'DESIGN', phaseId: null, at: null },
        { step: 'AGREEMENT', phaseId: null, at: T(4) },
      ],
      want: ['DESIGN=DONE', 'AGREEMENT=DONE', 'DEMO:p1=CURRENT'],
    },
    {
      name: 'a design revised after signing puts the design back in front (the pending banner’s case)',
      finished: [{ step: 'AGREEMENT', phaseId: null, at: T(4) }],
      want: ['DESIGN=CURRENT', 'AGREEMENT=DONE', 'DEMO:p1=UPCOMING'],
    },
  ];
  for (const row of table) {
    assert.deepEqual(shape(state({ sequence: 'DESIGN_FIRST', phases: [P1], finished: row.finished })), row.want, row.name);
  }
  for (const s of computeWizard(state({ sequence: 'DESIGN_FIRST', phases: [P1] }))) {
    assert.equal(s.locked, false, s.step);
    assert.equal(s.lockedAt, null, s.step);
  }
});

test('DESIGN_FIRST ignores StepApproval rows entirely: the legacy road is never locked', () => {
  const w = computeWizard(
    state({ sequence: 'DESIGN_FIRST', phases: [P1], approvals: [approval('AGREEMENT', 1), approval('DESIGN', 2)] }),
  );
  assert.deepEqual(w.map((s) => [s.step, s.status, s.locked]), [
    ['DESIGN', 'CURRENT', false],
    ['AGREEMENT', 'UPCOMING', false],
    ['DEMO', 'UPCOMING', false],
  ]);
});

test('legacyFinished: the gate’s answer, the signature’s time, and each accepted phase', () => {
  assert.deepEqual(legacyFinished({ designComplete: false, signed: false, signedAt: null, acceptedPhaseIds: [] }), []);
  assert.deepEqual(
    legacyFinished({ designComplete: true, signed: true, signedAt: T(6), acceptedPhaseIds: ['p1', 'p3'] }),
    [
      { step: 'DESIGN', phaseId: null, at: null },
      { step: 'AGREEMENT', phaseId: null, at: T(6) },
      { step: 'DEMO', phaseId: 'p1', at: null },
      { step: 'DEMO', phaseId: 'p3', at: null },
    ],
  );
});

// ---- assertStepOpen -----------------------------------------------------------------

const refusal = (code: string) => (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code === code;

test('assertStepOpen: STEP_LOCKED once the sealing approval exists, for every step it seals', () => {
  const sealed = state({ phases: [P1], approvals: [approval('AGREEMENT', 1), approval('DESIGN', 2), approval('DEMO', 3, 'p1')] });
  for (const [step, phaseId] of [
    ['REQUIREMENTS', null],
    ['SCOPE', null],
    ['DRAFT', null],
    ['AGREEMENT', null],
    ['DESIGN', null],
    ['DEMO', 'p1'],
  ] as const) {
    assert.throws(() => assertStepOpen(sealed, step, phaseId), refusal('STEP_LOCKED'), `${step} ${phaseId ?? ''}`);
  }
});

test('assertStepOpen: an open step passes, and a demo’s phase is its own lock', () => {
  const s = state({ phases: [P1, P2], approvals: [approval('AGREEMENT', 1), approval('DEMO', 3, 'p1')] });
  assertStepOpen(s, 'DESIGN');
  assertStepOpen(s, 'DEMO', 'p2');
  assert.throws(() => assertStepOpen(s, 'DEMO', 'p1'), refusal('STEP_LOCKED'));
  // The whole road is open before anything is approved.
  const fresh = state({ phases: [P1] });
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN'] as const) assertStepOpen(fresh, step);
});

test('assertStepOpen: SUMMARY never takes input, approved or not', () => {
  assert.throws(() => assertStepOpen(state(), 'SUMMARY'), refusal('STEP_LOCKED'));
});

test('assertStepOpen: a step that is not on this contract’s road is not locked', () => {
  // MOCKUP on the pre-made path; REQUIREMENTS on the legacy road; an unknown phase.
  assertStepOpen(state({ designPath: 'PREMADE' }), 'MOCKUP');
  assertStepOpen(state({ sequence: 'DESIGN_FIRST' }), 'REQUIREMENTS');
  assertStepOpen(state({ phases: [P1], approvals: [approval('DEMO', 1, 'gone')] }), 'DEMO', 'gone');
});

test('assertStepOpen: the legacy road is never locked, whatever rows exist', () => {
  const legacy = state({ sequence: 'DESIGN_FIRST', phases: [P1], approvals: [approval('AGREEMENT', 1), approval('DESIGN', 2)] });
  assertStepOpen(legacy, 'DESIGN');
  assertStepOpen(legacy, 'AGREEMENT');
  assertStepOpen(legacy, 'DEMO', 'p1');
});

// ---- the constant ---------------------------------------------------------------------

test('SEQUENCE_FOR_NEW_CONTRACTS stays DESIGN_FIRST until J4 makes the new road usable', () => {
  // A tripwire, not a spec: the day J4 flips it, this test is the line to
  // change — and its failure is the reminder that createContract's callers
  // (the legacy e2e specs, the integration files that sign a contract) now
  // create contracts on the road with no agreement gate yet.
  assert.equal(SEQUENCE_FOR_NEW_CONTRACTS, 'DESIGN_FIRST');
});
