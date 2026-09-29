/**
 * Seeds the one contract Phase 1 exists for, plus the two accounts needed to
 * drive it. Idempotent — safe to re-run.
 *
 * Article bodies 1–3 are the real text from the design handoff; the rest are
 * left empty on purpose, so the placeholder shows until the real contract text
 * is pasted in.
 */
import { loadEnvFile } from 'node:process';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { buildContractSnapshot, contentHash } from '../src/lib/revision.js';
import { agreedScopeSnapshot } from '../src/lib/scope.js';
import {
  ARTICLES,
  SCOPE,
  PAGES,
  CHECKLIST,
  TEMPLATE_TYPES,
  PLACEHOLDER_SCOPE,
  isTemplateSensitiveArticle,
  scopeKindForKey,
} from '../src/lib/templates.js';

// Run directly by `npm run seed`, which is not the Prisma CLI and so does not
// load .env for us. Same reason `src/lib/env.ts` does this.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const prisma = new PrismaClient();

// Journeys build plan J1 (PD-20): the four second-factor roles and the
// customer each get a phone — distinct, obviously fake Iranian mobiles, so
// e2e can drive the factor and phone sign-in without touching a real number.
// CONTRIBUTOR and REVIEWER stay without one on purpose (PD-20: neither
// requires the factor, and the reviewer invite flow is meant to keep
// working with only an email).
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@root.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-please';
const ADMIN_PHONE = process.env.SEED_ADMIN_PHONE ?? '+989120000001';
const CUSTOMER_EMAIL = process.env.SEED_CUSTOMER_EMAIL ?? 'nahal@example.com';
const CUSTOMER_PASSWORD = process.env.SEED_CUSTOMER_PASSWORD ?? 'change-me-please';
const CUSTOMER_PHONE = process.env.SEED_CUSTOMER_PHONE ?? '+989120000005';
// F2's e2e suite is the first thing that can prove REVIEWER sees exactly one
// desk section — the role F3 built had no surface to test until now.
const REVIEWER_EMAIL = process.env.SEED_REVIEWER_EMAIL ?? 'reviewer@root.local';
const REVIEWER_PASSWORD = process.env.SEED_REVIEWER_PASSWORD ?? 'change-me-please';
// C2's e2e spec needs a *second* active reviewer — the property the whole
// stage rests on (one expert's thread invisible to another) has no way to
// show up on screen with only one seeded account.
const REVIEWER2_EMAIL = process.env.SEED_REVIEWER2_EMAIL ?? 'reviewer2@root.local';
const REVIEWER2_PASSWORD = process.env.SEED_REVIEWER2_PASSWORD ?? 'change-me-please';
// R1's e2e spec needs a CONTRIBUTOR to prove the editor degrades honestly —
// the section is reachable, publish is not (T6).
const CONTRIBUTOR_EMAIL = process.env.SEED_CONTRIBUTOR_EMAIL ?? 'contributor@root.local';
const CONTRIBUTOR_PASSWORD = process.env.SEED_CONTRIBUTOR_PASSWORD ?? 'change-me-please';
// Build plan D6: DEVELOPER's first real test, exactly as F2 seeded REVIEWER
// to give that role something to sign into and F3's CONTRIBUTOR before it.
const DEVELOPER_EMAIL = process.env.SEED_DEVELOPER_EMAIL ?? 'developer@root.local';
const DEVELOPER_PASSWORD = process.env.SEED_DEVELOPER_PASSWORD ?? 'change-me-please';
const DEVELOPER_PHONE = process.env.SEED_DEVELOPER_PHONE ?? '+989120000004';
// Journeys build plan S1 (P0-6): one account per new staff role, so S1's
// e2e can sign into each desk and see the nav that role is meant to see.
const SALES_EMAIL = process.env.SEED_SALES_EMAIL ?? 'sales@root.local';
const SALES_PASSWORD = process.env.SEED_SALES_PASSWORD ?? 'change-me-please';
const SALES_PHONE = process.env.SEED_SALES_PHONE ?? '+989120000002';
const DESIGNER_EMAIL = process.env.SEED_DESIGNER_EMAIL ?? 'designer@root.local';
const DESIGNER_PASSWORD = process.env.SEED_DESIGNER_PASSWORD ?? 'change-me-please';
const DESIGNER_PHONE = process.env.SEED_DESIGNER_PHONE ?? '+989120000003';

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
      phone: ADMIN_PHONE,
      name: 'Root',
      roles: ['ADMIN'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 12),
    },
  });

  const customer = await prisma.user.upsert({
    where: { email: CUSTOMER_EMAIL },
    update: {},
    create: {
      email: CUSTOMER_EMAIL,
      phone: CUSTOMER_PHONE,
      name: 'نهال رضایی',
      clientName: 'استودیو نهال',
      roles: ['CUSTOMER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 12),
    },
  });

  // Journeys build plan S3: the product-import tool is a grant now, and the
  // seeded customer is the one whose Tools page e2e drives. Idempotent — the
  // partial unique index would refuse a second active row anyway, so this
  // looks first rather than relying on catching that.
  const activeImportGrant = await prisma.toolGrant.findFirst({
    where: { customerId: customer.id, tool: 'PRODUCT_IMPORT', revokedAt: null },
  });
  if (!activeImportGrant) {
    await prisma.toolGrant.create({
      data: { customerId: customer.id, tool: 'PRODUCT_IMPORT', grantedById: admin.id },
    });
  }

  await prisma.user.upsert({
    where: { email: REVIEWER_EMAIL },
    update: {},
    create: {
      email: REVIEWER_EMAIL,
      name: 'Reviewer',
      roles: ['REVIEWER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(REVIEWER_PASSWORD, 12),
    },
  });

  await prisma.user.upsert({
    where: { email: REVIEWER2_EMAIL },
    update: {},
    create: {
      email: REVIEWER2_EMAIL,
      name: 'Second Reviewer',
      roles: ['REVIEWER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(REVIEWER2_PASSWORD, 12),
    },
  });

  await prisma.user.upsert({
    where: { email: CONTRIBUTOR_EMAIL },
    update: {},
    create: {
      email: CONTRIBUTOR_EMAIL,
      name: 'Contributor',
      roles: ['CONTRIBUTOR'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(CONTRIBUTOR_PASSWORD, 12),
    },
  });

  const developer = await prisma.user.upsert({
    where: { email: DEVELOPER_EMAIL },
    update: {},
    create: {
      email: DEVELOPER_EMAIL,
      phone: DEVELOPER_PHONE,
      name: 'Developer',
      roles: ['DEVELOPER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(DEVELOPER_PASSWORD, 12),
    },
  });

  await prisma.user.upsert({
    where: { email: SALES_EMAIL },
    update: {},
    create: {
      email: SALES_EMAIL,
      phone: SALES_PHONE,
      name: 'Sales',
      roles: ['SALES'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(SALES_PASSWORD, 12),
    },
  });

  const designer = await prisma.user.upsert({
    where: { email: DESIGNER_EMAIL },
    update: {},
    create: {
      email: DESIGNER_EMAIL,
      phone: DESIGNER_PHONE,
      name: 'Designer',
      roles: ['DESIGNER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(DESIGNER_PASSWORD, 12),
    },
  });

  // Build plan D1/L1: the registry's owner. One project for the one contract
  // this fixture has ever needed — a real engagement spanning two contracts
  // is exactly the case L1 does not yet build a screen for (see L1.md).
  const project = await prisma.project.upsert({
    where: { id: 'seed-project-nahal' },
    update: {},
    create: {
      id: 'seed-project-nahal',
      customerId: customer.id,
      titleFa: 'وب‌سایت و پرتال نهال',
      titleEn: 'Nahal website & portal',
    },
  });

  // The completeness checklist (spec §3), seeded DECLINED — exactly as a
  // freshly created project gets it through createContract. Kept here too so
  // a fresh database and a migrated one land in the same state (matching the
  // reasoning already given for seeding the v1 contract revision below).
  for (const [i, [key, labelFa, labelEn]] of CHECKLIST.entries()) {
    await prisma.scopeItem.upsert({
      where: { projectId_key: { projectId: project.id, key } },
      update: {},
      create: { projectId: project.id, key, labelFa, labelEn, position: i, kind: 'EXTRA', status: 'DECLINED' },
    });
  }

  const contract = await prisma.contract.upsert({
    where: { ref: 'RC-2026-014' },
    update: {},
    create: {
      ref: 'RC-2026-014',
      titleFa: 'وب‌سایت و پرتال نهال',
      titleEn: 'Nahal website & portal',
      customerId: customer.id,
      projectId: project.id,
      amount: BigInt(180_000_000),
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date(),
      // Journeys build plan S1: the seeded designer and developer are this
      // contract's, so each can author their half of it straight after a
      // fresh seed — the acceptance check "the seeded developer opens a demo".
      designerId: designer.id,
      developerId: developer.id,
      // Journeys build plan J3, PD-7: this is the contract every legacy spec
      // drives to signature, so it is on the legacy road — exactly what the
      // migration makes of an existing row. The column's default is the new road.
      sequence: 'DESIGN_FIRST',
    },
  });

  // Journeys build plan J3: one contract on the new road, on the same customer's
  // project (J2 lets a project hold several contracts) — what the wizard's e2e
  // reads. **Created after RC-2026-014 and stamped older**: the project's
  // primary contract is its earliest (`primaryContractId`), so this one must
  // not come first by `createdAt`; and the customer's list is newest-updated
  // first, so every spec that opens "the first contract" (02-contract-flow)
  // still finds RC-2026-014, which the seed keeps touching below.
  await prisma.contract.upsert({
    where: { ref: 'RC-2026-021' },
    update: {},
    create: {
      ref: 'RC-2026-021',
      titleFa: 'فروشگاه آنلاین نهال',
      titleEn: 'Nahal online shop',
      customerId: customer.id,
      projectId: project.id,
      status: 'WAITING_ON_ROOT',
      publishedAt: new Date(),
      sequence: 'AGREEMENT_FIRST',
      designerId: designer.id,
      developerId: developer.id,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });

  // The checklist was seeded before its contract existed; name its agreement
  // now, as createContract does. Only rows still unnamed, so a re-run leaves
  // anything a later stage assigned alone.
  await prisma.scopeItem.updateMany({
    where: { projectId: project.id, contractId: null },
    data: { contractId: contract.id },
  });

  // v1 of the design lineage: published, and the live one. Concepts and their
  // pages hang off the revision, not off the contract.
  const designRevision = await prisma.designRevision.upsert({
    where: { contractId_version: { contractId: contract.id, version: 1 } },
    update: {},
    create: { contractId: contract.id, version: 1, publishedAt: contract.publishedAt },
  });

  for (const [i, [key, labelFa, labelEn]] of (
    [
      ['1a', 'طرح ۱a', 'Concept 1a'],
      ['1b', 'طرح ۱b', 'Concept 1b'],
      ['1c', 'طرح ۱c', 'Concept 1c'],
    ] as Array<[string, string, string]>
  ).entries()) {
    const concept = await prisma.designConcept.upsert({
      where: { designRevisionId_key: { designRevisionId: designRevision.id, key } },
      update: {},
      create: { designRevisionId: designRevision.id, key, labelFa, labelEn, position: i },
    });

    for (const [j, [pk, pFa, pEn]] of PAGES.entries()) {
      await prisma.pageDesign.upsert({
        where: { conceptId_key: { conceptId: concept.id, key: pk } },
        update: {},
        create: { conceptId: concept.id, key: pk, labelFa: pFa, labelEn: pEn, position: j },
      });
    }
  }

  for (const [i, [key, labelFa, labelEn]] of SCOPE.entries()) {
    await prisma.scopeItem.upsert({
      where: { projectId_key: { projectId: project.id, key } },
      update: {},
      // AGREED, not PROPOSED: this fixture is meant to represent a contract
      // already under way, the same reasoning addScopeItem's own comment
      // gives for a Root-authored item (build plan L1).
      create: {
        projectId: project.id,
        key,
        labelFa,
        labelEn,
        position: CHECKLIST.length + i,
        kind: scopeKindForKey(key),
        contractId: contract.id,
        status: 'AGREED',
      },
    });
  }

  // Journeys build plan T1: the five site types, each with three placeholder
  // scope items whose labels say so. `update: {}` — once a designer has edited
  // a type, or sales has replaced its list, a re-seed must not put the
  // placeholders back.
  for (const [i, [slug, labelFa, labelEn]] of TEMPLATE_TYPES.entries()) {
    const type = await prisma.templateType.upsert({
      where: { slug },
      update: {},
      create: { slug, labelFa, labelEn, position: i },
    });
    for (const [j, [key, kind, itemFa, itemEn]] of PLACEHOLDER_SCOPE.entries()) {
      await prisma.templateScopeItem.upsert({
        where: { typeId_key: { typeId: type.id, key } },
        update: {},
        create: { typeId: type.id, key, kind, labelFa: itemFa, labelEn: itemEn, position: j },
      });
    }
  }

  for (const [number, titleFa, titleEn, bodyFa, bodyEn] of ARTICLES) {
    await prisma.article.upsert({
      where: { contractId_number: { contractId: contract.id, number } },
      update: {},
      create: {
        contractId: contract.id,
        number,
        titleFa,
        titleEn,
        bodyFa: bodyFa ?? null,
        bodyEn: bodyEn ?? null,
        // Fees and Payment Schedule (PD-14, J4) — the template's own rule.
        sensitive: isTemplateSensitiveArticle(number, titleEn),
      },
    });
  }

  // v1 of the contract lineage: the articles just written, frozen and hashed.
  // Seeding it here rather than leaning on the backfill keeps a fresh database
  // and a migrated one in the same state.
  const articles = await prisma.article.findMany({ where: { contractId: contract.id } });
  const scopeItems = await prisma.scopeItem.findMany({ where: { projectId: project.id } });
  const snapshot = buildContractSnapshot(contract, articles, agreedScopeSnapshot(scopeItems));
  const contractRevision = await prisma.contractRevision.upsert({
    where: { contractId_version: { contractId: contract.id, version: 1 } },
    update: {},
    create: {
      contractId: contract.id,
      version: 1,
      snapshot,
      contentHash: contentHash(snapshot),
      publishedAt: contract.publishedAt,
    },
  });

  await prisma.contract.update({
    where: { id: contract.id },
    data: {
      currentContractRevisionId: contractRevision.id,
      currentDesignRevisionId: designRevision.id,
    },
  });

  const logCount = await prisma.changeLog.count({ where: { contractId: contract.id } });
  if (logCount === 0) {
    await prisma.changeLog.createMany({
      data: [
        { contractId: contract.id, actorId: admin.id, action: 'CREATED' },
        { contractId: contract.id, actorId: admin.id, action: 'PUBLISHED' },
      ],
    });
    await prisma.comment.create({
      data: {
        contractId: contract.id,
        authorId: admin.id,
        target: 'DESIGN',
        body: 'سه طرحِ کلی برایت آماده کردیم. هر کدام حالِ متفاوتی دارد — با خیال راحت نظر بده و یکی را انتخاب کن.',
      },
    });
  }

  console.info(`Seeded. Admin: ${admin.email} · Customer: ${customer.email}`);
  console.info('Change both passwords before this touches anything real.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
