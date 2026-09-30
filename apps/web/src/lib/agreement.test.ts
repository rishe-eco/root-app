import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCOPE_KIND_ORDER, groupScopeByKind, isPaymentScheduleArticle } from './agreement.js';
import { instantDate } from './format.js';

/**
 * The agreement's web-side rules (journeys build plan J7): which article the
 * payment plan renders under, and how Appendix 1 is grouped. The API decides
 * everything else; these are the two arrangements the document component makes.
 */

test('isPaymentScheduleArticle: article 5, Payment Schedule — by number and English title together', () => {
  assert.equal(isPaymentScheduleArticle(5, 'Payment Schedule'), true);
  assert.equal(isPaymentScheduleArticle(4, 'Payment Schedule'), false);
  assert.equal(isPaymentScheduleArticle(5, 'Fees'), false);
});

test('isPaymentScheduleArticle is the API’s rule, character for character (apps/web cannot import from apps/api)', () => {
  const rule = "return number === 5 && titleEn === 'Payment Schedule';";
  const api = readFileSync(fileURLToPath(new URL('../../../api/src/lib/templates.ts', import.meta.url)), 'utf8');
  const web = readFileSync(fileURLToPath(new URL('./agreement.ts', import.meta.url)), 'utf8');
  assert.ok(api.includes(rule));
  assert.ok(web.includes(rule));
});

test('groupScopeByKind: pages, features, deliverables, extras — in that order, each in the order the API froze', () => {
  const items = [
    { key: 'e', kind: 'EXTRA' as const },
    { key: 'f1', kind: 'FEATURE' as const },
    { key: 'p1', kind: 'PAGE' as const },
    { key: 'd1', kind: 'DELIVERABLE' as const },
    { key: 'p2', kind: 'PAGE' as const },
  ];
  assert.deepEqual(
    groupScopeByKind(items).map((g) => [g.kind, g.items.map((i) => i.key)]),
    [['PAGE', ['p1', 'p2']], ['FEATURE', ['f1']], ['DELIVERABLE', ['d1']], ['EXTRA', ['e']]],
  );
  assert.deepEqual([...SCOPE_KIND_ORDER], ['PAGE', 'FEATURE', 'DELIVERABLE', 'EXTRA']);
});

test('groupScopeByKind: a format-1 appendix (no kinds) is one flat list, and an empty one is no groups at all', () => {
  const flat = [{ key: 'a', kind: null }, { key: 'b' }];
  assert.deepEqual(groupScopeByKind(flat).map((g) => [g.kind, g.items.length]), [[null, 2]]);
  assert.deepEqual(groupScopeByKind([]), []);
  // A mix (should not happen) keeps the kinded groups and puts the rest last rather than guessing.
  assert.deepEqual(
    groupScopeByKind([{ key: 'x', kind: null }, { key: 'y', kind: 'PAGE' as const }]).map((g) => g.kind),
    ['PAGE', null],
  );
});

test('instantDate: the day an instant fell on, in the reader’s locale — Jalali for Persian, and never “Invalid Date”', () => {
  const at = '2026-10-04T09:30:00.000Z';
  assert.match(instantDate(at, 'en'), /2026/);
  assert.ok(!/Invalid/.test(instantDate(at, 'en')));
  // fa-IR is the Persian calendar and the Persian digits: no Latin year 2026 in it.
  assert.ok(/[۰-۹]/.test(instantDate(at, 'fa')));
  assert.ok(!/2026/.test(instantDate(at, 'fa')));
});
