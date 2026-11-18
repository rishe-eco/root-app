import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { onDay } from './calendar.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { FORMAT_3, contentHash, readContractSnapshot } from '../lib/revision.js';

/**
 * DX2b — what a phase is (desk UX review items 10–12; decisions 6–10).
 *
 * In this order: **an item in more than one phase** (`ScopeItem.phaseId` is the last of
 * its set; approving an earlier phase sends the item back to `IN_BUILD`, the last one
 * accepts it; deleting a phase re-derives it); **a phase with no demo** (`markPhaseDone`
 * and its refusals, the customer told, the invoice it makes issuable, the close it
 * unblocks); **"due on a date"** (`DATE_NOT_REACHED`, the plan's refusals, the CHECK by
 * a direct insert); **snapshot format 3** (what a publish writes, and a stored format-2
 * snapshot's bytes and hash untouched through Postgres); and the three small fixes
 * DX2a's review found.
 *
 * The contract is taken to signature the way a customer would, through the real
 * mutations (`signedContract`); a demo is a row inserted already published, because the
 * developer's side of publishing is J10's and these tests are about what comes after.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { email: 'customer@test.local', phone: '+989120000106', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  staff.DEVELOPER2 = await prisma.user.create({
    data: { email: 'developer2@test.local', name: 'Developer 2', roles: ['DEVELOPER'], state: 'ACTIVE' },
  });
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.createMany({
    data: [
      { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
      { typeId: type.id, key: 'about', kind: 'PAGE', labelFa: 'درباره‌ی ما', labelEn: 'About', position: 1 },
    ],
  });
  mail = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
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
const CREATE_PHASE =
  `mutation($c: ID!, $n: Int!, $d: Boolean){ createPhase(contractId: $c, number: $n, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "${onDay('2026-11-10')}", hasDemo: $d) { id } }`;
const UPDATE_PHASE = 'mutation($p: ID!, $d: Boolean){ updatePhase(phaseId: $p, titleFa: "فاز", titleEn: "Phase", hasDemo: $d) { id } }';
const DELETE_PHASE = 'mutation($p: ID!){ deletePhase(phaseId: $p) { id } }';
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';
const SET_PHASES = 'mutation($i: ID!, $p: [ID!]!){ setScopeItemPhases(scopeItemId: $i, phaseIds: $p) { id } }';
const ASSIGN = 'mutation($i: ID!, $p: ID){ assignScopeItemToPhase(scopeItemId: $i, phaseId: $p) { id } }';
const APPROVE_DEMO = 'mutation($c: ID!, $p: ID!){ approveDemo(contractId: $c, phaseId: $p) { id } }';
const MARK_DONE = 'mutation($p: ID!){ markPhaseDone(phaseId: $p) { id } }';
const ISSUE_PLANNED = 'mutation($p: ID!){ issuePlannedInvoice(plannedInvoiceId: $p) { id } }';
const CLOSE = 'mutation($c: ID!){ closeContract(contractId: $c) { id } }';
const READ = `query($c: ID!){ contract(id: $c) {
  wizard { step phaseId status }
  phases { id number hasDemo doneAt finished scopeItems { key } }
  paymentPlan { invoices { id ordinal phaseId dueOn state blockedBy } }
  agreedScopeItems { key phases }
  revision { format agreement { phases { number hasDemo } paymentPlan { invoices { ordinal dueOn } } } }
} }`;

type Read = {
  wizard: Array<{ step: string; phaseId: string | null; status: string }>;
  phases: Array<{ id: string; number: number; hasDemo: boolean; doneAt: string | null; finished: boolean; scopeItems: Array<{ key: string }> }>;
  paymentPlan: { invoices: Array<{ id: string; ordinal: number; phaseId: string | null; dueOn: string | null; state: string; blockedBy: string | null }> };
  agreedScopeItems: Array<{ key: string; phases: number[] | null }>;
  revision: {
    format: number;
    agreement: { phases: Array<{ number: number; hasDemo: boolean | null }>; paymentPlan: { invoices: Array<{ ordinal: number; dueOn: string | null }> } };
  } | null;
};

const read = async (as: User = staff.SALES) => ok(await exec(READ, { as, variables: { c: f.contract.id } })).contract as Read;
const dayOf = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const BRIEF = () => ({
  kind: 'NEW_SITE',
  templateTypeId: type.id,
  designTier: 'NONE',
  budgetCap: '180000000',
  hardDeadline: onDay('2026-10-23'),
  domainName: 'nahal.ir',
  supportMonths: 6,
  demoIterationsPerPhase: 2,
});

type Phases = { kick: string; build: string; last: string };
const planRows = (p: Phases, over: Array<Record<string, unknown>> = []) => [
  { labelFa: 'الف', labelEn: 'Kick-off', amount: '60000000', phaseId: p.kick, paymentTermDays: 7, ...over[0] },
  { labelFa: 'ب', labelEn: 'On a date', amount: '50000000', phaseId: null, dueOn: onDay('2026-12-01'), paymentTermDays: 7, ...over[1] },
  { labelFa: 'ج', labelEn: 'Last', amount: '70000000', phaseId: p.last, paymentTermDays: 7, ...over[2] },
];

/** A drafting contract: a kick-off phase with no demo, a built phase, a last phase; the scope seeded; a plan of three rows. */
async function drafting(): Promise<Phases> {
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: BRIEF() } }));
  const ids: string[] = [];
  for (const [n, hasDemo] of [[1, false], [2, true], [3, true]] as const) {
    ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n, d: hasDemo } }));
  }
  for (const p of await prisma.phase.findMany({ where: { contractId: f.contract.id }, orderBy: { number: 'asc' } })) ids.push(p.id);
  const phases = { kick: ids[0], build: ids[1], last: ids[2] };
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: planRows(phases) } }));
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: onDay('2026-10-12'), e: onDay('2026-12-20') } }));
  return phases;
}

const item = (key: string) => prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId, key } });

async function signedContract(): Promise<Phases> {
  const phases = await drafting();
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  mail.length = 0;
  return phases;
}

/** A demo already shown to the customer — what `approveDemo` needs to find. */
const shownDemo = (phaseId: string) =>
  prisma.demo.create({ data: { kind: 'SITE', projectId: f.contract.projectId, contractId: f.contract.id, phaseId, stagingUrl: 'https://nahal.staging.test', publishedAt: new Date() } });

// ---- an item in more than one phase --------------------------------------------------

test('an item in two phases: phaseId is the last, the join rows are both, and Phase.scopeItems lists it on each', async () => {
  const p = await drafting();
  const home = await item('home');
  // Handed over in the wrong order on purpose: the last is the highest-numbered, not the last given.
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.last, p.build] } }));
  const after = await prisma.scopeItem.findUniqueOrThrow({ where: { id: home.id }, include: { phaseLinks: true } });
  assert.equal(after.phaseId, p.last);
  assert.deepEqual(after.phaseLinks.map((l) => l.phaseId).sort(), [p.build, p.last].sort());

  const r = await read();
  const listed = (n: number) => r.phases.find((x) => x.number === n)!.scopeItems.map((s) => s.key);
  assert.deepEqual([listed(1), listed(2), listed(3)], [[], ['home'], ['home']]);
  const wireData = ok(await exec('query($c: ID!){ contract(id: $c) { scopeItems { key phaseId phaseIds } } }', { as: staff.SALES, variables: { c: f.contract.id } }));
  const wire = (wireData.contract as { scopeItems: Array<{ key: string; phaseId: string | null; phaseIds: string[] }> }).scopeItems;
  const w = wire.find((s) => s.key === 'home')!;
  assert.equal(w.phaseId, p.last);
  assert.deepEqual([...w.phaseIds].sort(), [p.build, p.last].sort());

  // Replacing the set is replacing: take it out of the later phase, and phaseId falls back.
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.build] } }));
  assert.equal((await item('home')).phaseId, p.build);
  assert.equal(await prisma.scopeItemPhase.count({ where: { scopeItemId: home.id } }), 1);
  // …and the empty set is no phase at all.
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [] } }));
  assert.equal((await item('home')).phaseId, null);
  assert.equal(await prisma.scopeItemPhase.count({ where: { scopeItemId: home.id } }), 0);
});

test('the older single-phase mutation still works, through the same writer: the item ends up in exactly that phase', async () => {
  const p = await drafting();
  const home = await item('home');
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.kick, p.build] } }));
  ok(await exec(ASSIGN, { as: staff.SALES, variables: { i: home.id, p: p.last } }));
  const after = await prisma.scopeItem.findUniqueOrThrow({ where: { id: home.id }, include: { phaseLinks: true } });
  assert.deepEqual([after.phaseId, after.phaseLinks.map((l) => l.phaseId)], [p.last, [p.last]]);
  ok(await exec(ASSIGN, { as: staff.SALES, variables: { i: home.id, p: null } }));
  assert.equal((await item('home')).phaseId, null);
});

test('setScopeItemPhases refuses a phase of another project, and a stranger', async () => {
  const p = await drafting();
  const home = await item('home');
  const otherProject = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'دیگر', titleEn: 'Other', status: 'ACTIVE' } });
  const otherContract = await prisma.contract.create({
    data: { ref: 'RC-OTHER', titleFa: 'ج', titleEn: 'o', customerId: f.customer.id, projectId: otherProject.id, status: 'WAITING_ON_CUSTOMER' },
  });
  const foreign = await prisma.phase.create({ data: { projectId: otherProject.id, contractId: otherContract.id, number: 1, titleFa: 'ف', titleEn: 'F' } });
  assert.equal((await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.build, foreign.id] } })).code, 'PHASE_WRONG_PROJECT');
  assert.equal((await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: ['nope'] } })).code, 'NOT_FOUND');
  assert.equal((await exec(SET_PHASES, { as: f.customer, variables: { i: home.id, p: [p.build] } })).code, 'FORBIDDEN');
  assert.deepEqual((await item('home')).phaseId, null, 'a refused call changed nothing');
});

test('deleting a phase re-derives phaseId from the phases the item is still in', async () => {
  const p = await drafting();
  const home = await item('home');
  const about = await item('about');
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.kick, p.build] } }));
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: about.id, p: [p.build] } }));
  // The plan names the kick-off and last phases; the build phase is free to go.
  ok(await exec(DELETE_PHASE, { as: staff.SALES, variables: { p: p.build } }));
  assert.equal((await item('home')).phaseId, p.kick, 'still in the kick-off phase: that is now its last');
  assert.equal((await item('about')).phaseId, null, 'in no phase any more');
  assert.equal(await prisma.scopeItemPhase.count({ where: { phaseId: p.build } }), 0);
});

test('approving an earlier phase sends an IN_DEMO item that is fixed in a later one back to IN_BUILD; the last phase accepts it', async () => {
  const p = await signedContract();
  const home = await item('home');
  const about = await item('about');
  // home is shown in the built phase and fixed in the last; about is in the built phase alone.
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.build, p.last] } }));
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: about.id, p: [p.build] } }));
  await prisma.scopeItem.updateMany({ where: { id: { in: [home.id, about.id] } }, data: { status: 'IN_DEMO' } });
  // …and one that was only AGREED, in both: not shown yet, so approving the earlier phase leaves it exactly as it was.
  const third = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'third', kind: 'FEATURE', status: 'AGREED', labelFa: 'س', labelEn: 'Third' },
  });
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: third.id, p: [p.build, p.last] } }));

  await shownDemo(p.build);
  ok(await exec(APPROVE_DEMO, { as: f.customer, variables: { c: f.contract.id, p: p.build } }));
  assert.equal((await item('about')).status, 'ACCEPTED', 'its last phase is the one approved');
  assert.equal((await item('home')).status, 'IN_BUILD', 'shown here, fixed in the next');
  assert.equal((await item('third')).status, 'AGREED');

  // The developer ships it again in the last phase, and the customer approves that.
  await prisma.scopeItem.update({ where: { id: home.id }, data: { status: 'IN_DEMO' } });
  await shownDemo(p.last);
  ok(await exec(APPROVE_DEMO, { as: f.customer, variables: { c: f.contract.id, p: p.last } }));
  assert.equal((await item('home')).status, 'ACCEPTED');
  assert.equal((await item('third')).status, 'ACCEPTED', 'agreed items are accepted by their last phase');
});

test('approveDemo’s staff mail links to the phase’s Demo step, not to the Phases tab', async () => {
  const p = await signedContract();
  await shownDemo(p.build);
  ok(await exec(APPROVE_DEMO, { as: f.customer, variables: { c: f.contract.id, p: p.build } }));
  const bodies = mail.map((m) => m.text ?? '').join('\n');
  assert.ok(bodies.includes(`/desk/contracts/${f.contract.id}/steps?step=DEMO&phase=${p.build}`), bodies);
  assert.ok(!bodies.includes('/phases'), 'the old link is gone');
});

// ---- a phase with no demo --------------------------------------------------------------

test('"Has a demo" is a switch on the phase row: a phase without one has no DEMO step', async () => {
  const p = await drafting();
  const road = (await read()).wizard.filter((w) => w.step === 'DEMO').map((w) => w.phaseId);
  assert.deepEqual(road, [p.build, p.last], 'the kick-off phase has none');
  // Turn it on, and the step appears; off again, and it goes.
  ok(await exec(UPDATE_PHASE, { as: staff.SALES, variables: { p: p.kick, d: true } }));
  assert.deepEqual((await read()).wizard.filter((w) => w.step === 'DEMO').map((w) => w.phaseId), [p.kick, p.build, p.last]);
  ok(await exec(UPDATE_PHASE, { as: staff.SALES, variables: { p: p.kick, d: false } }));
  // Omitted leaves it alone.
  ok(await exec('mutation($p: ID!){ updatePhase(phaseId: $p, titleFa: "ف", titleEn: "F") { id } }', { as: staff.SALES, variables: { p: p.kick } }));
  assert.equal((await prisma.phase.findUniqueOrThrow({ where: { id: p.kick } })).hasDemo, false);
});

test('the switch is behind the PHASES lock; marking done is not', async () => {
  const p = await signedContract();
  assert.equal((await exec(UPDATE_PHASE, { as: staff.SALES, variables: { p: p.kick, d: true } })).code, 'STEP_LOCKED');
  ok(await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.kick } }));
});

test('markPhaseDone: refusals in order, then it finishes the phase, accepts its items, tells the customer once, and makes its invoice issuable', async () => {
  const p = await drafting();
  const about = await item('about');
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: about.id, p: [p.kick] } }));

  // Before the agreement is signed there is nothing to be done *of*.
  assert.equal((await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.kick } })).code, 'NOT_SIGNED');
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  mail.length = 0;

  // Who: not the customer, not a developer who is not this contract's, not a designer.
  assert.equal((await exec(MARK_DONE, { as: f.customer, variables: { p: p.kick } })).code, 'FORBIDDEN');
  assert.equal((await exec(MARK_DONE, { as: staff.DESIGNER, variables: { p: p.kick } })).code, 'FORBIDDEN');
  assert.equal((await exec(MARK_DONE, { as: staff.DEVELOPER2, variables: { p: p.kick } })).code, 'NOT_ASSIGNED');
  assert.equal((await exec(MARK_DONE, { as: staff.SALES, variables: { p: 'nope' } })).code, 'NOT_FOUND');
  // A phase with a demo is finished by the customer's approval, not by this.
  assert.equal((await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.build } })).code, 'PHASE_HAS_DEMO');
  assert.equal(mail.length, 0, 'a refusal tells nobody');

  // The first row waits on the kick-off phase.
  assert.deepEqual((await read()).paymentPlan.invoices.slice(0, 1).map((i) => [i.state, i.blockedBy]), [['NOT_YET_ISSUABLE', 'PHASE_NOT_ACCEPTED']]);
  assert.equal((await exec(ISSUE_PLANNED, { as: f.admin, variables: { p: (await read()).paymentPlan.invoices[0].id } })).code, 'PHASE_NOT_ACCEPTED');

  // The developer of the contract may do it too — the assignment edge.
  ok(await exec(MARK_DONE, { as: staff.DEVELOPER, variables: { p: p.kick } }));
  const phase = await prisma.phase.findUniqueOrThrow({ where: { id: p.kick } });
  assert.ok(phase.doneAt);
  assert.equal(phase.doneById, staff.DEVELOPER.id);
  assert.equal((await item('about')).status, 'ACCEPTED', 'its last phase finished');

  // The customer is told once, in their language.
  const told = mail.filter((m) => m.to === 'customer@test.local');
  assert.equal(told.length, 1);
  assert.ok(told[0].subject.includes('انجام شد'), told[0].subject);

  // Idempotent refusal, and no second mail.
  assert.equal((await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.kick } })).code, 'PHASE_DONE');
  assert.equal(mail.filter((m) => m.to === 'customer@test.local').length, 1);

  // The rule has one answer everywhere: the phase reads finished, and the invoice is issuable.
  const after = await read(f.customer);
  assert.equal(after.phases.find((x) => x.id === p.kick)!.finished, true);
  assert.equal(after.phases.find((x) => x.id === p.build)!.finished, false);
  const plan = (await read()).paymentPlan.invoices;
  assert.deepEqual([plan[0].state, plan[0].blockedBy], ['ISSUABLE', null]);
  ok(await exec(ISSUE_PLANNED, { as: f.admin, variables: { p: plan[0].id } }));
});

test('the close waits for a no-demo phase to be marked done, like every other phase', async () => {
  const p = await signedContract();
  await prisma.stepApproval.createMany({
    data: [p.build, p.last].map((phaseId) => ({ contractId: f.contract.id, step: 'DEMO' as const, phaseId, approvedById: f.customer.id })),
  });
  const refused = await exec(CLOSE, { as: staff.SALES, variables: { c: f.contract.id } });
  assert.equal(refused.code, 'PHASES_NOT_ACCEPTED');
  ok(await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.kick } }));
  // Past the phases; the deliverables are the next refusal's, or none.
  const next = await exec(CLOSE, { as: staff.SALES, variables: { c: f.contract.id } });
  assert.notEqual(next.code, 'PHASES_NOT_ACCEPTED');
});

// ---- "due on a date" -----------------------------------------------------------------------

test('a planned invoice due on a date is not issuable before that day — staff issue it on or after', async () => {
  const p = await signedContract();
  ok(await exec(MARK_DONE, { as: staff.SALES, variables: { p: p.kick } }));
  const rows = (await read()).paymentPlan.invoices;
  ok(await exec(ISSUE_PLANNED, { as: f.admin, variables: { p: rows[0].id } }));
  await prisma.billingEntry.updateMany({ where: { plannedInvoiceId: rows[0].id }, data: { paidAt: new Date() } });

  // Tomorrow: not yet.
  await prisma.plannedInvoice.update({ where: { id: rows[1].id }, data: { dueOn: new Date(`${dayOf(1)}T00:00:00Z`) } });
  let second = (await read()).paymentPlan.invoices[1];
  assert.deepEqual([second.state, second.blockedBy], ['NOT_YET_ISSUABLE', 'DATE_NOT_REACHED']);
  assert.equal(second.dueOn?.slice(0, 10), dayOf(1));
  assert.equal((await exec(ISSUE_PLANNED, { as: f.admin, variables: { p: rows[1].id } })).code, 'DATE_NOT_REACHED');

  // Today: the day itself counts.
  await prisma.plannedInvoice.update({ where: { id: rows[1].id }, data: { dueOn: new Date(`${dayOf(0)}T00:00:00Z`) } });
  second = (await read()).paymentPlan.invoices[1];
  assert.deepEqual([second.state, second.blockedBy], ['ISSUABLE', null]);
  ok(await exec(ISSUE_PLANNED, { as: f.admin, variables: { p: rows[1].id } }));
});

test('the plan editor’s refusals: a phase and a date together, and a date that is not one', async () => {
  const p = await drafting();
  const both = planRows(p, [{ dueOn: onDay('2026-12-01') }]);
  assert.equal((await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: both } })).code, 'PHASE_AND_DATE');
  const bad = planRows(p, [{}, { dueOn: '2026-02-30' }]);
  assert.equal((await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: bad } })).code, 'INVALID_DATE');
  // The good plan is stored with its day.
  const stored = await prisma.plannedInvoice.findMany({ where: { plan: { contractId: f.contract.id } }, orderBy: { ordinal: 'asc' } });
  assert.deepEqual(stored.map((r) => r.dueOn?.toISOString().slice(0, 10) ?? null), [null, onDay('2026-12-01'), null]);
});

test('CHECK PlannedInvoice_phase_xor_date: a row is due on a phase or on a date, never both — by a direct insert', async () => {
  const p = await drafting();
  const plan = await prisma.paymentPlan.findFirstOrThrow({ where: { contractId: f.contract.id } });
  const base = { planId: plan.id, labelFa: 'ا', labelEn: 'a', amount: 1n, paymentTermDays: 0 };
  await assert.rejects(
    prisma.plannedInvoice.create({ data: { ...base, ordinal: 10, phaseId: p.build, dueOn: new Date('2027-01-01T00:00:00Z') } }),
    /PlannedInvoice_phase_xor_date/,
  );
  // Either alone, and neither, pass — and an UPDATE is held to it too.
  await prisma.plannedInvoice.create({ data: { ...base, ordinal: 11, phaseId: p.build } });
  await prisma.plannedInvoice.create({ data: { ...base, ordinal: 12, dueOn: new Date('2027-01-01T00:00:00Z') } });
  const neither = await prisma.plannedInvoice.create({ data: { ...base, ordinal: 13 } });
  await assert.rejects(
    prisma.plannedInvoice.update({ where: { id: neither.id }, data: { phaseId: p.build, dueOn: new Date('2027-01-01T00:00:00Z') } }),
    /PlannedInvoice_phase_xor_date/,
  );
});

// ---- snapshot format 3 --------------------------------------------------------------------------

test('a fresh publish writes format 3, and it reads back: the switch, the item’s phases and the row’s day', async () => {
  const p = await drafting();
  const home = await item('home');
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: home.id, p: [p.last, p.build] } }));
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));

  const stored = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id }, orderBy: { version: 'desc' } });
  const snapshot = readContractSnapshot(stored.snapshot);
  assert.equal(snapshot?.format, FORMAT_3);
  assert.equal(stored.contentHash, contentHash(snapshot!), 'the sealed hash is the stored bytes’');

  const r = await read(f.customer);
  assert.equal(r.revision?.format, 3);
  assert.deepEqual(r.revision?.agreement.phases.map((x) => [x.number, x.hasDemo]), [[1, false], [2, true], [3, true]]);
  assert.deepEqual(r.revision?.agreement.paymentPlan.invoices.map((i) => [i.ordinal, i.dueOn?.slice(0, 10) ?? null]), [[1, null], [2, onDay('2026-12-01')], [3, null]]);
  assert.deepEqual(r.agreedScopeItems.find((s) => s.key === 'home')?.phases, [2, 3]);
  assert.deepEqual(r.agreedScopeItems.find((s) => s.key === 'about')?.phases, []);
});

test('changing only an item’s phases makes the published draft dirty — they are part of what was agreed', async () => {
  const p = await drafting();
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
  const dirty = async () =>
    (ok(await exec('query($c: ID!){ contract(id: $c) { draft { dirty } } }', { as: staff.SALES, variables: { c: f.contract.id } })).contract as { draft: { dirty: boolean } }).draft.dirty;
  assert.equal(await dirty(), false);
  ok(await exec(SET_PHASES, { as: staff.SALES, variables: { i: (await item('home')).id, p: [p.build] } }));
  assert.equal(await dirty(), true);
});

test('a stored format-2 snapshot keeps its bytes and its hash through Postgres, and still reads as the agreement', async () => {
  // J7’s snapshot as it was written, frozen (the same literal `revision.test.ts` holds, there against the pure code).
  const stored = {
    allowances: { demoIterationsPerPhase: 2, mockupIterations: null, premadeRounds: 2, wireframeIterations: 2 },
    amount: '180',
    articles: [{ bodyEn: null, bodyFa: null, number: 1, sensitive: false, titleEn: 'Article 1', titleFa: 'ماده 1' }],
    brief: { budgetCap: '180000000', contentProvidedBy: 'CUSTOMER', designTier: 'THEME_PICK', domainName: 'nahal.ir', domainProvidedBy: 'CUSTOMER', existingSiteUrl: null, hardDeadline: '2026-10-23', hostProvidedBy: 'ROOT', idealDeadline: null, kind: 'NEW_SITE', supportMonths: 6, templateType: { labelEn: 'Store', labelFa: 'فروشگاهی', slug: 'store' } },
    format: 2,
    paymentPlan: { invoices: [{ amount: '100', labelEn: 'A', labelFa: 'الف', ordinal: 1, paymentTermDays: 0, phaseNumber: 1 }, { amount: '80', labelEn: 'B', labelFa: 'ب', ordinal: 2, paymentTermDays: 7, phaseNumber: null }], split: 'INSTALLMENTS' },
    phases: [{ milestoneLabel: 'M1', number: 1, plannedEndAt: '2026-11-10', titleEn: 'One', titleFa: 'یک' }, { milestoneLabel: null, number: 2, plannedEndAt: null, titleEn: 'Two', titleFa: 'دو' }],
    plannedEndAt: '2026-12-20',
    plannedStartAt: '2026-10-12',
    ref: 'RC-7',
    scopeItems: [{ key: 'home', kind: 'PAGE', labelEn: 'Home', labelFa: 'خانه' }],
    titleEn: 't',
    titleFa: 'ت',
  };
  const HASH = '5e171bf6204b95ebf8896cecb5b39817edb58f80cf504f1ffbb9c9967cc19c0c';
  await prisma.contractRevision.update({ where: { id: f.contractRevision.id }, data: { snapshot: stored, contentHash: HASH } });
  // JSONB does not keep key order: this is the read path a signed contract really takes.
  const back = await prisma.contractRevision.findUniqueOrThrow({ where: { id: f.contractRevision.id } });
  const snapshot = readContractSnapshot(back.snapshot);
  assert.equal(snapshot?.format, 2);
  assert.equal(contentHash(snapshot!), HASH);
  const r = await read(f.customer);
  assert.equal(r.revision?.format, 2);
  assert.deepEqual(r.revision?.agreement.phases.map((x) => x.hasDemo), [null, null], 'format 2 did not say');
  assert.deepEqual(r.agreedScopeItems[0].phases, null);
});

// ---- DX2a's review ---------------------------------------------------------------------------------

test('design mutations are refused on a contract with no design (STEP_NOT_ON_ROAD), and still open on one that has it', async () => {
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: BRIEF() } }));
  const START = 'mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }';
  assert.equal((await exec(START, { as: staff.DESIGNER, variables: { c: f.contract.id } })).code, 'STEP_NOT_ON_ROAD');
  // With a design tier the same call gets as far as the next rule (the agreement is not signed yet).
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: { ...BRIEF(), designTier: 'THEME_PICK', premadeRounds: 2 } } }));
  assert.equal((await exec(START, { as: staff.DESIGNER, variables: { c: f.contract.id } })).code, 'AGREEMENT_NOT_SIGNED');
});
