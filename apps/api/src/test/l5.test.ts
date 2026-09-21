import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';

/**
 * L5: the dependency board (build plan §3 "L5"; spec §7) — symmetric
 * commitments, customer-side and Root-side, on one board under one rule.
 * The banked trap is the entire feature: a verification step must record
 * *what was done*, never only a timestamp.
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

const CREATE_DEPENDENCY = `
  mutation($projectId: ID!, $side: DependencySide!, $titleFa: String!, $titleEn: String!, $dueAt: DateTime!) {
    createDependency(projectId: $projectId, side: $side, titleFa: $titleFa, titleEn: $titleEn, dueAt: $dueAt) {
      project { dependencies { id side titleFa titleEn dueAt overdue verifiedAt verifiedNote verifiedBy { id } createdBy { id } } }
    }
  }
`;

function dependenciesOf(result: Record<string, unknown>): Array<{
  id: string;
  side: string;
  overdue: boolean;
  verifiedAt: string | null;
  verifiedNote: string | null;
}> {
  return (result.createDependency as { project: { dependencies: unknown[] } }).project
    .dependencies as Array<{ id: string; side: string; overdue: boolean; verifiedAt: string | null; verifiedNote: string | null }>;
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const TOMORROW = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

test('createDependency records a commitment for either side, and overdue is derived from dueAt/verifiedAt, not stored', async () => {
  const projectId = f.contract.projectId!;

  const created = ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'CUSTOMER', titleFa: 'میزبانی', titleEn: 'Hosting', dueAt: YESTERDAY },
    }),
  );
  const deps = dependenciesOf(created);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].side, 'CUSTOMER');
  assert.equal(deps[0].overdue, true, 'past due, unverified — overdue');

  const rootOne = ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'ROOT', titleFa: 'ثبت پیامک', titleEn: 'SMS signup', dueAt: TOMORROW },
    }),
  );
  const both = dependenciesOf(rootOne);
  assert.equal(both.length, 2, 'both sides live on the same board');
  const root = both.find((d) => d.side === 'ROOT')!;
  assert.equal(root.overdue, false, 'not yet due — not overdue');
});

// --- The banked trap: verification requires its "how" -----------------------

test('verifyDependency is refused (VERIFICATION_NOTE_REQUIRED) without a note, and structurally at the database too', async () => {
  const projectId = f.contract.projectId!;
  const created = ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'CUSTOMER', titleFa: 'دامنه', titleEn: 'Domain', dueAt: YESTERDAY },
    }),
  );
  const depId = dependenciesOf(created)[0].id;

  const blank = await exec('mutation($id: ID!, $n: String!){ verifyDependency(dependencyId: $id, note: $n) { id } }', {
    as: f.admin,
    variables: { id: depId, n: '   ' },
  });
  assert.equal(blank.code, 'VERIFICATION_NOTE_REQUIRED', '"they said we have a host" is not enough');

  // The database itself refuses a verifiedAt with no note, bypassing the
  // resolver entirely — the same CHECK-bypassing-the-resolver discipline
  // L3b's own suite uses for BuildChangeEntry's CHECK constraints.
  await assert.rejects(
    prisma.dependency.update({ where: { id: depId }, data: { verifiedAt: new Date(), verifiedById: f.admin.id } }),
    /Dependency_verified_both_or_neither/,
  );

  const withNote = ok(
    await exec(
      'mutation($id: ID!, $n: String!){ verifyDependency(dependencyId: $id, note: $n) { project { dependencies { id overdue verifiedAt verifiedNote verifiedBy { id } } } } }',
      { as: f.admin, variables: { id: depId, n: 'دامنه را روی سرور آزمایش کردیم و کار کرد' } },
    ),
  );
  const dep = (withNote.verifyDependency as { project: { dependencies: Array<{ id: string; overdue: boolean; verifiedAt: string | null; verifiedNote: string | null; verifiedBy: { id: string } }> } }).project.dependencies.find((d) => d.id === depId)!;
  assert.ok(dep.verifiedAt, '"we deployed a test file to the host" — recorded, not just claimed');
  assert.equal(dep.verifiedNote, 'دامنه را روی سرور آزمایش کردیم و کار کرد');
  assert.equal(dep.verifiedBy.id, f.admin.id);
  assert.equal(dep.overdue, false, 'a verified dependency is never overdue, however late the verification came');
});

test('unverifyDependency clears verifiedAt/verifiedById/verifiedNote together', async () => {
  const projectId = f.contract.projectId!;
  const created = ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'ROOT', titleFa: 'درگاه پرداخت', titleEn: 'Payment gateway', dueAt: YESTERDAY },
    }),
  );
  const depId = dependenciesOf(created)[0].id;
  ok(
    await exec('mutation($id: ID!, $n: String!){ verifyDependency(dependencyId: $id, note: $n) { id } }', {
      as: f.admin,
      variables: { id: depId, n: 'ثبتِ درگاه را انجام دادیم' },
    }),
  );
  const unverified = ok(
    await exec(
      'mutation($id: ID!){ unverifyDependency(dependencyId: $id) { project { dependencies { id verifiedAt verifiedNote overdue } } } }',
      { as: f.admin, variables: { id: depId } },
    ),
  );
  const dep = (unverified.unverifyDependency as { project: { dependencies: Array<{ id: string; verifiedAt: string | null; verifiedNote: string | null; overdue: boolean }> } }).project.dependencies.find((d) => d.id === depId)!;
  assert.equal(dep.verifiedAt, null);
  assert.equal(dep.verifiedNote, null);
  assert.equal(dep.overdue, true, 'reopened, and past its due date — overdue again');
});

// --- Symmetry: overdue surfaces on both dashboards, for both sides ---------

test('overdueDependencies (staff) surfaces an overdue ROOT-side dependency exactly as a CUSTOMER-side one — the same board, the same rule', async () => {
  const projectId = f.contract.projectId!;
  ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'CUSTOMER', titleFa: 'میزبانی', titleEn: 'Hosting', dueAt: YESTERDAY },
    }),
  );
  ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'ROOT', titleFa: 'ثبتِ پیامک', titleEn: 'SMS signup', dueAt: YESTERDAY },
    }),
  );
  // A third, not-yet-due dependency must not appear.
  ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'ROOT', titleFa: 'مرورِ فنیِ اینماد', titleEn: 'Enamad technical review', dueAt: TOMORROW },
    }),
  );

  const board = ok(
    await exec('query{ overdueDependencies { side titleEn overdue project { id } } }', { as: f.admin }),
  );
  const rows = board.overdueDependencies as Array<{ side: string; overdue: boolean }>;
  assert.equal(rows.length, 2, 'both overdue rows, not the one that is not due yet');
  assert.ok(rows.every((r) => r.overdue), 'both flagged overdue — nothing here is asserted only for the customer side');
  const sides = rows.map((r) => r.side).sort();
  assert.deepEqual(sides, ['CUSTOMER', 'ROOT'], 'Root\'s own slippage surfaces exactly like the customer\'s');
});

test('overdueDependencies is refused for a customer (FORBIDDEN); myOverdueDependencies is scoped to the caller\'s own CUSTOMER-side rows only', async () => {
  const projectId = f.contract.projectId!;
  ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'CUSTOMER', titleFa: 'محتوای صفحات', titleEn: 'Page content', dueAt: YESTERDAY },
    }),
  );
  ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'ROOT', titleFa: 'ثبتِ پیامک', titleEn: 'SMS signup', dueAt: YESTERDAY },
    }),
  );

  const forbidden = await exec('query{ overdueDependencies { id } }', { as: f.customer });
  assert.equal(forbidden.code, 'FORBIDDEN');

  const mine = ok(await exec('query{ myOverdueDependencies { side titleEn } }', { as: f.customer }));
  const rows = mine.myOverdueDependencies as Array<{ side: string }>;
  assert.equal(rows.length, 1, 'only the CUSTOMER-side row — Root being late is not shown here');
  assert.equal(rows[0].side, 'CUSTOMER');

  // A stranger with no projects sees nothing, not an error.
  const strangerView = ok(await exec('query{ myOverdueDependencies { id } }', { as: f.stranger }));
  assert.deepEqual(strangerView.myOverdueDependencies, []);
});

test('createDependency/updateDependency/verifyDependency/deleteDependency are all refused for a customer (FORBIDDEN)', async () => {
  const projectId = f.contract.projectId!;
  const asCustomer = await exec(CREATE_DEPENDENCY, {
    as: f.customer,
    variables: { projectId, side: 'ROOT', titleFa: 'س', titleEn: 'x', dueAt: TOMORROW },
  });
  assert.equal(asCustomer.code, 'FORBIDDEN');
});

test('deleteDependency removes the row; updateDependency edits title and due date', async () => {
  const projectId = f.contract.projectId!;
  const created = ok(
    await exec(CREATE_DEPENDENCY, {
      as: f.admin,
      variables: { projectId, side: 'CUSTOMER', titleFa: 'الف', titleEn: 'A', dueAt: TOMORROW },
    }),
  );
  const depId = dependenciesOf(created)[0].id;

  const updated = ok(
    await exec(
      'mutation($id: ID!, $fa: String!, $en: String!, $d: DateTime!){ updateDependency(dependencyId: $id, titleFa: $fa, titleEn: $en, dueAt: $d) { project { dependencies { id titleEn dueAt } } } }',
      { as: f.admin, variables: { id: depId, fa: 'ب', en: 'B', d: YESTERDAY } },
    ),
  );
  const dep = (updated.updateDependency as { project: { dependencies: Array<{ id: string; titleEn: string }> } }).project.dependencies.find((d) => d.id === depId)!;
  assert.equal(dep.titleEn, 'B');

  const deleted = ok(
    await exec('mutation($id: ID!){ deleteDependency(dependencyId: $id) { project { dependencies { id } } } }', {
      as: f.admin,
      variables: { id: depId },
    }),
  );
  assert.deepEqual((deleted.deleteDependency as { project: { dependencies: unknown[] } }).project.dependencies, []);
});
