import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import * as yazl from 'yazl';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { storage } from '../lib/storage.js';
import { statementsRun } from '../lib/prisma.js';
import { __setMailTransportForTests, __resetMailTransportForTests } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J12 — the customer's dashboard and a home screen per staff role (journeys
 * build plan §5 "J12"): `myAttention`, and V4's Needs-Root queue re-pointed at
 * the attention module.
 *
 * In this order: **the customer** (two contracts, an invoice and a request, each
 * with its route, and a thread that clears by the next act, not by being read);
 * **sales**; **a designer assigned to one of two contracts**; **a developer**;
 * **ADMIN**, who sees everything through `assignments.override`; **a closed
 * contract** (J11) gone from the designer's and the developer's homes; **the
 * mockup** (J9b's owed gap, the whole step 5 as the designer and the customer
 * see it); **the Needs-Root queue**, by attention and not by status; **one rule
 * set** (the contract page's own `attention` against the home's items); **what a
 * home costs** in queries, which must not grow with the book; and who gets
 * nothing at all.
 *
 * Everything that is not the subject is carried by the real mutations — the
 * agreement signed, an invoice issued, a mockup iteration published, a demo
 * approved — and the rows that would take a long road to reach (an open note on
 * a step, a pending answer) go in by direct insert, as `j3.test.ts` does.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let contractB: { id: string; projectId: string };

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  staff.DESIGNER2 = await prisma.user.create({ data: { email: 'designer2@test.local', name: 'Designer 2', roles: ['DESIGNER'], state: 'ACTIVE' } });
  staff.DEVELOPER2 = await prisma.user.create({ data: { email: 'developer2@test.local', name: 'Developer 2', roles: ['DEVELOPER'], state: 'ACTIVE' } });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id } });
  // The customer's second contract, on a project of its own and another pair of assignees.
  const project = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'دوم', titleEn: 'Second' } });
  contractB = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'قرارداد دوم',
      titleEn: 'Second contract',
      customerId: f.customer.id,
      projectId: project.id,
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date('2026-07-02T09:00:00Z'),
      designerId: staff.DESIGNER2.id,
      developerId: staff.DEVELOPER2.id,
    },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.createMany({
    data: [
      { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
      { typeId: type.id, key: 'about', kind: 'PAGE', labelFa: 'درباره‌ی ما', labelEn: 'About', position: 1 },
      { typeId: type.id, key: 'cart', kind: 'FEATURE', labelFa: 'سبد خرید', labelEn: 'Cart', position: 2 },
    ],
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

// =================================================================================================
// Documents and fixtures
// =================================================================================================

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE =
  'mutation($c: ID!, $n: Int!, $e: String!){ createPhase(contractId: $c, number: $n, titleFa: "فاز", titleEn: "Phase", plannedEndAt: $e) { id } }';
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH_DRAFT = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE_AGREEMENT = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';
const ISSUE_PLANNED = 'mutation($p: ID!){ issuePlannedInvoice(plannedInvoiceId: $p) { id } }';
const MARK_PAID = 'mutation($e: ID!){ markBillingEntryPaid(entryId: $e) { id } }';
const SUBMIT_REQUEST = 'mutation($t: String!, $b: String!){ submitRequest(title: $t, body: $b, lang: "en") { id } }';
const POST_MESSAGE = 'mutation($p: ID!, $b: String!){ postRequestMessage(projectId: $p, body: $b) { id } }';
const CREATE_TICKET = 'mutation($s: String!){ createTicket(type: QUESTION, subject: $s, body: "Please help") { id } }';
const ADD_TICKET_MESSAGE = 'mutation($t: ID!, $b: String!){ addTicketMessage(ticketId: $t, body: $b) { id } }';

const HOME = `query { myAttention {
  kind variant audience contractId phaseId waitingOn role since route
  params { key value }
  subject { ref titleEn customerName }
} }`;

type HomeItem = {
  kind: string;
  variant: string;
  audience: 'CUSTOMER' | 'STAFF';
  contractId: string | null;
  phaseId: string | null;
  waitingOn: 'CUSTOMER' | 'ROOT';
  role: string | null;
  since: string;
  route: string;
  params: Array<{ key: string; value: string }>;
  subject: { ref: string | null; titleEn: string; customerName: string };
};

const homeOf = async (as: User): Promise<HomeItem[]> => (ok(await exec(HOME, { as })).myAttention as HomeItem[]);
const tag = (i: HomeItem) => `${i.kind}/${i.variant}${i.contractId ? `@${i.contractId === f.contract.id ? 'A' : i.contractId === contractB.id ? 'B' : '?'}` : ''}`;
const tags = (items: HomeItem[]) => items.map(tag).sort();
const param = (i: HomeItem, key: string) => i.params.find((p) => p.key === key)?.value;

const BRIEF_INPUT = {
  kind: 'NEW_SITE',
  templateTypeId: '',
  designTier: 'THEME_PICK',
  budgetCap: '150000000',
  hardDeadline: '2026-10-23',
  domainName: 'nahal.ir',
  domainProvidedBy: 'CUSTOMER',
  hostProvidedBy: 'ROOT',
  contentProvidedBy: 'CUSTOMER',
  supportMonths: 6,
  premadeRounds: 2,
  wireframeIterations: null,
  mockupIterations: null,
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
};
const CUSTOM_BRIEF = { designTier: 'SENIOR_DESIGNER', premadeRounds: null, wireframeIterations: 2, mockupIterations: 2 };

/**
 * Contract A, signed on the new road through the real mutations: the brief, two
 * phases, a payment plan (the first row tied to nothing, so it is issuable the
 * moment the agreement is signed; the second waits for it to be paid), the scope,
 * the draft published, approved and signed. The fixture's own legacy design is
 * removed, as `j9b.test.ts` does, so the design step is the new road's.
 */
async function signed(over: Record<string, unknown> = {}) {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentDesignRevisionId: null } });
  await prisma.designRevision.deleteMany({ where: { contractId: f.contract.id } });
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id, ...over } } }));
  for (const [n, end] of [[1, '2026-11-10'], [2, '2026-12-10']] as const) {
    ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n, e: end } }));
  }
  const phases = await prisma.phase.findMany({ where: { contractId: f.contract.id }, orderBy: { number: 'asc' } });
  ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: {
        c: f.contract.id,
        r: [
          { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId: null, paymentTermDays: 7 },
          { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: phases[1].id, paymentTermDays: 7 },
        ],
      },
    }),
  );
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  ok(await exec(PUBLISH_DRAFT, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE_AGREEMENT, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  const plan = await prisma.plannedInvoice.findMany({ where: { plan: { contractId: f.contract.id } }, orderBy: { ordinal: 'asc' } });
  return { phases, plan };
}

/** An open customer note on a step — what the road to it would take a dozen mutations to write. */
async function openNote(contractId: string, step: 'DESIGN' | 'DEMO' | 'MOCKUP' | 'SCOPE', phaseId: string | null = null) {
  const projectId = (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).projectId;
  return prisma.feedbackItem.create({
    data: { projectId, contractId, step, phaseId, general: true, comments: { create: { authorId: f.customer.id, body: 'a note' } } },
  });
}

/** An answer written by a designer on a step where a designer's answer is not direct: waiting for sales. */
async function pendingAnswer(contractId: string, step: 'DESIGN' | 'SCOPE') {
  const projectId = (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).projectId;
  // One general thread per step (S2): an answer goes on the note that is already there.
  const existing = await prisma.feedbackItem.findFirst({ where: { contractId, step, general: true, phaseId: null } });
  if (existing) {
    await prisma.feedbackComment.create({
      data: { feedbackItemId: existing.id, authorId: staff.DESIGNER.id, body: 'an answer', resolution: 'ADDRESSED', approval: 'PENDING' },
    });
    return existing;
  }
  return prisma.feedbackItem.create({
    data: {
      projectId,
      contractId,
      step,
      general: true,
      comments: {
        create: [
          { authorId: f.customer.id, body: 'a note' },
          { authorId: staff.DESIGNER.id, body: 'an answer', resolution: 'ADDRESSED', approval: 'PENDING' },
        ],
      },
    },
  });
}

// =================================================================================================
// The customer
// =================================================================================================

test('the customer’s dashboard: two contracts, an invoice and a request — each item with its words, its side and the route that opens it', async () => {
  const { plan } = await signed();
  // A late commitment of the customer's on contract B, found on its project.
  await prisma.dependency.create({
    data: { projectId: contractB.projectId, side: 'CUSTOMER', titleFa: 'محتوا', titleEn: 'Content', dueAt: new Date('2026-09-01T00:00:00Z'), createdById: staff.SALES.id },
  });
  ok(await exec(ISSUE_PLANNED, { as: staff.SALES, variables: { p: plan[0].id } }));
  const invoice = await prisma.billingEntry.findFirstOrThrow({ where: { contractId: f.contract.id } });
  const request = (ok(await exec(SUBMIT_REQUEST, { as: f.customer, variables: { t: 'A shop', b: 'We need a shop.' } })).submitRequest as { id: string }).id;

  const before = await homeOf(f.customer);
  assert.deepEqual(tags(before), [
    'COMMITMENT_OVERDUE/customer@B',
    'INVOICE_DUE/default@A',
    'REQUEST_MESSAGE/sent',
    'STEP_WAITING/DESIGN@A',
  ]);
  assert.ok(before.every((i) => i.audience === 'CUSTOMER' && i.role !== 'DESIGNER' || i.kind === 'STEP_WAITING'));

  const byKind = Object.fromEntries(before.map((i) => [i.kind, i]));
  assert.equal(byKind.INVOICE_DUE.route, `/app/invoices/${invoice.id}`);
  assert.equal(byKind.INVOICE_DUE.waitingOn, 'CUSTOMER');
  assert.equal(param(byKind.INVOICE_DUE, 'number'), 'INV-000001');
  assert.equal(param(byKind.INVOICE_DUE, 'dueAt'), invoice.dueAt!.toISOString().slice(0, 10));
  assert.equal(byKind.COMMITMENT_OVERDUE.route, `/app/contracts/${contractB.id}`);
  assert.equal(byKind.COMMITMENT_OVERDUE.subject.ref, 'RC-TEST-002');
  assert.equal(byKind.REQUEST_MESSAGE.route, `/app/contracts?request=${request}`);
  assert.equal(byKind.REQUEST_MESSAGE.waitingOn, 'ROOT');
  assert.equal(byKind.STEP_WAITING.route, `/app/contracts/${f.contract.id}?step=DESIGN`);
  assert.equal(byKind.STEP_WAITING.waitingOn, 'ROOT');
  // What is theirs to do comes first, then what waits on Root.
  assert.deepEqual(before.map((i) => i.waitingOn), ['CUSTOMER', 'CUSTOMER', 'ROOT', 'ROOT']);

  // Root replies: the request becomes the customer's move — and it clears by the
  // customer's own next message, not by their having read it (the plan's trap).
  ok(await exec(POST_MESSAGE, { as: staff.SALES, variables: { p: request, b: 'Tell us more.' } }));
  const replied = (await homeOf(f.customer)).find((i) => i.kind === 'REQUEST_MESSAGE')!;
  assert.deepEqual([replied.variant, replied.waitingOn], ['reply', 'CUSTOMER']);
  assert.deepEqual((await homeOf(f.customer)).find((i) => i.kind === 'REQUEST_MESSAGE')!.variant, 'reply', 'reading it changes nothing: there is nothing to read');
  ok(await exec(POST_MESSAGE, { as: f.customer, variables: { p: request, b: 'A shop with a cart.' } }));
  assert.equal((await homeOf(f.customer)).find((i) => i.kind === 'REQUEST_MESSAGE')!.variant, 'sent');

  // The invoice is paid: the line goes.
  ok(await exec(MARK_PAID, { as: staff.SALES, variables: { e: invoice.id } }));
  assert.ok(!tags(await homeOf(f.customer)).some((t) => t.startsWith('INVOICE_')));

  // A stranger's account has none of this.
  assert.deepEqual(await homeOf(f.stranger), []);
});

test('a ticket is the customer’s move once Root has answered it and Root’s while it waits; an overdue invoice and the next one due are two lines', async () => {
  const ticket = (ok(await exec(CREATE_TICKET, { as: f.customer, variables: { s: 'The logo is blurry' } })).createTicket as { id: string }).id;
  const ticketItem = async () => (await homeOf(f.customer)).find((i) => i.kind === 'TICKET_REPLY')!;
  assert.deepEqual([(await ticketItem()).variant, (await ticketItem()).waitingOn], ['open', 'ROOT']);
  ok(await exec(ADD_TICKET_MESSAGE, { as: staff.SALES, variables: { t: ticket, b: 'Sending a new file.' } }));
  assert.deepEqual([(await ticketItem()).variant, (await ticketItem()).waitingOn, (await ticketItem()).route], ['reply', 'CUSTOMER', '/app/support']);
  ok(await exec('mutation($t: ID!){ setTicketStatus(ticketId: $t, status: RESOLVED) { id } }', { as: staff.SALES, variables: { t: ticket } }));
  assert.equal((await homeOf(f.customer)).some((i) => i.kind === 'TICKET_REPLY'), false, 'a resolved ticket is nobody’s move');

  // A subscription period, billed to no contract: one overdue, one not.
  const base = { customerId: f.customer.id, source: 'SERVICE' as const, descriptionFa: 'ا', descriptionEn: 'a', amount: BigInt(5_000_000) };
  const day = (n: number) => new Date(Date.now() + n * 86_400_000);
  const dueDay = (n: number) => new Date(Date.UTC(day(n).getUTCFullYear(), day(n).getUTCMonth(), day(n).getUTCDate()));
  await prisma.billingEntry.create({ data: { ...base, issuedAt: day(-30), invoiceNumber: 'INV-900001', paymentTermDays: 7, dueAt: dueDay(-23) } });
  await prisma.billingEntry.create({ data: { ...base, issuedAt: day(-2), invoiceNumber: 'INV-900002', paymentTermDays: 7, dueAt: dueDay(5) } });
  const items = await homeOf(f.customer);
  assert.deepEqual(tags(items), ['INVOICE_DUE/default', 'INVOICE_OVERDUE/default']);
  assert.ok(items.every((i) => i.contractId === null));
  assert.deepEqual(items.map((i) => i.route).sort(), ['/app/invoices', `/app/invoices/${(await prisma.billingEntry.findFirstOrThrow({ where: { invoiceNumber: 'INV-900002' } })).id}`].sort());
  // Sales chases the overdue one and only that.
  assert.deepEqual(tags(await homeOf(staff.SALES)), ['INVOICE_OVERDUE/default']);
});

test('the customer sees nothing of Root’s housekeeping: a pending answer, an issuable invoice, an unready staging site', async () => {
  const { phases } = await signed();
  await pendingAnswer(f.contract.id, 'SCOPE');
  await prisma.demo.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phases[0].id, kind: 'SITE', stagingUrl: 'http://nahal.staging.localhost:5179/' } });
  const mine = tags(await homeOf(f.customer));
  assert.ok(!mine.some((t) => ['ANSWER_PENDING_APPROVAL', 'INVOICE_ISSUABLE', 'DEMO_NOT_READY'].includes(t.split('/')[0])), mine.join(','));
  // …all of which sales, and the developer where it is theirs, do.
  assert.deepEqual(tags(await homeOf(staff.SALES)).filter((t) => t.startsWith('ANSWER') || t.startsWith('INVOICE')), ['ANSWER_PENDING_APPROVAL/default@A', 'INVOICE_ISSUABLE/default@A']);
});

// =================================================================================================
// Staff
// =================================================================================================

test('sales: pending answers, requests, issuable invoices and unanswered tickets — and none of the design’s or the demo’s own work', async () => {
  const { plan } = await signed();
  await openNote(f.contract.id, 'DESIGN');
  await pendingAnswer(f.contract.id, 'DESIGN');
  ok(await exec(SUBMIT_REQUEST, { as: f.customer, variables: { t: 'A shop', b: 'We need a shop.' } }));
  ok(await exec(CREATE_TICKET, { as: f.customer, variables: { s: 'The logo is blurry' } }));

  const items = await homeOf(staff.SALES);
  assert.deepEqual(tags(items), [
    'ANSWER_PENDING_APPROVAL/default@A',
    'INVOICE_ISSUABLE/default@A',
    'REQUEST_MESSAGE/unanswered',
    'TICKET_REPLY/unanswered',
  ]);
  assert.ok(items.every((i) => i.audience === 'STAFF' && i.role === 'SALES'));
  const routes = Object.fromEntries(items.map((i) => [i.kind, i.route]));
  assert.equal(routes.ANSWER_PENDING_APPROVAL, '/desk/approvals');
  assert.equal(routes.INVOICE_ISSUABLE, '/desk/billing');
  assert.match(routes.REQUEST_MESSAGE, /^\/desk\/requests\/.+/);
  assert.equal(routes.TICKET_REPLY, '/desk/tickets');
  assert.equal(items.find((i) => i.kind === 'INVOICE_ISSUABLE')!.waitingOn, 'ROOT');

  // Issuing the invoice is the act that clears it — the next row waits for this one to be paid.
  ok(await exec(ISSUE_PLANNED, { as: staff.SALES, variables: { p: plan[0].id } }));
  assert.ok(!tags(await homeOf(staff.SALES)).includes('INVOICE_ISSUABLE/default@A'));
});

test('a designer assigned to one of two contracts sees only that one’s design work; the other designer sees the other’s', async () => {
  await signed();
  await openNote(f.contract.id, 'DESIGN');
  await openNote(contractB.id, 'DESIGN');
  await pendingAnswer(f.contract.id, 'DESIGN');

  const mine = await homeOf(staff.DESIGNER);
  assert.deepEqual(tags(mine), ['FEEDBACK_UNRESOLVED/default@A', 'STEP_WAITING/DESIGN@A']);
  assert.ok(mine.every((i) => i.audience === 'STAFF' && i.role === 'DESIGNER'));
  const note = mine.find((i) => i.kind === 'FEEDBACK_UNRESOLVED')!;
  assert.equal(param(note, 'step'), 'DESIGN');
  assert.equal(note.route, `/desk/contracts/${f.contract.id}/steps?step=DESIGN`);
  assert.equal(mine.find((i) => i.kind === 'STEP_WAITING')!.waitingOn, 'ROOT');

  assert.deepEqual(tags(await homeOf(staff.DESIGNER2)), ['FEEDBACK_UNRESOLVED/default@B']);
  // The pending answer is a sales approval, not design work — though it is a designer's own answer.
  assert.ok(!tags(mine).some((t) => t.startsWith('ANSWER_PENDING')));
  // No money, no requests, no tickets, whatever the capability set.
  ok(await exec(SUBMIT_REQUEST, { as: f.customer, variables: { t: 'A shop', b: 'We need a shop.' } }));
  assert.deepEqual(tags(await homeOf(staff.DESIGNER)), ['FEEDBACK_UNRESOLVED/default@A', 'STEP_WAITING/DESIGN@A']);
});

test('a developer: the demo’s notes, a staging site no browser has seen report, the demo to start, a technical commitment — on the contracts they develop', async () => {
  const { phases } = await signed();
  // The design is approved (the road reaches the demos); contract B's demo work is another developer's.
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  await openNote(f.contract.id, 'DEMO', phases[0].id);
  await openNote(contractB.id, 'DEMO');
  await prisma.dependency.createMany({
    data: [
      { projectId: f.contract.projectId, side: 'CUSTOMER', titleFa: 'ا', titleEn: 'DNS access', dueAt: new Date('2026-09-01T00:00:00Z'), createdById: staff.SALES.id, technical: true },
      { projectId: f.contract.projectId, side: 'CUSTOMER', titleFa: 'ب', titleEn: 'Logo', dueAt: new Date('2026-09-01T00:00:00Z'), createdById: staff.SALES.id },
    ],
  });
  await prisma.demo.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phases[0].id, kind: 'SITE', stagingUrl: 'http://nahal.staging.localhost:5179/' } });

  const items = await homeOf(staff.DEVELOPER);
  // Both about phase 1: nothing is out for it (the demo row exists but is not published), and the
  // staging site has not yet been seen to report. Phase 2 waits behind it — one step is current.
  assert.deepEqual(tags(items), [
    'COMMITMENT_OVERDUE/customer@A',
    'DEMO_NOT_READY/default@A',
    'FEEDBACK_UNRESOLVED/default@A',
    'STEP_WAITING/DEMO@A',
  ]);
  assert.equal(param(items.find((i) => i.kind === 'COMMITMENT_OVERDUE')!, 'titleEn'), 'DNS access', 'only the technical one is theirs; the logo is sales’ to chase');
  const notReady = items.find((i) => i.kind === 'DEMO_NOT_READY')!;
  assert.equal(notReady.route, `/desk/contracts/${f.contract.id}/phases`);
  assert.equal(notReady.phaseId, phases[0].id);
  assert.equal(param(notReady, 'phase'), '1');
  // Phase 2 has no demo yet and nothing was shown for it: its turn comes after phase 1's.
  assert.deepEqual(tags(await homeOf(staff.DEVELOPER2)), ['FEEDBACK_UNRESOLVED/default@B']);

  // A published demo is the customer's move — and the developer's readiness line goes with it.
  await prisma.demo.updateMany({ where: { contractId: f.contract.id }, data: { publishedAt: new Date(), readyAt: new Date(), readyVerifiedById: staff.DEVELOPER.id } });
  await prisma.feedbackItem.updateMany({ where: { contractId: f.contract.id, step: 'DEMO' }, data: { status: 'ACCEPTED' } });
  assert.deepEqual(tags(await homeOf(staff.DEVELOPER)), ['COMMITMENT_OVERDUE/customer@A']);
  const ready = (await homeOf(f.customer)).find((i) => i.kind === 'DEMO_READY_TO_APPROVE')!;
  assert.ok(ready, 'the customer is told the demo is out');
  assert.deepEqual([ready.waitingOn, ready.phaseId, param(ready, 'phase'), ready.route], ['CUSTOMER', phases[0].id, '1', `/app/contracts/${f.contract.id}?step=DEMO&phase=${phases[0].id}`]);

  // …until they approve it: the real mutation clears it and says nothing is left.
  ok(await exec('mutation($c: ID!, $p: ID!){ approveDemo(contractId: $c, phaseId: $p) { id } }', { as: f.customer, variables: { c: f.contract.id, p: phases[0].id } }));
  assert.ok(!(await homeOf(f.customer)).some((i) => i.kind === 'DEMO_READY_TO_APPROVE'));
});

test('an open note on a demo keeps the demo out of the customer’s hands: the move is Root’s while a note waits', async () => {
  const { phases } = await signed();
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  await prisma.demo.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phases[0].id, kind: 'SITE', stagingUrl: 'http://nahal.staging.localhost:5179/', publishedAt: new Date(), readyAt: new Date(), readyVerifiedById: staff.DEVELOPER.id },
  });
  assert.ok((await homeOf(f.customer)).some((i) => i.kind === 'DEMO_READY_TO_APPROVE'));
  const note = await openNote(f.contract.id, 'DEMO', phases[0].id);
  const customerNow = tags(await homeOf(f.customer));
  assert.ok(!customerNow.includes('DEMO_READY_TO_APPROVE/default@A') && customerNow.includes('FEEDBACK_UNRESOLVED/default@A'), customerNow.join(','));
  await prisma.feedbackItem.update({ where: { id: note.id }, data: { status: 'ADDRESSED' } });
  assert.ok((await homeOf(f.customer)).some((i) => i.kind === 'DEMO_READY_TO_APPROVE'), 'once answered it is theirs again');
});

test('ADMIN holds every job and, through assignments.override, every contract: their home is everyone’s', async () => {
  const { plan } = await signed();
  await openNote(f.contract.id, 'DESIGN');
  await openNote(contractB.id, 'DESIGN');
  await openNote(contractB.id, 'DEMO');
  await pendingAnswer(f.contract.id, 'DESIGN');
  ok(await exec(SUBMIT_REQUEST, { as: f.customer, variables: { t: 'A shop', b: 'We need a shop.' } }));
  const admin = await homeOf(f.admin);
  assert.deepEqual(tags(admin), [
    'ANSWER_PENDING_APPROVAL/default@A',
    'FEEDBACK_UNRESOLVED/default@A',
    'FEEDBACK_UNRESOLVED/default@B',
    'FEEDBACK_UNRESOLVED/default@B',
    'INVOICE_ISSUABLE/default@A',
    'REQUEST_MESSAGE/unanswered',
    'STEP_WAITING/DESIGN@A',
  ]);
  assert.deepEqual([...new Set(admin.map((i) => i.role))].sort(), ['DESIGNER', 'DEVELOPER', 'SALES']);
  void plan;
});

test('a closed contract (J11) is gone from the designer’s and the developer’s homes, and stays on sales’ and the customer’s', async () => {
  const { phases } = await signed();
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  await openNote(f.contract.id, 'DESIGN');
  await openNote(f.contract.id, 'DEMO', phases[0].id);
  await pendingAnswer(f.contract.id, 'DESIGN');
  const onAHome = async (u: User) => (await homeOf(u)).filter((i) => i.contractId === f.contract.id).length;
  assert.ok((await onAHome(staff.DESIGNER)) > 0 && (await onAHome(staff.DEVELOPER)) > 0);

  await prisma.contract.update({ where: { id: f.contract.id }, data: { deliveredAt: new Date(), deliveredById: staff.SALES.id } });
  assert.equal(await onAHome(staff.DESIGNER), 0);
  assert.equal(await onAHome(staff.DEVELOPER), 0);
  assert.ok((await onAHome(staff.SALES)) > 0, 'sales keeps the record');
  assert.ok((await onAHome(f.customer)) > 0, 'and so does the customer');
});

test('a discarded contract is on no one’s home, and a project that is not active is no designer’s work', async () => {
  await signed();
  await openNote(f.contract.id, 'DESIGN');
  await prisma.project.update({ where: { id: f.contract.projectId }, data: { status: 'ARCHIVED', archivedAt: new Date(), archivedReason: 'Not going ahead' } });
  assert.deepEqual(await homeOf(staff.DESIGNER), []);
  await prisma.project.update({ where: { id: f.contract.projectId }, data: { status: 'ACTIVE' } });
  assert.ok((await homeOf(staff.DESIGNER)).length > 0);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  for (const u of [staff.DESIGNER, staff.SALES, f.admin, f.customer]) {
    assert.ok(!(await homeOf(u)).some((i) => i.contractId === f.contract.id), u.email);
  }
});

test('an account with no contract work has an empty home, and an anonymous caller has none', async () => {
  await signed();
  await openNote(f.contract.id, 'DESIGN');
  assert.deepEqual(await homeOf(staff.CONTRIBUTOR), []);
  assert.equal((await exec(HOME)).code, 'UNAUTHENTICATED');
});

// =================================================================================================
// The mockup — J9b's owed gap
// =================================================================================================

const DRAFT_CONCEPT = 'query($c: ID!){ contract(id: $c) { designDraft { concepts { id key } } } }';
const CUSTOMER_PAGES = 'query($c: ID!){ contract(id: $c) { concepts { pages { id key } } } }';
const asDesigner = (query: string, variables: Record<string, unknown> = {}, as: User = staff.DESIGNER) =>
  exec(query, { as, variables: { c: f.contract.id, ...variables } });

/** Step 5's door, as `j9b.test.ts` reaches it: a custom design from wireframes to the customer's approval. */
async function reachMockup() {
  await signed(CUSTOM_BRIEF);
  ok(await asDesigner('mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }'));
  const draft = ok(await asDesigner(DRAFT_CONCEPT)).contract as { designDraft: { concepts: Array<{ id: string; key: string }> } };
  const concept = draft.designDraft.concepts.find((c) => c.key === 'wireframes')!;
  for (const key of ['home', 'about']) {
    ok(await asDesigner('mutation($k: ID!, $key: String!){ addPageDesign(conceptId: $k, key: $key, labelFa: "ف", labelEn: "L") { id } }', { k: concept.id, key }));
  }
  for (const [kind, role, value] of [['COLOR', 'primary', '#1f3a5c'], ['FONT', 'heading', 'Vazirmatn']]) {
    ok(await asDesigner('mutation($c: ID!, $kind: PaletteKind!, $role: String!, $v: String!){ addPaletteItem(contractId: $c, kind: $kind, role: $role, value: $v, labelFa: "برچسب", labelEn: "Label") { id } }', { kind, role, v: value }));
  }
  ok(await asDesigner('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }'));
  const pages = (ok(await exec(CUSTOMER_PAGES, { as: f.customer, variables: { c: f.contract.id } })).contract as { concepts: Array<{ pages: Array<{ id: string }> }> }).concepts[0].pages;
  for (const page of pages) {
    ok(await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { as: f.customer, variables: { p: page.id } }));
  }
  ok(await exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
}

function zipOf(entries: Record<string, string>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

async function publishIteration(demoId: string) {
  const zip = await zipOf({ 'index.html': '<!doctype html><html><head><title>Home</title></head><body>HOME</body></html>' });
  const key = await storage.put('PRIVATE', zip, '.zip');
  const file = await prisma.storedFile.create({
    data: { key, class: 'MOCKUP_BUNDLE', visibility: 'PRIVATE', mime: 'application/zip', bytes: zip.length, originalName: 'mockup.zip', contractId: f.contract.id, uploadedById: staff.DESIGNER.id },
  });
  const build = ok(
    await asDesigner('mutation($d: ID!, $f: ID!, $ch: [BuildChangeInput!]!){ declareMockupBuild(demoId: $d, fileId: $f, changes: $ch) { id } }', { d: demoId, f: file.id, ch: [] }),
  ).declareMockupBuild as { id: string };
  ok(await asDesigner('mutation($b: ID!){ publishBuild(buildId: $b) { id } }', { b: build.id }));
}

const MOVE = 'query($c: ID!){ contract(id: $c) { statusSummary { currentStep nextMoveOn waitingOnCustomer waitingOnRoot } } }';
const moveOf = async (as: User) =>
  (ok(await exec(MOVE, { as, variables: { c: f.contract.id } })).contract as { statusSummary: { currentStep: string; nextMoveOn: string; waitingOnCustomer: number; waitingOnRoot: number } }).statusSummary;

test('the mockup: nothing out is the designer’s move, an iteration out is the customer’s, a note on it is the designer’s again — and the status area agrees at every turn', async () => {
  await reachMockup();
  ok(await asDesigner('mutation($c: ID!){ createMockupDemo(contractId: $c) { id } }'));
  const demo = await prisma.demo.findFirstOrThrow({ where: { contractId: f.contract.id, kind: 'MOCKUP' } });

  // The step is open and nothing has been shown: the designer's move, and the customer is told Root is on it.
  assert.deepEqual(tags(await homeOf(staff.DESIGNER)), ['STEP_WAITING/MOCKUP@A']);
  const waiting = (await homeOf(staff.DESIGNER))[0];
  assert.deepEqual([waiting.waitingOn, waiting.role, waiting.route], ['ROOT', 'DESIGNER', `/desk/contracts/${f.contract.id}/steps?step=MOCKUP`]);
  assert.deepEqual(tags(await homeOf(f.customer)), ['STEP_WAITING/MOCKUP@A']);
  assert.deepEqual(tags(await homeOf(staff.DEVELOPER)), [], 'a mockup is not the developer’s');
  assert.equal((await moveOf(staff.DESIGNER)).nextMoveOn, 'ROOT');

  // An iteration is published: the customer's move. The designer's list does not carry it —
  // it is not theirs to do — but the status area now says so too (until J12 it said Root's).
  await publishIteration(demo.id);
  const out = await homeOf(f.customer);
  assert.deepEqual(tags(out), ['ITERATION_PUBLISHED/default@A']);
  assert.deepEqual([out[0].waitingOn, out[0].route, param(out[0], 'count')], ['CUSTOMER', `/app/contracts/${f.contract.id}?step=MOCKUP`, '1']);
  assert.deepEqual(tags(await homeOf(staff.DESIGNER)), []);
  assert.equal((await moveOf(f.customer)).nextMoveOn, 'CUSTOMER');
  assert.equal((await moveOf(staff.DESIGNER)).waitingOnCustomer, 1);

  // The customer leaves a note on a page: now it is the designer's, in their home with a route that opens the step.
  const page = await prisma.demoPage.findFirstOrThrow({ where: { demoId: demo.id, key: 'home' } });
  ok(await exec('mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: MOCKUP, target: $t, body: "The header is too tall") { item { id } } }', {
    as: f.customer,
    variables: { c: f.contract.id, t: { demoId: demo.id, demoPageId: page.id } },
  }));
  const designer = await homeOf(staff.DESIGNER);
  assert.deepEqual(tags(designer), ['FEEDBACK_UNRESOLVED/default@A']);
  assert.deepEqual([param(designer[0], 'step'), designer[0].role, designer[0].route], ['MOCKUP', 'DESIGNER', `/desk/contracts/${f.contract.id}/steps?step=MOCKUP`]);
  assert.deepEqual(tags(await homeOf(f.customer)), ['FEEDBACK_UNRESOLVED/default@A'], 'with a note open the ball is Root’s, so the iteration line steps aside');
  assert.equal((await moveOf(f.customer)).nextMoveOn, 'ROOT');

  // The designer answers; the customer is told, and the iteration is theirs to approve again.
  const item = await prisma.feedbackItem.findFirstOrThrow({ where: { contractId: f.contract.id, step: 'MOCKUP' } });
  ok(await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "Fixed", resolution: ADDRESSED) { id } }', { as: staff.DESIGNER, variables: { i: item.id } }));
  assert.deepEqual(tags(await homeOf(f.customer)), ['ANSWER_PUBLISHED/default@A', 'ITERATION_PUBLISHED/default@A']);
  assert.deepEqual(tags(await homeOf(staff.DESIGNER)), []);

  // Approval locks the step and clears the customer's line.
  ok(await exec('mutation($c: ID!){ approveMockup(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  assert.ok(!tags(await homeOf(f.customer)).some((t) => t.startsWith('ITERATION_PUBLISHED') || t.startsWith('ANSWER_PUBLISHED')));
});

// =================================================================================================
// V4's queue, re-pointed
// =================================================================================================

const QUEUE = 'query { needsRootQueue { since count contract { id ref status } } }';
type QueueEntry = { since: string; count: number; contract: { id: string; ref: string; status: string } };

test('the Needs-Root queue is read from attention, not from ContractStatus: a contract waiting on Root by the book but owed nothing is not in it; one sales marked "waiting on the customer" that owes an answer is', async () => {
  // A: marked WAITING_ON_ROOT by hand, owed nothing. B: marked WAITING_ON_CUSTOMER, with two notes Root owes answers to.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'WAITING_ON_ROOT', statusChangedAt: new Date('2026-01-01T00:00:00Z') } });
  await prisma.feedbackItem.create({
    data: { projectId: contractB.projectId, contractId: contractB.id, step: 'DESIGN', general: true, createdAt: new Date('2026-09-01T00:00:00Z'), comments: { create: { authorId: f.customer.id, body: 'old note', createdAt: new Date('2026-09-01T00:00:00Z') } } },
  });
  await openNote(contractB.id, 'DEMO');

  const queue = (ok(await exec(QUEUE, { as: staff.SALES })).needsRootQueue as QueueEntry[]);
  assert.deepEqual(queue.map((e) => [e.contract.ref, e.contract.status, e.count]), [['RC-TEST-002', 'WAITING_ON_CUSTOMER', 2]]);
  assert.equal(new Date(queue[0].since).toISOString(), '2026-09-01T00:00:00.000Z', 'since is the oldest thing owed');

  // The enum can say anything: setting contract A to the other status changes nothing here…
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DONE' } });
  assert.equal(((ok(await exec(QUEUE, { as: staff.SALES })).needsRootQueue as QueueEntry[])).length, 1);
  // …and owing something puts it in, whatever status it carries. Oldest first.
  await prisma.feedbackItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, step: 'DESIGN', general: true, createdAt: new Date('2026-08-01T00:00:00Z'), comments: { create: { authorId: f.customer.id, body: 'older', createdAt: new Date('2026-08-01T00:00:00Z') } } },
  });
  const both = ok(await exec(QUEUE, { as: staff.SALES })).needsRootQueue as QueueEntry[];
  assert.deepEqual(both.map((e) => [e.contract.ref, e.contract.status]), [['RC-TEST-001', 'DONE'], ['RC-TEST-002', 'WAITING_ON_CUSTOMER']]);

  // A delivered contract owes nothing; and the staff-only capability is as it was.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { deliveredAt: new Date() } });
  assert.deepEqual(((ok(await exec(QUEUE, { as: staff.SALES })).needsRootQueue as QueueEntry[])).map((e) => e.contract.ref), ['RC-TEST-002']);
  assert.equal((await exec(QUEUE, { as: staff.DESIGNER })).code, 'FORBIDDEN');
  assert.equal((await exec(QUEUE, { as: f.customer })).code, 'FORBIDDEN');
});

// =================================================================================================
// One rule set
// =================================================================================================

const CONTRACT_ATTENTION = 'query($c: ID!){ contract(id: $c) { attention { kind variant waitingOn phaseId params { key value } } } }';

test('one rule set: for each viewer, a contract’s items on the home screen are exactly the contract page’s own attention (the job filter aside)', async () => {
  const { plan } = await signed();
  await openNote(f.contract.id, 'DESIGN');
  await pendingAnswer(f.contract.id, 'DESIGN');
  ok(await exec(ISSUE_PLANNED, { as: staff.SALES, variables: { p: plan[0].id } }));
  await prisma.dependency.create({ data: { projectId: f.contract.projectId, side: 'ROOT', titleFa: 'ا', titleEn: 'Root late', dueAt: new Date('2026-09-01T00:00:00Z'), createdById: staff.SALES.id } });

  const shape = (i: { kind: string; variant: string; waitingOn: string; phaseId: string | null; params: Array<{ key: string; value: string }> }) =>
    JSON.stringify([i.kind, i.variant, i.waitingOn, i.phaseId, i.params]);
  // The customer's home keeps every item the contract page shows them: no job filter applies to one's own.
  const page = (ok(await exec(CONTRACT_ATTENTION, { as: f.customer, variables: { c: f.contract.id } })).contract as { attention: Parameters<typeof shape>[0][] }).attention;
  const home = (await homeOf(f.customer)).filter((i) => i.contractId === f.contract.id);
  assert.deepEqual(home.map(shape).sort(), page.map(shape).sort());
  assert.ok(page.length >= 3, 'a non-trivial comparison');
  // Staff's home is the contract page's list narrowed to their job — never anything the page would hide from them.
  for (const [who, role] of [[staff.SALES, 'SALES'], [staff.DESIGNER, 'DESIGNER']] as const) {
    const pageForStaff = (ok(await exec(CONTRACT_ATTENTION, { as: who, variables: { c: f.contract.id } })).contract as { attention: Parameters<typeof shape>[0][] }).attention;
    const mineOnHome = (await homeOf(who)).filter((i) => i.contractId === f.contract.id);
    assert.ok(mineOnHome.length > 0, role);
    for (const item of mineOnHome) assert.ok(pageForStaff.map(shape).includes(shape(item)), `${role}: ${item.kind} is on the contract page too`);
    assert.ok(mineOnHome.length < pageForStaff.length, `${role}: and narrower than the page`);
  }
});

// =================================================================================================
// What a home costs
// =================================================================================================

async function statementsFor(as: User): Promise<number> {
  const before = statementsRun();
  ok(await exec(HOME, { as }));
  return statementsRun() - before;
}

test('what a home costs: the same number of statements whether the book holds three contracts or thirty — for a customer with all of them and for sales who may see all of them', async () => {
  await signed();
  await openNote(f.contract.id, 'DESIGN');
  const small = { customer: await statementsFor(f.customer), sales: await statementsFor(staff.SALES), admin: await statementsFor(f.admin) };

  // Twenty-seven more contracts, each on a project of its own, each carrying something to be read:
  // an open note, a late commitment, an issued invoice.
  for (let n = 0; n < 27; n++) {
    const project = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: `P${n}` } });
    const c = await prisma.contract.create({
      data: { ref: `RC-BULK-${n}`, titleFa: 'ا', titleEn: `Bulk ${n}`, customerId: f.customer.id, projectId: project.id, status: 'WAITING_ON_ROOT', publishedAt: new Date(), designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
    });
    await openNote(c.id, 'DESIGN');
    await prisma.dependency.create({ data: { projectId: project.id, side: 'ROOT', titleFa: 'ا', titleEn: 'late', dueAt: new Date('2026-09-01T00:00:00Z'), createdById: staff.SALES.id } });
    await prisma.billingEntry.create({
      data: { customerId: f.customer.id, contractId: c.id, source: 'CONTRACT', descriptionFa: 'ا', descriptionEn: 'a', amount: BigInt(1), issuedAt: new Date('2026-09-01T00:00:00Z'), invoiceNumber: `INV-8${String(n).padStart(5, '0')}`, paymentTermDays: 7, dueAt: new Date('2026-09-08T00:00:00Z') },
    });
  }
  const large = { customer: await statementsFor(f.customer), sales: await statementsFor(staff.SALES), admin: await statementsFor(f.admin) };
  // Not *equal*: a relation nested inside a batched query (a phase's scope items, an item's comments)
  // is read by one more statement only when some parent has children, and twenty-seven contracts
  // with a note, a commitment and an invoice each wake a few that two contracts left asleep. What a
  // per-contract query would do is add twenty-seven or more, so the bound is the whole assertion:
  // a handful of newly-non-empty relations, and a ceiling on the total.
  for (const who of ['customer', 'sales', 'admin'] as const) {
    assert.ok(large[who] - small[who] <= 10, `${who}: ${small[who]} statements for 2 contracts, ${large[who]} for 29`);
    assert.ok(large[who] <= 45, `${who}: a home costs ${large[who]} statements`);
  }
  console.log(`J12: statements per home — ${JSON.stringify(small)} for 2 contracts, ${JSON.stringify(large)} for 29`);
  // The designer's home is the same loader over a narrower set.
  assert.ok((await homeOf(staff.DESIGNER)).length >= 28);
});
