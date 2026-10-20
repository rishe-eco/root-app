import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, publishDraftDirect, resetDatabase, seedFixture, type Fixture } from './db.js';
import { onDay } from './calendar.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J6 — step 2b, the draft and its notes (journeys build plan §5 "J6").
 *
 * In this order: **the publish gates** (`SCOPE_UNCONFIRMED`, then
 * `BRIEF_INCOMPLETE`, then success — and the legacy road untouched); the
 * **notes** anchored to `(revision, article number)` and where each article is
 * now on a later version — changed, moved without changing, unchanged, gone;
 * **PD-21** — a note on a sensitive article is about money and hidden from the
 * designer everywhere it could be read; **`USE_FEEDBACK`** for the new road's
 * free thread and its survival on the legacy one; the lock (`STEP_LOCKED`,
 * reached by inserting a `StepApproval` row directly); the planned dates; the
 * wizard's DRAFT signal; and the customer's email.
 *
 * The fixture's own published v1 carries three articles (`Article 1..3`) and is
 * on the new road, so notes anchor to it directly. A test whose subject is a
 * *later* revision publishes it with `publishDraftDirect` (the same snapshot,
 * none of the gates); the gate tests — and one chain from a brief to a note's
 * fate — use the mutation.
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
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
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
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.create({
    data: { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه‌ی اصلی', labelEn: 'Home page', position: 0 },
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

// ---- documents and helpers --------------------------------------------------------

const PUBLISH = 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id revision { id } contractRevisions { version } } }';
const SET_BRIEF = 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }';
const CREATE_PHASE = `mutation($c: ID!){ createPhase(contractId: $c, number: 1, titleFa: "فاز", titleEn: "Phase", plannedEndAt: "${onDay('2026-11-10')}") { phases { id } } }`;
const SET_PLAN =
  'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }';
const SEED_SCOPE = 'mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }';
const NOTE = `mutation($c: ID!, $t: FeedbackTargetInput!, $b: String!){
  submitFeedback(contractId: $c, step: DRAFT, target: $t, body: $b) { item { id status contractRevisionId articleNumber } } }`;
const ANSWER = 'mutation($i: ID!, $b: String!, $r: FeedbackResolution){ answerFeedback(itemId: $i, body: $b, resolution: $r) { id status } }';
const NOTES = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) {
  draftNotes { revisionVersion onCurrentRevision articleNumber currentArticleNumber articleChangedSince articleGone
    item { id status step comments { body } } }
  feedbackItems(step: DRAFT) { id }
  wizard { step status }
} }`;

type Note = {
  revisionVersion: number;
  onCurrentRevision: boolean;
  articleNumber: number | null;
  currentArticleNumber: number | null;
  articleChangedSince: boolean;
  articleGone: boolean;
  item: { id: string; status: string; step: string; comments: Array<{ body: string }> };
};

const publish = (as: User = staff.SALES, contractId = f.contract.id) => exec(PUBLISH, { as, variables: { c: contractId } });

/** Seeds the contract's scope from its template — which needs a brief that names the type, so a bare one is written if there is none yet. */
async function seedScope() {
  await prisma.contractBrief.upsert({
    where: { contractId: f.contract.id },
    update: {},
    create: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK' },
  });
  ok(await exec(SEED_SCOPE, { as: staff.SALES, variables: { c: f.contract.id } }));
}

/** Everything `publishContractRevision` asks of the new road: a scope of the contract's own, and a complete brief. */
async function readyToPublish({ scope = true }: { scope?: boolean } = {}) {
  ok(
    await exec(SET_BRIEF, {
      as: staff.SALES,
      variables: {
        c: f.contract.id,
        i: {
          kind: 'NEW_SITE',
          templateTypeId: type.id,
          designTier: 'THEME_PICK',
          budgetCap: '150000000',
          hardDeadline: onDay('2026-10-23'),
          domainName: 'nahal.ir',
          domainProvidedBy: 'CUSTOMER',
          hostProvidedBy: 'ROOT',
          contentProvidedBy: 'CUSTOMER',
          supportMonths: 6,
          premadeRounds: 2,
          demoIterationsPerPhase: 2,
          commitments: [
            { key: 'domain', dueAt: onDay('2026-10-05') },
            { key: 'host', dueAt: onDay('2026-10-06') },
            { key: 'content', dueAt: onDay('2026-10-07') },
          ],
        },
      },
    }),
  );
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id } })).createPhase as { phases: Array<{ id: string }> };
  ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: {
        c: f.contract.id,
        r: [
          { labelFa: 'الف', labelEn: 'A', amount: '100000000', phaseId: phase.phases[0].id, paymentTermDays: 7 },
          { labelFa: 'ب', labelEn: 'B', amount: '80000000', phaseId: null, paymentTermDays: 7 },
        ],
      },
    }),
  );
  if (scope) await seedScope();
}

/** A note by the customer on one article of a revision (the fixture's v1 unless told otherwise). */
const note = (articleNumber: number, body = 'Please explain this', revisionId = f.contractRevision.id, as: User = f.customer) =>
  exec(NOTE, { as, variables: { c: f.contract.id, t: { contractRevisionId: revisionId, articleNumber }, b: body } });
const noteOk = async (...args: Parameters<typeof note>) =>
  (ok(await note(...args)).submitFeedback as { item: { id: string } }).item;

const notes = async (as: User, asCustomer = false) =>
  (ok(await exec(NOTES, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as { draftNotes: Note[] }).draftNotes;

const lock = () => prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });

/** Publishes a v2 in which the fixture's article 3 has been changed by `edit`. */
async function v2With(edit: () => Promise<void>) {
  await edit();
  return publishDraftDirect(f.contract.id);
}

// ---- the gates --------------------------------------------------------------------

test('publishContractRevision on the new road: SCOPE_UNCONFIRMED until the contract has a scope of its own and nothing waits for Root', async () => {
  // Nothing seeded: the scope has nothing in it.
  assert.equal((await publish()).code, 'SCOPE_UNCONFIRMED');
  // Seeded — but a customer's proposal is waiting for a decision.
  await seedScope();
  await prisma.scopeProposal.create({
    data: { contractId: f.contract.id, kind: 'ADD', requestedKind: 'PAGE', text: 'یک صفحه', lang: 'fa', proposedById: f.customer.id },
  });
  assert.equal((await publish()).code, 'SCOPE_UNCONFIRMED');
  // Declined (a decision, of any kind): the scope is confirmed, and the next gate speaks.
  await prisma.scopeProposal.updateMany({ data: { decision: 'DECLINED', declineReason: 'no', decidedAt: new Date() } });
  assert.equal((await publish()).code, 'BRIEF_INCOMPLETE');
  assert.equal(await prisma.contractRevision.count(), 1, 'refusals published nothing');
});

test('BRIEF_INCOMPLETE: the scope refusal comes first, the brief’s second — with step 1’s gaps named — and success when both are clear', async () => {
  // Both fail: the plan's order — scope first.
  assert.equal((await publish()).code, 'SCOPE_UNCONFIRMED');
  await seedScope();
  const refused = await publish();
  assert.equal(refused.code, 'BRIEF_INCOMPLETE');
  // A dirty draft does not get around it.
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 3 } }, data: { bodyEn: 'Changed' } });
  assert.equal((await publish()).code, 'BRIEF_INCOMPLETE');

  await readyToPublish({ scope: false }); // the scope is seeded above; the rest completes the brief
  const done = ok(await publish()).publishContractRevision as { contractRevisions: Array<{ version: number }> };
  assert.deepEqual(done.contractRevisions.map((r) => r.version), [2, 1]);
});

test('the gates are read under the contract’s lock: a proposal made just before the press is in the answer', async () => {
  await readyToPublish();
  ok(await publish()); // v2 (the fixture's v1 is v1)
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 1 } }, data: { bodyEn: 'Changed again' } });
  ok(
    await exec('mutation($c: ID!){ proposeScopeAddition(contractId: $c, kind: PAGE, text: "one more", lang: "en") { id } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  );
  assert.equal((await publish()).code, 'SCOPE_UNCONFIRMED');
});

test('publishContractRevision: contracts.author only, and the older refusals keep their order (signed, then nothing-changed)', async () => {
  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    assert.equal((await publish(who)).code, 'FORBIDDEN', who.email!);
  }
  assert.equal((await publish(staff.SALES, 'nope')).code, 'NOT_FOUND');
  await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Test Customer', signedHash: f.contractRevision.contentHash! },
  });
  // Signed is terminal, and is said before any gate.
  assert.equal((await publish()).code, 'CONTRACT_SIGNED');
});

test('NO_CHANGES still follows the gates: a ready contract with an unchanged draft is refused as before', async () => {
  await readyToPublish();
  ok(await publish());
  assert.equal((await publish()).code, 'NO_CHANGES');
});

test('the legacy road publishes exactly as it did: no gates, and the customer is not emailed', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 3 } }, data: { bodyEn: 'Changed' } });
  mail.length = 0;
  sms.length = 0;
  const done = ok(await publish()).publishContractRevision as { contractRevisions: Array<{ version: number }> };
  assert.deepEqual(done.contractRevisions.map((r) => r.version), [2, 1]);
  assert.deepEqual(mail, []);
  assert.deepEqual(sms, []);
});

test('STEP_LOCKED: publishing the draft, setting the dates and applying the template are refused once the agreement is approved (a StepApproval row, inserted directly)', async () => {
  await readyToPublish();
  await lock();
  assert.equal((await publish()).code, 'STEP_LOCKED');
  assert.equal(
    (await exec(`mutation($c: ID!){ setPlannedDates(contractId: $c, plannedStartAt: "${onDay('2026-11-01')}") { id } }`, { as: staff.SALES, variables: { c: f.contract.id } })).code,
    'STEP_LOCKED',
  );
  await prisma.article.deleteMany({ where: { contractId: f.contract.id } });
  assert.equal(
    (await exec('mutation($c: ID!){ applyContractTemplate(contractId: $c) { id } }', { as: staff.SALES, variables: { c: f.contract.id } })).code,
    'STEP_LOCKED',
  );
  assert.equal(await prisma.article.count({ where: { contractId: f.contract.id } }), 0);
  // The customer's note is refused too — S2's own rule, on this step.
  assert.equal((await note(3)).code, 'STEP_LOCKED');
});

// ---- the notes ----------------------------------------------------------------------

test('a note on v1’s article 3 shows on v2 as changed when article 3’s text changed, in the same place', async () => {
  const item = await noteOk(3);
  const v2 = await v2With(async () => {
    await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 3 } }, data: { bodyEn: 'A wholly new clause' } });
  });
  assert.equal(v2.version, 2);
  for (const who of [f.customer, staff.SALES]) {
    const [n] = await notes(who);
    assert.equal(n.item.id, item.id);
    assert.deepEqual(
      [n.revisionVersion, n.onCurrentRevision, n.articleNumber, n.currentArticleNumber, n.articleChangedSince, n.articleGone],
      [1, false, 3, 3, true, false],
      who.email!,
    );
  }
});

test('…and as unchanged when it was another article that changed', async () => {
  await noteOk(3);
  await v2With(async () => {
    await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 2 } }, data: { bodyEn: 'Only article 2 moved' } });
  });
  const [n] = await notes(f.customer);
  assert.deepEqual([n.currentArticleNumber, n.articleChangedSince, n.articleGone], [3, false, false]);
});

test('an article inserted before it renumbers it: the note follows the article by title (now 4), and it is not "changed"', async () => {
  await noteOk(3);
  await v2With(async () => {
    const where = { contractId_number: { contractId: f.contract.id, number: 3 } };
    await prisma.article.update({ where, data: { number: 4 } });
    await prisma.article.create({
      data: { contractId: f.contract.id, number: 3, titleFa: 'تعاریف', titleEn: 'Definitions', bodyFa: 'ب', bodyEn: 'Terms' },
    });
  });
  const [n] = await notes(f.customer);
  // Read by number this would be "Definitions" — a different article. By title it is article 4.
  assert.deepEqual([n.articleNumber, n.currentArticleNumber, n.articleChangedSince, n.articleGone], [3, 4, false, false]);
});

test('an article that was deleted is gone — the note says so instead of pointing at whatever took its number', async () => {
  const item = await noteOk(3);
  await v2With(async () => {
    await prisma.article.delete({ where: { contractId_number: { contractId: f.contract.id, number: 3 } } });
    await prisma.article.create({
      data: { contractId: f.contract.id, number: 3, titleFa: 'کاملاً تازه', titleEn: 'Brand new', bodyFa: 'ب', bodyEn: 'Different' },
    });
  });
  const [n] = await notes(f.customer);
  assert.equal(n.item.id, item.id);
  assert.deepEqual([n.currentArticleNumber, n.articleChangedSince, n.articleGone], [null, false, true]);
});

test('a note on the current revision is on the current revision; notes on two versions of one article are two notes', async () => {
  const old = await noteOk(3, 'about v1');
  const v2 = await v2With(async () => {
    await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 3 } }, data: { bodyEn: 'Edited' } });
  });
  const fresh = await noteOk(3, 'about v2', v2.id);
  assert.notEqual(old.id, fresh.id);
  const listed = await notes(f.customer);
  assert.deepEqual(
    listed.map((n) => [n.item.id === old.id ? 'old' : 'fresh', n.revisionVersion, n.onCurrentRevision, n.articleChangedSince]),
    [['old', 1, false, true], ['fresh', 2, true, false]],
  );
  // The customer replies to the old one: the same thread, not a new note.
  const again = await noteOk(3, 'still unclear', f.contractRevision.id);
  assert.equal(again.id, old.id);
  assert.equal(await prisma.feedbackItem.count({ where: { step: 'DRAFT' } }), 2);
});

test('a note is the S2 model: Root answers it, its fate shows, and a comment on a resolved note reopens it', async () => {
  const item = await noteOk(2, 'What does this cover?');
  assert.equal((await notes(f.customer))[0].item.status, 'OPEN');
  ok(await exec(ANSWER, { as: staff.SALES, variables: { i: item.id, b: 'It covers the whole site.', r: 'ADDRESSED' } }));
  const [answered] = await notes(f.customer);
  assert.equal(answered.item.status, 'ADDRESSED');
  assert.deepEqual(answered.item.comments.map((c) => c.body), ['What does this cover?', 'It covers the whole site.']);
  await noteOk(2, 'Not what I meant');
  assert.equal((await notes(f.customer))[0].item.status, 'OPEN');
  // A DRAFT anchor is an article of a revision of *this* contract — or nothing.
  const other = await exec(NOTE, { as: f.customer, variables: { c: f.contract.id, t: { contractRevisionId: 'nope', articleNumber: 1 }, b: 'x' } });
  assert.equal(other.code, 'NOT_FOUND');
  assert.equal((await exec(NOTE, { as: f.customer, variables: { c: f.contract.id, t: { briefField: 'kind' }, b: 'x' } })).code, 'INVALID_TARGET');
});

test('only the contract’s customer raises a note; staff and strangers do not, and a stranger cannot read them', async () => {
  for (const who of [staff.SALES, f.admin, f.stranger]) {
    assert.equal((await note(1, 'x', f.contractRevision.id, who)).code, 'NOT_FOUND', who.email!);
  }
  await noteOk(1);
  assert.equal((await exec(NOTES, { as: f.stranger, variables: { c: f.contract.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(NOTES, { as: staff.CONTRIBUTOR, variables: { c: f.contract.id } })).code, 'NOT_FOUND');
});

test('the draft-wide note is not in draftNotes: it stays on feedbackItems with the other steps’ general notes', async () => {
  ok(await exec(NOTE, { as: f.customer, variables: { c: f.contract.id, t: { general: true }, b: 'The whole thing is too long' } }));
  await noteOk(1);
  const c = ok(await exec(NOTES, { as: staff.SALES, variables: { c: f.contract.id } })).contract as { draftNotes: Note[]; feedbackItems: unknown[] };
  assert.equal(c.draftNotes.length, 1);
  assert.equal(c.feedbackItems.length, 2);
});

// ---- PD-21: a note on a sensitive article -----------------------------------------------

test('PD-21: a note on a sensitive article is money-anchored — hidden from the designer in every list, shown to sales and to the customer', async () => {
  await prisma.article.create({ data: { contractId: f.contract.id, number: 4, titleFa: 'حق‌الزحمه', titleEn: 'Fees', bodyFa: 'ب', bodyEn: 'Pay us', sensitive: true } });
  await prisma.article.create({ data: { contractId: f.contract.id, number: 5, titleFa: 'محرمانگی', titleEn: 'Confidentiality', bodyFa: 'ب', bodyEn: 'Hush' } });
  const v2 = await publishDraftDirect(f.contract.id);
  const fees = await noteOk(4, 'This is too much', v2.id);
  const ordinary = await noteOk(5, 'Fine, but why', v2.id);

  const ids = (list: Note[]) => list.map((n) => n.item.id).sort();
  assert.deepEqual(ids(await notes(f.customer)), [fees.id, ordinary.id].sort());
  assert.deepEqual(ids(await notes(staff.SALES)), [fees.id, ordinary.id].sort());
  assert.deepEqual(ids(await notes(f.admin)), [fees.id, ordinary.id].sort());
  assert.deepEqual(ids(await notes(staff.SALES, true)), [fees.id, ordinary.id].sort(), 'view-as-customer is the customer’s own answer');
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    assert.deepEqual(ids(await notes(who)), [ordinary.id], `${who.email}: only the ordinary note`);
    // The same filter as Contract.feedbackItems: the list a shared fragment reads agrees.
    const items = ok(await exec(NOTES, { as: who, variables: { c: f.contract.id } })).contract as { feedbackItems: Array<{ id: string }> };
    assert.deepEqual(items.feedbackItems.map((i) => i.id), [ordinary.id], who.email!);
    // And they cannot answer what they cannot see: the item is not found.
    assert.equal((await exec(ANSWER, { as: who, variables: { i: fees.id, b: 'x', r: null } })).code, 'NOT_FOUND', who.email!);
  }
  // Sales answers it, directly.
  ok(await exec(ANSWER, { as: staff.SALES, variables: { i: fees.id, b: 'Here is the breakdown', r: 'ADDRESSED' } }));
  assert.equal((await notes(f.customer)).find((n) => n.item.id === fees.id)!.item.status, 'ADDRESSED');
});

test('the sensitivity is the live row’s: un-marking the article shows its notes to the designer', async () => {
  await prisma.article.create({ data: { contractId: f.contract.id, number: 4, titleFa: 'ح', titleEn: 'Fees', bodyFa: 'ب', bodyEn: 'x', sensitive: true } });
  const v2 = await publishDraftDirect(f.contract.id);
  await noteOk(4, 'hmm', v2.id);
  assert.equal((await notes(staff.DESIGNER)).length, 0);
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 4 } }, data: { sensitive: false } });
  assert.equal((await notes(staff.DESIGNER)).length, 1);
});

// ---- USE_FEEDBACK -------------------------------------------------------------------------

test('addComment: USE_FEEDBACK on a new-road contract — for its customer and for staff — and unchanged on a legacy one', async () => {
  const ADD = 'mutation($c: ID!){ addComment(contractId: $c, body: "hello") { id comments { body } } }';
  assert.equal((await exec(ADD, { as: f.customer, variables: { c: f.contract.id } })).code, 'USE_FEEDBACK');
  assert.equal((await exec(ADD, { as: staff.SALES, variables: { c: f.contract.id } })).code, 'USE_FEEDBACK');
  assert.equal((await exec(ADD, { as: f.stranger, variables: { c: f.contract.id } })).code, 'NOT_FOUND', 'a stranger still hears "no such contract"');
  assert.equal(await prisma.comment.count({ where: { contractId: f.contract.id } }), 0);

  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  const legacy = ok(await exec(ADD, { as: f.customer, variables: { c: f.contract.id } })).addComment as { comments: Array<{ body: string }> };
  assert.deepEqual(legacy.comments.map((c) => c.body), ['hello']);
  ok(await exec(ADD, { as: staff.SALES, variables: { c: f.contract.id } }));
  assert.equal(await prisma.changeLog.count({ where: { contractId: f.contract.id, action: 'COMMENTED' } }), 2, 'legacy still logs');
});

// ---- the planned dates ------------------------------------------------------------------------

const DATES = 'mutation($c: ID!, $s: String, $e: String){ setPlannedDates(contractId: $c, plannedStartAt: $s, plannedEndAt: $e) { plannedStartAt plannedEndAt } }';
const READ_DATES = 'query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { plannedStartAt plannedEndAt statusSummary { plannedStartAt } } }';

test('setPlannedDates: calendar days, a replace, ordered — and shown to the customer beside the draft, not before there is one', async () => {
  const set = (s: string | null, e: string | null, as: User = staff.SALES) => exec(DATES, { as, variables: { c: f.contract.id, s, e } });
  assert.equal((await set('2026-13-40', null)).code, 'INVALID_DATE');
  assert.equal((await set(onDay('2026-12-01'), onDay('2026-11-01'))).code, 'DATES_OUT_OF_ORDER');
  for (const who of [staff.DESIGNER, staff.DEVELOPER, f.customer]) assert.equal((await set(onDay('2026-11-01'), null, who)).code, 'FORBIDDEN', who.email!);

  const done = ok(await set(onDay('2026-11-01'), onDay('2027-01-15'))).setPlannedDates as { plannedStartAt: string; plannedEndAt: string };
  assert.deepEqual([done.plannedStartAt, done.plannedEndAt], [`${onDay('2026-11-01')}T00:00:00.000Z`, `${onDay('2027-01-15')}T00:00:00.000Z`]);
  // A replace: an omitted day is cleared.
  const cleared = ok(await set(onDay('2026-11-01'), null)).setPlannedDates as { plannedEndAt: string | null };
  assert.equal(cleared.plannedEndAt, null);
  ok(await set(onDay('2026-11-01'), onDay('2027-01-15')));

  const read = async (as: User, asCustomer = false) =>
    ok(await exec(READ_DATES, { as, variables: { c: f.contract.id, as: asCustomer } })).contract as { plannedStartAt: string | null; statusSummary: { plannedStartAt: string | null } };
  // The fixture's v1 is a published draft, so the customer reads them.
  assert.equal((await read(f.customer)).plannedStartAt, `${onDay('2026-11-01')}T00:00:00.000Z`);
  assert.equal((await read(f.customer)).statusSummary.plannedStartAt, `${onDay('2026-11-01')}T00:00:00.000Z`, 'the status area and the panel agree');
  // Without a draft they are staff's.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentContractRevisionId: null } });
  await prisma.contractRevision.deleteMany({ where: { contractId: f.contract.id } });
  assert.equal((await read(f.customer)).plannedStartAt, null);
  assert.equal((await read(staff.SALES, true)).plannedStartAt, null, 'view-as-customer is the customer’s answer');
  assert.equal((await read(staff.DESIGNER)).plannedStartAt, `${onDay('2026-11-01')}T00:00:00.000Z`);

  const legacy = await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await exec(DATES, { as: staff.SALES, variables: { c: legacy.id, s: onDay('2026-11-01'), e: null } })).code, 'STEP_NOT_ON_ROAD');
});

// ---- the wizard ---------------------------------------------------------------------------------

test('the wizard: DRAFT is done when a revision is published and no note on it is waiting for Root', async () => {
  const draft = async () => {
    const c = ok(await exec(NOTES, { as: f.customer, variables: { c: f.contract.id } })).contract as { wizard: Array<{ step: string; status: string }> };
    return c.wizard.find((w) => w.step === 'DRAFT')!.status;
  };
  assert.equal(await draft(), 'DONE', 'the fixture has a published v1 and no notes');
  const open = await noteOk(3);
  assert.notEqual(await draft(), 'DONE', 'a note is waiting for Root');
  ok(await exec(ANSWER, { as: staff.SALES, variables: { i: open.id, b: 'Answered', r: 'ADDRESSED' } }));
  assert.equal(await draft(), 'DONE', 'answered: Root’s half is done — approval (J7) is what needs it accepted');
  await noteOk(3, 'reopening');
  assert.notEqual(await draft(), 'DONE');
  // With no published revision at all the step is not done, whatever the notes.
  await prisma.feedbackItem.deleteMany();
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentContractRevisionId: null } });
  await prisma.contractRevision.deleteMany({ where: { contractId: f.contract.id } });
  assert.notEqual(await draft(), 'DONE');
});

// ---- the customer's email ---------------------------------------------------------------------------

test('publishing the draft tells the customer — once per publish, the first as "ready to read" and a later one as a revision — and no one else', async () => {
  await readyToPublish();
  mail.length = 0;
  sms.length = 0;
  ok(await publish()); // v2 — the fixture's v1 was published before the customer could be told
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, f.customer.email);
  assert.match(mail[0].subject, /بازبینی شد \(v2\)/);
  assert.ok(mail[0].text.includes(`/app/contracts/${f.contract.id}`));
  assert.deepEqual(sms.map((s) => s.to), ['+989120000105']);
  assert.ok(sms[0].text!.includes(`/app/contracts/${f.contract.id}`));

  // English, and a real "first look": a contract whose first revision this is.
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 1 } }, data: { bodyEn: 'Edited' } });
  mail.length = 0;
  ok(await publish());
  assert.match(mail[0].subject, /revised \(v3\)/);
});

test('the first draft is announced as ready to read; a contract not yet handed over tells no one (the customer cannot open it)', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentContractRevisionId: null } });
  await prisma.contractRevision.deleteMany({ where: { contractId: f.contract.id } });
  await prisma.user.update({ where: { id: f.customer.id }, data: { locale: 'en' } });
  await readyToPublish();
  mail.length = 0;
  ok(await publish());
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /ready to read/);

  // Not handed over (publishedAt null): the revision is published, nobody is emailed.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 1 } }, data: { bodyEn: 'Edited' } });
  mail.length = 0;
  ok(await publish());
  assert.deepEqual(mail, []);
});

test('a failing mail transport never fails the publish', async () => {
  await readyToPublish();
  __setMailTransportForTests({
    send: async () => {
      throw new Error('mail is down');
    },
  });
  const done = ok(await publish()).publishContractRevision as { contractRevisions: Array<{ version: number }> };
  assert.equal(done.contractRevisions[0].version, 2);
});

// ---- the chain --------------------------------------------------------------------------------------

test('the whole of step 2: seed, propose, decide, publish, note, revise, and see the note’s fate and its article’s', async () => {
  // Scope: seeded, one proposal from the customer, decided.
  await seedScope();
  ok(await exec('mutation($c: ID!){ proposeScopeAddition(contractId: $c, kind: FEATURE, text: "A blog", lang: "en") { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  const proposal = await prisma.scopeProposal.findFirstOrThrow();
  ok(await exec('mutation($p: ID!){ decideScopeProposal(id: $p, decision: ACCEPTED, labelFa: "وبلاگ", labelEn: "Blog") { id } }', { as: staff.SALES, variables: { p: proposal.id } }));
  // Step 1 completes; the draft goes out (v2 over the fixture's v1).
  await readyToPublish({ scope: false });
  ok(await publish());
  const current = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id }, orderBy: { version: 'desc' } });
  assert.equal(current.version, 2);

  // The customer leaves a note on article 3 of v2; Root answers; then a v3 changes the article.
  const item = await noteOk(3, 'This wording worries me', current.id);
  ok(await exec(ANSWER, { as: staff.SALES, variables: { i: item.id, b: 'We will reword it', r: 'ADDRESSED' } }));
  await prisma.article.update({ where: { contractId_number: { contractId: f.contract.id, number: 3 } }, data: { bodyEn: 'Reworded' } });
  ok(await publish());
  const [n] = await notes(f.customer);
  assert.deepEqual(
    [n.revisionVersion, n.onCurrentRevision, n.item.status, n.articleChangedSince, n.currentArticleNumber],
    [2, false, 'ADDRESSED', true, 3],
  );
});
