import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma, type User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, completeDesign, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { buildContractSnapshot, contentHash } from '../lib/revision.js';

/**
 * V3: the customer knowing that something moved, and what. No new
 * re-approval logic (V3.md §1) — this is entirely `pending`, the diff behind
 * it, and the traps around both.
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

const PENDING_QUERY = `
  query($id: ID!) {
    contract(id: $id) {
      gate { designComplete contractApproved signed }
      signature { id }
      pending {
        contractDiff { fromVersion toVersion titleChanged amountChanged articles { number titleFa titleEn kind } }
        designChanges { conceptKey pageKey kind }
        amendment { id approvedAt publishedAt signature { id } }
      }
    }
  }
`;

async function getPending(as: User) {
  const data = ok(await exec(PENDING_QUERY, { as, variables: { id: f.contract.id } }));
  return data.contract as {
    gate: { designComplete: boolean; contractApproved: boolean; signed: boolean };
    signature: { id: string } | null;
    pending: null | {
      contractDiff: null | {
        fromVersion: number;
        toVersion: number;
        titleChanged: boolean;
        amountChanged: boolean;
        articles: Array<{ number: number; titleFa: string; titleEn: string; kind: string }>;
      };
      designChanges: Array<{ conceptKey: string; pageKey: string; kind: string }>;
      amendment: { id: string; approvedAt: string | null; publishedAt: string | null; signature: unknown } | null;
    };
  };
}

/** Approve v1 through the real mutation, so the gate and the log agree with `pending`. */
async function approveV1() {
  await completeDesign(f);
  ok(
    await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  );
}

/** Edit article 1 and publish a v2 contract revision. */
async function publishContractV2(titleEn = 'Article 1, revised') {
  ok(
    await exec(
      'mutation($c: ID!, $t: String!){ setArticle(contractId: $c, number: 1, titleFa: "ماده یک ویرایش‌شده", titleEn: $t, bodyFa: "متن ۱", bodyEn: "Body 1") { id } }',
      { as: f.admin, variables: { c: f.contract.id, t: titleEn } },
    ),
  );
  ok(
    await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );
}

/**
 * Publish a design v2 that changes exactly one page under the concept the
 * customer already chose. `addConcept` is what triggers `draftDesignRevision`
 * — the extra concept it adds is harmless noise here, never chosen. The image
 * edit itself goes straight through Prisma rather than the upload endpoint,
 * matching how `seedFixture` sets `imageUrl` — the upload mechanics are not
 * what this is testing.
 */
async function publishDesignV2WithOneChangedPage(conceptKey = '1a', pageKey = 'home') {
  ok(
    await exec(
      'mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "ط", labelEn: "C") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  const draftPage = await prisma.pageDesign.findFirstOrThrow({
    where: { key: pageKey, concept: { key: conceptKey, designRevision: { contractId: f.contract.id, publishedAt: null } } },
  });
  await prisma.pageDesign.update({
    where: { id: draftPage.id },
    data: { imageUrl: `/img/${conceptKey}-${pageKey}-v2.png` },
  });
  ok(
    await exec('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', {
      as: f.admin,
      variables: { c: f.contract.id },
    }),
  );
}

test('pending is null on the freshly seeded fixture', async () => {
  const { pending } = await getPending(f.customer);
  assert.equal(pending, null);
});

test('approving v1 and publishing v2 names the revision the customer last approved, with the right article marked', async () => {
  await approveV1();
  await publishContractV2();

  const { pending } = await getPending(f.customer);
  assert.ok(pending?.contractDiff, 'contractDiff is present');
  assert.equal(pending.contractDiff.fromVersion, 1);
  assert.equal(pending.contractDiff.toVersion, 2);
  const byNumber = new Map(pending.contractDiff.articles.map((a) => [a.number, a.kind]));
  assert.equal(byNumber.get(1), 'CHANGED');
  assert.equal(byNumber.get(2), 'UNCHANGED');
  assert.equal(byNumber.get(3), 'UNCHANGED');
});

test('publishing a design v2 with one changed page leaves the contract lineage untouched', async () => {
  await approveV1();
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );

  await publishDesignV2WithOneChangedPage();

  const state = await getPending(f.customer);
  assert.equal(state.pending?.designChanges.length, 1, 'exactly one page needs attention, not four');
  assert.deepEqual(state.pending!.designChanges[0], { conceptKey: '1a', pageKey: 'home', kind: 'CHANGED' });
  // The independence property the two-lineage model exists for:
  assert.equal(state.gate.contractApproved, true);
  assert.equal(state.gate.signed, true);
  assert.ok(state.signature, 'the signature is still there');
});

test('approveContract after a revision succeeds, logs RE_APPROVED, and clears pending', async () => {
  await approveV1();
  await publishContractV2();

  const before = await getPending(f.customer);
  assert.ok(before.pending?.contractDiff);

  const approved = ok(
    await exec(
      'mutation($c: ID!){ approveContract(contractId: $c) { changeLog { action } } }',
      { as: f.customer, variables: { c: f.contract.id } },
    ),
  );
  const actions = (approved.approveContract as { changeLog: Array<{ action: string }> }).changeLog.map(
    (e) => e.action,
  );
  assert.ok(actions.includes('RE_APPROVED'));

  const after = await getPending(f.customer);
  assert.equal(after.pending, null);
});

test('an unpublished amendment does not appear in pending.amendment; a published one does', async () => {
  await approveV1();
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
  ok(
    await exec(
      'mutation($c: ID!){ issueAmendment(contractId: $c, titleFa: "ت", titleEn: "T", bodyFa: "ب", bodyEn: "B") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );

  const beforePublish = await getPending(f.customer);
  assert.equal(beforePublish.pending, null, 'an unpublished amendment must not leak into the banner');

  const amendmentId = await prisma.amendment
    .findFirstOrThrow({ where: { contractRevisionId: f.contractRevision.id } })
    .then((a) => a.id);
  ok(
    await exec('mutation($id: ID!){ publishAmendment(amendmentId: $id) { id } }', {
      as: f.admin,
      variables: { id: amendmentId },
    }),
  );

  const afterPublish = await getPending(f.customer);
  assert.equal(afterPublish.pending?.amendment?.id, amendmentId);
  assert.equal(afterPublish.pending?.amendment?.approvedAt, null);
});

test('both lineages moved: pending reports both, and approveContract is refused until the pages are approved (T1)', async () => {
  await approveV1();
  await publishContractV2();
  await publishDesignV2WithOneChangedPage();

  const state = await getPending(f.customer);
  assert.ok(state.pending?.contractDiff, 'the text moved');
  assert.equal(state.pending?.designChanges.length, 1, 'the design moved');

  const refused = await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', {
    as: f.customer,
    variables: { c: f.contract.id },
  });
  assert.equal(refused.code, 'GATE_DESIGN_INCOMPLETE');

  const page = await prisma.pageDesign.findFirstOrThrow({
    where: {
      key: 'home',
      concept: { key: '1a', designRevision: { contractId: f.contract.id, supersededAt: null, publishedAt: { not: null } } },
    },
  });
  ok(
    await exec('mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', {
      as: f.customer,
      variables: { p: page.id },
    }),
  );

  ok(
    await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id },
    }),
  );
});

test('an unsealed v1 as the approved revision renders with everything added, and does not throw (T3)', async () => {
  await prisma.contractRevision.update({
    where: { id: f.contractRevision.id },
    data: { snapshot: Prisma.DbNull, contentHash: null, approvedAt: new Date() },
  });
  const articles = await prisma.article.findMany({ where: { contractId: f.contract.id } });
  const v2Snapshot = buildContractSnapshot(f.contract, articles);
  const v2 = await prisma.contractRevision.create({
    data: {
      contractId: f.contract.id,
      version: 2,
      snapshot: v2Snapshot,
      contentHash: contentHash(v2Snapshot),
      publishedAt: new Date(),
    },
  });
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { currentContractRevisionId: v2.id },
  });

  const { pending } = await getPending(f.customer);
  assert.ok(pending?.contractDiff);
  assert.equal(pending.contractDiff.fromVersion, 1);
  assert.equal(pending.contractDiff.toVersion, 2);
  assert.equal(pending.contractDiff.titleChanged, true);
  assert.equal(pending.contractDiff.amountChanged, true);
  assert.ok(pending.contractDiff.articles.every((a) => a.kind === 'ADDED'));
});
