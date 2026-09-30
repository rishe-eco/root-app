import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Prisma, Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import type { Context } from '../context.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { ServiceRun } from '../graphql/resolvers/fields.js';

/**
 * J13 — invoices: drafts, numbers, due days, plan issuing, the invoice view
 * (journeys build plan §5 "J13").
 *
 * What the pure tables (`invoice.test.ts`) cannot show, in this order: **the
 * database's own rules by direct insert** (the CHECK that makes "issued" mean
 * numbered and dated; the two uniques) and **the migration's backfill, run as
 * shipped**; **drafts** (the creators write them; no path reaches a customer —
 * every edge that can return a `BillingEntry`, and a test that reads the
 * resolvers so a new edge cannot be added unnoticed); **issuing** (the number,
 * the due day, the term, the notification, the refusals); **the lazy
 * subscription generator** (issued and numbered, and a refresh burns nothing);
 * **the plan rule end to end** — `NOT_SIGNED`, `PREVIOUS_UNPAID`,
 * `PHASE_NOT_ACCEPTED` and its flip on a DEMO `StepApproval`, the state each
 * row reports, `SUCCESSOR_ISSUED`; **the races** (two presses, one invoice);
 * **`PLAN_HAS_ISSUED_INVOICES`** (J4's owed guard); "started" and the status
 * area's overdue line; and the capability and money rules.
 *
 * **Signing.** A contract on the new road cannot be approved or signed through
 * the API until J7, so a test that needs a *signed* one writes the row J7 will
 * write — the AGREEMENT `StepApproval` — by direct insert (`sign` below). There
 * is no `Contract.signedAt`: "signed" is `agreementSignedAt` (lib/steps.ts).
 * Likewise a phase's accepted demo is a direct DEMO `StepApproval` (`accept`),
 * which is exactly what J10 will produce, so J10 has only to produce the row.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string; code?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000113', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to, code) => void sms.push({ to, code }),
    sendText: async (to, text) => void sms.push({ to, text }),
  });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// ---- documents and helpers ---------------------------------------------------------

const ENTRY = `id source amount descriptionFa descriptionEn issuedAt paidAt invoiceNumber dueAt paymentTermDays overdue
  plannedInvoice { id ordinal } phase { id number }`;
const PLAN = `paymentPlan { id total invoices { id ordinal amount state blockedBy invoice { id invoiceNumber dueAt paidAt overdue } } }`;

const CREATE_DRAFT = `mutation($c: ID!, $amount: String!, $term: Int, $contract: ID, $phase: ID){
  createInvoiceDraft(customerId: $c, contractId: $contract, phaseId: $phase, source: CONTRACT, descriptionFa: "بابت کار", descriptionEn: "For work", amount: $amount, paymentTermDays: $term) { ${ENTRY} }
}`;
const UPDATE_DRAFT = `mutation($e: ID!, $amount: String!, $term: Int){
  updateInvoiceDraft(entryId: $e, descriptionFa: "ویرایش", descriptionEn: "Edited", amount: $amount, paymentTermDays: $term) { ${ENTRY} }
}`;
const DELETE_DRAFT = `mutation($e: ID!){ deleteInvoiceDraft(entryId: $e) }`;
const ISSUE = `mutation($e: ID!){ issueInvoice(entryId: $e) { ${ENTRY} } }`;
const ISSUE_PLANNED = `mutation($p: ID!){ issuePlannedInvoice(plannedInvoiceId: $p) { id ${PLAN} } }`;
const MARK_PAID = `mutation($e: ID!){ markBillingEntryPaid(entryId: $e) { ${ENTRY} } }`;
const UNMARK_PAID = `mutation($e: ID!){ unmarkBillingEntryPaid(entryId: $e) { ${ENTRY} } }`;
const MY_INVOICES = `{ myInvoices { ${ENTRY} } }`;
const INVOICE = `query($id: ID!){ invoice(id: $id) { ${ENTRY} } }`;
const PLAN_OF = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { id ${PLAN} } }`;
const SUMMARY = `query($c: ID!){ contract(id: $c) {
  statusSummary { started startedAt overdueCount }
  attention { kind waitingOn params { key value } }
} }`;

type Entry = {
  id: string;
  source: string;
  amount: string;
  descriptionFa: string;
  descriptionEn: string;
  issuedAt: string | null;
  paidAt: string | null;
  invoiceNumber: string | null;
  dueAt: string | null;
  paymentTermDays: number | null;
  overdue: boolean;
  plannedInvoice: { id: string; ordinal: number } | null;
  phase: { id: string; number: number } | null;
};

type PlanRead = {
  id: string;
  total: string;
  invoices: Array<{
    id: string;
    ordinal: number;
    amount: string;
    state: string;
    blockedBy: string | null;
    invoice: { id: string; invoiceNumber: string | null; dueAt: string | null; paidAt: string | null; overdue: boolean } | null;
  }>;
} | null;

const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => day(new Date(new Date(iso).getTime() + n * 86_400_000));
/** The UTC day an ISO instant falls on. */
const dayOf = (iso: string) => iso.slice(0, 10);

async function draft(over: { amount?: string; term?: number | null; contract?: string | null; phase?: string | null } = {}, as: User = staff.SALES) {
  return ok(
    await exec(CREATE_DRAFT, {
      as,
      variables: { c: f.customer.id, amount: over.amount ?? '1500000', term: over.term ?? null, contract: over.contract ?? null, phase: over.phase ?? null },
    }),
  ).createInvoiceDraft as Entry;
}

/** Signs the agreement the way J7 will: the AGREEMENT `StepApproval`. */
const sign = (contractId = f.contract.id) =>
  prisma.stepApproval.create({ data: { contractId, step: 'AGREEMENT', approvedById: f.customer.id } });

/** A phase's accepted demo, the way J10 will write it. */
const accept = (phaseId: string, contractId = f.contract.id) =>
  prisma.stepApproval.create({ data: { contractId, step: 'DEMO', phaseId, approvedById: f.customer.id } });

const phaseOf = (number: number) =>
  prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, number, titleFa: `فاز ${number}`, titleEn: `Phase ${number}` },
  });

/** A three-row plan on the fixture contract: a deposit, a phase-tied payment, a final one. */
async function makePlan(phaseId?: string) {
  const ph = phaseId ?? (await phaseOf(1)).id;
  const plan = await prisma.paymentPlan.create({
    data: {
      contractId: f.contract.id,
      split: 'INSTALLMENTS',
      invoices: {
        create: [
          { ordinal: 1, labelFa: 'پیش‌پرداخت', labelEn: 'Deposit', amount: 50_000_000n, paymentTermDays: 5 },
          { ordinal: 2, labelFa: 'فاز یک', labelEn: 'Phase one', amount: 60_000_000n, paymentTermDays: 10, phaseId: ph },
          { ordinal: 3, labelFa: 'پایانی', labelEn: 'Final', amount: 40_000_000n, paymentTermDays: 14 },
        ],
      },
    },
    include: { invoices: { orderBy: { ordinal: 'asc' } } },
  });
  return { plan, rows: plan.invoices, phaseId: ph };
}

const readPlan = async (as: User, asCustomer = false) =>
  (ok(await exec(PLAN_OF, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as { paymentPlan: PlanRead }).paymentPlan!;

const issuePlanned = (plannedInvoiceId: string, as: User = staff.SALES) => exec(ISSUE_PLANNED, { as, variables: { p: plannedInvoiceId } });

const states = (plan: PlanRead) => plan!.invoices.map((r) => (r.blockedBy ? `${r.state}/${r.blockedBy}` : r.state));

const sequenceState = async () =>
  (await prisma.$queryRaw<Array<{ last_value: bigint; is_called: boolean }>>`SELECT last_value, is_called FROM invoice_number_seq`)[0];

// =====================================================================================
// The database's own rules, by direct insert (the CHECK-proven-by-insert rule)

test('CHECK BillingEntry_issued_is_complete: an issued row must carry its number and its due day — a draft carries neither', async () => {
  const base = { customerId: f.customer.id, source: 'CONTRACT' as const, descriptionFa: 'ا', descriptionEn: 'a', amount: 1n };
  // A draft is free of both.
  await prisma.billingEntry.create({ data: base });
  // Issued, no number.
  await assert.rejects(
    () => prisma.billingEntry.create({ data: { ...base, issuedAt: new Date(), dueAt: new Date('2026-10-20T00:00:00Z') } }),
    /BillingEntry_issued_is_complete/,
  );
  // Issued, a number, no due day.
  await assert.rejects(
    () => prisma.billingEntry.create({ data: { ...base, issuedAt: new Date(), invoiceNumber: 'INV-000001' } }),
    /BillingEntry_issued_is_complete/,
  );
  // Issued, a due day, no number.
  await assert.rejects(
    () => prisma.billingEntry.create({ data: { ...base, issuedAt: new Date(), dueAt: new Date('2026-10-20T00:00:00Z'), invoiceNumber: null } }),
    /BillingEntry_issued_is_complete/,
  );
  // Both: accepted.
  await prisma.billingEntry.create({
    data: { ...base, issuedAt: new Date(), invoiceNumber: 'INV-000001', dueAt: new Date('2026-10-20T00:00:00Z') },
  });
  // The same constraint through the raw door, so it is the database refusing and not Prisma.
  await assert.rejects(
    () =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "BillingEntry" ("id","customerId","source","descriptionFa","descriptionEn","amount","issuedAt") VALUES ('raw-1','${f.customer.id}','CONTRACT','ا','a',1, now())`,
      ),
    /BillingEntry_issued_is_complete/,
  );
});

test('the invoice number and the planned-invoice edge are unique', async () => {
  const issued = (n: string, extra: Partial<Prisma.BillingEntryUncheckedCreateInput> = {}) => ({
    customerId: f.customer.id,
    source: 'CONTRACT' as const,
    descriptionFa: 'ا',
    descriptionEn: 'a',
    amount: 1n,
    issuedAt: new Date(),
    invoiceNumber: n,
    dueAt: new Date('2026-10-20T00:00:00Z'),
    ...extra,
  });
  await prisma.billingEntry.create({ data: issued('INV-000001') });
  await assert.rejects(() => prisma.billingEntry.create({ data: issued('INV-000001') }), /Unique constraint/);

  const { rows } = await makePlan();
  await prisma.billingEntry.create({ data: issued('INV-000002', { plannedInvoiceId: rows[0].id }) });
  await assert.rejects(() => prisma.billingEntry.create({ data: issued('INV-000003', { plannedInvoiceId: rows[0].id }) }), /Unique constraint/);
});

test('a planned invoice that has been issued cannot be deleted out from under its invoice (the foreign key restricts)', async () => {
  await sign();
  const { rows } = await makePlan();
  ok(await issuePlanned(rows[0].id));
  await assert.rejects(() => prisma.plannedInvoice.delete({ where: { id: rows[0].id } }), /Foreign key constraint/);
  await assert.rejects(() => prisma.plannedInvoice.deleteMany({ where: { planId: rows[0].planId } }), /Foreign key constraint/);
});

// ---- the migration's backfill, as shipped --------------------------------------------

const MIGRATION = fileURLToPath(new URL('../../prisma/migrations/20260930130000_j13_invoices/migration.sql', import.meta.url));

function between(begin: string, end: string): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = sql.slice(sql.indexOf(begin), sql.indexOf(end));
  assert.ok(block.length > 0, `${begin} … ${end} markers are missing`);
  return block
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

test('the backfill numbers every existing entry in issuedAt order, dates it the day it was issued, and continues the sequence after them', async () => {
  const rolledBack = new Error('roll back the un-migrated fixture');
  const seen: { rows: Array<{ id: string; invoiceNumber: string | null; dueAt: Date | null; paymentTermDays: number | null }>; next: bigint } = {
    rows: [],
    next: 0n,
  };
  await prisma
    .$transaction(async (tx) => {
      // The migrated database refuses an issued row without a number, so
      // pre-migration rows can only be built with the CHECK lifted — inside a
      // transaction that is always rolled back (as T1's, S2's and J4's do).
      await tx.$executeRawUnsafe('ALTER TABLE "BillingEntry" DROP CONSTRAINT "BillingEntry_issued_is_complete"');
      const insert = (id: string, issuedAt: string | null) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "BillingEntry" ("id","customerId","source","descriptionFa","descriptionEn","amount","issuedAt")
           VALUES ('${id}','${f.customer.id}','CONTRACT','ا','a',100, ${issuedAt ? `'${issuedAt}'` : 'NULL'})`,
        );
      await insert('bf-b', '2026-03-02 10:00:00');
      await insert('bf-c', '2026-03-01 10:00:00'); // the same instant as bf-a: the id breaks the tie
      await insert('bf-a', '2026-03-01 10:00:00');
      await insert('bf-d', null); // a draft cannot exist before this migration, but must survive one
      const statements = between('-- BACKFILL:BEGIN', '-- BACKFILL:END')
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean);
      assert.equal(statements.length, 2, 'the backfill is one update and one setval');
      for (const s of statements) await tx.$executeRawUnsafe(s);
      seen.rows = await tx.$queryRawUnsafe(`SELECT "id","invoiceNumber","dueAt","paymentTermDays" FROM "BillingEntry" WHERE "id" LIKE 'bf-%' ORDER BY "id"`);
      seen.next = (await tx.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('invoice_number_seq') AS n`)[0].n;
      throw rolledBack;
    })
    .catch((err) => {
      if (err !== rolledBack) throw err;
    });
  const byId = Object.fromEntries(seen.rows.map((r) => [r.id, r]));
  assert.equal(byId['bf-a'].invoiceNumber, 'INV-000001');
  assert.equal(byId['bf-c'].invoiceNumber, 'INV-000002');
  assert.equal(byId['bf-b'].invoiceNumber, 'INV-000003');
  assert.equal(byId['bf-d'].invoiceNumber, null, 'a draft is not numbered');
  assert.equal(byId['bf-d'].dueAt, null);
  assert.equal(day(byId['bf-a'].dueAt!), '2026-03-01', 'due the day it was issued');
  assert.equal(byId['bf-b'].paymentTermDays, 0);
  assert.equal(seen.next, 4n, 'the next invoice continues after the backfilled ones, drafts not counted');
});

// =====================================================================================
// Drafts

test('createInvoiceDraft writes a draft: no number, no due day, no issue date — and the desk sees it', async () => {
  const d = await draft({ term: 14 });
  assert.equal(d.issuedAt, null);
  assert.equal(d.invoiceNumber, null);
  assert.equal(d.dueAt, null);
  assert.equal(d.paymentTermDays, 14);
  assert.equal(d.overdue, false, 'a draft is never overdue');
  const ledger = ok(await exec(`{ allBillingEntries { id issuedAt invoiceNumber } }`, { as: staff.SALES })).allBillingEntries as Array<{ id: string; issuedAt: string | null }>;
  assert.deepEqual(ledger.filter((e) => e.id === d.id).map((e) => e.issuedAt), [null]);
});

test('the ticket creator writes a draft too, and so does the service-run creator (createTicketBillingEntry, createServiceRunBillingEntry)', async () => {
  const ticket = ok(await exec(`mutation { createTicket(type: BUG, subject: "s", body: "b") { id } }`, { as: f.customer })).createTicket as { id: string };
  ok(await exec(`mutation($t: ID!){ setTicketBillable(ticketId: $t, billable: true) { id } }`, { as: staff.SALES, variables: { t: ticket.id } }));
  ok(
    await exec(`mutation($t: ID!){ createTicketBillingEntry(ticketId: $t, amount: "500000", descriptionFa: "تعمیر", descriptionEn: "Fix") { id } }`, {
      as: staff.SALES,
      variables: { t: ticket.id },
    }),
  );
  const row = await prisma.billingEntry.findFirstOrThrow({ where: { ticketId: ticket.id } });
  assert.equal(row.issuedAt, null);
  assert.equal(row.invoiceNumber, null);
  // The service-run creator is driven end to end in `l7.test.ts`, which now
  // asserts the same of its entry; the source-text test below holds that no
  // creator names an `issuedAt`.
  const creators = readFileSync(fileURLToPath(new URL('../graphql/resolvers/admin/billing.ts', import.meta.url)), 'utf8');
  assert.ok(!/\bissuedAt\s*:/.test(creators.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no creator in billing.ts sets issuedAt');
});

test('a draft reaches no customer: myInvoices, invoice(id), the report, the ticket edge, the service-run edge, the desk’s customer page', async () => {
  const d = await draft();
  // A billable ticket with a draft charge, for the ticket edge.
  const ticket = ok(await exec(`mutation { createTicket(type: BUG, subject: "s", body: "b") { id } }`, { as: f.customer })).createTicket as { id: string };
  ok(await exec(`mutation($t: ID!){ setTicketBillable(ticketId: $t, billable: true) { id } }`, { as: staff.SALES, variables: { t: ticket.id } }));
  ok(
    await exec(`mutation($t: ID!){ createTicketBillingEntry(ticketId: $t, amount: "7000", descriptionFa: "ت", descriptionEn: "T") { id } }`, {
      as: staff.SALES,
      variables: { t: ticket.id },
    }),
  );

  // myInvoices: never selected.
  assert.deepEqual((ok(await exec(MY_INVOICES, { as: f.customer })).myInvoices as unknown[]), []);
  // invoice(id): "no such thing", the same answer as for a missing id.
  const asked = await exec(INVOICE, { as: f.customer, variables: { id: d.id } });
  const missing = await exec(INVOICE, { as: f.customer, variables: { id: 'nope' } });
  assert.equal(asked.code, 'NOT_FOUND');
  assert.equal(asked.errors[0].message, missing.errors[0].message, 'a draft is indistinguishable from an id that does not exist');
  // The report: a draft is in no total.
  const report = ok(await exec(`{ myBillingReport { totalIssued totalPaid totalOutstanding bySource { source } } }`, { as: f.customer })).myBillingReport as {
    totalIssued: string;
    totalOutstanding: string;
    bySource: unknown[];
  };
  assert.equal(report.totalIssued, '0');
  assert.equal(report.totalOutstanding, '0');
  assert.deepEqual(report.bySource, []);
  // The ticket edge (which the web had queried since L6 and the schema never declared).
  const tickets = ok(await exec(`{ myTickets { id billingEntry { id amount } } }`, { as: f.customer })).myTickets as Array<{ id: string; billingEntry: unknown }>;
  assert.equal(tickets.find((t) => t.id === ticket.id)!.billingEntry, null);
  // The service-run edge, through its own field resolver.
  const ctxOf = (user: User) => ({ user, auth: { kind: 'session' } }) as unknown as Context;
  const draftRow = await prisma.billingEntry.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(ServiceRun.billingEntry({ billingEntry: draftRow }, {}, ctxOf(f.customer)), null);
  assert.equal(ServiceRun.billingEntry({ billingEntry: draftRow }, {}, ctxOf(staff.SALES))?.id, d.id, 'billing sees its own draft');
  assert.equal(ServiceRun.billingEntry({ billingEntry: draftRow }, {}, ctxOf(staff.DESIGNER)), null, 'and design does not');
  // The desk's customer page: money readers' summary, drafts uncounted.
  const profile = ok(await exec(`query($id: ID!){ customer(id: $id) { invoices { totalIssued totalOutstanding } } }`, { as: staff.SALES, variables: { id: f.customer.id } })).customer as {
    invoices: { totalIssued: string; totalOutstanding: string };
  };
  assert.equal(profile.invoices.totalIssued, '0');
  // And the staff side does see the drafts and the ticket's charge.
  const staffTickets = ok(await exec(`{ allTickets { id billingEntry { id amount issuedAt } } }`, { as: staff.SALES })).allTickets as Array<{ id: string; billingEntry: { issuedAt: string | null } | null }>;
  assert.equal(staffTickets.find((t) => t.id === ticket.id)!.billingEntry!.issuedAt, null);

  // Once issued, every one of those shows it.
  ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }));
  assert.equal((ok(await exec(MY_INVOICES, { as: f.customer })).myInvoices as unknown[]).length, 1);
  assert.equal(((ok(await exec(INVOICE, { as: f.customer, variables: { id: d.id } })).invoice) as Entry).invoiceNumber, 'INV-000001');
  const issuedRow = await prisma.billingEntry.findUniqueOrThrow({ where: { id: d.id } });
  assert.equal(ServiceRun.billingEntry({ billingEntry: issuedRow }, {}, ctxOf(f.customer))?.id, d.id);
  assert.equal(
    (ok(await exec(`{ myBillingReport { totalIssued } }`, { as: f.customer })).myBillingReport as { totalIssued: string }).totalIssued,
    '1500000',
  );
});

test('an issued invoice is its own customer’s: another customer gets NOT_FOUND, exactly as for a missing id', async () => {
  const d = await draft();
  ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }));
  assert.equal((await exec(INVOICE, { as: f.stranger, variables: { id: d.id } })).code, 'NOT_FOUND');
  assert.deepEqual(ok(await exec(MY_INVOICES, { as: f.stranger })).myInvoices, []);
  assert.equal((await exec(MY_INVOICES, { as: null })).code, 'UNAUTHENTICATED');
});

test('every resolver that can return a BillingEntry is accounted for — a new edge must decide its draft rule before it ships', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const files: string[] = [];
  const walk = (d: string, prefix = '') => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${d}${entry.name}/`, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.ts')) files.push(`${prefix}${entry.name}`);
    }
  };
  walk(dir);
  const mentions = files.filter((name) => /billingEntry|BillingEntry/.test(readFileSync(`${dir}${name}`, 'utf8')));
  // Every file below is here for a stated reason. A file that starts to read or
  // return billing entries and is not in this table fails this test on purpose.
  const accounted: Record<string, string> = {
    'admin/billing.ts': 'staff mutations (billing.manage); every creator writes a draft',
    'admin/invoices.ts': 'staff mutations (billing.manage)',
    'brief.ts': 'counts issued entries to refuse replacing a plan (PLAN_HAS_ISSUED_INVOICES)',
    'fields.ts': 'the field resolvers: ServiceRun.billingEntry and Ticket.billingEntry ask invoiceVisibleTo',
    'index.ts': 'composition only',
    'invoices.ts': 'the customer’s reads (issued only, in the where) and PlannedInvoice.invoice (invoiceVisibleTo)',
    'people.ts': 'the desk’s customer page, money-gated, through computeBillingReport (which skips drafts)',
    'query.ts': 'myBillingReport (computeBillingReport skips drafts) and billing.manage’s staff reads',
    'services.ts': 'include only — the edge is resolved in fields.ts',
    'tickets.ts': 'include only — the edge is resolved in fields.ts',
    'wizard.ts': 'overdue invoices for the status area (issued only, in the where)',
  };
  assert.deepEqual(mentions.sort(), Object.keys(accounted).sort(), 'a resolver file reads or returns billing entries that this test does not know about');

  // Code only: a comment that names `issuedAt: { not: null }` is not a query.
  const read = (name: string) =>
    readFileSync(`${dir}${name}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  const fields = read('fields.ts');
  assert.equal((fields.match(/invoiceVisibleTo\(/g) ?? []).length, 2, 'ServiceRun.billingEntry and Ticket.billingEntry');
  assert.equal((read('invoices.ts').match(/issuedAt: \{ not: null \}/g) ?? []).length, 2, 'myInvoices and invoice(id) select issued rows only');
  assert.match(read('invoices.ts'), /invoiceVisibleTo\(viewerOf\(ctx\), entry\)/, 'PlannedInvoice.invoice');
  assert.match(read('wizard.ts'), /issuedAt: \{ not: null \}/);
  // The report's two customer-facing callers go through the one function that skips drafts.
  assert.match(read('query.ts'), /computeBillingReport\(entries\)/);
  assert.match(read('people.ts'), /computeBillingReport\(/);
});

test('updateInvoiceDraft and deleteInvoiceDraft work on a draft and refuse an issued invoice (NOT_A_DRAFT)', async () => {
  const d = await draft({ term: 3 });
  const edited = ok(await exec(UPDATE_DRAFT, { as: staff.SALES, variables: { e: d.id, amount: '2500000', term: null } })).updateInvoiceDraft as Entry;
  assert.equal(edited.amount, '2500000');
  assert.equal(edited.descriptionEn, 'Edited');
  assert.equal(edited.paymentTermDays, null, 'a replace: the omitted term is cleared');
  assert.equal(edited.issuedAt, null, 'editing never issues');

  const gone = await draft();
  assert.equal(ok(await exec(DELETE_DRAFT, { as: staff.SALES, variables: { e: gone.id } })).deleteInvoiceDraft, true);
  assert.equal(await prisma.billingEntry.count({ where: { id: gone.id } }), 0);
  assert.equal((await exec(DELETE_DRAFT, { as: staff.SALES, variables: { e: gone.id } })).code, 'NOT_FOUND');

  ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }));
  assert.equal((await exec(UPDATE_DRAFT, { as: staff.SALES, variables: { e: d.id, amount: '1', term: null } })).code, 'NOT_A_DRAFT');
  assert.equal((await exec(DELETE_DRAFT, { as: staff.SALES, variables: { e: d.id } })).code, 'NOT_A_DRAFT');
  assert.equal(await prisma.billingEntry.count({ where: { id: d.id } }), 1, 'an issued invoice is never deleted');
});

test('the draft’s own input is checked: INVALID_AMOUNT, INVALID_TERM, and a missing customer', async () => {
  const bad = (amount: string, term: number | null) => exec(CREATE_DRAFT, { as: staff.SALES, variables: { c: f.customer.id, amount, term } });
  assert.equal((await bad('100.5', null)).code, 'INVALID_AMOUNT');
  assert.equal((await bad('-5', null)).code, 'INVALID_AMOUNT');
  assert.equal((await bad('1000', -1)).code, 'INVALID_TERM');
  assert.equal((await bad('1000', 366)).code, 'INVALID_TERM');
  assert.equal((await exec(CREATE_DRAFT, { as: staff.SALES, variables: { c: 'nobody', amount: '1000', term: null } })).code, 'NOT_FOUND');
  const d = await draft();
  assert.equal((await exec(UPDATE_DRAFT, { as: staff.SALES, variables: { e: d.id, amount: '1000', term: 999 } })).code, 'INVALID_TERM');
  assert.equal((await exec(UPDATE_DRAFT, { as: staff.SALES, variables: { e: d.id, amount: 'x', term: null } })).code, 'INVALID_AMOUNT');
});

// =====================================================================================
// Issuing

test('issueInvoice numbers the invoice off the sequence, dates it now, and is due the default term later; the customer is told', async () => {
  const before = Date.now();
  const a = await draft();
  const b = await draft({ term: 14 });
  const issuedA = ok(await exec(ISSUE, { as: staff.SALES, variables: { e: a.id } })).issueInvoice as Entry;
  const issuedB = ok(await exec(ISSUE, { as: staff.SALES, variables: { e: b.id } })).issueInvoice as Entry;

  assert.equal(issuedA.invoiceNumber, 'INV-000001');
  assert.equal(issuedB.invoiceNumber, 'INV-000002');
  assert.ok(new Date(issuedA.issuedAt!).getTime() >= before);
  // DEFAULT_PAYMENT_TERM_DAYS is pinned to 7 in this suite; B carries its own 14.
  assert.equal(issuedA.paymentTermDays, 7);
  assert.equal(dayOf(issuedA.dueAt!), addDays(issuedA.issuedAt!, 7));
  assert.equal(issuedB.paymentTermDays, 14);
  assert.equal(dayOf(issuedB.dueAt!), addDays(issuedB.issuedAt!, 14));
  assert.equal(issuedA.dueAt!.slice(10), 'T00:00:00.000Z', 'a due date is a calendar day, midnight UTC (PD-19)');

  // A second press: ALREADY_ISSUED, and no number is taken for it.
  assert.equal((await exec(ISSUE, { as: staff.SALES, variables: { e: a.id } })).code, 'ALREADY_ISSUED');
  assert.equal((await sequenceState()).last_value, 2n);

  // The customer's own mail and SMS, in their language (fa), carrying the number.
  assert.equal(mail.length, 2);
  assert.equal(mail[0].to, f.customer.email);
  assert.ok(mail[0].subject.includes('INV-000001') && mail[0].subject.includes('صورت‌حساب'), mail[0].subject);
  assert.ok(mail[0].text.includes('/fa/app/invoices/'), 'the link goes to the invoice, in the customer’s language');
  assert.equal(sms.length, 2);
  assert.equal(sms[0].to, f.customer.phone);
  assert.match(sms[0].text!, /\/fa\/app\/invoices\//);
  // And now they can read them, newest first.
  const mine = ok(await exec(MY_INVOICES, { as: f.customer })).myInvoices as Entry[];
  assert.deepEqual(mine.map((e) => e.invoiceNumber), ['INV-000002', 'INV-000001']);
});

test('an English-speaking customer is told in English, with the invoice number Latin and the amount grouped', async () => {
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  const d = await draft({ amount: '45000000' });
  ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }));
  assert.match(mail[0].subject, /^Invoice INV-000001 from Root$/);
  assert.ok(mail[0].text.includes('45,000,000 Toman'));
  assert.match(sms[0].text!, /\/en\/app\/invoices\//);
});

test('issueInvoice on a missing entry is NOT_FOUND; markBillingEntryPaid on a draft is NOT_ISSUED', async () => {
  assert.equal((await exec(ISSUE, { as: staff.SALES, variables: { e: 'nope' } })).code, 'NOT_FOUND');
  const d = await draft();
  assert.equal((await exec(MARK_PAID, { as: staff.SALES, variables: { e: d.id } })).code, 'NOT_ISSUED');
  ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }));
  const paid = ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: d.id } })).markBillingEntryPaid as Entry;
  assert.ok(paid.paidAt);
  const back = ok(await exec(UNMARK_PAID, { as: staff.SALES, variables: { e: d.id } })).unmarkBillingEntryPaid as Entry;
  assert.equal(back.paidAt, null);
});

test('overdue is derived on read: an unpaid invoice past its due day is overdue, on the day itself it is not, paid it never is', async () => {
  const d = await draft({ term: 0 });
  const issued = ok(await exec(ISSUE, { as: staff.SALES, variables: { e: d.id } })).issueInvoice as Entry;
  assert.equal(issued.overdue, false, 'a zero term is due today, and today is the last day to pay');
  const yesterday = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 1));
  await prisma.billingEntry.update({ where: { id: d.id }, data: { dueAt: yesterday } });
  assert.equal((ok(await exec(INVOICE, { as: f.customer, variables: { id: d.id } })).invoice as Entry).overdue, true);
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: d.id } }));
  assert.equal((ok(await exec(INVOICE, { as: f.customer, variables: { id: d.id } })).invoice as Entry).overdue, false);
});

// =====================================================================================
// Subscription entries: issued, numbered, and a refresh burns nothing

test('a subscription’s entries are issued and numbered as the lazy generator writes them — oldest first, due the default term after the period starts', async () => {
  const now = new Date();
  const activeFrom = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  ok(
    await exec(
      `mutation($c: ID!, $from: DateTime!){ createSubscription(customerId: $c, labelFa: "پیامک", labelEn: "SMS API", amount: "250000", period: MONTHLY, activeFrom: $from) { id } }`,
      { as: staff.SALES, variables: { c: f.customer.id, from: activeFrom.toISOString() } },
    ),
  );
  const first = ok(await exec(MY_INVOICES, { as: f.customer })).myInvoices as Entry[];
  assert.equal(first.length, 3, 'three months due: two back and this one');
  for (const e of first) {
    assert.equal(e.source, 'SUBSCRIPTION');
    assert.match(e.invoiceNumber!, /^INV-\d{6}$/);
    assert.equal(e.paymentTermDays, 7);
    assert.equal(dayOf(e.dueAt!), addDays(e.issuedAt!, 7), 'due the default term after it was issued');
  }
  const byPeriod = await prisma.billingEntry.findMany({ where: { source: 'SUBSCRIPTION' }, orderBy: { periodStart: 'asc' } });
  assert.deepEqual(byPeriod.map((e) => e.invoiceNumber), ['INV-000001', 'INV-000002', 'INV-000003'], 'numbers follow the period');
  assert.deepEqual(byPeriod.map((e) => e.issuedAt!.getTime()), byPeriod.map((e) => e.periodStart!.getTime()), 'issued at its period start, as it always was');

  // A refresh finds every period billed *before* it takes a number: nothing is burned.
  const seq = await sequenceState();
  ok(await exec(MY_INVOICES, { as: f.customer }));
  ok(await exec(`{ allBillingEntries { id } }`, { as: staff.SALES }));
  assert.deepEqual(await sequenceState(), seq);
  assert.equal(await prisma.billingEntry.count({ where: { source: 'SUBSCRIPTION' } }), 3);
  // No notification: this ran because somebody opened billing, not because a person issued anything.
  assert.equal(mail.length, 0);
  assert.equal(sms.length, 0);
});

test('two readers generating the same subscription at once still produce one entry per period (the unique index, not the resolver)', async () => {
  const activeFrom = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1));
  ok(
    await exec(
      `mutation($c: ID!, $from: DateTime!){ createSubscription(customerId: $c, labelFa: "ه", labelEn: "Hosting", amount: "100000", period: MONTHLY, activeFrom: $from) { id } }`,
      { as: staff.SALES, variables: { c: f.customer.id, from: activeFrom.toISOString() } },
    ),
  );
  await Promise.all([exec(MY_INVOICES, { as: f.customer }), exec(MY_INVOICES, { as: f.customer }), exec(`{ allBillingEntries { id } }`, { as: staff.SALES })]);
  const rows = await prisma.billingEntry.findMany({ where: { source: 'SUBSCRIPTION' } });
  assert.equal(new Set(rows.map((r) => r.periodStart!.getTime())).size, rows.length, 'no period billed twice');
  assert.equal(new Set(rows.map((r) => r.invoiceNumber)).size, rows.length, 'and no number twice');
});

// =====================================================================================
// The plan rule, end to end

test('the plan rule: NOT_SIGNED → PREVIOUS_UNPAID → PHASE_NOT_ACCEPTED, each row reporting its state, and SUCCESSOR_ISSUED on the way back', async () => {
  const { rows, phaseId } = await makePlan();
  const [p1, p2, p3] = rows;

  // Nothing is signed: every row waits on the signature.
  assert.deepEqual(states(await readPlan(staff.SALES)), ['NOT_YET_ISSUABLE/NOT_SIGNED', 'NOT_YET_ISSUABLE/NOT_SIGNED', 'NOT_YET_ISSUABLE/NOT_SIGNED']);
  assert.equal((await issuePlanned(p1.id)).code, 'NOT_SIGNED');
  assert.equal(await prisma.billingEntry.count(), 0);
  assert.equal((await sequenceState()).is_called, false, 'a refusal burns no number');

  // Signed (the row J7 will write): only the first is issuable.
  await sign();
  assert.deepEqual(states(await readPlan(staff.SALES)), ['ISSUABLE', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  assert.equal((await issuePlanned(p2.id)).code, 'PREVIOUS_UNPAID', 'out of order');

  // Issue the first.
  const issued = ok(await issuePlanned(p1.id)).issuePlannedInvoice as { paymentPlan: PlanRead };
  assert.deepEqual(states(issued.paymentPlan), ['ISSUED', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  const e1 = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: p1.id } });
  assert.equal(e1.customerId, f.customer.id);
  assert.equal(e1.contractId, f.contract.id);
  assert.equal(e1.source, 'CONTRACT');
  assert.equal(e1.amount, 50_000_000n);
  assert.equal(e1.descriptionEn, 'Deposit');
  assert.equal(e1.descriptionFa, 'پیش‌پرداخت');
  assert.equal(e1.invoiceNumber, 'INV-000001');
  assert.equal(e1.paymentTermDays, 5, 'the row’s own term, not the default');
  assert.equal(day(e1.dueAt!), addDays(e1.issuedAt!.toISOString(), 5));
  assert.equal(e1.phaseId, null);
  // Told, exactly once.
  assert.equal(mail.length, 1);
  assert.ok(mail[0].subject.includes('INV-000001'));

  // A second press of the same row.
  assert.equal((await issuePlanned(p1.id)).code, 'ALREADY_ISSUED');
  assert.equal((await issuePlanned(p2.id)).code, 'PREVIOUS_UNPAID');

  // Paid: the phase-tied row now waits on its phase, not on the payment.
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: e1.id } }));
  assert.deepEqual(states(await readPlan(staff.SALES)), ['PAID', 'NOT_YET_ISSUABLE/PHASE_NOT_ACCEPTED', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  assert.equal((await issuePlanned(p2.id)).code, 'PHASE_NOT_ACCEPTED');

  // Another phase's accepted demo does not count; neither does a different step's approval.
  const other = await phaseOf(2);
  await accept(other.id);
  assert.equal((await issuePlanned(p2.id)).code, 'PHASE_NOT_ACCEPTED', 'a different phase');
  // The flip: this phase's demo approved — the row J10 will write — and it is issuable.
  await accept(phaseId);
  assert.deepEqual(states(await readPlan(staff.SALES)), ['PAID', 'ISSUABLE', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  ok(await issuePlanned(p2.id));
  const e2 = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: p2.id } });
  assert.equal(e2.invoiceNumber, 'INV-000002');
  assert.equal(e2.phaseId, phaseId, 'a phase-tied invoice carries its phase, so the portal can say what it waited on');
  assert.equal(e2.paymentTermDays, 10);

  // The first can no longer be un-paid: the second was issued on the strength of it.
  assert.equal((await exec(UNMARK_PAID, { as: staff.SALES, variables: { e: e1.id } })).code, 'SUCCESSOR_ISSUED');
  assert.ok((await prisma.billingEntry.findUniqueOrThrow({ where: { id: e1.id } })).paidAt, 'and it stayed paid');

  // The last row: unpaid predecessor, then paid, then issued; the second is then locked in too.
  assert.equal((await issuePlanned(p3.id)).code, 'PREVIOUS_UNPAID');
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: e2.id } }));
  ok(await exec(UNMARK_PAID, { as: staff.SALES, variables: { e: e2.id } })); // nothing issued after it yet: reversible
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: e2.id } }));
  ok(await issuePlanned(p3.id));
  assert.equal((await exec(UNMARK_PAID, { as: staff.SALES, variables: { e: e2.id } })).code, 'SUCCESSOR_ISSUED');
  assert.deepEqual(states(await readPlan(staff.SALES)), ['PAID', 'PAID', 'ISSUED']);
  assert.equal((await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: p3.id } })).invoiceNumber, 'INV-000003');
});

test('a planned invoice with a phase that was deleted (phaseId set null) loses its condition, exactly as J4 promised', async () => {
  const { rows, phaseId } = await makePlan();
  await sign();
  ok(await issuePlanned(rows[0].id));
  const first = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: rows[0].id } });
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: first.id } }));
  assert.equal((await issuePlanned(rows[1].id)).code, 'PHASE_NOT_ACCEPTED');
  await prisma.phase.delete({ where: { id: phaseId } });
  ok(await issuePlanned(rows[1].id));
});

test('the customer reads the plan and each row’s state; a designer reads none of it (PD-14)', async () => {
  const { rows } = await makePlan();
  await sign();
  ok(await issuePlanned(rows[0].id));
  const asCustomer = await readPlan(f.customer);
  assert.deepEqual(states(asCustomer), ['ISSUED', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID', 'NOT_YET_ISSUABLE/PREVIOUS_UNPAID']);
  assert.equal(asCustomer.invoices[0].invoice!.invoiceNumber, 'INV-000001');
  assert.equal(asCustomer.invoices[1].invoice, null);
  // View-as-customer is the same answer through the same rules.
  assert.deepEqual(states(await readPlan(staff.SALES, true)), states(asCustomer));
  // A designer's read of the contract succeeds and the plan (and so every invoice under it) is null.
  const designer = ok(await exec(PLAN_OF, { as: staff.DESIGNER, variables: { c: f.contract.id, as: false } })).contract as { paymentPlan: PlanRead };
  assert.equal(designer.paymentPlan, null);
});

test('two presses of Issue next at once make one invoice: one succeeds, the other is ALREADY_ISSUED, and only one number is taken', async () => {
  await sign();
  const { rows } = await makePlan();
  const results = await Promise.all([issuePlanned(rows[0].id), issuePlanned(rows[0].id)]);
  const codes = results.map((r) => r.code ?? 'OK').sort();
  assert.deepEqual(codes, ['ALREADY_ISSUED', 'OK']);
  assert.equal(await prisma.billingEntry.count({ where: { plannedInvoiceId: rows[0].id } }), 1);
  assert.equal((await sequenceState()).last_value, 1n, 'the loser found the entry before it took a number');
  assert.equal(mail.length, 1, 'and the customer was told once');
});

test('two presses of Issue on one draft make one invoice too', async () => {
  const d = await draft();
  const results = await Promise.all([exec(ISSUE, { as: staff.SALES, variables: { e: d.id } }), exec(ISSUE, { as: staff.SALES, variables: { e: d.id } })]);
  assert.deepEqual(results.map((r) => r.code ?? 'OK').sort(), ['ALREADY_ISSUED', 'OK']);
  assert.equal((await sequenceState()).last_value, 1n);
  assert.equal(mail.length, 1);
});

test('two different rows of one plan pressed at once: the contract lock serializes them and the rule holds (the second is refused, not issued)', async () => {
  await sign();
  const { rows } = await makePlan();
  const results = await Promise.all([issuePlanned(rows[0].id), issuePlanned(rows[1].id)]);
  assert.deepEqual(results.map((r) => r.code ?? 'OK').sort(), ['OK', 'PREVIOUS_UNPAID']);
  assert.equal(await prisma.billingEntry.count(), 1);
});

// ---- J4's owed guard ----------------------------------------------------------------

const SET_PLAN = `mutation($c: ID!, $s: PaymentSplit!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: $s, invoices: $r) { id ${PLAN} } }`;
const oneRow = (labelEn: string, amount: string) => [{ labelFa: 'ردیف', labelEn, amount, paymentTermDays: 7 }];

test('setPaymentPlan refuses to replace a plan once any row has been issued (PLAN_HAS_ISSUED_INVOICES), and still replaces one nothing was issued from', async () => {
  await makePlan();
  // Nothing issued: a replace is what it always was.
  const replaced = ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'LUMP_SUM', r: oneRow('Whole', '150000000') } })).setPaymentPlan as { paymentPlan: PlanRead };
  assert.equal(replaced.paymentPlan!.invoices.length, 1);

  // Issue that one, and the same call is refused — with the plan and its invoice untouched.
  // "Signed" here is the current revision's signature, which `agreementSignedAt`
  // accepts and which locks nothing: the AGREEMENT `StepApproval` J7 will write
  // locks REQUIREMENTS outright (`STEP_LOCKED`, checked first), so this guard is
  // the *only* one exactly until J7 — the state this test stands in.
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Customer', signedHash: f.contractRevision.contentHash },
  });
  const only = replaced.paymentPlan!.invoices[0];
  ok(await issuePlanned(only.id));
  const refused = await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: oneRow('Other', '1') } });
  assert.equal(refused.code, 'PLAN_HAS_ISSUED_INVOICES');
  const after = await readPlan(staff.SALES);
  assert.equal(after.invoices.length, 1);
  assert.equal(after.invoices[0].id, only.id, 'the row is the same row');
  assert.equal(after.invoices[0].invoice!.invoiceNumber, 'INV-000001');

  // Once the agreement is approved the step is locked and that is what answers.
  await sign();
  const locked = await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: oneRow('Other', '1') } });
  assert.equal(locked.code, 'STEP_LOCKED');
});

// =====================================================================================
// "Started", and the status area

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

test('started: a contract with a plan is started once it is signed and its first invoice is paid; without a plan, once it is signed', async () => {
  const summary = async (as: User = f.customer) => (ok(await exec(SUMMARY, { as, variables: { c: f.contract.id } })).contract as { statusSummary: { started: boolean; startedAt: string | null; overdueCount: number } }).statusSummary;

  // No plan (and so no first invoice to wait for): signed is started.
  assert.equal((await summary()).started, false);
  const approval = await sign();
  const noPlan = await summary();
  assert.equal(noPlan.started, true);
  assert.equal(noPlan.startedAt, approval.approvedAt.toISOString());
  await prisma.stepApproval.delete({ where: { id: approval.id } });

  // A plan: unsigned, signed, first invoice issued, first invoice paid.
  const { rows } = await makePlan();
  assert.equal((await summary()).started, false);
  await sign();
  assert.equal((await summary()).started, false, 'signed, but the first invoice is not paid');
  ok(await issuePlanned(rows[0].id));
  assert.equal((await summary()).started, false, 'issued is not paid');
  const first = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: rows[0].id } });
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: first.id } }));
  const started = await summary();
  assert.equal(started.started, true);
  assert.ok(started.startedAt, 'the moment the payment made it so');
  // Un-paying it (nothing issued after) un-starts it — "started" is derived, never stored.
  ok(await exec(UNMARK_PAID, { as: staff.SALES, variables: { e: first.id } }));
  assert.equal((await summary()).started, false);
});

test('a legacy contract — design first, no payment plan — keeps started = signed, exactly as before J13', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  const status = async () =>
    (ok(await exec(SUMMARY, { as: f.customer, variables: { c: f.contract.id } })).contract as { statusSummary: { started: boolean; startedAt: string | null } }).statusSummary;
  assert.equal((await status()).started, false);
  const signature = await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Customer', signedHash: f.contractRevision.contentHash },
  });
  const signed = await status();
  assert.equal(signed.started, true);
  assert.equal(signed.startedAt, signature.signedAt.toISOString(), 'the signature is the date, as it was');
});

test('overdue invoices are said on read: the customer and sales see INVOICE_OVERDUE and the count; a designer does not; paid, the line is gone', async () => {
  const { rows } = await makePlan();
  await sign();
  ok(await issuePlanned(rows[0].id));
  const entry = await prisma.billingEntry.findFirstOrThrow({ where: { plannedInvoiceId: rows[0].id } });
  const read = async (as: User) =>
    ok(await exec(SUMMARY, { as, variables: { c: f.contract.id } })).contract as {
      statusSummary: { overdueCount: number };
      attention: Array<{ kind: string; waitingOn: string; params: Array<{ key: string; value: string }> }>;
    };
  const overdue = (r: Awaited<ReturnType<typeof read>>) => r.attention.filter((a) => a.kind === 'INVOICE_OVERDUE');

  assert.deepEqual(overdue(await read(f.customer)), [], 'not yet due, not overdue');
  await prisma.billingEntry.update({ where: { id: entry.id }, data: { dueAt: new Date(Date.UTC(ago(3).getUTCFullYear(), ago(3).getUTCMonth(), ago(3).getUTCDate())) } });

  for (const who of [f.customer, staff.SALES]) {
    const r = await read(who);
    assert.equal(overdue(r).length, 1, who.email ?? '');
    assert.equal(overdue(r)[0].waitingOn, 'CUSTOMER');
    assert.deepEqual(overdue(r)[0].params, [{ key: 'count', value: '1' }]);
    assert.equal(r.statusSummary.overdueCount, 1);
  }
  // Money is not the designer's to know (PD-21) — the line is filtered, like every money item.
  assert.deepEqual(overdue(await read(staff.DESIGNER)), []);
  // Paid: gone.
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: entry.id } }));
  assert.deepEqual(overdue(await read(f.customer)), []);
  assert.equal((await read(f.customer)).statusSummary.overdueCount, 0);
});

// =====================================================================================
// Capabilities and money

test('every invoice mutation and the plan list are billing.manage: design, development, contributor and the customer are FORBIDDEN before anything is looked up', async () => {
  const d = await draft();
  const { rows } = await makePlan();
  const ops: Array<[string, string, Record<string, unknown>]> = [
    ['createInvoiceDraft', CREATE_DRAFT, { c: f.customer.id, amount: '1', term: null }],
    ['updateInvoiceDraft', UPDATE_DRAFT, { e: d.id, amount: '1', term: null }],
    ['deleteInvoiceDraft', DELETE_DRAFT, { e: d.id }],
    ['issueInvoice', ISSUE, { e: d.id }],
    ['issuePlannedInvoice', ISSUE_PLANNED, { p: rows[0].id }],
    ['markBillingEntryPaid', MARK_PAID, { e: d.id }],
    ['unmarkBillingEntryPaid', UNMARK_PAID, { e: d.id }],
    ['contractsWithPaymentPlan', `{ contractsWithPaymentPlan { id } }`, {}],
  ];
  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    for (const [name, doc, variables] of ops) {
      assert.equal((await exec(doc, { as: who, variables })).code, 'FORBIDDEN', `${who.email} · ${name}`);
    }
  }
  // …and nothing moved.
  assert.equal((await prisma.billingEntry.findUniqueOrThrow({ where: { id: d.id } })).issuedAt, null);
  assert.equal(await prisma.billingEntry.count(), 1);
  // Anonymous is not signed in at all.
  assert.equal((await exec(ISSUE, { as: null, variables: { e: d.id } })).code, 'UNAUTHENTICATED');
});

test('contractsWithPaymentPlan lists the contracts that have a plan, narrowed by customer, each with its rows’ states', async () => {
  assert.deepEqual((ok(await exec(`{ contractsWithPaymentPlan { id } }`, { as: staff.SALES })).contractsWithPaymentPlan as unknown[]), []);
  await makePlan();
  const all = ok(await exec(`query($c: ID){ contractsWithPaymentPlan(customerId: $c) { id ref ${PLAN} } }`, { as: staff.SALES, variables: { c: null } })).contractsWithPaymentPlan as Array<{
    id: string;
    ref: string;
    paymentPlan: PlanRead;
  }>;
  assert.equal(all.length, 1);
  assert.equal(all[0].ref, f.contract.ref);
  assert.equal(all[0].paymentPlan!.invoices.length, 3);
  const none = ok(await exec(`query($c: ID){ contractsWithPaymentPlan(customerId: $c) { id } }`, { as: staff.SALES, variables: { c: f.stranger.id } })).contractsWithPaymentPlan;
  assert.deepEqual(none, []);
});
