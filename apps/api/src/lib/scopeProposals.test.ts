import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PROPOSAL_TEXT,
  applyDecision,
  checkDecision,
  checkProposalText,
  checkScopeKey,
  hasUndecidedProposalFor,
  isProposableKind,
  isProposalLang,
  nextCustomKey,
  removable,
  restorable,
  scopeConfirmed,
  scopeSeeded,
  scopeStepDone,
  seedRows,
} from './scopeProposals.js';
import { scopeKindForKey } from './templates.js';

/**
 * Journeys build plan J5 — step 2a's rules as tables: what "confirmed" means,
 * what "seeded" means (per contract), which items a customer may propose
 * against, what a decision writes, and the keys. The database's own rules (the
 * two CHECKs) are proven by direct insert in `j5.test.ts`; here the migration is
 * read as text to make sure the SQL, the SDL and the schema still agree.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const decided = { decidedAt: new Date('2026-09-30T00:00:00Z') };
const undecided = { decidedAt: null };

test('scopeConfirmed: no proposal left undecided — true of a contract that never had one', () => {
  assert.equal(scopeConfirmed([]), true);
  assert.equal(scopeConfirmed([decided, decided]), true);
  assert.equal(scopeConfirmed([decided, undecided]), false);
  assert.equal(scopeConfirmed([undecided]), false);
});

test('scopeSeeded is per contract, and the completeness checklist never counts', () => {
  const items = [
    { kind: 'EXTRA', contractId: 'a' },
    { kind: 'EXTRA', contractId: 'b' },
    { kind: 'PAGE', contractId: 'a' },
    { kind: 'FEATURE', contractId: null }, // a trade's incoming item: nobody has agreed it
  ];
  assert.equal(scopeSeeded(items, 'a'), true);
  assert.equal(scopeSeeded(items, 'b'), false, 'a second contract on the project has no scope of its own yet');
  assert.equal(scopeSeeded(items, 'c'), false);
  assert.equal(scopeSeeded([], 'a'), false);
});

test('scopeStepDone needs both: a scope of its own and nothing undecided', () => {
  const items = [{ kind: 'PAGE', contractId: 'a' }];
  assert.equal(scopeStepDone({ items, proposals: [], contractId: 'a' }), true);
  assert.equal(scopeStepDone({ items, proposals: [decided], contractId: 'a' }), true);
  assert.equal(scopeStepDone({ items, proposals: [undecided], contractId: 'a' }), false);
  assert.equal(scopeStepDone({ items: [], proposals: [], contractId: 'a' }), false, 'confirmed is not seeded');
  assert.equal(scopeStepDone({ items, proposals: [], contractId: 'b' }), false);
});

test('removable is an agreed page/feature/deliverable only; restorable a declined one; never an extra', () => {
  const cases: Array<[string, string, boolean, boolean]> = [
    ['PAGE', 'AGREED', true, false],
    ['FEATURE', 'AGREED', true, false],
    ['DELIVERABLE', 'DECLINED', false, true],
    ['PAGE', 'PROPOSED', false, false],
    ['PAGE', 'TRADED', false, false],
    ['PAGE', 'IN_BUILD', false, false],
    ['PAGE', 'ACCEPTED', false, false],
    ['EXTRA', 'AGREED', false, false],
    ['EXTRA', 'DECLINED', false, false],
  ];
  for (const [kind, status, rm, rs] of cases) {
    const item = { kind, status: status as never };
    assert.equal(removable(item), rm, `${kind}/${status} removable`);
    assert.equal(restorable(item), rs, `${kind}/${status} restorable`);
  }
});

test('an item with a proposal already waiting is not proposed against again', () => {
  const proposals = [
    { scopeItemId: 'i1', decidedAt: null },
    { scopeItemId: 'i2', decidedAt: new Date() },
    { scopeItemId: null, decidedAt: null }, // an ADD
  ];
  assert.equal(hasUndecidedProposalFor(proposals, 'i1'), true);
  assert.equal(hasUndecidedProposalFor(proposals, 'i2'), false, 'a decided one is history');
  assert.equal(hasUndecidedProposalFor(proposals, 'i3'), false);
});

test('proposal text and language: trimmed, bounded, fa or en', () => {
  assert.equal(checkProposalText('یک صفحه‌ی وبلاگ'), null);
  assert.equal(checkProposalText('   '), 'EMPTY_PROPOSAL');
  assert.equal(checkProposalText(''), 'EMPTY_PROPOSAL');
  assert.equal(checkProposalText('x'.repeat(MAX_PROPOSAL_TEXT)), null);
  assert.equal(checkProposalText('x'.repeat(MAX_PROPOSAL_TEXT + 1)), 'PROPOSAL_TOO_LONG');
  assert.equal(checkProposalText(`  ${'x'.repeat(MAX_PROPOSAL_TEXT)}  `), null, 'the bound is on the trimmed text');
  assert.equal(isProposalLang('fa'), true);
  assert.equal(isProposalLang('en'), true);
  assert.equal(isProposalLang('de'), false);
  assert.equal(isProposableKind('PAGE'), true);
  assert.equal(isProposableKind('EXTRA'), false, 'the checklist is step 1’s');
  assert.equal(isProposableKind('page'), false);
});

test('custom keys: the highest custom.<n> plus one — Latin, whatever the words were', () => {
  assert.equal(nextCustomKey([]), 'custom.1');
  assert.equal(nextCustomKey(['home', 'about']), 'custom.1');
  assert.equal(nextCustomKey(['custom.1', 'custom.2']), 'custom.3');
  // A gap is not reused: `custom.2` may be remembered as something else.
  assert.equal(nextCustomKey(['custom.1', 'custom.3']), 'custom.4');
  assert.equal(nextCustomKey(['custom.9', 'custom.10']), 'custom.11', 'numeric, not lexicographic');
  assert.equal(nextCustomKey(['custom.x', 'customs.5', 'custom.5.2']), 'custom.1', 'only the exact shape counts');
  assert.equal(nextCustomKey(new Set(['custom.4'])), 'custom.5');
});

test('a typed key: Latin words joined by dots or hyphens, never inside checklist.*', () => {
  for (const ok of ['custom.7', 'wishlist', 'blog-archive', 'a1', 'a.b-c']) assert.equal(checkScopeKey(ok), null, ok);
  for (const bad of ['', 'Custom', 'a b', 'a_b', '.a', 'a.', 'a..b', 'checklist.auth', 'وبلاگ', 'a'.repeat(61)]) {
    assert.equal(checkScopeKey(bad), 'INVALID_KEY', bad);
  }
});

test('checkDecision: a decline needs its reason; an accepted ADD needs both labels; a remove/restore needs neither', () => {
  const add = { decision: 'ACCEPTED' as const, labelFa: 'وبلاگ', labelEn: 'Blog' };
  assert.equal(checkDecision('ADD', add), null);
  assert.equal(checkDecision('ADD', { ...add, labelEn: '  ' }), 'LABEL_REQUIRED');
  assert.equal(checkDecision('ADD', { ...add, labelFa: null }), 'LABEL_REQUIRED');
  assert.equal(checkDecision('ADD', { ...add, key: 'Bad Key' }), 'INVALID_KEY');
  assert.equal(checkDecision('ADD', { ...add, key: '' }), null, 'an empty key is "generate one"');
  assert.equal(checkDecision('ADD', { ...add, kind: 'EXTRA' }), 'INVALID_KIND');
  assert.equal(checkDecision('ADD', { ...add, kind: 'FEATURE' }), null);

  assert.equal(checkDecision('REMOVE', { decision: 'ACCEPTED' }), null);
  assert.equal(checkDecision('RESTORE', { decision: 'ACCEPTED' }), null);

  for (const kind of ['ADD', 'REMOVE', 'RESTORE'] as const) {
    assert.equal(checkDecision(kind, { decision: 'DECLINED' }), 'REASON_REQUIRED', kind);
    assert.equal(checkDecision(kind, { decision: 'DECLINED', declineReason: '   ' }), 'REASON_REQUIRED', kind);
    assert.equal(checkDecision(kind, { decision: 'DECLINED', declineReason: 'خارج از دامنه' }), null, kind);
    assert.equal(checkDecision(kind, { decision: 'DECLINED', declineReason: 'x'.repeat(1001) }), 'REASON_TOO_LONG', kind);
  }
});

test('applyDecision: ADD creates a bilingual item with a Latin key and the customer’s words as its origin', () => {
  const proposal = { kind: 'ADD' as const, text: '  یک صفحه‌ی وبلاگ  ', scopeItemId: null, requestedKind: 'PAGE' };
  const { item } = applyDecision(
    proposal,
    { decision: 'ACCEPTED', labelFa: ' وبلاگ ', labelEn: ' Blog ' },
    ['home', 'custom.1'],
  );
  assert.deepEqual(item, {
    action: 'create',
    key: 'custom.2',
    kind: 'PAGE',
    labelFa: 'وبلاگ',
    labelEn: 'Blog',
    originNote: 'یک صفحه‌ی وبلاگ',
  });
});

test('applyDecision: sales may type the key and correct the kind', () => {
  const proposal = { kind: 'ADD' as const, text: 'x', scopeItemId: null, requestedKind: 'PAGE' };
  const { item } = applyDecision(
    proposal,
    { decision: 'ACCEPTED', labelFa: 'ا', labelEn: 'A', key: ' wishlist ', kind: 'FEATURE' },
    [],
  );
  assert.equal(item.action, 'create');
  assert.equal(item.action === 'create' && item.key, 'wishlist');
  assert.equal(item.action === 'create' && item.kind, 'FEATURE');
});

test('applyDecision: REMOVE declines the item with the proposal’s text; RESTORE agrees it; a decline changes nothing', () => {
  const remove = { kind: 'REMOVE' as const, text: ' we do not sell ', scopeItemId: 'i1', requestedKind: null };
  assert.deepEqual(applyDecision(remove, { decision: 'ACCEPTED' }, []).item, {
    action: 'decline',
    itemId: 'i1',
    declinedReason: 'we do not sell',
  });
  const restore = { kind: 'RESTORE' as const, text: 'we changed our minds', scopeItemId: 'i2', requestedKind: null };
  assert.deepEqual(applyDecision(restore, { decision: 'ACCEPTED' }, []).item, { action: 'agree', itemId: 'i2' });
  for (const proposal of [remove, restore, { kind: 'ADD' as const, text: 'x', scopeItemId: null, requestedKind: 'PAGE' }]) {
    assert.deepEqual(applyDecision(proposal, { decision: 'DECLINED', declineReason: 'no' }, []).item, { action: 'none' });
  }
});

test('applyDecision: a REMOVE that names no item is a bug in the row, not a decision', () => {
  assert.throws(
    () => applyDecision({ kind: 'REMOVE', text: 'x', scopeItemId: null, requestedKind: null }, { decision: 'ACCEPTED' }, []),
    /names no item/,
  );
});

test('seedRows: keys keep their own kind, and a taken key takes the next free suffix', () => {
  const template = [
    { key: 'home', labelFa: 'صفحه', labelEn: 'Home' },
    { key: 'about', labelFa: 'درباره', labelEn: 'About' },
    { key: 'checkout', kind: 'FEATURE', labelFa: 'پرداخت', labelEn: 'Checkout' },
  ];
  const first = seedRows(template, [], 10);
  assert.deepEqual(first.map((r) => [r.key, r.kind, r.position]), [
    ['home', 'PAGE', 10],
    ['about', 'PAGE', 11],
    ['checkout', 'FEATURE', 12],
  ]);
  // A second contract on the same project: the keys are taken, its own rows get suffixes, the kind is still the word's.
  const second = seedRows(template, first.map((r) => r.key), 13);
  assert.deepEqual(second.map((r) => r.key), ['home.2', 'about.2', 'checkout.2']);
  assert.equal(second[0].kind, scopeKindForKey('home'));
  assert.equal(second[0].kind, 'PAGE');
  // ...and a third finds the next.
  const third = seedRows(template, [...first, ...second].map((r) => r.key), 16);
  assert.deepEqual(third.map((r) => r.key), ['home.3', 'about.3', 'checkout.3']);
  // A suffix that is taken already is skipped.
  assert.deepEqual(seedRows([{ key: 'home', labelFa: 'ا', labelEn: 'A' }], ['home', 'home.2'], 0).map((r) => r.key), ['home.3']);
  // Duplicate keys in the template itself never collide either.
  assert.deepEqual(
    seedRows([{ key: 'x', labelFa: 'ا', labelEn: 'A' }, { key: 'x', labelFa: 'ا', labelEn: 'A' }], [], 0).map((r) => r.key),
    ['x', 'x.2'],
  );
});

test('the enums agree across the schema and the SDL', () => {
  for (const name of ['ScopeProposalKind', 'ScopeProposalDecision']) {
    const values = (source: string) => {
      const m = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(source);
      assert.ok(m, `no ${name} in a source`);
      return m[1].split(/\s+/).filter(Boolean);
    };
    assert.deepEqual(values(read('../graphql/typeDefs.ts')), values(read('../../prisma/schema.prisma')), name);
  }
});

test('the J5 migration carries both hand-written CHECKs, and the reason one refuses whitespace', () => {
  const sql = read('../../prisma/migrations/20260930120000_j5_scope_proposals/migration.sql');
  assert.match(sql, /ADD CONSTRAINT "ScopeProposal_declined_has_reason" CHECK \(/);
  assert.match(sql, /"decision" <> 'DECLINED' OR \("declineReason" IS NOT NULL AND btrim\("declineReason"\) <> ''\)/);
  assert.match(sql, /ADD CONSTRAINT "ScopeProposal_target_required" CHECK \(\s*"kind" = 'ADD' OR "scopeItemId" IS NOT NULL/);
  // House rule 11: never array_length in a CHECK.
  assert.ok(!/array_length/.test(sql));
});
