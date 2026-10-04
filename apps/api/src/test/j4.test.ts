import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Prisma, Role, User } from '@prisma/client';
import { prisma, publishDraftDirect, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { __setMailTransportForTests, __resetMailTransportForTests, type MailMessage } from '../lib/mail.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J4 — step 1, requirements (journeys build plan §5 "J4").
 *
 * What the pure tables (`brief.test.ts`, `plan.test.ts`) cannot show, in this
 * order: **the database's own rules by direct insert** (both CHECKs on the
 * brief, both on a planned invoice, the partial unique on a commitment key, the
 * phase's contract, the type's Restrict) and **the migration's backfill, run as
 * shipped**; `setBrief` — the dependency sync (idempotent, a provider switched
 * flips the side, a sibling contract's brief keeps a row alive), dates as dates,
 * and every refusal; the extras; the payment plan (the rows are the plan); **the
 * locks** (`STEP_LOCKED` on every J4 write once the agreement is approved);
 * **money** (PD-14 — null for the designer and developer, present for sales and
 * the customer, for every money field J4 adds, and PD-21's hiding of feedback
 * about a sensitive article); the hand-over (`BRIEF_MISSING`, the notification);
 * the board (`BRIEF_OWNED`, the technical/general verification split); phases
 * that belong to a contract; and the wizard's REQUIREMENTS signal.
 */

let f: Fixture;
const staff: Record<string, User> = {};
let type: { id: string };
let mail: MailMessage[];
let sms: Array<{ to: string; text?: string; code?: string }>;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989120000105', locale: 'fa' } });
  f.customer = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER', 'CONTRIBUTOR'] as Role[]) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
  type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  mail = [];
  sms = [];
  __resetNamedRateLimitsForTests();
  __setMailTransportForTests({ send: async (m) => void mail.push(m) });
  __setSmsTransportForTests({
    sendCode: async (to, code) => void sms.push({ to, code }),
    sendText: async (to, text) => void sms.push({ to, text }),
  });
});

after(async () => {
  __resetMailTransportForTests();
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

// ---- documents ------------------------------------------------------------------

const CONTRACT = `
  id
  brief {
    id kind existingSiteUrl designTier budgetCap idealDeadline hardDeadline domainName
    domainProvidedBy hostProvidedBy contentProvidedBy supportMonths
    premadeRounds wireframeIterations mockupIterations demoIterationsPerPhase
    templateType { id slug }
  }
  briefCompleteness { code key }
  paymentPlan { id split total invoices { id ordinal labelFa labelEn amount phaseId paymentTermDays } }
  phases { id number contractId plannedEndAt }
  project { dependencies { id side briefKey technical dueAt verifiedAt titleEn } phases { id contractId } }
  wizard { step status locked }
`;
const SET_BRIEF = `mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { ${CONTRACT} } }`;
const SET_EXTRA = `mutation($s: ID!, $in: Boolean!, $c: ID){ setExtra(scopeItemId: $s, included: $in, contractId: $c) { ${CONTRACT} } }`;
const SET_PLAN = `mutation($c: ID!, $s: PaymentSplit!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: $s, invoices: $r) { ${CONTRACT} } }`;
const READ = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { ${CONTRACT} } }`;
const CREATE_PHASE = `mutation($c: ID!, $n: Int!, $end: String){ createPhase(contractId: $c, number: $n, titleFa: "فاز", titleEn: "Phase", plannedEndAt: $end) { ${CONTRACT} } }`;

type Contract = {
  id: string;
  brief: Record<string, unknown> | null;
  briefCompleteness: Array<{ code: string; key: string | null }>;
  paymentPlan: { id: string; split: string; total: string; invoices: Array<Record<string, unknown>> } | null;
  phases: Array<{ id: string; number: number; contractId: string; plannedEndAt: string | null }>;
  project: {
    dependencies: Array<{ id: string; side: string; briefKey: string | null; technical: boolean; dueAt: string; verifiedAt: string | null }>;
    phases: Array<{ id: string; contractId: string }>;
  };
  wizard: Array<{ step: string; status: string; locked: boolean }>;
};

const briefInput = (over: Record<string, unknown> = {}) => ({
  kind: 'NEW_SITE',
  templateTypeId: type.id,
  designTier: 'THEME_PICK',
  budgetCap: '150000000',
  idealDeadline: '2026-10-01',
  hardDeadline: '2026-10-23',
  domainName: 'nahal.ir',
  domainProvidedBy: 'CUSTOMER',
  hostProvidedBy: 'ROOT',
  contentProvidedBy: 'CUSTOMER',
  supportMonths: 6,
  premadeRounds: 2,
  demoIterationsPerPhase: 2,
  commitments: [
    { key: 'domain', dueAt: '2026-10-05' },
    { key: 'host', dueAt: '2026-10-06' },
    { key: 'content', dueAt: '2026-10-07' },
  ],
  ...over,
});

async function setBrief(over: Record<string, unknown> = {}, as: User = staff.SALES, contractId = f.contract.id) {
  return exec(SET_BRIEF, { as, variables: { c: contractId, i: briefInput(over) } });
}
const setBriefOk = async (...args: Parameters<typeof setBrief>) => ok(await setBrief(...args)).setBrief as Contract;

async function read(as: User, asCustomer = false, contractId = f.contract.id) {
  return ok(await exec(READ, { as, variables: { c: contractId, as: asCustomer } })).contract as Contract;
}

const rows = (...items: Array<[string, string, string, number]>) =>
  items.map(([labelEn, amount, phaseId, term]) => ({
    labelFa: `ردیف ${labelEn}`,
    labelEn,
    amount,
    phaseId: phaseId || null,
    paymentTermDays: term,
  }));

/** A second contract on the fixture's project — the founder's Q5 (a feature for an existing site). */
async function secondContract(over: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
  return prisma.contract.create({
    data: {
      ref: 'RC-TEST-002',
      titleFa: 'دوم',
      titleEn: 'Second',
      customerId: f.customer.id,
      projectId: f.contract.projectId,
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date(),
      ...over,
    },
  });
}

const boardRows = () => prisma.dependency.findMany({ where: { projectId: f.contract.projectId }, orderBy: { briefKey: 'asc' } });

/** Sales' approval of the agreement, straight in — J7 writes it through the gate. */
const approveAgreement = (contractId = f.contract.id) =>
  prisma.stepApproval.create({ data: { contractId, step: 'AGREEMENT', approvedById: f.admin.id } });

// =================================================================================
// The database's own rules, by direct insert
// =================================================================================

const briefRow = (over: Record<string, unknown> = {}) => ({
  contractId: f.contract.id,
  kind: 'NEW_SITE' as const,
  templateTypeId: type.id,
  designTier: 'THEME_PICK' as const,
  ...over,
});

test('ContractBrief_deadlines_ordered: an ideal deadline after the hard one is refused by the database; equal, and either one alone, are not', async () => {
  const day = (n: number) => new Date(Date.UTC(2026, 9, n));
  await assert.rejects(
    () => prisma.contractBrief.create({ data: briefRow({ idealDeadline: day(9), hardDeadline: day(2) }) }),
    /ContractBrief_deadlines_ordered/,
  );
  for (const [i, over] of [
    { idealDeadline: day(2), hardDeadline: day(9) },
    { idealDeadline: day(5), hardDeadline: day(5) },
    { idealDeadline: day(9) },
    { hardDeadline: day(2) },
    {},
  ].entries()) {
    await prisma.contractBrief.deleteMany();
    await assert.doesNotReject(() => prisma.contractBrief.create({ data: briefRow(over) }), `case ${i}`);
  }
});

test('ContractBrief_allowances_positive: any allowance that is set must be above zero — each of the four, by direct insert', async () => {
  for (const column of ['premadeRounds', 'wireframeIterations', 'mockupIterations', 'demoIterationsPerPhase']) {
    for (const value of [0, -1]) {
      await assert.rejects(
        () => prisma.contractBrief.create({ data: briefRow({ [column]: value }) }),
        /ContractBrief_allowances_positive/,
        `${column} = ${value}`,
      );
    }
    await prisma.contractBrief.deleteMany();
    await assert.doesNotReject(() => prisma.contractBrief.create({ data: briefRow({ [column]: 3 }) }), `${column} = 3`);
    await prisma.contractBrief.deleteMany();
  }
  // Unset is fine, and the wireframe allowance defaults to two.
  const brief = await prisma.contractBrief.create({ data: briefRow() });
  assert.equal(brief.wireframeIterations, 2);
  assert.equal(brief.premadeRounds, null);
});

test('PlannedInvoice_amount_positive and PlannedInvoice_term_not_negative: refused by the database, not only the resolver', async () => {
  const plan = await prisma.paymentPlan.create({ data: { contractId: f.contract.id, split: 'INSTALLMENTS' } });
  const invoice = (over: Record<string, unknown>) => ({
    planId: plan.id,
    ordinal: 1,
    labelFa: 'ا',
    labelEn: 'a',
    amount: 100n,
    paymentTermDays: 7,
    ...over,
  });
  await assert.rejects(() => prisma.plannedInvoice.create({ data: invoice({ amount: 0n }) }), /PlannedInvoice_amount_positive/);
  await assert.rejects(() => prisma.plannedInvoice.create({ data: invoice({ amount: -5n }) }), /PlannedInvoice_amount_positive/);
  await assert.rejects(() => prisma.plannedInvoice.create({ data: invoice({ paymentTermDays: -1 }) }), /PlannedInvoice_term_not_negative/);
  await assert.doesNotReject(() => prisma.plannedInvoice.create({ data: invoice({ paymentTermDays: 0 }) }));
  // One ordinal per plan.
  await assert.rejects(() => prisma.plannedInvoice.create({ data: invoice({}) }), /Unique constraint/);
});

test('Dependency_briefKey_key: one row per (project, briefKey); ordinary rows are unaffected, and another project may hold the same key', async () => {
  const base = { projectId: f.contract.projectId, side: 'CUSTOMER' as const, titleFa: 'ا', titleEn: 'a', dueAt: new Date(), createdById: f.admin.id };
  await prisma.dependency.create({ data: { ...base, briefKey: 'domain' } });
  await assert.rejects(() => prisma.dependency.create({ data: { ...base, briefKey: 'domain' } }), /Dependency_briefKey_key|Unique constraint/);
  // NULL keys are distinct from each other — the point of a *partial* index.
  await assert.doesNotReject(async () => {
    await prisma.dependency.create({ data: base });
    await prisma.dependency.create({ data: base });
  });
  await assert.doesNotReject(() => prisma.dependency.create({ data: { ...base, briefKey: 'host' } }));
  const other = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ب', titleEn: 'other' } });
  await assert.doesNotReject(() => prisma.dependency.create({ data: { ...base, projectId: other.id, briefKey: 'domain' } }));
});

test('Phase: a contract is required, its number is unique per contract (not per project), and a type in use cannot be deleted', async () => {
  await assert.rejects(
    () => prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: 'nope', number: 1, titleFa: 'ا', titleEn: 'a' } }),
    /Foreign key constraint/,
  );
  const second = await secondContract();
  const phase = (contractId: string, number: number) =>
    prisma.phase.create({ data: { projectId: f.contract.projectId, contractId, number, titleFa: 'ا', titleEn: 'a' } });
  await phase(f.contract.id, 1);
  await assert.rejects(() => phase(f.contract.id, 1), /Unique constraint/);
  await assert.doesNotReject(() => phase(second.id, 1), 'two contracts on one project each have a phase 1');

  await prisma.contractBrief.create({ data: briefRow() });
  await assert.rejects(() => prisma.templateType.delete({ where: { id: type.id } }), /Foreign key constraint/);
});

test('the calendar-day columns are `date`, not `timestamptz` (PD-19): the brief’s deadlines and a phase’s planned end', async () => {
  const cols = await prisma.$queryRawUnsafe<Array<{ table_name: string; column_name: string; data_type: string }>>(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
     WHERE (table_name = 'ContractBrief' AND column_name IN ('idealDeadline', 'hardDeadline'))
        OR (table_name = 'Phase' AND column_name = 'plannedEndAt')`,
  );
  assert.equal(cols.length, 3);
  for (const c of cols) assert.equal(c.data_type, 'date', `${c.table_name}.${c.column_name}`);
});

// ---- the migration's backfill, as shipped ------------------------------------------------------

const MIGRATION = fileURLToPath(new URL('../../prisma/migrations/20260930100000_j4_brief_plan_phases/migration.sql', import.meta.url));

/** Everything between a pair of markers, comments dropped. */
function between(begin: string, end: string): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = sql.slice(sql.indexOf(begin), sql.indexOf(end));
  assert.ok(block.length > 0, `${begin} … ${end} markers are missing`);
  return block
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/**
 * The migration cannot run over pre-migration rows here (the test database is
 * migrated before any test starts), so — as T1's and S2's tests do — this takes
 * the migration's *own text*, un-does its effect inside a transaction that is
 * always rolled back (drops NOT NULL on `Phase.contractId`), and runs the SQL
 * that ships over fixture rows.
 */
async function overUnmigratedRows<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const rolledBack = new Error('roll back the un-migrated fixture');
  let result!: T;
  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Phase" ALTER COLUMN "contractId" DROP NOT NULL');
      result = await body(tx);
      throw rolledBack;
    })
    .catch((err) => {
      if (err !== rolledBack) throw err;
    });
  return result;
}

test('the phase backfill gives each phase its project’s primary contract — the earliest, exactly primaryContractId — and flags the money articles', async () => {
  const older = await secondContract({ ref: 'RC-OLDER', createdAt: new Date('2020-01-01T00:00:00Z') });
  const { contractIds, articles } = await overUnmigratedRows(async (tx) => {
    for (const n of [1, 2]) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Phase" ("id", "projectId", "number", "titleFa", "titleEn", "updatedAt")
         VALUES ('bf-phase-${n}', '${f.contract.projectId}', ${n}, 'ا', 'p${n}', now())`,
      );
    }
    // Articles: the template's two, and three decoys that must stay unflagged.
    for (const [contractId, number, titleEn] of [
      [f.contract.id, 4, 'Fees'],
      [f.contract.id, 5, 'Payment Schedule'],
      [f.contract.id, 9, 'Fees'],
      [older.id, 4, 'Warranties'],
      [older.id, 5, 'Fees'],
    ] as const) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Article" ("id", "contractId", "number", "titleFa", "titleEn") VALUES ('bf-art-${contractId}-${number}', '${contractId}', ${number}, 'ا', '${titleEn}')`,
      );
    }
    const statements = between('-- BACKFILL:BEGIN', '-- BACKFILL:END')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(statements.length, 2, 'the backfill is a phase update and an article update');
    for (const s of statements) await tx.$executeRawUnsafe(s);
    return {
      contractIds: await tx.$queryRawUnsafe<Array<{ contractId: string }>>(
        `SELECT "contractId" FROM "Phase" WHERE "id" LIKE 'bf-phase-%' ORDER BY "id"`,
      ),
      articles: await tx.$queryRawUnsafe<Array<{ id: string; sensitive: boolean }>>(
        `SELECT "id", "sensitive" FROM "Article" WHERE "id" LIKE 'bf-art-%' ORDER BY "id"`,
      ),
    };
  });
  assert.deepEqual(contractIds.map((r) => r.contractId), [older.id, older.id], 'the earliest contract on the project');
  const flagged = articles.filter((a) => a.sensitive).map((a) => a.id.replace('bf-art-', '').replace(f.contract.id, 'main').replace(older.id, 'older'));
  assert.deepEqual(flagged.sort(), ['main-4', 'main-5'], 'Fees (4) and Payment Schedule (5) by number and title — not a Fees at 9, not a Warranties at 4');
});

test('the migration’s guard refuses to make Phase.contractId required while a phase has no contract', async () => {
  const guard = between('-- VERIFY:BEGIN', '-- VERIFY:END');
  const orphanProject = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ی', titleEn: 'orphan' } });
  await assert.rejects(
    () =>
      overUnmigratedRows(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Phase" ("id", "projectId", "number", "titleFa", "titleEn", "updatedAt") VALUES ('orphan', '${orphanProject.id}', 1, 'ا', 'p', now())`,
        );
        await tx.$executeRawUnsafe(guard);
      }),
    /J4: 1 phase\(s\) are on a project with no contract/,
  );
  // With nothing orphaned the same text passes.
  await overUnmigratedRows(async (tx) => {
    await tx.$executeRawUnsafe(guard);
  });
});

// =================================================================================
// setBrief
// =================================================================================

test('setBrief writes the brief; dates come back as the day they were sent; the budget is a string; the contract fee is untouched', async () => {
  const before = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  const c = await setBriefOk();
  assert.equal(c.brief!.kind, 'NEW_SITE');
  assert.equal(c.brief!.designTier, 'THEME_PICK');
  assert.deepEqual(c.brief!.templateType, { id: type.id, slug: 'store' });
  assert.equal(c.brief!.budgetCap, '150000000');
  // A calendar day is midnight UTC on the wire, and a `date` in the table.
  assert.equal(c.brief!.hardDeadline, '2026-10-23T00:00:00.000Z');
  assert.equal(c.brief!.idealDeadline, '2026-10-01T00:00:00.000Z');
  const [row] = await prisma.$queryRawUnsafe<Array<{ d: string }>>(`SELECT to_char("hardDeadline", 'YYYY-MM-DD') AS d FROM "ContractBrief"`);
  assert.equal(row.d, '2026-10-23');
  assert.equal(c.brief!.wireframeIterations, 2, 'the default');

  // budgetCap is not Contract.amount: nothing prefills or moves one from the other, either way.
  const after = await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } });
  assert.equal(after.amount, before.amount);
  assert.equal(String(before.amount), '180000000');
  ok(
    await exec('mutation($c: ID!){ updateContractDraft(contractId: $c, titleFa: "ت", titleEn: "T", amount: "999") { id } }', {
      as: staff.SALES,
      variables: { c: f.contract.id },
    }),
  );
  assert.equal(((await read(staff.SALES)).brief as { budgetCap: string }).budgetCap, '150000000');
});

test('setBrief syncs the dependencies in the same write, and setting it twice leaves one row per key', async () => {
  const first = await setBriefOk();
  const rowsAfterFirst = await boardRows();
  assert.deepEqual(
    rowsAfterFirst.map((r) => [r.briefKey, r.side, r.technical]),
    [
      ['content', 'CUSTOMER', false],
      ['domain', 'CUSTOMER', true],
      ['host', 'ROOT', true],
    ],
  );
  assert.equal(first.project.dependencies.length, 3);

  await setBriefOk();
  await setBriefOk({ budgetCap: '160000000' });
  const rowsAfter = await boardRows();
  assert.equal(rowsAfter.length, 3, 'one row per key, however often the brief is set');
  assert.deepEqual(rowsAfter.map((r) => r.id).sort(), rowsAfterFirst.map((r) => r.id).sort(), 'the same rows — updated, never recreated');
  assert.equal(await prisma.contractBrief.count(), 1);
  // The commitment dates are calendar days the caller named.
  const domain = rowsAfter.find((r) => r.briefKey === 'domain')!;
  assert.equal(domain.dueAt.toISOString(), '2026-10-05T00:00:00.000Z');
});

test('switching a provider to Root flips the row’s side — and only its side — and a new date moves its date', async () => {
  await setBriefOk();
  const before = (await boardRows()).find((r) => r.briefKey === 'domain')!;
  assert.equal(before.side, 'CUSTOMER');

  await setBriefOk({ domainProvidedBy: 'ROOT' });
  const flipped = (await boardRows()).find((r) => r.briefKey === 'domain')!;
  assert.equal(flipped.id, before.id);
  assert.equal(flipped.side, 'ROOT');
  assert.equal(flipped.dueAt.toISOString(), before.dueAt.toISOString(), 'the date is kept when none is sent — the form re-sends it, this one did too');

  await setBriefOk({ domainProvidedBy: 'ROOT', commitments: [{ key: 'domain', dueAt: '2026-11-02' }] });
  assert.equal((await boardRows()).find((r) => r.briefKey === 'domain')!.dueAt.toISOString(), '2026-11-02T00:00:00.000Z');
});

test('a commitment with no date is not created — the brief says so instead (COMMITMENT_UNDATED); the row appears once it has one', async () => {
  const c = await setBriefOk({ commitments: [{ key: 'domain', dueAt: '2026-10-05' }] });
  assert.deepEqual((await boardRows()).map((r) => r.briefKey), ['domain']);
  const undated = c.briefCompleteness.filter((m) => m.code === 'COMMITMENT_UNDATED').map((m) => m.key).sort();
  assert.deepEqual(undated, ['content', 'host']);

  const done = await setBriefOk();
  assert.equal((await boardRows()).length, 3);
  assert.equal(done.briefCompleteness.some((m) => m.code === 'COMMITMENT_UNDATED'), false);
});

test('a key no brief implies any more is removed — unless someone verified it, then it stays as an ordinary row', async () => {
  await setBriefOk();
  const host = (await boardRows()).find((r) => r.briefKey === 'host')!;
  const domain = (await boardRows()).find((r) => r.briefKey === 'domain')!;
  await prisma.dependency.update({ where: { id: domain.id }, data: { verifiedAt: new Date(), verifiedById: f.admin.id, verifiedNote: 'deployed a test file' } });

  await setBriefOk({ domainProvidedBy: null, hostProvidedBy: null, commitments: [] });
  const left = await boardRows();
  assert.equal(left.find((r) => r.id === host.id), undefined, 'the unverified one is gone');
  const kept = left.find((r) => r.id === domain.id)!;
  assert.equal(kept.briefKey, null, 'the verified one is kept, and freed from the brief');
  assert.equal(kept.verifiedAt !== null, true);
});

test('the board is the project’s: a sibling contract’s brief keeps a commitment alive, and adopts the same row', async () => {
  const second = await secondContract();
  await setBriefOk({ commitments: [{ key: 'domain', dueAt: '2026-10-05' }] });
  const [row] = await boardRows();
  await setBriefOk({ commitments: [{ key: 'domain', dueAt: '2026-10-05' }] }, staff.SALES, second.id);
  assert.equal((await boardRows()).length >= 1, true);
  assert.equal((await boardRows()).filter((r) => r.briefKey === 'domain').length, 1, 'one domain row for the project, not one per contract');
  assert.equal((await boardRows()).find((r) => r.briefKey === 'domain')!.id, row.id);

  // The second brief stops implying it — the first still does, so the row stays…
  await setBriefOk({ domainProvidedBy: null, commitments: [] }, staff.SALES, second.id);
  assert.equal((await boardRows()).some((r) => r.briefKey === 'domain'), true);
  // …and when the first stops too, it goes.
  await setBriefOk({ domainProvidedBy: null, commitments: [] });
  assert.equal((await boardRows()).some((r) => r.briefKey === 'domain'), false);
});

test('setBrief is a replace: what the form left out is cleared, and the wireframe allowance returns to two', async () => {
  await setBriefOk({ wireframeIterations: 5, mockupIterations: 3 });
  assert.equal(((await read(staff.SALES)).brief as { wireframeIterations: number }).wireframeIterations, 5);
  const c = await setBriefOk({ budgetCap: null, idealDeadline: null, domainName: null, mockupIterations: null, wireframeIterations: null });
  assert.equal(c.brief!.wireframeIterations, 2);
  assert.equal(c.brief!.mockupIterations, null);
  assert.equal(c.brief!.budgetCap, null);
  assert.equal(c.brief!.idealDeadline, null);
  assert.equal(c.brief!.domainName, null);
});

test('setBrief refuses, each with its own code, and writes nothing', async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['a budget of zero', { budgetCap: '0' }, 'INVALID_BUDGET'],
    ['a budget with a decimal', { budgetCap: '1.5' }, 'INVALID_BUDGET'],
    ['a date that is not a day', { hardDeadline: '2026-02-30' }, 'INVALID_DEADLINE'],
    ['a date in local-time shape', { hardDeadline: '2026-10-23T20:30:00Z' }, 'INVALID_DEADLINE'],
    ['ideal after hard', { idealDeadline: '2026-11-01', hardDeadline: '2026-10-01' }, 'DEADLINES_OUT_OF_ORDER'],
    ['an existing site that is not a url', { kind: 'FEATURE_FOR_EXISTING', existingSiteUrl: 'nahal' }, 'INVALID_SITE_URL'],
    ['negative support', { supportMonths: -1 }, 'INVALID_SUPPORT_MONTHS'],
    ['a zero allowance', { premadeRounds: 0 }, 'INVALID_ALLOWANCE'],
    ['a commitment date that is not a day', { commitments: [{ key: 'domain', dueAt: '5 Aban' }] }, 'INVALID_DATE'],
    ['a type that does not exist', { templateTypeId: 'nope' }, 'NOT_FOUND'],
  ];
  for (const [label, over, code] of cases) {
    assert.equal((await setBrief(over)).code, code, label);
  }
  assert.equal(await prisma.contractBrief.count(), 0);
  assert.equal((await boardRows()).length, 0);

  for (const who of [staff.DESIGNER, staff.DEVELOPER, staff.CONTRIBUTOR, f.customer]) {
    assert.equal((await setBrief({}, who)).code, 'FORBIDDEN');
  }
});

test('an inactive template type cannot be newly chosen, but a brief that already has it keeps it', async () => {
  await setBriefOk();
  await prisma.templateType.update({ where: { id: type.id }, data: { active: false } });
  const other = await prisma.templateType.create({ data: { slug: 'blog', labelFa: 'وبلاگ', labelEn: 'Blog', active: false } });
  assert.equal((await setBrief({ templateTypeId: other.id })).code, 'TEMPLATE_TYPE_INACTIVE');
  await setBriefOk({ budgetCap: '170000000' }); // the same, now-inactive type
});

test('step 1 does not exist on a legacy (DESIGN_FIRST) contract: STEP_NOT_ON_ROAD, and nothing is written', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  assert.equal((await setBrief()).code, 'STEP_NOT_ON_ROAD');
  assert.equal(
    (await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['Everything', '100', '', 0]) } })).code,
    'STEP_NOT_ON_ROAD',
  );
  assert.equal(await prisma.contractBrief.count(), 0);
});

// =================================================================================
// extras
// =================================================================================

async function extra(key: string, status: 'DECLINED' | 'AGREED' = 'DECLINED') {
  return prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key, kind: 'EXTRA', labelFa: 'ا', labelEn: key, status, contractId: f.contract.id },
  });
}

test('setExtra moves an extra between declined and agreed — and only an extra', async () => {
  const payment = await extra('checklist.payment');
  const page = await prisma.scopeItem.create({
    data: { projectId: f.contract.projectId, key: 'home', kind: 'PAGE', labelFa: 'ا', labelEn: 'Home', status: 'AGREED' },
  });

  ok(await exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: true } }));
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: payment.id } })).status, 'AGREED');
  // Idempotent.
  ok(await exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: true } }));
  ok(await exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: false } }));
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: payment.id } })).status, 'DECLINED');

  assert.equal((await exec(SET_EXTRA, { as: staff.SALES, variables: { s: page.id, in: false } })).code, 'NOT_AN_EXTRA');
  assert.equal((await exec(SET_EXTRA, { as: staff.DESIGNER, variables: { s: payment.id, in: true } })).code, 'FORBIDDEN');
  assert.equal((await exec(SET_EXTRA, { as: staff.SALES, variables: { s: 'nope', in: true } })).code, 'NOT_FOUND');
});

test('an extra that is in scope implies a commitment; switching it off removes the row — through setExtra and through the generic status setter alike', async () => {
  const payment = await extra('checklist.payment', 'AGREED');
  await setBriefOk({ commitments: [{ key: 'gateway', dueAt: '2026-10-09' }] });
  const gateway = (await boardRows()).find((r) => r.briefKey === 'gateway')!;
  assert.equal(gateway.side, 'CUSTOMER');
  assert.equal(gateway.technical, false, 'the gateway is sales’ to verify');

  ok(await exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: false } }));
  assert.equal((await boardRows()).some((r) => r.briefKey === 'gateway'), false);

  // Switched back on with no date: nothing can be created (a row needs a date) — the brief says so.
  const back = ok(await exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: true } })).setExtra as Contract;
  assert.equal((await boardRows()).some((r) => r.briefKey === 'gateway'), false);
  assert.ok(back.briefCompleteness.some((m) => m.code === 'COMMITMENT_UNDATED' && m.key === 'gateway'));
  await setBriefOk({ commitments: [{ key: 'gateway', dueAt: '2026-10-09' }] });
  assert.equal((await boardRows()).some((r) => r.briefKey === 'gateway'), true);

  // The registry's own status setter is a second door to the same fact.
  ok(
    await exec('mutation($s: ID!){ setScopeItemStatus(scopeItemId: $s, status: DECLINED) { id } }', {
      as: staff.SALES,
      variables: { s: payment.id },
    }),
  );
  assert.equal((await boardRows()).some((r) => r.briefKey === 'gateway'), false);
});

test('an extra that work has started on cannot be switched off from step 1', async () => {
  const notifications = await extra('checklist.notifications', 'AGREED');
  await prisma.scopeItem.update({ where: { id: notifications.id }, data: { status: 'IN_BUILD' } });
  assert.equal((await exec(SET_EXTRA, { as: staff.SALES, variables: { s: notifications.id, in: false } })).code, 'EXTRA_IN_PROGRESS');
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: notifications.id } })).status, 'IN_BUILD');
});

// =================================================================================
// the payment plan
// =================================================================================

test('setPaymentPlan stores exactly the rows it is given, in order — the split is a description, not a generator', async () => {
  // LUMP_SUM with three rows: the server does not "correct" it to one.
  const c = ok(
    await exec(SET_PLAN, {
      as: staff.SALES,
      variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['Deposit', '60000000', '', 7], ['Middle', '70000000', '', 14], ['Final', '50000000', '', 0]) },
    }),
  ).setPaymentPlan as Contract;
  assert.equal(c.paymentPlan!.split, 'LUMP_SUM');
  assert.deepEqual(c.paymentPlan!.invoices.map((i) => [i.ordinal, i.labelEn, i.amount, i.paymentTermDays]), [
    [1, 'Deposit', '60000000', 7],
    [2, 'Middle', '70000000', 14],
    [3, 'Final', '50000000', 0],
  ]);
  assert.equal(c.paymentPlan!.total, '180000000');

  // Replace-all: the second save leaves only its own rows, and one plan.
  const again = ok(
    await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: rows(['One', '180000000', '', 30]) } }),
  ).setPaymentPlan as Contract;
  assert.equal(again.paymentPlan!.invoices.length, 1);
  assert.equal(again.paymentPlan!.id, c.paymentPlan!.id, 'the plan is updated, not recreated');
  assert.equal(await prisma.paymentPlan.count(), 1);
  assert.equal(await prisma.plannedInvoice.count(), 1);
});

test('setPaymentPlan refuses bad rows and a phase that is not this contract’s, and leaves the old plan alone', async () => {
  const second = await secondContract();
  const foreign = await prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: second.id, number: 1, titleFa: 'ا', titleEn: 'foreign' },
  });
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['Keep', '100', '', 0]) } }));

  const attempt = (r: unknown[]) => exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r } });
  assert.equal((await attempt([])).code, 'PLAN_ROWS_REQUIRED');
  assert.equal((await attempt(rows(['Zero', '0', '', 0]))).code, 'INVALID_AMOUNT');
  assert.equal((await attempt(rows(['Decimal', '1.5', '', 0]))).code, 'INVALID_AMOUNT');
  assert.equal((await attempt(rows(['Term', '10', '', -1]))).code, 'INVALID_TERM');
  assert.equal((await attempt([{ ...rows(['x', '1', '', 0])[0], labelEn: ' ' }])).code, 'LABEL_REQUIRED');
  assert.equal((await attempt(rows(['Foreign', '10', foreign.id, 0]))).code, 'PHASE_WRONG_CONTRACT');
  const still = await prisma.plannedInvoice.findMany();
  assert.deepEqual(still.map((i) => i.labelEn), ['Keep']);

  for (const who of [staff.DESIGNER, staff.DEVELOPER, f.customer]) {
    assert.equal((await exec(SET_PLAN, { as: who, variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['x', '1', '', 0]) } })).code, 'FORBIDDEN');
  }
});

test('a planned invoice may name one of this contract’s phases, and loses the link — not the row — when the phase goes', async () => {
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: '2026-11-10' } })).createPhase as Contract;
  const phaseId = phase.phases[0].id;
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: rows(['On phase 1', '100', phaseId, 5]) } }));
  assert.equal((await prisma.plannedInvoice.findFirstOrThrow()).phaseId, phaseId);
  ok(await exec('mutation($p: ID!){ deletePhase(phaseId: $p) { id } }', { as: staff.SALES, variables: { p: phaseId } }));
  const invoice = await prisma.plannedInvoice.findFirstOrThrow();
  assert.equal(invoice.phaseId, null);
});

// =================================================================================
// phases belong to a contract
// =================================================================================

test('a phase names its contract; numbers are per contract; the two lists differ — Contract.phases is its own, Project.phases the project’s', async () => {
  const second = await secondContract();
  const a = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: '2026-11-10' } })).createPhase as Contract;
  ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: second.id, n: 1, end: null } }));
  assert.equal((await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: null } })).code, 'PHASE_NUMBER_TAKEN');

  assert.deepEqual(a.phases.map((p) => [p.number, p.contractId, p.plannedEndAt]), [[1, f.contract.id, '2026-11-10T00:00:00.000Z']]);
  const mine = await read(staff.SALES);
  const theirs = await read(staff.SALES, false, second.id);
  assert.equal(mine.phases.length, 1);
  assert.equal(theirs.phases.length, 1);
  assert.notEqual(mine.phases[0].id, theirs.phases[0].id);
  assert.equal(mine.project.phases.length, 2, 'the project holds both');
  // Each road shows the demos of its own phases only (J3's placeholder for a contract with none is gone with the stopgap).
  assert.deepEqual(mine.wizard.filter((w) => w.step === 'DEMO').length, 1);
});

test('updatePhase: plannedEndAt is omitted (left), null (cleared) or a day (set); a bad day is INVALID_DATE; a contract that is not the phase’s is NOT_FOUND', async () => {
  const second = await secondContract();
  const c = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: '2026-11-10' } })).createPhase as Contract;
  const id = c.phases[0].id;
  const UPDATE = (extra: string, contractId?: string) =>
    exec(`mutation($p: ID!, $c: ID){ updatePhase(phaseId: $p, titleFa: "ب", titleEn: "Renamed", contractId: $c${extra}) { id phases { id plannedEndAt } } }`, {
      as: staff.SALES,
      variables: { p: id, c: contractId ?? null },
    });
  const end = async () => (await prisma.phase.findUniqueOrThrow({ where: { id } })).plannedEndAt?.toISOString() ?? null;

  ok(await UPDATE(''));
  assert.equal(await end(), '2026-11-10T00:00:00.000Z', 'omitted leaves it');
  ok(await UPDATE(', plannedEndAt: "2026-12-01"'));
  assert.equal(await end(), '2026-12-01T00:00:00.000Z');
  ok(await UPDATE(', plannedEndAt: null'));
  assert.equal(await end(), null, 'null clears it');
  assert.equal((await UPDATE(', plannedEndAt: "1 Aban"')).code, 'INVALID_DATE');
  assert.equal((await UPDATE('', second.id)).code, 'NOT_FOUND');
  assert.equal((await prisma.phase.findUniqueOrThrow({ where: { id } })).titleEn, 'Renamed');
});

test('a developer’s claim on a phase is its own contract’s developer — not any contract on the project (S1’s stopgap, retired)', async () => {
  const otherDev = await prisma.user.create({
    data: { email: 'dev2@test.local', name: 'Dev 2', roles: ['DEVELOPER'], state: 'ACTIVE' },
  });
  const second = await secondContract({ developerId: otherDev.id, designerId: staff.DESIGNER.id });
  const mineP = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ا', titleEn: 'mine' } });
  const theirsP = await prisma.phase.create({ data: { projectId: f.contract.projectId, contractId: second.id, number: 1, titleFa: 'ب', titleEn: 'theirs' } });
  const DEMO = (phaseId: string) =>
    exec('mutation($p: ID!){ createDemo(phaseId: $p, stagingUrl: "https://a.staging.localhost") { id } }', { as: staff.DEVELOPER, variables: { p: phaseId } });

  ok(await DEMO(mineP.id));
  assert.equal((await DEMO(theirsP.id)).code, 'NOT_ASSIGNED', 'a developer of the project is not the developer of every phase on it');
  assert.equal(
    (await exec('mutation($p: ID!){ createDemo(phaseId: $p, stagingUrl: "https://a.staging.localhost") { id } }', { as: otherDev, variables: { p: mineP.id } })).code,
    'NOT_ASSIGNED',
  );

  // The desk's phase picker offers each developer their own phases.
  const list = async (as: User) =>
    (ok(await exec('{ phasesForBuilds { id } }', { as })).phasesForBuilds as Array<{ id: string }>).map((p) => p.id);
  assert.deepEqual(await list(staff.DEVELOPER), [mineP.id]);
  assert.deepEqual(await list(otherDev), [theirsP.id]);
  assert.deepEqual((await list(f.admin)).sort(), [mineP.id, theirsP.id].sort());

  // And so does the queue: an item on the other contract's demo is not in this developer's.
  const item = async (contractId: string, phaseId: string, key: string) => {
    const demo = await prisma.demo.create({ data: { projectId: f.contract.projectId, phaseId, stagingUrl: `https://${key}.example.com`, publishedAt: new Date() } });
    const page = await prisma.demoPage.create({ data: { demoId: demo.id, key, labelFa: 'ا', labelEn: key, canonicalPath: `/${key}` } });
    return prisma.feedbackItem.create({
      data: { projectId: f.contract.projectId, contractId, step: 'DEMO', phaseId, demoId: demo.id, demoPageId: page.id },
    });
  };
  const mineItem = await item(f.contract.id, mineP.id, 'mine');
  const theirItem = await item(second.id, theirsP.id, 'theirs');
  const queue = async (as: User) =>
    (ok(await exec('query($p: ID!){ openFeedbackQueue(projectId: $p) { id } }', { as, variables: { p: f.contract.projectId } })).openFeedbackQueue as Array<{ id: string }>).map((i) => i.id);
  assert.deepEqual(await queue(staff.DEVELOPER), [mineItem.id]);
  assert.deepEqual(await queue(otherDev), [theirItem.id]);
  assert.deepEqual((await queue(f.admin)).sort(), [mineItem.id, theirItem.id].sort());
});

// =================================================================================
// the locks: every J4 write asks assertStepOpen(REQUIREMENTS)
// =================================================================================

test('once the agreement is approved every J4 write is STEP_LOCKED — and writes nothing', async () => {
  const payment = await extra('checklist.payment');
  await setBriefOk();
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: '2026-11-10' } })).createPhase as Contract;
  const phaseId = phase.phases[0].id;
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['Only', '100', '', 0]) } }));
  const brief = await prisma.contractBrief.findFirstOrThrow();

  await approveAgreement();
  const locked = await read(staff.SALES);
  assert.ok(locked.wizard.filter((w) => ['REQUIREMENTS', 'SCOPE', 'DRAFT'].includes(w.step)).every((w) => w.locked), 'AGREEMENT seals steps 1–3');

  const attempts: Array<[string, Promise<{ code?: string }>]> = [
    ['setBrief', setBrief({ budgetCap: '1' })],
    ['setExtra', exec(SET_EXTRA, { as: staff.SALES, variables: { s: payment.id, in: true } })],
    ['setPaymentPlan', exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'LUMP_SUM', r: rows(['New', '5', '', 0]) } })],
    ['createPhase', exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 2, end: null } })],
    ['updatePhase', exec('mutation($p: ID!){ updatePhase(phaseId: $p, titleFa: "ب", titleEn: "X") { id } }', { as: staff.SALES, variables: { p: phaseId } })],
    ['deletePhase', exec('mutation($p: ID!){ deletePhase(phaseId: $p) { id } }', { as: staff.SALES, variables: { p: phaseId } })],
  ];
  for (const [name, attempt] of attempts) assert.equal((await attempt).code, 'STEP_LOCKED', name);

  assert.equal(String((await prisma.contractBrief.findFirstOrThrow()).budgetCap), String(brief.budgetCap), 'the brief is as it was');
  assert.equal((await prisma.scopeItem.findUniqueOrThrow({ where: { id: payment.id } })).status, 'DECLINED');
  assert.deepEqual((await prisma.plannedInvoice.findMany()).map((i) => i.labelEn), ['Only']);
  assert.equal(await prisma.phase.count(), 1);
});

test('a legacy contract’s phases are not locked by anything — there is no step 1 to lock', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { sequence: 'DESIGN_FIRST' } });
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'AGREEMENT', approvedById: f.admin.id } });
  ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: null } }));
});

// =================================================================================
// money (PD-14) and PD-21
// =================================================================================

test('every money field J4 adds is null for the designer and the developer and present for sales, the customer, and sales viewing as the customer', async () => {
  await setBriefOk();
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: rows(['A', '100000000', '', 7], ['B', '80000000', '', 7]) } }));

  const budget = (c: Contract) => (c.brief as { budgetCap: string | null }).budgetCap;
  for (const who of [staff.SALES, f.admin, f.customer]) {
    const c = await read(who);
    assert.equal(budget(c), '150000000', `budgetCap for ${String(who.email)}`);
    assert.equal(c.paymentPlan!.total, '180000000', `plan for ${String(who.email)}`);
    assert.equal(c.paymentPlan!.invoices.length, 2);
  }
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    const c = await read(who);
    // The rest of the brief is theirs to read; the money is not.
    assert.equal(c.brief!.kind, 'NEW_SITE');
    assert.equal(c.brief!.hardDeadline, '2026-10-23T00:00:00.000Z');
    assert.equal(budget(c), null, `budgetCap for ${String(who.email)}`);
    assert.equal(c.paymentPlan, null, `payment plan for ${String(who.email)}`);
  }
  // View-as-customer is the customer's own read, through the same rule.
  const asCustomer = await read(staff.SALES, true);
  assert.deepEqual([budget(asCustomer), asCustomer.paymentPlan?.total], ['150000000', '180000000']);
  // …and sales viewing as the customer reads what the customer reads, nothing more.
  assert.deepEqual(await read(f.customer), asCustomer);
});

async function sensitiveArticles() {
  for (const [number, titleEn, sensitive] of [
    [4, 'Fees', true],
    [5, 'Payment Schedule', true],
    [6, 'Revisions', false],
  ] as const) {
    await prisma.article.create({
      data: { contractId: f.contract.id, number, titleFa: `ماده ${number}`, titleEn, bodyFa: `بدنه ${number}`, bodyEn: `Body ${number}`, sensitive },
    });
  }
  // Not through `publishContractRevision`: since J6 that has gates on this road
  // (a scope, a complete brief), and these tests are about what a published
  // article reveals, not about being allowed to publish one.
  // A format-1 revision on purpose: this is the live-row rule J4 wrote for every
  // revision that does not freeze the flag itself (J7's format 2 does, and
  // `j7.test.ts` holds that side).
  await publishDraftDirect(f.contract.id, { format: 1 });
}
const ARTICLES = `query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { articles { number titleEn sensitive bodyFa bodyEn } draft { articles { number bodyEn sensitive } } } }`;
type Articles = { articles: Array<{ number: number; titleEn: string; sensitive: boolean; bodyFa: string | null; bodyEn: string | null }>; draft: { articles: Array<{ number: number; bodyEn: string | null }> } | null };
const articlesFor = async (who: User, asCustomer = false) =>
  ok(await exec(ARTICLES, { as: who, variables: { c: f.contract.id, as: asCustomer } })).contract as Articles;

test('a sensitive article’s body is withheld from staff without money.read — the title stays — and every reader who may see money reads it', async () => {
  await sensitiveArticles();
  for (const who of [staff.SALES, f.admin, f.customer]) {
    const { articles } = await articlesFor(who);
    assert.equal(articles.find((a) => a.number === 4)!.bodyEn, 'Body 4', String(who.email));
    assert.equal(articles.find((a) => a.number === 5)!.bodyFa, 'بدنه 5', String(who.email));
  }
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    const { articles } = await articlesFor(who);
    const fees = articles.find((a) => a.number === 4)!;
    assert.deepEqual([fees.titleEn, fees.sensitive, fees.bodyEn, fees.bodyFa], ['Fees', true, null, null], `${who.email}: the title stays, the body goes`);
    assert.equal(articles.find((a) => a.number === 5)!.bodyEn, null);
    assert.equal(articles.find((a) => a.number === 6)!.bodyEn, 'Body 6', 'an ordinary article is theirs to read');
    assert.equal(articles.find((a) => a.number === 1)!.bodyEn, 'Body 1');
    // The draft is sales' (contracts.author), and null for them as ever.
    assert.equal((await articlesFor(who)).draft, null);
  }
  // The published snapshot itself is untouched — the hash still verifies.
  const revision = await prisma.contractRevision.findFirstOrThrow({ orderBy: { version: 'desc' } });
  assert.equal(JSON.stringify(revision.snapshot).includes('Body 4'), true, 'the frozen text is whole; only the view is redacted');
  assert.equal(JSON.stringify(revision.snapshot).includes('sensitive'), false, 'no new key entered the snapshot');
  // Sales' draft carries the bodies and the flag.
  const draft = (await articlesFor(staff.SALES)).draft!;
  assert.equal(draft.articles.find((a) => a.number === 4)!.bodyEn, 'Body 4');
  // Viewing as the customer is the customer's read.
  assert.deepEqual((await articlesFor(staff.SALES, true)).articles, (await articlesFor(f.customer)).articles);
});

test('deleting a money article from the draft does not un-hide the published one', async () => {
  await sensitiveArticles();
  ok(await exec('mutation($c: ID!){ deleteArticle(contractId: $c, number: 4) { id } }', { as: staff.SALES, variables: { c: f.contract.id } }));
  const { articles } = await articlesFor(staff.DESIGNER);
  assert.equal(articles.find((a) => a.number === 4)!.bodyEn, null, 'the template’s own rule stands in for the deleted row');
  assert.equal(articles.find((a) => a.number === 4)!.sensitive, true);
});

test('setArticle: a new Fees or Payment Schedule article is sensitive by the template’s rule; an existing flag is kept unless said; the flag can be set', async () => {
  const SET = `mutation($c: ID!, $n: Int!, $t: String!, $s: Boolean){ setArticle(contractId: $c, number: $n, titleFa: "ا", titleEn: $t, bodyEn: "x", sensitive: $s) { id } }`;
  ok(await exec(SET, { as: staff.SALES, variables: { c: f.contract.id, n: 4, t: 'Fees', s: null } }));
  ok(await exec(SET, { as: staff.SALES, variables: { c: f.contract.id, n: 7, t: 'Intellectual Property', s: null } }));
  ok(await exec(SET, { as: staff.SALES, variables: { c: f.contract.id, n: 8, t: 'Confidentiality', s: true } }));
  const flag = async (n: number) => (await prisma.article.findFirstOrThrow({ where: { contractId: f.contract.id, number: n } })).sensitive;
  assert.deepEqual([await flag(4), await flag(7), await flag(8)], [true, false, true]);
  ok(await exec(SET, { as: staff.SALES, variables: { c: f.contract.id, n: 4, t: 'Fees (edited)', s: null } }));
  assert.equal(await flag(4), true, 'an omitted flag keeps what the row had');
  ok(await exec(SET, { as: staff.SALES, variables: { c: f.contract.id, n: 4, t: 'Fees (edited)', s: false } }));
  assert.equal(await flag(4), false);
});

test('applyContractTemplate flags Fees and Payment Schedule — and only them', async () => {
  const empty = await prisma.contract.create({
    data: { ref: 'RC-TEMPLATE', titleFa: 'ت', titleEn: 'T', customerId: f.customer.id, projectId: (await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ت', titleEn: 'T' } })).id },
  });
  ok(await exec('mutation($c: ID!){ applyContractTemplate(contractId: $c) { id } }', { as: staff.SALES, variables: { c: empty.id } }));
  const flagged = await prisma.article.findMany({ where: { contractId: empty.id, sensitive: true }, orderBy: { number: 'asc' } });
  assert.deepEqual(flagged.map((a) => [a.number, a.titleEn]), [[4, 'Fees'], [5, 'Payment Schedule']]);
});

test('PD-21: a note on a sensitive article is about money — hidden from the designer’s list, queue and answers; visible to sales; a note on an ordinary article is not', async () => {
  await sensitiveArticles();
  const revision = await prisma.contractRevision.findFirstOrThrow({ orderBy: { version: 'desc' } });
  const SUBMIT = `mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: DRAFT, target: $t, body: "hm") { item { id } } }`;
  const note = async (articleNumber: number) =>
    (ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { contractRevisionId: revision.id, articleNumber } } })).submitFeedback as { item: { id: string } }).item.id;
  const fees = await note(4);
  const ordinary = await note(6);

  const list = async (who: User, asCustomer = false) =>
    (ok(await exec(`query($c: ID!, $as: Boolean){ contract(id: $c, asCustomer: $as) { feedbackItems(step: DRAFT) { id } } }`, { as: who, variables: { c: f.contract.id, as: asCustomer } })).contract as { feedbackItems: Array<{ id: string }> }).feedbackItems.map((i) => i.id);
  assert.deepEqual((await list(staff.SALES)).sort(), [fees, ordinary].sort());
  assert.deepEqual((await list(f.customer)).sort(), [fees, ordinary].sort());
  assert.deepEqual(await list(staff.DESIGNER), [ordinary], 'the designer is not told what the customer said about the fee');
  assert.deepEqual(await list(staff.DEVELOPER), [ordinary]);

  const queue = async (who: User) =>
    (ok(await exec('{ myFeedbackQueue { item { id } } }', { as: who })).myFeedbackQueue as Array<{ item: { id: string } }>).map((e) => e.item.id);
  assert.ok((await queue(staff.SALES)).includes(fees));
  assert.deepEqual(await queue(staff.DESIGNER), [ordinary]);

  // The designer cannot answer it, nor learn that it exists.
  assert.equal(
    (await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "no") { id } }', { as: staff.DESIGNER, variables: { i: fees } })).code,
    'NOT_FOUND',
  );
  ok(await exec('mutation($i: ID!){ answerFeedback(itemId: $i, body: "ok") { id } }', { as: staff.SALES, variables: { i: fees } }));
});

test('the wizard’s attention flags a note on a sensitive article as money, so the designer’s status area never counts it', async () => {
  await sensitiveArticles();
  const revision = await prisma.contractRevision.findFirstOrThrow({ orderBy: { version: 'desc' } });
  const SUBMIT = `mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: DRAFT, target: $t, body: "hm") { item { id } } }`;
  ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { contractRevisionId: revision.id, articleNumber: 4 } } }));
  const ATT = `query($c: ID!){ contract(id: $c) { attention { kind variant } statusSummary { waitingOnRoot } } }`;
  const count = async (who: User) => {
    const c = ok(await exec(ATT, { as: who, variables: { c: f.contract.id } })).contract as { attention: unknown[]; statusSummary: { waitingOnRoot: number } };
    return c.statusSummary.waitingOnRoot;
  };
  const sales = await count(staff.SALES);
  const designer = await count(staff.DESIGNER);
  assert.ok(sales > designer, `sales sees the fee note waiting (${sales}); the designer does not (${designer})`);
});

// =================================================================================
// feedback anchors on step 1
// =================================================================================

test('a REQUIREMENTS note is anchored to a field some card renders; a name the brief does not have is INVALID_TARGET', async () => {
  const SUBMIT = `mutation($c: ID!, $t: FeedbackTargetInput!){ submitFeedback(contractId: $c, step: REQUIREMENTS, target: $t, body: "hm") { item { id briefField } } }`;
  for (const field of ['hardDeadline', 'budgetCap', 'paymentPlan', 'phases', 'domain', 'extras', 'templateType']) {
    const item = (ok(await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { briefField: field } } })).submitFeedback as { item: { briefField: string } }).item;
    assert.equal(item.briefField, field);
  }
  for (const bad of ['nope', 'Budget', 'hard deadline']) {
    assert.equal((await exec(SUBMIT, { as: f.customer, variables: { c: f.contract.id, t: { briefField: bad } } })).code, 'INVALID_TARGET', bad);
  }
});

// =================================================================================
// handing step 1 to the customer
// =================================================================================

async function draftContract(over: Record<string, unknown> = {}) {
  return secondContract({ ref: 'RC-DRAFT', publishedAt: null, status: 'DRAFT', ...over });
}
const PUBLISH = `mutation($c: ID!){ publishContract(contractId: $c) { id } }`;

test('handing over a new-road contract needs a brief (BRIEF_MISSING); then it publishes and tells the customer, by email and SMS, in their language', async () => {
  const draft = await draftContract();
  assert.equal((await exec(PUBLISH, { as: staff.SALES, variables: { c: draft.id } })).code, 'BRIEF_MISSING');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: draft.id } })).publishedAt, null);
  assert.equal(mail.length, 0);

  // A brief with only its three identity fields is a brief: the rest may still be incomplete.
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: draft.id, i: { kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK' } } }));
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: draft.id } }));
  const after = await prisma.contract.findUniqueOrThrow({ where: { id: draft.id } });
  assert.ok(after.publishedAt);
  assert.equal(after.status, 'WAITING_ON_CUSTOMER');

  const toCustomer = mail.filter((m) => m.to === f.customer.email);
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].subject, /نیازمندی‌های پروژه‌ی شما برای خواندن آماده است/);
  assert.ok(toCustomer[0].text.includes(`/fa/app/contracts/${draft.id}`), 'the link opens the contract, in the customer’s language');
  const texts = sms.filter((s) => s.to === f.customer.phone);
  assert.equal(texts.length, 1);
  assert.match(texts[0].text!, /نیازمندی‌های پروژه‌ی شما در ریشه آماده است/);

  // Idempotent: a second click changes nothing and tells no one.
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: draft.id } }));
  assert.equal(mail.filter((m) => m.to === f.customer.email).length, 1);
  assert.equal(sms.filter((s) => s.to === f.customer.phone).length, 1);
});

test('the customer cannot read a contract that has not been handed over, and can once it is — with the incomplete parts named, not hidden', async () => {
  const draft = await draftContract();
  ok(await exec(SET_BRIEF, { as: staff.SALES, variables: { c: draft.id, i: { kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'CLAUDE_ASSISTED' } } }));
  assert.equal((await exec(READ, { as: f.customer, variables: { c: draft.id } })).code, 'NOT_FOUND');
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: draft.id } }));
  const seen = await read(f.customer, false, draft.id);
  assert.equal(seen.brief!.designTier, 'CLAUDE_ASSISTED');
  const missing = seen.briefCompleteness.map((m) => m.code);
  for (const code of ['BUDGET_CAP', 'HARD_DEADLINE', 'DOMAIN_PROVIDER', 'PHASES', 'PAYMENT_PLAN', 'MOCKUP_ITERATIONS']) {
    assert.ok(missing.includes(code), `${code} is named`);
  }
  assert.equal(seen.brief!.budgetCap, null);
});

test('a legacy (DESIGN_FIRST) contract publishes exactly as it always did — no brief needed, no message sent', async () => {
  const legacy = await draftContract({ ref: 'RC-LEGACY', sequence: 'DESIGN_FIRST' });
  ok(await exec(PUBLISH, { as: staff.SALES, variables: { c: legacy.id } }));
  assert.ok((await prisma.contract.findUniqueOrThrow({ where: { id: legacy.id } })).publishedAt);
  assert.equal(mail.length, 0);
  assert.equal(sms.length, 0);
});

// =================================================================================
// the board
// =================================================================================

test('a commitment the brief owns cannot be deleted from the board (BRIEF_OWNED); an ordinary row can', async () => {
  await setBriefOk();
  const owned = (await boardRows()).find((r) => r.briefKey === 'host')!;
  const ordinary = await prisma.dependency.create({
    data: { projectId: f.contract.projectId, side: 'ROOT', titleFa: 'ا', titleEn: 'Ordinary', dueAt: new Date(), createdById: f.admin.id },
  });
  const DELETE = 'mutation($d: ID!){ deleteDependency(dependencyId: $d) { id } }';
  assert.equal((await exec(DELETE, { as: staff.SALES, variables: { d: owned.id } })).code, 'BRIEF_OWNED');
  assert.equal((await exec(DELETE, { as: f.admin, variables: { d: owned.id } })).code, 'BRIEF_OWNED', 'not even ADMIN');
  assert.equal(await prisma.dependency.count({ where: { id: owned.id } }), 1);
  ok(await exec(DELETE, { as: staff.SALES, variables: { d: ordinary.id } }));
  assert.equal(await prisma.dependency.count({ where: { id: ordinary.id } }), 0);
  // Changing the brief is the way out.
  await setBriefOk({ hostProvidedBy: null });
  assert.equal(await prisma.dependency.count({ where: { id: owned.id } }), 0);
});

test('verification is routed by the flag: a technical row is the developer’s, a general row sales’ — and neither may take the other’s', async () => {
  await setBriefOk();
  const board = await boardRows();
  const technical = board.find((r) => r.briefKey === 'host')!;
  const general = board.find((r) => r.briefKey === 'content')!;
  assert.deepEqual([technical.technical, general.technical], [true, false]);

  const VERIFY = 'mutation($d: ID!){ verifyDependency(dependencyId: $d, note: "checked it") { id } }';
  const UNVERIFY = 'mutation($d: ID!){ unverifyDependency(dependencyId: $d) { id } }';
  const code = async (who: User, dep: string, query = VERIFY) => (await exec(query, { as: who, variables: { d: dep } })).code ?? 'OK';

  assert.equal(await code(staff.SALES, technical.id), 'FORBIDDEN', 'sales cannot verify a hosting');
  assert.equal(await code(staff.DEVELOPER, general.id), 'FORBIDDEN', 'the developer cannot verify the content');
  assert.equal(await code(staff.DESIGNER, technical.id), 'FORBIDDEN');
  assert.equal(await code(staff.CONTRIBUTOR, general.id), 'FORBIDDEN');
  assert.equal(await code(f.customer, general.id), 'FORBIDDEN');

  assert.equal(await code(staff.DEVELOPER, technical.id), 'OK');
  assert.equal(await code(staff.SALES, general.id), 'OK');
  assert.equal(await code(f.admin, technical.id), 'OK', 'ADMIN holds both');
  assert.equal(await code(staff.SALES, technical.id, UNVERIFY), 'FORBIDDEN');
  assert.equal(await code(staff.DEVELOPER, technical.id, UNVERIFY), 'OK');
  assert.equal(await code(staff.DEVELOPER, general.id, UNVERIFY), 'FORBIDDEN');

  // A developer of some other project is not this project's developer.
  const stranger = await prisma.user.create({ data: { email: 'dev3@test.local', name: 'Dev 3', roles: ['DEVELOPER'], state: 'ACTIVE' } });
  assert.equal(await code(stranger, technical.id), 'NOT_ASSIGNED');
});

// =================================================================================
// the wizard's signal
// =================================================================================

test('REQUIREMENTS is done exactly when briefCompleteness is empty — and the current step moves on with it', async () => {
  await sensitiveArticles(); // gives the contract a draft fee of 180,000,000 already
  const road = (c: Contract) => Object.fromEntries(c.wizard.map((w) => [w.step, w.status]).filter(([s]) => ['REQUIREMENTS', 'SCOPE'].includes(s as string)));

  const start = await read(staff.SALES);
  assert.deepEqual(road(start), { REQUIREMENTS: 'CURRENT', SCOPE: 'UPCOMING' });
  assert.equal(start.briefCompleteness.length > 0, true);

  await setBriefOk();
  const phase = ok(await exec(CREATE_PHASE, { as: staff.SALES, variables: { c: f.contract.id, n: 1, end: '2026-11-10' } })).createPhase as Contract;
  const midway = await read(staff.SALES);
  assert.deepEqual(midway.briefCompleteness.map((m) => m.code), ['PAYMENT_PLAN'], 'only the plan is left');
  assert.equal(road(midway).REQUIREMENTS, 'CURRENT');

  // A plan that does not add up to the fee is still incomplete…
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: rows(['A', '100000000', phase.phases[0].id, 7]) } }));
  assert.deepEqual((await read(staff.SALES)).briefCompleteness.map((m) => m.code), ['PAYMENT_PLAN_TOTAL']);
  // …and one that does is done.
  ok(await exec(SET_PLAN, { as: staff.SALES, variables: { c: f.contract.id, s: 'INSTALLMENTS', r: rows(['A', '100000000', phase.phases[0].id, 7], ['B', '80000000', '', 7]) } }));
  const done = await read(staff.SALES);
  assert.deepEqual(done.briefCompleteness, []);
  assert.deepEqual(road(done), { REQUIREMENTS: 'DONE', SCOPE: 'CURRENT' });
  // The customer's road agrees — the signal is not a staff-only view.
  assert.deepEqual(road(await read(f.customer)), { REQUIREMENTS: 'DONE', SCOPE: 'CURRENT' });
});
