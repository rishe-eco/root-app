import { GraphQLError } from 'graphql';
import type { ChangeAction, ContractStatus, Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';

/**
 * The contract-loading layer every resolver module builds on.
 *
 * This is the part that is genuinely shared: one include shape fetched once,
 * one rule about who may see a contract, one place that writes the change log,
 * and one place that knows how a design draft comes into being. Everything
 * else — fields, queries, the three mutation groups — is a thin layer over
 * these, and lives in its own file.
 */

/** The concepts-and-pages shape, reused for the current revision and drafts. */
export const conceptsInclude = {
  concepts: { include: { pages: { orderBy: { position: 'asc' } } }, orderBy: { position: 'asc' } },
} satisfies Prisma.DesignRevisionInclude;

/**
 * Everything the detail screen needs, in one shape, fetched once.
 *
 * A level deeper than it used to be: design comes through the *current* design
 * revision, and the signature hangs off the current contract revision rather
 * than the contract. `articles` here is the editable draft; what the customer
 * reads is the snapshot inside the current contract revision.
 */
export const contractInclude = {
  customer: true,
  currentDesignRevision: { include: conceptsInclude },
  currentContractRevision: {
    include: {
      signature: { include: { signer: true } },
      amendments: {
        // `signer` because the GraphQL Signature type requires it, and an
        // amendment's signature is exposed exactly like the revision's.
        include: { signature: { include: { signer: true } } },
        orderBy: { ordinal: 'asc' },
      },
    },
  },
  scopeItems: { orderBy: { position: 'asc' } },
  articles: { orderBy: { number: 'asc' } },
  comments: { include: { author: true }, orderBy: { createdAt: 'asc' } },
  changeLogs: { include: { actor: true }, orderBy: { createdAt: 'desc' } },
} satisfies Prisma.ContractInclude;

export type FullContract = Prisma.ContractGetPayload<{ include: typeof contractInclude }>;

export const loadContract = (id: string) =>
  prisma.contract.findUnique({ where: { id }, include: contractInclude });

/**
 * A customer may only ever touch their own contract, and only after Root has
 * published it. Admins see everything.
 */
export async function loadForActor(id: string, user: User): Promise<FullContract> {
  const contract = await loadContract(id);
  if (!contract) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  if (user.role === 'ADMIN') return contract;
  if (contract.customerId !== user.id || contract.publishedAt === null) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  return contract;
}

export async function log(
  contractId: string,
  actorId: string,
  action: ChangeAction,
  arg?: string | null,
) {
  await prisma.changeLog.create({ data: { contractId, actorId, action, arg: arg ?? null } });
}

/**
 * Automatic transitions are defaults, not rails (v3 §8) — Root can always
 * override with setContractStatus. Terminal states are left alone.
 */
export async function nudgeStatus(contract: FullContract, next: ContractStatus) {
  if (contract.status === 'DONE' || contract.status === 'DISCARDED') return;
  if (contract.status === next) return;
  await prisma.contract.update({ where: { id: contract.id }, data: { status: next } });
}

export const reload = async (id: string) => (await loadContract(id))!;

/**
 * The design revision Root is currently editing: the one with no `publishedAt`.
 * There is at most one. Created on demand by cloning the published revision —
 * concepts and pages come across, approvals do not, because an approval is of
 * a revision and this is a different one.
 */
export async function draftDesignRevision(contractId: string) {
  const existing = await prisma.designRevision.findFirst({
    where: { contractId, publishedAt: null },
    include: conceptsInclude,
  });
  if (existing) return existing;

  const latest = await prisma.designRevision.findFirst({
    where: { contractId },
    orderBy: { version: 'desc' },
    include: conceptsInclude,
  });

  const draft = await prisma.designRevision.create({
    data: { contractId, version: (latest?.version ?? 0) + 1 },
  });

  for (const concept of latest?.concepts ?? []) {
    await prisma.designConcept.create({
      data: {
        designRevisionId: draft.id,
        key: concept.key,
        labelFa: concept.labelFa,
        labelEn: concept.labelEn,
        // Both halves of the image, together — see the note on
        // PageDesign.imageUrl. Copying the string alone would leave the fork
        // claiming an externally hosted image and would drop the reference
        // that keeps the file from being deleted.
        imageUrl: concept.imageUrl,
        imageFileId: concept.imageFileId,
        position: concept.position,
        pages: {
          create: concept.pages.map((p) => ({
            key: p.key,
            labelFa: p.labelFa,
            labelEn: p.labelEn,
            imageUrl: p.imageUrl,
            imageFileId: p.imageFileId,
            position: p.position,
          })),
        },
      },
    });
  }

  return (await prisma.designRevision.findUnique({
    where: { id: draft.id },
    include: conceptsInclude,
  }))!;
}
