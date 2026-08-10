import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * V4: the desk's Overview. `statusChangedAt` (defect D7), the three
 * capability-guarded queries, and the ownership filter on the review queue.
 */

let f: Fixture;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

test("allContractStatusCounts sees every contract; contractStatusCounts stays scoped to the caller's own", async () => {
  await prisma.contract.create({
    data: {
      ref: 'RC-OTHER-1',
      titleFa: 'قرارداد دیگر',
      titleEn: 'Other contract',
      customerId: f.stranger.id,
      status: 'DRAFT',
    },
  });

  const asAdmin = ok(
    await exec('query{ allContractStatusCounts { status count } }', { as: f.admin }),
  );
  const adminTotal = (asAdmin.allContractStatusCounts as Array<{ count: number }>).reduce(
    (sum, c) => sum + c.count,
    0,
  );
  assert.equal(adminTotal, 2, 'allContractStatusCounts must see every contract, not one customer');

  const asCustomer = ok(
    await exec('query{ contractStatusCounts { status count } }', { as: f.customer }),
  );
  const customerTotal = (asCustomer.contractStatusCounts as Array<{ count: number }>).reduce(
    (sum, c) => sum + c.count,
    0,
  );
  assert.equal(customerTotal, 1, "contractStatusCounts must stay scoped to the caller's own");
});

test('needsRootQueue orders by statusChangedAt ascending — the longest-waiting contract first', async () => {
  const olderWait = new Date('2026-01-01T00:00:00Z');
  const newerWait = new Date('2026-06-01T00:00:00Z');

  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { status: 'WAITING_ON_ROOT', statusChangedAt: olderWait },
  });
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-SECOND-1',
      titleFa: 'قرارداد دوم',
      titleEn: 'Second contract',
      customerId: f.customer.id,
      status: 'WAITING_ON_ROOT',
      statusChangedAt: newerWait,
      publishedAt: new Date(),
    },
  });

  const data = ok(await exec('query{ needsRootQueue { id } }', { as: f.admin }));
  const ids = (data.needsRootQueue as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids, [f.contract.id, second.id], 'nudged-earlier must sort before nudged-later');
});

test('setContractStatus to the status a contract already has does not move statusChangedAt (D7)', async () => {
  const before = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });

  ok(
    await exec(
      'mutation($c: ID!, $s: ContractStatus!){ setContractStatus(contractId: $c, status: $s) { id } }',
      { as: f.admin, variables: { c: f.contract.id, s: before.status } },
    ),
  );

  const after = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.equal(
    after.statusChangedAt.getTime(),
    before.statusChangedAt.getTime(),
    'setting the status a contract already has must not reset the clock',
  );
});

test('activity(reviewOnly) includes review-worthy customer actions and excludes admin-authored or routine ones', async () => {
  // A customer comment is review-worthy; the same action from an admin is not.
  ok(
    await exec('mutation($c: ID!, $b: String!){ addComment(contractId: $c, body: $b) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, b: 'A question about article 2.' },
    }),
  );
  ok(
    await exec('mutation($c: ID!, $b: String!){ addComment(contractId: $c, body: $b) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id, b: 'A reply.' },
    }),
  );

  // Approving a page is routine; taking the approval back is always worth a look.
  const concept = await prisma.designConcept.findFirstOrThrow({
    where: { designRevisionId: f.designRevision.id, key: '1a' },
  });
  ok(
    await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, k: concept.id },
    }),
  );
  const page = await prisma.pageDesign.findFirstOrThrow({ where: { conceptId: concept.id } });
  ok(
    await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', {
      as: f.customer,
      variables: { p: page.id },
    }),
  );
  ok(
    await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: false) { id } }', {
      as: f.customer,
      variables: { p: page.id },
    }),
  );

  const data = ok(
    await exec('query{ activity(reviewOnly: true) { action } }', { as: f.admin }),
  );
  const actions = (data.activity as Array<{ action: string }>).map((a) => a.action);

  assert.equal(
    actions.filter((a) => a === 'COMMENTED').length,
    1,
    "exactly the customer's comment, not the admin's",
  );
  assert.ok(!actions.includes('APPROVED_PAGE'), 'routine progress is not a review action');
  assert.ok(actions.includes('UNAPPROVED_PAGE'), 'the customer took an approval back');
});

test('a customer is refused all three staff queries', async () => {
  for (const query of [
    'query{ allContractStatusCounts { status count } }',
    'query{ needsRootQueue { id } }',
    'query{ activity { id } }',
  ]) {
    const r = await exec(query, { as: f.customer });
    assert.equal(r.code, 'FORBIDDEN', query);
  }
});
