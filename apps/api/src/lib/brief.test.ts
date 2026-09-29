import test from 'node:test';
import assert from 'node:assert/strict';
import type { DependencySide } from '@prisma/client';
import {
  BRIEF_FIELDS,
  COMMITMENTS,
  COMMITMENT_KEYS,
  EXTRA_COMMITMENT,
  briefCompleteness,
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

const provided = (
  domain: DependencySide | null = null,
  host: DependencySide | null = null,
  content: DependencySide | null = null,
) => ({ domainProvidedBy: domain, hostProvidedBy: host, contentProvidedBy: content });

// --- briefDependencies -------------------------------------------------------------

test('briefDependencies: a provider left unset implies nothing — no row is a guess about whose side it is', () => {
  assert.deepEqual(briefDependencies(provided(), []), []);
  assert.deepEqual(briefDependencies(null, []), []);
  assert.deepEqual(
    briefDependencies(provided('CUSTOMER'), []).map((i) => [i.key, i.side]),
    [['domain', 'CUSTOMER']],
  );
});

test('briefDependencies: domain, host, content take their sides from the brief, in a stable order', () => {
  const implied = briefDependencies(provided('ROOT', 'CUSTOMER', 'CUSTOMER'), []);
  assert.deepEqual(
    implied.map((i) => [i.key, i.side, i.sideFromBrief]),
    [
      ['domain', 'ROOT', true],
      ['host', 'CUSTOMER', true],
      ['content', 'CUSTOMER', true],
    ],
  );
});

test('briefDependencies: domain and host are technical (the developer verifies); everything else is general', () => {
  const all = briefDependencies(provided('CUSTOMER', 'CUSTOMER', 'CUSTOMER'), Object.keys(EXTRA_COMMITMENT));
  assert.deepEqual(
    Object.fromEntries(all.map((i) => [i.key, i.technical])),
    { domain: true, host: true, content: false, gateway: false, smsLine: false, enamad: false },
  );
  // …and the table the API writes rows from says the same.
  for (const key of COMMITMENT_KEYS) {
    assert.equal(COMMITMENTS[key].technical, key === 'domain' || key === 'host', key);
  }
});

test('briefDependencies: the extras imply gateway, smsLine and enamad — customer-side unless the caller says otherwise', () => {
  const implied = briefDependencies(provided(), ['checklist.payment', 'checklist.notifications', 'checklist.legal']);
  assert.deepEqual(
    implied.map((i) => [i.key, i.side, i.sideFromBrief]),
    [
      ['gateway', 'CUSTOMER', false],
      ['smsLine', 'CUSTOMER', false],
      ['enamad', 'CUSTOMER', false],
    ],
  );
  const overridden = briefDependencies(provided(), ['checklist.payment'], { gateway: 'ROOT' });
  assert.equal(overridden[0].side, 'ROOT');
  // An override never beats the brief's own field for the three it records.
  const domain = briefDependencies(provided('CUSTOMER'), [], { domain: 'ROOT' });
  assert.equal(domain[0].side, 'CUSTOMER');
});

test('briefDependencies: an extra that implies nothing (or is not in scope) adds nothing', () => {
  assert.deepEqual(briefDependencies(provided(), ['checklist.analytics', 'checklist.hosting']), []);
  assert.deepEqual(briefDependencies(provided(), []), []);
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
  items.map(([key, side]) => ({ key, side, technical: COMMITMENTS[key].technical, sideFromBrief: true }));

const plan = (over: Partial<Parameters<typeof planDependencySync>[0]>) =>
  planDependencySync({ implied: [], existing: [], dueDates: {}, stillImpliedElsewhere: new Set(), ...over });

test('planDependencySync: creates a row only for an implied key that has a date to give it', () => {
  const p = plan({ implied: implied(['domain', 'CUSTOMER'], ['host', 'CUSTOMER']), dueDates: { domain: d(15) } });
  assert.deepEqual(
    p.create.map((c) => [c.key, c.side, c.dueAt.getTime(), c.technical]),
    [['domain', 'CUSTOMER', d(15).getTime(), true]],
  );
  // host has no date and no row: not created — `briefCompleteness` reports it.
  assert.equal(p.create.some((c) => c.key === 'host'), false);
});

test('planDependencySync: a provider switched to Root flips the row’s side and nothing else', () => {
  const p = plan({ implied: implied(['host', 'ROOT']), existing: [row('host')] });
  assert.equal(p.create.length, 0);
  assert.deepEqual(p.update.map((u) => [u.id, u.side, u.dueAt.getTime()]), [['row-host', 'ROOT', d(20).getTime()]]);
});

test('planDependencySync: a row keeps its own date when none is given, and takes a new one when it is', () => {
  const kept = plan({ implied: implied(['domain', 'CUSTOMER']), existing: [row('domain')] });
  assert.deepEqual(kept.update, [], 'nothing differs — nothing is written');
  const moved = plan({ implied: implied(['domain', 'CUSTOMER']), existing: [row('domain')], dueDates: { domain: d(25) } });
  assert.deepEqual(moved.update.map((u) => u.dueAt.getTime()), [d(25).getTime()]);
});

test('planDependencySync is idempotent: applied, then planned again, it is empty — one row per key however often the brief is set', () => {
  const want = implied(['domain', 'ROOT'], ['host', 'CUSTOMER'], ['content', 'CUSTOMER']);
  const dates = { domain: d(10), host: d(11), content: d(12) };
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
    implied: implied(['domain', 'CUSTOMER']),
    existing: [row('domain'), row('gateway'), row('smsLine', { verifiedAt: d(1) })],
  });
  assert.deepEqual(p.remove, ['row-gateway']);
  assert.deepEqual(p.detach, ['row-smsLine']);
});

test('planDependencySync: a key a sibling contract’s brief still implies stays — the board’s rows are the project’s', () => {
  const p = plan({
    implied: [],
    existing: [row('domain'), row('host')],
    stillImpliedElsewhere: new Set(['domain'] as const),
  });
  assert.deepEqual(p.remove, ['row-host']);
});

test('planDependencySync: a row whose title or flag drifted from the table is put back', () => {
  const p = plan({
    implied: implied(['host', 'CUSTOMER']),
    existing: [row('host', { technical: false, titleEn: 'old' })],
  });
  assert.equal(p.update.length, 1);
  assert.equal(p.update[0].technical, true);
  assert.equal(p.update[0].titleEn, COMMITMENTS.host.titleEn);
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
  ...provided('CUSTOMER', 'CUSTOMER', 'ROOT'),
  ...over,
});

const inputFor = (over: Partial<Parameters<typeof briefCompleteness>[0]> = {}): Parameters<typeof briefCompleteness>[0] => ({
  brief: complete(),
  commitmentDates: { domain: d(10), host: d(10), content: d(10) },
  includedExtraKeys: [],
  phases: [{ id: 'p1', plannedEndAt: d(28) }],
  plan: { invoiceAmounts: [60n, 40n] },
  fee: 100n,
  ...over,
});

const codes = (over?: Partial<Parameters<typeof briefCompleteness>[0]>) =>
  briefCompleteness(inputFor(over)).map((m) => (m.key ? `${m.code}:${m.key}` : m.code));

test('briefCompleteness: a complete brief, dated commitments, dated phases and a plan that matches the fee lacks nothing', () => {
  assert.deepEqual(codes(), []);
});

test('briefCompleteness: no brief at all is BRIEF, alongside what the rest of the step lacks', () => {
  assert.deepEqual(codes({ brief: null, plan: null, phases: [] }), ['BRIEF', 'PHASES', 'PAYMENT_PLAN']);
});

test('briefCompleteness: each field the later steps read is named when it is missing', () => {
  const lacking: Array<[Partial<BriefForCompleteness>, string]> = [
    [{ budgetCap: null }, 'BUDGET_CAP'],
    [{ hardDeadline: null }, 'HARD_DEADLINE'],
    [{ domainProvidedBy: null }, 'DOMAIN_PROVIDER'],
    [{ hostProvidedBy: null }, 'HOST_PROVIDER'],
    [{ contentProvidedBy: null }, 'CONTENT_PROVIDER'],
    [{ supportMonths: null }, 'SUPPORT_MONTHS'],
    [{ demoIterationsPerPhase: null }, 'DEMO_ITERATIONS'],
    [{ kind: 'FEATURE_FOR_EXISTING' }, 'EXISTING_SITE_URL'],
  ];
  for (const [over, code] of lacking) {
    const got = codes({ brief: complete(over), commitmentDates: { domain: d(1), host: d(1), content: d(1) } });
    assert.ok(got.includes(code), `${code} in ${JSON.stringify(got)}`);
  }
});

test('briefCompleteness: the allowance a design path counts against is the one required — premade rounds, or mockup iterations', () => {
  assert.ok(codes({ brief: complete({ premadeRounds: null }) }).includes('PREMADE_ROUNDS'));
  assert.ok(!codes({ brief: complete({ premadeRounds: null, designTier: 'SENIOR_DESIGNER', mockupIterations: 2 }) }).includes('PREMADE_ROUNDS'));
  assert.ok(codes({ brief: complete({ designTier: 'CLAUDE_ASSISTED' }) }).includes('MOCKUP_ITERATIONS'));
  assert.ok(!codes({ brief: complete() }).includes('MOCKUP_ITERATIONS'));
});

test('briefCompleteness: every implied commitment needs a date (COMMITMENT_UNDATED) — extras included; a wish is never required', () => {
  assert.deepEqual(codes({ commitmentDates: { domain: d(10), host: d(10) } }), ['COMMITMENT_UNDATED:content']);
  assert.deepEqual(
    codes({ includedExtraKeys: ['checklist.payment'], commitmentDates: { domain: d(1), host: d(1), content: d(1) } }),
    ['COMMITMENT_UNDATED:gateway'],
  );
  // The ideal deadline and the domain name are not in the brief type at all:
  // nothing about them can make a step incomplete.
});

test('briefCompleteness: phases need a planned end date each; the plan must exist and, given a fee, add up to it', () => {
  assert.deepEqual(codes({ phases: [{ id: 'a', plannedEndAt: d(1) }, { id: 'b', plannedEndAt: null }] }), ['PHASE_END_DATE:b']);
  assert.deepEqual(codes({ plan: { invoiceAmounts: [] } }), ['PAYMENT_PLAN']);
  assert.deepEqual(codes({ plan: { invoiceAmounts: [60n, 30n] } }), ['PAYMENT_PLAN_TOTAL']);
  // No fee yet: the plan is not compared with nothing (`planMatchesFee` makes the same choice).
  assert.deepEqual(codes({ plan: { invoiceAmounts: [60n, 30n] }, fee: null }), []);
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
  assert.equal(checkBriefInput(input({ allowances: [0, 2, null, null] })), 'INVALID_ALLOWANCE');
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
