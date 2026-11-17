import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boardRowIsComplete,
  changesLockedFields,
  compareBoardRows,
  isOverdue,
  missingHandoverTypes,
  onCustomerBoard,
  orderHandover,
  verificationRequiresNote,
} from './dependency.js';

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

// --- DX3a: undated, undecided and not-needed rows ---------------------------------

test('isOverdue (DX3a): a row with no date is never overdue, nor one nobody needs, nor one nobody owns yet', () => {
  assert.equal(isOverdue({ dueAt: null, verifiedAt: null }, NOW), false);
  assert.equal(isOverdue({ dueAt: YESTERDAY, verifiedAt: null, notNeeded: true }, NOW), false);
  assert.equal(isOverdue({ dueAt: YESTERDAY, verifiedAt: null, side: null }, NOW), false);
  assert.equal(isOverdue({ dueAt: YESTERDAY, verifiedAt: null, side: 'ROOT', notNeeded: false }, NOW), true);
});

test('onCustomerBoard: hides the not-needed and the undecided; Requirements still lists both', () => {
  assert.equal(onCustomerBoard({ notNeeded: false, side: 'CUSTOMER' }), true);
  assert.equal(onCustomerBoard({ notNeeded: false, side: 'ROOT' }), true);
  assert.equal(onCustomerBoard({ notNeeded: true, side: 'CUSTOMER' }), false);
  assert.equal(onCustomerBoard({ notNeeded: false, side: null }), false);
});

test('compareBoardRows: soonest first, the undated last, then by title', () => {
  const rows = [
    { id: 'a', titleEn: 'B', dueAt: null },
    { id: 'b', titleEn: 'A', dueAt: TOMORROW },
    { id: 'c', titleEn: 'A', dueAt: null },
    { id: 'd', titleEn: 'Z', dueAt: YESTERDAY },
  ];
  assert.deepEqual([...rows].sort(compareBoardRows).map((r) => r.id), ['d', 'b', 'c', 'a']);
});

test('missingHandoverTypes: only the active items the project does not hold yet', () => {
  const types = [
    { key: 'domain', active: true },
    { key: 'host', active: true },
    { key: 'sms', active: false },
    { key: 'content', active: true },
  ];
  assert.deepEqual(missingHandoverTypes(types, new Set(['host'])).map((t) => t.key), ['domain', 'content']);
  assert.deepEqual(missingHandoverTypes(types, new Set(['domain', 'host', 'content'])), []);
});

test('orderHandover: by the default list’s position, then title; rows with no type follow, by title', () => {
  const position = new Map([['domain', 0], ['host', 1], ['content', 2]]);
  const row = (briefKey: string | null, titleEn: string) => ({ briefKey, titleEn, titleFa: titleEn });
  const rows = [row(null, 'Zed'), row('content', 'C'), row('gateway', 'Gateway'), row('domain', 'D'), row(null, 'Alpha'), row('host', 'H')];
  assert.deepEqual(orderHandover(rows, position).map((r) => r.titleEn), ['D', 'H', 'C', 'Alpha', 'Gateway', 'Zed']);
  // Reordering the list on the desk reorders the agreement the same way.
  assert.deepEqual(orderHandover(rows, new Map([['content', 0], ['host', 1], ['domain', 2]])).slice(0, 3).map((r) => r.titleEn), ['C', 'H', 'D']);
});

test('changesLockedFields: a save that repeats what the row says is not a change; any real change is', () => {
  const row = { side: 'ROOT', dueAt: YESTERDAY, notNeeded: false, titleFa: 'ا', titleEn: 'A' };
  assert.equal(changesLockedFields(row, {}), false);
  assert.equal(changesLockedFields(row, { side: 'ROOT', dueAt: new Date(YESTERDAY), notNeeded: false, titleFa: 'ا', titleEn: 'A' }), false);
  assert.equal(changesLockedFields(row, { side: 'CUSTOMER' }), true);
  assert.equal(changesLockedFields(row, { side: null }), true);
  assert.equal(changesLockedFields(row, { dueAt: TOMORROW }), true);
  assert.equal(changesLockedFields(row, { dueAt: null }), true);
  assert.equal(changesLockedFields(row, { notNeeded: true }), true);
  assert.equal(changesLockedFields(row, { titleEn: 'B' }), true);
  assert.equal(changesLockedFields({ ...row, dueAt: null }, { dueAt: null }), false);
});

test('boardRowIsComplete: a board-only row needs both a side and a date', () => {
  assert.equal(boardRowIsComplete({ side: 'ROOT', dueAt: NOW }), true);
  assert.equal(boardRowIsComplete({ side: null, dueAt: NOW }), false);
  assert.equal(boardRowIsComplete({ side: 'ROOT', dueAt: null }), false);
});
