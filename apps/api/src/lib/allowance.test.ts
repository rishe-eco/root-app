import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWANCE_STEPS,
  MAX_EXTENSION,
  allowanceFor,
  allowanceState,
  assertWithinAllowance,
  baseAllowance,
  checkExtension,
  isExhausted,
  iterationsUsed,
  type BriefAllowances,
  type ExtensionRow,
} from './allowance.js';

/**
 * Journeys build plan J8 — the allowance rule, as tables. Pure: no database.
 * `j8.test.ts` proves the loader counts published design revisions and the
 * publish guard asks this file.
 */

const premade: BriefAllowances = {
  designTier: 'THEME_PICK',
  premadeRounds: 3,
  wireframeIterations: 2,
  mockupIterations: null,
  demoIterationsPerPhase: 2,
};
const custom: BriefAllowances = {
  designTier: 'SENIOR_DESIGNER',
  premadeRounds: null,
  wireframeIterations: 2,
  mockupIterations: 4,
  demoIterationsPerPhase: 2,
};

const ext = (step: ExtensionRow['step'], extra: number, phaseId: string | null = null): ExtensionRow => ({ step, phaseId, extra });

test('DESIGN counts against the allowance that matches the design path — the pre-made rounds or the wireframe iterations', () => {
  assert.equal(baseAllowance('DESIGN', premade), 3);
  assert.equal(baseAllowance('DESIGN', custom), 2);
  // The other tier of the custom path is custom too (PD-13): one function, not two lists.
  assert.equal(baseAllowance('DESIGN', { ...custom, designTier: 'CLAUDE_ASSISTED' }), 2);
});

test('MOCKUP has an allowance only on the custom path; DEMO is per-phase and the same on both', () => {
  assert.equal(baseAllowance('MOCKUP', custom), 4);
  assert.equal(baseAllowance('MOCKUP', premade), null, 'a pre-made contract has no mockup step');
  assert.equal(baseAllowance('DEMO', premade), 2);
  assert.equal(baseAllowance('DEMO', custom), 2);
});

test('the steps that never take rounds have no allowance, and neither has a contract with no brief', () => {
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'SUMMARY'] as const) {
    assert.equal(baseAllowance(step, premade), null, step);
    assert.equal(allowanceFor(step, null, premade, []), null, step);
  }
  assert.equal(baseAllowance('DESIGN', null), null);
  assert.deepEqual([...ALLOWANCE_STEPS], ['DESIGN', 'MOCKUP', 'DEMO']);
});

test('extensions add to their own step and no other', () => {
  const extensions = [ext('DESIGN', 1), ext('DESIGN', 2), ext('MOCKUP', 5)];
  assert.equal(allowanceFor('DESIGN', null, premade, extensions), 6);
  assert.equal(allowanceFor('MOCKUP', null, custom, extensions), 9);
  assert.equal(allowanceFor('DEMO', 'p1', premade, extensions), 2, 'a design extension does not raise the demo');
});

test('a demo extension is for its phase only (Q-S6: per phase)', () => {
  const extensions = [ext('DEMO', 3, 'p1')];
  assert.equal(allowanceFor('DEMO', 'p1', premade, extensions), 5);
  assert.equal(allowanceFor('DEMO', 'p2', premade, extensions), 2);
});

test('an extension on an unset allowance changes nothing: there is no limit to raise', () => {
  assert.equal(allowanceFor('DESIGN', null, { ...premade, premadeRounds: null }, [ext('DESIGN', 2)]), null);
});

test('iterationsUsed: DESIGN is counted; MOCKUP and DEMO read "not counted" until J9 and J10 supply theirs', () => {
  assert.equal(iterationsUsed('DESIGN', null, { design: 2 }), 2);
  assert.equal(iterationsUsed('DESIGN', null, { design: 0 }), 0);
  assert.equal(iterationsUsed('MOCKUP', null, { design: 2 }), null);
  assert.equal(iterationsUsed('DEMO', 'p1', { design: 2 }), null);
  // Once they do, the numbers come through untouched.
  assert.equal(iterationsUsed('MOCKUP', null, { design: 2, mockup: 1 }), 1);
  assert.equal(iterationsUsed('DEMO', 'p1', { design: 2, demoByPhase: { p1: 2 } }), 2);
  assert.equal(iterationsUsed('DEMO', 'p2', { design: 2, demoByPhase: { p1: 2 } }), null);
  assert.equal(iterationsUsed('SCOPE', null, { design: 2 }), null);
});

test('the guard: the round about to be published must fit — three of three refuses the fourth, and an extension admits one more', () => {
  const at = (used: number, extensions: ExtensionRow[] = []) => allowanceState('DESIGN', null, premade, extensions, { design: used });
  assert.doesNotThrow(() => assertWithinAllowance(at(0)));
  assert.doesNotThrow(() => assertWithinAllowance(at(2)));
  assert.equal(isExhausted(at(3)), true);
  assert.throws(
    () => assertWithinAllowance(at(3)),
    (err: unknown) => {
      const e = err as { extensions?: { code?: string; used?: number; allowance?: number } };
      return e.extensions?.code === 'ALLOWANCE_EXHAUSTED' && e.extensions.used === 3 && e.extensions.allowance === 3;
    },
  );
  // Sales extends by one: the fourth is admitted, the fifth is not.
  assert.doesNotThrow(() => assertWithinAllowance(at(3, [ext('DESIGN', 1)])));
  assert.throws(() => assertWithinAllowance(at(4, [ext('DESIGN', 1)])), /rounds/);
});

test('a step nobody counts yet is never refused', () => {
  const mockup = allowanceState('MOCKUP', null, custom, [], { design: 0 });
  assert.deepEqual(mockup, { used: null, allowance: 4 });
  assert.equal(isExhausted(mockup), false);
  assert.doesNotThrow(() => assertWithinAllowance(mockup));
  assert.doesNotThrow(() => assertWithinAllowance({ used: 5, allowance: null }));
});

test('checkExtension: whole rounds above zero, a reason, and the phase only where the allowance is per phase', () => {
  const ok = { step: 'DESIGN' as const, phaseId: null, extra: 1, reason: 'the customer changed direction' };
  assert.equal(checkExtension(ok), null);
  assert.equal(checkExtension({ ...ok, extra: 0 }), 'INVALID_EXTRA');
  assert.equal(checkExtension({ ...ok, extra: -2 }), 'INVALID_EXTRA');
  assert.equal(checkExtension({ ...ok, extra: 1.5 }), 'INVALID_EXTRA');
  assert.equal(checkExtension({ ...ok, extra: MAX_EXTENSION + 1 }), 'INVALID_EXTRA');
  assert.equal(checkExtension({ ...ok, extra: MAX_EXTENSION }), null);
  assert.equal(checkExtension({ ...ok, reason: '   ' }), 'REASON_REQUIRED');
  assert.equal(checkExtension({ ...ok, step: 'SCOPE' }), 'STEP_HAS_NO_ALLOWANCE');
  assert.equal(checkExtension({ ...ok, step: 'DEMO' }), 'PHASE_REQUIRED');
  assert.equal(checkExtension({ ...ok, step: 'DEMO', phaseId: 'p1' }), null);
  assert.equal(checkExtension({ ...ok, phaseId: 'p1' }), 'PHASE_NOT_ALLOWED');
});
