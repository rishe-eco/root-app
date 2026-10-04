import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, upload } from './http.js';
import * as yazl from 'yazl';
import { storage } from '../lib/storage.js';

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

/**
 * `NOT_FOUND` is the customer's edge (house rules 2 and 13): a staff member who
 * can see the contract is still not *its customer*, and hears what a stranger
 * hears. `SCOPE_UNCONFIRMED` is a row whose capability check passed and whose
 * first refusal is the step's own — the fixture has no scope, so publishing the
 * draft gets exactly that far (J6) for whoever holds `contracts.author`.
 * `NOT_SIGNED` (J13) likewise: issuing a payment plan's first row on a contract
 * nobody has signed is what "allowed" looks like for that row.
 */
type Outcome = 'OK' | 'FORBIDDEN' | 'NOT_ASSIGNED' | 'NOT_FOUND' | 'SCOPE_UNCONFIRMED' | 'NOT_SIGNED' | 'NO_DRAFT' | 'DESIGN_INCOMPLETE' | 'NO_PUBLISHED_MOCKUP' | 'PHASES_NOT_ACCEPTED';

let f: Fixture;
const staff: Record<string, User> = {};
let phaseId: string;
let demoId: string;
let dependencyId: string;
let technicalDependencyId: string;
let proposalId: string;
let tradeId: string;
// J13: a draft (to edit, delete and issue), an issued invoice (to mark paid),
// and the first row of a payment plan on a contract that is not signed.
let draftEntryId: string;
let issuedEntryId: string;
let plannedInvoiceId: string;

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

  const projectId = f.contract.projectId;
  const phase = await prisma.phase.create({ data: { projectId, contractId: f.contract.id, number: 1, titleFa: 'فاز ۱', titleEn: 'Phase 1' } });
  phaseId = phase.id;
  const demo = await prisma.demo.create({ data: { projectId, phaseId, stagingUrl: 'https://nahal.staging.m-root.com' } });
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
  // J4: the same board also holds a technical row (the domain, the hosting),
  // which the developer verifies and sales does not.
  const technical = await prisma.dependency.create({
    data: {
      projectId,
      side: 'CUSTOMER',
      titleFa: 'میزبانی',
      titleEn: 'Hosting',
      dueAt: new Date('2026-10-01T00:00:00Z'),
      createdById: f.admin.id,
      technical: true,
      briefKey: 'host',
    },
  });
  technicalDependencyId = technical.id;

  // J5 and J6: what the new road's operations act on — a site type with a scope
  // list and a brief that names it (`applyScopeTemplate`), a customer's proposal
  // waiting for a decision, and a scope trade waiting for its customer half.
  const type = await prisma.templateType.create({ data: { slug: 'store', labelFa: 'فروشگاهی', labelEn: 'Store' } });
  await prisma.templateScopeItem.create({
    data: { typeId: type.id, key: 'home', kind: 'PAGE', labelFa: 'صفحه', labelEn: 'Home', position: 0 },
  });
  await prisma.contractBrief.create({
    data: { contractId: f.contract.id, kind: 'NEW_SITE', templateTypeId: type.id, designTier: 'THEME_PICK' },
  });
  proposalId = (
    await prisma.scopeProposal.create({
      data: { contractId: f.contract.id, kind: 'ADD', requestedKind: 'PAGE', text: 'یک صفحه‌ی وبلاگ', lang: 'fa', proposedById: f.customer.id },
    })
  ).id;
  const [outItem, inItem] = await Promise.all(
    ['out-item', 'in-item'].map((key, position) =>
      prisma.scopeItem.create({
        data: {
          projectId,
          key,
          labelFa: key,
          labelEn: key,
          position,
          kind: 'FEATURE',
          status: key === 'out-item' ? 'AGREED' : 'PROPOSED',
        },
      }),
    ),
  );
  tradeId = (
    await prisma.scopeTrade.create({
      data: { projectId, outItemId: outItem.id, inItemId: inItem.id, proposedById: f.admin.id, rootConfirmedAt: new Date() },
    })
  ).id;

  const draft = await prisma.billingEntry.create({
    data: { customerId: f.customer.id, source: 'CONTRACT', descriptionFa: 'پیش‌نویس', descriptionEn: 'Draft', amount: 1_000n },
  });
  draftEntryId = draft.id;
  const issued = await prisma.billingEntry.create({
    data: {
      customerId: f.customer.id,
      source: 'CONTRACT',
      descriptionFa: 'صادرشده',
      descriptionEn: 'Issued',
      amount: 1_000n,
      issuedAt: new Date('2026-09-01T00:00:00Z'),
      invoiceNumber: 'INV-900001',
      dueAt: new Date('2026-09-08T00:00:00Z'),
      paymentTermDays: 7,
    },
  });
  issuedEntryId = issued.id;
  const plan = await prisma.paymentPlan.create({
    data: {
      contractId: f.contract.id,
      split: 'LUMP_SUM',
      invoices: { create: [{ ordinal: 1, labelFa: 'همه', labelEn: 'All', amount: 1_000n, paymentTermDays: 7 }] },
    },
    include: { invoices: true },
  });
  plannedInvoiceId = plan.invoices[0].id;
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

/** The fixture's agreement, signed — the row `agreementSignedAt` reads, and the
 *  one thing that opens the design (J8). */
const signAgreement = () =>
  prisma.signature.create({ data: { contractRevisionId: f.contractRevision.id, signerId: f.customer.id, typedName: 'Test Customer' } });

/**
 * J9b: the fixture on the custom path with its design approved (the row `openMockup` reads),
 * a mockup allowance of two, and an agreed page for the mockup to show.
 */
async function customApproved() {
  await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'SENIOR_DESIGNER', mockupIterations: 2, premadeRounds: null } });
  await prisma.stepApproval.create({ data: { contractId: f.contract.id, step: 'DESIGN', approvedById: f.customer.id } });
  const existing = await prisma.scopeItem.findFirst({ where: { contractId: f.contract.id, key: 'home' } });
  if (!existing) {
    await prisma.scopeItem.create({
      data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'home', labelFa: 'صفحه', labelEn: 'Home', kind: 'PAGE', status: 'AGREED' },
    });
  }
}

/** A MOCKUP demo with one declared page, as `createMockupDemo` leaves it. */
async function mockupDemo() {
  await customApproved();
  const demo = await prisma.demo.create({
    data: { kind: 'MOCKUP', projectId: f.contract.projectId, contractId: f.contract.id, pages: { create: [{ key: 'home', labelFa: 'صفحه', labelEn: 'Home', canonicalPath: '' }] } },
    include: { pages: true },
  });
  return { demoId: demo.id, pageId: demo.pages[0].id };
}

/** A real one-page bundle on disk, owned by the contract. */
async function mockupBundle() {
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from('<html><head></head><body>hi</body></html>'), 'index.html');
  const chunks: Buffer[] = [];
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
  const key = await storage.put('PRIVATE', bytes, '.zip');
  return prisma.storedFile.create({
    data: { key, class: 'MOCKUP_BUNDLE', visibility: 'PRIVATE', mime: 'application/zip', bytes: bytes.length, originalName: 'm.zip', contractId: f.contract.id, uploadedById: staff.DESIGNER.id },
  });
}

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
  // Journeys build plan J8: the design opens once the agreement is signed, so the
  // design operations sign the fixture first (each test starts from a reset
  // database, and the billing row that wants an *unsigned* agreement is another
  // test). A signature is what `agreementSignedAt` reads (J13's one rule).
  'design.author · add concept': async (as) => {
    await signAgreement();
    return exec('mutation($c: ID!){ addConcept(contractId: $c, key: "9z", labelFa: "ط", labelEn: "C") { id } }', {
      as,
      variables: { c: f.contract.id },
    });
  },
  'design.author · start a round': async (as) => {
    await signAgreement();
    return exec('mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }', { as, variables: { c: f.contract.id } });
  },
  'design.author · propose themes': async (as) => {
    await signAgreement();
    // The brief is pre-made; a theme offered for its type is what a round proposes.
    const theme = await prisma.theme.create({ data: { name: 'Astra' } });
    await prisma.templateTypeTheme.create({ data: { typeId: (await prisma.contractBrief.findUniqueOrThrow({ where: { contractId: f.contract.id } })).templateTypeId, themeId: theme.id } });
    return exec('mutation($c: ID!, $t: [ID!]!){ proposeThemes(contractId: $c, themeIds: $t) { id } }', {
      as,
      variables: { c: f.contract.id, t: [theme.id] },
    });
  },
  'design.author · add a palette item': async (as) => {
    await signAgreement();
    // A palette belongs to a custom design.
    await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { designTier: 'SENIOR_DESIGNER' } });
    return exec(
      'mutation($c: ID!){ addPaletteItem(contractId: $c, kind: COLOR, role: "primary", value: "#1f3a5c", labelFa: "ا", labelEn: "P") { id } }',
      { as, variables: { c: f.contract.id } },
    );
  },
  'design.author · publish a round': async (as) => {
    await signAgreement();
    return exec('mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', { as, variables: { c: f.contract.id } });
  },
  // Journeys build plan J9b: step 5. The mockup belongs to a custom design that is approved,
  // so each of these sets that up first (the design's approval row is what `openMockup` reads).
  'design.author · start the mockup': async (as) => {
    await customApproved();
    return exec('mutation($c: ID!){ createMockupDemo(contractId: $c) { id } }', { as, variables: { c: f.contract.id } });
  },
  'design.author · map a mockup page': async (as) => {
    const { pageId } = await mockupDemo();
    return exec('mutation($p: ID!){ mapMockupPage(demoPageId: $p, path: "/about") { id } }', { as, variables: { p: pageId } });
  },
  'design.author · declare a mockup build': async (as) => {
    const { demoId } = await mockupDemo();
    const file = await mockupBundle();
    return exec('mutation($d: ID!, $f: ID!){ declareMockupBuild(demoId: $d, fileId: $f, changes: []) { id } }', {
      as,
      variables: { d: demoId, f: file.id },
    });
  },
  'design.author · publish a mockup build': async (as) => {
    const { demoId } = await mockupDemo();
    const file = await mockupBundle();
    const build = await prisma.build.create({
      data: { kind: 'MOCKUP', projectId: f.contract.projectId, demoId, bundleFileId: file.id, number: 1, declaredById: staff.DESIGNER.id },
    });
    return exec('mutation($b: ID!){ publishBuild(buildId: $b) { id } }', { as, variables: { b: build.id } });
  },
  'customer · approve the mockup': async (as) => {
    await customApproved();
    return exec('mutation($c: ID!){ approveMockup(contractId: $c) { id } }', { as, variables: { c: f.contract.id } });
  },
  'contracts.author · extend the mockup allowance': async (as) => {
    await customApproved();
    return exec(
      'mutation($c: ID!){ extendAllowance(contractId: $c, step: MOCKUP, extra: 1, reason: "They asked for another look") { id } }',
      { as, variables: { c: f.contract.id } },
    );
  },
  'contracts.author · extend the allowance': async (as) => {
    await prisma.contractBrief.update({ where: { contractId: f.contract.id }, data: { premadeRounds: 3 } });
    return exec(
      'mutation($c: ID!){ extendAllowance(contractId: $c, step: DESIGN, extra: 1, reason: "Changed direction") { id } }',
      { as, variables: { c: f.contract.id } },
    );
  },
  // The customer's operations are an ownership edge: every staff role hears NOT_FOUND.
  'customer · request other options': (as) =>
    exec('mutation($c: ID!){ requestOtherOptions(contractId: $c) { id } }', { as, variables: { c: f.contract.id } }),
  'customer · approve the design': (as) =>
    exec('mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { as, variables: { c: f.contract.id } }),
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
  // J4: a technical row is the developer's (and only on a project they
  // develop — DEVELOPER_UNASSIGNED is NOT_ASSIGNED), never sales'.
  'dependencies.verifyTechnical · verify': (as) =>
    exec('mutation($d: ID!){ verifyDependency(dependencyId: $d, note: "deployed a test file") { id } }', {
      as,
      variables: { d: technicalDependencyId },
    }),
  'billing.manage · ledger': (as) => exec('{ allBillingEntries { id } }', { as }),
  // Journeys build plan J13: every new invoice operation is `billing.manage`.
  'billing.manage · create draft': (as) =>
    exec(
      'mutation($c: ID!){ createInvoiceDraft(customerId: $c, source: CONTRACT, descriptionFa: "ب", descriptionEn: "B", amount: "1000") { id } }',
      { as, variables: { c: f.customer.id } },
    ),
  'billing.manage · update draft': (as) =>
    exec(
      'mutation($e: ID!){ updateInvoiceDraft(entryId: $e, descriptionFa: "ب", descriptionEn: "B", amount: "2000") { id } }',
      { as, variables: { e: draftEntryId } },
    ),
  'billing.manage · delete draft': (as) =>
    exec('mutation($e: ID!){ deleteInvoiceDraft(entryId: $e) }', { as, variables: { e: draftEntryId } }),
  'billing.manage · issue invoice': (as) =>
    exec('mutation($e: ID!){ issueInvoice(entryId: $e) { id } }', { as, variables: { e: draftEntryId } }),
  'billing.manage · issue planned invoice': (as) =>
    exec('mutation($p: ID!){ issuePlannedInvoice(plannedInvoiceId: $p) { id } }', { as, variables: { p: plannedInvoiceId } }),
  'billing.manage · mark paid': (as) =>
    exec('mutation($e: ID!){ markBillingEntryPaid(entryId: $e) { id } }', { as, variables: { e: issuedEntryId } }),
  'billing.manage · payment plans': (as) => exec('{ contractsWithPaymentPlan { id } }', { as }),
  'tickets.answer · desk queue': (as) => exec('{ allTickets { id } }', { as }),
  'customers.manage · service runs': (as) => exec('{ allServiceRuns { id } }', { as }),
  'contracts.author · assign': (as) =>
    exec('mutation($c: ID!, $d: ID){ assignContract(contractId: $c, designerId: $d) { id } }', {
      as,
      variables: { c: f.contract.id, d: staff.DESIGNER.id },
    }),
  // --- J5: step 2a ---
  'contracts.author · apply scope template': (as) =>
    exec('mutation($c: ID!){ applyScopeTemplate(contractId: $c) { id } }', { as, variables: { c: f.contract.id } }),
  'contracts.author · decide scope proposal': (as) =>
    exec(
      'mutation($p: ID!){ decideScopeProposal(id: $p, decision: ACCEPTED, labelFa: "وبلاگ", labelEn: "Blog") { id } }',
      { as, variables: { p: proposalId } },
    ),
  'customer · propose scope addition': (as) =>
    exec('mutation($c: ID!){ proposeScopeAddition(contractId: $c, kind: PAGE, text: "a news page", lang: "en") { id } }', {
      as,
      variables: { c: f.contract.id },
    }),
  'customer · confirm scope trade': (as) =>
    exec('mutation($t: ID!, $c: ID){ confirmScopeTradeCustomer(tradeId: $t, contractId: $c) { id } }', { as, variables: { t: tradeId, c: f.contract.id } }),
  // --- J6: step 2b ---
  'contracts.author · planned dates': (as) =>
    exec('mutation($c: ID!){ setPlannedDates(contractId: $c, plannedStartAt: "2026-11-01", plannedEndAt: "2027-01-15") { id } }', {
      as,
      variables: { c: f.contract.id },
    }),
  'contracts.author · publish the draft': (as) =>
    exec('mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', { as, variables: { c: f.contract.id } }),
  // --- J11: step 7. A signed agreement, so the step's own refusals are the ones in play.
  'contracts.author · close the contract': async (as) => {
    await signAgreement();
    return exec('mutation($c: ID!){ closeContract(contractId: $c) { id } }', { as, variables: { c: f.contract.id } });
  },
  // Handing over is contracts.author **or** builds.author *and* the contract's developer —
  // the capability and the edge, separately (house rule 2).
  'handover · mark a deliverable': async (as) => {
    await signAgreement();
    const d = await prisma.scopeItem.create({
      data: { projectId: f.contract.projectId, contractId: f.contract.id, key: 'repo', kind: 'DELIVERABLE', status: 'AGREED', labelFa: 'ک', labelEn: 'Repo' },
    });
    return exec('mutation($i: ID!){ markHandedOver(scopeItemId: $i, note: "Transferred.") { id } }', { as, variables: { i: d.id } });
  },
  'contracts.author · take a handover back': async (as) => {
    const d = await prisma.scopeItem.create({
      data: {
        projectId: f.contract.projectId, contractId: f.contract.id, key: 'repo', kind: 'DELIVERABLE', status: 'AGREED', labelFa: 'ک', labelEn: 'Repo',
        handedOverAt: new Date(), handedOverById: staff.DEVELOPER.id, handoverNote: 'Transferred.',
      },
    });
    return exec('mutation($i: ID!){ unmarkHandedOver(scopeItemId: $i) { id } }', { as, variables: { i: d.id } });
  },
};

const F = 'FORBIDDEN' as const;
const N = 'NOT_ASSIGNED' as const;
const NF = 'NOT_FOUND' as const;
const U = 'SCOPE_UNCONFIRMED' as const;
const NS = 'NOT_SIGNED' as const;
const ND = 'NO_DRAFT' as const;
const DI = 'DESIGN_INCOMPLETE' as const;
const PNA = 'PHASES_NOT_ACCEPTED' as const;
const NP = 'NO_PUBLISHED_MOCKUP' as const;

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
  // J8. An authorized publish with no draft is the step's own refusal, the way
  // an authorized publish of the contract draft is SCOPE_UNCONFIRMED.
  'design.author · start a round':        ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'design.author · propose themes':       ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'design.author · add a palette item':   ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'design.author · publish a round':      [ND,   F,    ND,   N,    F,    F,    F,   F,   F],
  'contracts.author · extend the allowance': ['OK', 'OK', F,   F,    F,    F,    F,   F,   F],
  // J9b. Step 5 is the designer's (design.author and the assignment edge), not the developer's:
  // the developer who may publish a site build hears "no such build" for a mockup's.
  'design.author · start the mockup':     ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'design.author · map a mockup page':    ['OK', F,    'OK', N,    F,    F,    F,   F,   F],
  'design.author · declare a mockup build': ['OK', F,  'OK', N,    F,    F,    F,   F,   F],
  'design.author · publish a mockup build': ['OK', F,  'OK', N,    NF,   NF,   F,   F,   F],
  'customer · approve the mockup':        [NF,   NF,   NF,   NF,   NF,   NF,   NF,  NF,  NP],
  'contracts.author · extend the mockup allowance': ['OK', 'OK', F, F, F,    F,    F,   F,   F],
  'customer · request other options':     [NF,   NF,   NF,   NF,   NF,   NF,   NF,  NF,  'OK'],
  'customer · approve the design':        [NF,   NF,   NF,   NF,   NF,   NF,   NF,  NF,  DI],
  'builds.author · demo CRUD':            ['OK', F,    F,    F,    'OK', N,    F,   F,   F],
  'builds.author · builds queue':         ['OK', F,    F,    F,    'OK', N,    F,   F,   F],
  'dependencies.verifyGeneral · verify':  ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'dependencies.verifyTechnical · verify': ['OK', F,    F,    F,    'OK', N,    F,   F,   F],
  'billing.manage · ledger':              ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · create draft':        ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · update draft':        ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · delete draft':        ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · issue invoice':       ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · issue planned invoice': [NS, NS,   F,    F,    F,    F,    F,   F,   F],
  'billing.manage · mark paid':           ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'billing.manage · payment plans':       ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'tickets.answer · desk queue':          ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'customers.manage · service runs':      ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.author · assign':            ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  // J5 and J6. The customer's operations are an ownership edge, not a
  // capability: every staff role hears NOT_FOUND, sales and ADMIN included.
  'contracts.author · apply scope template': ['OK', 'OK', F,  F,    F,    F,    F,   F,   F],
  'contracts.author · decide scope proposal': ['OK', 'OK', F, F,    F,    F,    F,   F,   F],
  'customer · propose scope addition':    [NF,   NF,   NF,   NF,   NF,   NF,   NF,  NF,  'OK'],
  'customer · confirm scope trade':       [NF,   NF,   NF,   NF,   NF,   NF,   NF,  NF,  'OK'],
  'contracts.author · planned dates':     ['OK', 'OK', F,    F,    F,    F,    F,   F,   F],
  'contracts.author · publish the draft': [U,    U,    F,    F,    F,    F,    F,   F,   F],
  // J11. The fixture's phase has no accepted demo, so an authorized close gets as far as that.
  'contracts.author · close the contract': [PNA,  PNA,  F,    F,    F,    F,    F,   F,   F],
  'handover · mark a deliverable':        ['OK', 'OK', F,    F,    'OK', N,    F,   F,   F],
  'contracts.author · take a handover back': ['OK', 'OK', F,  F,    F,    F,    F,   F,   F],
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

test('readActive (J11): a delivered contract leaves the designer’s and the developer’s list and link; sales and the customer keep it', async () => {
  const q = 'query($id: ID!){ contract(id: $id) { id } }';
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DONE', deliveredAt: new Date(), deliveredById: staff.SALES.id } });
  for (const who of [staff.DESIGNER, staff.DEVELOPER]) {
    assert.equal((await exec(q, { as: who, variables: { id: f.contract.id } })).code, 'NOT_FOUND', who.email ?? '');
    assert.deepEqual(ok(await exec('{ allContracts { id } }', { as: who })).allContracts, [], `${who.email} list`);
  }
  for (const who of [staff.SALES, f.admin, f.customer]) {
    ok(await exec(q, { as: who, variables: { id: f.contract.id } }));
  }
  assert.equal(((ok(await exec('{ allContracts { id } }', { as: staff.SALES })).allContracts) as unknown[]).length, 1);
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

test('assignableUsers lists exactly who assignContract would accept', async () => {
  const q = 'query($j: AssignmentJob!){ assignableUsers(job: $j) { id } }';
  const ids = async (job: string) =>
    ((ok(await exec(q, { as: staff.SALES, variables: { j: job } })).assignableUsers as Array<{ id: string }>).map((u) => u.id)).sort();
  await prisma.user.update({ where: { id: staff.DESIGNER_UNASSIGNED.id }, data: { state: 'DISABLED' } });
  // ADMIN holds every capability, so ADMIN is assignable to both jobs.
  assert.deepEqual(await ids('DESIGN'), [f.admin.id, staff.DESIGNER.id].sort());
  assert.deepEqual(await ids('BUILD'), [f.admin.id, staff.DEVELOPER.id, staff.DEVELOPER_UNASSIGNED.id].sort());
  assert.equal((await exec(q, { as: staff.DESIGNER, variables: { j: 'DESIGN' } })).code, 'FORBIDDEN');
});

test('every staff role survives a round trip through User.roles (the SDL enum)', async () => {
  // Regression for the S1 web lane's finding: SALES and DESIGNER were in the
  // Prisma enum and not the SDL one, so selecting `roles` threw for them —
  // `signIn` included. `me` selects the same field the sign-in payload does.
  for (const who of ['SALES', 'DESIGNER', 'DEVELOPER']) {
    const data = ok(await exec('{ me { roles capabilities } }', { as: staff[who] })) as { me: { roles: string[] } };
    assert.deepEqual(data.me.roles, [who]);
  }
});
