import test from 'node:test';
import assert from 'node:assert/strict';
import type { DependencySide } from '@prisma/client';
import {
  BRIEF_FIELDS,
  COMMITMENTS,
  COMMITMENT_KEYS,
  EXTRA_COMMITMENT,
  EXTRA_COMMITMENT_KEYS,
  EXISTING_SITE_PRESET,
  handoverUndated,
  handoverUndecided,
  presetApplies,
  briefCompleteness,
  planCompleteness,
  briefDependencies,
  checkBriefInput,
  isBriefField,
  isCommitmentKey,
  isIncludedExtra,
  isMoneyString,
  isSiteUrl,
  planDependencySync,
  type BriefForCompleteness,
  type ExistingBriefRow,
  type HandoverFacts,
  type ImpliedCommitment,
} from './brief.js';
import { MONEY_BRIEF_FIELDS } from './feedbackRules.js';
import { CHECKLIST } from './templates.js';

/**
 * Journeys build plan J4 — step 1's rules as tables. Each is a pure function of
 * plain rows, so what the brief implies, what it lacks and what must change on
 * the board is checked here without a database; `j4.test.ts` then only has to
 * prove the resolvers *use* them.
 */

const d = (day: number) => new Date(Date.UTC(2026, 9, day)); // 2026-10-<day>

// --- briefDependencies -------------------------------------------------------------

test('briefDependencies (DX3a): only the included extras imply a commitment — the default list is rows, not brief fields', () => {
  assert.deepEqual(briefDependencies([]), []);
  assert.deepEqual(briefDependencies(['checklist.analytics', 'checklist.hosting']), [], 'an extra that implies nothing adds nothing');
});

test('briefDependencies: gateway, smsLine and enamad are customer-side unless the caller says otherwise, in a stable order', () => {
  const implied = briefDependencies(['checklist.legal', 'checklist.payment', 'checklist.notifications']);
  assert.deepEqual(
    implied.map((i) => [i.key, i.side, i.technical]),
    [
      ['gateway', 'CUSTOMER', false],
      ['smsLine', 'CUSTOMER', false],
      ['enamad', 'CUSTOMER', false],
    ],
  );
  assert.equal(briefDependencies(['checklist.payment'], { gateway: 'ROOT' })[0].side, 'ROOT');
});

test('briefDependencies: a side cleared to undecided stays undecided — null is an answer, not "use the default"', () => {
  assert.equal(briefDependencies(['checklist.payment'], { gateway: null })[0].side, null);
  assert.equal(briefDependencies(['checklist.payment'], {})[0].side, 'CUSTOMER');
});

test('the commitments table still marks domain and host technical (the developer verifies); the default list is seeded from it', () => {
  for (const key of COMMITMENT_KEYS) {
    assert.equal(COMMITMENTS[key].technical, key === 'domain' || key === 'host', key);
  }
  // The extras own gateway, smsLine and enamad; a default-list item may not take their keys.
  assert.deepEqual([...EXTRA_COMMITMENT_KEYS].sort(), ['enamad', 'gateway', 'smsLine']);
});

test('every extra that implies a commitment is a real checklist area, and every commitment key is a real key', () => {
  const areas = new Set(CHECKLIST.map(([key]) => key));
  for (const [extra, key] of Object.entries(EXTRA_COMMITMENT)) {
    assert.ok(areas.has(extra), `${extra} is not in the completeness checklist`);
    assert.ok(isCommitmentKey(key));
  }
  assert.equal(isCommitmentKey('nope'), false);
});

test('isIncludedExtra: agreed or beyond is in scope; declined, proposed and traded are not', () => {
  for (const s of ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED']) assert.equal(isIncludedExtra(s), true, s);
  for (const s of ['DECLINED', 'PROPOSED', 'TRADED']) assert.equal(isIncludedExtra(s), false, s);
});

// --- planDependencySync --------------------------------------------------------------

const row = (key: ExistingBriefRow['briefKey'], over: Partial<ExistingBriefRow> = {}): ExistingBriefRow => ({
  id: `row-${key}`,
  briefKey: key,
  side: 'CUSTOMER',
  dueAt: d(20),
  technical: COMMITMENTS[key].technical,
  titleFa: COMMITMENTS[key].titleFa,
  titleEn: COMMITMENTS[key].titleEn,
  verifiedAt: null,
  ...over,
});

const implied = (...items: Array<[ImpliedCommitment['key'], DependencySide]>): ImpliedCommitment[] =>
  items.map(([key, side]) => ({ key, side, technical: COMMITMENTS[key].technical }));

const plan = (over: Partial<Parameters<typeof planDependencySync>[0]>) =>
  planDependencySync({ implied: [], existing: [], dueDates: {}, stillImpliedElsewhere: new Set(), ...over });

test('planDependencySync (DX3a): creates a row for every implied key, dated when the caller gave a date and undated when not', () => {
  const p = plan({ implied: implied(['gateway', 'CUSTOMER'], ['enamad', 'CUSTOMER']), dueDates: { gateway: d(15) } });
  assert.deepEqual(
    p.create.map((c) => [c.key, c.side, c.dueAt?.getTime() ?? null, c.technical]),
    [
      ['gateway', 'CUSTOMER', d(15).getTime(), false],
      ['enamad', 'CUSTOMER', null, false],
    ],
  );
});

test('planDependencySync: a provider switched to Root flips the row’s side and nothing else', () => {
  const p = plan({ implied: implied(['gateway', 'ROOT']), existing: [row('gateway')] });
  assert.equal(p.create.length, 0);
  assert.deepEqual(p.update.map((u) => [u.id, u.side, u.dueAt?.getTime()]), [['row-gateway', 'ROOT', d(20).getTime()]]);
});

test('planDependencySync: a row keeps its own date when none is given, and takes a new one when it is', () => {
  const kept = plan({ implied: implied(['gateway', 'CUSTOMER']), existing: [row('gateway')] });
  assert.deepEqual(kept.update, [], 'nothing differs — nothing is written');
  const moved = plan({ implied: implied(['gateway', 'CUSTOMER']), existing: [row('gateway')], dueDates: { gateway: d(25) } });
  assert.deepEqual(moved.update.map((u) => u.dueAt?.getTime()), [d(25).getTime()]);
});

test('planDependencySync is idempotent: applied, then planned again, it is empty — one row per key however often the brief is set', () => {
  const want = implied(['gateway', 'ROOT'], ['smsLine', 'CUSTOMER'], ['enamad', 'CUSTOMER']);
  const dates = { gateway: d(10), smsLine: d(11), enamad: d(12) };
  const first = plan({ implied: want, dueDates: dates });
  assert.equal(first.create.length, 3);

  // Apply it: the board now holds exactly those rows.
  const board: ExistingBriefRow[] = first.create.map((c) => ({
    id: `id-${c.key}`,
    briefKey: c.key,
    side: c.side,
    dueAt: c.dueAt,
    technical: c.technical,
    titleFa: c.titleFa,
    titleEn: c.titleEn,
    verifiedAt: null,
  }));
  const second = plan({ implied: want, existing: board, dueDates: dates });
  assert.deepEqual(second, { create: [], update: [], remove: [], detach: [] });
  const third = plan({ implied: want, existing: board });
  assert.deepEqual(third, { create: [], update: [], remove: [], detach: [] });
});

test('planDependencySync: a key no brief implies any more is removed — unless verified, then it is kept and freed', () => {
  const p = plan({
    implied: implied(['enamad', 'CUSTOMER']),
    existing: [row('enamad'), row('gateway'), row('smsLine', { verifiedAt: d(1) })],
  });
  assert.deepEqual(p.remove, ['row-gateway']);
  assert.deepEqual(p.detach, ['row-smsLine']);
});

test('planDependencySync: a key a sibling contract’s brief still implies stays — the board’s rows are the project’s', () => {
  const p = plan({
    implied: [],
    existing: [row('gateway'), row('enamad')],
    stillImpliedElsewhere: new Set(['gateway'] as const),
  });
  assert.deepEqual(p.remove, ['row-enamad']);
});

test('planDependencySync: a row whose title or flag drifted from the table is put back', () => {
  const p = plan({
    implied: implied(['gateway', 'CUSTOMER']),
    existing: [row('gateway', { technical: true, titleEn: 'old' })],
  });
  assert.equal(p.update.length, 1);
  assert.equal(p.update[0].technical, false);
  assert.equal(p.update[0].titleEn, COMMITMENTS.gateway.titleEn);
});

// --- briefCompleteness ---------------------------------------------------------------

const complete = (over: Partial<BriefForCompleteness> = {}): BriefForCompleteness => ({
  kind: 'NEW_SITE',
  existingSiteUrl: null,
  designTier: 'THEME_PICK',
  budgetCap: 100n,
  hardDeadline: d(30),
  supportMonths: 6,
  premadeRounds: 2,
  mockupIterations: null,
  demoIterationsPerPhase: 2,
  ...over,
});

const item = (key: string, side: DependencySide | null, dueAt: Date | null, over: Partial<HandoverFacts> = {}): HandoverFacts => ({
  key,
  inBrief: true,
  side,
  dueAt,
  notNeeded: false,
  ...over,
});

const inputFor = (over: Partial<Parameters<typeof briefCompleteness>[0]> = {}): Parameters<typeof briefCompleteness>[0] => ({
  brief: complete(),
  handover: [item('domain', 'CUSTOMER', d(10)), item('host', 'ROOT', d(10)), item('content', 'CUSTOMER', d(10))],
  ...over,
});

const codes = (over?: Partial<Parameters<typeof briefCompleteness>[0]>) =>
  briefCompleteness(inputFor(over)).map((m) => (m.key ? `${m.code}:${m.key}` : m.code));

test('briefCompleteness: a complete brief with dated commitments lacks nothing', () => {
  assert.deepEqual(codes(), []);
});

test('briefCompleteness: no brief at all is BRIEF — and since DX2a it no longer names phases or the plan', () => {
  assert.deepEqual(codes({ brief: null }), ['BRIEF']);
});

test('briefCompleteness: each field the later steps read is named when it is missing', () => {
  const lacking: Array<[Partial<BriefForCompleteness>, string]> = [
    [{ budgetCap: null }, 'BUDGET_CAP'],
    [{ hardDeadline: null }, 'HARD_DEADLINE'],
    [{ supportMonths: null }, 'SUPPORT_MONTHS'],
    [{ demoIterationsPerPhase: null }, 'DEMO_ITERATIONS'],
    [{ kind: 'FEATURE_FOR_EXISTING' }, 'EXISTING_SITE_URL'],
  ];
  for (const [over, code] of lacking) {
    const got = codes({ brief: complete(over) });
    assert.ok(got.includes(code), `${code} in ${JSON.stringify(got)}`);
  }
});

test('briefCompleteness: the allowance a design path counts against is the one required — premade rounds, or mockup iterations', () => {
  assert.ok(codes({ brief: complete({ premadeRounds: null }) }).includes('PREMADE_ROUNDS'));
  assert.ok(!codes({ brief: complete({ premadeRounds: null, designTier: 'SENIOR_DESIGNER', mockupIterations: 2 }) }).includes('PREMADE_ROUNDS'));
  assert.ok(codes({ brief: complete({ designTier: 'CLAUDE_ASSISTED' }) }).includes('MOCKUP_ITERATIONS'));
  assert.ok(!codes({ brief: complete() }).includes('MOCKUP_ITERATIONS'));
  // DX2a: no design, no allowance to set — neither is required.
  assert.deepEqual(codes({ brief: complete({ designTier: 'NONE', premadeRounds: null, mockupIterations: null }) }), []);
});

test('briefCompleteness (DX6): every item in the brief is decided — a side or not needed (COMMITMENT_UNDECIDED)', () => {
  const undecided = [item('domain', null, null), item('host', null, null), item('content', null, null)];
  assert.deepEqual(codes({ handover: undecided }), ['COMMITMENT_UNDECIDED:domain', 'COMMITMENT_UNDECIDED:host', 'COMMITMENT_UNDECIDED:content']);
  assert.deepEqual(codes({ handover: [] }), []);
  assert.deepEqual(codes({ handover: [item('host', null, null, { notNeeded: true })] }), [], 'not needed is a decision');
  assert.deepEqual(codes({ handover: [item('x', null, null, { inBrief: false })] }), [], 'a board-only row is the board’s business');
  assert.equal(handoverUndecided(item('x', null, null)), true);
  assert.equal(handoverUndecided(item('x', 'ROOT', null)), false);
});

test('briefCompleteness: an item someone provides needs a date (COMMITMENT_UNDATED) — not one marked not needed', () => {
  assert.deepEqual(codes({ handover: [item('domain', 'CUSTOMER', d(10)), item('host', 'ROOT', null)] }), ['COMMITMENT_UNDATED:host']);
  assert.deepEqual(codes({ handover: [item('host', 'ROOT', null, { notNeeded: true })] }), []);
  // A one-off is named by its id, and an extra by its key.
  assert.deepEqual(codes({ handover: [item('dep-123', 'CUSTOMER', null), item('gateway', 'CUSTOMER', null)] }), [
    'COMMITMENT_UNDATED:dep-123',
    'COMMITMENT_UNDATED:gateway',
  ]);
  // A board-only row (not in the brief) is the board's business, not the step's.
  assert.deepEqual(codes({ handover: [item('x', 'CUSTOMER', null, { inBrief: false })] }), []);
  assert.equal(handoverUndated(item('x', 'ROOT', null)), true);
});

test('the "feature for an existing site" preset applies on the change to that kind, once (DX3a)', () => {
  assert.equal(presetApplies(null, 'FEATURE_FOR_EXISTING'), true, 'a brand-new brief of that kind');
  assert.equal(presetApplies('NEW_SITE', 'FEATURE_FOR_EXISTING'), true);
  assert.equal(presetApplies('FEATURE_FOR_EXISTING', 'FEATURE_FOR_EXISTING'), false, 'saved as typed the second time');
  assert.equal(presetApplies('FEATURE_FOR_EXISTING', 'NEW_SITE'), false, 'switching back changes nothing');
  assert.equal(presetApplies(null, 'NEW_SITE'), false);
  assert.deepEqual([EXISTING_SITE_PRESET.designTier, [...EXISTING_SITE_PRESET.notNeededKeys]], ['NONE', ['domain', 'host']]);
});

const planCodes = (over: Partial<Parameters<typeof planCompleteness>[0]> = {}) =>
  planCompleteness({ phases: [{ id: 'p1', plannedEndAt: d(28) }], plan: { invoiceAmounts: [60n, 40n] }, fee: 100n, ...over }).map((m) =>
    m.key ? `${m.code}:${m.key}` : m.code,
  );

test('planCompleteness (DX2a): dated phases and a plan that matches the fee lack nothing', () => {
  assert.deepEqual(planCodes(), []);
});

test('planCompleteness: no phase and no plan are named; phases need a planned end date each; the plan must exist and, given a fee, add up to it', () => {
  assert.deepEqual(planCodes({ phases: [], plan: null }), ['PHASES', 'PAYMENT_PLAN']);
  assert.deepEqual(planCodes({ phases: [{ id: 'a', plannedEndAt: d(1) }, { id: 'b', plannedEndAt: null }] }), ['PHASE_END_DATE:b']);
  assert.deepEqual(planCodes({ plan: { invoiceAmounts: [] } }), ['PAYMENT_PLAN']);
  assert.deepEqual(planCodes({ plan: { invoiceAmounts: [60n, 30n] } }), ['PAYMENT_PLAN_TOTAL']);
  // No fee yet: the plan is not compared with nothing (`planMatchesFee` makes the same choice).
  assert.deepEqual(planCodes({ plan: { invoiceAmounts: [60n, 30n] }, fee: null }), []);
});

// --- anchors ---------------------------------------------------------------------------

test('every money field S2 hides (PD-21) is a brief field a note can be anchored to', () => {
  for (const field of MONEY_BRIEF_FIELDS) assert.ok(isBriefField(field), field);
  for (const key of COMMITMENT_KEYS) assert.ok(isBriefField(key), `a commitment is its own anchor: ${key}`);
  assert.equal(isBriefField('x'), false);
  assert.equal(new Set(BRIEF_FIELDS).size, BRIEF_FIELDS.length, 'no field listed twice');
});

// --- input ---------------------------------------------------------------------------------

const input = (over: Partial<Parameters<typeof checkBriefInput>[0]> = {}): Parameters<typeof checkBriefInput>[0] => ({
  budgetCap: null,
  idealDeadline: null,
  hardDeadline: null,
  existingSiteUrl: null,
  supportMonths: null,
  allowances: [null, 2, null, null],
  ...over,
});

test('checkBriefInput: a fine input is fine, including everything unset', () => {
  assert.equal(checkBriefInput(input()), null);
  assert.equal(
    checkBriefInput(input({ budgetCap: '50000000', idealDeadline: d(1), hardDeadline: d(1), supportMonths: 0, existingSiteUrl: 'https://old.example.com' })),
    null,
    'equal deadlines are ordered',
  );
});

test('checkBriefInput: each refusal, and the first one in form order wins', () => {
  assert.equal(checkBriefInput(input({ budgetCap: '0' })), 'INVALID_BUDGET');
  assert.equal(checkBriefInput(input({ budgetCap: '1e6' })), 'INVALID_BUDGET');
  assert.equal(checkBriefInput(input({ budgetCap: '-5' })), 'INVALID_BUDGET');
  assert.equal(checkBriefInput(input({ hardDeadline: 'invalid' })), 'INVALID_DEADLINE');
  assert.equal(checkBriefInput(input({ idealDeadline: d(9), hardDeadline: d(2) })), 'DEADLINES_OUT_OF_ORDER');
  assert.equal(checkBriefInput(input({ existingSiteUrl: 'ftp://x' })), 'INVALID_SITE_URL');
  assert.equal(checkBriefInput(input({ existingSiteUrl: 'not a url' })), 'INVALID_SITE_URL');
  assert.equal(checkBriefInput(input({ supportMonths: -1 })), 'INVALID_SUPPORT_MONTHS');
  assert.equal(checkBriefInput(input({ supportMonths: 121 })), 'INVALID_SUPPORT_MONTHS');
  assert.equal(checkBriefInput(input({ supportMonths: 1.5 })), 'INVALID_SUPPORT_MONTHS');
  assert.equal(checkBriefInput(input({ allowances: [-1, 2, null, null] })), 'INVALID_ALLOWANCE');
  assert.equal(checkBriefInput(input({ allowances: [0, 0, 0, 0] })), null, 'DX6: zero rounds is a valid count');
  assert.equal(checkBriefInput(input({ allowances: [null, 2, 101, null] })), 'INVALID_ALLOWANCE');
  // Site url is asked before the budget in the form, so it is reported first.
  assert.equal(checkBriefInput(input({ existingSiteUrl: 'x', budgetCap: '0' })), 'INVALID_SITE_URL');
});

test('isMoneyString and isSiteUrl', () => {
  for (const ok of ['1', '180000000', '999999999999999']) assert.equal(isMoneyString(ok), true, ok);
  for (const bad of ['', '0', '01', '1.5', ' 5', '1000000000000000', 'ab']) assert.equal(isMoneyString(bad), false, bad);
  assert.equal(isSiteUrl('http://a.example'), true);
  assert.equal(isSiteUrl('https://a.example/path?q=1'), true);
  assert.equal(isSiteUrl('javascript:alert(1)'), false);
});
