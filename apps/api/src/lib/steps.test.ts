import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContractSequence, StepKind } from '@prisma/client';
import {
  LOCKS_WITH_AGREEMENT,
  SEQUENCE_FOR_NEW_CONTRACTS,
  agreementSignedAt,
  assertStepOpen,
  computeWizard,
  currentStepOf,
  designMissing,
  designPathOf,
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

/** The signature as the loader supplies it (J7): AGREEMENT's "done" signal. */
const signed = (day: number): Finished => ({ step: 'AGREEMENT', phaseId: null, at: T(day) });

test('the agreement approved but not signed (J7): the steps that lock with it are done, the agreement itself is locked and still current', () => {
  const w = computeWizard(state({ approvals: [approval('AGREEMENT', 5)] }));
  assert.deepEqual(w.map((s) => `${s.step}=${s.status}/${s.locked}`), [
    'REQUIREMENTS=DONE/true',
    'SCOPE=DONE/true',
    'DRAFT=DONE/true',
    'AGREEMENT=CURRENT/true',
    'DESIGN=UPCOMING/false',
    'DEMO=UPCOMING/false',
    'SUMMARY=UPCOMING/false',
  ]);
  // Locked with the agreement's own moment, for all four.
  for (const s of w.slice(0, 4)) assert.deepEqual(s.lockedAt, T(5), s.step);
  // Not done, so no finished time — the approval is a lock, not a completion.
  assert.equal(w[3].finishedAt, null);
});

test('the agreement approved and signed (J7): AGREEMENT is done — done means signed — and design is current', () => {
  const w = computeWizard(state({ approvals: [approval('AGREEMENT', 5)], finished: [signed(6)] }));
  assert.deepEqual(w.map((s) => `${s.step}=${s.status}/${s.locked}`), [
    'REQUIREMENTS=DONE/true',
    'SCOPE=DONE/true',
    'DRAFT=DONE/true',
    'AGREEMENT=DONE/true',
    'DESIGN=CURRENT/false',
    'DEMO=UPCOMING/false',
    'SUMMARY=UPCOMING/false',
  ]);
  assert.deepEqual(w[3].finishedAt, T(6));
});

test('a signature without an approval (a direct insert, J13’s tests) makes AGREEMENT done but locks nothing', () => {
  const w = computeWizard(state({ finished: [signed(6)] }));
  const agreement = w.find((s) => s.step === 'AGREEMENT')!;
  assert.deepEqual([agreement.status, agreement.locked], ['DONE', false]);
  assert.equal(w.find((s) => s.step === 'REQUIREMENTS')!.locked, false);
});

test('the legacy road’s AGREEMENT is done when signed, as it always was — J7 changed only the new road', () => {
  const w = computeWizard(state({ sequence: 'DESIGN_FIRST', finished: [{ step: 'AGREEMENT', phaseId: null, at: T(4) }] }));
  assert.equal(w.find((s) => s.step === 'AGREEMENT')!.status, 'DONE');
});

test('LOCKS_WITH_AGREEMENT is exactly the brief, the scope and the draft', () => {
  assert.deepEqual([...LOCKS_WITH_AGREEMENT].sort(), ['DRAFT', 'REQUIREMENTS', 'SCOPE']);
});

test('a step with its own approval locks with that approval alone', () => {
  const w = computeWizard(
    state({
      approvals: [approval('AGREEMENT', 5), approval('DESIGN', 9)],
      finished: [signed(6)],
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
      finished: [signed(1)],
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
      finished: [signed(1), { step: 'SUMMARY', phaseId: null, at: T(4) }],
    }),
  );
  assert.equal(currentStepOf(w), null);
  assert.ok(w.every((s) => s.status === 'DONE'));
});

test('SUMMARY never takes input; every other step does', () => {
  const w = computeWizard(state({ phases: [P1] }));
  assert.deepEqual(w.filter((s) => !s.takesInput).map((s) => s.step), ['SUMMARY']);
});

test('iterationsUsed and allowance are null for a step nobody counts', () => {
  for (const s of computeWizard(state())) {
    assert.equal(s.iterationsUsed, null);
    assert.equal(s.allowance, null);
  }
});

test('J8: the design step carries its rounds used and its allowance; a step with no entry still reads null', () => {
  const w = computeWizard(state({ designPath: 'PREMADE', iterations: [{ step: 'DESIGN', phaseId: null, used: 2, allowance: 3 }] }));
  const design = w.find((s) => s.step === 'DESIGN')!;
  assert.equal(design.iterationsUsed, 2);
  assert.equal(design.allowance, 3);
  for (const s of w.filter((x) => x.step !== 'DESIGN')) assert.equal(s.iterationsUsed, null, s.step);
  // A demo's count is per phase: only the phase it names carries it.
  const withDemo = computeWizard(
    state({ phases: [P1, P2], iterations: [{ step: 'DEMO', phaseId: 'p2', used: 1, allowance: 2 }] }),
  );
  assert.deepEqual(
    withDemo.filter((s) => s.step === 'DEMO').map((s) => [s.phaseId, s.iterationsUsed, s.allowance]),
    [
      ['p1', null, null],
      ['p2', 1, 2],
    ],
  );
});

test('J8: designPathOf is the one place a tier becomes a path — the pre-made tier and the two custom ones', () => {
  assert.equal(designPathOf('THEME_PICK'), 'PREMADE');
  assert.equal(designPathOf('CLAUDE_ASSISTED'), 'CUSTOM');
  assert.equal(designPathOf('SENIOR_DESIGNER'), 'CUSTOM');
});

test('J8: the custom path puts MOCKUP on the road and the pre-made path does not — from the tier, through the same function', () => {
  const road = (tier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER') =>
    stepsFor('AGREEMENT_FIRST', designPathOf(tier), []).map((s) => s.step);
  assert.equal(road('THEME_PICK').includes('MOCKUP'), false);
  assert.equal(road('CLAUDE_ASSISTED').includes('MOCKUP'), true);
  assert.equal(road('SENIOR_DESIGNER').includes('MOCKUP'), true);
});

// ---- designMissing: the new road's design completeness (J8) ---------------------------

test('J8 designMissing: pre-made needs a chosen concept; custom needs every page approved, one page at least, and a palette', () => {
  const concept = (chosen: boolean, ...pages: boolean[]) => ({
    chosenAt: chosen ? T(1) : null,
    pages: pages.map((approved) => ({ approvedAt: approved ? T(1) : null })),
  });
  const table: Array<{ name: string; input: Parameters<typeof designMissing>[0]; want: string[] }> = [
    { name: 'nothing published yet', input: { path: 'PREMADE', hasRound: false, concepts: [], paletteCount: 0 }, want: ['NO_ROUND'] },
    { name: 'a round but no brief, so no path', input: { path: null, hasRound: true, concepts: [concept(true)], paletteCount: 3 }, want: ['BRIEF_MISSING'] },
    { name: 'pre-made, nothing chosen', input: { path: 'PREMADE', hasRound: true, concepts: [concept(false), concept(false)], paletteCount: 0 }, want: ['CONCEPT_NOT_CHOSEN'] },
    { name: 'pre-made, one chosen — a palette is not asked for', input: { path: 'PREMADE', hasRound: true, concepts: [concept(false), concept(true)], paletteCount: 0 }, want: [] },
    { name: 'pre-made: page approvals are not asked for', input: { path: 'PREMADE', hasRound: true, concepts: [concept(true, false)], paletteCount: 0 }, want: [] },
    { name: 'custom, no pages at all', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(true)], paletteCount: 2 }, want: ['NO_PAGES'] },
    { name: 'custom, a page unapproved', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(true, true, false)], paletteCount: 2 }, want: ['PAGE_NOT_APPROVED'] },
    { name: 'custom, pages approved, palette empty', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(true, true, true)], paletteCount: 0 }, want: ['PALETTE_EMPTY'] },
    { name: 'custom, both missing', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(true, false)], paletteCount: 0 }, want: ['PAGE_NOT_APPROVED', 'PALETTE_EMPTY'] },
    { name: 'custom, complete', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(true, true, true)], paletteCount: 1 }, want: [] },
    { name: 'custom: the concept need not be chosen (there is one direction to approve)', input: { path: 'CUSTOM', hasRound: true, concepts: [concept(false, true)], paletteCount: 1 }, want: [] },
  ];
  for (const { name, input, want } of table) assert.deepEqual(designMissing(input), want, name);
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

test('SEQUENCE_FOR_NEW_CONTRACTS is AGREEMENT_FIRST — J7 flipped it, PD-7 and the column default agree', () => {
  // The tripwire this test was until J7 (it asserted DESIGN_FIRST, and said the
  // day J7 flips it, this is the line to change). J7 builds the agreement gate —
  // the first point at which an AGREEMENT_FIRST contract can be approved and
  // signed — so every contract `createContract` makes is now on the new road,
  // and a test or fixture that is *about* the legacy road makes one directly.
  assert.equal(SEQUENCE_FOR_NEW_CONTRACTS, 'AGREEMENT_FIRST');
});

test('agreementSignedAt (J13): the signature, on both roads — an AGREEMENT approval alone is not signed', () => {
  const signed = new Date('2026-10-01T00:00:00Z');
  assert.deepEqual(agreementSignedAt({ signatureSignedAt: signed }), signed);
  assert.equal(agreementSignedAt({ signatureSignedAt: null }), null);
});
