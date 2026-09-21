import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  missingDispositions,
  hasAtMostOneOrigin,
  outcomeAllowedForStatus,
  declinedRequiresNote,
  noOriginRequiresNote,
  noteAndLangTogether,
  nextFeedbackStatus,
  nextBuildNumber,
} from './build.js';

// --- missingDispositions (L3b.2's "a fate must never be silent") -----------

test('missingDispositions: every open id must appear once among the changes', () => {
  const missing = missingDispositions(['a', 'b', 'c'], [{ feedbackItemId: 'a' }, { feedbackItemId: 'c' }]);
  assert.deepEqual(missing, ['b']);
});

test('missingDispositions: empty when every open id is covered', () => {
  const missing = missingDispositions(['a', 'b'], [{ feedbackItemId: 'a' }, { feedbackItemId: 'b' }, { scopeItemId: 's1' }]);
  assert.deepEqual(missing, []);
});

test('missingDispositions: a no-origin or scope-origin entry never counts toward coverage', () => {
  const missing = missingDispositions(['a'], [{ scopeItemId: 's1' }, { note: 'refactor' }]);
  assert.deepEqual(missing, ['a']);
});

// --- hasAtMostOneOrigin -----------------------------------------------------

test('hasAtMostOneOrigin: neither set is legal ("nobody asked")', () => {
  assert.equal(hasAtMostOneOrigin({}), true);
});

test('hasAtMostOneOrigin: exactly one set is legal', () => {
  assert.equal(hasAtMostOneOrigin({ feedbackItemId: 'f1' }), true);
  assert.equal(hasAtMostOneOrigin({ scopeItemId: 's1' }), true);
});

test('hasAtMostOneOrigin: both set is not legal', () => {
  assert.equal(hasAtMostOneOrigin({ feedbackItemId: 'f1', scopeItemId: 's1' }), false);
});

// --- outcomeAllowedForStatus (D3's gate stays intact) -----------------------

test('outcomeAllowedForStatus: CARRIED_FORWARD is legal for OPEN and RATIFIED', () => {
  assert.equal(outcomeAllowedForStatus('CARRIED_FORWARD', 'OPEN'), true);
  assert.equal(outcomeAllowedForStatus('CARRIED_FORWARD', 'RATIFIED'), true);
});

test('outcomeAllowedForStatus: ADDRESSED/DECLINED require RATIFIED, never a merely-OPEN item', () => {
  assert.equal(outcomeAllowedForStatus('ADDRESSED', 'OPEN'), false);
  assert.equal(outcomeAllowedForStatus('DECLINED', 'OPEN'), false);
  assert.equal(outcomeAllowedForStatus('ADDRESSED', 'RATIFIED'), true);
  assert.equal(outcomeAllowedForStatus('DECLINED', 'RATIFIED'), true);
});

test('outcomeAllowedForStatus: an already-resolved item never accepts a new disposition', () => {
  assert.equal(outcomeAllowedForStatus('ADDRESSED', 'ADDRESSED'), false);
  assert.equal(outcomeAllowedForStatus('CARRIED_FORWARD', 'ACCEPTED'), false);
});

// --- declinedRequiresNote (L3b.2's third rule) ------------------------------

test('declinedRequiresNote: DECLINED with no note fails', () => {
  assert.equal(declinedRequiresNote({ outcome: 'DECLINED' }), false);
  assert.equal(declinedRequiresNote({ outcome: 'DECLINED', note: '   ' }), false);
});

test('declinedRequiresNote: DECLINED with a real note passes; any other outcome is unconstrained', () => {
  assert.equal(declinedRequiresNote({ outcome: 'DECLINED', note: 'already decided in the contract' }), true);
  assert.equal(declinedRequiresNote({ outcome: 'ADDRESSED' }), true);
  assert.equal(declinedRequiresNote({ outcome: 'CARRIED_FORWARD' }), true);
});

// --- noOriginRequiresNote (L3b.1's third source: "the note IS the entry") --

test('noOriginRequiresNote: an entry with neither origin needs a real note', () => {
  assert.equal(noOriginRequiresNote({}), false);
  assert.equal(noOriginRequiresNote({ note: '  ' }), false);
  assert.equal(noOriginRequiresNote({ note: 'swapped the SMS provider' }), true);
});

test('noOriginRequiresNote: an entry with an origin is unconstrained', () => {
  assert.equal(noOriginRequiresNote({ feedbackItemId: 'f1' }), true);
  assert.equal(noOriginRequiresNote({ scopeItemId: 's1' }), true);
});

// --- noteAndLangTogether -----------------------------------------------------

test('noteAndLangTogether: both present or both absent', () => {
  assert.equal(noteAndLangTogether({}), true);
  assert.equal(noteAndLangTogether({ note: 'x', noteLang: 'en' }), true);
  assert.equal(noteAndLangTogether({ note: 'x' }), false);
  assert.equal(noteAndLangTogether({ noteLang: 'en' }), false);
});

// --- nextFeedbackStatus (never ACCEPTED — L3b.2's first rule) ---------------

test('nextFeedbackStatus: ADDRESSED and DECLINED map straight across; CARRIED_FORWARD changes nothing', () => {
  assert.equal(nextFeedbackStatus('ADDRESSED'), 'ADDRESSED');
  assert.equal(nextFeedbackStatus('DECLINED'), 'DECLINED');
  assert.equal(nextFeedbackStatus('CARRIED_FORWARD'), null);
});

// --- nextBuildNumber (project-wide, monotonic, Latin) -----------------------

test('nextBuildNumber: 1 for a project with no builds yet, max+1 otherwise', () => {
  assert.equal(nextBuildNumber(null), 1);
  assert.equal(nextBuildNumber(4), 5);
});
