import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOverdue, verificationRequiresNote } from './dependency.js';

const NOW = new Date('2026-09-21T12:00:00Z');
const YESTERDAY = new Date('2026-09-20T12:00:00Z');
const TOMORROW = new Date('2026-09-22T12:00:00Z');

// --- isOverdue (derived, never stored — F5's own discipline) ---------------

test('isOverdue: past due and unverified is overdue', () => {
  assert.equal(isOverdue({ dueAt: YESTERDAY, verifiedAt: null }, NOW), true);
});

test('isOverdue: not yet due is never overdue, verified or not', () => {
  assert.equal(isOverdue({ dueAt: TOMORROW, verifiedAt: null }, NOW), false);
});

test('isOverdue: verified is never overdue, however late the verification came', () => {
  assert.equal(isOverdue({ dueAt: YESTERDAY, verifiedAt: NOW }, NOW), false);
});

// --- verificationRequiresNote (the banked trap: "what was done") -----------

test('verificationRequiresNote: a blank or whitespace-only note is not enough', () => {
  assert.equal(verificationRequiresNote({ note: null }), false);
  assert.equal(verificationRequiresNote({ note: undefined }), false);
  assert.equal(verificationRequiresNote({ note: '   ' }), false);
});

test('verificationRequiresNote: a real note passes — "we deployed a test file to the host"', () => {
  assert.equal(verificationRequiresNote({ note: 'we deployed a test file to the host' }), true);
});
