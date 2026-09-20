import { GraphQLError } from 'graphql';
import { requireCapability, type Context } from '../../../context.js';
import { buildAmendmentSnapshot, contentHash } from '../../../lib/revision.js';
import { prisma } from '../../../lib/prisma.js';
import { loadContract, log, nudgeStatus, reload } from '../contracts.js';

/** The amendment lifecycle — issue, edit, publish, all against a signed base
 *  contract (schema.prisma's note on `Amendment`). Part of the L1 split of
 *  the former `admin.ts`; see `index.ts`. */
export const amendmentMutations = {
  /**
   * Layered on top of a signed base revision, never a replacement for one.
   * Unpublished and editable until `publishAmendment`, matching the rest of
   * the draft/publish split — but `contentHash` is `NOT NULL` here, unlike a
   * contract revision, so it is sealed at creation and recomputed on every
   * subsequent write (V2.md §3.2).
   */
  issueAmendment: async (
    _p: unknown,
    args: {
      contractId: string;
      titleFa: string;
      titleEn: string;
      bodyFa: string;
      bodyEn: string;
      relatesToArticle?: number | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const contract = await loadContract(args.contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    const current = contract.currentContractRevision;
    if (!current?.signature) {
      throw new GraphQLError('An amendment can only be issued against a signed contract.', {
        extensions: { code: 'CONTRACT_NOT_SIGNED' },
      });
    }

    const latest = await prisma.amendment.findFirst({
      where: { contractRevisionId: current.id },
      orderBy: { ordinal: 'desc' },
    });
    const ordinal = (latest?.ordinal ?? 0) + 1;
    const snapshot = buildAmendmentSnapshot({
      ordinal,
      titleFa: args.titleFa,
      titleEn: args.titleEn,
      bodyFa: args.bodyFa,
      bodyEn: args.bodyEn,
    });

    await prisma.amendment.create({
      data: {
        contractRevisionId: current.id,
        ordinal,
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        bodyFa: args.bodyFa,
        bodyEn: args.bodyEn,
        relatesToArticle: args.relatesToArticle ?? null,
        contentHash: contentHash(snapshot),
      },
    });
    return reload(contract.id);
  },

  /**
   * An amendment editable while unpublished must have its hash move with it,
   * or a typo means burning an ordinal. The hash is computed from the row
   * about to be written, never from the arguments in isolation — the two
   * cannot then disagree (V2.md §3.2, "the dangerous one").
   */
  updateAmendment: async (
    _p: unknown,
    args: {
      amendmentId: string;
      titleFa: string;
      titleEn: string;
      bodyFa: string;
      bodyEn: string;
      relatesToArticle?: number | null;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is published and cannot be edited.', {
        extensions: { code: 'REVISION_PUBLISHED' },
      });
    }

    const snapshot = buildAmendmentSnapshot({
      ordinal: amendment.ordinal,
      titleFa: args.titleFa,
      titleEn: args.titleEn,
      bodyFa: args.bodyFa,
      bodyEn: args.bodyEn,
    });
    await prisma.amendment.update({
      where: { id: amendment.id },
      data: {
        titleFa: args.titleFa,
        titleEn: args.titleEn,
        bodyFa: args.bodyFa,
        bodyEn: args.bodyEn,
        relatesToArticle: args.relatesToArticle ?? null,
        contentHash: contentHash(snapshot),
      },
    });
    return reload(amendment.contractRevision.contractId);
  },

  deleteAmendment: async (_p: unknown, args: { amendmentId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is published and cannot be deleted.', {
        extensions: { code: 'REVISION_PUBLISHED' },
      });
    }
    await prisma.amendment.delete({ where: { id: amendment.id } });
    return reload(amendment.contractRevision.contractId);
  },

  publishAmendment: async (_p: unknown, args: { amendmentId: string }, ctx: Context) => {
    const admin = requireCapability(ctx, 'contracts.manage');
    const amendment = await prisma.amendment.findUnique({
      where: { id: args.amendmentId },
      include: { contractRevision: { select: { contractId: true } } },
    });
    if (!amendment) {
      throw new GraphQLError('No such amendment.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (amendment.publishedAt) {
      throw new GraphQLError('That amendment is already published.', {
        extensions: { code: 'ALREADY_PUBLISHED' },
      });
    }
    const contractId = amendment.contractRevision.contractId;
    const contract = await loadContract(contractId);
    if (!contract) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }

    await prisma.amendment.update({
      where: { id: amendment.id },
      data: { publishedAt: new Date() },
    });
    await log(contractId, admin.id, 'CONTRACT_AMENDED', `A${amendment.ordinal}`);
    await nudgeStatus(contract, 'WAITING_ON_CUSTOMER');
    return reload(contractId);
  },
};
