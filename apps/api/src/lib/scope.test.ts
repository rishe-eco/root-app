import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GraphQLError } from 'graphql';
import {
  agreedScopeSnapshot,
  agreedScopeSnapshotFor,
  assertCanConfirmTradeAsRoot,
  assertCanExecuteTrade,
  isAgreedOrBeyond,
  reorderTargetIndex,
  type ScopeItemLike,
} from './scope.js';

/** The code an error carries, which is what the client actually branches on
 *  (house rule 12) — matching gate.test.ts's own helper rather than matching
 *  on message text, which is English prose and not the interface. */
const codeOf = (fn: () => void): string | undefined => {
  try {
    fn();
  } catch (err) {
    return (err as GraphQLError).extensions?.code as string;
  }
  return undefined;
};

const item = (key: string, status: ScopeItemLike['status'], position: number): ScopeItemLike => ({
  key,
  labelFa: `ب-${key}`,
  labelEn: `l-${key}`,
  status,
  position,
});

test('isAgreedOrBeyond is true for agreed and everything after it in the lifecycle', () => {
  assert.equal(isAgreedOrBeyond('AGREED'), true);
  assert.equal(isAgreedOrBeyond('IN_BUILD'), true);
  assert.equal(isAgreedOrBeyond('IN_DEMO'), true);
  assert.equal(isAgreedOrBeyond('ACCEPTED'), true);
});

test('isAgreedOrBeyond is false for proposed, declined and traded', () => {
  assert.equal(isAgreedOrBeyond('PROPOSED'), false);
  assert.equal(isAgreedOrBeyond('DECLINED'), false);
  assert.equal(isAgreedOrBeyond('TRADED'), false);
});

test('agreedScopeSnapshot keeps only agreed-or-beyond items, in position order', () => {
  const items = [
    item('c', 'AGREED', 2),
    item('a', 'PROPOSED', 0),
    item('b', 'ACCEPTED', 1),
    item('d', 'DECLINED', 3),
  ];
  assert.deepEqual(agreedScopeSnapshot(items), [
    { key: 'b', labelFa: 'ب-b', labelEn: 'l-b' },
    { key: 'c', labelFa: 'ب-c', labelEn: 'l-c' },
  ]);
});

test('agreedScopeSnapshot of an empty or all-proposed registry is empty — the safe default for every pre-L1 snapshot', () => {
  assert.deepEqual(agreedScopeSnapshot([]), []);
  assert.deepEqual(agreedScopeSnapshot([item('a', 'PROPOSED', 0)]), []);
});

test('agreedScopeSnapshot never includes status — it is a frozen label view, not a live row', () => {
  const [row] = agreedScopeSnapshot([item('a', 'AGREED', 0)]);
  assert.deepEqual(Object.keys(row).sort(), ['key', 'labelEn', 'labelFa']);
});

test('reorderTargetIndex UP/DOWN finds the neighbour, and null at either end', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(reorderTargetIndex(rows, 'b', 'UP'), 0);
  assert.equal(reorderTargetIndex(rows, 'b', 'DOWN'), 2);
  assert.equal(reorderTargetIndex(rows, 'a', 'UP'), null);
  assert.equal(reorderTargetIndex(rows, 'c', 'DOWN'), null);
});

test('reorderTargetIndex is null for an id not in the list', () => {
  assert.equal(reorderTargetIndex([{ id: 'a' }], 'z', 'UP'), null);
});

test('assertCanConfirmTradeAsRoot refuses a second confirmation', () => {
  assert.equal(codeOf(() => assertCanConfirmTradeAsRoot({ rootConfirmedAt: new Date() })), 'ALREADY_CONFIRMED');
  assert.doesNotThrow(() => assertCanConfirmTradeAsRoot({ rootConfirmedAt: null }));
});

test('assertCanExecuteTrade requires both confirmations', () => {
  assert.equal(
    codeOf(() => assertCanExecuteTrade({ rootConfirmedAt: new Date(), customerConfirmedAt: null, executedAt: null })),
    'TRADE_NOT_CONFIRMED',
  );
  assert.equal(
    codeOf(() => assertCanExecuteTrade({ rootConfirmedAt: null, customerConfirmedAt: new Date(), executedAt: null })),
    'TRADE_NOT_CONFIRMED',
  );
  assert.doesNotThrow(() =>
    assertCanExecuteTrade({ rootConfirmedAt: new Date(), customerConfirmedAt: new Date(), executedAt: null }),
  );
});

test('assertCanExecuteTrade refuses an already-executed trade', () => {
  assert.equal(
    codeOf(() =>
      assertCanExecuteTrade({
        rootConfirmedAt: new Date(),
        customerConfirmedAt: new Date(),
        executedAt: new Date(),
      }),
    ),
    'ALREADY_EXECUTED',
  );
});

test('agreedScopeSnapshotFor (J7): format 2’s appendix — agreed items with their kind, this contract’s own, and the project’s extras', () => {
  const item = (key: string, over: Partial<ScopeItemLike> = {}): ScopeItemLike => ({
    key,
    labelFa: key + '-fa',
    labelEn: key + '-en',
    status: 'AGREED',
    position: 0,
    kind: 'PAGE',
    contractId: 'c1',
    ...over,
  });
  const items = [
    item('c', { position: 2, kind: 'FEATURE' }),
    item('a', { position: 0 }),
    item('sibling', { position: 1, contractId: 'c2' }),
    item('declined', { position: 3, status: 'DECLINED' }),
    item('extra', { position: 4, kind: 'EXTRA', contractId: 'c2' }),
    item('proposed', { position: 5, status: 'PROPOSED' }),
    item('traded', { position: 6, status: 'TRADED' }),
    item('orphan', { position: 7, contractId: null }),
  ];
  assert.deepEqual(
    agreedScopeSnapshotFor('c1', items).map((i) => [i.key, i.kind]),
    [['a', 'PAGE'], ['c', 'FEATURE'], ['extra', 'EXTRA']],
    'registry order; a sibling contract’s item, an unagreed one and an orphan are not in this contract’s agreement; an extra is',
  );
  // Format 1’s function is untouched: the whole project’s agreed set, no kind, as before.
  assert.deepEqual(
    agreedScopeSnapshot(items).map((i) => i.key),
    ['a', 'sibling', 'c', 'extra', 'orphan'],
  );
  assert.ok(agreedScopeSnapshot(items).every((i) => !('kind' in i)));
});
