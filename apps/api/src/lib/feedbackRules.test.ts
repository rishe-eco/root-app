import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, StepKind } from '@prisma/client';
import {
  FEEDBACK_STEPS,
  acceptanceOnApproval,
  answerGoverns,
  answerRoute,
  anchorMatchesStep,
  blockerCode,
  isMoneyAnchored,
  mayCarryResolution,
  reopensOnComment,
  stepBlockers,
  type ItemStatus,
  type ThreadEntry,
} from './feedbackRules.js';
import { visibleComment, visibleItem } from './visibility.js';
import { ANCHOR_TABLE } from '../test/anchorTable.js';

/**
 * The §3.1 rule as tables (journeys build plan S2): who answers directly, what
 * reopens, what blocks an approval, what an approval writes, which answer
 * governs, which anchor a step takes — and the two visibility rules that hang
 * off them. Pure functions; `s2.test.ts` is the same rules through a database.
 */

const user = (...roles: Role[]) => ({ id: roles.join('+') || 'nobody', roles });

// --- answerRoute: the matrix (PD-3), each role × each step -----------------

const STEPS: StepKind[] = ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN', 'MOCKUP', 'DEMO', 'SUMMARY'];

/** journeys §7.3, written out: D = direct, A = needs approval. */
const MATRIX: Record<string, Record<StepKind, 'D' | 'A'>> = {
  SALES: { REQUIREMENTS: 'D', SCOPE: 'D', DRAFT: 'D', AGREEMENT: 'D', DESIGN: 'D', MOCKUP: 'D', DEMO: 'D', SUMMARY: 'A' },
  DESIGNER: { REQUIREMENTS: 'A', SCOPE: 'A', DRAFT: 'A', AGREEMENT: 'A', DESIGN: 'D', MOCKUP: 'D', DEMO: 'A', SUMMARY: 'A' },
  DEVELOPER: { REQUIREMENTS: 'A', SCOPE: 'A', DRAFT: 'A', AGREEMENT: 'A', DESIGN: 'A', MOCKUP: 'A', DEMO: 'D', SUMMARY: 'A' },
  ADMIN: { REQUIREMENTS: 'D', SCOPE: 'D', DRAFT: 'D', AGREEMENT: 'D', DESIGN: 'D', MOCKUP: 'D', DEMO: 'D', SUMMARY: 'A' },
  CUSTOMER: { REQUIREMENTS: 'A', SCOPE: 'A', DRAFT: 'A', AGREEMENT: 'A', DESIGN: 'A', MOCKUP: 'A', DEMO: 'A', SUMMARY: 'A' },
};

for (const [role, row] of Object.entries(MATRIX)) {
  test(`answerRoute: ${role} × every step`, () => {
    for (const step of STEPS) {
      assert.equal(
        answerRoute(user(role as Role), step),
        row[step] === 'D' ? 'DIRECT' : 'NEEDS_APPROVAL',
        `${role} on ${step}`,
      );
    }
  });
}

test('answerRoute: a person holding two roles gets the union, not either alone (house rule 1)', () => {
  const both = user('DESIGNER', 'DEVELOPER');
  for (const step of ['DESIGN', 'MOCKUP', 'DEMO'] as const) assert.equal(answerRoute(both, step), 'DIRECT', step);
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT'] as const) assert.equal(answerRoute(both, step), 'NEEDS_APPROVAL', step);
});

test('the summary takes no feedback and so has no direct route', () => {
  assert.ok(!FEEDBACK_STEPS.includes('SUMMARY'));
  assert.ok(!FEEDBACK_STEPS.includes('AGREEMENT'), 'the agreement is approved, not discussed');
});

// --- who may attach a resolution ------------------------------------------

test('mayCarryResolution: only someone who may answer — the customer’s comments never resolve anything', () => {
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'ADMIN'] as const) assert.equal(mayCarryResolution(user(role)), true, role);
  for (const role of ['CUSTOMER', 'CONTRIBUTOR', 'REVIEWER'] as const) assert.equal(mayCarryResolution(user(role)), false, role);
});

// --- reopensOnComment (§3.1, reversing L3b §2.5) ---------------------------

test('reopensOnComment: ADDRESSED, DECLINED and MOVED reopen; OPEN has nothing to reopen; ACCEPTED never silently un-accepts', () => {
  const table: Array<[ItemStatus, boolean]> = [
    ['OPEN', false],
    ['ADDRESSED', true],
    ['DECLINED', true],
    ['MOVED', true],
    ['ACCEPTED', false],
  ];
  for (const [status, expected] of table) assert.equal(reopensOnComment(status), expected, status);
});

// --- stepBlockers -----------------------------------------------------------

test('stepBlockers: open items and pending answers block; every resolved status does not', () => {
  const statuses: ItemStatus[] = ['OPEN', 'ADDRESSED', 'DECLINED', 'MOVED', 'ACCEPTED'];
  const items = statuses.map((status, i) => ({ id: `i${i}`, status }));
  assert.deepEqual(stepBlockers(items, []), { openItemIds: ['i0'], pendingAnswerIds: [] });
  assert.deepEqual(stepBlockers(items.slice(1), [{ id: 'a1' }, { id: 'a2' }]), { openItemIds: [], pendingAnswerIds: ['a1', 'a2'] });
  assert.deepEqual(stepBlockers([], []), { openItemIds: [], pendingAnswerIds: [] });
});

test('blockerCode: open items are named before pending answers; nothing blocking is null', () => {
  assert.equal(blockerCode({ openItemIds: ['a'], pendingAnswerIds: ['b'] }), 'STEP_HAS_OPEN_FEEDBACK');
  assert.equal(blockerCode({ openItemIds: [], pendingAnswerIds: ['b'] }), 'STEP_HAS_PENDING_ANSWERS');
  assert.equal(blockerCode({ openItemIds: [], pendingAnswerIds: [] }), null);
});

// --- acceptanceOnApproval ---------------------------------------------------

test('acceptanceOnApproval: ADDRESSED becomes ACCEPTED; DECLINED and MOVED keep their status and gain the acceptance; OPEN and already-accepted are left alone', () => {
  const at = new Date('2026-09-29T12:00:00Z');
  const writes = acceptanceOnApproval([
    { id: 'addressed', status: 'ADDRESSED', acceptedAt: null },
    { id: 'declined', status: 'DECLINED', acceptedAt: null },
    { id: 'moved', status: 'MOVED', acceptedAt: null },
    { id: 'open', status: 'OPEN', acceptedAt: null },
    { id: 'accepted', status: 'ACCEPTED', acceptedAt: at },
    { id: 'declinedTwice', status: 'DECLINED', acceptedAt: at },
  ]);
  assert.deepEqual(writes, [
    { id: 'addressed', status: 'ACCEPTED' },
    { id: 'declined', status: 'DECLINED' },
    { id: 'moved', status: 'MOVED' },
  ]);
});

// --- answerGoverns ----------------------------------------------------------

const t0 = new Date('2026-09-29T10:00:00Z');
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);
const entry = (id: string, minutes: number, over: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id,
  createdAt: at(minutes),
  byCustomer: false,
  resolution: null,
  approval: 'NOT_REQUIRED',
  ...over,
});

test('answerGoverns: a pending answer governs when nothing visible and later has spoken', () => {
  const thread = [entry('c1', 0, { byCustomer: true }), entry('a1', 1, { resolution: 'ADDRESSED', approval: 'PENDING' })];
  assert.equal(answerGoverns('a1', thread), true);
});

test('answerGoverns: a later direct resolving answer supersedes an earlier pending one — it is moot', () => {
  const thread = [
    entry('c1', 0, { byCustomer: true }),
    entry('pending', 1, { resolution: 'DECLINED', approval: 'PENDING' }),
    entry('direct', 2, { resolution: 'ADDRESSED', approval: 'NOT_REQUIRED' }),
  ];
  assert.equal(answerGoverns('pending', thread), false);
  assert.equal(answerGoverns('direct', thread), true);
});

test('answerGoverns: a later customer comment (a reopening) is not overwritten by approving an older answer', () => {
  const thread = [
    entry('pending', 1, { resolution: 'ADDRESSED', approval: 'PENDING' }),
    entry('c2', 2, { byCustomer: true }),
  ];
  assert.equal(answerGoverns('pending', thread), false);
});

test('answerGoverns: a later answer that is itself pending or declined has not spoken', () => {
  const thread = [
    entry('a1', 1, { resolution: 'ADDRESSED', approval: 'PENDING' }),
    entry('later-pending', 2, { resolution: 'DECLINED', approval: 'PENDING' }),
    entry('later-declined', 3, { resolution: 'DECLINED', approval: 'DECLINED' }),
    entry('later-plain', 4, { resolution: null, approval: 'NOT_REQUIRED' }),
  ];
  assert.equal(answerGoverns('a1', thread), true, 'only a visible resolving answer, or the customer, supersedes');
});

test('answerGoverns: equal times fall back to the id, so the answer is total; an unknown id governs nothing', () => {
  const a = entry('a', 5, { resolution: 'ADDRESSED', approval: 'PENDING' });
  const b = entry('b', 5, { resolution: 'DECLINED', approval: 'APPROVED' });
  assert.equal(answerGoverns('a', [a, b]), false);
  assert.equal(answerGoverns('b', [a, b]), true);
  assert.equal(answerGoverns('missing', [a, b]), false);
});

// --- anchorMatchesStep: the CHECK's twin, as a table -------------------------
// The table is test/anchorTable.ts — s2.test.ts inserts the same rows into
// Postgres, where FeedbackItem_anchor_matches_step must agree row for row.

test('anchorMatchesStep: the table', () => {
  for (const [step, a, expected, why] of ANCHOR_TABLE) {
    assert.equal(anchorMatchesStep(step, a), expected, `${step}: ${why}`);
  }
});

// --- money (PD-21) -----------------------------------------------------------

test('isMoneyAnchored: the budget, the payment plan and a sensitive article — nothing else', () => {
  assert.equal(isMoneyAnchored({ briefField: 'budgetCap' }), true);
  assert.equal(isMoneyAnchored({ briefField: 'paymentPlan' }), true);
  assert.equal(isMoneyAnchored({ briefField: 'domain' }), false);
  assert.equal(isMoneyAnchored({ briefField: null }), false);
  assert.equal(isMoneyAnchored({ briefField: null, articleSensitive: true }), true);
});

test('visibleItem: feedback about money is hidden from staff without money.read, never from the customer or a money reader', () => {
  const contract = { customerId: 'cust' };
  const about = { briefField: 'budgetCap' };
  assert.equal(visibleItem(about, { id: 'cust', roles: ['CUSTOMER'] }, contract), true);
  assert.equal(visibleItem(about, { id: 's', roles: ['SALES'] }, contract), true);
  assert.equal(visibleItem(about, { id: 'a', roles: ['ADMIN'] }, contract), true);
  assert.equal(visibleItem(about, { id: 'd', roles: ['DESIGNER'] }, contract), false);
  assert.equal(visibleItem(about, { id: 'v', roles: ['DEVELOPER'] }, contract), false);
  assert.equal(visibleItem({ briefField: 'domain' }, { id: 'd', roles: ['DESIGNER'] }, contract), true, 'other feedback is theirs');
  assert.equal(visibleItem({ briefField: null, articleSensitive: true }, { id: 'd', roles: ['DESIGNER'] }, contract), false);
});

// --- the customer projection (PD-4) -------------------------------------------

test('visibleComment: staff readers see every comment; anyone else only what has reached them', () => {
  const approvals = ['NOT_REQUIRED', 'PENDING', 'APPROVED', 'DECLINED'] as const;
  const seen = (viewer: { id: string; roles: Role[] }) => approvals.filter((approval) => visibleComment({ approval }, viewer));
  assert.deepEqual(seen({ id: 'c', roles: ['CUSTOMER'] }), ['NOT_REQUIRED', 'APPROVED']);
  assert.deepEqual(seen({ id: 's', roles: ['SALES'] }), [...approvals]);
  assert.deepEqual(seen({ id: 'd', roles: ['DESIGNER'] }), [...approvals], 'the author sees their own declined draft and its reason');
  assert.deepEqual(seen({ id: 'v', roles: ['DEVELOPER'] }), [...approvals]);
});
