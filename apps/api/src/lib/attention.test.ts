import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Role, StepKind } from '@prisma/client';
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
  feedback: { unresolved: [], pendingApproval: [], answered: [] },
  invoices: [],
  ...over,
});

const fact = (step: StepKind, phaseId: string | null, since: Date, money = false) => ({ step, phaseId, money, since });

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

test('answered items collapse to one line per step and phase, since the earliest answer', () => {
  const items = attentionFor(
    empty({
      feedback: {
        unresolved: [],
        pendingApproval: [],
        answered: [fact('DEMO', 'p1', day(-2)), fact('DEMO', 'p1', day(-5)), fact('DEMO', 'p2', day(-1)), fact('DESIGN', null, day(-3))],
      },
    }),
    CUSTOMER,
  );
  assert.deepEqual(items.map((i) => [i.kind, i.phaseId, i.params, i.since]), [
    ['ANSWER_PUBLISHED', 'p1', { count: 2, step: 'DEMO' }, day(-5)],
    ['ANSWER_PUBLISHED', null, { count: 1, step: 'DESIGN' }, day(-3)],
    ['ANSWER_PUBLISHED', 'p2', { count: 1, step: 'DEMO' }, day(-1)],
  ]);
  assert.ok(items.every((i) => i.waitingOn === 'CUSTOMER'));
});

test('feedback Root owes is Root’s move, routed to the step’s job; a customer sees it, and sees nothing of the approval queue', () => {
  const input = empty({
    feedback: {
      unresolved: [fact('REQUIREMENTS', null, day(-4)), fact('DESIGN', null, day(-3)), fact('DEMO', 'p1', day(-2))],
      pendingApproval: [fact('DESIGN', null, day(-1)), fact('DESIGN', null, day(-6))],
      answered: [],
    },
  });
  const staff = attentionFor(input, SALES);
  assert.deepEqual(
    staff.map((i) => [i.kind, i.waitingOn, i.role, i.internal, i.params]),
    [
      ['ANSWER_PENDING_APPROVAL', 'ROOT', 'SALES', true, { count: 2, step: 'DESIGN' }],
      ['FEEDBACK_UNRESOLVED', 'ROOT', 'SALES', false, { count: 1, step: 'REQUIREMENTS' }],
      ['FEEDBACK_UNRESOLVED', 'ROOT', 'DESIGNER', false, { count: 1, step: 'DESIGN' }],
      ['FEEDBACK_UNRESOLVED', 'ROOT', 'DEVELOPER', false, { count: 1, step: 'DEMO' }],
    ],
  );
  assert.equal(staff[0].since.getTime(), day(-6).getTime(), 'a group waits since its earliest member');
  // The customer is told Root owes them an answer — never that one is waiting
  // for sales to release it.
  assert.deepEqual(attentionFor(input, CUSTOMER).map((i) => i.kind), ['FEEDBACK_UNRESOLVED', 'FEEDBACK_UNRESOLVED', 'FEEDBACK_UNRESOLVED']);
});

test('feedback about money is its own line, and only money readers see it (PD-21)', () => {
  const input = empty({
    feedback: {
      unresolved: [fact('REQUIREMENTS', null, day(-2), true), fact('REQUIREMENTS', null, day(-1), false)],
      pendingApproval: [],
      answered: [],
    },
  });
  assert.equal(attentionFor(input, SALES).length, 2);
  assert.deepEqual(attentionFor(input, DESIGNER).map((i) => i.money), [false]);
  assert.equal(attentionFor(input, CUSTOMER).length, 2, 'the customer’s own feedback about money is theirs to see');
});

let invoiceSeq = 0;
const invoice = (over: { issuedAt: Date | null; dueAt: Date | null; paidAt: Date | null }) => ({
  id: `inv-${++invoiceSeq}`,
  invoiceNumber: `INV-${String(invoiceSeq).padStart(6, '0')}`,
  ...over,
});

test('overdue invoices (J13): one line with the count, since the earliest due day; paid, drafted and not-yet-due ones are no part of it', () => {
  const inv = (dueOffset: number | null, paid = false, issued = true) =>
    invoice({
      issuedAt: issued ? day(-30) : null,
      dueAt: dueOffset === null ? null : day(dueOffset),
      paidAt: paid ? day(-1) : null,
    });
  const input = empty({
    invoices: [inv(-10), inv(-3), inv(-20, true), inv(4), inv(null, false, false)],
  });
  // (J12: the one not yet due is its own `INVOICE_DUE` line, tested below.)
  const items = attentionFor(input, CUSTOMER).filter((i) => i.kind === 'INVOICE_OVERDUE');
  assert.deepEqual(summary(items), ['INVOICE_OVERDUE/default/CUSTOMER']);
  assert.deepEqual(items[0].params, { count: 2 });
  // The earliest due *day* is when the wait began (a `date` column: midnight UTC).
  assert.equal(items[0].since.getTime(), day(-10).getTime());
  assert.equal(items[0].money, true);
  assert.equal(items[0].internal, false);
  // J12: the line is sales' to follow up, though the customer owes the money.
  assert.equal(items[0].role, 'SALES');
  assert.deepEqual(attentionFor(empty({ invoices: [inv(-20, true), inv(null, false, false)] }), CUSTOMER), []);
});

test('an invoice not yet due is its own line (J12): the customer’s move, one per invoice, named by number, money', () => {
  const issued = invoice({ issuedAt: day(-2), dueAt: day(5), paidAt: null });
  const overdue = invoice({ issuedAt: day(-30), dueAt: day(-3), paidAt: null });
  const items = attentionFor(empty({ invoices: [issued, overdue] }), CUSTOMER);
  assert.deepEqual(items.map((i) => i.kind).sort(), ['INVOICE_DUE', 'INVOICE_OVERDUE']);
  const due = items.find((i) => i.kind === 'INVOICE_DUE')!;
  assert.deepEqual(due.params, { invoiceId: issued.id, number: issued.invoiceNumber, dueAt: day(5).toISOString().slice(0, 10) });
  assert.equal(due.since.getTime(), day(-2).getTime(), 'the wait began when it reached them');
  assert.equal(due.waitingOn, 'CUSTOMER');
  assert.equal(due.money, true);
  assert.equal(due.role, null, 'a due invoice is nobody’s work yet — only an overdue one is chased');
  // A designer may not read the money, so it is not on their list either.
  assert.deepEqual(attentionFor(empty({ invoices: [issued] }), DESIGNER), []);
  // Paid: no line.
  assert.deepEqual(attentionFor(empty({ invoices: [invoice({ issuedAt: day(-2), dueAt: day(5), paidAt: day(-1) })] }), CUSTOMER), []);
});

test('an overdue invoice is money: the customer and sales see it, a designer does not (PD-21)', () => {
  const input = empty({ invoices: [invoice({ issuedAt: day(-30), dueAt: day(-2), paidAt: null })] });
  assert.equal(attentionFor(input, CUSTOMER).length, 1);
  assert.equal(attentionFor(input, SALES).length, 1);
  assert.deepEqual(attentionFor(input, DESIGNER), []);
  assert.deepEqual(attentionFor(input, OTHER_CUSTOMER), []);
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
      feedback: { unresolved: [], pendingApproval: [], answered: [fact('DEMO', 'p1', day(-9))] },
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
      feedback: {
        unresolved: [fact('DEMO', 'p', day(-1))],
        pendingApproval: [fact('DEMO', 'p', day(-1))],
        answered: [fact('DEMO', 'p', day(-1))],
      },
      invoices: [invoice({ issuedAt: day(-9), dueAt: day(-2), paidAt: null })],
    }),
    SALES,
  );
  assert.ok(emitted.some((i) => i.kind === 'INVOICE_OVERDUE'));
  for (const item of emitted) {
    const audiences = ATTENTION_SENTENCES[item.kind]?.[item.variant];
    assert.ok(audiences, `${item.kind}/${item.variant} has no ATTENTION_SENTENCES entry`);
    assert.ok(audiences.includes('staff'), `${item.kind}/${item.variant} has no staff sentence`);
  }
});

// --- J5: proposals waiting, and a scope trade waiting -------------------------------

test('proposals waiting for Root are one line, Root’s move, sales’ job, dated by the oldest', () => {
  const items = attentionFor(
    empty({ scope: { undecidedProposals: [{ since: day(-1) }, { since: day(-4) }, { since: day(-2) }], openTrades: [] } }),
    SALES,
  );
  assert.deepEqual(summary(items), ['PROPOSAL_TO_DECIDE/default/ROOT']);
  assert.deepEqual(items[0].params, { count: 3 });
  assert.equal(items[0].role, 'SALES');
  assert.equal(items[0].since.getTime(), day(-4).getTime());
  // The customer sees that Root owes them an answer — it is not Root's housekeeping.
  assert.deepEqual(summary(attentionFor(empty({ scope: { undecidedProposals: [{ since: day(-1) }], openTrades: [] } }), CUSTOMER)), [
    'PROPOSAL_TO_DECIDE/default/ROOT',
  ]);
  assert.deepEqual(attentionFor(empty({ scope: { undecidedProposals: [], openTrades: [] } }), SALES), []);
  assert.deepEqual(attentionFor(empty(), SALES), [], 'a fixture that predates the scope facts still works');
});

test('a scope trade: the customer’s move until they confirm, then Root’s to confirm, then Root’s to carry out', () => {
  const trade = (over: Partial<{ rootConfirmedAt: Date | null; customerConfirmedAt: Date | null }>) => ({
    id: 't1',
    proposedAt: day(-3),
    rootConfirmedAt: null,
    customerConfirmedAt: null,
    ...over,
  });
  const at = (t: ReturnType<typeof trade>) => summary(attentionFor(empty({ scope: { undecidedProposals: [], openTrades: [t] } }), SALES));
  // Neither has confirmed: both sides owe something.
  assert.deepEqual(at(trade({})).sort(), ['TRADE_TO_CONFIRM/customer/CUSTOMER', 'TRADE_TO_CONFIRM/root/ROOT']);
  // Root confirmed; the customer has not.
  assert.deepEqual(at(trade({ rootConfirmedAt: day(-2) })), ['TRADE_TO_CONFIRM/customer/CUSTOMER']);
  // The customer confirmed; Root has not.
  assert.deepEqual(at(trade({ customerConfirmedAt: day(-2) })), ['TRADE_TO_CONFIRM/root/ROOT']);
  // Both: only carrying it out is left, and that is Root's.
  assert.deepEqual(at(trade({ rootConfirmedAt: day(-2), customerConfirmedAt: day(-1) })), ['TRADE_TO_CONFIRM/execute/ROOT']);
  // The customer sees the ones about them, with a sentence written for them (locale test above).
  const forCustomer = attentionFor(empty({ scope: { undecidedProposals: [], openTrades: [trade({})] } }), CUSTOMER);
  assert.equal(forCustomer.length, 2);
  assert.ok(forCustomer.every((i) => ATTENTION_SENTENCES.TRADE_TO_CONFIRM?.[i.variant]?.includes('customer')));
});
