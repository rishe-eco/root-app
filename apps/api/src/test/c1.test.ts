import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { buildDocumentSnapshot, contentHash, type Block } from '../lib/revision.js';

/**
 * C1: the Review Room's trust boundary. The publish mutation revalidates
 * everything a CLI could have sent — paths, shapes, and the hash, always
 * recomputed here rather than trusted (§3.1) — and every query is guarded
 * by capability, not by the desk nav (T2), since review.participate is the
 * most externally-held capability in the app.
 */

let f: Fixture;
let reviewer: Awaited<ReturnType<typeof prisma.user.create>>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  reviewer = await prisma.user.create({
    data: { email: 'reviewer@test.local', name: 'Reviewer', roles: ['REVIEWER'], state: 'ACTIVE' },
  });
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const block = (id: string, text: string, kind: Block['kind'] = 'PARAGRAPH') => ({ id, kind, text });

function docInput(overrides: Partial<{ path: string; title: string; order: number; blocks: unknown[] }> = {}) {
  return {
    path: 'ecosystem/canon/learn.md',
    title: 'Learn',
    order: 0,
    blocks: [block('b1', 'Some content.')],
    ...overrides,
  };
}

const PUBLISH = `
  mutation($sha: String!, $label: String, $documents: [ReviewDocumentInput!]!) {
    publishReviewRound(sha: $sha, label: $label, documents: $documents) {
      id
      sha
      documents { id path title order }
    }
  }
`;
const ROUNDS = `query{ reviewRounds { id sha label documents { id path title } } }`;
const DOCUMENT = `
  query($roundId: ID!, $documentId: ID!) {
    reviewDocument(roundId: $roundId, documentId: $documentId) {
      id path title contentHash blocks { id kind depth text } round { id sha }
    }
  }
`;

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

async function publish(overrides: { sha?: string; label?: string | null; documents?: unknown[] } = {}) {
  return exec(PUBLISH, {
    as: f.admin,
    variables: { sha: overrides.sha ?? SHA_A, label: overrides.label ?? null, documents: overrides.documents ?? [docInput()] },
  });
}

// ---------------------------------------------------------------------------
// §1 / T5 — the allowlist, proven for the file the decision was about
// ---------------------------------------------------------------------------

test('publishing a round writes one ReviewDocument per manifest entry and no more — personal-canon.md is never in the documents list, so it is never written', async () => {
  // The mutation only ever knows about what it is given — this is really a
  // regression guard: nothing here should ever grow a "sync the whole repo"
  // behaviour that would write personal-canon.md just because it exists.
  const data = ok(
    await publish({
      documents: [docInput({ path: 'ecosystem/canon/learn.md', title: 'Learn' })],
    }),
  );
  const round = data.publishReviewRound as { id: string; documents: Array<{ path: string }> };
  assert.equal(round.documents.length, 1);
  assert.equal(round.documents[0].path, 'ecosystem/canon/learn.md');

  const rows = await prisma.reviewDocument.findMany({ where: { roundId: round.id } });
  assert.equal(rows.length, 1);
  assert.ok(!rows.some((r) => r.path === 'personal-canon.md'));
});

// ---------------------------------------------------------------------------
// The mutation as trust boundary (§3.1) — revalidated, not trusted
// ---------------------------------------------------------------------------

test('sha must be a full 40-character commit hash — a branch name is refused', async () => {
  const res = await publish({ sha: 'main' });
  assert.equal(res.code, 'INVALID_SHA');
  assert.equal(await prisma.reviewRound.count(), 0);
});

test('a round needs at least one document', async () => {
  const res = await publish({ documents: [] });
  assert.equal(res.code, 'EMPTY_ROUND');
});

test('republishing the same sha is refused, not duplicated', async () => {
  ok(await publish({ sha: SHA_A }));
  const res = await publish({ sha: SHA_A, documents: [docInput({ path: 'other.md' })] });
  assert.equal(res.code, 'ROUND_ALREADY_PUBLISHED');
  assert.equal(await prisma.reviewRound.count(), 1);
});

test('an unsafe path is refused server-side too, not only by the CLI', async () => {
  const res = await publish({ documents: [docInput({ path: '../../etc/passwd' })] });
  assert.equal(res.code, 'UNSAFE_PATH');
  assert.equal(await prisma.reviewDocument.count(), 0);
});

test('a duplicate path within one round is refused', async () => {
  const res = await publish({
    documents: [docInput({ path: 'a.md' }), docInput({ path: 'a.md', title: 'Second' })],
  });
  assert.equal(res.code, 'DUPLICATE_PATH');
});

test('contentHash is always recomputed from the received blocks, not taken from the request — there is nowhere to even send one', async () => {
  const blocks = [block('b1', 'Exact content'), block('b2', 'Second block', 'HEADING')];
  const data = ok(await publish({ sha: SHA_B, documents: [docInput({ blocks })] }));
  const round = data.publishReviewRound as { documents: Array<{ id: string }> };
  const stored = await prisma.reviewDocument.findUniqueOrThrow({ where: { id: round.documents[0].id } });
  assert.equal(stored.contentHash, contentHash(buildDocumentSnapshot(blocks as Block[])));
});

// ---------------------------------------------------------------------------
// T2 — every resolver guards itself, not just the desk nav
// ---------------------------------------------------------------------------

test('review.admin is required to publish; review.participate is not enough', async () => {
  const res = await exec(PUBLISH, {
    as: reviewer,
    variables: { sha: SHA_A, label: null, documents: [docInput()] },
  });
  assert.equal(res.code, 'FORBIDDEN');
});

test('a reviewer can read a published round and its documents', async () => {
  const pub = ok(await publish());
  const round = pub.publishReviewRound as { id: string; documents: Array<{ id: string }> };

  const rounds = ok(await exec(ROUNDS, { as: reviewer }));
  assert.equal((rounds.reviewRounds as unknown[]).length, 1);

  const doc = ok(
    await exec(DOCUMENT, { as: reviewer, variables: { roundId: round.id, documentId: round.documents[0].id } }),
  );
  assert.equal((doc.reviewDocument as { path: string }).path, 'ecosystem/canon/learn.md');
});

test('a customer and an unauthenticated caller cannot read the Review Room at all', async () => {
  ok(await publish());
  for (const as of [f.customer, null]) {
    const rounds = await exec(ROUNDS, { as });
    assert.equal(rounds.code, as ? 'FORBIDDEN' : 'UNAUTHENTICATED');
  }
});

test('a document from a different round than the one named is not found — no cross-round leak through a mismatched id', async () => {
  const p1 = ok(await publish({ sha: SHA_A, documents: [docInput({ path: 'one.md' })] }));
  const p2 = ok(await publish({ sha: SHA_B, documents: [docInput({ path: 'two.md' })] }));
  const round1 = p1.publishReviewRound as { id: string };
  const round2doc = (p2.publishReviewRound as { documents: Array<{ id: string }> }).documents[0];

  const res = await exec(DOCUMENT, {
    as: reviewer,
    variables: { roundId: round1.id, documentId: round2doc.id },
  });
  assert.equal(res.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// T1 — the round list is thin; blocks are structurally absent from it
// ---------------------------------------------------------------------------

test('reviewRounds cannot ask for a document\'s blocks — the thin type has no such field', async () => {
  const res = await exec('query{ reviewRounds { documents { id blocks { id } } } }', { as: reviewer });
  assert.ok(res.errors.length > 0, 'ReviewDocumentRef must not have a blocks field');
});
