import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, upload } from './http.js';

/**
 * S1 — roles, the capability split, visibility, assignment (journeys build
 * plan §5 "S1").
 *
 * The heart of this file is a **generated matrix**: every role × one
 * representative operation per group of the plan's guard-mapping table,
 * asserting the exact outcome — success, `FORBIDDEN`, or `NOT_ASSIGNED`. The
 * table is written out below as data, so a changed guard shows up as a
 * changed cell rather than as a test someone forgot to add. The unit tables
 * (`capabilities.test.ts`, `visibility.test.ts`) prove the rules; this proves
 * every resolver group actually *asks* them.
 *
 * Then the plan's acceptance checks, one each: D-2 closed (a developer loads
 * a demo), `readActive` hiding a discarded contract, money withheld from
 * design and development, assignment's two refusals, and the design-image
 * upload guard (the plan's "files.ts reads capabilities too" trap).
 */

type Outcome = 'OK' | 'FORBIDDEN' | 'NOT_ASSIGNED';

let f: Fixture;
const staff: Record<string, User> = {};
let phaseId: string;
let demoId: string;
let dependencyId: string;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  // A second designer and developer, assigned to nothing — the NOT_ASSIGNED row.
  staff.DESIGNER_UNASSIGNED = await prisma.user.create({
    data: { email: 'designer2@test.local', name: 'Designer 2', roles: ['DESIGNER'], state: 'ACTIVE' },
  });
  staff.DEVELOPER_UNASSIGNED = await prisma.user.create({
    data: { email: 'developer2@test.local', name: 'Developer 2', roles: ['DEVELOPER'], state: 'ACTIVE' },
  });
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });

  const projectId = f.contract.projectId!;
  const phase = await prisma.phase.create({ data: { projectId, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  phaseId = phase.id;
  const demo = await prisma.demo.create({ data: { phaseId, stagingUrl: 'https://nahal.staging.m-root.com' } });
  demoId = demo.id;
  const dep = await prisma.dependency.create({
    data: {
      projectId,
      side: 'CUSTOMER',
      titleFa: 'محتوا',
      titleEn: 'Content',
      dueAt: new Date('2026-10-01T00:00:00Z'),
      createdById: f.admin.id,
    },
  });
  dependencyId = dep.id;
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

/** Who is asking, by row label. */
function actor(label: string): User {
  if (label === 'ADMIN') return f.admin;
  if (label === 'CUSTOMER') return f.customer;
  return staff[label];
}

/**
 * One operation per group of the plan's mapping table. Each returns the
 * result of the call; the matrix below says what it must be for whom.
 */
const OPS: Record<string, (as: User) => ReturnType<typeof exec>> = {
  'contracts.author · draft edit': (as) =>
    exec('mutation($c: ID!){ updateContractDraft(contractId: $c, titleFa: "ت", titleEn: "T") { id } }', {
      as,
      variables: { c: f.contract.id },
    }),
  'contracts.author · phase CRUD': (as) =>
    exec('mutation($c: ID!){ createPhase(contractId: $c, number: 9, titleFa: "ف", titleEn: "P") { id } }', {
      as,
      variables: { c: f.contract.id },
    }),
  'contracts.author · dependency write': (as) =>
    exec(
      'mutation($p: ID!){ createDependency(projectId: $p, side: ROOT, titleFa: "د", titleEn: "D", dueAt: "2026-11-01T00:00:00Z") { id } }',
      { as, variables: { p: f.contract.projectId } },
    ),
  'contracts.readAll · status counts': (as) =>
    exec('{ allContractStatusCounts { status count } }', { as }),
  'contracts.read* · contract list': (as) => exec('{ allContracts { id } }', { as }),
  'design.author · add concept': (as) =>
    exec('mutation($c: ID!){ addConcept(contractId: $c, key: "9z", labelFa: "ط", labelEn: "C") { id } }', {
      as,
      variables: { c: f.contract.id },
    }),
  'builds.author · demo CRUD': (as) =>
    exec('mutation($p: ID!){ createDemo(phaseId: $p, stagingUrl: "https://nahal.staging.m-root.com") { id } }', {
      as,
      variables: { p: phaseId },
    }),
  'builds.author · builds queue': (as) =>
    exec('query($p: ID!){ openFeedbackQueue(projectId: $p) { id } }', { as, variables: { p: f.contract.projectId } }),
  'dependencies.verifyGeneral · verify': (as) =>
    exec('mutation($d: ID!){ verifyDependency(dependencyId: $d, note: "checked the files") { id } }', {
      as,
      variables: { d: dependencyId },
    }),
  'billing.manage · ledger': (as) => exec('{ allBillingEntries { id } }', { as }),
  'tickets.answer · desk queue': (as) => exec('{ allTickets { id } }', { as }),
  'customers.manage · service runs': (as) => exec('{ allServiceRuns { id } }', { as }),
  'contracts.author · assign': (as) =>
    exec('mutation($c: ID!, $d: ID){ assignContract(contractId: $c, designerId: $d) { id } }', {
      as,
      variables: { c: f.contract.id, d: staff.DESIGNER.id },
    }),
};

const F = 'FORBIDDEN' as const;
const N = 'NOT_ASSIGNED' as const;

/**
 * The matrix. Columns: ADMIN, SALES, DESIGNER, DESIGNER_UNASSIGNED,
 * DEVELOPER, DEVELOPER_UNASSIGNED, CONTRIBUTOR, REVIEWER, CUSTOMER.
 */
const COLUMNS = [
  'ADMIN',
  'SALES',
  'DESIGNER',
  'DESIGNER_UNASSIGNED',
  'DEVELOPER',
  'DEVELOPER_UNASSIGNED',
  'CONTRIBUTOR',
  'REVIEWER',
  'CUSTOMER',
] as const;

const MATRIX: Record<keyof typeof OPS, Outcome[]> = {
  //                                        ADM   SAL   DES   DES2  DEV   DEV2  CON  REV  CUS
  'contracts.author · draft edit':        ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.author · phase CRUD':        ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.author · dependency write':  ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.readAll · status counts':    ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.read* · contract list':      ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', F,   F,   F],
  'design.author · add concept':          ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'builds.author · demo CRUD':            ['OK', F,    F,    F,    'OK', N,    F,   F,   F],
  'builds.author · builds queue':         ['OK', F,    F,    F,    'OK', N,    F,   F,   F],
  'dependencies.verifyGeneral · verify':  ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · ledger':              ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'tickets.answer · desk queue':          ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'customers.manage · service runs':      ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.author · assign':            ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
};

for (const [op, row] of Object.entries(MATRIX)) {
  COLUMNS.forEach((who, i) => {
    const expected = row[i];
    test(`matrix · ${op} · ${who} → ${expected}`, async () => {
      const result = await OPS[op](actor(who));
      if (expected === 'OK') ok(result);
      else assert.equal(result.code, expected, `${who} on ${op}: got ${result.code ?? 'success'}`);
    });
  });
}

// ---------------------------------------------------------------------------
// The plan's acceptance checks, one each.

test('D-2 closed: the assigned developer loads a demo through the ownership loader', async () => {
  // reportDemoPath goes through loadDemoForActor — the loader D-2 was about.
  ok(
    await exec('mutation($d: ID!){ reportDemoPath(demoId: $d, path: "/about") { normalizedPath } }', {
      as: staff.DEVELOPER,
      variables: { d: demoId },
    }),
  );
});

test('readActive: a designer can read an active contract and not a discarded one', async () => {
  const q = 'query($id: ID!){ contract(id: $id) { id } }';
  const before = ok(await exec(q, { as: staff.DESIGNER, variables: { id: f.contract.id } }));
  assert.ok(before.contract);

  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  const after = await exec(q, { as: staff.DESIGNER, variables: { id: f.contract.id } });
  assert.equal(after.code, 'NOT_FOUND');
  // …and it drops out of their list too — the list and the link agree.
  const list = ok(await exec('{ allContracts { id } }', { as: staff.DESIGNER }));
  assert.deepEqual(list.allContracts, []);
  // Sales still sees it: readAll.
  ok(await exec(q, { as: staff.SALES, variables: { id: f.contract.id } }));
});

test('money: design and development read the contract without its fee; sales and the customer with it', async () => {
  const q = 'query($id: ID!){ contract(id: $id) { amount revision { amount } draft { amount } } }';
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    const data = ok(await exec(q, { as: who, variables: { id: f.contract.id } })) as {
      contract: { amount: string | null; revision: { amount: string | null } | null; draft: unknown };
    };
    assert.equal(data.contract.amount, null, who.email!);
    assert.equal(data.contract.revision?.amount ?? null, null, who.email!);
    assert.equal(data.contract.draft, null, `${who.email} gets no draft`);
  }
  const sales = ok(await exec(q, { as: staff.SALES, variables: { id: f.contract.id } })) as {
    contract: { amount: string | null; draft: { amount: string | null } | null };
  };
  assert.equal(sales.contract.amount, '180000000');
  assert.equal(sales.contract.draft?.amount, '180000000');
  const customer = ok(await exec(q, { as: f.customer, variables: { id: f.contract.id } })) as {
    contract: { amount: string | null };
  };
  assert.equal(customer.contract.amount, '180000000');
});

test('assignContract refuses someone who cannot do the job, and a disabled account', async () => {
  const m = 'mutation($c: ID!, $d: ID, $v: ID){ assignContract(contractId: $c, designerId: $d, developerId: $v) { designer { id } developer { id } } }';
  const wrongJob = await exec(m, { as: staff.SALES, variables: { c: f.contract.id, d: staff.DEVELOPER.id } });
  assert.equal(wrongJob.code, 'ASSIGNEE_LACKS_CAPABILITY');

  await prisma.user.update({ where: { id: staff.DESIGNER_UNASSIGNED.id }, data: { state: 'DISABLED' } });
  const disabled = await exec(m, { as: staff.SALES, variables: { c: f.contract.id, d: staff.DESIGNER_UNASSIGNED.id } });
  assert.equal(disabled.code, 'ASSIGNEE_INACTIVE');

  // Omitted leaves as is; null unassigns.
  const cleared = ok(await exec(m, { as: staff.SALES, variables: { c: f.contract.id, v: null } })) as {
    assignContract: { designer: { id: string } | null; developer: { id: string } | null };
  };
  assert.equal(cleared.assignContract.designer?.id, staff.DESIGNER.id);
  assert.equal(cleared.assignContract.developer, null);
});

test('createContract takes both assignees, and refuses a wrong one before creating anything', async () => {
  const m = `mutation($i: CreateContractInput!){ createContract(input: $i) { designer { id } developer { id } } }`;
  const base = { customerId: f.customer.id, titleFa: 'ق', titleEn: 'C' };
  const made = ok(
    await exec(m, {
      as: staff.SALES,
      variables: { i: { ...base, ref: 'RC-S1-1', designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id } },
    }),
  ) as { createContract: { designer: { id: string }; developer: { id: string } } };
  assert.equal(made.createContract.designer.id, staff.DESIGNER.id);
  assert.equal(made.createContract.developer.id, staff.DEVELOPER.id);

  const projectsBefore = await prisma.project.count();
  const refused = await exec(m, {
    as: staff.SALES,
    variables: { i: { ...base, ref: 'RC-S1-2', designerId: staff.CONTRIBUTOR.id } },
  });
  assert.equal(refused.code, 'ASSIGNEE_LACKS_CAPABILITY');
  assert.equal(await prisma.project.count(), projectsBefore, 'no orphan project left behind');
});

test('the builds queue lists only the projects a developer develops', async () => {
  const q = '{ phasesForBuilds { id } }';
  const mine = ok(await exec(q, { as: staff.DEVELOPER })) as { phasesForBuilds: unknown[] };
  assert.equal(mine.phasesForBuilds.length, 1);
  const theirs = ok(await exec(q, { as: staff.DEVELOPER_UNASSIGNED })) as { phasesForBuilds: unknown[] };
  assert.equal(theirs.phasesForBuilds.length, 0);
  const admin = ok(await exec(q, { as: f.admin })) as { phasesForBuilds: unknown[] };
  assert.equal(admin.phasesForBuilds.length, 1);
});

test('design-image upload: the assigned designer yes, an unassigned one NOT_ASSIGNED, sales FORBIDDEN', async () => {
  // The plan's S1 trap — the upload route reads a capability of its own, and
  // missing it makes uploads 403 for the designer while the resolvers admit them.
  const server = await startFileServer();
  try {
    const mine = await upload(server.base, { as: staff.DESIGNER, contractId: f.contract.id });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    const unassigned = await upload(server.base, { as: staff.DESIGNER_UNASSIGNED, contractId: f.contract.id });
    assert.equal(unassigned.status, 403);
    assert.equal(unassigned.body?.error, 'NOT_ASSIGNED');
    const sales = await upload(server.base, { as: staff.SALES, contractId: f.contract.id });
    assert.equal(sales.status, 403);
    assert.equal(sales.body?.error, 'FORBIDDEN');
  } finally {
    await server.close();
  }
});

test('the Library, the Review Room and tokens are untouched for their roles', async () => {
  // Spot checks of the must-not-break list (plan §0.2) at the capability
  // boundary: the contributor still writes the Library and reaches no
  // contract; the reviewer reaches no contract.
  assert.equal((await exec('{ allContracts { id } }', { as: staff.CONTRIBUTOR })).code, 'FORBIDDEN');
  assert.equal((await exec('{ allContracts { id } }', { as: staff.REVIEWER })).code, 'FORBIDDEN');
  const me = ok(await exec('{ me { capabilities } }', { as: staff.CONTRIBUTOR })) as { me: { capabilities: string[] } };
  assert.deepEqual(me.me.capabilities, ['library.write']);
});
