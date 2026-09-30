import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Contract, DraftNote, ScopeItem, ScopeProposal, ScopeTrade } from './queries.js';
import {
  PROPOSABLE_KINDS,
  groupByKind,
  hasNoteOnCurrent,
  isInScope,
  isLeftOut,
  newestFirst,
  notesByArticle,
  openTrades,
  ownItems,
  tradeState,
  undecidedProposals,
  waitingProposalFor,
} from './scopeStep.js';

/**
 * Steps 2a and 2b's arrangement rules (journeys build plan J5, J6): what a
 * step panel draws, in what groups, and where a note belongs when article
 * numbers have shifted. The rules themselves are the API's.
 */

const item = (over: Partial<ScopeItem>): ScopeItem => ({
  id: 'i',
  key: 'k',
  labelFa: 'ا',
  labelEn: 'A',
  position: 0,
  kind: 'PAGE',
  contractId: 'c1',
  checked: false,
  status: 'AGREED',
  temporary: false,
  outOfScope: false,
  adminWork: false,
  decidedAt: null,
  decidedNote: null,
  declinedReason: null,
  originNote: null,
  originRound: null,
  phaseId: null,
  ...over,
});

const proposal = (over: Partial<ScopeProposal>): ScopeProposal => ({
  id: 'p',
  kind: 'ADD',
  scopeItem: null,
  requestedKind: 'PAGE',
  text: 'x',
  lang: 'fa',
  proposedBy: { id: 'u', name: 'U' },
  createdAt: '2026-09-30T10:00:00.000Z',
  decidedAt: null,
  decision: null,
  declineReason: null,
  createdItem: null,
  ...over,
});

test('the kinds a customer may propose are exactly the API’s template kinds — never the checklist’s EXTRA', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../api/src/lib/templates.ts', import.meta.url)), 'utf8');
  const declared = /TEMPLATE_KINDS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  assert.deepEqual([...declared.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]), [...PROPOSABLE_KINDS]);
});

test('ownItems: this contract’s pages, features and deliverables in registry order — not another contract’s, not the checklist', () => {
  const contract = {
    id: 'c1',
    scopeItems: [
      item({ id: 'b', position: 2, kind: 'FEATURE' }),
      item({ id: 'a', position: 1 }),
      item({ id: 'x', position: 0, kind: 'EXTRA' }),
      item({ id: 'o', position: 3, contractId: 'c2' }),
      item({ id: 'n', position: 4, contractId: null }),
    ],
  } as Pick<Contract, 'id' | 'scopeItems'>;
  assert.deepEqual(ownItems(contract).map((i) => i.id), ['a', 'b']);
});

test('in scope, and left out: a trade’s incoming half is neither', () => {
  for (const status of ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'] as const) {
    assert.deepEqual([isInScope({ status }), isLeftOut({ status })], [true, false], status);
  }
  for (const status of ['DECLINED', 'TRADED'] as const) {
    assert.deepEqual([isInScope({ status }), isLeftOut({ status })], [false, true], status);
  }
  assert.deepEqual([isInScope({ status: 'PROPOSED' }), isLeftOut({ status: 'PROPOSED' })], [false, false]);
});

test('groupByKind: pages, then features, then deliverables, and no empty group', () => {
  const groups = groupByKind([
    item({ id: 'd', kind: 'DELIVERABLE' }),
    item({ id: 'p1', kind: 'PAGE' }),
    item({ id: 'p2', kind: 'PAGE' }),
  ]);
  assert.deepEqual(groups.map((g) => [g.kind, g.items.map((i) => i.id)]), [
    ['PAGE', ['p1', 'p2']],
    ['DELIVERABLE', ['d']],
  ]);
  assert.deepEqual(groupByKind([]), []);
});

test('proposals: the one waiting for an item, the undecided ones, newest first', () => {
  const ps = [
    proposal({ id: 'p1', scopeItem: { id: 'i1', key: 'k', labelFa: 'ا', labelEn: 'A', kind: 'PAGE', status: 'AGREED' }, createdAt: '2026-09-01T00:00:00Z' }),
    proposal({ id: 'p2', scopeItem: { id: 'i1', key: 'k', labelFa: 'ا', labelEn: 'A', kind: 'PAGE', status: 'AGREED' }, decidedAt: '2026-09-02T00:00:00Z', decision: 'DECLINED', declineReason: 'no', createdAt: '2026-08-01T00:00:00Z' }),
    proposal({ id: 'p3', createdAt: '2026-09-03T00:00:00Z' }),
  ];
  assert.equal(waitingProposalFor(ps, 'i1')?.id, 'p1', 'a decided one is history');
  assert.equal(waitingProposalFor(ps, 'i2'), null);
  assert.deepEqual(undecidedProposals(ps).map((p) => p.id), ['p1', 'p3']);
  assert.deepEqual(newestFirst(ps).map((p) => p.id), ['p3', 'p1', 'p2']);
});

test('trades: only the open ones whose outgoing item this contract agreed, and their state from the two confirmations', () => {
  const trade = (over: Partial<ScopeTrade> & { outContract?: string | null }): ScopeTrade =>
    ({
      id: 't',
      outItem: item({ id: 'out', contractId: over.outContract === undefined ? 'c1' : over.outContract }),
      inItem: item({ id: 'in', contractId: null }),
      proposedBy: { id: 'u', name: 'U' },
      proposedAt: '2026-09-01T00:00:00Z',
      rootConfirmedAt: null,
      customerConfirmedAt: null,
      executedAt: null,
      ...over,
    }) as ScopeTrade;
  const contract = {
    id: 'c1',
    project: {
      scopeTrades: [
        trade({ id: 'mine' }),
        trade({ id: 'done', executedAt: '2026-09-02T00:00:00Z' }),
        trade({ id: 'theirs', outContract: 'c2' }),
      ],
    },
  } as unknown as Pick<Contract, 'id' | 'project'>;
  assert.deepEqual(openTrades(contract).map((t) => t.id), ['mine']);
  assert.equal(tradeState({ rootConfirmedAt: null, customerConfirmedAt: null }), 'WAITING_ON_BOTH');
  assert.equal(tradeState({ rootConfirmedAt: 'x', customerConfirmedAt: null }), 'WAITING_ON_CUSTOMER');
  assert.equal(tradeState({ rootConfirmedAt: null, customerConfirmedAt: 'x' }), 'WAITING_ON_ROOT');
  assert.equal(tradeState({ rootConfirmedAt: 'x', customerConfirmedAt: 'x' }), 'READY');
});

const note = (over: Partial<DraftNote> & { id?: string }): DraftNote => ({
  item: { id: over.id ?? 'n' } as DraftNote['item'],
  revisionVersion: 1,
  onCurrentRevision: false,
  articleNumber: 3,
  currentArticleNumber: 3,
  articleChangedSince: false,
  articleGone: false,
  ...over,
});

test('notesByArticle: a note follows its article to the number it has now, and a gone article’s note is listed apart', () => {
  const articles = [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }];
  const { byArticle, orphans } = notesByArticle(articles, [
    note({ id: 'moved', articleNumber: 3, currentArticleNumber: 4 }),
    note({ id: 'same', articleNumber: 2, currentArticleNumber: 2 }),
    note({ id: 'gone', articleNumber: 3, currentArticleNumber: null, articleGone: true }),
    note({ id: 'alsoSame', articleNumber: 2, currentArticleNumber: 2, onCurrentRevision: true }),
    note({ id: 'whole', articleNumber: null, currentArticleNumber: null }),
  ]);
  assert.deepEqual(byArticle.get(4)!.map((n) => n.item.id), ['moved']);
  assert.deepEqual(byArticle.get(2)!.map((n) => n.item.id), ['same', 'alsoSame'], 'oldest first, as given');
  assert.deepEqual(byArticle.get(3), [], 'nothing takes the number a moved note left');
  assert.deepEqual(orphans.map((n) => n.item.id), ['gone', 'whole']);
  // A note that points at a number the current revision has no article for is an orphan too, never lost.
  assert.deepEqual(notesByArticle([{ number: 1 }], [note({ id: 'stray', currentArticleNumber: 9 })]).orphans.map((n) => n.item.id), ['stray']);
});

test('hasNoteOnCurrent: only a note on the revision being read stops the panel offering a blank one', () => {
  assert.equal(hasNoteOnCurrent(undefined), false);
  assert.equal(hasNoteOnCurrent([]), false);
  assert.equal(hasNoteOnCurrent([note({ onCurrentRevision: false })]), false);
  assert.equal(hasNoteOnCurrent([note({ onCurrentRevision: false }), note({ onCurrentRevision: true })]), true);
});
