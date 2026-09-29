import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Role, StepKind, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { ANCHOR_TABLE } from './anchorTable.js';
import { anchorMatchesStep, type FeedbackAnchor } from '../lib/feedbackRules.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';

/**
 * S2: one feedback model for every step, the §3.1 rule, answers and the
 * approval queue (journeys build plan §5 "S2"). The plan's list, in order:
 * the answer matrix through the API; a pending answer invisible to the
 * customer and to sales-as-customer; approve applies, decline needs a reason
 * (the CHECK, by insert); reopen from DECLINED; `STEP_LOCKED` after approval;
 * the anchor CHECK and every partial index by direct insert; the single writer
 * of `acceptedAt`; the build queue that must not drain other steps — and the
 * Acceptance paragraph as one scenario, at the end.
 */

let f: Fixture;
let sales: User;
let designer: User;
let designer2: User;
let developer: User;
let mail: MailMessage[];

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  const mk = (name: string, roles: Role[]) =>
    prisma.user.create({ data: { email: `${name}@test.local`, name, roles, state: 'ACTIVE', locale: 'en' } });
  sales = await mk('sales', ['SALES']);
  designer = await mk('designer', ['DESIGNER']);
  designer2 = await mk('designer2', ['DESIGNER']);
  developer = await mk('developer', ['DEVELOPER']);
  await prisma.user.updateMany({ where: { id: { in: [f.customer.id, f.admin.id] } }, data: { locale: 'en' } });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: designer.id, developerId: developer.id } });
  mail = [];
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
});

after(async () => {
  __resetMailTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// --- fixtures ------------------------------------------------------------------

/** A phase with a published demo, a frame, two declared pages and one frame
 *  line pointing at a scope item. Direct Prisma: the state under test is
 *  S2's, not L3's. */
async function seedDemo(opts: { decided?: boolean } = {}) {
  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  const demo = await prisma.demo.create({
    data: { phaseId: phase.id, stagingUrl: 'https://staging.example.com', publishedAt: new Date() },
  });
  const home = await prisma.demoPage.create({ data: { demoId: demo.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' } });
  const about = await prisma.demoPage.create({ data: { demoId: demo.id, key: 'about', labelFa: 'درباره', labelEn: 'About', canonicalPath: '/about' } });
  const scopeItem = await prisma.scopeItem.create({
    data: {
      projectId,
      key: 'checkout',
      kind: 'FEATURE',
      labelFa: 'پرداخت',
      labelEn: 'Checkout',
      status: 'IN_DEMO',
      phaseId: phase.id,
      decidedAt: opts.decided ? new Date('2026-01-01T00:00:00Z') : null,
      decidedNote: opts.decided ? 'Settled on a call' : null,
    },
  });
  const frame = await prisma.demoFrame.create({ data: { demoId: demo.id, authoredById: f.admin.id } });
  const line = await prisma.demoFrameLine.create({
    data: { frameId: frame.id, kind: 'NEW', textFa: 'پرداخت', textEn: 'Checkout', scopeItemId: scopeItem.id },
  });
  return { phase, demo, home, about, scopeItem, line };
}

const SUBMIT = `
  mutation($c: ID!, $s: StepKind!, $ph: ID, $t: FeedbackTargetInput!, $b: String!, $confirm: Boolean) {
    submitFeedback(contractId: $c, step: $s, phaseId: $ph, target: $t, body: $b, confirmReopen: $confirm) {
      item { id status step general }
      intercepted
      interceptionReason
    }
  }
`;

type Submitted = { item: { id: string; status: string } | null; intercepted: boolean; interceptionReason: string | null };

async function submit(
  step: StepKind,
  target: Record<string, unknown>,
  body = 'a comment',
  extra: { phaseId?: string; confirm?: boolean; as?: User; contractId?: string } = {},
) {
  return exec(SUBMIT, {
    as: extra.as ?? f.customer,
    variables: { c: extra.contractId ?? f.contract.id, s: step, ph: extra.phaseId ?? null, t: target, b: body, confirm: extra.confirm ?? false },
  });
}

async function submitOk(...args: Parameters<typeof submit>) {
  return (ok(await submit(...args)).submitFeedback as Submitted).item!;
}

const ANSWER = `
  mutation($i: ID!, $b: String!, $r: FeedbackResolution) {
    answerFeedback(itemId: $i, body: $b, resolution: $r) {
      id status
      comments { id body resolution approval approvalNote originalBody approvedBy { id } author { id } }
    }
  }
`;

const answer = (as: User, itemId: string, body: string, resolution: 'ADDRESSED' | 'DECLINED' | null = null) =>
  exec(ANSWER, { as, variables: { i: itemId, b: body, r: resolution } });

const APPROVE_ANSWER = 'mutation($c: ID!, $b: String){ approveAnswer(commentId: $c, body: $b) { id status comments { id body originalBody approval } } }';
const DECLINE_ANSWER = 'mutation($c: ID!, $r: String!){ declineAnswer(commentId: $c, reason: $r) { id status } }';
const APPROVE_STEP = 'mutation($c: ID!, $s: StepKind!, $p: ID){ approveStep(contractId: $c, step: $s, phaseId: $p) { id wizard { step phaseId locked } } }';

const ITEMS = `
  query($c: ID!, $as: Boolean, $s: StepKind) {
    contract(id: $c, asCustomer: $as) {
      feedbackItems(step: $s) {
        id status step general
        comments { id body resolution approval approvalNote originalBody approvedBy { id } author { id } }
      }
    }
  }
`;

type ViewedItem = {
  id: string;
  status: string;
  step: string;
  comments: Array<{ id: string; body: string; resolution: string | null; approval: string; approvalNote: string | null; originalBody: string | null; approvedBy: { id: string } | null; author: { id: string } }>;
};

async function view(as: User, opts: { asCustomer?: boolean; step?: StepKind } = {}) {
  const data = ok(await exec(ITEMS, { as, variables: { c: f.contract.id, as: opts.asCustomer ?? null, s: opts.step ?? null } }));
  return (data.contract as { feedbackItems: ViewedItem[] }).feedbackItems;
}

const mails = (kind: string) => mail.filter((m) => m.subject.includes(kind));

/** A `general` item on a step, made straight in the database — the matrix
 *  needs one per step and the customer's door is tested elsewhere. */
async function makeItem(step: StepKind, phaseId: string | null = null, extra: Record<string, unknown> = {}) {
  return prisma.feedbackItem.create({
    data: {
      projectId: f.contract.projectId,
      contractId: f.contract.id,
      step,
      phaseId,
      general: true,
      ratifiedAt: new Date(),
      ratifiedById: f.customer.id,
      comments: { create: { authorId: f.customer.id, body: 'Please look at this' } },
      ...extra,
    },
  });
}

// =================================================================================
// The answer matrix, through the API (PD-3)
// =================================================================================

test('answerFeedback: every role × every feedback step — direct or pending, exactly as the matrix says', async () => {
  const { phase } = await seedDemo();
  const steps: StepKind[] = ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'DESIGN', 'MOCKUP', 'DEMO'];
  const who: Array<[string, User, Record<StepKind, "D" | "A">]> = [
    ["SALES", sales, { REQUIREMENTS: 'D', SCOPE: 'D', DRAFT: 'D', AGREEMENT: 'D', DESIGN: 'D', MOCKUP: 'D', DEMO: 'D', SUMMARY: 'A' }],
    ["ADMIN", f.admin, { REQUIREMENTS: 'D', SCOPE: 'D', DRAFT: 'D', AGREEMENT: 'D', DESIGN: 'D', MOCKUP: 'D', DEMO: 'D', SUMMARY: 'A' }],
    ["DESIGNER", designer, { REQUIREMENTS: 'A', SCOPE: 'A', DRAFT: 'A', AGREEMENT: 'A', DESIGN: 'D', MOCKUP: 'D', DEMO: 'A', SUMMARY: 'A' }],
    ["DEVELOPER", developer, { REQUIREMENTS: 'A', SCOPE: 'A', DRAFT: 'A', AGREEMENT: 'A', DESIGN: 'A', MOCKUP: 'A', DEMO: 'D', SUMMARY: 'A' }],
  ];
  for (const step of steps) {
    for (const [name, actor, row] of who) {
      const item = await makeItem(step, step === 'DEMO' ? phase.id : null, { general: true });
      const result = ok(await answer(actor, item.id, `answer by ${name}`, 'ADDRESSED'));
      const a = result.answerFeedback as { status: string; comments: Array<{ approval: string; body: string }> };
      const comment = a.comments.find((c) => c.body === `answer by ${name}`)!;
      const direct = row[step] === 'D';
      assert.equal(comment.approval, direct ? 'NOT_REQUIRED' : 'PENDING', `${name} on ${step}`);
      assert.equal(a.status, direct ? 'ADDRESSED' : 'OPEN', `${name} on ${step}: a pending answer resolves nothing`);
      // The next iteration's item must not collide with the general-per-step index.
      await prisma.feedbackItem.delete({ where: { id: item.id } });
    }
  }
});

test('answerFeedback: only feedback.answer, and only on an item the caller can see', async () => {
  const item = await makeItem('REQUIREMENTS');
  assert.equal((await answer(f.customer, item.id, 'I answer myself')).code, 'FORBIDDEN');
  const stranger = await prisma.user.create({ data: { email: 's@t.local', name: 's', roles: ['CUSTOMER'], state: 'ACTIVE' } });
  assert.equal((await answer(stranger, item.id, 'x')).code, 'FORBIDDEN');
  assert.equal((await answer(sales, item.id, '   ')).code, 'EMPTY_COMMENT');
  assert.equal((await answer(sales, 'no-such-item', 'x')).code, 'NOT_FOUND');
  // A contributor holds no staff capability at all.
  const contributor = await prisma.user.create({ data: { email: 'c@t.local', name: 'c', roles: ['CONTRIBUTOR'], state: 'ACTIVE' } });
  assert.equal((await answer(contributor, item.id, 'x')).code, 'FORBIDDEN');
});

// =================================================================================
// A pending answer is invisible to the customer — and to sales viewing as the customer
// =================================================================================

test('a pending answer is invisible to the customer and to sales under asCustomer; the item stays open; staff see it', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'The hero image is blurry', { phaseId: phase.id });

  ok(await answer(designer, item.id, 'Fixed the hero image', 'ADDRESSED'));
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'OPEN', 'pending — nothing applied');

  const asCustomer = await view(f.customer);
  assert.deepEqual(asCustomer[0].comments.map((c) => c.body), ['The hero image is blurry']);
  assert.equal(asCustomer[0].status, 'OPEN');

  // Sales looking as the customer is asked about the *customer* (`viewerOf`):
  // no asCustomer branch anywhere, so the pending answer cannot leak.
  const salesAsCustomer = await view(sales, { asCustomer: true });
  assert.deepEqual(salesAsCustomer[0].comments.map((c) => c.body), ['The hero image is blurry']);

  // Staff — the author included — see it, with its state.
  for (const staff of [sales, designer, developer]) {
    const seen = (await view(staff))[0].comments;
    const pending = seen.find((c) => c.body === 'Fixed the hero image')!;
    assert.equal(pending.approval, 'PENDING');
    assert.equal(pending.resolution, 'ADDRESSED');
  }

  // The machinery is staff's too: a customer reading a published answer sees no approver.
  ok(await exec(APPROVE_ANSWER, { as: sales, variables: { c: (await view(sales))[0].comments.find((c) => c.approval === 'PENDING')!.id, b: null } }));
  const published = (await view(f.customer))[0].comments.find((c) => c.body === 'Fixed the hero image')!;
  assert.equal(published.approval, 'APPROVED');
  assert.equal(published.approvedBy, null, 'who approved is Root’s business');
  assert.equal(published.originalBody, null);
});

// =================================================================================
// approve applies; decline needs a reason
// =================================================================================

test('approveAnswer publishes and applies the resolution; edit-and-approve keeps the author’s words; both record who', async () => {
  const { phase, home, about } = await seedDemo();
  const a = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'One', { phaseId: phase.id });
  const b = await submitOk('DEMO', { demoId: about.demoId, demoPageId: about.id }, 'Two', { phaseId: phase.id });
  ok(await answer(designer, a.id, 'Done as asked', 'ADDRESSED'));
  ok(await answer(designer, b.id, 'not now', 'DECLINED'));

  const pendingIds = async (itemId: string) => (await view(sales)).find((i) => i.id === itemId)!.comments.find((c) => c.approval === 'PENDING')!.id;

  const approved = ok(await exec(APPROVE_ANSWER, { as: sales, variables: { c: await pendingIds(a.id), b: null } }));
  assert.equal((approved.approveAnswer as { status: string }).status, 'ADDRESSED', 'the resolution is applied at approval');

  const edited = ok(await exec(APPROVE_ANSWER, { as: sales, variables: { c: await pendingIds(b.id), b: 'Not in this phase — it is planned for phase 2.' } }));
  const editedItem = edited.approveAnswer as { status: string; comments: Array<{ body: string; originalBody: string | null; approval: string }> };
  assert.equal(editedItem.status, 'DECLINED');
  const published = editedItem.comments.find((c) => c.approval === 'APPROVED')!;
  assert.equal(published.body, 'Not in this phase — it is planned for phase 2.');
  assert.equal(published.originalBody, 'not now', 'the designer’s own words are kept');

  const rows = await prisma.feedbackComment.findMany({ where: { approval: 'APPROVED' } });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.approvedById, sales.id);
    assert.ok(row.approvedAt);
    assert.equal(row.authorId, designer.id, 'both author and approver are on the record');
  }
  // A second approval of the same answer is refused, not repeated.
  const again = await exec(APPROVE_ANSWER, { as: sales, variables: { c: rows[0].id, b: null } });
  assert.equal(again.code, 'ANSWER_NOT_PENDING');
  // Only feedback.approveAnswers.
  const [pendingLeft] = [await prisma.feedbackComment.create({ data: { feedbackItemId: a.id, authorId: designer.id, body: 'x', approval: 'PENDING' } })];
  assert.equal((await exec(APPROVE_ANSWER, { as: designer, variables: { c: pendingLeft.id, b: null } })).code, 'FORBIDDEN');
  assert.equal((await exec(APPROVE_ANSWER, { as: f.customer, variables: { c: pendingLeft.id, b: null } })).code, 'FORBIDDEN');
  assert.equal((await exec(APPROVE_ANSWER, { as: sales, variables: { c: pendingLeft.id, b: '  ' } })).code, 'EMPTY_COMMENT');
});

test('declineAnswer needs a reason, keeps the answer in the record, leaves the item unchanged — and the author sees why, the customer never does', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'Change the logo', { phaseId: phase.id });
  ok(await answer(designer, item.id, 'Logo changed', 'ADDRESSED'));
  const commentId = (await view(sales))[0].comments.find((c) => c.approval === 'PENDING')!.id;

  assert.equal((await exec(DECLINE_ANSWER, { as: sales, variables: { c: commentId, r: '   ' } })).code, 'REASON_REQUIRED');
  assert.equal((await exec(DECLINE_ANSWER, { as: designer, variables: { c: commentId, r: 'no' } })).code, 'FORBIDDEN');
  ok(await exec(DECLINE_ANSWER, { as: sales, variables: { c: commentId, r: 'The logo is not ours to change — say so.' } }));

  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'OPEN', 'a declined answer resolves nothing');
  const authorSees = (await view(designer))[0].comments.find((c) => c.id === commentId)!;
  assert.equal(authorSees.approval, 'DECLINED');
  assert.equal(authorSees.approvalNote, 'The logo is not ours to change — say so.', 'the designer sees the reason');
  assert.equal(authorSees.approvedBy?.id, sales.id);
  assert.ok(!(await view(f.customer))[0].comments.some((c) => c.id === commentId), 'the customer never sees a declined draft');
  assert.ok(!(await view(sales, { asCustomer: true }))[0].comments.some((c) => c.id === commentId));

  // …and it is no longer pending, so it no longer blocks anything.
  assert.equal((await exec(DECLINE_ANSWER, { as: sales, variables: { c: commentId, r: 'again' } })).code, 'ANSWER_NOT_PENDING');
});

test('a later direct answer supersedes an earlier pending one: approving the old one publishes its words and leaves the state alone', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'Wrong colour', { phaseId: phase.id });
  ok(await answer(designer, item.id, 'We will not change it', 'DECLINED')); // pending — a designer outside their step
  ok(await answer(developer, item.id, 'Changed it', 'ADDRESSED')); // direct, later
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status, 'ADDRESSED');

  const stale = (await view(sales))[0].comments.find((c) => c.approval === 'PENDING')!;
  ok(await exec(APPROVE_ANSWER, { as: sales, variables: { c: stale.id, b: null } }));
  assert.equal(
    (await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    'ADDRESSED',
    'the item follows the latest visible resolving answer, not the last one approved',
  );
});

test('FeedbackComment_declined_has_reason: the database refuses a declined answer with no reason, by insert', async () => {
  const item = await makeItem('REQUIREMENTS');
  const base = { feedbackItemId: item.id, authorId: designer.id, body: 'x' };
  await assert.rejects(
    () => prisma.feedbackComment.create({ data: { ...base, approval: 'DECLINED' } }),
    /FeedbackComment_declined_has_reason/,
  );
  await assert.rejects(
    () => prisma.feedbackComment.create({ data: { ...base, approval: 'DECLINED', approvalNote: '   ' } }),
    /FeedbackComment_declined_has_reason/,
    'a note of whitespace is not a reason',
  );
  await prisma.feedbackComment.create({ data: { ...base, approval: 'DECLINED', approvalNote: 'because' } });
  // The CHECK binds only the DECLINED state.
  await prisma.feedbackComment.create({ data: { ...base, approval: 'PENDING' } });
  await prisma.feedbackComment.create({ data: { ...base, approval: 'APPROVED' } });
});

test('resolution is only ever on a staff comment: no comment in the database carries one from someone who may not answer', async () => {
  // The plan's "resolution IS NULL OR author is staff" cannot be a SQL CHECK
  // (staff is a function of a role set) — it is held by construction in the
  // resolvers and asserted here over a whole scenario's rows.
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'a', { phaseId: phase.id });
  ok(await answer(developer, item.id, 'b', 'DECLINED'));
  await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'c', { phaseId: phase.id });
  ok(await answer(designer, item.id, 'd', 'ADDRESSED'));
  const withResolution = await prisma.feedbackComment.findMany({ where: { resolution: { not: null } }, include: { author: true } });
  assert.ok(withResolution.length >= 2);
  for (const c of withResolution) assert.ok(c.author.roles.some((r) => r === 'DEVELOPER' || r === 'DESIGNER'), c.author.email ?? '');
  assert.ok(!withResolution.some((c) => c.authorId === f.customer.id));
});

// =================================================================================
// Reopen (§3.1 reverses L3b §2.5), and STEP_LOCKED
// =================================================================================

test('the customer reopens a DECLINED item — and a MOVED one — by commenting; the build pointer is dropped', async () => {
  const { phase, home, about } = await seedDemo();
  const target = (page: { id: string; demoId: string }) => ({ demoId: page.demoId, demoPageId: page.id });
  const declined = await submitOk('DEMO', target(home), 'Move the button', { phaseId: phase.id });
  ok(await answer(developer, declined.id, 'We are keeping it where it is', 'DECLINED'));
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: declined.id } })).status, 'DECLINED');

  const again = await submitOk('DEMO', target(home), 'I really need it moved', { phaseId: phase.id });
  assert.equal(again.id, declined.id, 'same target — same thread');
  assert.equal(again.status, 'OPEN', 'a DECLINED item reopens');

  const moved = await submitOk('DEMO', target(about), 'A whole new page', { phaseId: phase.id });
  await prisma.feedbackItem.update({ where: { id: moved.id }, data: { status: 'MOVED' } });
  assert.equal((await submitOk('DEMO', target(about), 'no, now', { phaseId: phase.id })).status, 'OPEN', 'a MOVED item reopens');

  const build = await prisma.build.create({ data: { phaseId: phase.id, projectId: f.contract.projectId, number: 1, declaredById: developer.id } });
  await prisma.feedbackItem.update({ where: { id: moved.id }, data: { status: 'ADDRESSED', addressedInBuildId: build.id } });
  await submitOk('DEMO', target(about), 'still wrong', { phaseId: phase.id });
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: moved.id } })).addressedInBuildId, null);
});

test('approval locks the step for everyone: the customer, and staff who answer, approve and decline, all get STEP_LOCKED (§3.1)', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'A thing', { phaseId: phase.id });
  ok(await answer(developer, item.id, 'Done', 'ADDRESSED'));
  const pending = await prisma.feedbackComment.create({ data: { feedbackItemId: item.id, authorId: designer.id, body: 'late', approval: 'PENDING' } });
  await prisma.feedbackComment.update({ where: { id: pending.id }, data: { approval: 'DECLINED', approvalNote: 'moot' } });

  ok(await exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: phase.id } }));

  const target = { demoId: home.demoId, demoPageId: home.id };
  assert.equal((await submit('DEMO', target, 'one more', { phaseId: phase.id })).code, 'STEP_LOCKED', 'no new feedback');
  assert.equal((await submit('DEMO', { general: true }, 'one more', { phaseId: phase.id })).code, 'STEP_LOCKED');
  assert.equal((await answer(developer, item.id, 'more words')).code, 'STEP_LOCKED', 'staff cannot answer on a locked step either');
  assert.equal((await answer(sales, item.id, 'more words')).code, 'STEP_LOCKED');
  const late = await prisma.feedbackComment.create({ data: { feedbackItemId: item.id, authorId: designer.id, body: 'x', approval: 'PENDING' } });
  assert.equal((await exec(APPROVE_ANSWER, { as: sales, variables: { c: late.id, b: null } })).code, 'STEP_LOCKED');
  assert.equal((await exec(DECLINE_ANSWER, { as: sales, variables: { c: late.id, r: 'r' } })).code, 'STEP_LOCKED');
  assert.equal((await exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: phase.id } })).code, 'STEP_LOCKED', 'approved once');
});

// =================================================================================
// approveStep: refusals, and what an approval writes
// =================================================================================

test('approveStep is refused while an item is open, then while an answer waits for sales — and only then accepts', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'Fix it', { phaseId: phase.id });
  const approve = () => exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: phase.id } });

  const open = await approve();
  assert.equal(open.code, 'STEP_HAS_OPEN_FEEDBACK');
  assert.equal(open.errors[0].message.includes('Root’s answer'), true);

  // A pending answer alone does not resolve the item — still open.
  ok(await answer(designer, item.id, 'Fixed', 'ADDRESSED'));
  assert.equal((await approve()).code, 'STEP_HAS_OPEN_FEEDBACK');

  // Resolved directly, but a stale pending answer still waits: blocks too.
  ok(await answer(developer, item.id, 'Fixed, for real', 'ADDRESSED'));
  assert.equal((await approve()).code, 'STEP_HAS_PENDING_ANSWERS');
  const pending = (await view(sales))[0].comments.find((c) => c.approval === 'PENDING')!;
  ok(await exec(DECLINE_ANSWER, { as: sales, variables: { c: pending.id, r: 'Superseded' } }));

  const approved = ok(await approve());
  const wizard = (approved.approveStep as { wizard: Array<{ step: string; phaseId: string | null; locked: boolean }> }).wizard;
  assert.equal(wizard.find((s) => s.step === 'DEMO' && s.phaseId === phase.id)!.locked, true, 'the wizard shows the lock');
  assert.equal(wizard.find((s) => s.step === 'DESIGN')!.locked, false, 'and only that step');
});

test('approving accepts everything at once: ADDRESSED becomes ACCEPTED, DECLINED and MOVED keep their status and gain acceptedAt/By', async () => {
  const { phase, home, about, line } = await seedDemo();
  const a = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'a', { phaseId: phase.id });
  const b = await submitOk('DEMO', { demoId: about.demoId, demoPageId: about.id }, 'b', { phaseId: phase.id });
  const c = await submitOk('DEMO', { demoId: home.demoId, frameLineId: line.id }, 'c', { phaseId: phase.id });
  ok(await answer(developer, a.id, 'done', 'ADDRESSED'));
  ok(await answer(developer, b.id, 'no', 'DECLINED'));
  await prisma.feedbackItem.update({ where: { id: c.id }, data: { status: 'MOVED' } });

  ok(await exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: phase.id } }));

  const rows = await prisma.feedbackItem.findMany({ where: { id: { in: [a.id, b.id, c.id] } }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => r.status), ['ACCEPTED', 'DECLINED', 'MOVED']);
  for (const r of rows) {
    assert.ok(r.acceptedAt, r.id);
    assert.equal(r.acceptedById, f.customer.id, 'the customer’s act — through the customer’s own mutation');
  }
  const approval = await prisma.stepApproval.findFirstOrThrow({ where: { contractId: f.contract.id } });
  assert.equal(approval.step, 'DEMO');
  assert.equal(approval.phaseId, phase.id);
  assert.equal(approval.approvedById, f.customer.id);
});

test('approveStep: only the contract’s customer, only the steps that are approved this way, only a step on the road', async () => {
  const { phase } = await seedDemo();
  const go = (as: User, s: StepKind, p: string | null = null) => exec(APPROVE_STEP, { as, variables: { c: f.contract.id, s, p } });

  // Root does not approve for the customer, and a stranger cannot even see the contract.
  assert.equal((await go(f.admin, 'DEMO', phase.id)).code, 'NOT_FOUND');
  assert.equal((await go(sales, 'DEMO', phase.id)).code, 'NOT_FOUND');
  assert.equal((await go(f.stranger, 'DEMO', phase.id)).code, 'NOT_FOUND');

  // The agreement is J7's gate; the steps it seals are approved with it.
  for (const step of ['AGREEMENT', 'REQUIREMENTS', 'SCOPE', 'DRAFT', 'SUMMARY'] as const) {
    assert.equal((await go(f.customer, step)).code, 'STEP_NOT_APPROVABLE', step);
  }
  assert.equal((await prisma.stepApproval.count()), 0, 'nothing was written by a refusal');

  // A demo needs its phase — the placeholder demo (no phase) can never take an approval.
  assert.equal((await go(f.customer, 'DEMO', null)).code, 'STEP_NOT_ON_ROAD');
  assert.equal((await go(f.customer, 'DEMO', 'not-a-phase')).code, 'STEP_NOT_ON_ROAD');
  assert.equal((await go(f.customer, 'DESIGN', phase.id)).code, 'INVALID_TARGET', 'only a demo has a phase');

  // The legacy road approves through its own gate.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await go(f.customer, 'DEMO', phase.id)).code, 'STEP_NOT_APPROVABLE');
});

test('approving DESIGN accepts and locks design feedback and no other step’s', async () => {
  const design = await submitOk('DESIGN', { designRevisionId: f.designRevision.id }, 'The palette feels cold');
  const requirements = await submitOk('REQUIREMENTS', { general: true }, 'One more thing');
  ok(await answer(sales, design.id, 'Warmer palette coming', 'ADDRESSED'));

  ok(await exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DESIGN', p: null } }));
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: design.id } })).status, 'ACCEPTED');
  const untouched = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: requirements.id } });
  assert.equal(untouched.status, 'OPEN');
  assert.equal(untouched.acceptedAt, null, 'one step’s approval never accepts another step’s items');
  assert.equal((await submit('DESIGN', { general: true }, 'late')).code, 'STEP_LOCKED');
  assert.equal((await submit('REQUIREMENTS', { general: true }, 'still open')).code, undefined, 'requirements is unaffected');
});

// =================================================================================
// submitFeedback: targets, collapse, interception on every step
// =================================================================================

test('every step takes its own anchor through the API; a malformed or foreign target is refused with a code', async () => {
  const { phase, demo, home, scopeItem } = await seedDemo();
  const ok1 = async (step: StepKind, target: Record<string, unknown>, extra: { phaseId?: string } = {}) =>
    assert.ok((await submitOk(step, target, 'note', extra)).id, `${step} ${JSON.stringify(target)}`);

  await ok1('REQUIREMENTS', { briefField: 'domain' });
  await ok1('SCOPE', { scopeItemId: scopeItem.id });
  await ok1('DRAFT', { contractRevisionId: f.contractRevision.id });
  await ok1('DRAFT', { contractRevisionId: f.contractRevision.id, articleNumber: 2 });
  await ok1('DESIGN', { designRevisionId: f.designRevision.id });
  const concept = await prisma.designConcept.findFirstOrThrow({ where: { designRevisionId: f.designRevision.id } });
  const page = await prisma.pageDesign.findFirstOrThrow({ where: { conceptId: concept.id } });
  await ok1('DESIGN', { designRevisionId: f.designRevision.id, conceptId: concept.id });
  await ok1('DESIGN', { designRevisionId: f.designRevision.id, pageDesignId: page.id });
  await ok1('DEMO', { demoId: demo.id, demoPageId: home.id }, { phaseId: phase.id });
  await ok1('DEMO', { general: true }, { phaseId: phase.id });
  await ok1('MOCKUP', { demoId: demo.id, demoPageId: home.id });

  const refused: Array<[string, StepKind, Record<string, unknown>, string | undefined, string]> = [
    ['a demo item with a brief field', 'DEMO', { demoId: demo.id, demoPageId: home.id, briefField: 'budgetCap' }, phase.id, 'INVALID_TARGET'],
    ['no anchor at all', 'REQUIREMENTS', {}, undefined, 'INVALID_TARGET'],
    ['field and general', 'REQUIREMENTS', { briefField: 'x', general: true }, undefined, 'INVALID_TARGET'],
    ['two design parts', 'DESIGN', { designRevisionId: f.designRevision.id, conceptId: concept.id, pageDesignId: page.id }, undefined, 'INVALID_TARGET'],
    ['an article number 0', 'DRAFT', { contractRevisionId: f.contractRevision.id, articleNumber: 0 }, undefined, 'INVALID_TARGET'],
    ['the agreement takes no feedback', 'AGREEMENT', { general: true }, undefined, 'INVALID_TARGET'],
    ['the summary takes no feedback', 'SUMMARY', { general: true }, undefined, 'INVALID_TARGET'],
    ['a phase on a step without one', 'SCOPE', { general: true }, phase.id, 'INVALID_TARGET'],
    ['a demo with no phase named', 'DEMO', { general: true }, undefined, 'INVALID_TARGET'],
    ['another phase than the demo’s', 'DEMO', { demoId: demo.id, demoPageId: home.id }, 'other-phase', 'INVALID_TARGET'],
    ['a scope item that is not this project’s', 'SCOPE', { scopeItemId: 'nope' }, undefined, 'NOT_FOUND'],
    ['a revision that is not this contract’s', 'DRAFT', { contractRevisionId: 'nope' }, undefined, 'NOT_FOUND'],
    ['a concept of another revision', 'DESIGN', { designRevisionId: f.designRevision.id, conceptId: 'nope' }, undefined, 'NOT_FOUND'],
    ['a page of another demo', 'DEMO', { demoId: demo.id, demoPageId: 'nope' }, phase.id, 'NOT_FOUND'],
  ];
  for (const [why, step, target, phaseId, code] of refused) {
    assert.equal((await submit(step, target, 'note', { phaseId })).code, code, why);
  }
  assert.equal((await submit('REQUIREMENTS', { general: true }, '   ')).code, 'EMPTY_COMMENT');

  // The legacy road has no requirements, scope or draft.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await submit('REQUIREMENTS', { general: true }, 'x')).code, 'STEP_NOT_ON_ROAD');
  assert.equal((await submit('DESIGN', { general: true }, 'x')).code, undefined, 'design is on it');

  // A draft demo takes no feedback.
  await prisma.demo.update({ where: { id: demo.id }, data: { publishedAt: null } });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'AGREEMENT_FIRST' } });
  assert.equal((await submit('DEMO', { demoId: demo.id, demoPageId: home.id }, 'x', { phaseId: phase.id })).code, 'DEMO_NOT_PUBLISHED');
});

test('general comments on one step collapse into one thread (and say so in the UI); two contracts, two threads', async () => {
  const first = await submitOk('REQUIREMENTS', { general: true }, 'first thought');
  const second = await submitOk('REQUIREMENTS', { general: true }, 'second thought');
  assert.equal(second.id, first.id);
  assert.equal((await prisma.feedbackComment.count({ where: { feedbackItemId: first.id } })), 2);
  const scope = await submitOk('SCOPE', { general: true }, 'different step');
  assert.notEqual(scope.id, first.id);

  // The per-anchor items collapse too: the brief field, once per contract.
  const field = await submitOk('REQUIREMENTS', { briefField: 'budgetCap' }, 'too high');
  assert.equal((await submitOk('REQUIREMENTS', { briefField: 'budgetCap' }, 'still too high')).id, field.id);
  assert.notEqual(field.id, first.id);
});

test('interception generalizes to every step whose anchor names a scope item — a SCOPE anchor as much as a frame line', async () => {
  const { scopeItem: decided, phase, demo, line } = await seedDemo({ decided: true });

  const scopeTry = ok(await submit('SCOPE', { scopeItemId: decided.id }, 'Why is this settled?')).submitFeedback as Submitted;
  assert.equal(scopeTry.item, null, 'nothing written until the customer confirms');
  assert.equal(scopeTry.intercepted, true);
  assert.equal(scopeTry.interceptionReason, 'DECIDED');
  assert.equal(await prisma.feedbackItem.count(), 0);

  const confirmed = ok(await submit('SCOPE', { scopeItemId: decided.id }, 'I want to reopen it', { confirm: true })).submitFeedback as Submitted;
  assert.ok(confirmed.item);
  const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: confirmed.item!.id } });
  assert.equal(row.reopenedScopeItemId, decided.id);
  assert.equal(row.anchorScopeItemId, decided.id, 'the anchor and the interception record are two different columns');

  // The demo's frame line still does, unchanged.
  const lineTry = ok(await submit('DEMO', { demoId: demo.id, frameLineId: line.id }, 'and this?', { phaseId: phase.id })).submitFeedback as Submitted;
  assert.equal(lineTry.intercepted, true);
  assert.equal(lineTry.item, null);

  // A temporary item intercepts too; an ordinary one does not.
  const temp = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'stub', kind: 'FEATURE', labelFa: 'موقت', labelEn: 'Stub', status: 'IN_DEMO', temporary: true },
  });
  assert.equal(((ok(await submit('SCOPE', { scopeItemId: temp.id })).submitFeedback) as Submitted).interceptionReason, 'TEMPORARY');
  const plain = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'plain', kind: 'FEATURE', labelFa: 'ساده', labelEn: 'Plain', status: 'IN_DEMO' },
  });
  assert.equal(((ok(await submit('SCOPE', { scopeItemId: plain.id })).submitFeedback) as Submitted).intercepted, false);
});

test('the same demo page through the second contract of a project is not a thread of its own', async () => {
  const { phase, demo, home } = await seedDemo();
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId: f.contract.projectId,
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date(),
    },
  });
  // Phases, demos and builds are the project's first contract's until J4.
  const refused = await submit('DEMO', { demoId: demo.id, demoPageId: home.id }, 'x', { phaseId: phase.id, contractId: second.id });
  assert.equal(refused.code, 'STEP_NOT_ON_ROAD');
  // Its own steps work.
  assert.ok((await submitOk('REQUIREMENTS', { general: true }, 'ours', { contractId: second.id })).id);
});

// =================================================================================
// Queues, money, visibility
// =================================================================================

test('pendingAnswers is sales’ queue: oldest first, thin, and nobody else’s', async () => {
  const one = await makeItem('DESIGN');
  const two = await makeItem('REQUIREMENTS');
  ok(await answer(developer, one.id, 'developer on design', null));
  ok(await answer(designer, two.id, 'designer on requirements', 'ADDRESSED'));
  ok(await answer(designer, one.id, 'designer, direct — not queued', null));

  const Q = 'query { pendingAnswers { id contractRef step phaseNumber comment { body approval author { name } } item { id status } } }';
  const rows = ok(await exec(Q, { as: sales })).pendingAnswers as Array<{ contractRef: string; step: string; comment: { body: string; author: { name: string } }; item: { status: string } }>;
  assert.deepEqual(rows.map((r) => [r.step, r.comment.body, r.comment.author.name]), [
    ['DESIGN', 'developer on design', 'developer'],
    ['REQUIREMENTS', 'designer on requirements', 'designer'],
  ]);
  assert.equal(rows[0].contractRef, 'RC-TEST-001');
  assert.equal(rows[0].item.status, 'OPEN');
  assert.equal(ok(await exec(Q, { as: f.admin })).pendingAnswers instanceof Array, true);
  for (const who of [designer, developer, f.customer]) assert.equal((await exec(Q, { as: who })).code, 'FORBIDDEN');
});

test('myFeedbackQueue: what is mine by assignment and route first, then the rest with the route each would take', async () => {
  const { phase } = await seedDemo();
  await makeItem('DESIGN');
  await makeItem('DEMO', phase.id);
  await makeItem('REQUIREMENTS');
  const Q = 'query { myFeedbackQueue { route mine item { step } } }';
  type Row = { route: string; mine: boolean; item: { step: string } };
  const rowsOf = async (as: User) => (ok(await exec(Q, { as })).myFeedbackQueue as Row[]).map((r) => `${r.item.step}:${r.route}:${r.mine}`);

  assert.deepEqual(await rowsOf(designer), ['DESIGN:DIRECT:true', 'DEMO:NEEDS_APPROVAL:false', 'REQUIREMENTS:NEEDS_APPROVAL:false']);
  assert.deepEqual(await rowsOf(developer), ['DEMO:DIRECT:true', 'DESIGN:NEEDS_APPROVAL:false', 'REQUIREMENTS:NEEDS_APPROVAL:false']);
  // A designer who is not this contract's: direct in the design step, but not theirs.
  assert.deepEqual(await rowsOf(designer2), ['DESIGN:DIRECT:false', 'DEMO:NEEDS_APPROVAL:false', 'REQUIREMENTS:NEEDS_APPROVAL:false'].sort(
    (a, b) => Number(b.endsWith('true')) - Number(a.endsWith('true')),
  ));
  // Sales: the agreement’s steps are its own; design and demo are somebody’s.
  const salesRows = await rowsOf(sales);
  assert.equal(salesRows[0], 'REQUIREMENTS:DIRECT:true');
  assert.ok(salesRows.includes('DESIGN:DIRECT:false') && salesRows.includes('DEMO:DIRECT:false'));
  assert.equal((await exec(Q, { as: f.customer })).code, 'FORBIDDEN');
});

test('feedback about money is for money readers: hidden from the designer’s queue, list and answers (PD-21); the customer and sales see it', async () => {
  const money = await submitOk('REQUIREMENTS', { briefField: 'budgetCap' }, 'The budget is too high');
  await submitOk('REQUIREMENTS', { briefField: 'domain' }, 'Use a .ir domain');

  const bodies = async (as: User) => (await view(as)).map((i) => i.comments[0].body).sort();
  assert.deepEqual(await bodies(f.customer), ['The budget is too high', 'Use a .ir domain']);
  assert.deepEqual(await bodies(sales), ['The budget is too high', 'Use a .ir domain']);
  assert.deepEqual(await bodies(designer), ['Use a .ir domain']);
  assert.deepEqual(await bodies(developer), ['Use a .ir domain']);

  // Answerable only by sales — the designer is told there is no such thing.
  assert.equal((await answer(designer, money.id, 'x')).code, 'NOT_FOUND');
  assert.ok(!(ok(await exec('query { myFeedbackQueue { item { id } } }', { as: designer })).myFeedbackQueue as Array<{ item: { id: string } }>).some((r) => r.item.id === money.id));
  ok(await answer(sales, money.id, 'Noted — let us talk', 'ADDRESSED'));

  // Nor does it appear in a designer’s attention, or under sales-as-customer: the customer's own is theirs.
  const attention = async (as: User) =>
    (ok(await exec('query($c: ID!){ contract(id: $c) { attention { kind params { key value } } } }', { as, variables: { c: f.contract.id } })).contract as { attention: Array<{ kind: string; params: Array<{ key: string; value: string }> }> }).attention;
  const count = (rows: Awaited<ReturnType<typeof attention>>, kind: string) =>
    rows.filter((r) => r.kind === kind).reduce((n, r) => n + Number(r.params.find((p) => p.key === 'count')!.value), 0);
  assert.equal(count(await attention(designer), 'FEEDBACK_UNRESOLVED'), 1);
  assert.equal(count(await attention(sales), 'FEEDBACK_UNRESOLVED'), 1, 'the money item is now answered; one open item remains');
  assert.equal(count(await attention(sales), 'ANSWER_PUBLISHED'), 1);
  assert.equal(count(await attention(designer), 'ANSWER_PUBLISHED'), 0);
});

// =================================================================================
// Attention: from real data
// =================================================================================

test('attention: Root owes an answer, an answer waits for sales (staff only), an answer reached the customer', async () => {
  const { phase, home, about } = await seedDemo();
  const a = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'a', { phaseId: phase.id });
  await submitOk('DEMO', { demoId: about.demoId, demoPageId: about.id }, 'b', { phaseId: phase.id });
  const req = await submitOk('REQUIREMENTS', { general: true }, 'r');
  const read = async (as: User, asCustomer = false) =>
    (ok(await exec('query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { attention { kind waitingOn phaseId role params { key value } } } }', { as, variables: { c: f.contract.id, as: asCustomer } })).contract as { attention: Array<{ kind: string; waitingOn: string; phaseId: string | null; role: string | null; params: Array<{ key: string; value: string }> }> }).attention;
  const digest = (rows: Awaited<ReturnType<typeof read>>) =>
    rows.map((r) => `${r.kind}/${r.waitingOn}/${r.role ?? '-'}/${r.params.map((p) => `${p.key}=${p.value}`).join(',')}`).sort();

  assert.deepEqual(digest(await read(f.customer)), [
    'FEEDBACK_UNRESOLVED/ROOT/DEVELOPER/count=2,step=DEMO',
    'FEEDBACK_UNRESOLVED/ROOT/SALES/count=1,step=REQUIREMENTS',
  ]);

  ok(await answer(designer, a.id, 'fixed', 'ADDRESSED')); // pending
  ok(await answer(developer, req.id, 'noted', null)); // pending too — a developer outside their step
  const staffView = digest(await read(sales));
  assert.ok(staffView.includes('ANSWER_PENDING_APPROVAL/ROOT/SALES/count=1,step=DEMO'));
  assert.ok(staffView.includes('ANSWER_PENDING_APPROVAL/ROOT/SALES/count=1,step=REQUIREMENTS'));
  for (const view of [digest(await read(f.customer)), digest(await read(sales, true))]) {
    assert.ok(!view.some((row) => row.startsWith('ANSWER_PENDING_APPROVAL')), 'the customer — and sales as the customer — never see the queue');
  }

  ok(await answer(developer, a.id, 'fixed for real', 'ADDRESSED')); // direct
  const answered = digest(await read(f.customer));
  assert.ok(answered.includes('ANSWER_PUBLISHED/CUSTOMER/-/count=1,step=DEMO'));
  assert.ok(answered.includes('FEEDBACK_UNRESOLVED/ROOT/DEVELOPER/count=1,step=DEMO'));
});

// =================================================================================
// Notifications
// =================================================================================

test('notifications: customer feedback goes to the step’s owner, nobody assigned falls to the role, answers to the approvers, the customer once, the author on decline', async () => {
  const { phase, home } = await seedDemo();
  const to = (kind: string) => mails(kind).map((m) => m.to).sort();
  const NEW = 'New feedback';

  // DESIGN → the assigned designer, not the other one, not sales.
  await submitOk('DESIGN', { general: true }, 'design thought');
  assert.deepEqual(to(NEW), ['designer@test.local']);

  // DEMO → the assigned developer.
  mail.length = 0;
  await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'demo thought', { phaseId: phase.id });
  assert.deepEqual(to(NEW), ['developer@test.local']);

  // REQUIREMENTS / SCOPE / DRAFT → every holder of contracts.author (sales, the admin).
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT'] as const) {
    mail.length = 0;
    await submitOk(step, { general: true }, `${step} thought`);
    assert.deepEqual(to(NEW), ['admin@test.local', 'sales@test.local'], step);
  }

  // Nobody assigned → everyone holding the step's answers.direct.*.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: null } });
  mail.length = 0;
  await submitOk('MOCKUP', { general: true }, 'mockup thought');
  assert.deepEqual(to(NEW), ['admin@test.local', 'designer2@test.local', 'designer@test.local', 'sales@test.local']);
  // An assigned-but-disabled designer is "nobody" too.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: designer.id } });
  await prisma.user.update({ where: { id: designer.id }, data: { state: 'DISABLED' } });
  mail.length = 0;
  await submitOk('DESIGN', { general: true }, 'again');
  assert.ok(!to(NEW).includes('designer@test.local'));
  assert.ok(to(NEW).includes('designer2@test.local'));
  await prisma.user.update({ where: { id: designer.id }, data: { state: 'ACTIVE' } });

  // A pending answer → the approvers (not its author).
  const item = await makeItem('SCOPE', null, { general: false, anchorScopeItemId: (await prisma.scopeItem.findFirstOrThrow({ where: { projectId: f.contract.projectId } })).id });
  mail.length = 0;
  ok(await answer(designer, item.id, 'my answer', 'ADDRESSED'));
  assert.deepEqual(to('waiting for your approval'), ['admin@test.local', 'sales@test.local']);
  assert.equal(mails('Root answered').length, 0, 'the customer is told nothing yet');

  // Approving it tells the customer — once.
  const pending = (await view(sales, { step: 'SCOPE' }))[0].comments.find((c) => c.approval === 'PENDING')!;
  mail.length = 0;
  ok(await exec(APPROVE_ANSWER, { as: sales, variables: { c: pending.id, b: null } }));
  assert.deepEqual(to('Root answered'), ['customer@test.local']);

  // A direct answer tells the customer once per mutation, and not the approvers.
  mail.length = 0;
  ok(await answer(sales, item.id, 'and a direct word', null));
  assert.deepEqual(to('Root answered'), ['customer@test.local']);
  assert.equal(mails('waiting for your approval').length, 0);

  // A decline goes to its author, with the reason; the customer hears nothing.
  const other = await makeItem('DRAFT', null, { general: false, contractRevisionId: f.contractRevision.id });
  ok(await answer(developer, other.id, 'a stray answer', 'ADDRESSED'));
  const stray = (await view(sales, { step: 'DRAFT' }))[0].comments.find((c) => c.approval === 'PENDING')!;
  mail.length = 0;
  ok(await exec(DECLINE_ANSWER, { as: sales, variables: { c: stray.id, r: 'Not a developer question' } }));
  assert.deepEqual(to('sent back'), ['developer@test.local']);
  assert.match(mails('sent back')[0].text, /Not a developer question/);
  assert.equal(mails('Root answered').length, 0);
});

test('feedback about money notifies only those who may read it', async () => {
  await submitOk('REQUIREMENTS', { briefField: 'budgetCap' }, 'too high');
  assert.deepEqual(mails('New feedback').map((m) => m.to).sort(), ['admin@test.local', 'sales@test.local']);
  // (contracts.author holders are exactly the money readers today; the filter is for the day they are not.)
  mail.length = 0;
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: null } });
  await prisma.feedbackItem.updateMany({ data: { briefField: null, general: true } });
  await submitOk('DESIGN', { general: true }, 'x');
  assert.ok(mails('New feedback').some((m) => m.to === 'designer@test.local'), 'a design comment is the designers’');
});

// =================================================================================
// The build queue must not drain other steps (S2 trap 2)
// =================================================================================

test('the build queue is the demo step’s, on the phase: another step’s open items are neither in it nor dispositioned by a build', async () => {
  const { phase, home } = await seedDemo();
  const demoItem = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'demo note', { phaseId: phase.id });
  const requirements = await submitOk('REQUIREMENTS', { general: true }, 'a note on the brief');
  const design = await submitOk('DESIGN', { general: true }, 'a note on the design');
  const otherPhase = await prisma.phase.create({ data: { projectId: f.contract.projectId, number: 2, titleFa: 'فاز ۲', titleEn: 'Phase 2' } });
  const otherDemo = await prisma.demo.create({ data: { phaseId: otherPhase.id, stagingUrl: 'https://two.example.com', publishedAt: new Date() } });
  const otherPage = await prisma.demoPage.create({ data: { demoId: otherDemo.id, key: 'p2', labelFa: 'ب', labelEn: 'p2', canonicalPath: '/p2' } });
  const phase2Item = await submitOk('DEMO', { demoId: otherDemo.id, demoPageId: otherPage.id }, 'phase two note', { phaseId: otherPhase.id });

  const queue = async (phaseId: string | null) =>
    (ok(await exec('query($p: ID!, $ph: ID){ openFeedbackQueue(projectId: $p, phaseId: $ph) { id step } }', { as: developer, variables: { p: f.contract.projectId, ph: phaseId } })).openFeedbackQueue as Array<{ id: string; step: string }>);
  assert.deepEqual((await queue(null)).map((i) => i.id).sort(), [demoItem.id, phase2Item.id].sort(), 'the project’s demo items, nothing else');
  assert.deepEqual((await queue(phase.id)).map((i) => i.id), [demoItem.id]);
  assert.ok((await queue(null)).every((i) => i.step === 'DEMO'));

  // A build on phase 1 owes a disposition for phase 1’s demo item only.
  const DECLARE = 'mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id } }';
  assert.equal((await exec(DECLARE, { as: developer, variables: { p: phase.id, c: [] } })).code, 'MISSING_DISPOSITION');
  ok(await exec(DECLARE, { as: developer, variables: { p: phase.id, c: [{ feedbackItemId: demoItem.id, outcome: 'ADDRESSED', note: 'ok', noteLang: 'en' }] } }));
  // …and cannot name another step’s item at all — it is not "an open item on this project" of the queue.
  assert.equal(
    (await exec(DECLARE, { as: developer, variables: { p: otherPhase.id, c: [{ feedbackItemId: phase2Item.id, outcome: 'CARRIED_FORWARD' }, { feedbackItemId: requirements.id, outcome: 'ADDRESSED', note: 'x', noteLang: 'en' }] } })).code,
    'NOT_FOUND',
  );
  for (const id of [requirements.id, design.id]) {
    const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id } });
    assert.equal(row.status, 'OPEN', 'another step’s feedback is never drained by a build');
    assert.equal(await prisma.feedbackComment.count({ where: { feedbackItemId: id, authorId: developer.id } }), 0);
  }
  // Carrying forward is not resolving: the item stays open and still blocks the step.
  ok(await exec(DECLARE, { as: developer, variables: { p: otherPhase.id, c: [{ feedbackItemId: phase2Item.id, outcome: 'CARRIED_FORWARD' }] } }));
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: phase2Item.id } })).status, 'OPEN');
  assert.equal((await exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: otherPhase.id } })).code, 'STEP_HAS_OPEN_FEEDBACK');
});

test('a build’s dispositions also serve the ledger: reopened and addressed again in build N+2, every hop is kept', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'wrong', { phaseId: phase.id });
  const DECLARE = 'mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id number } }';
  ok(await exec(DECLARE, { as: developer, variables: { p: phase.id, c: [{ feedbackItemId: item.id, outcome: 'ADDRESSED', note: 'v1', noteLang: 'en' }] } }));
  await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'still wrong', { phaseId: phase.id });
  ok(await exec(DECLARE, { as: developer, variables: { p: phase.id, c: [{ feedbackItemId: item.id, outcome: 'ADDRESSED', note: 'v2', noteLang: 'en' }] } }));
  const entries = await prisma.buildChangeEntry.findMany({ where: { feedbackItemId: item.id }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(entries.map((e) => e.note), ['v1', 'v2']);
  const row = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(row.status, 'ADDRESSED');
  assert.ok(row.addressedInBuildId);
});

test('text: every feedbackItem read in builds.ts names the demo step (or the one helper that does), and tickets.ts reads none', () => {
  const dir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const builds = readFileSync(join(dir, 'builds.ts'), 'utf8');
  const reads = [...builds.matchAll(/feedbackItem\.(findMany|count|findFirst|updateMany|deleteMany|groupBy|aggregate)\(/g)];
  assert.ok(reads.length >= 2, 'the scan found the queue’s two reads');
  for (const m of reads) {
    const window = builds.slice(m.index!, m.index! + 260);
    assert.match(window, /step:|openDemoItems\(/, `builds.ts: ${m[0]} ... has no step in its where`);
  }
  assert.match(builds, /step: 'DEMO'/);
  const tickets = readFileSync(join(dir, 'tickets.ts'), 'utf8');
  assert.equal([...tickets.matchAll(/feedbackItem\.(findMany|count|updateMany|deleteMany|groupBy|aggregate)\(/g)].length, 0);
});

// =================================================================================
// The single writer of acceptedAt (S2 trap 1)
// =================================================================================

/** The text of every `{ … }` that follows one of the given keys — `data: {`,
 *  `create: {` … — with braces matched. */
function objectsAfterKeys(source: string, keys: string[]): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`\\b(?:${keys.join('|')})\\s*:\\s*\\{`, 'g');
  for (const m of source.matchAll(pattern)) {
    let depth = 0;
    for (let i = m.index! + m[0].length - 1; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}' && --depth === 0) {
        out.push(source.slice(m.index!, i + 1));
        break;
      }
    }
  }
  return out;
}

function writesAcceptance(source: string): boolean {
  // Comments out: a doc comment that says "data: { acceptedAt … }" is not a write.
  // (`//` only counts at a line start or after whitespace, so `https://…` survives.)
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
  return (
    objectsAfterKeys(stripped, ['data', 'create', 'update', 'set']).some((o) => /\baccepted(At|ById)\b/.test(o)) ||
    /UPDATE\s+"FeedbackItem"[^;]*accepted(At|ById)/i.test(stripped) ||
    /"accepted(At|ById)"\s*=/.test(stripped)
  );
}

test('acceptedAt is written in lib/stepApproval.ts alone: no other resolver, lib or script file writes it', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)); // apps/api/src
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !dir.endsWith(`${join('src', 'test')}`)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  walk(fileURLToPath(new URL('../../prisma/', import.meta.url)));

  // The detector is alive: it sees the one legitimate writer, and a synthetic one.
  const writer = files.find((f2) => f2.endsWith(join('lib', 'stepApproval.ts')))!;
  assert.ok(writesAcceptance(readFileSync(writer, 'utf8')), 'stepApproval.ts must be seen writing acceptedAt');
  assert.ok(writesAcceptance('await tx.feedbackItem.update({ where, data: { status: "X", acceptedAt: new Date() } })'));
  assert.ok(writesAcceptance('prisma.feedbackItem.create({ data: { acceptedById: user.id } })'));
  assert.ok(!writesAcceptance('prisma.feedbackItem.findMany({ where: { acceptedAt: null } }) // data: { acceptedAt: 1 }'));

  assert.ok(files.length > 40, `the scan read ${files.length} files`);
  const offenders = files.filter((file) => file !== writer && writesAcceptance(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], 'a second writer of acceptedAt is a second path with different preconditions');
});

test('acceptFeedback and ratifyFeedback are gone from the schema and the resolvers, and RATIFIED from the status', () => {
  const typeDefs = readFileSync(fileURLToPath(new URL('../graphql/typeDefs.ts', import.meta.url)), 'utf8');
  const prismaSchema = readFileSync(fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)), 'utf8');
  for (const gone of ['ratifyFeedback', 'acceptFeedback']) {
    assert.ok(!new RegExp(`\\b${gone}\\s*\\(`).test(typeDefs), `${gone} is still in the SDL`);
  }
  const values = (source: string) =>
    source
      .match(/enum FeedbackStatus\s*\{([^}]*)\}/)![1]
      .split('\n')
      .map((l) => l.replace(/(\/\/|#|").*$/, '').replace(/"[^"]*"/g, '').trim())
      .filter((l) => /^[A-Z_]+$/.test(l));
  assert.deepEqual(values(prismaSchema), ['OPEN', 'ADDRESSED', 'DECLINED', 'MOVED', 'ACCEPTED']);
  assert.deepEqual(values(typeDefs), ['OPEN', 'ADDRESSED', 'DECLINED', 'MOVED', 'ACCEPTED']);
  const resolversDir = fileURLToPath(new URL('../graphql/resolvers/', import.meta.url));
  const feedback = readFileSync(join(resolversDir, 'feedback.ts'), 'utf8');
  assert.ok(!/^\s+(ratifyFeedback|acceptFeedback):/m.test(feedback));
});

// =================================================================================
// The database: every hand-written CHECK and partial index, by direct insert
// =================================================================================

test('FeedbackItem_anchor_matches_step: every row of the anchor table, inserted into Postgres, agrees with anchorMatchesStep', async () => {
  const { phase, demo, home, line, scopeItem } = await seedDemo();
  const concept = await prisma.designConcept.findFirstOrThrow({ where: { designRevisionId: f.designRevision.id } });
  const page = await prisma.pageDesign.findFirstOrThrow({ where: { conceptId: concept.id } });
  const real: Partial<Record<keyof FeedbackAnchor, string>> = {
    anchorScopeItemId: scopeItem.id,
    contractRevisionId: f.contractRevision.id,
    designRevisionId: f.designRevision.id,
    conceptId: concept.id,
    pageDesignId: page.id,
    demoId: demo.id,
    demoPageId: home.id,
    frameLineId: line.id,
  };

  class Rollback extends Error {}
  for (const [step, anchor, legal, why] of ANCHOR_TABLE) {
    const columns: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(anchor)) {
      columns[key] = typeof value === 'string' && key in real ? real[key as keyof FeedbackAnchor] : value;
    }
    // The table names placeholders; anything that is not a real foreign key
    // (a brief field, a palette item, an article number) is used as it is.
    let outcome: 'inserted' | 'check' | string;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.feedbackItem.create({
          data: { projectId: f.contract.projectId, contractId: f.contract.id, step, phaseId: step === 'DEMO' ? phase.id : null, ...columns },
        });
        throw new Rollback();
      });
      outcome = 'inserted';
    } catch (err) {
      const message = (err as Error).message;
      outcome = err instanceof Rollback ? 'inserted' : message.includes('FeedbackItem_anchor_matches_step') ? 'check' : message;
    }
    assert.ok(outcome === 'inserted' || outcome === 'check', `${step} ${why}: unexpected ${outcome}`);
    assert.equal(outcome === 'inserted', legal, `${step}: ${why} — the database says ${outcome}`);
    assert.equal(anchorMatchesStep(step, anchor), legal, `${step}: ${why} — the twin disagrees with the table`);
  }
});

test('the duplicate-collapse indexes, by insert: both general ones, the whole-revision ones, and each plain anchor unique', async () => {
  const { phase, home, scopeItem } = await seedDemo();
  const phase2 = await prisma.phase.create({ data: { projectId: f.contract.projectId, number: 2, titleFa: 'ب', titleEn: 'Phase 2' } });
  const concept = await prisma.designConcept.findFirstOrThrow({ where: { designRevisionId: f.designRevision.id } });
  const page = await prisma.pageDesign.findFirstOrThrow({ where: { conceptId: concept.id } });
  const base = { projectId: f.contract.projectId, contractId: f.contract.id };
  const make = (data: Record<string, unknown>) => prisma.feedbackItem.create({ data: { ...base, ...data } as never });
  const refuses = async (data: Record<string, unknown>, name: string) => {
    await assert.rejects(
      () => make(data),
      (err: unknown) => (err as { code?: string }).code === 'P2002',
      `${name} should refuse a second ${JSON.stringify(data)}`,
    );
  };

  // A `general` item collapses per step — with no phase, the partial index
  // FeedbackItem_one_general_per_step; a plain unique would let two NULLs by.
  await make({ step: 'REQUIREMENTS', general: true });
  await refuses({ step: 'REQUIREMENTS', general: true }, 'FeedbackItem_one_general_per_step');
  await make({ step: 'SCOPE', general: true }); // another step: fine
  // …and per step *and phase* for the demo.
  await make({ step: 'DEMO', general: true, phaseId: phase.id });
  await refuses({ step: 'DEMO', general: true, phaseId: phase.id }, 'FeedbackItem_one_general_per_step_phase');
  await make({ step: 'DEMO', general: true, phaseId: phase2.id }); // another phase: fine
  // A non-general item is not caught by either.
  await make({ step: 'REQUIREMENTS', briefField: 'domain' });
  await make({ step: 'REQUIREMENTS', briefField: 'hosting' });
  await refuses({ step: 'REQUIREMENTS', briefField: 'domain' }, 'FeedbackItem_contractId_briefField_key');

  await make({ step: 'SCOPE', anchorScopeItemId: scopeItem.id });
  await refuses({ step: 'SCOPE', anchorScopeItemId: scopeItem.id }, 'FeedbackItem_contractId_anchorScopeItemId_key');

  // DRAFT: a revision, an article of it — each once. The whole-revision one is a partial index.
  await make({ step: 'DRAFT', contractRevisionId: f.contractRevision.id });
  await refuses({ step: 'DRAFT', contractRevisionId: f.contractRevision.id }, 'FeedbackItem_one_per_revision');
  await make({ step: 'DRAFT', contractRevisionId: f.contractRevision.id, articleNumber: 1 });
  await make({ step: 'DRAFT', contractRevisionId: f.contractRevision.id, articleNumber: 2 });
  await refuses({ step: 'DRAFT', contractRevisionId: f.contractRevision.id, articleNumber: 2 }, 'FeedbackItem_contractRevisionId_articleNumber_key');

  // DESIGN: the revision as a whole (partial), each concept, page and palette item once.
  await make({ step: 'DESIGN', designRevisionId: f.designRevision.id });
  await refuses({ step: 'DESIGN', designRevisionId: f.designRevision.id }, 'FeedbackItem_one_per_design_revision');
  await make({ step: 'DESIGN', designRevisionId: f.designRevision.id, conceptId: concept.id });
  await refuses({ step: 'DESIGN', designRevisionId: f.designRevision.id, conceptId: concept.id }, 'FeedbackItem_conceptId_key');
  await make({ step: 'DESIGN', designRevisionId: f.designRevision.id, pageDesignId: page.id });
  await refuses({ step: 'DESIGN', designRevisionId: f.designRevision.id, pageDesignId: page.id }, 'FeedbackItem_pageDesignId_key');
  await make({ step: 'DESIGN', designRevisionId: f.designRevision.id, paletteItemId: 'swatch-1' });
  await refuses({ step: 'DESIGN', designRevisionId: f.designRevision.id, paletteItemId: 'swatch-1' }, 'FeedbackItem_paletteItemId_key');

  // The demo page keeps L3’s own unique.
  await make({ step: 'DEMO', phaseId: phase.id, demoId: home.demoId, demoPageId: home.id });
  await refuses({ step: 'DEMO', phaseId: phase.id, demoId: home.demoId, demoPageId: home.id }, 'FeedbackItem_demoPageId_key');

  // A second contract has its own threads.
  const second = await prisma.contract.create({
    data: { ref: 'RC-TEST-009', titleFa: 'ن', titleEn: 'n', customerId: f.customer.id, projectId: f.contract.projectId, status: 'WAITING_ON_CUSTOMER', publishedAt: new Date() },
  });
  await prisma.feedbackItem.create({ data: { projectId: f.contract.projectId, contractId: second.id, step: 'REQUIREMENTS', general: true } });
});

test('the migration’s backfill and guard, run over a legacy-shaped row: project, phase and the earliest contract; and a stop if a project has none', async () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20260929180000_s2_feedback_everywhere/migration.sql', import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const block = sql.slice(sql.indexOf('-- VERIFY:BEGIN') + '-- VERIFY:BEGIN'.length, sql.indexOf('-- VERIFY:END')).trim();
  const statements = block.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3, 'two UPDATEs and the guard');
  assert.match(statements[2], /RAISE EXCEPTION/);

  const { phase, demo, home } = await seedDemo();
  // The project’s *first* contract is what a legacy item is given — not the newest.
  await prisma.contract.create({
    data: { ref: 'RC-TEST-LATER', titleFa: 'ن', titleEn: 'later', customerId: f.customer.id, projectId: f.contract.projectId, status: 'WAITING_ON_CUSTOMER', publishedAt: new Date() },
  });

  await prisma.$transaction(async (tx) => {
    for (const col of ['projectId', 'contractId']) await tx.$executeRawUnsafe(`ALTER TABLE "FeedbackItem" ALTER COLUMN "${col}" DROP NOT NULL`);
    await tx.$executeRawUnsafe(
      `INSERT INTO "FeedbackItem" ("id", "demoId", "demoPageId", "step", "status", "updatedAt")
       VALUES ('legacy-item', '${demo.id}', '${home.id}', 'DEMO', 'OPEN', now())`,
    );
    for (const s of statements) await tx.$executeRawUnsafe(s);
    const [row] = await tx.$queryRawUnsafe<Array<{ projectId: string; contractId: string; phaseId: string }>>(
      `SELECT "projectId", "contractId", "phaseId" FROM "FeedbackItem" WHERE "id" = 'legacy-item'`,
    );
    assert.equal(row.projectId, f.contract.projectId);
    assert.equal(row.phaseId, phase.id);
    assert.equal(row.contractId, f.contract.id, 'the primary (earliest) contract');
    await tx.$executeRawUnsafe(`ALTER TABLE "FeedbackItem" ALTER COLUMN "projectId" SET NOT NULL`).catch(() => undefined);
    throw new Error('ROLLBACK');
  }).catch((err: Error) => assert.equal(err.message, 'ROLLBACK'));

  // A project with no contract at all: the guard stops the migration.
  const orphanProject = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ی', titleEn: 'orphan' } });
  const orphanPhase = await prisma.phase.create({ data: { projectId: orphanProject.id, number: 1, titleFa: 'ف', titleEn: 'p' } });
  const orphanDemo = await prisma.demo.create({ data: { phaseId: orphanPhase.id, stagingUrl: 'https://o.example.com' } });
  const orphanPage = await prisma.demoPage.create({ data: { demoId: orphanDemo.id, key: 'o', labelFa: 'ا', labelEn: 'o', canonicalPath: '/o' } });
  await assert.rejects(
    () =>
      prisma.$transaction(async (tx) => {
        for (const col of ['projectId', 'contractId']) await tx.$executeRawUnsafe(`ALTER TABLE "FeedbackItem" ALTER COLUMN "${col}" DROP NOT NULL`);
        await tx.$executeRawUnsafe(
          `INSERT INTO "FeedbackItem" ("id", "demoId", "demoPageId", "step", "status", "updatedAt")
           VALUES ('orphan-item', '${orphanDemo.id}', '${orphanPage.id}', 'DEMO', 'OPEN', now())`,
        );
        for (const s of statements) await tx.$executeRawUnsafe(s);
      }),
    /S2: 1 feedback item\(s\) have no project or contract/,
  );
  const [col] = await prisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
    `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'FeedbackItem' AND column_name = 'contractId'`,
  );
  assert.equal(col.is_nullable, 'NO', 'the rolled-back transaction left the column required');
});

// =================================================================================
// The customer’s ticket door, and the J3 owed item
// =================================================================================

test('createTicketFromFeedback: the item is MOVED, the customer sees the move, and can reopen it', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'A whole new checkout', { phaseId: phase.id });
  ok(
    await exec(
      'mutation($i: ID!){ createTicketFromFeedback(itemId: $i, currentState: "none", desiredState: "a checkout", lang: "en") { id } }',
      { as: sales, variables: { i: item.id } },
    ),
  );
  const seen = (await view(f.customer))[0];
  assert.equal(seen.status, 'MOVED');
  const ticketId = (ok(await exec('query($c: ID!){ contract(id: $c) { feedbackItems { ticket { id type } } } }', { as: f.customer, variables: { c: f.contract.id } })).contract as { feedbackItems: Array<{ ticket: { type: string } | null }> }).feedbackItems[0].ticket;
  assert.equal(ticketId?.type, 'CHANGE_REQUEST');
  assert.equal((await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'no — I mean it', { phaseId: phase.id })).status, 'OPEN');
});

test('FeedbackItem.addressedInBuild loads declaredBy: a customer reads the developer’s name — not their contacts, not the change list', async () => {
  const { phase, home } = await seedDemo();
  const item = await submitOk('DEMO', { demoId: home.demoId, demoPageId: home.id }, 'fix', { phaseId: phase.id });
  await prisma.user.update({ where: { id: developer.id }, data: { phone: '+989120000077' } });
  ok(
    await exec('mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id } }', {
      as: developer,
      variables: { p: phase.id, c: [{ feedbackItemId: item.id, outcome: 'ADDRESSED', note: 'raw developer note', noteLang: 'en' }, { note: 'an unprompted refactor', noteLang: 'en' }] },
    }),
  );
  const Q = 'query($c: ID!){ contract(id: $c) { feedbackItems { addressedInBuild { number declaredBy { name email phone } changes { note } } } } }';
  type B = { number: number; declaredBy: { name: string; email: string | null; phone: string | null }; changes: Array<{ note: string | null }> };
  const read = async (as: User) => (ok(await exec(Q, { as, variables: { c: f.contract.id } })).contract as { feedbackItems: Array<{ addressedInBuild: B }> }).feedbackItems[0].addressedInBuild;

  const asCustomer = await read(f.customer);
  assert.equal(asCustomer.number, 1);
  assert.equal(asCustomer.declaredBy.name, 'developer');
  assert.equal(asCustomer.declaredBy.email, null, 'a name is fine; contacts are not (mayReadContactOf)');
  assert.equal(asCustomer.declaredBy.phone, null);
  assert.deepEqual(asCustomer.changes, [], 'the raw notes are staff’s until the PM has written them up');

  const asStaff = await read(sales);
  assert.equal(asStaff.declaredBy.email, 'developer@test.local');
  assert.equal(asStaff.changes.length, 2);
});

// =================================================================================
// The plan’s Acceptance paragraph, as one scenario on a seeded demo
// =================================================================================

test('Acceptance: the customer comments; the developer answers directly; the designer’s answer waits, invisible; sales declines it with a reason the designer sees; the customer reopens a declined item; approval is refused until everything is resolved, then accepts all and locks', async () => {
  const { phase, demo, home, about, line } = await seedDemo();
  const target = (page: { id: string }) => ({ demoId: demo.id, demoPageId: page.id });

  // 1. The customer comments on three things.
  const a = await submitOk('DEMO', target(home), 'The header overlaps the logo', { phaseId: phase.id });
  const b = await submitOk('DEMO', target(about), 'The team photo is missing', { phaseId: phase.id });
  const c = await submitOk('DEMO', { demoId: demo.id, frameLineId: line.id }, 'Can checkout also take cards?', { phaseId: phase.id });

  // 2. The developer answers on the demo — directly. The customer sees it now.
  ok(await answer(developer, a.id, 'Fixed in the next build', 'ADDRESSED'));
  const afterDev = (await view(f.customer)).find((i) => i.id === a.id)!;
  assert.equal(afterDev.status, 'ADDRESSED');
  assert.ok(afterDev.comments.some((cm) => cm.body === 'Fixed in the next build' && cm.approval === 'NOT_REQUIRED'));

  // 3. The designer’s answer on the same demo waits in sales’ queue, invisible to the customer.
  ok(await answer(designer, b.id, 'We can add the photo', 'ADDRESSED'));
  assert.ok(!(await view(f.customer)).find((i) => i.id === b.id)!.comments.some((cm) => cm.body === 'We can add the photo'));
  const queue = ok(await exec('query { pendingAnswers { id comment { body } item { id } } }', { as: sales })).pendingAnswers as Array<{ id: string; comment: { body: string }; item: { id: string } }>;
  assert.deepEqual(queue.map((q) => q.comment.body), ['We can add the photo']);

  // 4. Sales declines it with a reason; the designer sees the reason, the customer still nothing.
  ok(await exec(DECLINE_ANSWER, { as: sales, variables: { c: queue[0].id, r: 'Photos are the customer’s to send — say so in the answer.' } }));
  const designerSees = (await view(designer)).find((i) => i.id === b.id)!.comments.find((cm) => cm.body === 'We can add the photo')!;
  assert.equal(designerSees.approvalNote, 'Photos are the customer’s to send — say so in the answer.');
  assert.ok(!(await view(f.customer)).find((i) => i.id === b.id)!.comments.some((cm) => cm.body === 'We can add the photo'));
  assert.equal((await prisma.feedbackItem.findUniqueOrThrow({ where: { id: b.id } })).status, 'OPEN');

  // 5. The developer declines the checkout question outright; the customer reopens it.
  ok(await answer(developer, c.id, 'Card payments are out of scope for this phase', 'DECLINED'));
  assert.equal((await view(f.customer)).find((i) => i.id === c.id)!.status, 'DECLINED');
  await submitOk('DEMO', { demoId: demo.id, frameLineId: line.id }, 'It is in the contract — please check', { phaseId: phase.id });
  assert.equal((await view(f.customer)).find((i) => i.id === c.id)!.status, 'OPEN', 'the customer reopened a declined item');

  // 6. Approval is refused while anything is open…
  const approve = () => exec(APPROVE_STEP, { as: f.customer, variables: { c: f.contract.id, s: 'DEMO', p: phase.id } });
  assert.equal((await approve()).code, 'STEP_HAS_OPEN_FEEDBACK');

  // …until every item is resolved (b answered by the developer; c answered by sales, and kept declined).
  ok(await answer(developer, b.id, 'Send us the photo and we will add it', 'ADDRESSED'));
  assert.equal((await approve()).code, 'STEP_HAS_OPEN_FEEDBACK', 'c is still open');
  ok(await answer(sales, c.id, 'Checked: cards are not in the agreement; a change request can add them', 'DECLINED'));

  // 7. Then it accepts all — and locks.
  ok(await approve());
  const rows = await prisma.feedbackItem.findMany({ where: { step: 'DEMO' }, orderBy: { createdAt: 'asc' } });
  assert.deepEqual(rows.map((r) => r.status), ['ACCEPTED', 'ACCEPTED', 'DECLINED']);
  assert.ok(rows.every((r) => r.acceptedAt && r.acceptedById === f.customer.id));
  assert.equal((await submit('DEMO', target(home), 'one more thing', { phaseId: phase.id })).code, 'STEP_LOCKED');
  assert.equal((await answer(developer, a.id, 'one more answer')).code, 'STEP_LOCKED');
});
