import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { onDay } from './calendar.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * DX2a — the new step order, and "No design" (desk UX review 4, 10–12).
 *
 * The road with PHASES on it for a drafting and a signed contract (fixtures, no
 * backfill); the step's own done signal and the lists it left Requirements with;
 * the publish gate's two plan refusals and `publishBlockers`; the lock; and a
 * contract with no design, from its brief to its first demo.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.create({
    data: { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
  });
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async () => undefined });
  __setSmsTransportForTests({ sendCode: async () => undefined, sendText: async () => undefined });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// ---- documents and helpers --------------------------------------------------------

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE = (n = 1) =>
  `mutation($c: ID!){ createPhase(contractId: $c, number: ${n}, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "${onDay('2026-11-10')}") { phases { id } } }`;
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';
const READ = `query($c: ID!){ contract(id: $c) {
  wizard { step status locked }
  briefCompleteness { code key }
  planCompleteness { code key }
  publishBlockers { code step count }
  statusSummary { currentStep }
} }`;

type Read = {
  wizard: Array<{ step: string; status: string; locked: boolean }>;
  briefCompleteness: Array<{ code: string; key: string | null }>;
  planCompleteness: Array<{ code: string; key: string | null }>;
  publishBlockers: Array<{ code: string; step: string | null; count: number }>;
  statusSummary: { currentStep: string | null };
};

const read = async (as: User = staff.SALES) => ok(await exec(READ, { as, variables: { c: f.contract.id } })).contract as Read;
const stepsOf = (r: Read) => r.wizard.map((w) => w.step);
const rowOf = (r: Read, step: string) => r.wizard.find((w) => w.step === step)!;

const briefInput = (tier: string) => ({
  kind: 'NEW_SITE',
  templateTypeId: type.id,
  designTier: tier,
  budgetCap: '150000000',
  hardDeadline: onDay('2026-10-23'),
  domainName: 'nahal.ir',
  domainProvidedBy: 'CUSTOMER',
  hostProvidedBy: 'ROOT',
  contentProvidedBy: 'CUSTOMER',
  supportMonths: 6,
  ...(tier === 'THEME_PICK' ? { premadeRounds: 2 } : tier === 'NONE' ? {} : { mockupIterations: 2 }),
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: onDay('2026-10-05') },
    { key: 'host', dueAt: onDay('2026-10-06') },
    { key: 'content', dueAt: onDay('2026-10-07') },
  ],
});

const setBrief = (tier = 'THEME_PICK') => exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: briefInput(tier) } });

const rows = (a: string, b: string, phaseId: string | null) => [
  { labelFa: 'الف', labelEn: 'A', amount: a, phaseId, paymentTermDays: 7 },
  { labelFa: 'ب', labelEn: 'B', amount: b, phaseId: null, paymentTermDays: 7 },
];

/** One phase and a plan that adds up to the fixture's 180,000,000 fee. */
async function phasesAndPlan(a = '100000000', b = '80000000') {
  const phase = ok(await exec(CREATE_PHASE(), { as: staff.SALES, variables: { c: f.contract.id } })).createPhase as { phases: Array<{ id: string }> };
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: rows(a, b, phase.phases[0].id) } }));
  return phase.phases[0].id;
}

// ---- the road ---------------------------------------------------------------------

test('a drafting contract: PHASES sits between SCOPE and DRAFT, and is done exactly when planCompleteness is empty', async () => {
  const start = await read();
  assert.deepEqual(stepsOf(start).slice(0, 4), ['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT']);
  assert.deepEqual(start.planCompleteness.map((m) => m.code), ['PHASES', 'PAYMENT_PLAN']);
  assert.notEqual(rowOf(start, 'PHASES').status, 'DONE');

  // The brief's list no longer names the phases or the plan.
  ok(await setBrief());
  const brief = await read();
  assert.deepEqual(brief.briefCompleteness, []);
  assert.equal(rowOf(brief, 'REQUIREMENTS').status, 'DONE');

  const phaseId = await phasesAndPlan('100000000', '30000000'); // 130,000,000 of the fee's 180,000,000
  const short = await read();
  assert.deepEqual(short.planCompleteness.map((m) => m.code), ['PAYMENT_PLAN_TOTAL']);
  assert.notEqual(rowOf(short, 'PHASES').status, 'DONE');

  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: rows('100000000', '80000000', phaseId) } }));
  const done = await read();
  assert.deepEqual(done.planCompleteness, []);
  assert.equal(rowOf(done, 'PHASES').status, 'DONE');
  assert.equal(rowOf(done, 'PHASES').locked, false);
  // The customer's road agrees: the signal is not a staff-only view.
  assert.equal(rowOf(await read(f.customer), 'PHASES').status, 'DONE');
});

test('a signed contract that never had a PHASES step reads correctly with no backfill: PHASES done and locked, with the rest of steps 1–3', async () => {
  // A contract signed before the step existed: no phases, no plan — only the agreement's approval and a signature.
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Test Customer', signedHash: f.contractRevision.contentHash! },
  });
  const r = await read();
  for (const step of ['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT']) {
    assert.deepEqual([rowOf(r, step).status, rowOf(r, step).locked], ['DONE', true], step);
  }
  // …and the phase and plan writes are refused with STEP_LOCKED, which is the lock `j7` tabulates for the rest.
  assert.equal((await exec(CREATE_PHASE(2), { as: staff.SALES, variables: { c: f.contract.id } })).code, 'STEP_LOCKED');
  assert.equal((await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: rows('1', '1', null) } })).code, 'STEP_LOCKED');
});

// ---- the publish gate -------------------------------------------------------------

test('publish refuses a draft whose phases and plan are incomplete (PLAN_INCOMPLETE) or short of the price (PLAN_UNBALANCED), each pointing at the PHASES step', async () => {
  ok(await setBrief());
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));

  // No phase and no plan: the brief and the scope are clear, so the plan speaks.
  const first = await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } });
  assert.equal(first.code, 'PLAN_INCOMPLETE');
  const gaps = (await read()).publishBlockers;
  assert.deepEqual(gaps.map((b) => [b.code, b.step]), [['PLAN_INCOMPLETE', 'PHASES']]);
  assert.equal(gaps[0].count, 2, 'no phase, no plan');

  // A plan that does not add up: the other code, the same step.
  await phasesAndPlan('100000000', '30000000');
  assert.equal((await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } })).code, 'PLAN_UNBALANCED');
  assert.deepEqual((await read()).publishBlockers.map((b) => [b.code, b.step]), [['PLAN_UNBALANCED', 'PHASES']]);

  // Balanced: nothing blocks, and the publish lands.
  const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { contractId: f.contract.id }, include: { invoices: true } });
  await prisma.plannedInvoice.update({ where: { id: plan.invoices.find((i) => i.amount === 30000000n)!.id }, data: { amount: 80000000n } });
  assert.deepEqual((await read()).publishBlockers, []);
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
});

test('the order of the refusals is the scope, the brief, then the plan; and a draft with a dated phase but no payment plan is PLAN_INCOMPLETE', async () => {
  const none = (await read()).publishBlockers.map((b) => b.code);
  assert.deepEqual(none, ['SCOPE_UNCONFIRMED', 'BRIEF_INCOMPLETE', 'PLAN_INCOMPLETE']);
  ok(await exec(CREATE_PHASE(), { as: staff.SALES, variables: { c: f.contract.id } }));
  const blocker = (await read()).publishBlockers.find((b) => b.code === 'PLAN_INCOMPLETE')!;
  assert.equal(blocker.count, 1, 'only the payment plan is missing');
});

// ---- no design --------------------------------------------------------------------

test('a contract with no design: its brief needs no design allowance, its road has neither DESIGN nor MOCKUP, and it reaches its first demo', async () => {
  ok(await setBrief('NONE'));
  const brief = await read();
  assert.deepEqual(brief.briefCompleteness, [], 'no premade rounds and no mockup iterations are asked for');
  const road = stepsOf(brief);
  assert.equal(road.includes('DESIGN'), false);
  assert.equal(road.includes('MOCKUP'), false);
  assert.deepEqual(road, ['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT', 'AGREEMENT', 'DEMO', 'SUMMARY']);

  // The same contract with a pre-made design has both steps' absence reversed (THEME_PICK has DESIGN, no MOCKUP).
  ok(await setBrief('THEME_PICK'));
  assert.deepEqual(stepsOf(await read()), ['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT', 'AGREEMENT', 'DESIGN', 'DEMO', 'SUMMARY']);
  ok(await setBrief('NONE'));

  // Publish, approve and sign: nothing waits on a design that is not there.
  const phaseId = await phasesAndPlan();
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: onDay('2026-10-12'), e: onDay('2026-12-20') } }));
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));

  const signed = await read();
  assert.equal(signed.statusSummary.currentStep, 'DEMO', 'the road goes from the agreement straight to the first phase’s demo');
  assert.equal(rowOf(signed, 'AGREEMENT').status, 'DONE');
  // The first demo can be opened (created) by the developer.
  ok(
    await exec('mutation($p: ID!, $u: String!){ createDemo(phaseId: $p, stagingUrl: $u) { id } }', {
      as: staff.DEVELOPER,
      variables: { p: phaseId, u: 'https://nahal.staging.localhost/' },
    }),
  );
});
