import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProjectProgress, isPhaseAccepted, type PhaseLike, type ScopeStatusLike } from './phase.js';

const item = (status: ScopeStatusLike) => ({ status });

const phase = (number: number, statuses: ScopeStatusLike[]): PhaseLike => ({
  id: `phase-${number}`,
  number,
  titleFa: `فاز ${number}`,
  titleEn: `Phase ${number}`,
  scopeItems: statuses.map(item),
});

test('no phases at all reads as null, not phase 0 or phase 1', () => {
  const progress = computeProjectProgress([]);
  assert.deepEqual(progress, {
    totalPhases: 0,
    currentPhaseNumber: null,
    currentPhaseTitleFa: null,
    currentPhaseTitleEn: null,
    itemsAcceptedInPhase: 0,
    itemsTotalInPhase: 0,
  });
});

test('a single in-progress phase is the current one', () => {
  const progress = computeProjectProgress([phase(1, ['AGREED', 'IN_BUILD'])]);
  assert.equal(progress.totalPhases, 1);
  assert.equal(progress.currentPhaseNumber, 1);
  assert.equal(progress.itemsAcceptedInPhase, 0);
  assert.equal(progress.itemsTotalInPhase, 2);
});

test('the current phase is the first one not fully accepted', () => {
  const progress = computeProjectProgress([
    phase(1, ['ACCEPTED', 'ACCEPTED']),
    phase(2, ['ACCEPTED', 'IN_DEMO']),
    phase(3, ['PROPOSED']),
  ]);
  assert.equal(progress.currentPhaseNumber, 2);
  assert.equal(progress.itemsAcceptedInPhase, 1);
  assert.equal(progress.itemsTotalInPhase, 2);
});

test('when every phase is fully accepted, the last phase is reported as current', () => {
  const progress = computeProjectProgress([
    phase(1, ['ACCEPTED']),
    phase(2, ['ACCEPTED', 'ACCEPTED']),
  ]);
  assert.equal(progress.currentPhaseNumber, 2);
  assert.equal(progress.itemsAcceptedInPhase, 2);
  assert.equal(progress.itemsTotalInPhase, 2);
});

test('DECLINED and TRADED items neither block a phase from being done nor count in the total', () => {
  const progress = computeProjectProgress([phase(1, ['ACCEPTED', 'DECLINED', 'TRADED'])]);
  // All non-declined/traded items (just the one ACCEPTED) are done, so phase
  // 1 counts as done and — being the only phase — is still reported current.
  assert.equal(progress.currentPhaseNumber, 1);
  assert.equal(progress.itemsAcceptedInPhase, 1);
  assert.equal(progress.itemsTotalInPhase, 1);
});

test('an empty phase counts as done and is skipped when searching for the current one', () => {
  const progress = computeProjectProgress([phase(1, []), phase(2, ['PROPOSED'])]);
  assert.equal(progress.currentPhaseNumber, 2);
});

test('a project with only empty phases reports the last one, with a 0/0 item count', () => {
  const progress = computeProjectProgress([phase(1, []), phase(2, [])]);
  assert.equal(progress.currentPhaseNumber, 2);
  assert.equal(progress.itemsAcceptedInPhase, 0);
  assert.equal(progress.itemsTotalInPhase, 0);
});

test('isPhaseAccepted: accepted means non-empty and every counted item ACCEPTED (J3) — unlike isPhaseDone, an empty phase has finished nothing', () => {
  assert.equal(isPhaseAccepted(phase(1, [])), false);
  assert.equal(isPhaseAccepted(phase(1, ['ACCEPTED', 'ACCEPTED'])), true);
  assert.equal(isPhaseAccepted(phase(1, ['ACCEPTED', 'IN_DEMO'])), false);
  // Declined and traded items are not part of the deal, so they neither block…
  assert.equal(isPhaseAccepted(phase(1, ['ACCEPTED', 'DECLINED', 'TRADED'])), true);
  // …nor count as work done on their own.
  assert.equal(isPhaseAccepted(phase(1, ['DECLINED', 'TRADED'])), false);
});

test('titles come from the current phase, not the first or last', () => {
  const progress = computeProjectProgress([
    phase(1, ['ACCEPTED']),
    { ...phase(2, ['PROPOSED']), titleFa: 'راه‌اندازی', titleEn: 'Launch' },
  ]);
  assert.equal(progress.currentPhaseTitleEn, 'Launch');
  assert.equal(progress.currentPhaseTitleFa, 'راه‌اندازی');
});
