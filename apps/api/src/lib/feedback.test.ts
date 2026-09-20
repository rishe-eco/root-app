import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInterception } from './feedback.js';

test('checkInterception: null target (a page, or a hand-authored line) never intercepts', () => {
  assert.deepEqual(checkInterception(null), { intercepted: false });
});

test('checkInterception: an ordinary agreed item never intercepts', () => {
  assert.deepEqual(checkInterception({ id: 's1', decidedAt: null, temporary: false }), { intercepted: false });
});

test('checkInterception: a decided item intercepts with reason DECIDED', () => {
  const result = checkInterception({ id: 's1', decidedAt: new Date('2026-01-01'), temporary: false });
  assert.deepEqual(result, { intercepted: true, reason: 'DECIDED', scopeItemId: 's1' });
});

test('checkInterception: a temporary item intercepts with reason TEMPORARY', () => {
  const result = checkInterception({ id: 's1', decidedAt: null, temporary: true });
  assert.deepEqual(result, { intercepted: true, reason: 'TEMPORARY', scopeItemId: 's1' });
});

test('checkInterception: decided wins when an item is somehow both', () => {
  const result = checkInterception({ id: 's1', decidedAt: new Date('2026-01-01'), temporary: true });
  assert.deepEqual(result, { intercepted: true, reason: 'DECIDED', scopeItemId: 's1' });
});
