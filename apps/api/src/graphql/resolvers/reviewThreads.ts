import { GraphQLError } from 'graphql';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { requireCapability, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { sendMail } from '../../lib/mail.js';
import { newCommentEmail } from '../../lib/mailTemplates.js';
import type { Block } from '../../lib/revision.js';

/**
 * C2: threads and comments anchored to a passage in one frozen block.
 * `review.participate` is the surface guard everywhere below; which threads
 * a given caller may then see or act on is a separate question, answered by
 * `threadsVisibleTo` — house rule 2, the same shape as `loadForActor` for a
 * contract, just expressed as a where-clause rather than a load-and-check
 * (a list filter, not a single row).
 */

const notFound = (what: string) =>
  new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

const threadInclude = {
  author: true,
  resolvedBy: true,
  comments: { orderBy: { createdAt: 'asc' as const }, include: { author: true } },
};

/** Root sees every thread; a reviewer sees only their own. Parallel
 *  independent review — one expert's read must not anchor another's
 *  (C2.md §3). Loading a thread through this filter *is* the permission
 *  check for reading, replying to, and resolving it: there is no thread a
 *  caller can load here that they are not also allowed to act on. */
const threadsVisibleTo = (user: Pick<User, 'roles' | 'id'>) =>
  can(user, 'review.admin') ? {} : { authorId: user.id };

async function loadThreadForActor(threadId: string, user: User) {
  const thread = await prisma.reviewThread.findFirst({
    where: { id: threadId, ...threadsVisibleTo(user) },
    include: { ...threadInclude, document: true },
  });
  // Existence and ownership collapse into one NOT_FOUND (house rule: never
  // tell a caller "that exists, but isn't yours" — see contracts.ts's
  // loadForActor for the same shape).
  if (!thread) throw notFound('thread');
  return thread;
}

function blockExists(blocks: unknown, blockId: string): boolean {
  return Array.isArray(blocks) && (blocks as Block[]).some((b) => b?.id === blockId);
}

/** Every user currently holding review.admin — "Root," for the purpose of
 *  new-comment notifications. Filtered in application code, never by
 *  testing a role directly (lib/capabilities.ts's own rule), since which
 *  role grants review.admin is that file's decision to make, not this
 *  one's to duplicate. */
async function reviewAdmins(): Promise<User[]> {
  const active = await prisma.user.findMany({ where: { state: 'ACTIVE' } });
  return active.filter((u) => can(u, 'review.admin'));
}

function threadUrl(locale: string, roundId: string, documentId: string, threadId: string): string {
  return `${env.APP_ORIGIN}/${locale}/desk/review/${roundId}/${documentId}#thread-${threadId}`;
}

async function notifyNewComment(
  recipients: User[],
  doc: { title: string; roundId: string; id: string },
  threadId: string,
) {
  await Promise.all(
    recipients.map((u) =>
      sendMail({
        to: u.email,
        ...newCommentEmail(u.locale, {
          recipientName: u.name,
          documentTitle: doc.title,
          threadUrl: threadUrl(u.locale, doc.roundId, doc.id, threadId),
        }),
      }).catch((err) => console.error('[mail] new-comment send failed', err)),
    ),
  );
}

export const reviewThreadFields = {
  ReviewDocument: {
    /** Visible to Root always; to a reviewer, only the threads they opened
     *  (§3). No existence leak: a reviewer asking for this field on a
     *  document with someone else's thread on it sees nothing at all, not
     *  an empty-but-suggestive count. */
    threads: async (doc: { id: string }, _a: unknown, ctx: Context) => {
      const user = requireCapability(ctx, 'review.participate');
      return prisma.reviewThread.findMany({
        where: { documentId: doc.id, ...threadsVisibleTo(user) },
        orderBy: { createdAt: 'asc' },
        include: threadInclude,
      });
    },
  },
};

export const reviewThreadMutations = {
  openReviewThread: async (
    _p: unknown,
    args: {
      documentId: string;
      blockId: string;
      startOffset: number;
      endOffset: number;
      quote: string;
      body: string;
    },
    ctx: Context,
  ) => {
    const user = requireCapability(ctx, 'review.participate');

    if (args.startOffset < 0 || args.endOffset <= args.startOffset) {
      throw new GraphQLError('Not a passage.', { extensions: { code: 'INVALID_RANGE' } });
    }
    if (!args.quote.trim() || !args.body.trim()) {
      throw new GraphQLError('A thread needs its quote and an opening comment.', {
        extensions: { code: 'INVALID_THREAD' },
      });
    }

    const doc = await prisma.reviewDocument.findUnique({ where: { id: args.documentId } });
    if (!doc) throw notFound('document');
    // Revalidated server-side, not trusted from the client's own DOM walk
    // (same discipline as publishReviewRound's trust boundary, C1.md §3.1):
    // the block named must actually belong to this document.
    if (!blockExists(doc.blocks, args.blockId)) {
      throw new GraphQLError('No such block in this document.', { extensions: { code: 'UNKNOWN_BLOCK' } });
    }

    const thread = await prisma.reviewThread.create({
      data: {
        documentId: doc.id,
        authorId: user.id,
        blockId: args.blockId,
        startOffset: args.startOffset,
        endOffset: args.endOffset,
        quote: args.quote,
        comments: { create: { authorId: user.id, body: args.body } },
      },
      include: threadInclude,
    });

    // Root gets notified of a new thread; never another reviewer (§3, §6).
    await notifyNewComment(await reviewAdmins(), doc, thread.id);

    return thread;
  },

  addReviewComment: async (_p: unknown, args: { threadId: string; body: string }, ctx: Context) => {
    const user = requireCapability(ctx, 'review.participate');
    if (!args.body.trim()) {
      throw new GraphQLError('A comment needs a body.', { extensions: { code: 'EMPTY_COMMENT' } });
    }
    const thread = await loadThreadForActor(args.threadId, user);

    await prisma.reviewComment.create({
      data: { threadId: thread.id, authorId: user.id, body: args.body },
    });

    // Notify the *other* side of this one thread — the author if Root just
    // replied, Root if the author added to their own thread. Never a third
    // party: `loadThreadForActor` already proved this caller is one of
    // exactly these two people.
    if (user.id === thread.authorId) {
      await notifyNewComment(await reviewAdmins(), thread.document, thread.id);
    } else {
      await notifyNewComment([thread.author], thread.document, thread.id);
    }

    return prisma.reviewThread.findUniqueOrThrow({ where: { id: thread.id }, include: threadInclude });
  },

  resolveReviewThread: async (_p: unknown, args: { threadId: string }, ctx: Context) => {
    const user = requireCapability(ctx, 'review.participate');
    const thread = await loadThreadForActor(args.threadId, user);
    if (thread.resolvedAt) return thread; // already resolved — idempotent, not an error

    return prisma.reviewThread.update({
      where: { id: thread.id },
      data: { resolvedAt: new Date(), resolvedById: user.id },
      include: threadInclude,
    });
  },
};
