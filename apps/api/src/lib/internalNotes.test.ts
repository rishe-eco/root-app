import test from 'node:test';
import assert from 'node:assert/strict';
import { INTERNAL_NOTE_MAX, checkInternalNote } from './internalNotes.js';

test('checkInternalNote: empty and whitespace are refused with the code every thread uses; over-long is TOO_LONG', () => {
  assert.equal(checkInternalNote(''), 'EMPTY_COMMENT');
  assert.equal(checkInternalNote('   \n\t '), 'EMPTY_COMMENT');
  assert.equal(checkInternalNote('Call the customer on Sunday.'), null);
  assert.equal(checkInternalNote('x'.repeat(INTERNAL_NOTE_MAX)), null);
  assert.equal(checkInternalNote('x'.repeat(INTERNAL_NOTE_MAX + 1)), 'TOO_LONG');
  // The limit is on the text as stored, so padding cannot push a real note over it.
  assert.equal(checkInternalNote(`  ${'x'.repeat(INTERNAL_NOTE_MAX)}  `), null);
});
