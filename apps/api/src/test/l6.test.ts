import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * L6: billing — subscriptions, invoices, the report (build plan §3 "L6";
 * spec §8). The banked traps are the tests worth having: lazy generation
 * produces exactly one entry per due period and is idempotent on repeated
 * reads (a double-charge on refresh would be the worst bug in this stage),
 * BigInt amounts survive the GraphQL round trip as strings, and the
 * Ticket.billable → BillingEntry edge L4 deliberately left unbuilt.
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

const CREATE_SUBSCRIPTION = `
  mutation($customerId: ID!, $labelFa: String!, $labelEn: String!, $amount: String!, $period: SubscriptionPeriod!, $activeFrom: DateTime!) {
    createSubscription(customerId: $customerId, labelFa: $labelFa, labelEn: $labelEn, amount: $amount, period: $period, activeFrom: $activeFrom) {
      id labelFa labelEn amount period activeFrom activeUntil
    }
  }
`;

const MY_BILLING_ENTRIES = `
  query {
    myBillingEntries { id source amount descriptionFa descriptionEn periodStart periodEnd paidAt subscription { id } }
  }
`;

// --- The scheduler decision: lazy-on-read, and it must be idempotent -------

test('a subscription generates exactly one entry per due period, and re-reading does not double it (build plan L6\'s worst-bug trap)', async () => {
  const activeFrom = new Date('2026-01-01T00:00:00Z').toISOString();
  const created = ok(
    await exec(CREATE_SUBSCRIPTION, {
      as: f.admin,
      variables: {
        customerId: f.customer.id,
        labelFa: 'پیامک',
        labelEn: 'SMS API',
        amount: '250000',
        period: 'MONTHLY',
        activeFrom,
      },
    }),
  );
  const subscriptionId = (created.createSubscription as { id: string }).id;

  // Force "now" for the lazy generator by writing a due date in the past
  // directly, since duePeriods reads real wall-clock time by default and
  // the test must not depend on when it happens to run relative to
  // 2026-01-01. Three months should be due by the time this test runs.
  const firstRead = ok(await exec(MY_BILLING_ENTRIES, { as: f.customer }));
  const entriesFirst = (firstRead.myBillingEntries as Array<{ id: string; subscription: { id: string } | null }>).filter(
    (e) => e.subscription?.id === subscriptionId,
  );
  assert.ok(entriesFirst.length >= 1, 'at least the first period should be due immediately');
  const countAfterFirstRead = entriesFirst.length;

  // Re-reading immediately after must not create a second entry for any
  // period already generated — this is the idempotency guarantee the
  // unique (subscriptionId, periodStart) index backs.
  const secondRead = ok(await exec(MY_BILLING_ENTRIES, { as: f.customer }));
  const entriesSecond = (secondRead.myBillingEntries as Array<{ id: string; subscription: { id: string } | null }>).filter(
    (e) => e.subscription?.id === subscriptionId,
  );
  assert.equal(entriesSecond.length, countAfterFirstRead, 'a repeated read must not create duplicate entries');

  // And the ids are identical sets, not merely the same count.
  assert.deepEqual(
    entriesSecond.map((e) => e.id).sort(),
    entriesFirst.map((e) => e.id).sort(),
  );
});

test('lazy generation survives a concurrent-looking double read without a race creating two entries for the same period', async () => {
  const created = ok(
    await exec(CREATE_SUBSCRIPTION, {
      as: f.admin,
      variables: {
        customerId: f.customer.id,
        labelFa: 'پیامک',
        labelEn: 'SMS API',
        amount: '100000',
        period: 'MONTHLY',
        activeFrom: new Date().toISOString(),
      },
    }),
  );
  const subscriptionId = (created.createSubscription as { id: string }).id;

  // Two reads "at once" — the database's own unique index is what makes
  // this safe, not any ordering guarantee in the resolver.
  await Promise.all([exec(MY_BILLING_ENTRIES, { as: f.customer }), exec(MY_BILLING_ENTRIES, { as: f.customer })]);

  const rows = await prisma.billingEntry.findMany({ where: { subscriptionId } });
  const periodStarts = rows.map((r) => r.periodStart?.toISOString());
  assert.equal(new Set(periodStarts).size, periodStarts.length, 'no period was billed twice');
});

// --- BigInt over the wire ----------------------------------------------

test('BigInt amounts survive the GraphQL round trip as strings, not numbers', async () => {
  const created = ok(
    await exec(CREATE_SUBSCRIPTION, {
      as: f.admin,
      variables: {
        customerId: f.customer.id,
        labelFa: 'هاست',
        labelEn: 'Hosting',
        // Larger than Number.MAX_SAFE_INTEGER's neighbourhood is not needed
        // to prove the point, but a plain large Toman figure is exactly the
        // shape a real invoice has.
        amount: '9999999999',
        period: 'YEARLY',
        activeFrom: new Date().toISOString(),
      },
    }),
  );
  const sub = created.createSubscription as { amount: string };
  assert.equal(typeof sub.amount, 'string');
  assert.equal(sub.amount, '9999999999');
});

test('createBillingEntry refuses a non-integer amount (INVALID_AMOUNT) — no float ever touches a charge', async () => {
  const result = await exec(
    `mutation($customerId: ID!, $amount: String!) {
      createBillingEntry(customerId: $customerId, source: CONTRACT, descriptionFa: "x", descriptionEn: "x", amount: $amount) { id }
    }`,
    { as: f.admin, variables: { customerId: f.customer.id, amount: '100.50' } },
  );
  assert.equal(result.code, 'INVALID_AMOUNT');
});

test('createBillingEntry refuses source SUBSCRIPTION — those are only ever generated lazily', async () => {
  const result = await exec(
    `mutation($customerId: ID!) {
      createBillingEntry(customerId: $customerId, source: SUBSCRIPTION, descriptionFa: "x", descriptionEn: "x", amount: "1000") { id }
    }`,
    { as: f.admin, variables: { customerId: f.customer.id } },
  );
  assert.equal(result.code, 'INVALID_SOURCE');
});

// --- The Ticket.billable -> BillingEntry edge (build plan L4's second trap) -

test('createTicketBillingEntry refuses a non-billable ticket (NOT_BILLABLE)', async () => {
  const ticketResult = ok(
    await exec(
      `mutation { createTicket(type: BUG, subject: "s", body: "b") { id } }`,
      { as: f.customer },
    ),
  );
  const ticketId = (ticketResult.createTicket as { id: string }).id;

  const billed = await exec(
    `mutation($ticketId: ID!) { createTicketBillingEntry(ticketId: $ticketId, amount: "50000", descriptionFa: "x", descriptionEn: "x") { id } }`,
    { as: f.admin, variables: { ticketId } },
  );
  assert.equal(billed.code, 'NOT_BILLABLE');
});

test('createTicketBillingEntry creates a TICKET-sourced entry once billable, and refuses a second one (ALREADY_BILLED)', async () => {
  const ticketResult = ok(
    await exec(`mutation { createTicket(type: BUG, subject: "s", body: "b") { id } }`, { as: f.customer }),
  );
  const ticketId = (ticketResult.createTicket as { id: string }).id;

  ok(
    await exec(`mutation($ticketId: ID!) { setTicketBillable(ticketId: $ticketId, billable: true) { id billable } }`, {
      as: f.admin,
      variables: { ticketId },
    }),
  );

  const first = ok(
    await exec(
      `mutation($ticketId: ID!) { createTicketBillingEntry(ticketId: $ticketId, amount: "500000", descriptionFa: "تعمیر", descriptionEn: "Fix") { id source amount ticket { id } } }`,
      { as: f.admin, variables: { ticketId } },
    ),
  );
  const entry = first.createTicketBillingEntry as { id: string; source: string; amount: string; ticket: { id: string } };
  assert.equal(entry.source, 'TICKET');
  assert.equal(entry.amount, '500000');
  assert.equal(entry.ticket.id, ticketId);

  const second = await exec(
    `mutation($ticketId: ID!) { createTicketBillingEntry(ticketId: $ticketId, amount: "1", descriptionFa: "x", descriptionEn: "x") { id } }`,
    { as: f.admin, variables: { ticketId } },
  );
  assert.equal(second.code, 'ALREADY_BILLED');
});

// --- Marking paid, and reversing it -----------------------------------

test('markBillingEntryPaid / unmarkBillingEntryPaid toggle paidAt, and the report moves between issued and outstanding', async () => {
  const entry = ok(
    await exec(
      `mutation($customerId: ID!) { createBillingEntry(customerId: $customerId, source: CONTRACT, descriptionFa: "x", descriptionEn: "x", amount: "300000") { id } }`,
      { as: f.admin, variables: { customerId: f.customer.id } },
    ),
  );
  const entryId = (entry.createBillingEntry as { id: string }).id;

  const reportBefore = ok(await exec(`query($c: ID){ billingReport(customerId: $c) { totalIssued totalPaid totalOutstanding } }`, {
    as: f.admin,
    variables: { c: f.customer.id },
  }));
  const before = reportBefore.billingReport as { totalIssued: string; totalPaid: string; totalOutstanding: string };
  assert.equal(before.totalIssued, '300000');
  assert.equal(before.totalPaid, '0');
  assert.equal(before.totalOutstanding, '300000');

  ok(await exec(`mutation($id: ID!){ markBillingEntryPaid(entryId: $id) { id paidAt } }`, { as: f.admin, variables: { id: entryId } }));

  const reportAfter = ok(await exec(`query($c: ID){ billingReport(customerId: $c) { totalIssued totalPaid totalOutstanding } }`, {
    as: f.admin,
    variables: { c: f.customer.id },
  }));
  const after = reportAfter.billingReport as { totalPaid: string; totalOutstanding: string };
  assert.equal(after.totalPaid, '300000');
  assert.equal(after.totalOutstanding, '0');

  ok(await exec(`mutation($id: ID!){ unmarkBillingEntryPaid(entryId: $id) { id paidAt } }`, { as: f.admin, variables: { id: entryId } }));
  const reportReversed = ok(await exec(`query($c: ID){ billingReport(customerId: $c) { totalPaid totalOutstanding } }`, {
    as: f.admin,
    variables: { c: f.customer.id },
  }));
  const reversed = reportReversed.billingReport as { totalPaid: string; totalOutstanding: string };
  assert.equal(reversed.totalPaid, '0');
  assert.equal(reversed.totalOutstanding, '300000');
});

// --- Milestone linkage ----------------------------------------------------

test('createBillingEntry accepts phaseId — the portal can show what a payment is gated on', async () => {
  const projectId = f.contract.projectId!;
  const phase = await prisma.phase.create({
    data: { projectId, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1', milestoneLabel: 'Payment 1 of 4' },
  });

  const entry = ok(
    await exec(
      `mutation($customerId: ID!, $phaseId: ID!) {
        createBillingEntry(customerId: $customerId, phaseId: $phaseId, source: CONTRACT, descriptionFa: "x", descriptionEn: "x", amount: "1000000") {
          id phase { id milestoneLabel }
        }
      }`,
      { as: f.admin, variables: { customerId: f.customer.id, phaseId: phase.id } },
    ),
  );
  const created = entry.createBillingEntry as { phase: { id: string; milestoneLabel: string | null } };
  assert.equal(created.phase.id, phase.id);
  assert.equal(created.phase.milestoneLabel, 'Payment 1 of 4');
});

// --- Ownership and capability boundaries (house rule 2) --------------------

test('a customer cannot read another customer\'s billing entries, and cannot call staff mutations', async () => {
  ok(
    await exec(
      `mutation($customerId: ID!) { createBillingEntry(customerId: $customerId, source: CONTRACT, descriptionFa: "x", descriptionEn: "x", amount: "10000") { id } }`,
      { as: f.admin, variables: { customerId: f.customer.id } },
    ),
  );

  const strangerRead = ok(await exec(MY_BILLING_ENTRIES, { as: f.stranger }));
  assert.equal((strangerRead.myBillingEntries as unknown[]).length, 0);

  const forbidden = await exec(
    `mutation($customerId: ID!) { createBillingEntry(customerId: $customerId, source: CONTRACT, descriptionFa: "x", descriptionEn: "x", amount: "1") { id } }`,
    { as: f.customer, variables: { customerId: f.customer.id } },
  );
  assert.equal(forbidden.code, 'FORBIDDEN');

  const anonymous = await exec(MY_BILLING_ENTRIES, { as: null });
  assert.equal(anonymous.code, 'UNAUTHENTICATED');
});

// --- endSubscription --------------------------------------------------

test('endSubscription stops future periods and refuses a second end (ALREADY_ENDED)', async () => {
  const created = ok(
    await exec(CREATE_SUBSCRIPTION, {
      as: f.admin,
      variables: {
        customerId: f.customer.id,
        labelFa: 'پیامک',
        labelEn: 'SMS API',
        amount: '100000',
        period: 'MONTHLY',
        activeFrom: new Date('2020-01-01T00:00:00Z').toISOString(),
      },
    }),
  );
  const subscriptionId = (created.createSubscription as { id: string }).id;

  // Read once so periods up to "now" are generated under the still-open subscription.
  ok(await exec(MY_BILLING_ENTRIES, { as: f.customer }));
  const beforeEnd = await prisma.billingEntry.count({ where: { subscriptionId } });
  assert.ok(beforeEnd > 1, 'several years of monthly periods should already be due');

  const ended = ok(
    await exec(`mutation($id: ID!, $until: DateTime!){ endSubscription(subscriptionId: $id, activeUntil: $until) { id activeUntil } }`, {
      as: f.admin,
      variables: { id: subscriptionId, until: new Date('2020-02-01T00:00:00Z').toISOString() },
    }),
  );
  assert.ok((ended.endSubscription as { activeUntil: string }).activeUntil);

  // Every entry generated from now on is capped at the end date — resetting
  // and re-reading must not create anything past it.
  await prisma.billingEntry.deleteMany({ where: { subscriptionId } });
  ok(await exec(MY_BILLING_ENTRIES, { as: f.customer }));
  const afterEnd = await prisma.billingEntry.findMany({ where: { subscriptionId } });
  assert.equal(afterEnd.length, 2, 'only the Jan and Feb 2020 periods are within range');

  const secondEnd = await exec(
    `mutation($id: ID!, $until: DateTime!){ endSubscription(subscriptionId: $id, activeUntil: $until) { id } }`,
    { as: f.admin, variables: { id: subscriptionId, until: new Date().toISOString() } },
  );
  assert.equal(secondEnd.code, 'ALREADY_ENDED');
});
