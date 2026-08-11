import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import { buildDocumentSnapshot, contentHash, type Block } from '../../lib/revision.js';
import { isFullCommitSha, isSafeRepoPath } from '../../lib/reviewBlocks.js';

/**
 * The Review Room's queries and mutation (C1). `review.participate` reads;
 * `review.admin` is the only capability that may publish — the most
 * externally-held capability in the app reads through this file, so every
 * resolver here is guarded on its own, never by the desk nav alone (T2).
 */

const notFound = (what: string) =>
  new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/** The list screen's document shape — no blocks, matching the staff Library
 *  list's own thinness (T1). */
const documentRefSelect = {
  id: true,
  path: true,
  title: true,
  order: true,
} satisfies Prisma.ReviewDocumentSelect;

type BlockInput = { id: string; kind: Block['kind']; depth?: number | null; text: string };
type DocumentInput = { path: string; title: string; order: number; blocks: BlockInput[] };

/** Validates and narrows the mutation's block input into the stored shape.
 *  GraphQL's own enum/required-field checks already refuse a malformed
 *  `kind` or a missing `text` before this runs — this is the one thing the
 *  schema cannot express: an empty id or empty text. */
function toBlocks(input: BlockInput[]): Block[] {
  return input.map((b) => {
    if (!b.id.trim() || !b.text.trim()) {
      throw new GraphQLError('Every block needs a non-empty id and text.', {
        extensions: { code: 'INVALID_BLOCK' },
      });
    }
    return b.depth == null ? { id: b.id, kind: b.kind, text: b.text } : { id: b.id, kind: b.kind, depth: b.depth, text: b.text };
  });
}

export const reviewQueries = {
  reviewRounds: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'review.participate');
    return prisma.reviewRound.findMany({
      orderBy: { publishedAt: 'desc' },
      include: {
        publishedBy: true,
        documents: { orderBy: { order: 'asc' }, select: documentRefSelect },
      },
    });
  },

  reviewDocument: async (_p: unknown, args: { roundId: string; documentId: string }, ctx: Context) => {
    requireCapability(ctx, 'review.participate');
    const doc = await prisma.reviewDocument.findFirst({
      where: { id: args.documentId, roundId: args.roundId },
      include: { round: true },
    });
    if (!doc) throw notFound('document');
    return doc;
  },
};

export const reviewMutations = {
  publishReviewRound: async (
    _p: unknown,
    args: { sha: string; label?: string | null; documents: DocumentInput[] },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'review.admin');

    // T1: the round is a record of a sha, not a link to one — this never
    // resolves, fetches or validates it against a remote. It only checks the
    // *shape*, which is what "not a symbolic ref" (C1.md §3) actually means
    // from the one side of the trust boundary that has no git access at all.
    if (!isFullCommitSha(args.sha)) {
      throw new GraphQLError('sha must be a full 40-character commit hash.', {
        extensions: { code: 'INVALID_SHA' },
      });
    }
    if (args.documents.length === 0) {
      throw new GraphQLError('A round needs at least one document.', { extensions: { code: 'EMPTY_ROUND' } });
    }

    // Republishing the same sha is refused rather than made idempotent — a
    // round names an immutable commit, so a second publish at the same sha
    // is either a mistake or nothing new to say (C1.md §3.1).
    const existing = await prisma.reviewRound.findFirst({ where: { sha: args.sha } });
    if (existing) {
      throw new GraphQLError('A round for this sha has already been published.', {
        extensions: { code: 'ROUND_ALREADY_PUBLISHED' },
      });
    }

    const seenPaths = new Set<string>();
    for (const doc of args.documents) {
      if (!isSafeRepoPath(doc.path)) {
        throw new GraphQLError(`Refusing an unsafe path: "${doc.path}".`, {
          extensions: { code: 'UNSAFE_PATH' },
        });
      }
      if (seenPaths.has(doc.path)) {
        throw new GraphQLError(`Duplicate path in one round: "${doc.path}".`, {
          extensions: { code: 'DUPLICATE_PATH' },
        });
      }
      seenPaths.add(doc.path);
      if (doc.blocks.length === 0) {
        throw new GraphQLError(`"${doc.path}" has no blocks.`, { extensions: { code: 'EMPTY_DOCUMENT' } });
      }
    }

    const round = await prisma.reviewRound.create({
      data: {
        sha: args.sha,
        label: args.label?.trim() || null,
        publishedById: user.id,
        documents: {
          create: args.documents.map((doc) => {
            const blocks = toBlocks(doc.blocks);
            return {
              path: doc.path,
              title: doc.title,
              order: doc.order,
              blocks: blocks as unknown as Prisma.InputJsonValue,
              // Never taken from the request — recomputed from the blocks
              // this resolver itself just validated (C1.md §3.1).
              contentHash: contentHash(buildDocumentSnapshot(blocks)),
            };
          }),
        },
      },
      include: {
        publishedBy: true,
        documents: { orderBy: { order: 'asc' }, select: documentRefSelect },
      },
    });
    return round;
  },
};
