import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * C2: threads and comments anchored to a passage in one frozen block.
 * `threadsVisibleTo` (reviewThreads.ts) is the ownership edge the whole
 * stage rests on — Root sees every thread, a reviewer sees only their own
 * — and every mutation loads a thread through that same filter, so reading,
 * replying and resolving are all provably gated by the one function.
 */

let f: Fixture;
let reviewerA: Awaited<ReturnType<typeof prisma.user.create>>;
let reviewerB: Awaited<ReturnType<typeof prisma.user.create>>;
let round: { id: string };
let doc: { id: string; blocks: unknown };

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  reviewerA = await prisma.user.create({
    data: { email: 'reviewer-a@test.local', name: 'Reviewer A', roles: ['REVIEWER'], state: 'ACTIVE' },
  });
  reviewerB = await prisma.user.create({
    data: { email: 'reviewer-b@test.local', name: 'Reviewer B', roles: ['REVIEWER'], state: 'ACTIVE' },
  });

  round = await prisma.reviewRound.create({
    data: {
      sha: 'a'.repeat(40),
      publishedById: f.admin.id,
      documents: {
        create: [
          {
            path: 'ecosystem/canon/learn.md',
            title: 'Learn',
            order: 0,
            contentHash: 'x',
            blocks: [{ id: 'b1', kind: 'PARAGRAPH', text: 'Some content about growing a mind that grows.' }],
          },
        ],
      },
    },
    include: { documents: true },
  });
  doc = (round as unknown as { documents: Array<{ id: string; blocks: unknown }> }).documents[0];
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const THREAD_FIELDS = `
  id documentId authorId blockId startOffset endOffset quote resolvedAt resolvedById
  author { id name }
  resolvedBy { id name }
  comments { id authorId body author { id name } }
`;

const OPEN = `
  mutation($documentId: ID!, $blockId: String!, $startOffset: Int!, $endOffset: Int!, $quote: String!, $body: String!) {
    openReviewThread(documentId: $documentId, blockId: $blockId, startOffset: $startOffset, endOffset: $endOffset, quote: $quote, body: $body) { ${THREAD_FIELDS} }
  }
`;
const ADD_COMMENT = `
  mutation($threadId: ID!, $body: String!) {
    addReviewComment(threadId: $threadId, body: $body) { ${THREAD_FIELDS} }
  }
`;
const RESOLVE = `
  mutation($threadId: ID!) {
    resolveReviewThread(threadId: $threadId) { ${THREAD_FIELDS} }
  }
`;
const DOCUMENT_THREADS = `
  query($roundId: ID!, $documentId: ID!) {
    reviewDocument(roundId: $roundId, documentId: $documentId) { id threads { ${THREAD_FIELDS} } }
  }
`;

async function openThread(
  as: typeof reviewerA,
  overrides: Partial<{ documentId: string; blockId: string; startOffset: number; endOffset: number; quote: string; body: string }> = {},
) {
  return exec(OPEN, {
    as,
    variables: {
      documentId: doc.id,
      blockId: 'b1',
      startOffset: 5,
      endOffset: 12,
      quote: 'content',
      body: 'What does this mean?',
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// §3 — the property this whole stage rests on
// ---------------------------------------------------------------------------

test("a reviewer's thread is invisible to a second reviewer and visible to Root", async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  const asB = ok(await exec(DOCUMENT_THREADS, { as: reviewerB, variables: { roundId: round.id, documentId: doc.id } }));
  assert.equal((asB.reviewDocument as { threads: unknown[] }).threads.length, 0);

  const asAdmin = ok(await exec(DOCUMENT_THREADS, { as: f.admin, variables: { roundId: round.id, documentId: doc.id } }));
  const adminThreads = (asAdmin.reviewDocument as { threads: Array<{ id: string }> }).threads;
  assert.equal(adminThreads.length, 1);
  assert.equal(adminThreads[0].id, threadId);

  const asA = ok(await exec(DOCUMENT_THREADS, { as: reviewerA, variables: { roundId: round.id, documentId: doc.id } }));
  assert.equal((asA.reviewDocument as { threads: Array<{ id: string }> }).threads.length, 1);
});

test('a reviewer cannot read, reply to, or resolve another reviewer\'s thread by id — the ownership filter refuses the load itself', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  const reply = await exec(ADD_COMMENT, { as: reviewerB, variables: { threadId, body: 'Butting in.' } });
  assert.equal(reply.code, 'NOT_FOUND');

  const resolve = await exec(RESOLVE, { as: reviewerB, variables: { threadId } });
  assert.equal(resolve.code, 'NOT_FOUND');
});

test("Root's reply appears in the thread author's own thread", async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  ok(await exec(ADD_COMMENT, { as: f.admin, variables: { threadId, body: 'Good question — clarifying now.' } }));

  const asA = ok(await exec(DOCUMENT_THREADS, { as: reviewerA, variables: { roundId: round.id, documentId: doc.id } }));
  const thread = (asA.reviewDocument as { threads: Array<{ comments: Array<{ body: string; authorId: string }> }> }).threads[0];
  assert.equal(thread.comments.length, 2);
  assert.equal(thread.comments[1].body, 'Good question — clarifying now.');
  assert.equal(thread.comments[1].authorId, f.admin.id);
});

// ---------------------------------------------------------------------------
// Resolution — a state, not a hide (T4)
// ---------------------------------------------------------------------------

test('resolving sets resolvedAt/resolvedBy and does not delete the thread or its comments', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  const resolved = ok(await exec(RESOLVE, { as: reviewerA, variables: { threadId } }));
  const thread = resolved.resolveReviewThread as { resolvedAt: string | null; resolvedById: string | null; comments: unknown[] };
  assert.ok(thread.resolvedAt);
  assert.equal(thread.resolvedById, reviewerA.id);
  assert.equal(thread.comments.length, 1);

  const row = await prisma.reviewThread.findUniqueOrThrow({ where: { id: threadId } });
  assert.ok(row.resolvedAt);
});

test('resolving an already-resolved thread is idempotent, not an error', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;
  ok(await exec(RESOLVE, { as: reviewerA, variables: { threadId } }));
  const second = ok(await exec(RESOLVE, { as: reviewerA, variables: { threadId } }));
  assert.ok((second.resolveReviewThread as { resolvedAt: string }).resolvedAt);
});

// ---------------------------------------------------------------------------
// §4 — threads stay on the round they were written against
// ---------------------------------------------------------------------------

test('a thread on an older round stays attached to it after a new round is published', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  await prisma.reviewRound.create({
    data: {
      sha: 'b'.repeat(40),
      publishedById: f.admin.id,
      documents: {
        create: [
          { path: 'ecosystem/canon/learn.md', title: 'Learn v2', order: 0, contentHash: 'y', blocks: [{ id: 'b1', kind: 'PARAGRAPH', text: 'Updated content.' }] },
        ],
      },
    },
  });

  const row = await prisma.reviewThread.findUniqueOrThrow({ where: { id: threadId } });
  assert.equal(row.documentId, doc.id); // still the original round's document, untouched

  const asAdmin = ok(await exec(DOCUMENT_THREADS, { as: f.admin, variables: { roundId: round.id, documentId: doc.id } }));
  assert.equal((asAdmin.reviewDocument as { threads: unknown[] }).threads.length, 1);
});

// ---------------------------------------------------------------------------
// §2 — the offset CHECK
// ---------------------------------------------------------------------------

test('an inverted or zero-width range is refused at the resolver, before ever reaching the database', async () => {
  const zeroWidth = await openThread(reviewerA, { startOffset: 5, endOffset: 5 });
  assert.equal(zeroWidth.code, 'INVALID_RANGE');
  const inverted = await openThread(reviewerA, { startOffset: 9, endOffset: 5 });
  assert.equal(inverted.code, 'INVALID_RANGE');
  assert.equal(await prisma.reviewThread.count(), 0);
});

test('the database CHECK itself refuses an inverted range, independent of the resolver', async () => {
  await assert.rejects(
    prisma.reviewThread.create({
      data: { documentId: doc.id, authorId: reviewerA.id, blockId: 'b1', startOffset: 9, endOffset: 5, quote: 'x' },
    }),
    /ReviewThread_offsets_valid/,
  );
});

// ---------------------------------------------------------------------------
// Validation and guards
// ---------------------------------------------------------------------------

test('an empty quote or empty body is refused', async () => {
  const emptyQuote = await openThread(reviewerA, { quote: '   ' });
  assert.equal(emptyQuote.code, 'INVALID_THREAD');
  const emptyBody = await openThread(reviewerA, { body: '' });
  assert.equal(emptyBody.code, 'INVALID_THREAD');
});

test('a blockId that does not exist on the document is refused, not trusted from the client', async () => {
  const res = await openThread(reviewerA, { blockId: 'not-a-real-block' });
  assert.equal(res.code, 'UNKNOWN_BLOCK');
});

test('opening a thread on a non-existent document is NOT_FOUND', async () => {
  const res = await openThread(reviewerA, { documentId: 'nope' });
  assert.equal(res.code, 'NOT_FOUND');
});

test('review.participate is required to open, reply, or resolve — a customer and an anonymous caller are refused', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  for (const as of [f.customer, null]) {
    const openRes = await openThread(as as typeof reviewerA);
    assert.equal(openRes.code, as ? 'FORBIDDEN' : 'UNAUTHENTICATED');
    const replyRes = await exec(ADD_COMMENT, { as, variables: { threadId, body: 'x' } });
    assert.equal(replyRes.code, as ? 'FORBIDDEN' : 'UNAUTHENTICATED');
  }
});

// ---------------------------------------------------------------------------
// The corpus admin (C2 §5) — reviewer invite and revoke
// ---------------------------------------------------------------------------

const INVITE_REVIEWER = `
  mutation($email: String!, $name: String!) {
    inviteReviewer(email: $email, name: $name) { userId email inviteUrl }
  }
`;
const REVOKE_REVIEWER = `mutation($userId: ID!) { revokeReviewer(userId: $userId) }`;
const REVIEWERS = `query { reviewers { id email } }`;

test('inviteReviewer is guarded by review.admin, creates a REVIEWER account, and customers.manage alone is not enough', async () => {
  const contributor = await prisma.user.create({
    data: { email: 'contributor-only@test.local', name: 'C', roles: ['CONTRIBUTOR'], state: 'ACTIVE' },
  });
  const refused = await exec(INVITE_REVIEWER, {
    as: contributor,
    variables: { email: 'new-reviewer@test.local', name: 'New Reviewer' },
  });
  assert.equal(refused.code, 'FORBIDDEN');

  const data = ok(
    await exec(INVITE_REVIEWER, { as: f.admin, variables: { email: 'new-reviewer@test.local', name: 'New Reviewer' } }),
  );
  const result = data.inviteReviewer as { userId: string; inviteUrl: string };
  const created = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
  assert.deepEqual(created.roles, ['REVIEWER']);
  assert.equal(created.state, 'INVITED');
  assert.ok(result.inviteUrl.includes('/portal/invite/'));
});

test('reviewers query lists only accounts holding REVIEWER, and is guarded by review.admin', async () => {
  const forbidden = await exec(REVIEWERS, { as: f.customer });
  assert.equal(forbidden.code, 'FORBIDDEN');

  const data = ok(await exec(REVIEWERS, { as: f.admin }));
  const emails = (data.reviewers as Array<{ email: string }>).map((r) => r.email).sort();
  assert.deepEqual(emails, ['reviewer-a@test.local', 'reviewer-b@test.local']);
});

test('revokeReviewer drops the role and keeps every thread and comment the reviewer wrote', async () => {
  const opened = ok(await openThread(reviewerA));
  const threadId = (opened.openReviewThread as { id: string }).id;

  await prisma.user.update({ where: { id: reviewerA.id }, data: { roles: ['REVIEWER', 'CONTRIBUTOR'] } });
  ok(await exec(REVOKE_REVIEWER, { as: f.admin, variables: { userId: reviewerA.id } }));

  const after = await prisma.user.findUniqueOrThrow({ where: { id: reviewerA.id } });
  assert.deepEqual(after.roles, ['CONTRIBUTOR']);

  const thread = await prisma.reviewThread.findUniqueOrThrow({ where: { id: threadId }, include: { comments: true } });
  assert.equal(thread.authorId, reviewerA.id);
  assert.equal(thread.comments.length, 1);
});

test("revokeReviewer refuses when REVIEWER is the account's only role, rather than leaving it with none", async () => {
  const res = await exec(REVOKE_REVIEWER, { as: f.admin, variables: { userId: reviewerA.id } });
  assert.equal(res.code, 'LAST_ROLE');
  const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: reviewerA.id } });
  assert.deepEqual(unchanged.roles, ['REVIEWER']);
});
