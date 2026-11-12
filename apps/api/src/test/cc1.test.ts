import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { erasedEmailFor } from '../lib/erasure.js';

/**
 * CC1 — moving a contract to another customer, and every refusal in front of
 * it: signed (the founder's rule), approved, invoiced, a project holding
 * another contract, a project that began as a request, an inactive or
 * non-customer target. What moves: the contract, its project, the project's
 * subscriptions and every unissued billing entry; the old customer's mockup
 * grants on the project go; the log says so without a name. The new customer
 * reads it; the old one hears "no such contract".
 */

let f: Fixture;
let sales: User;
let other: User;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  // The fixture's revision v1 is published, sealed, neither approved nor signed.
  f = await seedFixture();
  sales = await prisma.user.create({
    data: { email: 'sales@test.local', phone: '+989120000102', name: 'Sales', roles: ['SALES'], state: 'ACTIVE' },
  });
  other = await prisma.user.create({
    data: { email: 'other@test.local', phone: '+989120000199', name: 'Other Customer', roles: ['CUSTOMER'], state: 'ACTIVE' },
  });
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const CHANGE = `mutation($c: ID!, $u: ID!){ changeContractCustomer(contractId: $c, customerId: $u) { id customer { id } } }`;
const READ = `query($c: ID!){ contract(id: $c) { id } }`;
const change = (to: string, as: User = sales) => exec(CHANGE, { as, variables: { c: f.contract.id, u: to } });

test('the contract and its project move; draft invoices move, the log says so, the new customer reads it and the old one cannot', async () => {
  const draft = await prisma.billingEntry.create({
    data: {
      customerId: f.customer.id,
      contractId: f.contract.id,
      source: 'CONTRACT',
      descriptionFa: 'پیش‌پرداخت',
      descriptionEn: 'Deposit',
      amount: 1000n,
    },
  });
  const r = ok(await change(other.id)).changeContractCustomer as { customer: { id: string } };
  assert.equal(r.customer.id, other.id);
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: f.contract.projectId } })).customerId, other.id);
  assert.equal((await prisma.billingEntry.findUniqueOrThrow({ where: { id: draft.id } })).customerId, other.id);
  const logged = await prisma.changeLog.findFirstOrThrow({ where: { contractId: f.contract.id, action: 'CUSTOMER_CHANGED' } });
  assert.equal(logged.arg, null, 'no name in a log the new customer reads');

  ok(await exec(READ, { as: other, variables: { c: f.contract.id } }));
  assert.equal((await exec(READ, { as: f.customer, variables: { c: f.contract.id } })).code, 'NOT_FOUND');
});

test('CONTRACT_SIGNED and CONTRACT_APPROVED: once the customer has acted on the text, it stays theirs', async () => {
  const revision = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id } });
  await prisma.contractRevision.update({ where: { id: revision.id }, data: { approvedAt: new Date() } });
  assert.equal((await change(other.id)).code, 'CONTRACT_APPROVED');
  await prisma.signature.create({
    data: { contractRevisionId: revision.id, signerId: f.customer.id, typedName: 'Nahal', signedHash: revision.contentHash },
  });
  assert.equal((await change(other.id)).code, 'CONTRACT_SIGNED');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).customerId, f.customer.id);
});

test('INVOICED: an issued invoice is addressed to a person', async () => {
  await prisma.billingEntry.create({
    data: {
      customerId: f.customer.id,
      contractId: f.contract.id,
      source: 'CONTRACT',
      descriptionFa: 'پیش‌پرداخت',
      descriptionEn: 'Deposit',
      amount: 1000n,
      issuedAt: new Date(),
      invoiceNumber: 'INV-CC1-1',
      dueAt: new Date(Date.now() + 14 * 86_400_000),
    },
  });
  assert.equal((await change(other.id)).code, 'INVOICED');
});

test('PROJECT_SHARED and PROJECT_HAS_REQUEST: the project moves with the contract, so it must carry nothing else', async () => {
  const second = await prisma.contract.create({
    data: { customerId: f.customer.id, projectId: f.contract.projectId, ref: 'RC-CC1-2', titleFa: 'دوم', titleEn: 'Second' },
  });
  assert.equal((await change(other.id)).code, 'PROJECT_SHARED');
  await prisma.contract.delete({ where: { id: second.id } });

  await prisma.requestMessage.create({
    data: { projectId: f.contract.projectId, authorId: f.customer.id, body: 'یک فروشگاه می‌خواهم' },
  });
  assert.equal((await change(other.id)).code, 'PROJECT_HAS_REQUEST');
});

test('the target: a customer account, active or invited — not staff, not disabled, not erased; and contracts.author only', async () => {
  assert.equal((await change(sales.id)).code, 'NOT_FOUND');
  assert.equal((await change('no-such-user')).code, 'NOT_FOUND');
  await prisma.user.update({ where: { id: other.id }, data: { state: 'DISABLED' } });
  assert.equal((await change(other.id)).code, 'CUSTOMER_INACTIVE');
  await prisma.user.update({ where: { id: other.id }, data: { state: 'ACTIVE', email: erasedEmailFor(other.id) } });
  assert.equal((await change(other.id)).code, 'CUSTOMER_INACTIVE');
  assert.equal((await change(other.id, f.customer)).code, 'FORBIDDEN');
});
