import test from 'node:test';
import assert from 'node:assert/strict';
import type { ScopeKind, ScopeStatus } from '@prisma/client';
import { executedAmendments, invoiceTotals, summaryItems, summarySteps, unpromptedChanges } from './summary.js';
import { computeWizard, type WizardState } from './steps.js';

/**
 * Journeys build plan J11 — the summary's rules, as tables: what became of each
 * item, which amendments count, which changes a customer may be told of, what a
 * step's rounds were, and the money. The integration suite (`j11.test.ts`) runs
 * them against a contract carried through the whole road.
 */

const item = (
  id: string,
  over: Partial<{
    key: string;
    kind: ScopeKind;
    status: ScopeStatus;
    position: number;
    contractId: string | null;
    phaseId: string | null;
    declinedReason: string | null;
    handedOverAt: Date | null;
    handedOverBy: { name: string } | null;
    handoverNote: string | null;
  }> = {},
) => ({
  id,
  key: over.key ?? id,
  labelFa: `فا ${id}`,
  labelEn: `En ${id}`,
  kind: 'PAGE' as ScopeKind,
  status: 'ACCEPTED' as ScopeStatus,
  position: 0,
  contractId: 'c1' as string | null,
  phaseId: null as string | null,
  declinedReason: null as string | null,
  handedOverAt: null as Date | null,
  handedOverBy: null as { name: string } | null,
  handoverNote: null as string | null,
  ...over,
});

const NO_TRADES: Array<{ outItemId: string; inItemId: string; executedAt: Date }> = [];

test('summaryItems: this contract’s items with their end states — a declined item stays, with why', () => {
  const out = summaryItems({
    contractId: 'c1',
    items: [
      item('home', { position: 1 }),
      item('blog', { position: 2, kind: 'FEATURE', status: 'DECLINED', declinedReason: 'Out of budget' }),
      item('theirs', { position: 3, contractId: 'c2' }),
      item('never', { position: 4, status: 'PROPOSED' }),
      item('kept', { position: 5, kind: 'EXTRA', contractId: null, status: 'AGREED' }),
      item('skipped-extra', { position: 6, kind: 'EXTRA', contractId: null, status: 'DECLINED' }),
    ],
    agreedKeys: new Set(['home', 'blog', 'kept']),
    trades: NO_TRADES,
    phaseNumbers: new Map(),
  });
  assert.deepEqual(
    out.map((i) => [i.key, i.status, i.declinedReason]),
    [
      ['home', 'ACCEPTED', null],
      ['blog', 'DECLINED', 'Out of budget'],
      ['kept', 'AGREED', null],
    ],
    'a sibling contract’s item, a proposal nobody agreed and a declined standing extra are not this record',
  );
});

test('summaryItems: a declined reason shows only on a declined item', () => {
  const [row] = summaryItems({
    contractId: 'c1',
    items: [item('home', { declinedReason: 'left over from when it was declined' })],
    agreedKeys: new Set(['home']),
    trades: NO_TRADES,
    phaseNumbers: new Map(),
  });
  assert.equal(row!.declinedReason, null);
});

test('summaryItems: agreed against what it became — an item that came in by a trade was not in the signed agreement', () => {
  const executedAt = new Date('2026-10-05T00:00:00Z');
  const out = summaryItems({
    contractId: 'c1',
    items: [
      item('gallery', { position: 1, status: 'TRADED' }),
      item('shop', { position: 2, status: 'ACCEPTED' }),
      item('home', { position: 3 }),
    ],
    agreedKeys: new Set(['gallery', 'home']),
    trades: [{ outItemId: 'gallery', inItemId: 'shop', executedAt }],
    phaseNumbers: new Map(),
  });
  const gallery = out.find((i) => i.key === 'gallery')!;
  const shop = out.find((i) => i.key === 'shop')!;
  assert.equal(gallery.inAgreement, true);
  assert.deepEqual(gallery.tradePartner, { direction: 'OUT', key: 'shop', labelFa: 'فا shop', labelEn: 'En shop', executedAt });
  assert.equal(shop.inAgreement, false, 'not in the signed appendix');
  assert.deepEqual(shop.tradePartner, { direction: 'IN', key: 'gallery', labelFa: 'فا gallery', labelEn: 'En gallery', executedAt });
  assert.equal(out.find((i) => i.key === 'home')!.tradePartner, null);
});

test('summaryItems: the phase number, and the handover only once it happened', () => {
  const at = new Date('2026-10-09T10:00:00Z');
  const out = summaryItems({
    contractId: 'c1',
    items: [
      item('repo', {
        position: 1,
        kind: 'DELIVERABLE',
        phaseId: 'p2',
        handedOverAt: at,
        handedOverBy: { name: 'Dev' },
        handoverNote: 'Transferred to their organisation.',
      }),
      // A note left behind by an un-marked handover would never reach here (the
      // resolver clears it), but the record must not show one without a date.
      item('export', { position: 2, kind: 'DELIVERABLE', handoverNote: 'stale', handedOverBy: { name: 'Dev' } }),
    ],
    agreedKeys: new Set(),
    trades: NO_TRADES,
    phaseNumbers: new Map([['p2', 2]]),
  });
  assert.equal(out[0]!.phaseNumber, 2);
  assert.deepEqual([out[0]!.handedOverAt, out[0]!.handedOverBy, out[0]!.handoverNote], [at, 'Dev', 'Transferred to their organisation.']);
  assert.deepEqual([out[1]!.handedOverAt, out[1]!.handedOverBy, out[1]!.handoverNote], [null, null, null]);
});

test('executedAmendments: signed, or the paired amendment of an executed trade — never one still waiting', () => {
  const at = new Date('2026-10-05T00:00:00Z');
  const a = (name: string, over: Partial<{ publishedAt: Date | null; signature: unknown; scopeTrade: { executedAt: Date | null } | null }>) => ({
    name,
    publishedAt: at as Date | null,
    signature: null as unknown,
    scopeTrade: null as { executedAt: Date | null } | null,
    ...over,
  });
  const out = executedAmendments([
    a('signed', { signature: { id: 's' } }),
    a('trade', { scopeTrade: { executedAt: at } }),
    a('waiting', {}),
    a('draft', { publishedAt: null, signature: { id: 's' } }),
    a('trade-not-executed', { scopeTrade: { executedAt: null } }),
  ]);
  assert.deepEqual(
    out.map((x) => x.name),
    ['signed', 'trade'],
  );
});

const build = (kind: 'SITE' | 'MOCKUP', number: number, publishedAt: Date | null) => ({ kind, number, publishedAt });
const T1 = new Date('2026-10-02T00:00:00Z');
const T2 = new Date('2026-10-03T00:00:00Z');

test('unpromptedChanges: a customer is told of the written-up ones only, in both languages; staff see them all', () => {
  const rows = [
    { id: 'raw', note: 'swapped the image library', noteLang: 'en', frameLine: null, build: build('SITE', 2, T2) },
    { id: 'told', note: 'fixed the footer', noteLang: 'en', frameLine: { textFa: 'پاورقی درست شد', textEn: 'The footer was fixed' }, build: build('SITE', 1, T1) },
    { id: 'undeclared', note: 'not yet published', noteLang: 'en', frameLine: { textFa: 'x', textEn: 'y' }, build: build('SITE', 3, null) },
  ];
  const customer = unpromptedChanges(rows, false);
  assert.deepEqual(customer.map((c) => c.id), ['told']);
  assert.deepEqual([customer[0]!.textFa, customer[0]!.textEn, customer[0]!.note, customer[0]!.writtenUp], ['پاورقی درست شد', 'The footer was fixed', null, true]);

  const staff = unpromptedChanges(rows, true);
  assert.deepEqual(staff.map((c) => c.id), ['told', 'raw'], 'oldest build first; an unpublished build is in nobody’s record');
  const raw = staff.find((c) => c.id === 'raw')!;
  assert.deepEqual([raw.note, raw.noteLang, raw.writtenUp, raw.textFa], ['swapped the image library', 'en', false, null]);
  // A written-up entry shows its prose, not the developer's raw note.
  assert.equal(staff.find((c) => c.id === 'told')!.note, null);
});

test('unpromptedChanges: a mockup iteration is the MOCKUP step’s, a site build the DEMO’s', () => {
  const out = unpromptedChanges(
    [
      { id: 'm', note: 'n', noteLang: 'fa', frameLine: null, build: build('MOCKUP', 1, T1) },
      { id: 's', note: 'n', noteLang: 'fa', frameLine: null, build: build('SITE', 1, T2) },
    ],
    true,
  );
  assert.deepEqual(out.map((c) => [c.id, c.step]), [['m', 'MOCKUP'], ['s', 'DEMO']]);
});

test('summarySteps: rounds against the allowance, extensions added, a step nobody counts reads null — never zero', () => {
  const state: WizardState = {
    sequence: 'AGREEMENT_FIRST',
    designPath: 'CUSTOM',
    phases: [{ id: 'p1', number: 1 }, { id: 'p2', number: 2 }],
    approvals: [],
    finished: [{ step: 'DESIGN', phaseId: null, at: T1 }],
  };
  const rows = summarySteps({
    wizard: computeWizard(state),
    brief: { designTier: 'SENIOR_DESIGNER', premadeRounds: null, wireframeIterations: 2, mockupIterations: 3, demoIterationsPerPhase: 2 },
    extensions: [
      { step: 'DESIGN', phaseId: null, extra: 1 },
      { step: 'DEMO', phaseId: 'p2', extra: 2 },
    ],
    counts: { design: 3 },
  });
  const by = (step: string, phaseId: string | null = null) => rows.find((r) => r.step === step && r.phaseId === phaseId)!;
  assert.ok(!rows.some((r) => r.step === 'SUMMARY'), 'the summary is not a step of itself');
  assert.deepEqual(
    [by('DESIGN').iterationsUsed, by('DESIGN').allowance, by('DESIGN').extensions, by('DESIGN').finishedAt],
    [3, 3, 1, T1],
  );
  // J9b and J10 fill these counts in `roundCountsOn`; until then the hole is honest.
  assert.equal(by('MOCKUP').iterationsUsed, null);
  assert.equal(by('MOCKUP').allowance, 3);
  assert.equal(by('DEMO', 'p1').iterationsUsed, null);
  assert.deepEqual([by('DEMO', 'p1').allowance, by('DEMO', 'p1').extensions], [2, 0]);
  assert.deepEqual([by('DEMO', 'p2').allowance, by('DEMO', 'p2').extensions], [4, 2], 'an extension is for its own phase');
  assert.equal(by('AGREEMENT').iterationsUsed, null);
  assert.equal(by('AGREEMENT').allowance, null);
});

test('summarySteps: when a stage does count mockup and demo rounds, the summary shows them without a change here', () => {
  const state: WizardState = {
    sequence: 'AGREEMENT_FIRST',
    designPath: 'CUSTOM',
    phases: [{ id: 'p1', number: 1 }],
    approvals: [],
    finished: [],
  };
  const rows = summarySteps({
    wizard: computeWizard(state),
    brief: { designTier: 'SENIOR_DESIGNER', premadeRounds: null, wireframeIterations: 2, mockupIterations: 3, demoIterationsPerPhase: 2 },
    extensions: [],
    counts: { design: 1, mockup: 2, demoByPhase: { p1: 1 } },
  });
  assert.equal(rows.find((r) => r.step === 'MOCKUP')!.iterationsUsed, 2);
  assert.equal(rows.find((r) => r.step === 'DEMO')!.iterationsUsed, 1);
});

test('invoiceTotals: issued invoices only — a draft is not part of the record', () => {
  const issued = new Date('2026-10-01T00:00:00Z');
  const paid = new Date('2026-10-04T00:00:00Z');
  assert.deepEqual(
    invoiceTotals([
      { amount: 1_000_000n, issuedAt: issued, paidAt: paid },
      { amount: 2_500_000n, issuedAt: issued, paidAt: null },
      { amount: 9_999_999n, issuedAt: null, paidAt: null },
    ]),
    { count: 2, paidCount: 1, issued: '3500000', paid: '1000000', outstanding: '2500000' },
  );
  assert.deepEqual(invoiceTotals([]), { count: 0, paidCount: 0, issued: '0', paid: '0', outstanding: '0' });
});
