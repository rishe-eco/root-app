import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';
import { addMonths } from '../lib/delivery.js';

/**
 * J11 — step 7: the summary, the handover, closing a contract (journeys build
 * plan §5 "J11").
 *
 * In this order: **the CHECK by direct insert** (a handover on a feature, a note
 * of whitespace); **what a close waits for** — `PHASES_NOT_ACCEPTED` before
 * `DELIVERABLES_PENDING`, a declined or traded deliverable not counting, a
 * sibling contract's deliverable not holding this one open, no phase at all, an
 * unsigned or discarded contract, a double press; **the handover guards** — the
 * capability and the assignment, checked separately; **closing on the legacy
 * road**; **who sees a closed contract** (S1's `readActive`: a designer and a
 * developer lose it, sales and the customer keep it); **the notification**; and
 * **the summary** against a contract carried through the whole road — agreed
 * against what became of it, a trade, amendments, the money withheld from the
 * designer, unprompted changes split by viewer, and no feedback anywhere in it.
 *
 * **Phase acceptance.** J10's `approveDemo` does not exist yet, so a phase's
 * acceptance is produced the way it will be: the DEMO `StepApproval` row
 * `approveStepTx(DEMO, phase)` writes, and that phase's scope items moved to
 * `ACCEPTED` (`accept` below) — the same stand-in J13's tests use. When J10
 * lands, `accept` becomes a call to it and nothing else here changes.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000111', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
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
      { typeId: type.id, key: 'cart', kind: 'FEATURE', labelFa: 'سبد خرید', labelEn: 'Cart', position: 1 },
      { typeId: type.id, key: 'repo', kind: 'DELIVERABLE', labelFa: 'مخزن کد', labelEn: 'The repository', position: 2 },
      { typeId: type.id, key: 'export', kind: 'DELIVERABLE', labelFa: 'خروجی داده', labelEn: 'Data export', position: 3 },
    ],
  });
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to) => void sms.push({ to }),
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

const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE =
  'mutation($c: ID!){ createPhase(contractId: $c, number: 1, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "2026-11-10") { phases { id } } }';
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const SET_DATES =
  'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { id } }';
const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }';
const APPROVE = 'mutation($c: ID!){ approveContract(contractId: $c) { id } }';
const SIGN = 'mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }';

const HAND = `mutation($i: ID!, $n: String!){ markHandedOver(scopeItemId: $i, note: $n) { id deliveredAt delivery { closable deliverablesPending } } }`;
const UNHAND = `mutation($i: ID!){ unmarkHandedOver(scopeItemId: $i) { id delivery { deliverablesPending } } }`;
const CLOSE = `mutation($c: ID!){ closeContract(contractId: $c) {
  id status deliveredAt
  delivery { closable noPhases phasesNotAccepted deliverablesPending }
  wizard { step status finishedAt }
  timeline { kind }
} }`;
const DELIVERY = `query($c: ID!){ contract(id: $c) { deliveredAt delivery { deliveredAt closable noPhases phasesNotAccepted deliverablesPending } } }`;

type Delivery = { closable: boolean; noPhases: boolean; phasesNotAccepted: number[]; deliverablesPending: string[] };

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
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
};

const PLAN_ROWS = (phaseId: string) => [
  { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId, paymentTermDays: 7 },
  { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: null, paymentTermDays: 7 },
];

/** A signed new-road agreement, carried through the real mutations: steps 1 and 2,
 *  a published format-2 draft, the customer's approval and signature. One phase. */
async function signed() {
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: f.contract.id, i: { ...BRIEF_INPUT, templateTypeId: type.id } } }));
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id } })).createPhase as {
    phases: Array<{ id: string }>;
  };
  const phaseId = phase.phases[0].id;
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, r: PLAN_ROWS(phaseId) } }));
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(SET_DATES, { as: staff.SALES, variables: { c: f.contract.id, s: '2026-10-12', e: '2026-12-20' } }));
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: f.contract.id } }));
  ok(await exec(APPROVE, { as: f.customer, variables: { c: f.contract.id } }));
  ok(await exec(SIGN, { as: f.customer, variables: { c: f.contract.id, n: 'Test Customer' } }));
  return { phaseId };
}

const item = (key: string) =>
  prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId, key } });

/**
 * A phase's accepted demo, the way J10's `approveDemo` will write it: the DEMO
 * `StepApproval` for the phase, and the phase's scope items `ACCEPTED`
 * (`approveStepTx` accepts the step's feedback; the items' move is `approveDemo`'s
 * own effect, plan §5 J10). J10 does not exist on `main` yet.
 */
async function accept(phaseId: string, keys: string[] = ['home', 'cart']) {
  for (const key of keys) {
    await prisma.scopeItem.updateMany({
      where: { projectId: f.contract.projectId, key, status: 'AGREED' },
      data: { phaseId, status: 'ACCEPTED' },
    });
  }
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DEMO', phaseId, approvedById: f.customer.id } });
}

const hand = async (key: string, as: User = staff.SALES, note = 'Transferred to the customer’s organisation.') =>
  exec(HAND, { as, variables: { i: (await item(key)).id, n: note } });
const close = (as: User = staff.SALES, id = f.contract.id) => exec(CLOSE, { as, variables: { c: id } });

/** Signed, the phase accepted, both deliverables handed over: one press from closing. */
async function readyToClose() {
  const { phaseId } = await signed();
  await accept(phaseId);
  ok(await hand('repo', staff.DEVELOPER));
  ok(await hand('export', staff.SALES));
  return { phaseId };
}

const deliveryOf = async (as: User) =>
  (ok(await exec(DELIVERY, { as, variables: { c: f.contract.id } })).contract as { deliveredAt: string | null; delivery: Delivery }).delivery;

// =====================================================================================
// the database's own rule, by direct insert

test('CHECK ScopeItem_handover_is_a_deliverable: only a deliverable is handed over, and with a note that says something', async () => {
  const base = { projectId: f.contract.projectId, labelFa: 'ا', labelEn: 'a', status: 'AGREED' as const };
  const handedOver = { handedOverAt: new Date(), handedOverById: staff.SALES.id };

  // A handover on a feature (and a page) is refused, however good the note.
  for (const kind of ['FEATURE', 'PAGE', 'EXTRA'] as const) {
    await assert.rejects(
      prisma.scopeItem.create({ data: { ...base, key: `k-${kind}`, kind, ...handedOver, handoverNote: 'given' } }),
      /ScopeItem_handover_is_a_deliverable/,
      kind,
    );
  }
  // …and on a deliverable with no note, a blank one, or whitespace.
  for (const [i, note] of [null, '', '   \n\t'].entries()) {
    await assert.rejects(
      prisma.scopeItem.create({ data: { ...base, key: `d-${i}`, kind: 'DELIVERABLE', ...handedOver, handoverNote: note } }),
      /ScopeItem_handover_is_a_deliverable/,
      `note ${JSON.stringify(note)}`,
    );
  }
  // A real handover, and an item never handed over (with or without a stray note), pass.
  await prisma.scopeItem.create({ data: { ...base, key: 'd-ok', kind: 'DELIVERABLE', ...handedOver, handoverNote: 'The export was emailed.' } });
  await prisma.scopeItem.create({ data: { ...base, key: 'f-plain', kind: 'FEATURE' } });
  await prisma.scopeItem.create({ data: { ...base, key: 'd-open', kind: 'DELIVERABLE' } });

  // An UPDATE is held to it too — the path the resolver takes.
  const feature = await prisma.scopeItem.findFirstOrThrow({ where: { key: 'f-plain' } });
  await assert.rejects(
    prisma.scopeItem.update({ where: { id: feature.id }, data: { ...handedOver, handoverNote: 'x' } }),
    /ScopeItem_handover_is_a_deliverable/,
  );
});

// =====================================================================================
// what a close waits for

test('PHASES_NOT_ACCEPTED comes before DELIVERABLES_PENDING: the customer’s DEMO approval, not the items, is a phase’s acceptance', async () => {
  const { phaseId } = await signed();
  // Both outstanding: the phases are what is refused.
  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED');
  assert.deepEqual((await deliveryOf(staff.SALES)).phasesNotAccepted, [1]);

  // Items accepted by hand do not stand in for the approval on this road.
  await prisma.scopeItem.updateMany({ where: { projectId: f.contract.projectId, key: { in: ['home', 'cart'] } }, data: { phaseId, status: 'ACCEPTED' } });
  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED');

  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DEMO', phaseId, approvedById: f.customer.id } });
  const pending = await close();
  assert.equal(pending.code, 'DELIVERABLES_PENDING');
  const d = await deliveryOf(staff.SALES);
  assert.deepEqual([d.phasesNotAccepted, d.closable, d.deliverablesPending.length], [[], false, 2]);
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).deliveredAt, null, 'a refusal closed nothing');
});

test('DELIVERABLES_PENDING: a declined or traded-away deliverable does not count, a handed-over one is done, a sibling contract’s is not ours', async () => {
  const { phaseId } = await signed();
  await accept(phaseId);
  // A sibling contract on the same project with its own pending deliverable.
  const sibling = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002', titleFa: 'ب', titleEn: 'Sibling', customerId: f.customer.id, projectId: f.contract.projectId,
      status: 'IN_PROGRESS', publishedAt: new Date(), developerId: staff.DEVELOPER2.id,
    },
  });
  await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: sibling.id, key: 'sib-deliverable', kind: 'DELIVERABLE', status: 'AGREED', labelFa: 'ا', labelEn: 'S', position: 99 },
  });

  assert.equal((await close()).code, 'DELIVERABLES_PENDING');
  // One declined, one handed over: nothing of ours is pending.
  await prisma.scopeItem.update({ where: { id: (await item('export')).id }, data: { status: 'DECLINED', declinedReason: 'Not needed' } });
  assert.equal((await close()).code, 'DELIVERABLES_PENDING', 'the repository is still pending');
  ok(await hand('repo'));
  assert.deepEqual((await deliveryOf(staff.SALES)).deliverablesPending, []);
  assert.equal((await deliveryOf(staff.SALES)).closable, true);

  // A traded-away deliverable is out of the deal too.
  await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'gone', kind: 'DELIVERABLE', status: 'TRADED', labelFa: 'ا', labelEn: 'Gone', position: 98 },
  });
  const closed = ok(await close()).closeContract as { status: string; deliveredAt: string };
  assert.equal(closed.status, 'DONE');
  assert.ok(closed.deliveredAt);
  // The sibling is untouched.
  const sib = await prisma.contract.findUniqueOrThrow({ where: { id: sibling.id } });
  assert.deepEqual([sib.deliveredAt, sib.status], [null, 'IN_PROGRESS']);
});

test('closing sets deliveredAt, who, DONE and statusChangedAt; the wizard’s summary step is done and the rail says delivered; the customer is told', async () => {
  await readyToClose();
  const before = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  mail = [];
  sms = [];
  const closed = ok(await close()).closeContract as {
    status: string;
    deliveredAt: string;
    delivery: Delivery;
    wizard: Array<{ step: string; status: string; finishedAt: string | null }>;
    timeline: Array<{ kind: string }>;
  };
  const row = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.deepEqual([row.status, row.deliveredById], ['DONE', staff.SALES.id]);
  assert.ok(row.deliveredAt && row.statusChangedAt.getTime() >= before.statusChangedAt.getTime());
  assert.equal(closed.deliveredAt, row.deliveredAt!.toISOString());
  assert.equal(closed.delivery.closable, false, 'already delivered');
  const summary = closed.wizard.find((s) => s.step === 'SUMMARY')!;
  assert.equal(summary.status, 'DONE');
  assert.equal(summary.finishedAt, row.deliveredAt!.toISOString());
  assert.ok(closed.timeline.some((t) => t.kind === 'CONTRACT_DELIVERED'));

  // Twice: the second hears the truth, and nothing moves.
  assert.equal((await close()).code, 'ALREADY_DELIVERED');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).deliveredAt!.getTime(), row.deliveredAt!.getTime());

  // The customer — email and SMS, in Persian — and nobody else.
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, f.customer.email);
  assert.match(mail[0].subject, /تحویل شد/);
  assert.ok(mail[0].text.includes(`/fa/app/contracts/${f.contract.id}`));
  assert.match(mail[0].text, /دوره‌ی پشتیبانی‌ات ۶ ماه است/, 'the brief’s support promise, in the customer’s digits');
  assert.equal(sms.length, 1);
  assert.equal(sms[0].to, '+989120000111');
  assert.ok(sms[0].text!.includes(`/fa/app/contracts/${f.contract.id}`));
});

test('an English-speaking customer is told in English', async () => {
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  await readyToClose();
  mail = [];
  sms = [];
  ok(await close());
  assert.match(mail[0].subject, /Delivered/);
  assert.match(mail[0].text, /support period is 6 months, until /);
  assert.match(sms[0].text!, /delivered/);
});

test('two presses of Close at once close it once — the contract’s lock serializes them', async () => {
  await readyToClose();
  mail = [];
  const [a, b] = await Promise.all([close(), close()]);
  assert.deepEqual([a.code, b.code].map((c) => c ?? 'ok').sort(), ['ALREADY_DELIVERED', 'ok']);
  assert.equal(mail.filter((m) => m.to === f.customer.email).length, 1, 'one notification');
});

test('closeContract refuses what is not deliverable: unsigned, discarded, no phase at all — and who may', async () => {
  // Not signed (the fixture's v1 has no signature).
  assert.equal((await close()).code, 'CONTRACT_NOT_SIGNED');
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Customer', signedHash: f.contractRevision.contentHash },
  });
  // Signed, but there is not a single phase: nothing was built, nothing accepted.
  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED');
  assert.equal((await deliveryOf(staff.SALES)).noPhases, true);
  assert.equal((await deliveryOf(staff.SALES)).closable, false);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  assert.equal((await close()).code, 'CONTRACT_DISCARDED');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'IN_PROGRESS' } });

  // The capability: only contracts.author. Everyone else — before any lookup.
  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    assert.equal((await close(who)).code, 'FORBIDDEN', who.email ?? '');
  }
  assert.equal((await close(staff.SALES, 'nope')).code, 'NOT_FOUND');
  assert.equal((await close(f.admin)).code, 'PHASES_NOT_ACCEPTED', 'ADMIN holds the capability');
});

// =====================================================================================
// the legacy road

test('closeContract applies to a legacy contract too: its phases are accepted the way its wizard says, by their scope items', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Customer', signedHash: f.contractRevision.contentHash },
  });
  const phase = await prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: 'P' },
  });
  const mk = (key: string, status: 'IN_DEMO' | 'ACCEPTED') =>
    prisma.scopeItem.create({
      data: { projectId: f.contract.projectId, contractId: f.contract.id, phaseId: phase.id, key, kind: 'PAGE', status, labelFa: 'ا', labelEn: key },
    });
  const home = await mk('home', 'ACCEPTED');
  const about = await mk('about', 'IN_DEMO');
  // A DEMO approval row means nothing on the legacy road — the wizard ignores it, and so does this.
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DEMO', phaseId: phase.id, approvedById: f.customer.id } });
  assert.equal((await close()).code, 'PHASES_NOT_ACCEPTED');
  await prisma.scopeItem.update({ where: { id: about.id }, data: { status: 'ACCEPTED' } });
  assert.ok(home);
  const closed = ok(await close()).closeContract as { status: string };
  assert.equal(closed.status, 'DONE');
  assert.ok((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).deliveredAt);
  // …and its summary reads, without a format-2 agreement.
  const s = ok(
    await exec('query($c: ID!){ contract(id: $c) { summary { agreed { version agreement { phases { number } } scopeItems { key } } items { key status } } } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  ).contract as { summary: { agreed: { agreement: unknown; version: number }; items: Array<{ key: string }> } };
  assert.equal(s.summary.agreed.agreement, null);
  assert.deepEqual(s.summary.items.map((i) => i.key).sort(), ['about', 'home']);
});

// =====================================================================================
// the handover

test('markHandedOver: records who, when and what; the developer of this contract may, as may sales; the note is trimmed', async () => {
  await signed();
  const repo = await item('repo');
  const done = ok(await hand('repo', staff.DEVELOPER, '  Transferred to the customer’s organisation.  ')).markHandedOver as {
    delivery: Delivery;
  };
  assert.deepEqual(done.delivery.deliverablesPending.length, 1, 'one of the two is left');
  const row = await prisma.scopeItem.findUniqueOrThrow({ where: { id: repo.id } });
  assert.deepEqual([row.handedOverById, row.handoverNote], [staff.DEVELOPER.id, 'Transferred to the customer’s organisation.']);
  assert.ok(row.handedOverAt);
  // Sales hands over the other.
  ok(await hand('export', staff.SALES));
  assert.equal((await item('export')).handedOverById, staff.SALES.id);
});

test('markHandedOver guards: capability and assignment checked separately — and the refusals in their order', async () => {
  await signed();
  const id = (await item('repo')).id;
  const run = (as: User | null, note = 'Done.', itemId = id) => exec(HAND, { as, variables: { i: itemId, n: note } });

  // No builds.author / contracts.author: a designer, the customer, a contributor.
  for (const who of [staff.DESIGNER, f.customer, staff.CONTRIBUTOR]) {
    assert.equal((await run(who)).code, 'FORBIDDEN', who.email ?? '');
  }
  // The capability without the edge: a developer of another contract.
  const sibling = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002', titleFa: 'ب', titleEn: 'Sibling', customerId: f.customer.id, projectId: f.contract.projectId,
      status: 'IN_PROGRESS', publishedAt: new Date(), developerId: staff.DEVELOPER2.id,
    },
  });
  assert.ok(sibling);
  assert.equal((await run(staff.DEVELOPER2)).code, 'NOT_ASSIGNED');
  assert.equal((await item('repo')).handedOverAt, null);

  // Input and shape.
  assert.equal((await run(staff.SALES, '   ')).code, 'HANDOVER_NOTE_REQUIRED');
  assert.equal((await run(staff.SALES, 'x'.repeat(2001))).code, 'HANDOVER_NOTE_TOO_LONG');
  assert.equal((await run(staff.SALES, 'ok', 'nope')).code, 'NOT_FOUND');
  assert.equal((await run(staff.SALES, 'ok', (await item('home')).id)).code, 'NOT_A_DELIVERABLE');
  await prisma.scopeItem.update({ where: { id: (await item('export')).id }, data: { status: 'DECLINED', declinedReason: 'no' } });
  assert.equal((await run(staff.SALES, 'ok', (await item('export')).id)).code, 'NOT_AGREED');
  await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'maybe', kind: 'DELIVERABLE', status: 'PROPOSED', labelFa: 'ا', labelEn: 'Maybe', position: 50 },
  });
  assert.equal((await run(staff.SALES, 'ok', (await item('maybe')).id)).code, 'NOT_AGREED');

  ok(await run(staff.SALES));
  assert.equal((await run(staff.SALES)).code, 'ALREADY_HANDED_OVER');
  assert.equal((await run(staff.DEVELOPER, 'a rewrite')).code, 'ALREADY_HANDED_OVER', 'a note is never rewritten in place');
});

test('markHandedOver needs a signed agreement', async () => {
  // The fixture's deliverable on an unsigned contract.
  const d = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'repo', kind: 'DELIVERABLE', status: 'AGREED', labelFa: 'ا', labelEn: 'Repo' },
  });
  const r = await exec(HAND, { as: staff.SALES, variables: { i: d.id, n: 'Done.' } });
  assert.equal(r.code, 'CONTRACT_NOT_SIGNED');
});

test('unmarkHandedOver: contracts.author only, only a handed-over item, only before the close — and it clears the record whole', async () => {
  await signed();
  ok(await hand('repo', staff.DEVELOPER));
  const id = (await item('repo')).id;
  const run = (as: User) => exec(UNHAND, { as, variables: { i: id } });

  // The developer who made it cannot take it back; a correction is sales'.
  assert.equal((await run(staff.DEVELOPER)).code, 'FORBIDDEN');
  assert.equal((await run(staff.DESIGNER)).code, 'FORBIDDEN');
  assert.equal((await run(f.customer)).code, 'FORBIDDEN');
  ok(await run(staff.SALES));
  const row = await item('repo');
  assert.deepEqual([row.handedOverAt, row.handedOverById, row.handoverNote], [null, null, null]);
  assert.equal((await run(staff.SALES)).code, 'NOT_HANDED_OVER');

  // After the close the record is closed.
  const { phaseId } = { phaseId: (await prisma.phase.findFirstOrThrow({ where: { contractId: f.contract.id } })).id };
  await accept(phaseId);
  ok(await hand('repo', staff.SALES));
  ok(await hand('export', staff.SALES));
  ok(await close());
  assert.equal((await run(staff.SALES)).code, 'CONTRACT_DELIVERED');
  assert.equal((await hand('repo', staff.SALES)).code, 'CONTRACT_DELIVERED');
});

// =====================================================================================
// who sees a closed contract

test('a closed contract leaves the designer and the developer; sales, ADMIN and the customer keep it', async () => {
  await readyToClose();
  const q = 'query($id: ID!){ contract(id: $id) { id deliveredAt } }';
  // Before: both read it, and see it in their lists and queues.
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    ok(await exec(q, { as: who, variables: { id: f.contract.id } }));
    assert.equal(((ok(await exec('{ allContracts { id } }', { as: who })).allContracts) as unknown[]).length, 1);
  }
  assert.equal(((ok(await exec('{ phasesForBuilds { id } }', { as: staff.DEVELOPER })).phasesForBuilds) as unknown[]).length, 1);
  const project = (as: User) => exec('query($p: ID!){ project(id: $p) { id } }', { as, variables: { p: f.contract.projectId } });
  assert.ok((ok(await project(staff.DESIGNER)) as { project: unknown }).project);

  ok(await close());

  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    assert.equal((await exec(q, { as: who, variables: { id: f.contract.id } })).code, 'NOT_FOUND', `${who.email} link`);
    assert.deepEqual(ok(await exec('{ allContracts { id } }', { as: who })).allContracts, [], `${who.email} list`);
  }
  assert.equal(((ok(await exec('{ phasesForBuilds { id } }', { as: staff.DEVELOPER })).phasesForBuilds) as unknown[]).length, 0);
  assert.equal((ok(await project(staff.DESIGNER)) as { project: unknown }).project, null);
  // …and what they could write is gone with it.
  assert.equal(
    (await exec('mutation($p: ID!){ createDemo(phaseId: $p, stagingUrl: "https://nahal.staging.m-root.com") { id } }', {
      as: staff.DEVELOPER,
      variables: { p: (await prisma.phase.findFirstOrThrow({ where: { contractId: f.contract.id } })).id },
    })).code,
    'NOT_FOUND',
  );

  for (const who of [staff.SALES, f.admin, f.customer]) {
    const r = ok(await exec(q, { as: who, variables: { id: f.contract.id } })) as { contract: { deliveredAt: string } };
    assert.ok(r.contract.deliveredAt, who.email ?? '');
  }
  assert.equal(((ok(await exec('{ allContracts { id } }', { as: staff.SALES })).allContracts) as unknown[]).length, 1);
  assert.equal(((ok(await exec('{ myContracts { id } }', { as: f.customer })).myContracts) as unknown[]).length, 1);
});

test('status DONE set by hand is not a delivery — the designer keeps a contract nobody closed', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DONE' } });
  ok(await exec('query($id: ID!){ contract(id: $id) { id } }', { as: staff.DESIGNER, variables: { id: f.contract.id } }));
});

// =====================================================================================
// the summary

const SUMMARY = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { id summary {
  deliveredAt deliveredBy
  agreed {
    version contentHash signedAt
    scopeItems { key kind }
    agreement { brief { supportMonths budgetCap templateType { slug } } paymentPlan { total } phases { number } plannedStartAt plannedEndAt }
    amendments { ordinal titleEn bodyEn signature { typedName } }
    trades { executedAt out { key } in { key } }
  }
  items { key kind status phaseNumber inAgreement declinedReason tradePartner { direction key } handedOverAt handedOverBy handoverNote }
  unpromptedChanges { step buildNumber textFa textEn note noteLang writtenUp }
  steps { step phaseNumber iterationsUsed allowance extensions finishedAt }
  dates { plannedStartAt plannedEndAt signedAt startedAt deliveredAt phases { number plannedEndAt acceptedAt } }
  invoices { count paidCount issued paid outstanding }
  support { months from until }
} } }`;

type Summary = {
  deliveredAt: string | null;
  deliveredBy: string | null;
  agreed: {
    version: number;
    contentHash: string | null;
    signedAt: string;
    scopeItems: Array<{ key: string; kind: string }>;
    agreement: {
      brief: { supportMonths: number; budgetCap: string | null; templateType: { slug: string } };
      paymentPlan: { total: string } | null;
      phases: Array<{ number: number }>;
      plannedStartAt: string;
      plannedEndAt: string;
    } | null;
    amendments: Array<{ ordinal: number; titleEn: string; bodyEn: string | null; signature: { typedName: string } | null }>;
    trades: Array<{ out: { key: string }; in: { key: string } }>;
  };
  items: Array<{
    key: string; kind: string; status: string; phaseNumber: number | null; inAgreement: boolean; declinedReason: string | null;
    tradePartner: { direction: string; key: string } | null; handedOverAt: string | null; handedOverBy: string | null; handoverNote: string | null;
  }>;
  unpromptedChanges: Array<{ step: string; buildNumber: number; textFa: string | null; textEn: string | null; note: string | null; noteLang: string | null; writtenUp: boolean }>;
  steps: Array<{ step: string; phaseNumber: number | null; iterationsUsed: number | null; allowance: number | null; extensions: number; finishedAt: string | null }>;
  dates: {
    plannedStartAt: string; plannedEndAt: string; signedAt: string; startedAt: string | null; deliveredAt: string | null;
    phases: Array<{ number: number; plannedEndAt: string; acceptedAt: string | null }>;
  };
  invoices: { count: number; paidCount: number; issued: string; paid: string; outstanding: string } | null;
  support: { months: number; from: string | null; until: string | null } | null;
};

const summaryAs = async (as: User, asCustomer = false) =>
  (ok(await exec(SUMMARY, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as { summary: Summary | null }).summary;

/**
 * The whole road, with something of everything on it: a trade (cart out, shop in),
 * a signed amendment, a published-but-unsigned one, a declined deliverable, a
 * handed-over one, issued invoices (one paid) and a draft, an extra design round,
 * and two unprompted changes (one written up).
 */
async function fullRun() {
  const { phaseId } = await signed();
  const cart = await item('cart');

  // A trade: cart goes out, shop comes in — the real mutations, both halves confirming.
  ok(
    await exec(
      `mutation($p: ID!, $o: ID!, $c: ID){ proposeScopeTrade(projectId: $p, outItemId: $o, inKey: "shop", inLabelFa: "فروشگاه", inLabelEn: "Shop", contractId: $c) { id } }`,
      { as: staff.SALES, variables: { p: f.contract.projectId, o: cart.id, c: f.contract.id } },
    ),
  );
  const trade = await prisma.scopeTrade.findFirstOrThrow({ where: { outItemId: cart.id } });
  ok(await exec('mutation($t: ID!, $c: ID){ confirmScopeTradeRoot(tradeId: $t, contractId: $c) { id } }', { as: staff.SALES, variables: { t: trade.id, c: f.contract.id } }));
  ok(await exec('mutation($t: ID!, $c: ID){ confirmScopeTradeCustomer(tradeId: $t, contractId: $c) { id } }', { as: f.customer, variables: { t: trade.id, c: f.contract.id } }));
  ok(await exec('mutation($t: ID!, $c: ID){ executeScopeTrade(tradeId: $t, contractId: $c) { id } }', { as: staff.SALES, variables: { t: trade.id, c: f.contract.id } }));

  // Amendments: A-next signed by the customer; one more published and left waiting.
  const amend = async (title: string) => {
    const made = ok(
      await exec(
        'mutation($c: ID!, $t: String!){ issueAmendment(contractId: $c, titleFa: "الحاقیه", titleEn: $t, bodyFa: "متن", bodyEn: "Body text") { id } }',
        { as: staff.SALES, variables: { c: f.contract.id, t: title } },
      ),
    );
    void made;
    const row = await prisma.amendment.findFirstOrThrow({ where: { titleEn: title } });
    ok(await exec('mutation($a: ID!){ publishAmendment(amendmentId: $a) { id } }', { as: staff.SALES, variables: { a: row.id } }));
    return row.id;
  };
  const signedAmendment = await amend('Signed amendment');
  ok(await exec('mutation($a: ID!){ approveAmendment(amendmentId: $a) { id } }', { as: f.customer, variables: { a: signedAmendment } }));
  ok(await exec('mutation($a: ID!, $n: String!){ signAmendment(amendmentId: $a, typedName: $n) { id } }', { as: f.customer, variables: { a: signedAmendment, n: 'Test Customer' } }));
  await amend('Still waiting');

  // End states.
  await prisma.scopeItem.update({ where: { id: (await item('export')).id }, data: { status: 'DECLINED', declinedReason: 'Not needed any more' } });
  await accept(phaseId, ['home', 'shop']);
  ok(await hand('repo', staff.DEVELOPER, 'The repository was transferred to the customer’s organisation.'));

  // Rounds and the money.
  await prisma.allowanceExtension.create({
    data: { contractId: f.contract.id, step: 'DESIGN', extra: 1, reason: 'Changed direction', approvedById: staff.SALES.id },
  });
  const entry = (n: number, over: Record<string, unknown>) => ({
    customerId: f.customer.id, contractId: f.contract.id, source: 'CONTRACT' as const, descriptionFa: 'ب', descriptionEn: 'B',
    amount: 100_000_000n, ...over, ...(n ? {} : {}),
  });
  const issuedAt = new Date('2026-10-01T00:00:00Z');
  await prisma.billingEntry.create({
    data: entry(1, { issuedAt, invoiceNumber: 'INV-900001', dueAt: new Date('2026-10-08T00:00:00Z'), paymentTermDays: 7, paidAt: new Date('2026-10-03T00:00:00Z') }),
  });
  await prisma.billingEntry.create({
    data: entry(2, { amount: 80_000_000n, issuedAt, invoiceNumber: 'INV-900002', dueAt: new Date('2026-10-08T00:00:00Z'), paymentTermDays: 7 }),
  });
  await prisma.billingEntry.create({ data: entry(3, { amount: 999_000_000n }) }); // a draft

  // Two unprompted changes on published builds; one has been written up.
  const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId, stagingUrl: 'https://nahal.staging.m-root.com', publishedAt: new Date() } });
  const frame = await prisma.demoFrame.create({ data: { demoId: demo.id, authoredById: staff.SALES.id } });
  const mkBuild = (number: number) =>
    prisma.build.create({
      data: { projectId: f.contract.projectId, phaseId, number, declaredById: staff.DEVELOPER.id, publishedAt: new Date(`2026-10-0${number + 1}T00:00:00Z`) },
    });
  const b1 = await mkBuild(1);
  const b2 = await mkBuild(2);
  const told = await prisma.buildChangeEntry.create({ data: { buildId: b1.id, note: 'fixed the footer', noteLang: 'en' } });
  await prisma.buildChangeEntry.create({ data: { buildId: b2.id, note: 'swapped the image library', noteLang: 'en' } });
  await prisma.demoFrameLine.create({
    data: { frameId: frame.id, kind: 'NEW', textFa: 'پاورقی درست شد', textEn: 'The footer was fixed', buildChangeEntryId: told.id },
  });
  return { phaseId };
}

test('the summary: nothing to record until the agreement is signed', async () => {
  assert.equal(await summaryAs(f.customer), null);
  assert.equal(await summaryAs(staff.SALES), null);
});

test('the summary against a run end to end: what was agreed, what became of each item, a trade, amendments, the rounds, the dates, the support period', async () => {
  const { phaseId } = await fullRun();
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).deliveredAt, null);
  ok(await close());

  const s = (await summaryAs(f.customer))!;
  const closedAt = (await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).deliveredAt!;
  assert.equal(s.deliveredAt, closedAt.toISOString());
  assert.equal(s.deliveredBy, 'SALES');

  // Agreed: the signed snapshot, not the live registry. Cart is still in it; shop is not.
  const revision = await prisma.contractRevision.findUniqueOrThrow({
    where: { id: (await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).currentContractRevisionId! },
  });
  assert.equal(s.agreed.contentHash, revision.contentHash);
  assert.deepEqual(s.agreed.scopeItems.map((i) => i.key), ['home', 'cart', 'repo', 'export']);
  assert.equal(s.agreed.agreement!.brief.supportMonths, 6);
  assert.equal(s.agreed.agreement!.brief.templateType.slug, 'store');
  assert.equal(s.agreed.agreement!.paymentPlan!.total, '180000000', 'the customer reads the plan she signed');
  assert.deepEqual(s.agreed.agreement!.phases.map((p) => p.number), [1]);
  assert.deepEqual(s.agreed.trades.map((t) => [t.out.key, t.in.key]), [['cart', 'shop']]);
  // Executed amendments only: the signed one and the trade's pair — never the one still waiting.
  assert.deepEqual(s.agreed.amendments.map((a) => a.titleEn), ['Scope amendment — a confirmed trade', 'Signed amendment']);
  assert.equal(s.agreed.amendments[1].signature!.typedName, 'Test Customer');
  assert.equal(s.agreed.amendments[0].signature, null);

  // What became of each item.
  const by = (key: string) => s.items.find((i) => i.key === key)!;
  assert.deepEqual(s.items.map((i) => i.key).sort(), ['cart', 'export', 'home', 'repo', 'shop']);
  assert.deepEqual([by('home').status, by('home').inAgreement, by('home').phaseNumber], ['ACCEPTED', true, 1]);
  assert.deepEqual([by('cart').status, by('cart').tradePartner], ['TRADED', { direction: 'OUT', key: 'shop' }]);
  assert.deepEqual([by('shop').status, by('shop').inAgreement, by('shop').tradePartner], ['ACCEPTED', false, { direction: 'IN', key: 'cart' }]);
  assert.deepEqual([by('export').status, by('export').declinedReason], ['DECLINED', 'Not needed any more']);
  assert.deepEqual(
    [by('repo').handedOverBy, by('repo').handoverNote, by('repo').handedOverAt !== null],
    ['DEVELOPER', 'The repository was transferred to the customer’s organisation.', true],
  );
  assert.equal(by('home').handoverNote, null);

  // Each step: rounds against the allowance, extensions, finish dates. The fixture's
  // own published design round is the one counted; MOCKUP/DEMO counts are J9b's/J10's —
  // a null hole, not a zero.
  const step = (name: string, phase: number | null = null) => s.steps.find((r) => r.step === name && r.phaseNumber === phase)!;
  assert.ok(!s.steps.some((r) => r.step === 'SUMMARY'));
  assert.deepEqual([step('DESIGN').iterationsUsed, step('DESIGN').allowance, step('DESIGN').extensions], [1, 3, 1]);
  assert.deepEqual([step('DEMO', 1).iterationsUsed, step('DEMO', 1).allowance, step('DEMO', 1).extensions], [null, 2, 0]);
  assert.equal(step('AGREEMENT').finishedAt, s.dates.signedAt);
  assert.ok(step('DEMO', 1).finishedAt, 'the demo finished when the customer approved it');

  // Planned against actual, as calendar days.
  assert.deepEqual([s.dates.plannedStartAt.slice(0, 10), s.dates.plannedEndAt.slice(0, 10)], ['2026-10-12', '2026-12-20']);
  assert.equal(s.dates.phases[0].plannedEndAt.slice(0, 10), '2026-11-10');
  const approval = await prisma.stepApproval.findFirstOrThrow({ where: { contractId: f.contract.id, step: 'DEMO', phaseId } });
  assert.equal(s.dates.phases[0].acceptedAt, approval.approvedAt.toISOString());
  assert.equal(s.dates.deliveredAt, closedAt.toISOString());

  // The money: issued invoices only; the 999M draft is not in the record.
  assert.deepEqual(s.invoices, { count: 2, paidCount: 1, issued: '180000000', paid: '100000000', outstanding: '80000000' });

  // Support: six months from the day of delivery, in calendar days (UTC).
  const from = closedAt.toISOString().slice(0, 10);
  assert.deepEqual(
    [s.support!.months, s.support!.from!.slice(0, 10), s.support!.until!.slice(0, 10)],
    [6, from, addMonths(from, 6)],
  );
});

test('the money half is the customer’s and sales’ — the designer reads the summary without it, and before the close', async () => {
  await fullRun();
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    const s = (await summaryAs(who))!;
    assert.equal(s.invoices, null, who.email ?? '');
    assert.equal(s.agreed.agreement!.paymentPlan, null);
    assert.equal(s.agreed.agreement!.brief.budgetCap, null);
    // …and the rest of the record is the same one.
    assert.equal(s.items.length, 5);
  }
  for (const who of [f.customer, staff.SALES]) {
    const s = (await summaryAs(who))!;
    assert.equal(s.invoices!.count, 2, who.email ?? '');
    assert.equal(s.agreed.agreement!.paymentPlan!.total, '180000000');
    assert.equal(s.agreed.agreement!.brief.budgetCap, '150000000');
  }
  // Before the close: delivered nothing, a support promise with no dates yet.
  const s = (await summaryAs(f.customer))!;
  assert.deepEqual([s.deliveredAt, s.deliveredBy, s.dates.deliveredAt], [null, null, null]);
  assert.deepEqual(s.support, { months: 6, from: null, until: null });
});

test('unprompted changes: the customer is told only of those written up, in both languages; staff see the rest with the raw note; sales “as the customer” sees the customer’s', async () => {
  await fullRun();
  const customer = (await summaryAs(f.customer))!;
  assert.deepEqual(
    customer.unpromptedChanges.map((c) => [c.step, c.buildNumber, c.textFa, c.textEn, c.note, c.writtenUp]),
    [['DEMO', 1, 'پاورقی درست شد', 'The footer was fixed', null, true]],
  );
  const sales = (await summaryAs(staff.SALES))!;
  assert.deepEqual(
    sales.unpromptedChanges.map((c) => [c.buildNumber, c.writtenUp, c.note, c.noteLang]),
    [[1, true, null, null], [2, false, 'swapped the image library', 'en']],
  );
  const asCustomer = (await summaryAs(staff.SALES, true))!;
  assert.equal(asCustomer.unpromptedChanges.length, 1, 'view-as shows the customer’s record');
  // An unpublished build is in nobody’s record.
  const demoBuild = await prisma.build.findFirstOrThrow({ where: { number: 2 } });
  await prisma.build.update({ where: { id: demoBuild.id }, data: { publishedAt: null } });
  assert.equal((await summaryAs(staff.SALES))!.unpromptedChanges.length, 1);
});

test('the summary carries no feedback at all (Q-S8): not in its types, and not in what it returns', async () => {
  await fullRun();
  const intro = ok(
    await exec('{ types: __schema { types { name fields { name } } } }'),
  ).types as { types: Array<{ name: string; fields: Array<{ name: string }> | null }> };
  const summaryTypes = intro.types.filter((t) => /^(ContractSummary|Summary[A-Z])/.test(t.name));
  assert.ok(summaryTypes.length >= 8);
  for (const t of summaryTypes) {
    for (const field of t.fields ?? []) {
      assert.ok(!/feedback|comment|thread|answer|resolution|review/i.test(field.name), `${t.name}.${field.name}`);
    }
  }
  const json = JSON.stringify(await summaryAs(f.customer));
  assert.ok(!/feedback|comment/i.test(json));
});

test('a summary read through the print route’s query is the same record for the customer and for sales viewing as them', async () => {
  await fullRun();
  const mine = await summaryAs(f.customer);
  const viewed = await summaryAs(staff.SALES, true);
  assert.deepEqual(viewed, mine);
});
