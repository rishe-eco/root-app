import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveFrameLines, type ScopeItemForFrame } from './demoFrame.js';

const item = (over: Partial<ScopeItemForFrame> & { id: string }): ScopeItemForFrame => ({
  labelFa: `ب-${over.id}`,
  labelEn: `l-${over.id}`,
  status: 'AGREED',
  temporary: false,
  decidedAt: null,
  decidedNote: null,
  phaseId: null,
  ...over,
});

test('deriveFrameLines: an IN_DEMO item on this phase is NEW', () => {
  const items = [item({ id: 'a', phaseId: 'p1', status: 'IN_DEMO' })];
  const lines = deriveFrameLines('p1', items);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'NEW');
  assert.equal(lines[0].scopeItemId, 'a');
  assert.equal(lines[0].textFa, 'ب-a');
});

test('deriveFrameLines: an IN_BUILD item on this phase is KNOWN_MISSING', () => {
  const items = [item({ id: 'a', phaseId: 'p1', status: 'IN_BUILD' })];
  const lines = deriveFrameLines('p1', items);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['KNOWN_MISSING'],
  );
});

test('deriveFrameLines: IN_DEMO/IN_BUILD items on a different phase contribute nothing to NEW/KNOWN_MISSING', () => {
  const items = [item({ id: 'a', phaseId: 'p2', status: 'IN_DEMO' }), item({ id: 'b', phaseId: 'p2', status: 'IN_BUILD' })];
  assert.deepEqual(deriveFrameLines('p1', items), []);
});

test('deriveFrameLines: a temporary agreed item is TEMPORARY project-wide, regardless of phase', () => {
  const items = [item({ id: 'a', phaseId: 'p2', status: 'AGREED', temporary: true })];
  const lines = deriveFrameLines('p1', items);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['TEMPORARY'],
  );
});

test('deriveFrameLines: a temporary item not yet agreed (PROPOSED) is not surfaced', () => {
  const items = [item({ id: 'a', status: 'PROPOSED', temporary: true })];
  assert.deepEqual(deriveFrameLines('p1', items), []);
});

test('deriveFrameLines: a decided item is DECIDED project-wide, regardless of phase', () => {
  const items = [item({ id: 'a', phaseId: 'p2', decidedAt: new Date('2026-01-01') })];
  const lines = deriveFrameLines('p1', items);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ['DECIDED'],
  );
});

test('deriveFrameLines: one item can land in more than one bucket at once', () => {
  const items = [item({ id: 'a', phaseId: 'p1', status: 'IN_DEMO', temporary: true, decidedAt: new Date() })];
  const lines = deriveFrameLines('p1', items);
  assert.deepEqual(
    lines.map((l) => l.kind).sort(),
    ['DECIDED', 'NEW', 'TEMPORARY'].sort(),
  );
  assert.ok(lines.every((l) => l.scopeItemId === 'a'));
});

test('deriveFrameLines: declined and traded items never surface, even if flagged temporary or decided', () => {
  const items = [
    item({ id: 'a', status: 'DECLINED', temporary: true, decidedAt: new Date() }),
    item({ id: 'b', status: 'TRADED', temporary: true, decidedAt: new Date() }),
  ];
  assert.deepEqual(deriveFrameLines('p1', items), []);
});

test('deriveFrameLines: an empty registry produces an empty frame', () => {
  assert.deepEqual(deriveFrameLines('p1', []), []);
});
