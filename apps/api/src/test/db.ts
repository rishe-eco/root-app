import bcrypt from 'bcryptjs';
import { buildContractSnapshot, contentHash, draftState } from '../lib/revision.js';
import { agreedScopeSnapshot } from '../lib/scope.js';
import { draftStateOn } from '../graphql/resolvers/agreement.js';
import { loadContract } from '../graphql/resolvers/contracts.js';
// The same singleton the resolvers use, deliberately — a second client would
// be a second connection pool and a second chance to be looking at a different
// database than the code under test.
import { prisma } from '../lib/prisma.js';

/**
 * A real Postgres, not a mock.
 *
 * Everything worth testing in the resolvers is a database fact — who owns a
 * contract, whether a revision is published, which unique constraint refuses a
 * second signature. A mocked client would be asserting that the code calls the
 * methods this test expects, which is a restatement of the code, not a check
 * on it.
 *
 * Point DATABASE_URL at a throwaway database before running these. The npm
 * script does it; `process.loadEnvFile()` in env.ts does not override a
 * variable that is already set, so the shell wins over apps/api/.env.
 */

const url = process.env.DATABASE_URL ?? '';

// This truncates every table it can find. Running it against the development
// database — or worse, production — would be unrecoverable, so it refuses
// anything that is not visibly a test database.
if (!/_test(\?|$)/.test(url.split('/').pop() ?? '')) {
  throw new Error(
    `Refusing to run: DATABASE_URL does not name a *_test database.\n` +
      `  got: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}\n` +
      `  try: npm run test:integration --workspace=apps/api`,
  );
}

export { prisma };

/**
 * Empty every table between tests. TRUNCATE … CASCADE rather than deleting in
 * dependency order: the order is a second copy of the schema's foreign keys
 * and would rot the first time one changed.
 */
export async function resetDatabase() {
  const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  // J13: `RESTART IDENTITY` restarts only sequences a column owns, and
  // `invoice_number_seq` is not one — so without this the first invoice of a
  // test would be numbered by however many earlier tests issued, and no test
  // could say "INV-000001". (Nothing in production ever does this: an invoice
  // number is never reused.)
  await prisma.$executeRawUnsafe(`ALTER SEQUENCE "invoice_number_seq" RESTART`);
}

export type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/**
 * One contract, mid-flow: design revision v1 published with three concepts of
 * four pages each and nothing chosen yet, contract revision v1 published and
 * sealed, neither approved nor signed. That is the state a customer opens the
 * portal to, so it is the state most tests want to start from.
 */
export async function seedFixture(opts: { sequence?: 'DESIGN_FIRST' | 'AGREEMENT_FIRST' } = {}) {
  const passwordHash = await bcrypt.hash('a-long-enough-password', 4); // cost 4: tests, not production
  const publishedAt = new Date('2026-07-01T09:00:00Z');

  const admin = await prisma.user.create({
    data: { email: 'admin@test.local', name: 'Root', roles: ['ADMIN'], state: 'ACTIVE', passwordHash },
  });
  const customer = await prisma.user.create({
    data: {
      email: 'customer@test.local',
      name: 'Customer',
      clientName: 'Test Studio',
      roles: ['CUSTOMER'],
      state: 'ACTIVE',
      passwordHash,
    },
  });
  // Journeys build plan S3: the product-import tool is a grant, and L7's
  // suites (and anything else that drives the services resolvers as this
  // customer) predate that — so the fixture customer holds it, exactly as the
  // seeded one does. A test about *not* having the tool revokes it.
  await prisma.toolGrant.create({
    data: { customerId: customer.id, tool: 'PRODUCT_IMPORT', grantedById: admin.id },
  });
  // A second customer, so "can A read B's contract?" is answerable.
  const stranger = await prisma.user.create({
    data: {
      email: 'stranger@test.local',
      name: 'Stranger',
      roles: ['CUSTOMER'],
      state: 'ACTIVE',
      passwordHash,
    },
  });

  // Every contract has a project (build plan D1; required by the database
  // since J2) — `createContract` makes one in the same transaction, or is
  // handed a requested one. A fixture that inserts a contract straight through
  // Prisma names one too.
  const project = await prisma.project.create({
    data: {
      customerId: customer.id,
      titleFa: 'قرارداد آزمایشی',
      titleEn: 'Test contract',
    },
  });

  const contract = await prisma.contract.create({
    data: {
      ref: 'RC-TEST-001',
      titleFa: 'قرارداد آزمایشی',
      titleEn: 'Test contract',
      customerId: customer.id,
      projectId: project.id,
      amount: BigInt(180_000_000),
      status: 'WAITING_ON_CUSTOMER',
      publishedAt,
      // Unset takes the column's default, the new road (J3). The suites written
      // before J3 — the draft, both lineages' revisions, the gate — drive the
      // *legacy* road, and say so: since J5 and J6 the two roads differ in what
      // a customer may do (`setScopeItem`, `addComment`) and what publishing a
      // revision requires, so a legacy test that ran on the new road by
      // default would be testing something else.
      ...(opts.sequence ? { sequence: opts.sequence } : {}),
    },
  });

  const designRevision = await prisma.designRevision.create({
    data: { contractId: contract.id, version: 1, publishedAt },
  });

  for (const [i, key] of ['1a', '1b', '1c'].entries()) {
    const concept = await prisma.designConcept.create({
      data: {
        designRevisionId: designRevision.id,
        key,
        labelFa: `طرح ${key}`,
        labelEn: `Concept ${key}`,
        position: i,
      },
    });
    for (const [j, pk] of ['home', 'about', 'contracts', 'portal'].entries()) {
      await prisma.pageDesign.create({
        data: {
          conceptId: concept.id,
          key: pk,
          labelFa: pk,
          labelEn: pk,
          position: j,
          imageUrl: `/img/${key}-${pk}.png`,
        },
      });
    }
  }

  for (const n of [1, 2, 3]) {
    await prisma.article.create({
      data: {
        contractId: contract.id,
        number: n,
        titleFa: `ماده ${n}`,
        titleEn: `Article ${n}`,
        bodyFa: `متن ${n}`,
        bodyEn: `Body ${n}`,
      },
    });
  }

  const articles = await prisma.article.findMany({ where: { contractId: contract.id } });
  const snapshot = buildContractSnapshot(contract, articles);
  const contractRevision = await prisma.contractRevision.create({
    data: {
      contractId: contract.id,
      version: 1,
      snapshot,
      contentHash: contentHash(snapshot),
      publishedAt,
    },
  });

  await prisma.contract.update({
    where: { id: contract.id },
    data: {
      currentContractRevisionId: contractRevision.id,
      currentDesignRevisionId: designRevision.id,
    },
  });

  return { admin, customer, stranger, contract, designRevision, contractRevision };
}

/** Drive the fixture's design to complete: choose a concept, approve its pages. */
export async function completeDesign(fixture: Fixture, conceptKey = '1a') {
  const concept = await prisma.designConcept.findFirstOrThrow({
    where: { designRevisionId: fixture.designRevision.id, key: conceptKey },
  });
  await prisma.designConcept.update({
    where: { id: concept.id },
    data: { chosenAt: new Date() },
  });
  await prisma.pageDesign.updateMany({
    where: { conceptId: concept.id },
    data: { approvedAt: new Date() },
  });
  return concept;
}

/** …and past the approval step, so signing is the only thing left. */
export async function approveContract(fixture: Fixture) {
  await prisma.contractRevision.update({
    where: { id: fixture.contractRevision.id },
    data: { approvedAt: new Date() },
  });
}

/**
 * Publishes the contract's draft as its next revision **without going through
 * `publishContractRevision`** — the same snapshot, hash and lineage writes, none
 * of the checks. For a test whose subject is something *else* about a published
 * revision (a sensitive article's body, a note anchored to an article) and which
 * must not have to satisfy the new road's gates (J6: `SCOPE_UNCONFIRMED`,
 * `BRIEF_INCOMPLETE`) to get one. A test about the gates uses the mutation.
 */
export async function publishDraftDirect(contractId: string, opts: { format?: 1 } = {}) {
  // **In the road's own format** (J7): a new-road contract's draft is a format-2
  // snapshot, and one published as format 1 would read as stale to the agreement
  // gate the moment a test tried to approve it. `draftStateOn` is the very
  // computation `publishContractRevision` makes, minus the gates.
  //
  // `format: 1` asks for the old shape on purpose, for a test whose subject is what
  // a *format-1* revision does (J4's sensitive-article rule reads the live row
  // for one; a legacy contract's revision, and every revision published before J7,
  // is one) — the fixture is on the new road, whose own revisions are format 2.
  const contract = (await loadContract(contractId))!;
  const { snapshot, hash } =
    opts.format === 1
      ? draftState(contract, contract.articles, contract.currentContractRevision, agreedScopeSnapshot(contract.project.scopeItems))
      : await draftStateOn(prisma, contract);
  const latest = await prisma.contractRevision.findFirst({ where: { contractId }, orderBy: { version: 'desc' } });
  const now = new Date();
  const revision = await prisma.contractRevision.create({
    data: { contractId, version: (latest?.version ?? 0) + 1, snapshot, contentHash: hash, publishedAt: now },
  });
  if (contract.currentContractRevision) {
    await prisma.contractRevision.update({ where: { id: contract.currentContractRevision.id }, data: { supersededAt: now } });
  }
  await prisma.contract.update({ where: { id: contractId }, data: { currentContractRevisionId: revision.id } });
  return revision;
}
