import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Role } from '@prisma/client';
import {
  ATTENTION_KINDS,
  ATTENTION_SENTENCES,
  attentionFor,
  type AttentionInput,
  type AttentionItem,
} from './attention.js';
import { attentionVisibleTo } from './visibility.js';

/**
 * Journeys build plan J3 — the attention module as tables. Fixtures in, typed
 * items out; who may see which is `attentionVisibleTo`'s table below, and the
 * last tests read the locale files so a kind cannot ship without its sentence.
 */

const NOW = new Date('2026-09-29T12:00:00Z');
const day = (offset: number) => new Date(NOW.getTime() + offset * 24 * 60 * 60 * 1000);

const CUSTOMER = { id: 'cust', roles: ['CUSTOMER'] as Role[] };
const SALES = { id: 'sales', roles: ['SALES'] as Role[] };
const DESIGNER = { id: 'designer', roles: ['DESIGNER'] as Role[] };
const OTHER_CUSTOMER = { id: 'stranger', roles: ['CUSTOMER'] as Role[] };

const empty = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  contractId: 'c1',
  customerId: 'cust',
  now: NOW,
  pending: null,
  dependencies: [],
  addressed: [],
  ...over,
});

const summary = (items: AttentionItem[]) => items.map((i) => `${i.kind}/${i.variant}/${i.waitingOn}`);

test('nothing pending, nothing overdue: no items', () => {
  assert.deepEqual(attentionFor(empty(), SALES), []);
  assert.deepEqual(attentionFor(empty(), CUSTOMER), []);
});

test('the pending banner: a revised contract, a moved design and an amendment are three items, all the customer’s move', () => {
  const items = attentionFor(
    empty({
      pending: {
        contract: { fromVersion: 1, toVersion: 2, since: day(-3) },
        designChangeCount: 4,
        designSince: day(-2),
        amendment: { ordinal: 1, approved: false, since: day(-1) },
      },
    }),
    CUSTOMER,
  );
  assert.deepEqual(summary(items), [
    'DRAFT_TO_REVIEW/contract/CUSTOMER',
    'ROUND_PUBLISHED/default/CUSTOMER',
    'DRAFT_TO_REVIEW/amendmentApprove/CUSTOMER',
  ]);
  assert.deepEqual(items[0].params, { fromVersion: 1, toVersion: 2 });
  assert.deepEqual(items[1].params, { count: 4 });
  assert.deepEqual(items[2].params, { label: 'A1' });
  assert.ok(items.every((i) => i.role === null && i.phaseId === null && i.contractId === 'c1'));
});

test('an approved amendment waits for a signature, not an approval', () => {
  const items = attentionFor(
    empty({ pending: { contract: null, designChangeCount: 0, designSince: null, amendment: { ordinal: 2, approved: true, since: day(-1) } } }),
    CUSTOMER,
  );
  assert.deepEqual(summary(items), ['DRAFT_TO_REVIEW/amendmentSign/CUSTOMER']);
});

test('a design "change" count of zero is no item, even with a date', () => {
  const items = attentionFor(
    empty({ pending: { contract: null, designChangeCount: 0, designSince: day(-1), amendment: null } }),
    SALES,
  );
  assert.deepEqual(items, []);
});

test('overdue dependencies: only unverified, only past due, and the side decides who is waited on', () => {
  const dep = (id: string, side: 'CUSTOMER' | 'ROOT', dueOffset: number, verified = false) => ({
    id,
    side,
    titleFa: `الف ${id}`,
    titleEn: `Title ${id}`,
    dueAt: day(dueOffset),
    verifiedAt: verified ? day(dueOffset + 1) : null,
  });
  const items = attentionFor(
    empty({
      dependencies: [
        dep('late-customer', 'CUSTOMER', -5),
        dep('late-root', 'ROOT', -2),
        dep('not-yet', 'CUSTOMER', 3),
        dep('late-but-verified', 'CUSTOMER', -9, true),
      ],
    }),
    SALES,
  );
  assert.deepEqual(summary(items), ['COMMITMENT_OVERDUE/customer/CUSTOMER', 'COMMITMENT_OVERDUE/root/ROOT']);
  const [customerSide, rootSide] = items;
  assert.equal(customerSide.role, null);
  assert.equal(customerSide.internal, false);
  assert.equal(rootSide.role, 'SALES');
  assert.equal(rootSide.internal, true);
  assert.deepEqual(customerSide.since, day(-5));
  assert.deepEqual(customerSide.params, { dependencyId: 'late-customer', titleFa: 'الف late-customer', titleEn: 'Title late-customer' });
});

test('addressed demo items collapse to one line per phase, since the earliest publish', () => {
  const items = attentionFor(
    empty({
      addressed: [
        { id: 'f1', phaseId: 'p1', since: day(-2) },
        { id: 'f2', phaseId: 'p1', since: day(-5) },
        { id: 'f3', phaseId: 'p2', since: day(-1) },
      ],
    }),
    CUSTOMER,
  );
  assert.deepEqual(items.map((i) => [i.kind, i.phaseId, i.params, i.since]), [
    ['ANSWER_PUBLISHED', 'p1', { count: 2 }, day(-5)],
    ['ANSWER_PUBLISHED', 'p2', { count: 1 }, day(-1)],
  ]);
  assert.ok(items.every((i) => i.waitingOn === 'CUSTOMER'));
});

test('longest-waiting first; equal times fall back to the catalogue order, so the list is total', () => {
  const items = attentionFor(
    empty({
      pending: {
        contract: { fromVersion: 1, toVersion: 2, since: day(-1) },
        designChangeCount: 1,
        designSince: day(-1),
        amendment: null,
      },
      addressed: [{ id: 'f', phaseId: 'p1', since: day(-9) }],
      dependencies: [{ id: 'd', side: 'CUSTOMER', titleFa: 'ا', titleEn: 'a', dueAt: day(-4), verifiedAt: null }],
    }),
    CUSTOMER,
  );
  assert.deepEqual(items.map((i) => i.kind), [
    'ANSWER_PUBLISHED', // -9
    'COMMITMENT_OVERDUE', // -4
    'DRAFT_TO_REVIEW', // -1, catalogue index 1…
    'ROUND_PUBLISHED', // …before ROUND_PUBLISHED's 7
  ]);
});

// ---- who sees what: the visibility rule, as a table -----------------------------------

test('attentionVisibleTo: internal items are for contract readers, money items for money readers', () => {
  const contract = { customerId: 'cust' };
  const table: Array<{ who: string; viewer: { id: string; roles: Role[] }; internal: boolean; money: boolean; sees: boolean }> = [
    { who: 'customer, plain item', viewer: CUSTOMER, internal: false, money: false, sees: true },
    { who: 'customer, Root’s housekeeping', viewer: CUSTOMER, internal: true, money: false, sees: false },
    { who: 'customer, money about their own contract', viewer: CUSTOMER, internal: false, money: true, sees: true },
    { who: 'another customer, money', viewer: OTHER_CUSTOMER, internal: false, money: true, sees: false },
    { who: 'sales, housekeeping', viewer: SALES, internal: true, money: false, sees: true },
    { who: 'sales, money', viewer: SALES, internal: false, money: true, sees: true },
    { who: 'designer, plain item', viewer: DESIGNER, internal: false, money: false, sees: true },
    { who: 'designer, housekeeping', viewer: DESIGNER, internal: true, money: false, sees: true },
    { who: 'designer, money (PD-21)', viewer: DESIGNER, internal: false, money: true, sees: false },
  ];
  for (const row of table) {
    assert.equal(attentionVisibleTo(row.viewer, contract, row), row.sees, row.who);
  }
});

test('a customer never receives Root’s late commitment; sales does (the same input, two viewers)', () => {
  const input = empty({
    dependencies: [{ id: 'd', side: 'ROOT', titleFa: 'ا', titleEn: 'a', dueAt: day(-2), verifiedAt: null }],
  });
  assert.deepEqual(attentionFor(input, CUSTOMER), []);
  assert.deepEqual(summary(attentionFor(input, SALES)), ['COMMITMENT_OVERDUE/root/ROOT']);
});

// ---- the catalogue and its sentences ------------------------------------------------------

test('the catalogue is §6.3 whole: twenty distinct kinds, and the SDL enum lists exactly them', () => {
  assert.equal(new Set(ATTENTION_KINDS).size, 20);
  const sdl = readFileSync(new URL('../graphql/typeDefs.ts', import.meta.url), 'utf8');
  const block = /enum AttentionKind \{([^}]*)\}/.exec(sdl)?.[1] ?? '';
  const declared = block.split(/\s+/).filter(Boolean);
  assert.deepEqual(declared, [...ATTENTION_KINDS]);
});

function locale(lang: 'fa' | 'en'): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../../../web/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
}

const dig = (obj: unknown, path: string[]): unknown => path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

test('every shipped kind has its sentence for every audience that can see it, in both languages', () => {
  const shipped = Object.entries(ATTENTION_SENTENCES);
  assert.ok(shipped.length >= 4, 'J3 ships four kinds');
  for (const lang of ['fa', 'en'] as const) {
    const messages = locale(lang);
    for (const [kind, variants] of shipped) {
      for (const [variant, audiences] of Object.entries(variants)) {
        for (const audience of audiences) {
          const sentence = dig(messages, ['attention', kind, variant, audience]) ?? dig(messages, ['attention', kind, variant, `${audience}_other`]);
          assert.equal(typeof sentence, 'string', `${lang}: attention.${kind}.${variant}.${audience}`);
          assert.ok((sentence as string).trim().length > 0, `${lang}: attention.${kind}.${variant}.${audience} is empty`);
        }
      }
    }
  }
});

test('every item the module can emit names a sentence that exists in the table', () => {
  const emitted = attentionFor(
    empty({
      pending: {
        contract: { fromVersion: 1, toVersion: 2, since: day(-1) },
        designChangeCount: 2,
        designSince: day(-1),
        amendment: { ordinal: 1, approved: false, since: day(-1) },
      },
      dependencies: [
        { id: 'a', side: 'CUSTOMER', titleFa: 'ا', titleEn: 'a', dueAt: day(-1), verifiedAt: null },
        { id: 'b', side: 'ROOT', titleFa: 'ا', titleEn: 'a', dueAt: day(-1), verifiedAt: null },
      ],
      addressed: [{ id: 'f', phaseId: 'p', since: day(-1) }],
    }),
    SALES,
  );
  for (const item of emitted) {
    const audiences = ATTENTION_SENTENCES[item.kind]?.[item.variant];
    assert.ok(audiences, `${item.kind}/${item.variant} has no ATTENTION_SENTENCES entry`);
    assert.ok(audiences.includes('staff'), `${item.kind}/${item.variant} has no staff sentence`);
  }
});
