import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildSchema,
  getNamedType,
  isEnumType,
  isNonNullType,
  isObjectType,
  isScalarType,
  type GraphQLObjectType,
  type GraphQLType,
} from 'graphql';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, completeDesign, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { typeDefs } from '../graphql/typeDefs.js';
import { assertStepOpenOn } from '../graphql/resolvers/wizard.js';

/**
 * J3 — steps, sequence, the wizard shell, the status area, attention,
 * internal notes, view as customer (journeys build plan §5 "J3").
 *
 * The pure rules are proven as tables in `lib/{steps,attention,statusSummary,
 * timeline}.test.ts`; this file proves what only a database and the real
 * resolvers can: the two partial unique indexes by direct insert, the
 * migration's backfill, that the loader hands those rules the right rows, that
 * internal notes reach no customer, and — the one that matters — that **"view
 * as customer" is the customer's own read**, field by field.
 */

let f: Fixture;
const staff: Record<string, User> = {};

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  for (const [i, role] of (['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]).entries()) {
    staff[role] = await prisma.user.create({
      data: {
        email: `${role.toLowerCase()}@test.local`,
        phone: `+98912000020${i}`,
        name: role,
        roles: [role],
        state: 'ACTIVE',
      },
    });
  }
  // The fixture contract is what a pre-J3 contract is: legacy road, with its
  // designer and developer assigned. Tests that want the new road say so.
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { sequence: 'DESIGN_FIRST', designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const refusal = (code: string) => (e: unknown) => (e as { extensions?: { code?: string } }).extensions?.code === code;

// ---- documents --------------------------------------------------------------------------

const VIEW = `query($id: ID!, $as: Boolean){
  contract(id: $id, asCustomer: $as) {
    id sequence
    wizard { step phaseId phaseNumber status locked lockedAt takesInput iterationsUsed allowance finishedAt }
    statusSummary {
      started startedAt currentStep currentPhaseId currentPhaseNumber nextMoveOn waitingOnRoot waitingOnCustomer
      plannedStartAt plannedEndAt overdueCount lastProgressAt daysSinceProgress
    }
    attention { kind variant contractId phaseId waitingOn role since params { key value } }
    timeline { id at kind by step phaseNumber number }
    internalNotes { id body createdAt author { id name } }
  }
}`;

type View = {
  id: string;
  sequence: string;
  wizard: Array<{ step: string; phaseId: string | null; phaseNumber: number | null; status: string; locked: boolean; lockedAt: string | null; takesInput: boolean; finishedAt: string | null }>;
  statusSummary: {
    started: boolean;
    startedAt: string | null;
    currentStep: string | null;
    currentPhaseId: string | null;
    currentPhaseNumber: number | null;
    nextMoveOn: string | null;
    waitingOnRoot: number;
    waitingOnCustomer: number;
    plannedStartAt: string | null;
    plannedEndAt: string | null;
    overdueCount: number;
    lastProgressAt: string | null;
    daysSinceProgress: number | null;
  };
  attention: Array<{ kind: string; variant: string; phaseId: string | null; waitingOn: string; role: string | null; since: string; params: Array<{ key: string; value: string }> }>;
  timeline: Array<{ id: string; kind: string; by: string; step: string | null; phaseNumber: number | null; number: number | null }>;
  internalNotes: Array<{ id: string; body: string; author: { id: string; name: string } }>;
};

async function view(as: User, opts: { asCustomer?: boolean; id?: string } = {}): Promise<View> {
  const data = ok(await exec(VIEW, { as, variables: { id: opts.id ?? f.contract.id, as: opts.asCustomer ?? false } }));
  return data.contract as View;
}

const steps = (v: View) => v.wizard.map((w) => `${w.step}${w.phaseId ? ':phase' : ''}=${w.status}`);

// ---- the database rules, by direct insert -------------------------------------------------

test('StepApproval: two NULL-phase rows for one step are refused; a different step, or a different phase, is not', async () => {
  const insert = (step: 'AGREEMENT' | 'DESIGN' | 'DEMO', phaseId: string | null = null, contractId = f.contract.id) =>
    prisma.stepApproval.create({ data: { contractId, step, phaseId, approvedById: f.admin.id } });

  await insert('AGREEMENT');
  // The whole point of the hand-written index: a plain UNIQUE (contractId, step, phaseId)
  // would accept this, because NULLs are distinct.
  await assert.rejects(() => insert('AGREEMENT'), /StepApproval_one_per_step|Unique constraint/i);
  // …and it is per step, not per contract.
  await insert('DESIGN');

  const p1 = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'P1' } });
  const p2 = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 2, titleFa: 'ف۲', titleEn: 'P2' } });
  // A demo is approved once per phase: two different phases are fine…
  await insert('DEMO', p1.id);
  await insert('DEMO', p2.id);
  // …the same phase twice is not…
  await assert.rejects(() => insert('DEMO', p1.id), /StepApproval_one_per_step_phase|Unique constraint/i);
  // …and a phase-less DEMO row is a different row again (the two indexes do not overlap).
  await insert('DEMO');
  await assert.rejects(() => insert('DEMO'), /StepApproval_one_per_step|Unique constraint/i);

  // Another contract on the same project has its own approvals.
  const other = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'ا',
      titleEn: 'Other',
      customerId: f.customer.id,
      projectId: f.contract.projectId,
      publishedAt: new Date(),
    },
  });
  await insert('AGREEMENT', null, other.id);
});

test('a phase with an approval cannot be deleted out from under its lock (the FK restricts)', async () => {
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: 'P' } });
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DEMO', phaseId: phase.id, approvedById: f.admin.id } });
  await assert.rejects(() => prisma.phase.delete({ where: { id: phase.id } }), /Foreign key constraint|StepApproval_phaseId_fkey/i);
});

test('the migration backfills existing contracts DESIGN_FIRST and leaves new ones AGREEMENT_FIRST — proven on the shipped SQL', async () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../../prisma/migrations/20260929160000_j3_steps/migration.sql', import.meta.url)),
    'utf8',
  );
  // The two statements that matter, lifted from the file and pointed at a
  // scratch table, so this reads the migration and not a paraphrase of it.
  const addColumn = /ALTER TABLE "Contract" ADD COLUMN[\s\S]*?"sequence" "ContractSequence" NOT NULL DEFAULT 'DESIGN_FIRST';/.exec(sql)?.[0];
  const setDefault = /ALTER TABLE "Contract" ALTER COLUMN "sequence" SET DEFAULT 'AGREEMENT_FIRST';/.exec(sql)?.[0];
  assert.ok(addColumn && setDefault, 'the migration carries both statements');

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`CREATE TABLE "J3Scratch" ("id" TEXT PRIMARY KEY)`);
    await tx.$executeRawUnsafe(`INSERT INTO "J3Scratch" ("id") VALUES ('existing-1'), ('existing-2')`);
    // Comments in the lifted block are harmless to Postgres; only the table name changes.
    await tx.$executeRawUnsafe(addColumn.replaceAll('"Contract"', '"J3Scratch"'));
    await tx.$executeRawUnsafe(setDefault.replaceAll('"Contract"', '"J3Scratch"'));
    await tx.$executeRawUnsafe(`INSERT INTO "J3Scratch" ("id") VALUES ('new-1')`);
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; sequence: string }>>(
      `SELECT "id", "sequence"::text AS "sequence" FROM "J3Scratch" ORDER BY "id"`,
    );
    assert.deepEqual(rows, [
      { id: 'existing-1', sequence: 'DESIGN_FIRST' },
      { id: 'existing-2', sequence: 'DESIGN_FIRST' },
      { id: 'new-1', sequence: 'AGREEMENT_FIRST' },
    ]);
    throw new Error('rollback');
  }).catch((e: Error) => {
    if (e.message !== 'rollback') throw e;
  });

  // …and the live column is what the schema says.
  const [col] = await prisma.$queryRaw<Array<{ column_default: string }>>`
    SELECT column_default FROM information_schema.columns WHERE table_name = 'Contract' AND column_name = 'sequence'`;
  assert.match(col.column_default, /AGREEMENT_FIRST/);
});

test('createContract states its sequence: AGREEMENT_FIRST — J7 flipped SEQUENCE_FOR_NEW_CONTRACTS once the gate existed', async () => {
  const data = ok(
    await exec(
      `mutation($i: CreateContractInput!){ createContract(input: $i) { id sequence } }`,
      { as: staff.SALES, variables: { i: { customerId: f.customer.id, ref: 'RC-J3-NEW', titleFa: 'ج', titleEn: 'J3' } } },
    ),
  );
  assert.equal((data.createContract as { sequence: string }).sequence, 'AGREEMENT_FIRST');
  // A row made straight through Prisma takes the schema's default — the same road, now that the resolver's stated value agrees with it.
  const direct = await prisma.contract.create({
    data: { ref: 'RC-J3-DIRECT', titleFa: 'م', titleEn: 'Direct', customerId: f.customer.id, projectId: f.contract.projectId },
  });
  assert.equal(direct.sequence, 'AGREEMENT_FIRST');
});

// ---- the wizard, through the resolvers ------------------------------------------------------

test('a DESIGN_FIRST contract walks design → agreement exactly as the gate does, and is never locked', async () => {
  let v = await view(f.customer);
  assert.equal(v.sequence, 'DESIGN_FIRST');
  assert.deepEqual(steps(v), ['DESIGN=CURRENT', 'AGREEMENT=UPCOMING']);
  assert.equal(v.statusSummary.currentStep, 'DESIGN');
  // A design revision exists and is published: the choosing is the customer's.
  assert.equal(v.statusSummary.nextMoveOn, 'CUSTOMER');

  await completeDesign(f);
  v = await view(f.customer);
  assert.deepEqual(steps(v), ['DESIGN=DONE', 'AGREEMENT=CURRENT']);

  ok(await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
  v = await view(f.customer);
  assert.deepEqual(steps(v), ['DESIGN=DONE', 'AGREEMENT=DONE']);
  assert.equal(v.statusSummary.currentStep, null);
  assert.equal(v.statusSummary.nextMoveOn, null);
  assert.equal(v.statusSummary.started, true);
  const signature = await prisma.signature.findFirstOrThrow({ where: { contractRevisionId: f.contractRevision.id } });
  assert.equal(new Date(v.statusSummary.startedAt!).getTime(), signature.signedAt.getTime());
  assert.ok(v.wizard.every((w) => !w.locked && w.lockedAt === null));
});

test('a DESIGN_FIRST contract shows a demo step per phase, done when the phase’s items are all accepted', async () => {
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'Phase 1' } });
  let v = await view(f.customer);
  assert.deepEqual(steps(v), ['DESIGN=CURRENT', 'AGREEMENT=UPCOMING', 'DEMO:phase=UPCOMING']);
  assert.equal(v.wizard[2].phaseId, phase.id);
  assert.equal(v.wizard[2].phaseNumber, 1);

  // An empty phase has finished nothing; a phase whose only item is accepted has.
  await completeDesign(f);
  ok(await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  ok(
    await exec('mutation($c: ID!, $n: String!){ signContract(contractId: $c, typedName: $n) { id } }', {
      as: f.customer,
      variables: { c: f.contract.id, n: 'Customer' },
    }),
  );
  v = await view(f.customer);
  assert.equal(v.statusSummary.currentStep, 'DEMO');
  assert.equal(v.statusSummary.currentPhaseNumber, 1);
  await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'j3-item', labelFa: 'م', labelEn: 'Item', position: 0, kind: 'FEATURE', status: 'ACCEPTED', phaseId: phase.id },
  });
  v = await view(f.customer);
  assert.equal(v.wizard[2].status, 'DONE');
});

test('an AGREEMENT_FIRST contract starts at requirements, is Root’s move, and locks four steps when the agreement is approved', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'AGREEMENT_FIRST' } });
  let v = await view(staff.SALES);
  assert.equal(v.sequence, 'AGREEMENT_FIRST');
  assert.deepEqual(steps(v), [
    'REQUIREMENTS=CURRENT',
    'SCOPE=UPCOMING',
    // The fixture has a published revision and no note waiting, which is J6's
    // DONE for the draft — in a state the real road cannot reach (publishing is
    // gated on the two steps before it). The road is walked in order, so the
    // current step is still the first that is not done.
    'DRAFT=DONE',
    'AGREEMENT=UPCOMING',
    'DESIGN=UPCOMING',
    'DEMO=UPCOMING',
    'SUMMARY=UPCOMING',
  ]);
  assert.equal(v.statusSummary.nextMoveOn, 'ROOT');
  assert.equal(v.statusSummary.started, false);
  assert.equal(v.wizard.find((w) => w.step === 'DEMO')!.phaseId, null);

  const approval = await prisma.stepApproval.create({
    data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id, approvedAt: new Date('2026-09-20T10:00:00Z') },
  });
  v = await view(f.customer);
  // **Done means signed** (J7): approved-and-unsigned is locked, and still the
  // current step — the customer signs next.
  assert.deepEqual(steps(v), [
    'REQUIREMENTS=DONE',
    'SCOPE=DONE',
    'DRAFT=DONE',
    'AGREEMENT=CURRENT',
    'DESIGN=UPCOMING',
    'DEMO=UPCOMING',
    'SUMMARY=UPCOMING',
  ]);
  assert.deepEqual(v.wizard.filter((w) => w.locked).map((w) => w.step), ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT']);
  assert.ok(v.wizard.filter((w) => w.locked).every((w) => w.lockedAt === approval.approvedAt.toISOString()));
  // Approved is not signed (J13 review): the steps lock, but "started" waits
  // for the signature — `agreementSignedAt` reads only the revision's signature.
  assert.equal(v.statusSummary.started, false);
  // The timeline names it, from the row itself (PD-17).
  assert.ok(v.timeline.some((t) => t.kind === 'STEP_APPROVED' && t.step === 'AGREEMENT' && t.by === 'ROOT'));

  const signature = await prisma.signature.create({
    data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Customer', signedHash: f.contractRevision.contentHash },
  });
  v = await view(f.customer);
  assert.equal(v.statusSummary.started, true);
  assert.equal(v.statusSummary.startedAt, signature.signedAt.toISOString());
  // …and the signature is what completes the agreement and moves the road on.
  assert.deepEqual(steps(v), [
    'REQUIREMENTS=DONE',
    'SCOPE=DONE',
    'DRAFT=DONE',
    'AGREEMENT=DONE',
    'DESIGN=CURRENT',
    'DEMO=UPCOMING',
    'SUMMARY=UPCOMING',
  ]);
});

test('each contract’s road has the phases it delivers (J4, PD-5); one with none gets the placeholder demo', async () => {
  const firstPhase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'Phase 1' } });
  const second = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId: f.contract.projectId,
      publishedAt: new Date(),
    },
  });
  const first = await view(f.customer);
  const other = await view(f.customer, { id: second.id });
  assert.ok(first.wizard.some((w) => w.step === 'DEMO' && w.phaseId !== null));
  assert.deepEqual(
    other.wizard.filter((w) => w.step === 'DEMO').map((w) => w.phaseId),
    [null],
  );
  // Neither the phases' builds nor a demo's progress leak onto the second contract's summary.
  assert.equal(other.statusSummary.lastProgressAt, null);
  assert.equal(other.statusSummary.daysSinceProgress, null);

  // Give the second contract a phase of its own — with the same number, which
  // is contract-scoped since J4 — and each road shows exactly its own.
  const secondPhase = await prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: second.id, number: 1, titleFa: 'ف۱', titleEn: 'Phase 1 (second)' },
  });
  const firstAgain = await view(f.customer);
  const secondAgain = await view(f.customer, { id: second.id });
  assert.deepEqual(firstAgain.wizard.filter((w) => w.step === 'DEMO').map((w) => w.phaseId), [firstPhase.id]);
  assert.deepEqual(secondAgain.wizard.filter((w) => w.step === 'DEMO').map((w) => w.phaseId), [secondPhase.id]);
});

// ---- assertStepOpen against the database ----------------------------------------------------

test('assertStepOpenOn: STEP_LOCKED once the sealing approval exists — per step, per phase, and never on the legacy road', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'AGREEMENT_FIRST' } });
  const p1 = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'P1' } });
  const p2 = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 2, titleFa: 'ف۲', titleEn: 'P2' } });

  // Before any approval every step is open.
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT', 'DESIGN'] as const) {
    await assertStepOpenOn(f.contract.id, step);
  }

  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT', 'AGREEMENT'] as const) {
    await assert.rejects(() => assertStepOpenOn(f.contract.id, step), refusal('STEP_LOCKED'), step);
  }
  await assertStepOpenOn(f.contract.id, 'DESIGN');

  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DEMO', phaseId: p1.id, approvedById: f.admin.id } });
  await assert.rejects(() => assertStepOpenOn(f.contract.id, 'DEMO', p1.id), refusal('STEP_LOCKED'));
  await assertStepOpenOn(f.contract.id, 'DEMO', p2.id);

  // Inside a transaction, on the transaction's snapshot.
  await prisma.$transaction(async (tx) => {
    await assert.rejects(() => assertStepOpenOn(f.contract.id, 'DRAFT', null, tx), refusal('STEP_LOCKED'));
  });

  await assert.rejects(() => assertStepOpenOn('nope', 'DRAFT'), refusal('NOT_FOUND'));

  // The legacy road ignores approval rows entirely.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await assertStepOpenOn(f.contract.id, 'AGREEMENT');
  await assertStepOpenOn(f.contract.id, 'DEMO', p1.id);
});

// ---- internal notes -------------------------------------------------------------------------

const ADD_NOTE = `mutation($c: ID!, $b: String!){ addInternalNote(contractId: $c, body: $b) { id internalNotes { id body author { id name } } } }`;

test('addInternalNote: any staff reader who can see the contract; refusals in the documented order', async () => {
  // Sales, admin, the assigned designer and developer, and an unassigned reader of an active contract.
  for (const [who, as] of [
    ['sales', staff.SALES],
    ['admin', f.admin],
    ['designer', staff.DESIGNER],
    ['developer', staff.DEVELOPER],
  ] as const) {
    const data = ok(await exec(ADD_NOTE, { as, variables: { c: f.contract.id, b: `  a note from ${who}  ` } }));
    const notes = (data.addInternalNote as { internalNotes: Array<{ body: string; author: { id: string } }> }).internalNotes;
    assert.equal(notes.at(-1)!.body, `a note from ${who}`, 'trimmed');
    assert.equal(notes.at(-1)!.author.id, as.id);
  }
  assert.equal(await prisma.internalNote.count({ where: { contractId: f.contract.id } }), 4);

  // Capability first: a customer, a contributor and a stranger are FORBIDDEN — for a real id and a made-up one alike.
  for (const as of [f.customer, staff.CONTRIBUTOR, f.stranger]) {
    for (const id of [f.contract.id, 'no-such-contract']) {
      const r = await exec(ADD_NOTE, { as, variables: { c: id, b: 'sneaky' } });
      assert.equal(r.code, 'FORBIDDEN', `${as.name} ${id}`);
    }
  }
  assert.equal((await exec(ADD_NOTE, { as: null, variables: { c: f.contract.id, b: 'x' } })).code, 'UNAUTHENTICATED');

  // The text.
  assert.equal((await exec(ADD_NOTE, { as: staff.SALES, variables: { c: f.contract.id, b: '   ' } })).code, 'EMPTY_COMMENT');
  assert.equal((await exec(ADD_NOTE, { as: staff.SALES, variables: { c: f.contract.id, b: 'x'.repeat(4001) } })).code, 'TOO_LONG');
  assert.equal((await exec(ADD_NOTE, { as: staff.SALES, variables: { c: 'no-such-contract', b: 'x' } })).code, 'NOT_FOUND');
  assert.equal(await prisma.internalNote.count({ where: { contractId: f.contract.id } }), 4, 'nothing was written by a refusal');
});

test('a reader who cannot see the contract cannot note it: a discarded contract is invisible to readActive', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  assert.equal((await exec(ADD_NOTE, { as: staff.DESIGNER, variables: { c: f.contract.id, b: 'x' } })).code, 'NOT_FOUND');
  // Sales (readAll) still can — the history of a discarded contract is theirs.
  ok(await exec(ADD_NOTE, { as: staff.SALES, variables: { c: f.contract.id, b: 'why we dropped it' } }));
  // …and the designer reads none of them.
  assert.equal((await exec(VIEW, { as: staff.DESIGNER, variables: { id: f.contract.id, as: false } })).code, 'NOT_FOUND');
});

test('internal notes are absent from the customer projection and from asCustomer — an empty list, never an error', async () => {
  await prisma.internalNote.createMany({
    data: [
      { contractId: f.contract.id, authorId: staff.SALES.id, body: 'NOTE-ONE-secret' },
      { contractId: f.contract.id, authorId: staff.DESIGNER.id, body: 'NOTE-TWO-secret' },
    ],
  });

  // Staff see them, oldest first.
  const seen = await view(staff.SALES);
  assert.deepEqual(seen.internalNotes.map((n) => n.body), ['NOTE-ONE-secret', 'NOTE-TWO-secret']);
  assert.equal((await view(staff.DESIGNER)).internalNotes.length, 2);

  // The customer's own read: empty, no error — a fragment shared with the portal must not break it.
  const raw = await exec(VIEW, { as: f.customer, variables: { id: f.contract.id, as: false } });
  assert.deepEqual(raw.errors, []);
  assert.deepEqual((raw.data!.contract as View).internalNotes, []);
  assert.doesNotMatch(JSON.stringify(raw.data), /secret/);

  // The list queries a customer can reach carry none either.
  const mine = ok(await exec(`{ myContracts { id internalNotes { body } } }`, { as: f.customer }));
  assert.deepEqual((mine.myContracts as Array<{ internalNotes: unknown[] }>)[0].internalNotes, []);

  // Staff viewing as the customer: the same emptiness, because the viewer there IS the customer.
  for (const as of [staff.SALES, f.admin, staff.DESIGNER, staff.DEVELOPER]) {
    const asCustomer = await exec(VIEW, { as, variables: { id: f.contract.id, as: true } });
    assert.deepEqual(asCustomer.errors, [], as.name);
    assert.deepEqual((asCustomer.data!.contract as View).internalNotes, [], as.name);
    assert.doesNotMatch(JSON.stringify(asCustomer.data), /secret/, as.name);
  }
});

// ---- attention, status area, timeline ---------------------------------------------------------

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);

test('overdue commitments: the customer’s own are theirs to see; Root’s are staff-only', async () => {
  const mk = (side: 'CUSTOMER' | 'ROOT', dueOffset: number, extra: { verified?: boolean } = {}) =>
    prisma.dependency.create({
      data: {
        projectId: f.contract.projectId,
        side,
        titleFa: `تعهد ${side}`,
        titleEn: `Commitment ${side}`,
        dueAt: day(dueOffset),
        createdById: f.admin.id,
        ...(extra.verified ? { verifiedAt: day(dueOffset + 1), verifiedById: f.admin.id, verifiedNote: 'checked' } : {}),
      },
    });
  await mk('CUSTOMER', -4);
  await mk('ROOT', -2);
  await mk('CUSTOMER', 5);
  await mk('CUSTOMER', -9, { verified: true });

  const forCustomer = await view(f.customer);
  assert.deepEqual(forCustomer.attention.map((a) => `${a.kind}/${a.variant}/${a.waitingOn}`), ['COMMITMENT_OVERDUE/customer/CUSTOMER']);
  assert.equal(forCustomer.statusSummary.overdueCount, 1);
  assert.equal(forCustomer.statusSummary.waitingOnCustomer, 1);
  assert.equal(forCustomer.statusSummary.waitingOnRoot, 0);
  const titleEn = forCustomer.attention[0].params.find((p) => p.key === 'titleEn')!;
  assert.equal(titleEn.value, 'Commitment CUSTOMER');

  const forSales = await view(staff.SALES);
  assert.deepEqual(forSales.attention.map((a) => `${a.variant}/${a.waitingOn}/${a.role}`), ['customer/CUSTOMER/null', 'root/ROOT/SALES']);
  assert.equal(forSales.statusSummary.overdueCount, 2);
  assert.equal(forSales.statusSummary.waitingOnRoot, 1);

  // Design and development are contract readers: they see Root's housekeeping too.
  assert.equal((await view(staff.DESIGNER)).attention.length, 2);
});

test('the pending banner becomes DRAFT_TO_REVIEW and ROUND_PUBLISHED attention, dated by the revision', async () => {
  await completeDesign(f);
  ok(await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  ok(
    await exec(
      'mutation($c: ID!){ setArticle(contractId: $c, number: 1, titleFa: "ماده یک ویرایش‌شده", titleEn: "Article 1, revised", bodyFa: "متن ۱", bodyEn: "Body 1") { id } }',
      { as: f.admin, variables: { c: f.contract.id } },
    ),
  );
  ok(await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', { as: f.admin, variables: { c: f.contract.id } }));

  const v = await view(f.customer);
  assert.deepEqual(v.attention.map((a) => `${a.kind}/${a.variant}/${a.waitingOn}`), ['DRAFT_TO_REVIEW/contract/CUSTOMER']);
  assert.deepEqual(v.attention[0].params, [
    { key: 'fromVersion', value: '1' },
    { key: 'toVersion', value: '2' },
  ]);
  const v2 = await prisma.contractRevision.findFirstOrThrow({ where: { contractId: f.contract.id, version: 2 } });
  assert.equal(v.attention[0].since, v2.publishedAt!.toISOString());
  assert.equal(v.statusSummary.waitingOnCustomer, 1);
  // Progress is Root's latest publication.
  assert.equal(v.statusSummary.lastProgressAt, v2.publishedAt!.toISOString());
  assert.equal(v.statusSummary.daysSinceProgress, 0);
});

test('demo items addressed in a published build are the customer’s to accept — one line per phase, only once the build is published', async () => {
  const phase = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'Phase 1' } });
  const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://staging.example.com', publishedAt: new Date('2026-09-10T08:00:00Z') } });
  const page = (key: string) =>
    prisma.demoPage.create({ data: { demoId: demo.id, key, labelFa: key, labelEn: key, canonicalPath: `/${key}` } });
  const build = await prisma.build.create({
    data: { phaseId: phase.id, projectId: f.contract.projectId, number: 1, declaredById: staff.DEVELOPER.id },
  });
  for (const key of ['home', 'about']) {
    const p = await page(key);
    await prisma.feedbackItem.create({
      data: {
        projectId: f.contract.projectId,
        contractId: f.contract.id,
        step: 'DEMO',
        phaseId: phase.id,
        demoId: demo.id,
        demoPageId: p.id,
        status: 'ADDRESSED',
        addressedInBuildId: build.id,
      },
    });
  }
  // A declared but unpublished build has told the customer nothing.
  assert.deepEqual((await view(f.customer)).attention, []);

  const publishedAt = new Date('2026-09-12T08:00:00Z');
  await prisma.build.update({ where: { id: build.id }, data: { publishedAt } });
  const v = await view(f.customer);
  assert.deepEqual(v.attention.map((a) => [a.kind, a.phaseId, a.waitingOn, a.params]), [
    ['ANSWER_PUBLISHED', phase.id, 'CUSTOMER', [{ key: 'count', value: '2' }, { key: 'step', value: 'DEMO' }]],
  ]);
  assert.equal(v.attention[0].since, publishedAt.toISOString());
  assert.ok(v.timeline.some((t) => t.kind === 'BUILD_PUBLISHED' && t.number === 1));
  assert.equal(v.statusSummary.lastProgressAt, publishedAt.toISOString());
});

test('the timeline is derived from dated rows: revisions, approvals; the request only for those who may read it', async () => {
  await prisma.project.update({
    where: { id: f.contract.projectId },
    data: { requestTitle: 'A shop', requestBody: 'Prints', requestLang: 'en', requestedAt: new Date('2026-06-20T09:00:00Z') },
  });
  const sales = await view(staff.SALES);
  const customer = await view(f.customer);
  const designer = await view(staff.DESIGNER);
  const kinds = (v: View) => v.timeline.map((t) => t.kind);
  assert.ok(kinds(sales).includes('REQUEST_SUBMITTED'));
  assert.ok(kinds(customer).includes('REQUEST_SUBMITTED'));
  // A designer reads the contract, not the sales conversation that preceded it.
  assert.ok(!kinds(designer).includes('REQUEST_SUBMITTED'));
  // The fixture's published design and contract revisions.
  for (const v of [sales, customer, designer]) {
    assert.ok(kinds(v).includes('REVISION_PUBLISHED'));
    assert.ok(kinds(v).includes('DESIGN_PUBLISHED'));
  }
  // Newest first.
  const times = customer.timeline.map((t) => t.id);
  assert.equal(times.length, new Set(times).size);
});

test('planned dates: staff read them from the start; the customer once a draft is published (J6) or the agreement is approved (PD-19: calendar days)', async () => {
  // J3 said "once the agreement is approved"; J6's step 2b shows the *proposed*
  // dates beside the draft (Q12: Root proposes them in the draft), so a customer
  // reads them from the moment a revision is published. Before that — a contract
  // handed over for step 1 that has no draft yet — they are staff's.
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: {
      sequence: 'AGREEMENT_FIRST',
      plannedStartAt: new Date('2026-10-01'),
      plannedEndAt: new Date('2026-12-15'),
      currentContractRevisionId: null,
    },
  });
  await prisma.contractRevision.deleteMany({ where: { contractId: f.contract.id } });
  const staffView = await view(staff.DESIGNER);
  assert.equal(staffView.statusSummary.plannedStartAt, '2026-10-01T00:00:00.000Z');
  assert.equal(staffView.statusSummary.plannedEndAt, '2026-12-15T00:00:00.000Z');
  const before = await view(f.customer);
  assert.deepEqual([before.statusSummary.plannedStartAt, before.statusSummary.plannedEndAt], [null, null]);
  // "View as customer" hides them too — it is the customer's own answer.
  const asCustomer = await view(staff.SALES, { asCustomer: true });
  assert.deepEqual([asCustomer.statusSummary.plannedStartAt, asCustomer.statusSummary.plannedEndAt], [null, null]);

  // A draft in front of the customer: the proposal is theirs to read and comment on.
  const revision = await prisma.contractRevision.create({
    data: { contractId: f.contract.id, version: 1, publishedAt: new Date() },
  });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { currentContractRevisionId: revision.id } });
  const shown = await view(f.customer);
  assert.equal(shown.statusSummary.plannedStartAt, '2026-10-01T00:00:00.000Z');
  assert.equal((await view(staff.SALES, { asCustomer: true })).statusSummary.plannedEndAt, '2026-12-15T00:00:00.000Z');

  // ...and the approval keeps them shown (nothing un-publishes a draft).
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
  const after = await view(f.customer);
  assert.equal(after.statusSummary.plannedStartAt, '2026-10-01T00:00:00.000Z');
});

test('the desk list can ask every contract for its current step and whose move it is', async () => {
  const data = ok(
    await exec(`{ allContracts { id sequence statusSummary { currentStep nextMoveOn } } }`, { as: staff.SALES }),
  );
  assert.deepEqual(data.allContracts, [
    { id: f.contract.id, sequence: 'DESIGN_FIRST', statusSummary: { currentStep: 'DESIGN', nextMoveOn: 'CUSTOMER' } },
  ]);
  // A designer's list is the same contracts through the same resolvers.
  const designerList = ok(await exec(`{ allContracts { id statusSummary { currentStep } } }`, { as: staff.DESIGNER }));
  assert.equal((designerList.allContracts as unknown[]).length, 1);
});

// ---- view as customer -------------------------------------------------------------------------

test('asCustomer: any staff reader who may see the contract; NOT_FOUND otherwise; a customer gets their own view unchanged', async () => {
  for (const as of [staff.SALES, f.admin, staff.DESIGNER, staff.DEVELOPER]) {
    const v = await view(as, { asCustomer: true });
    assert.equal(v.id, f.contract.id, as.name);
  }
  // Roles that read no contracts, and other customers, get what any of them gets: NOT_FOUND.
  for (const as of [staff.CONTRIBUTOR, f.stranger]) {
    const r = await exec(VIEW, { as, variables: { id: f.contract.id, as: true } });
    assert.equal(r.code, 'NOT_FOUND', as.name);
  }
  // A reader with readActive only cannot view a contract they cannot open — as anyone.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  assert.equal((await exec(VIEW, { as: staff.DESIGNER, variables: { id: f.contract.id, as: true } })).code, 'NOT_FOUND');
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'IN_PROGRESS' } });

  // The customer passing it: their own view, byte for byte.
  const plain = await exec(VIEW, { as: f.customer, variables: { id: f.contract.id, as: false } });
  const flagged = await exec(VIEW, { as: f.customer, variables: { id: f.contract.id, as: true } });
  assert.deepEqual(flagged, plain);
});

test('asCustomer on a contract not yet handed over is refused with a code of its own — the caller knows it exists', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });
  assert.equal((await exec(VIEW, { as: staff.SALES, variables: { id: f.contract.id, as: true } })).code, 'NOT_VISIBLE_TO_CUSTOMER');
  // The staff view itself still works, and the customer's own read is NOT_FOUND (house rule 13).
  assert.equal((await view(staff.SALES)).id, f.contract.id);
  assert.equal((await exec(VIEW, { as: f.customer, variables: { id: f.contract.id, as: false } })).code, 'NOT_FOUND');
});

/**
 * Every field on `Contract` a customer can select, generated from the schema
 * itself — so a field added tomorrow is compared without anyone remembering
 * to add it here. Cycles are cut where a type repeats on the path; fields that
 * need an argument are skipped.
 */
function everything(): string {
  const schema = buildSchema(typeDefs);
  const MAX_DEPTH = 7;
  /**
   * Edges the schema declares more of than any resolver path loads — found by
   * this very generator. `FeedbackItem.addressedInBuild` used to be one: it is
   * loaded as a bare `Build` row, so selecting `declaredBy` or `changes` failed
   * for *everyone* ("Cannot return null for non-nullable field
   * Build.declaredBy"), and the edge was held to scalars here. **S2 closed it**
   * (`Build` in fields.ts resolves both lazily), so the set is empty: the edge
   * is walked in full, and the parity test below compares what the customer
   * reads through it with what staff-as-customer reads — a name, no contacts,
   * no change list. Add an edge here only with the reason it cannot be walked.
   */
  const SCALARS_ONLY = new Set<string>();
  const walk = (type: GraphQLType, path: string[], scalarsOnly = false): string | null => {
    const named = getNamedType(type);
    if (isScalarType(named) || isEnumType(named)) return '';
    if (!isObjectType(named)) return null;
    if (path.includes(named.name) || path.length > MAX_DEPTH) return null;
    const parts: string[] = [];
    for (const field of Object.values((named as GraphQLObjectType).getFields())) {
      if (field.args.some((a) => isNonNullType(a.type) && a.defaultValue === undefined)) continue;
      const sub = walk(field.type, [...path, named.name], SCALARS_ONLY.has(`${named.name}.${field.name}`));
      if (sub === null || (scalarsOnly && sub !== '')) continue;
      parts.push(sub === '' ? field.name : `${field.name} ${sub}`);
    }
    return parts.length ? `{ ${parts.join(' ')} }` : null;
  };
  const selection = walk(schema.getType('Contract')!, []);
  assert.ok(selection);
  return `query($id: ID!, $as: Boolean){ contract(id: $id, asCustomer: $as) ${selection} }`;
}

/** A contract with a little of everything a customer must not see — and some of what they must. */
async function enrich() {
  const projectId = f.contract.projectId;

  // A request that began the project, with a thread.
  await prisma.project.update({
    where: { id: projectId },
    data: { requestTitle: 'A shop', requestBody: 'We sell prints', requestLang: 'en', requestedAt: new Date('2026-06-20T09:00:00Z') },
  });
  await prisma.requestMessage.createMany({
    data: [
      { projectId, authorId: f.customer.id, body: 'Can we start in autumn?' },
      { projectId, authorId: staff.SALES.id, body: 'Yes.' },
    ],
  });

  // Internal notes.
  await prisma.internalNote.create({ data: { contractId: f.contract.id, authorId: staff.SALES.id, body: 'PARITY-secret-note' } });

  // Approve v1, publish v2 (a pending contract diff), then leave a further unpublished draft edit behind.
  await completeDesign(f);
  ok(await exec('mutation($c: ID!){ approveContract(contractId: $c) { id } }', { as: f.customer, variables: { c: f.contract.id } }));
  const setArticle = (titleEn: string) =>
    exec(
      'mutation($c: ID!, $t: String!){ setArticle(contractId: $c, number: 1, titleFa: "ماده یک", titleEn: $t, bodyFa: "متن", bodyEn: "Body") { id } }',
      { as: f.admin, variables: { c: f.contract.id, t: titleEn } },
    );
  ok(await setArticle('Article 1, revised'));
  ok(await exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', { as: f.admin, variables: { c: f.contract.id } }));
  ok(await setArticle('Article 1, revised again — draft only'));
  // An unpublished contract revision row, as staff (and only staff) are meant to see it.
  await prisma.contractRevision.create({ data: { contractId: f.contract.id, version: 3 } });

  // Amendments on the current revision: one published and waiting, one still a draft.
  const current = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  await prisma.amendment.createMany({
    data: [
      { contractRevisionId: current.currentContractRevisionId!, ordinal: 1, titleFa: 'ا', titleEn: 'Published amendment', bodyFa: 'ب', bodyEn: 'B', contentHash: 'h1', publishedAt: new Date() },
      { contractRevisionId: current.currentContractRevisionId!, ordinal: 2, titleFa: 'ا', titleEn: 'DRAFT amendment', bodyFa: 'ب', bodyEn: 'B', contentHash: 'h2' },
    ],
  });

  // Design: a published v2 that changed a page, then an unpublished draft on top.
  ok(await exec('mutation($c: ID!){ addConcept(contractId: $c, key: "1d", labelFa: "ط", labelEn: "C") { id } }', { as: f.admin, variables: { c: f.contract.id } }));
  const draftPage = await prisma.pageDesign.findFirstOrThrow({
    where: { key: 'home', concept: { key: '1a', designRevision: { contractId: f.contract.id, publishedAt: null } } },
  });
  await prisma.pageDesign.update({ where: { id: draftPage.id }, data: { imageUrl: '/img/1a-home-v2.png' } });
  ok(await exec('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', { as: f.admin, variables: { c: f.contract.id } }));
  ok(await exec('mutation($c: ID!){ addConcept(contractId: $c, key: "1e", labelFa: "ط", labelEn: "Draft concept") { id } }', { as: f.admin, variables: { c: f.contract.id } }));

  // Commitments on both sides, late and not.
  for (const [side, offset] of [['CUSTOMER', -4], ['ROOT', -2], ['CUSTOMER', 6]] as const) {
    await prisma.dependency.create({
      data: { projectId, side, titleFa: `تعهد ${side}`, titleEn: `Commitment ${side}`, dueAt: day(offset), createdById: f.admin.id },
    });
  }

  // A phase with a published demo and a draft demo, and an addressed item in a published build.
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'ف۱', titleEn: 'Phase 1' } });
  const published = await prisma.demo.create({ data: { projectId, phaseId: phase.id, stagingUrl: 'https://one.example.com', publishedAt: new Date() } });
  await prisma.demo.create({ data: { projectId, phaseId: phase.id, stagingUrl: 'https://DRAFT.example.com' } });
  const build = await prisma.build.create({
    data: { phaseId: phase.id, projectId, number: 1, declaredById: staff.DEVELOPER.id, publishedAt: new Date('2026-09-15T00:00:00Z') },
  });
  const page = await prisma.demoPage.create({ data: { demoId: published.id, key: 'home', labelFa: 'خانه', labelEn: 'Home', canonicalPath: '/' } });
  await prisma.feedbackItem.create({
    data: {
      projectId,
      contractId: f.contract.id,
      step: 'DEMO',
      phaseId: phase.id,
      demoId: published.id,
      demoPageId: page.id,
      status: 'ADDRESSED',
      addressedInBuildId: build.id,
    },
  });

  // Planned dates, while still a proposal.
  await prisma.contract.update({ where: { id: f.contract.id }, data: { plannedStartAt: new Date('2026-10-01'), plannedEndAt: new Date('2026-12-01') } });
}

for (const sequence of ['DESIGN_FIRST', 'AGREEMENT_FIRST'] as const) {
  test(`asCustomer parity (${sequence}): every field a customer can select reads exactly as the customer’s own read does`, async () => {
    await enrich();
    await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence } });
    if (sequence === 'AGREEMENT_FIRST') {
      // Approved locks and all: the road with a StepApproval on it.
      await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
    }
    const query = everything();
    const read = (as: User, asCustomer: boolean) => exec(query, { as, variables: { id: f.contract.id, as: asCustomer } });

    const theirs = await read(f.customer, false);
    assert.deepEqual(theirs.errors, [], 'the customer’s own read succeeds');
    assert.ok(theirs.data);
    const theirsJson = JSON.stringify(theirs.data);
    // The fixture really did put secrets in front of staff…
    assert.doesNotMatch(theirsJson, /PARITY-secret-note|DRAFT amendment|Draft concept|DRAFT\.example/);
    assert.ok(/Published amendment/.test(theirsJson), 'and really did give the customer something');
    assert.ok(/"amount":"180000000"/.test(theirsJson), 'the customer reads their own fee');

    // …so the plain staff read differs — the test can tell a leak from a match.
    const salesPlain = await read(staff.SALES, false);
    assert.notDeepEqual(salesPlain.data, theirs.data);
    assert.match(JSON.stringify(salesPlain.data), /PARITY-secret-note/);
    assert.match(JSON.stringify(salesPlain.data), /DRAFT amendment/);
    assert.match(JSON.stringify(salesPlain.data), /DRAFT\.example/);

    // The claim: viewing as the customer is reading as the customer.
    for (const as of [f.admin, staff.SALES, staff.DESIGNER, staff.DEVELOPER]) {
      const mine = await read(as, true);
      assert.deepEqual(mine.errors, theirs.errors, `${as.name}: errors`);
      assert.deepEqual(mine.data, theirs.data, `${as.name}: data`);
    }
    // Even for a designer, who holds no money.read: the customer's view carries the fee.
    assert.match(JSON.stringify((await read(staff.DESIGNER, true)).data), /"amount":"180000000"/);
    assert.doesNotMatch(JSON.stringify((await read(staff.DESIGNER, false)).data), /"amount":"180000000"/);
  });
}

test('asCustomer does not leak into a later operation: the flag lives on one request’s context', async () => {
  await enrich();
  const asCustomer = await view(staff.SALES, { asCustomer: true });
  assert.deepEqual(asCustomer.internalNotes, []);
  // The next request from the same staff member is theirs again.
  const plain = await view(staff.SALES);
  assert.equal(plain.internalNotes.length, 1);
});

test('the generated selection really covers the surface: it reaches the fields this stage added', () => {
  const query = everything();
  for (const field of ['wizard', 'statusSummary', 'attention', 'timeline', 'internalNotes', 'draft', 'designDraft', 'contractRevisions', 'request']) {
    assert.match(query, new RegExp(`\\b${field}\\b`), field);
  }
});

test('a customer reads no staff email or phone through the contract — and staff still do (J3 review)', async () => {
  const designer = await prisma.user.create({
    data: { email: 'designer-contact@test.local', phone: '+989121110000', name: 'Designer', roles: ['DESIGNER'], state: 'ACTIVE' },
  });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: designer.id } });
  const q = 'query($id: ID!){ contract(id: $id) { designer { id name email phone } customer { email } } }';

  const asCustomer = ok(await exec(q, { as: f.customer, variables: { id: f.contract.id } })) as {
    contract: { designer: { name: string; email: string | null; phone: string | null }; customer: { email: string | null } };
  };
  assert.equal(asCustomer.contract.designer.name, 'Designer', 'the name is still shown');
  assert.equal(asCustomer.contract.designer.email, null);
  assert.equal(asCustomer.contract.designer.phone, null);
  assert.equal(asCustomer.contract.customer.email, f.customer.email, 'their own, yes');

  const asAdmin = ok(await exec(q, { as: f.admin, variables: { id: f.contract.id } })) as {
    contract: { designer: { email: string | null } };
  };
  assert.equal(asAdmin.contract.designer.email, 'designer-contact@test.local');
});
