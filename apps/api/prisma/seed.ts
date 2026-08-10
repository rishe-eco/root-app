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
import { ARTICLES, SCOPE, PAGES } from '../src/lib/templates.js';

// Run directly by `npm run seed`, which is not the Prisma CLI and so does not
// load .env for us. Same reason `src/lib/env.ts` does this.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@root.local';
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'change-me-please';
const CUSTOMER_EMAIL = process.env.SEED_CUSTOMER_EMAIL ?? 'nahal@example.com';
const CUSTOMER_PASSWORD = process.env.SEED_CUSTOMER_PASSWORD ?? 'change-me-please';
// F2's e2e suite is the first thing that can prove REVIEWER sees exactly one
// desk section — the role F3 built had no surface to test until now.
const REVIEWER_EMAIL = process.env.SEED_REVIEWER_EMAIL ?? 'reviewer@root.local';
const REVIEWER_PASSWORD = process.env.SEED_REVIEWER_PASSWORD ?? 'change-me-please';

async function main() {
  const admin = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: {},
    create: {
      email: ADMIN_EMAIL,
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
      name: 'نهال رضایی',
      clientName: 'استودیو نهال',
      roles: ['CUSTOMER'],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(CUSTOMER_PASSWORD, 12),
    },
  });

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

  const contract = await prisma.contract.upsert({
    where: { ref: 'RC-2026-014' },
    update: {},
    create: {
      ref: 'RC-2026-014',
      titleFa: 'وب‌سایت و پرتال نهال',
      titleEn: 'Nahal website & portal',
      customerId: customer.id,
      amount: BigInt(180_000_000),
      status: 'WAITING_ON_CUSTOMER',
      publishedAt: new Date(),
    },
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
      where: { contractId_key: { contractId: contract.id, key } },
      update: {},
      create: { contractId: contract.id, key, labelFa, labelEn, position: i },
    });
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
      },
    });
  }

  // v1 of the contract lineage: the articles just written, frozen and hashed.
  // Seeding it here rather than leaning on the backfill keeps a fresh database
  // and a migrated one in the same state.
  const articles = await prisma.article.findMany({ where: { contractId: contract.id } });
  const snapshot = buildContractSnapshot(contract, articles);
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
