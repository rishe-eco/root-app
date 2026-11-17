import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, seedHandoverTypes, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { onDay } from './calendar.js';

/**
 * DX3c — duplicate a contract (desk UX review item 30). A signed contract with a
 * multi-phase item, a no-demo phase, a phase-triggered and a dated invoice and
 * handover rows is copied; the copy is a fresh unsigned draft with the brief,
 * the agreed scope, the phases, the plan and the handover rows, and none of the
 * dates or the history. The source is left exactly as it was.
 */

let f: Fixture;
let sales: User;
let designer: User;
let otherCustomer: User;
let phase1: string;
let phase2: string;
let phase3: string;

before(async () => {
  await resetDatabase();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  sales = await prisma.user.create({ data: { email: 'sales@test.local', name: 'Sales', roles: ['SALES'], state: 'ACTIVE' } });
  designer = await prisma.user.create({ data: { email: 'design@test.local', name: 'Designer', roles: ['DESIGNER'], state: 'ACTIVE' } });
  otherCustomer = await prisma.user.create({ data: { email: 'other@test.local', name: 'Other', roles: ['CUSTOMER'], state: 'ACTIVE' } });
  await seedHandoverTypes();
  const { id: contractId, projectId } = f.contract;
  await prisma.contract.update({ where: { id: contractId }, data: { amount: 90_000_000n } });
  const type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.contractBrief.create({
    data: {
      contractId,
      kind: 'NEW_SITE',
      templateTypeId: type.id,
      designTier: 'THEME_PICK',
      budgetCap: 150_000_000n,
      hardDeadline: new Date(`${onDay('2026-10-23')}T00:00:00Z`),
      domainName: 'nahal.ir',
      supportMonths: 6,
      premadeRounds: 2,
    },
  });
  const mk = (number: number, hasDemo: boolean, over: Record<string, unknown> = {}) =>
    prisma.phase.create({
      data: { projectId, contractId, number, titleFa: `فاز ${number}`, titleEn: `Phase ${number}`, hasDemo, ...over },
    });
  phase1 = (await mk(1, true, { milestoneLabel: 'First look', plannedEndAt: new Date(`${onDay('2026-10-20')}T00:00:00Z`) })).id;
  phase2 = (await mk(2, false)).id;
  phase3 = (await mk(3, true, { doneAt: new Date(), doneById: f.admin.id })).id;

  const item = (key: string, status: 'AGREED' | 'ACCEPTED' | 'PROPOSED' | 'DECLINED' | 'TRADED', extra: Record<string, unknown> = {}) =>
    prisma.scopeItem.create({
      data: { projectId, contractId, key, kind: 'PAGE', labelFa: `ص ${key}`, labelEn: key, status, ...extra },
    });
  const cart = await item('cart', 'ACCEPTED', { position: 1, adminWork: true });
  await item('home', 'AGREED', { position: 0 });
  await item('wish', 'PROPOSED');
  await item('blog', 'DECLINED');
  await item('old', 'TRADED');
  await item('checklist.auth', 'AGREED', { kind: 'EXTRA' });
  await prisma.scopeItemPhase.createMany({
    data: [
      { scopeItemId: cart.id, phaseId: phase1 },
      { scopeItemId: cart.id, phaseId: phase3 },
    ],
  });
  await prisma.scopeItem.update({ where: { id: cart.id }, data: { phaseId: phase3 } });

  const plan = await prisma.paymentPlan.create({ data: { contractId, split: 'INSTALLMENTS' } });
  await prisma.plannedInvoice.createMany({
    data: [
      { planId: plan.id, ordinal: 1, labelFa: 'پیش', labelEn: 'Deposit', amount: 30_000_000n, paymentTermDays: 7 },
      { planId: plan.id, ordinal: 2, labelFa: 'فاز ۲', labelEn: 'Phase 2', amount: 30_000_000n, phaseId: phase2, paymentTermDays: 14 },
      { planId: plan.id, ordinal: 3, labelFa: 'روز', labelEn: 'On a day', amount: 30_000_000n, dueOn: new Date(`${onDay('2026-11-20')}T00:00:00Z`), paymentTermDays: 0 },
    ],
  });
  await prisma.dependency.createMany({
    data: [
      { projectId, titleFa: 'دامنه', titleEn: 'Domain', briefKey: 'domain', inBrief: true, side: 'CUSTOMER', technical: true, dueAt: new Date(`${onDay('2026-10-10')}T00:00:00Z`), verifiedAt: new Date(), verifiedById: f.admin.id, verifiedNote: 'ok', createdById: f.admin.id },
      { projectId, titleFa: 'محتوا', titleEn: 'Content', briefKey: 'content', inBrief: true, side: 'ROOT', notNeeded: true, createdById: f.admin.id },
      { projectId, titleFa: 'تخته', titleEn: 'Board only', inBrief: false, side: 'ROOT', dueAt: new Date(`${onDay('2026-10-12')}T00:00:00Z`), createdById: f.admin.id },
    ],
  });
  const revision = await prisma.contractRevision.findFirstOrThrow({ where: { contractId } });
  await prisma.signature.create({ data: { contractRevisionId: revision.id, signerId: f.customer.id, typedName: 'Nahal', signedHash: revision.contentHash } });
});

const DUP = `mutation($c: ID!, $u: ID!, $fa: String!, $en: String!){ duplicateContract(contractId: $c, customerId: $u, titleFa: $fa, titleEn: $en) { id ref titleEn amount customer { id } } }`;
const dup = (as: User | undefined, over: Record<string, unknown> = {}) =>
  exec(DUP, { as, variables: { c: f.contract.id, u: f.customer.id, fa: 'کپی', en: 'Copy of Nahal', ...over } });

async function snapshotOfSource() {
  const id = f.contract.id;
  return JSON.stringify(
    await Promise.all([
      prisma.contract.findUnique({ where: { id } }),
      prisma.phase.findMany({ where: { contractId: id }, orderBy: { number: 'asc' } }),
      prisma.scopeItem.findMany({ where: { projectId: f.contract.projectId }, orderBy: { key: 'asc' } }),
      prisma.scopeItemPhase.findMany({ where: { scopeItem: { projectId: f.contract.projectId } }, orderBy: [{ scopeItemId: 'asc' }, { phaseId: 'asc' }] }),
      prisma.plannedInvoice.findMany({ where: { plan: { contractId: id } }, orderBy: { ordinal: 'asc' } }),
      prisma.dependency.findMany({ where: { projectId: f.contract.projectId }, orderBy: { titleEn: 'asc' } }),
      prisma.signature.count({ where: { contractRevision: { contractId: id } } }),
      prisma.changeLog.count({ where: { contractId: id } }),
    ]),
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}

test('the copy: unsigned, generated ref, a project of its own, price kept, one CREATED row', async () => {
  const before = await snapshotOfSource();
  const made = ok(await dup(sales)).duplicateContract as { id: string; ref: string; amount: string };
  assert.match(made.ref, /^R-\d{4}-\d{3}$/);
  assert.equal(made.amount, '90000000');
  const c = await prisma.contract.findUniqueOrThrow({ where: { id: made.id }, include: { project: true } });
  assert.notEqual(c.projectId, f.contract.projectId);
  assert.equal(c.status, 'DRAFT');
  assert.equal(c.titleEn, 'Copy of Nahal');
  assert.equal(c.project.titleEn, 'Copy of Nahal');
  assert.equal(c.designerId, null);
  assert.equal(await prisma.signature.count({ where: { contractRevision: { contractId: c.id } } }), 0);
  assert.equal(await prisma.contractRevision.count({ where: { contractId: c.id } }), 0);
  assert.equal(await prisma.article.count({ where: { contractId: c.id } }), 0);
  assert.equal(await prisma.stepApproval.count({ where: { contractId: c.id } }), 0);
  const logs = await prisma.changeLog.findMany({ where: { contractId: c.id } });
  assert.deepEqual(logs.map((l) => l.action), ['CREATED']);
  assert.equal(await snapshotOfSource(), before, 'the source is untouched');
});

test('the brief, the phases and the scope items come across; phases are mapped, dates are not copied', async () => {
  const made = ok(await dup(sales)).duplicateContract as { id: string };
  const brief = await prisma.contractBrief.findUniqueOrThrow({ where: { contractId: made.id } });
  const src = await prisma.contractBrief.findUniqueOrThrow({ where: { contractId: f.contract.id } });
  assert.equal(brief.domainName, 'nahal.ir');
  assert.equal(brief.budgetCap, 150_000_000n);
  assert.equal(brief.supportMonths, 6);
  assert.equal(brief.templateTypeId, src.templateTypeId);
  assert.deepEqual(brief.hardDeadline, src.hardDeadline);

  const phases = await prisma.phase.findMany({ where: { contractId: made.id }, orderBy: { number: 'asc' } });
  assert.deepEqual(phases.map((p) => [p.number, p.titleEn, p.hasDemo, p.milestoneLabel, p.plannedEndAt, p.doneAt]), [
    [1, 'Phase 1', true, 'First look', null, null],
    [2, 'Phase 2', false, null, null, null],
    [3, 'Phase 3', true, null, null, null],
  ]);
  assert.ok(phases.every((p) => ![phase1, phase2, phase3].includes(p.id)));

  const items = await prisma.scopeItem.findMany({
    where: { contractId: made.id, NOT: { key: { startsWith: 'checklist.' } } },
    orderBy: { position: 'asc' },
    include: { phaseLinks: true },
  });
  assert.deepEqual(items.map((i) => [i.key, i.status]), [['home', 'AGREED'], ['cart', 'AGREED']]);
  const cart = items[1]!;
  assert.equal(cart.adminWork, true);
  assert.deepEqual(cart.phaseLinks.map((l) => l.phaseId).sort(), [phases[0]!.id, phases[2]!.id].sort());
  assert.equal(cart.phaseId, phases[2]!.id, 'the acceptance phase is the highest-numbered of the set');
  assert.equal(cart.decidedAt, null);

  const checklist = await prisma.scopeItem.findMany({ where: { contractId: made.id, key: { startsWith: 'checklist.' } } });
  assert.equal(checklist.length, 10, 'the checklist is seeded once, not doubled');
  assert.ok(checklist.every((i) => i.status === 'DECLINED'));
});

test('the plan: phase triggers follow, the date trigger becomes on signing; handover rows lose their dates', async () => {
  const made = ok(await dup(sales)).duplicateContract as { id: string };
  const phases = await prisma.phase.findMany({ where: { contractId: made.id }, orderBy: { number: 'asc' } });
  const plan = await prisma.paymentPlan.findUniqueOrThrow({ where: { contractId: made.id }, include: { invoices: { orderBy: { ordinal: 'asc' } } } });
  assert.equal(plan.split, 'INSTALLMENTS');
  assert.deepEqual(
    plan.invoices.map((r) => [r.ordinal, r.labelEn, r.amount, r.phaseId, r.dueOn, r.paymentTermDays]),
    [
      [1, 'Deposit', 30_000_000n, null, null, 7],
      [2, 'Phase 2', 30_000_000n, phases[1]!.id, null, 14],
      [3, 'On a day', 30_000_000n, null, null, 0],
    ],
  );
  assert.equal(await prisma.billingEntry.count({ where: { contractId: made.id } }), 0);

  const project = (await prisma.contract.findUniqueOrThrow({ where: { id: made.id } })).projectId;
  const rows = await prisma.dependency.findMany({ where: { projectId: project }, orderBy: { titleEn: 'asc' } });
  assert.deepEqual(rows.map((r) => [r.briefKey, r.titleEn, r.side, r.notNeeded, r.technical, r.inBrief, r.dueAt, r.verifiedAt, r.verifiedNote]), [
    ['content', 'Content', 'ROOT', true, false, true, null, null, null],
    ['domain', 'Domain', 'CUSTOMER', false, true, true, null, null, null],
  ]);
});

test('to another customer; the next number follows; two copies at once get two numbers', async () => {
  const a = ok(await dup(sales, { u: otherCustomer.id })).duplicateContract as { ref: string; customer: { id: string } };
  assert.equal(a.customer.id, otherCustomer.id);
  const both = await Promise.all([dup(sales), dup(sales)]);
  const refs = [a.ref, ...both.map((r) => (ok(r).duplicateContract as { ref: string }).ref)];
  assert.equal(new Set(refs).size, 3);
  const project = (await prisma.contract.findFirstOrThrow({ where: { ref: a.ref } })).projectId;
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project } })).customerId, otherCustomer.id);
});

test('refusals: capability, no such contract, not a customer, inactive customer, blank title', async () => {
  assert.equal((await dup(designer)).code, 'FORBIDDEN');
  assert.equal((await dup(f.customer)).code, 'FORBIDDEN');
  assert.equal((await dup(undefined)).code, 'UNAUTHENTICATED');
  assert.equal((await exec(DUP, { as: sales, variables: { c: 'nope', u: f.customer.id, fa: 'ک', en: 'C' } })).code, 'NOT_FOUND');
  assert.equal((await dup(sales, { u: designer.id })).code, 'NOT_FOUND');
  await prisma.user.update({ where: { id: otherCustomer.id }, data: { state: 'DISABLED' } });
  assert.equal((await dup(sales, { u: otherCustomer.id })).code, 'CUSTOMER_INACTIVE');
  assert.equal((await dup(sales, { en: '   ' })).code, 'TITLE_REQUIRED');
  assert.equal(await prisma.contract.count(), 1, 'nothing was created by a refusal');
  assert.equal(await prisma.project.count(), 1);
});
