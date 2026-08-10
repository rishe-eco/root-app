import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * V1b: the draft gets its own name on the wire, and the published surface is
 * not touched. These tests hold the two properties that matter — a write to
 * the draft round-trips through `draft`, and `designDraft` never creates what
 * it reads (trap T1 in docs/development/V1b.md).
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

const contractDraftAndArticles = `
  query($id: ID!) {
    contract(id: $id) {
      draft { articles { number bodyEn } }
      articles { number bodyEn }
    }
  }
`;

test('a setArticle write round-trips in draft; customer-facing articles do not move (acceptance)', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 2, titleFa: "دو", titleEn: "Article 2", bodyEn: "New body for 2") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const data = ok(await exec(contractDraftAndArticles, { as: f.admin, variables: { id: f.contract.id } }));
  const contract = data.contract as {
    draft: { articles: Array<{ number: number; bodyEn: string }> };
    articles: Array<{ number: number; bodyEn: string }>;
  };

  const draftTwo = contract.draft.articles.find((a) => a.number === 2);
  assert.equal(draftTwo?.bodyEn, 'New body for 2', 'the draft did not see the write');

  const publishedTwo = contract.articles.find((a) => a.number === 2);
  assert.equal(publishedTwo?.bodyEn, 'Body 2', 'the published snapshot moved under the write');
});

test('draft is null for the contract\'s own customer, with no error', async () => {
  const r = await exec('query($id: ID!){ contract(id: $id) { draft { contentHash } } }', {
    as: f.customer,
    variables: { id: f.contract.id },
  });
  assert.deepEqual(r.errors, []);
  assert.equal((r.data?.contract as { draft: unknown } | undefined)?.draft, null);
});

test('designDraft is null on a contract with no draft, and reading it creates nothing', async () => {
  const before = await prisma.designRevision.count();

  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { designDraft { id } } }', {
      as: f.admin,
      variables: { id: f.contract.id },
    }),
  );
  assert.equal((data.contract as { designDraft: unknown }).designDraft, null);

  const after = await prisma.designRevision.count();
  assert.equal(after, before, 'looking at designDraft minted a design revision');
});

test('designDraft appears once an edit creates one, and concepts still shows the published revision', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "طرح", labelEn: "Concept") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const data = ok(
    await exec(
      'query($id: ID!){ contract(id: $id) { designDraft { concepts { key } } concepts { key } } }',
      { as: f.admin, variables: { id: f.contract.id } },
    ),
  );
  const contract = data.contract as {
    designDraft: { concepts: Array<{ key: string }> };
    concepts: Array<{ key: string }>;
  };

  assert.ok(
    contract.designDraft.concepts.some((c) => c.key === '1d'),
    'the new concept did not land on the draft',
  );
  assert.deepEqual(
    contract.concepts.map((c) => c.key).sort(),
    ['1a', '1b', '1c'],
    'the published concepts moved before publishing',
  );
});

test('designRevisions excludes the unpublished draft for a customer, and includes it for staff', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "طرح", labelEn: "Concept") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const query = 'query($id: ID!){ contract(id: $id) { designRevisions { version publishedAt } } }';

  const asCustomer = ok(await exec(query, { as: f.customer, variables: { id: f.contract.id } }));
  const customerVersions = (
    asCustomer.contract as { designRevisions: Array<{ version: number }> }
  ).designRevisions.map((r) => r.version);
  assert.deepEqual(customerVersions, [1]);

  const asAdmin = ok(await exec(query, { as: f.admin, variables: { id: f.contract.id } }));
  const adminVersions = (
    asAdmin.contract as { designRevisions: Array<{ version: number }> }
  ).designRevisions.map((r) => r.version);
  assert.deepEqual(adminVersions, [2, 1], 'newest first, and the draft is missing');
});

test('dirty agrees with the NO_CHANGES refusal, in both directions', async () => {
  const seeded = ok(
    await exec('query($id: ID!){ contract(id: $id) { draft { dirty } } }', {
      as: f.admin,
      variables: { id: f.contract.id },
    }),
  );
  assert.equal((seeded.contract as { draft: { dirty: boolean } }).draft.dirty, false);
  assert.equal(
    (
      await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
        as: f.admin,
        variables: { c: f.contract.id },
      })
    ).code,
    'NO_CHANGES',
  );

  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "ماده ۱", titleEn: "Article 1", bodyEn: "Changed") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const edited = ok(
    await exec('query($id: ID!){ contract(id: $id) { draft { dirty } } }', {
      as: f.admin,
      variables: { id: f.contract.id },
    }),
  );
  assert.equal((edited.contract as { draft: { dirty: boolean } }).draft.dirty, true);
  ok(
    await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );
});
