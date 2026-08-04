/**
 * Seals the contract revisions the migration left unsealed.
 *
 * `20260802090000_contract_and_design_revisions` does the relational half of
 * the backfill in SQL — v1 of each lineage, concepts re-parented, approvals and
 * signatures moved across. It stops short of the snapshot and its hash, because
 * canonical serialization lives in `src/lib/revision.ts` and writing a second
 * copy of it in SQL is the surest way to end up with two answers to "what did
 * this contract say".
 *
 * So: run the migration, then run this. Idempotent — it only touches revisions
 * whose snapshot is still null, so re-running is a no-op and a half-finished
 * run picks up where it stopped.
 *
 *   npm run backfill --workspace=apps/api
 */
import { loadEnvFile } from 'node:process';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildContractSnapshot, contentHash } from '../src/lib/revision.js';

try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const prisma = new PrismaClient();

async function main() {
  const unsealed = await prisma.contractRevision.findMany({
    where: { snapshot: { equals: Prisma.DbNull } },
    include: { contract: { include: { articles: true } } },
    orderBy: [{ contractId: 'asc' }, { version: 'asc' }],
  });

  if (unsealed.length === 0) {
    console.info('Nothing to seal — every contract revision already has a snapshot.');
    return;
  }

  for (const revision of unsealed) {
    // v1 is the contract exactly as it stood when the migration ran, and the
    // draft rows have not moved since — they are still the same Article rows.
    // A later unsealed revision would be a bug, not a state to guess at.
    if (revision.version !== 1) {
      throw new Error(
        `Revision ${revision.contractId} v${revision.version} is unsealed but is not v1. ` +
          'Only the backfilled v1 can be reconstructed from the draft; refusing to guess.',
      );
    }

    const snapshot = buildContractSnapshot(revision.contract, revision.contract.articles);
    await prisma.contractRevision.update({
      where: { id: revision.id },
      data: { snapshot, contentHash: contentHash(snapshot) },
    });
    console.info(`Sealed ${revision.contract.ref} v${revision.version}.`);
  }

  console.info(
    `Sealed ${unsealed.length} revision(s). Signatures made before hashing existed keep a ` +
      'null signedHash — back-dating one would assert something the signer never saw.',
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
