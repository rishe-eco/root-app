import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import {
  prisma,
  resetDatabase,
  seedFixture,
  completeDesign,
  approveContract,
  type Fixture,
} from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * The resolvers, against a real database.
 *
 * Two things are checked here that no unit test can reach: **who may do what**
 * (ownership and role, which live in loadForActor and requireRole), and
 * **which refusal comes back** for each way of asking too early. The error
 * codes matter as much as the behaviour — the client branches on them.
 *
 * The bugs this layer has actually produced, both found by hand in a browser:
 * a guard that reopened the design step and then refused every action that
 * could close it, and a resolver that would dereference a null revision id.
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

// --- who can see what -------------------------------------------------------

test('an anonymous caller gets nothing and is told why', async () => {
  const r = await exec('{ myContracts { ref } }');
  assert.equal(r.code, 'UNAUTHENTICATED');
});

test('a customer sees their own contract', async () => {
  const data = ok(await exec('{ myContracts { ref } }', { as: f.customer }));
  assert.deepEqual(data.myContracts, [{ ref: 'RC-TEST-001' }]);
});

test("a customer cannot read another customer's contract by id", async () => {
  // The id is not a secret — it is in the URL. Ownership is what protects it.
  const r = await exec('query($id: ID!){ contract(id: $id) { ref } }', {
    as: f.stranger,
    variables: { id: f.contract.id },
  });
  assert.equal(r.data?.contract ?? null, null);
});

test("a customer cannot act on another customer's contract", async () => {
  const concept = await prisma.designConcept.findFirstOrThrow({
    where: { designRevisionId: f.designRevision.id },
  });
  const r = await exec('mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', {
    as: f.stranger,
    variables: { c: f.contract.id, k: concept.id },
  });
  assert.notEqual(r.errors.length, 0, 'a stranger was allowed to choose a concept');
});

test('a customer is refused the admin queries', async () => {
  assert.equal((await exec('{ allContracts { ref } }', { as: f.customer })).code, 'FORBIDDEN');
  assert.equal((await exec('{ allCustomers { email } }', { as: f.customer })).code, 'FORBIDDEN');
});

test('an admin sees every contract', async () => {
  const data = ok(await exec('{ allContracts { ref } }', { as: f.admin }));
  assert.equal((data.allContracts as unknown[]).length, 1);
});

// --- the gate, enforced on the server --------------------------------------

test('approving is refused while the design is incomplete', async () => {
  const r = await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', {
    as: f.customer,
    variables: { c: f.contract.id },
  });
  assert.equal(r.code, 'GATE_DESIGN_INCOMPLETE');
});

test('signing is refused before approval, even with the design complete', async () => {
  await completeDesign(f);
  const r = await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
    as: f.customer,
    variables: { c: f.contract.id, n: 'Customer' },
  });
  assert.equal(r.code, 'GATE_CONTRACT_UNAPPROVED');
});

test('the full sequence works in order', async () => {
  await completeDesign(f);
  ok(
    await exec('mutation($c: ID!){ approveContract(contractId: $c) { gate { contractApproved } } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  );
  const data = ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { gate { signed } } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
  assert.deepEqual(data.signContract, { gate: { signed: true } });
});

test('signing twice is refused', async () => {
  await completeDesign(f);
  await approveContract(f);
  const sign = () =>
    exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    });
  ok(await sign());
  assert.equal((await sign()).code, 'ALREADY_SIGNED');
});

test('a signature binds to the revision it signed, by hash', async () => {
  await completeDesign(f);
  await approveContract(f);
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );

  const signature = await prisma.signature.findFirstOrThrow({
    where: { contractRevisionId: f.contractRevision.id },
  });
  assert.equal(signature.signedHash, f.contractRevision.contentHash);
  assert.equal(signature.signerId, f.customer.id);
  // req.ip is stubbed in the harness; this asserts it is recorded at all,
  // which is the half that is this layer's business.
  assert.equal(signature.ip, '203.0.113.7');
});

test('commenting is never gated', async () => {
  // Nothing has been chosen or approved; a comment must still land.
  const data = ok(
    await exec('mutation($c: ID!, $b: String!){ addComment(contractId: $c, body: $b) { comments { body } } }', {
      as: f.customer,
      variables: { c: f.contract.id, b: 'A question about article 2.' },
    }),
  );
  const comments = (data.addComment as { comments: Array<{ body: string }> }).comments;
  assert.ok(comments.some((c) => c.body === 'A question about article 2.'));
});

// --- the two lineages -------------------------------------------------------

test('publishing a contract revision is refused once signed', async () => {
  await completeDesign(f);
  await approveContract(f);
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );

  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "x", titleEn: "Changed", bodyEn: "New body") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const r = await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
    as: f.admin,
    variables: { c: f.contract.id },
  });
  assert.equal(r.code, 'CONTRACT_SIGNED');
});

test('an admin edit stays in the draft — the customer keeps reading the snapshot', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "ویرایش", titleEn: "Edited", bodyEn: "Draft body") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { articles { number titleEn bodyEn } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  const first = (data.contract as { articles: Array<{ number: number; titleEn: string }> }).articles.find(
    (a) => a.number === 1,
  );
  assert.equal(first?.titleEn, 'Article 1', 'the published snapshot changed under the customer');
});

test('republishing with no changes is refused', async () => {
  const r = await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
    as: f.admin,
    variables: { c: f.contract.id },
  });
  assert.equal(r.code, 'NO_CHANGES');
});

test('publishing a contract revision bumps the version and reseals', async () => {
  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "ویرایش", titleEn: "Edited", bodyEn: "New body") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  ok(
    await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );

  const revisions = await prisma.contractRevision.findMany({
    where: { contractId: f.contract.id },
    orderBy: { version: 'asc' },
  });
  assert.equal(revisions.length, 2);
  assert.notEqual(revisions[1].contentHash, revisions[0].contentHash);
  assert.ok(revisions[0].supersededAt, 'v1 was left un-superseded');

  // …and now the customer reads the new text.
  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { articles { number titleEn } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  const first = (data.contract as { articles: Array<{ number: number; titleEn: string }> }).articles.find(
    (a) => a.number === 1,
  );
  assert.equal(first?.titleEn, 'Edited');
});

test('a design revision published after signing leaves the signature standing', async () => {
  // The property the two lineages exist for, end to end. This is the shape of
  // the bug that shipped: the design step reopens, and every action that could
  // close it must still be allowed.
  await completeDesign(f);
  await approveContract(f);
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );

  // Root revises one page of the chosen concept, then publishes design v2.
  const chosen = await prisma.designConcept.findFirstOrThrow({
    where: { designRevisionId: f.designRevision.id, chosenAt: { not: null } },
  });
  // Any admin write to the design clones the published revision into a draft;
  // adding a fourth concept is the least intrusive way to ask for one.
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "طرح", labelEn: "Concept", imageUrl: "/img/1d.png") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const draft = await prisma.designRevision.findFirstOrThrow({
    where: { contractId: f.contract.id, publishedAt: null },
    include: { concepts: { include: { pages: true } } },
  });
  const draftConcept = draft.concepts.find((c) => c.key === chosen.key);
  assert.ok(draftConcept, 'the draft revision lost the chosen concept');
  const movedPage = draftConcept.pages.find((p) => p.key === 'home');
  assert.ok(movedPage);
  await prisma.pageDesign.update({
    where: { id: movedPage.id },
    data: { imageUrl: '/img/1a-home-v2.png' },
  });

  ok(
    await exec('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );

  const data = ok(
    await exec(
      'query($id: ID!){ contract(id: $id) { gate { designComplete contractApproved signed approvedPageCount totalPageCount } } }',
      { as: f.customer, variables: { id: f.contract.id } },
    ),
  );
  const gate = (data.contract as { gate: Record<string, unknown> }).gate;

  assert.equal(gate.signed, true, 'a design revision un-signed the contract');
  assert.equal(gate.contractApproved, true, 'a design revision un-approved the contract');
  assert.equal(gate.designComplete, false, 'the changed page did not need re-approval');
  assert.equal(gate.approvedPageCount, 3, 'the three untouched pages did not carry forward');
  assert.equal(gate.totalPageCount, 4);
});

test('the customer can still close the reopened design step', async () => {
  // The exact regression: approvals reset, and then every action that could
  // restore them is refused because the contract is already approved.
  await completeDesign(f);
  await approveContract(f);

  const page = await prisma.pageDesign.findFirstOrThrow({
    where: { concept: { chosenAt: { not: null } } },
  });
  await prisma.pageDesign.update({ where: { id: page.id }, data: { approvedAt: null } });

  const r = await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { gate { designComplete } } }', {
    as: f.customer,
    variables: { p: page.id },
  });
  assert.deepEqual(r.errors, [], 'the customer was locked out of the reopened design step');
  assert.deepEqual(r.data?.setPageApproval, { gate: { designComplete: true } });
});

test('a duplicate concept key is refused cleanly, not as a 500', async () => {
  // How the leak was found: the draft revision is cloned from the published
  // one, so re-adding an existing key hits a unique constraint. It used to
  // surface as INTERNAL_SERVER_ERROR carrying Prisma's invocation text —
  // server paths and schema field names — straight to the caller.
  const r = await exec(
    'mutation($c: ID!){ addConcept(contractId: $c, key: "1a", labelFa: "طرح", labelEn: "Concept") { id } }',
    { as: f.admin, variables: { c: f.contract.id } },
  );
  assert.equal(r.code, 'DUPLICATE_KEY');
  assert.ok(!r.errors[0].message.includes('prisma.'), 'Prisma internals reached the client');
  assert.ok(!r.errors[0].message.includes('/home/'), 'a server path reached the client');
});

// --- history ----------------------------------------------------------------

test('every logged action is one the client can render', async () => {
  // Pairs with changeAction.test.ts: that one proves the enum agrees across
  // five files, this one proves the resolvers only ever write values from it.
  await completeDesign(f);
  await approveContract(f);
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
  ok(
    await exec('mutation($c: ID!, $b: String!){ addComment(contractId: $c, body: $b) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, b: 'Thanks.' },
    }),
  );

  const entries = await prisma.changeLog.findMany({ where: { contractId: f.contract.id } });
  assert.ok(entries.length > 0, 'nothing was logged at all');
  for (const e of entries) {
    assert.match(e.action, /^[A-Z][A-Z0-9_]*$/);
  }
});

// --- the revision, as the printable copy reads it ---------------------------
//
// The print view renders `contract.revision` rather than the contract's own
// fields, so that what a customer prints is what `contentHash` covers. These
// tests hold that property from the API side: if `revision` ever started
// answering with the draft, a signed PDF would attest to words nobody signed.

test('the revision carries the frozen title and fee, not the draft', async () => {
  // Root edits the working copy after publishing. The published revision must
  // not move with it — that is the entire point of freezing a snapshot.
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { titleEn: 'Renamed after publication', amount: BigInt(999) },
  });

  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { titleEn amount revision { version titleEn amount contentHash } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  const contract = data.contract as {
    titleEn: string;
    amount: string;
    revision: { version: number; titleEn: string; amount: string; contentHash: string };
  };

  assert.equal(contract.titleEn, 'Renamed after publication', 'the draft should move');
  assert.equal(contract.revision.titleEn, 'Test contract', 'the revision must not');
  assert.equal(contract.revision.amount, '180000000');
  assert.equal(contract.revision.version, 1);
  assert.equal(contract.revision.contentHash, f.contractRevision.contentHash);
});

test('an unsealed revision reports no revision at all', async () => {
  // A backfilled v1 before `npm run backfill`: there is no snapshot to read a
  // title out of, and inventing one from the draft is the drift this prevents.
  await prisma.contractRevision.update({
    where: { id: f.contractRevision.id },
    data: { snapshot: Prisma.DbNull, contentHash: null },
  });

  const data = ok(
    await exec('query($id: ID!){ contract(id: $id) { revision { version } } }', {
      as: f.customer,
      variables: { id: f.contract.id },
    }),
  );
  assert.equal((data.contract as { revision: unknown }).revision, null);
});

test('a customer reads published amendments only; an admin sees the draft too', async () => {
  const base = {
    contractRevisionId: f.contractRevision.id,
    titleFa: 'الحاقیه',
    titleEn: 'Amendment',
    bodyFa: 'متن',
    bodyEn: 'Body',
  };
  await prisma.amendment.create({
    data: { ...base, ordinal: 1, contentHash: 'a'.repeat(64), publishedAt: new Date() },
  });
  // Root's unpublished draft — the same kind of secret as an unpublished
  // revision, and it must not reach the customer's printed copy.
  await prisma.amendment.create({
    data: { ...base, ordinal: 2, contentHash: 'b'.repeat(64), publishedAt: null },
  });

  const query = 'query($id: ID!){ contract(id: $id) { revision { amendments { ordinal } } } }';
  const read = async (as: typeof f.customer) => {
    const data = ok(await exec(query, { as, variables: { id: f.contract.id } }));
    const revision = (data.contract as { revision: { amendments: Array<{ ordinal: number }> } })
      .revision;
    return revision.amendments.map((a) => a.ordinal);
  };

  assert.deepEqual(await read(f.customer), [1]);
  assert.deepEqual(await read(f.admin), [1, 2]);
});
