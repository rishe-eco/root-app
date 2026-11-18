import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, seedHandoverTypes, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { CHECKLIST } from '../lib/templates.js';
import { onDay } from './calendar.js';

/**
 * DX6 — the founder's walk through the steps (2026-11-18).
 *
 * What the pure tables (`brief.test.ts`, `allowance.test.ts`) cannot show: the
 * zero CHECK by direct insert and a brief of zero allowances saved and read; the
 * budget and the fee as one number in both directions, and what a lock on the
 * step does to it; `COMMITMENT_UNDECIDED` in the completeness list and the
 * publish blockers; the desk's default list of extras (`ExtraType`), the
 * migration's seed and a contract made from the active rows; and an extra added
 * to one contract and removed again.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let typeId: string;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  typeId = (await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } })).id;
  await seedHandoverTypes();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const DEP = 'id side dueAt notNeeded inBrief briefKey';
const SET_BRIEF = `mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) {
  id draft { amount } brief { budgetCap premadeRounds wireframeIterations mockupIterations demoIterationsPerPhase } briefCompleteness { code key } handover { ${DEP} } } }`;
const UPDATE_DRAFT = `mutation($c: ID!, $fa: String!, $en: String!, $a: String){
  updateContractDraft(contractId: $c, titleFa: $fa, titleEn: $en, amount: $a) { id draft { amount } brief { budgetCap } } }`;
const UPDATE_DEP = `mutation($d: ID!, $side: DependencySide, $due: DateTime, $nn: Boolean){
  updateDependency(dependencyId: $d, side: $side, dueAt: $due, notNeeded: $nn) { id } }`;
const BLOCKERS = `query($c: ID!){ contract(id: $c) { briefCompleteness { code key } publishBlockers { code step count } } }`;

type Completeness = Array<{ code: string; key: string | null }>;
const briefInput = (over: Record<string, unknown> = {}) => ({
  kind: 'NEW_SITE',
  templateTypeId: typeId,
  designTier: 'THEME_PICK',
  budgetCap: '150000000',
  hardDeadline: onDay('2026-10-23'),
  supportMonths: 6,
  premadeRounds: 2,
  demoIterationsPerPhase: 2,
  ...over,
});
const setBrief = (over: Record<string, unknown> = {}) =>
  exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: briefInput(over) } });
const updateDraft = (amount: string | null) =>
  exec(UPDATE_DRAFT, { as: staff.SALES, variables: { c: f.contract.id, fa: 'عنوان', en: 'Title', a: amount } });
const feeInDb = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).amount;
const budgetInDb = async () => (await prisma.contractBrief.findUnique({ where: { contractId: f.contract.id } }))?.budgetCap ?? null;
const lock = () => prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });

// =================================================================================
// 1. zero is a valid count
// =================================================================================

test('ContractBrief_allowances_not_negative: zero is allowed and below zero is not — each of the four, by direct insert', async () => {
  const row = (over: Record<string, unknown>) => ({ contractId: f.contract.id, kind: 'NEW_SITE' as const, templateTypeId: typeId, designTier: 'THEME_PICK' as const, ...over });
  for (const column of ['premadeRounds', 'wireframeIterations', 'mockupIterations', 'demoIterationsPerPhase']) {
    await assert.rejects(
      () => prisma.contractBrief.create({ data: row({ [column]: -1 }) }),
      /ContractBrief_allowances_not_negative/,
      `${column} = -1`,
    );
    await assert.doesNotReject(() => prisma.contractBrief.create({ data: row({ [column]: 0 }) }), `${column} = 0`);
    await prisma.contractBrief.deleteMany();
  }
  // The old constraint is gone, not just joined by a new one.
  const [{ n }] = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'ContractBrief_allowances_positive'`;
  assert.equal(Number(n), 0);
});

test('a brief of zero rounds is saved and read back as zero, and none of the allowance gaps is reported', async () => {
  const brief = ok(await setBrief({ premadeRounds: 0, wireframeIterations: 0, mockupIterations: 0, demoIterationsPerPhase: 0 })).setBrief as {
    brief: Record<string, number | null>;
    briefCompleteness: Completeness;
  };
  assert.deepEqual([brief.brief.premadeRounds, brief.brief.wireframeIterations, brief.brief.mockupIterations, brief.brief.demoIterationsPerPhase], [0, 0, 0, 0]);
  const codes = brief.briefCompleteness.map((m) => m.code);
  for (const gap of ['PREMADE_ROUNDS', 'MOCKUP_ITERATIONS', 'DEMO_ITERATIONS']) assert.ok(!codes.includes(gap), `0 is not unset (${gap})`);
  // Still refused below zero.
  assert.equal((await setBrief({ premadeRounds: -1 })).code, 'INVALID_ALLOWANCE');
});

// =================================================================================
// 3. the budget and the fee are one number
// =================================================================================

test('saving the brief’s budget sets the contract’s fee', async () => {
  const r = ok(await setBrief({ budgetCap: '150000000' })).setBrief as { draft: { amount: string } };
  assert.equal(r.draft.amount, '150000000');
  assert.equal(await feeInDb(), 150_000_000n);
  ok(await setBrief({ budgetCap: '90000000' }));
  assert.equal(await feeInDb(), 90_000_000n);
});

test('saving the fee on the Contract tab sets the brief’s budget — and with no brief yet it only sets the fee', async () => {
  ok(await updateDraft('70000000'));
  assert.equal(await feeInDb(), 70_000_000n);
  assert.equal(await budgetInDb(), null, 'no brief: nothing to write');

  ok(await setBrief({ budgetCap: '1' }));
  const r = ok(await updateDraft('80000000')).updateContractDraft as { draft: { amount: string }; brief: { budgetCap: string } };
  assert.equal(r.brief.budgetCap, '80000000');
  assert.equal(await budgetInDb(), 80_000_000n);
  assert.equal(await feeInDb(), 80_000_000n);
});

test('clearing one side does not clear the other; a brief made after the fee starts from it', async () => {
  ok(await updateDraft('70000000'));
  // The first brief, budget left blank: it takes the fee.
  ok(await setBrief({ budgetCap: null }));
  assert.equal(await budgetInDb(), 70_000_000n);
  // Cleared again: the brief forgets, the price stays.
  ok(await setBrief({ budgetCap: null }));
  assert.equal(await budgetInDb(), null);
  assert.equal(await feeInDb(), 70_000_000n);
  // And a cleared fee leaves the budget.
  ok(await setBrief({ budgetCap: '60000000' }));
  ok(await updateDraft(null));
  assert.equal(await budgetInDb(), 60_000_000n);
});

test('a lock on the agreement stops both writes, and neither moves the other number', async () => {
  ok(await setBrief({ budgetCap: '100' }));
  await lock();
  assert.equal((await setBrief({ budgetCap: '200' })).code, 'STEP_LOCKED');
  assert.equal((await updateDraft('300')).code, 'STEP_LOCKED');
  assert.equal(await feeInDb(), 100n);
  assert.equal(await budgetInDb(), 100n);
});

test('a contract with no brief on the road (the legacy one) takes a fee as it always did', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  ok(await updateDraft('5000'));
  assert.equal(await feeInDb(), 5000n);
});

// =================================================================================
// 4. dependencies are decided before the contract goes out
// =================================================================================

test('COMMITMENT_UNDECIDED: a row in the brief with no side blocks the step and the publish; a side without a date is UNDATED; a decided row clears', async () => {
  const made = ok(await setBrief()).setBrief as { briefCompleteness: Completeness; handover: Array<{ id: string; briefKey: string }> };
  const undecided = made.briefCompleteness.filter((m) => m.code === 'COMMITMENT_UNDECIDED').map((m) => m.key).sort();
  assert.deepEqual(undecided, ['content', 'domain', 'host']);
  assert.ok(!made.briefCompleteness.some((m) => m.code === 'COMMITMENT_UNDATED'));
  let read = ok(await exec(BLOCKERS, { as: staff.SALES, variables: { c: f.contract.id } })).contract as { publishBlockers: Array<{ code: string; step: string; count: number }> };
  const brief = read.publishBlockers.find((b) => b.code === 'BRIEF_INCOMPLETE');
  assert.ok(brief, 'the publish gate names the brief');
  assert.equal(brief.step, 'REQUIREMENTS');

  const row = (key: string) => made.handover.find((h) => h.briefKey === key)!.id;
  const update = async (key: string, vars: Record<string, unknown>) =>
    ok(await exec(UPDATE_DEP, { as: staff.SALES, variables: { d: row(key), ...vars } }));
  const codes = async () =>
    ((ok(await exec(BLOCKERS, { as: staff.SALES, variables: { c: f.contract.id } })).contract as { briefCompleteness: Completeness }).briefCompleteness).map((m) => `${m.code}:${m.key}`).sort();

  await update('domain', { side: 'CUSTOMER' });
  await update('host', { nn: true });
  await update('content', { side: 'ROOT' });
  assert.deepEqual(await codes(), ['COMMITMENT_UNDATED:content', 'COMMITMENT_UNDATED:domain']);

  await update('domain', { due: onDay('2026-10-20') + 'T00:00:00.000Z' });
  await update('content', { due: onDay('2026-10-21') + 'T00:00:00.000Z' });
  assert.deepEqual(await codes(), []);
  read = ok(await exec(BLOCKERS, { as: staff.SALES, variables: { c: f.contract.id } })).contract as { publishBlockers: Array<{ code: string; step: string; count: number }> };
  assert.ok(!read.publishBlockers.some((b) => b.code === 'BRIEF_INCOMPLETE'));
});

// =================================================================================
// 7. extras: the desk's default list, and one-offs
// =================================================================================

const CREATE = `mutation($i: CreateContractInput!){ createContract(input: $i) { id scopeItems { key kind status labelEn position } } }`;
const create = () => exec(CREATE, { as: staff.SALES, variables: { i: { customerId: f.customer.id, titleFa: 'ق', titleEn: 'C' } } });
type Made = { id: string; scopeItems: Array<{ key: string; kind: string; status: string; labelEn: string }> };

test('the migration seeds the extras list from CHECKLIST, in order — one list, two copies, pinned together', () => {
  const sql = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261118124529_dx6_extras/migration.sql', import.meta.url)), 'utf8');
  const seeded = [...sql.matchAll(/\('extra_type_\w+', '(checklist\.\w+)', '([^']+)', '([^']+)', (\d+)\)/g)].map((m) => [m[1], m[2], m[3], Number(m[4])]);
  assert.deepEqual(
    seeded,
    CHECKLIST.map(([key, fa, en], i) => [key, fa, en, i]),
  );
});

test('a new contract’s extras are the active rows of the desk’s list, declined, in order; editing the list leaves a made contract alone', async () => {
  assert.equal(await prisma.extraType.count(), CHECKLIST.length, 'the reset puts the seeded list back');
  const first = ok(await create()).createContract as Made;
  assert.deepEqual(
    first.scopeItems.map((i) => i.key),
    CHECKLIST.map(([key]) => key),
  );
  assert.ok(first.scopeItems.every((i) => i.kind === 'EXTRA' && i.status === 'DECLINED'));

  // Switch one off, add one, rename one — through the desk's own mutations.
  const list = ok(await exec('query{ extraTypes { id key labelEn position active } }', { as: staff.SALES })).extraTypes as Array<{ id: string; key: string; active: boolean }>;
  ok(await exec('mutation($i: ID!){ updateExtraType(id: $i, active: false) { id } }', { as: staff.SALES, variables: { i: list.find((x) => x.key === 'checklist.analytics')!.id } }));
  ok(await exec('mutation($i: ID!){ updateExtraType(id: $i, labelEn: "Sign-in") { id labelEn } }', { as: staff.SALES, variables: { i: list.find((x) => x.key === 'checklist.auth')!.id } }));
  const added = ok(await exec('mutation{ createExtraType(slug: "chat", labelFa: "گفتگو", labelEn: "Live chat") { key position active } }', { as: staff.SALES })).createExtraType as { key: string; position: number };
  assert.deepEqual([added.key, added.position], ['checklist.chat', CHECKLIST.length]);

  const second = ok(await create()).createContract as Made;
  assert.deepEqual(
    second.scopeItems.map((i) => i.key),
    [...CHECKLIST.map(([key]) => key).filter((k) => k !== 'checklist.analytics'), 'checklist.chat'],
  );
  assert.equal(second.scopeItems.find((i) => i.key === 'checklist.auth')!.labelEn, 'Sign-in');
  // The first contract keeps what it had.
  const kept = await prisma.scopeItem.findMany({ where: { contractId: first.id } });
  assert.equal(kept.length, CHECKLIST.length);
  assert.equal(kept.find((i) => i.key === 'checklist.auth')!.labelEn, 'Authentication');
});

test('the extras list: a slug is checked, a key is taken once, both names are required, the order is the whole list, sales only', async () => {
  const mk = (slug: string, fa = 'ا', en = 'A', as: User = staff.SALES) =>
    exec('mutation($s: String!, $fa: String!, $en: String!){ createExtraType(slug: $s, labelFa: $fa, labelEn: $en) { id } }', { as, variables: { s: slug, fa, en } });
  assert.equal((await mk('Bad Slug')).code, 'INVALID_SLUG');
  assert.equal((await mk('auth')).code, 'EXTRA_KEY_TAKEN', 'checklist.auth exists');
  assert.equal((await mk('chat', ' ', 'Chat')).code, 'LABEL_REQUIRED');
  assert.equal((await mk('chat', 'گ', 'Chat', staff.DESIGNER)).code, 'FORBIDDEN');
  assert.equal((await exec('mutation{ updateExtraType(id: "nope", active: false) { id } }', { as: staff.SALES })).code, 'NOT_FOUND');

  const ids = (await prisma.extraType.findMany({ orderBy: { position: 'asc' }, select: { id: true } })).map((x) => x.id);
  assert.equal((await exec('mutation($i: [ID!]!){ reorderExtraTypes(ids: $i) { id } }', { as: staff.SALES, variables: { i: ids.slice(1) } })).code, 'REORDER_MISMATCH');
  const reversed = [...ids].reverse();
  const out = ok(await exec('mutation($i: [ID!]!){ reorderExtraTypes(ids: $i) { id key } }', { as: staff.SALES, variables: { i: reversed } })).reorderExtraTypes as Array<{ id: string }>;
  assert.deepEqual(out.map((x) => x.id), reversed);
});

test('a one-off extra is added to one contract and removed again; a seeded one is switched off, not deleted', async () => {
  const made = ok(await create()).createContract as Made;
  const ADD = `mutation($c: ID!, $fa: String!, $en: String!){ addScopeItem(contractId: $c, labelFa: $fa, labelEn: $en, kind: EXTRA) { scopeItems { id key kind status labelEn contractId } } }`;
  const added = ok(await exec(ADD, { as: staff.SALES, variables: { c: made.id, fa: 'نسخه‌ی پشتیبان', en: 'Nightly backups' } })).addScopeItem as {
    scopeItems: Array<{ id: string; key: string; kind: string; status: string; labelEn: string; contractId: string }>;
  };
  const one = added.scopeItems.find((i) => i.labelEn === 'Nightly backups')!;
  assert.deepEqual([one.key, one.kind, one.status, one.contractId], ['custom.1', 'EXTRA', 'AGREED', made.id]);
  assert.equal(await prisma.extraType.count({ where: { key: 'custom.1' } }), 0, 'it is not on the desk’s list');

  const DELETE = `mutation($s: ID!, $c: ID){ deleteScopeItem(scopeItemId: $s, contractId: $c) { scopeItems { key } } }`;
  const after = ok(await exec(DELETE, { as: staff.SALES, variables: { s: one.id, c: made.id } })).deleteScopeItem as { scopeItems: Array<{ key: string }> };
  assert.ok(!after.scopeItems.some((i) => i.key === 'custom.1'));
  assert.equal(after.scopeItems.length, CHECKLIST.length);

  // A seeded extra goes through setExtra: on, then off again — the row stays.
  const seeded = await prisma.scopeItem.findFirstOrThrow({ where: { contractId: made.id, key: 'checklist.auth' } });
  const SET = `mutation($s: ID!, $on: Boolean!, $c: ID){ setExtra(scopeItemId: $s, included: $on, contractId: $c) { id } }`;
  ok(await exec(SET, { as: staff.SALES, variables: { s: seeded.id, on: true, c: made.id } }));
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: seeded.id } })).status, 'AGREED');
  ok(await exec(SET, { as: staff.SALES, variables: { s: seeded.id, on: false, c: made.id } }));
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: seeded.id } })).status, 'DECLINED');
});
