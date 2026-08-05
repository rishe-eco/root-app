import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, completeDesign, approveContract, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { buildAmendmentSnapshot, contentHash } from '../lib/revision.js';

/**
 * V2: the admin contract workspace's server half — everything that was
 * missing for *editing and removing*, the amendment lifecycle end to end,
 * and the two defects (D2, D6) and the constraint (D5) this stage fixes.
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

const signBase = async () => {
  await completeDesign(f);
  await approveContract(f);
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
};

async function assertAmendmentHashHolds(amendmentId: string) {
  const row = await prisma.amendment.findUniqueOrThrow({ where: { id: amendmentId } });
  const fresh = contentHash(
    buildAmendmentSnapshot({
      ordinal: row.ordinal,
      titleFa: row.titleFa,
      titleEn: row.titleEn,
      bodyFa: row.bodyFa,
      bodyEn: row.bodyEn,
    }),
  );
  assert.equal(row.contentHash, fresh, 'amendment.contentHash has drifted from its own text');
}

// --- the contract draft -------------------------------------------------

test("updateContractDraft changes the draft's title and fee, not the published revision", async () => {
  ok(
    await exec(
      'mutation($c: ID!){ updateContractDraft(contractId: $c, titleFa: "ت", titleEn: "Renamed", amount: "999") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const data = ok(
    await exec(
      'query($id: ID!){ contract(id: $id) { titleEn draft { titleEn amount } revision { titleEn amount } } }',
      { as: f.admin, variables: { id: f.contract.id } },
    ),
  );
  const contract = data.contract as {
    titleEn: string;
    draft: { titleEn: string; amount: string | null };
    revision: { titleEn: string; amount: string | null };
  };
  assert.equal(contract.titleEn, 'Renamed');
  assert.equal(contract.draft.titleEn, 'Renamed');
  assert.equal(contract.draft.amount, '999');
  assert.equal(contract.revision.titleEn, 'Test contract', 'the published revision moved');
});

test('deleteArticle removes it from the draft; the customer keeps reading the published one until the next publish', async () => {
  ok(
    await exec('mutation($c: ID!){ deleteArticle(contractId: $c, number: 2) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );

  const afterDelete = ok(
    await exec(
      'query($id: ID!){ contract(id: $id) { draft { articles { number } } articles { number } } }',
      { as: f.admin, variables: { id: f.contract.id } },
    ),
  );
  const shape = afterDelete.contract as {
    draft: { articles: Array<{ number: number }> };
    articles: Array<{ number: number }>;
  };
  assert.ok(!shape.draft.articles.some((a) => a.number === 2), 'the draft still has article 2');
  assert.ok(shape.articles.some((a) => a.number === 2), 'the customer lost article 2 before republishing');

  ok(
    await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );
  const afterPublish = ok(
    await exec('query($id: ID!){ contract(id: $id) { articles { number } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  const numbers = (afterPublish.contract as { articles: Array<{ number: number }> }).articles.map(
    (a) => a.number,
  );
  assert.ok(!numbers.includes(2), 'article 2 survived a republish after being deleted');
});

// --- the design draft -----------------------------------------------------

test('discardDesignDraft removes the draft; concepts still shows the published revision', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "طرح", labelEn: "Concept") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  ok(
    await exec('mutation($c: ID!){ discardDesignDraft(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );

  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { designDraft { id } concepts { key } } }', {
      as: f.admin,
      variables: { id: f.contract.id },
    }),
  );
  const shape = data.contract as { designDraft: unknown; concepts: Array<{ key: string }> };
  assert.equal(shape.designDraft, null);
  assert.deepEqual(shape.concepts.map((c) => c.key).sort(), ['1a', '1b', '1c']);
});

test('updateConcept refuses on a published revision', async () => {
  const published = await prisma.designConcept.findFirstOrThrow({
    where: { designRevisionId: f.designRevision.id },
  });
  const r = await exec(
    'mutation($id: ID!){ updateConcept(conceptId: $id, labelFa: "x", labelEn: "y") { id } }',
    { as: f.admin, variables: { id: published.id } },
  );
  assert.equal(r.code, 'REVISION_PUBLISHED');
});

test('publishDesignRevision refuses NO_CHANGES when the draft matches the published revision exactly (D6)', async () => {
  const added = ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "ط", labelEn: "C") { designDraft { concepts { id key } } } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const concepts = (
    added.addConcept as { designDraft: { concepts: Array<{ id: string; key: string }> } }
  ).designDraft.concepts;
  const extra = concepts.find((c) => c.key === '1d')!;
  // Undo the only real change, leaving a draft that is byte-for-byte the
  // clone draftDesignRevision started from.
  ok(
    await exec('mutation($id: ID!){ deleteConcept(conceptId: $id) { id } }', {
      as: f.admin,
      variables: { id: extra.id },
    }),
  );

  const r = await exec('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', {
    as: f.admin,
    variables: { c: f.contract.id },
  });
  assert.equal(r.code, 'NO_CHANGES');
});

test('the partial unique index refuses a second draft design revision (D5)', async () => {
  // Triggers draftDesignRevision, which creates the one legal draft.
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "ط", labelEn: "C") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  await assert.rejects(
    prisma.designRevision.create({ data: { contractId: f.contract.id, version: 99 } }),
    /Unique constraint/,
  );
});

// --- the amendment lifecycle ------------------------------------------------

test('the amendment hash invariant holds across issue and three updates', async () => {
  await signBase();
  const issued = ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T1", bodyFa: "ب", bodyEn: "B1") { revision { amendments { id } } } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const amendmentId = (
    issued.issueAmendment as { revision: { amendments: Array<{ id: string }> } }
  ).revision.amendments[0].id;
  await assertAmendmentHashHolds(amendmentId);

  for (const [n, body] of [
    ['T2', 'B2'],
    ['T3', 'B3'],
    ['T4', 'B4'],
  ] as const) {
    ok(
      await exec(
        'mutation($id: ID!, $t: String!, $b: String!){ updateAmendment(amendmentId: $id, titleFa: "ت", titleEn: $t, bodyFa: "ب", bodyEn: $b) { id } }',
        { as: f.admin, variables: { id: amendmentId, t: n, b: body } },
      ),
    );
    await assertAmendmentHashHolds(amendmentId);
  }
});

test('updateAmendment on a published amendment is refused', async () => {
  await signBase();
  const issued = ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T1", bodyFa: "ب", bodyEn: "B1") { revision { amendments { id } } } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const amendmentId = (
    issued.issueAmendment as { revision: { amendments: Array<{ id: string }> } }
  ).revision.amendments[0].id;
  ok(
    await exec('mutation($id: ID!){ publishAmendment(amendmentId: $id) { id } }', {
      as: f.admin,
      variables: { id: amendmentId },
    }),
  );

  const r = await exec(
    'mutation($id: ID!){ updateAmendment(amendmentId: $id, titleFa: "x", titleEn: "y", bodyFa: "z", bodyEn: "w") { id } }',
    { as: f.admin, variables: { id: amendmentId } },
  );
  assert.equal(r.code, 'REVISION_PUBLISHED');
});

test('the full amendment path: sign, refuse a new revision, issue, publish, approve, sign — base untouched', async () => {
  await signBase();

  // Once signed, a v2 contract revision is refused; the way forward is an amendment.
  const refused = await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
    as: f.admin,
    variables: { c: f.contract.id },
  });
  assert.equal(refused.code, 'CONTRACT_SIGNED');

  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "الحاقیه", titleEn: "Amendment", bodyFa: "متن", bodyEn: "Text", relatesToArticle: 4) { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const amendmentId = await prisma.amendment
    .findFirstOrThrow({ where: { contractRevisionId: f.contractRevision.id } })
    .then((a) => a.id);

  ok(
    await exec('mutation($id: ID!){ publishAmendment(amendmentId: $id) { id } }', {
      as: f.admin,
      variables: { id: amendmentId },
    }),
  );

  const seen = ok(
    await exec(
      'query($id: ID!){ contract(id: $id) { revision { amendments { id ordinal relatesToArticle publishedAt } } } }',
      { as: f.customer, variables: { id: f.contract.id } },
    ),
  );
  const customerAmendments = (
    seen.contract as { revision: { amendments: Array<{ id: string; relatesToArticle: number | null }> } }
  ).revision.amendments;
  assert.equal(customerAmendments.length, 1);
  assert.equal(customerAmendments[0].id, amendmentId);
  assert.equal(customerAmendments[0].relatesToArticle, 4);

  ok(
    await exec('mutation($id: ID!){ approveAmendment(amendmentId: $id) { id } }', {
      as: f.customer,
      variables: { id: amendmentId },
    }),
  );
  const signed = ok(
    await exec(
      'mutation($id: ID!, $n: String!){ signAmendment(amendmentId: $id, typedName: $n) { id gate { signed } signature { typedName } } }',
      { as: f.customer, variables: { id: amendmentId, n: 'Customer' } },
    ),
  );
  const result = signed.signAmendment as { gate: { signed: boolean }; signature: { typedName: string } };
  assert.equal(result.gate.signed, true, 'the base signature stopped counting as signed');
  assert.equal(result.signature.typedName, 'Customer', 'the base signature moved');

  const amendmentSignature = await prisma.signature.findFirstOrThrow({
    where: { amendmentId },
  });
  assert.equal(amendmentSignature.signedHash, (await prisma.amendment.findUniqueOrThrow({ where: { id: amendmentId } })).contentHash);
});

test('a customer cannot see an unpublished amendment', async () => {
  await signBase();
  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T", bodyFa: "ب", bodyEn: "B") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const asCustomer = ok(
    await exec('query($id: ID!){ contract(id: $id) { revision { amendments { id } } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  assert.deepEqual(
    (asCustomer.contract as { revision: { amendments: unknown[] } }).revision.amendments,
    [],
  );
});

test('a customer is refused every admin amendment mutation; approveAmendment on an unpublished one is refused', async () => {
  await signBase();
  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T", bodyFa: "ب", bodyEn: "B") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const amendmentId = await prisma.amendment
    .findFirstOrThrow({ where: { contractRevisionId: f.contractRevision.id } })
    .then((a) => a.id);

  assert.equal(
    (
      await exec(
        'mutation($id: ID!){ updateAmendment(amendmentId: $id, titleFa: "x", titleEn: "y", bodyFa: "z", bodyEn: "w") { id } }',
        { as: f.customer, variables: { id: amendmentId } },
      )
    ).code,
    'FORBIDDEN',
  );
  assert.equal(
    (
      await exec('mutation($id: ID!){ publishAmendment(amendmentId: $id) { id } }', {
        as: f.customer,
        variables: { id: amendmentId },
      })
    ).code,
    'FORBIDDEN',
  );
  assert.equal(
    (
      await exec('mutation($id: ID!){ approveAmendment(amendmentId: $id) { id } }', {
        as: f.customer,
        variables: { id: amendmentId },
      })
    ).code,
    'AMENDMENT_UNPUBLISHED',
  );
});

test("approveAmendment on someone else's contract is NOT_FOUND, not FORBIDDEN", async () => {
  await signBase();
  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T", bodyFa: "ب", bodyEn: "B") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const amendmentId = await prisma.amendment
    .findFirstOrThrow({ where: { contractRevisionId: f.contractRevision.id } })
    .then((a) => a.id);
  ok(
    await exec('mutation($id: ID!){ publishAmendment(amendmentId: $id) { id } }', {
      as: f.admin,
      variables: { id: amendmentId },
    }),
  );

  const r = await exec('mutation($id: ID!){ approveAmendment(amendmentId: $id) { id } }', {
    as: f.stranger,
    variables: { id: amendmentId },
  });
  assert.equal(r.code, 'NOT_FOUND');
});

// --- the odd one out: scope, and the convenience template -------------------

test('updateScopeItem is visible to the customer immediately, with no draft or publish', async () => {
  const added = ok(
    await exec(
      'mutation($c: ID!){ addScopeItem(contractId: $c, key: "bilingual", labelFa: "الف", labelEn: "First") { scopeItems { id key } } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const item = (added.addScopeItem as { scopeItems: Array<{ id: string; key: string }> }).scopeItems.find(
    (s) => s.key === 'bilingual',
  )!;
  ok(
    await exec(
      'mutation($id: ID!){ updateScopeItem(scopeItemId: $id, labelFa: "جدید", labelEn: "New label") { id } }',
      { as: f.admin, variables: { id: item.id } },
    ),
  );
  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { scopeItems { id labelEn } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  const updated = (data.contract as { scopeItems: Array<{ id: string; labelEn: string }> }).scopeItems.find(
    (s) => s.id === item.id,
  );
  assert.equal(updated?.labelEn, 'New label');
});

test('applyContractTemplate refuses a contract that already has articles, and fills an empty one', async () => {
  const already = await exec('mutation($c: ID!){ applyContractTemplate(contractId: $c) { id } }', {
    as: f.admin,
    variables: { c: f.contract.id },
  });
  assert.equal(already.code, 'TEMPLATE_NOT_EMPTY');

  const empty = await prisma.contract.create({
    data: { ref: 'RC-EMPTY-1', titleFa: 'خالی', titleEn: 'Empty', customerId: f.customer.id },
  });
  const data = ok(
    await exec(
      'mutation($c: ID!){ applyContractTemplate(contractId: $c) { draft { articles { number } } scopeItems { key } } }',
      { as: f.admin, variables: { c: empty.id } },
    ),
  );
  const filled = data.applyContractTemplate as {
    draft: { articles: Array<{ number: number }> };
    scopeItems: Array<{ key: string }>;
  };
  assert.equal(filled.draft.articles.length, 15);
  assert.equal(filled.scopeItems.length, 6);
});
