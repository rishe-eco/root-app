import { GraphQLError } from 'graphql';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { checkInterception } from '../../lib/feedback.js';
import { sendMail } from '../../lib/mail.js';
import { feedbackSubmittedEmail, feedbackRatifiedEmail } from '../../lib/mailTemplates.js';
import { env } from '../../lib/env.js';
import { loadDemoForActor } from './demo.js';
import { reload } from './contracts.js';
import { firstContractId } from './admin/shared.js';

/**
 * Per-item feedback intake and ratification (build plan L3; spec §6).
 *
 * Lives outside `resolvers/admin/` on purpose, same reasoning as
 * `resolvers/demo.ts`: `submitFeedback` and `ratifyFeedback` are both
 * ownership-gated (house rule 2 — `project.customerId`, D3's own escape
 * hatch), not capability-gated, and the decider is "the project's own
 * customer, or staff" for both — never a role test.
 */

/** Shared shape for the FeedbackItem GraphQL type, reused by fields.ts's
 *  `Project.phases` eager include and by this file's own reloads, so the two
 *  never drift into fetching a different shape of the same object. */
export const feedbackItemInclude = {
  demoPage: true,
  frameLine: true,
  reopenedScopeItem: true,
  ratifiedBy: true,
  comments: { orderBy: { createdAt: 'asc' as const }, include: { author: true } },
} satisfies Prisma.FeedbackItemInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

/** Every account holding contracts.manage — "Root," for feedback
 *  notifications. Same pattern reviewThreads.ts's own `reviewAdmins()` uses
 *  for a different capability; filtered in application code, never by
 *  testing a role directly (lib/capabilities.ts's own rule). */
async function contractManagers(): Promise<User[]> {
  const active = await prisma.user.findMany({ where: { state: 'ACTIVE' } });
  return active.filter((u) => can(u, 'contracts.manage'));
}

function deskDemoUrl(locale: string, contractId: string): string {
  return `${env.APP_ORIGIN}/${locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contractId}/phases`;
}

export const feedbackMutations = {
  /**
   * Exactly one of targetDemoPageId/targetFrameLineId. Intercepted (D4) when
   * the target resolves to a decided/temporary scope item and confirmReopen
   * is not yet true — nothing is written; the caller resubmits identically
   * with confirmReopen: true once the reviewer has seen the prompt the web
   * renders from interceptionReason/interceptionScopeItem (house rule 6).
   *
   * A second submission against a target that already has a row appends a
   * FeedbackComment to it instead of creating a second item (D4's collapse
   * — the two partial-unique indexes on FeedbackItem are the backstop).
   */
  submitFeedback: async (
    _p: unknown,
    args: {
      demoId: string;
      targetDemoPageId?: string | null;
      targetFrameLineId?: string | null;
      body: string;
      confirmReopen?: boolean | null;
    },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    const demo = await loadDemoForActor(args.demoId, user);

    if (!demo.publishedAt) {
      throw new GraphQLError('This demo has not been published yet.', { extensions: { code: 'DEMO_NOT_PUBLISHED' } });
    }

    const hasPage = !!args.targetDemoPageId;
    const hasLine = !!args.targetFrameLineId;
    if (hasPage === hasLine) {
      throw new GraphQLError('Feedback must target exactly one page or frame line.', {
        extensions: { code: 'INVALID_TARGET' },
      });
    }

    const body = args.body.trim();
    if (!body) {
      throw new GraphQLError('A comment needs a body.', { extensions: { code: 'EMPTY_COMMENT' } });
    }

    let scopeItemForInterception: { id: string; decidedAt: Date | null; temporary: boolean } | null = null;
    if (hasPage) {
      const page = demo.pages.find((p) => p.id === args.targetDemoPageId);
      if (!page) throw notFound('demo page');
    } else {
      const line = await prisma.demoFrameLine.findUnique({
        where: { id: args.targetFrameLineId! },
        include: { frame: true, scopeItem: true },
      });
      if (!line || line.frame.demoId !== demo.id) throw notFound('frame line');
      scopeItemForInterception = line.scopeItem;
    }

    const interception = checkInterception(scopeItemForInterception);
    if (interception.intercepted && !args.confirmReopen) {
      // Nothing written yet — the reviewer has not confirmed past the
      // prompt this result lets the web build (house rule 6: a code and
      // parameters, never a sentence, from this side of the wire).
      return {
        item: null,
        intercepted: true,
        interceptionReason: interception.reason,
        interceptionScopeItem: scopeItemForInterception,
      };
    }

    const itemId = await prisma.$transaction(async (tx) => {
      const existing = hasPage
        ? await tx.feedbackItem.findUnique({ where: { demoPageId: args.targetDemoPageId! } })
        : await tx.feedbackItem.findUnique({ where: { frameLineId: args.targetFrameLineId! } });

      const feedbackItem =
        existing ??
        (await tx.feedbackItem.create({
          data: {
            demoId: demo.id,
            demoPageId: hasPage ? args.targetDemoPageId : null,
            frameLineId: hasLine ? args.targetFrameLineId : null,
            reopenedScopeItemId: interception.intercepted ? interception.scopeItemId : null,
          },
        }));

      // A target already on record can still be re-intercepted later (the
      // scope item is decided *after* the first, un-intercepted comment) —
      // record that the moment it is confirmed, rather than only at creation.
      if (interception.intercepted && !feedbackItem.reopenedScopeItemId) {
        await tx.feedbackItem.update({
          where: { id: feedbackItem.id },
          data: { reopenedScopeItemId: interception.scopeItemId },
        });
      }

      await tx.feedbackComment.create({ data: { feedbackItemId: feedbackItem.id, authorId: user.id, body } });
      return feedbackItem.id;
    });

    // "The team has been notified" (spec §6) — the mechanism, not polish.
    // Never sent when Root itself is the one submitting.
    if (!can(user, 'contracts.manage')) {
      const project = demo.phase.project;
      const contractId = await firstContractId(project.id);
      const recipients = await contractManagers();
      await Promise.all(
        recipients.map((r) =>
          sendMail({
            to: r.email,
            ...feedbackSubmittedEmail(r.locale, {
              recipientName: r.name,
              projectTitleFa: project.titleFa,
              projectTitleEn: project.titleEn,
              deskUrl: deskDemoUrl(r.locale, contractId),
            }),
          }).catch((err) => console.error('[mail] feedback-submitted send failed', err)),
        ),
      );
    }

    const full = await prisma.feedbackItem.findUniqueOrThrow({ where: { id: itemId }, include: feedbackItemInclude });
    return {
      item: full,
      intercepted: interception.intercepted,
      interceptionReason: interception.intercepted ? interception.reason : null,
      interceptionScopeItem: scopeItemForInterception,
    };
  },

  /**
   * The decider (D3) ratifies a batch. Only items in the list that are
   * currently OPEN and belong to this demo move — anything else named is
   * silently skipped, the same idempotent shape `resolveReviewThread`
   * already uses for "already done" rather than treating it as an error.
   */
  ratifyFeedback: async (_p: unknown, args: { demoId: string; itemIds: string[] }, ctx: Context) => {
    const user = requireUser(ctx);
    const demo = await loadDemoForActor(args.demoId, user);

    const { count } = await prisma.feedbackItem.updateMany({
      where: { demoId: demo.id, id: { in: args.itemIds }, status: 'OPEN' },
      data: { status: 'RATIFIED', ratifiedAt: new Date(), ratifiedById: user.id },
    });

    if (count > 0) {
      const project = demo.phase.project;
      const contractId = await firstContractId(project.id);
      const recipients = await contractManagers();
      await Promise.all(
        recipients.map((r) =>
          sendMail({
            to: r.email,
            ...feedbackRatifiedEmail(r.locale, {
              recipientName: r.name,
              projectTitleFa: project.titleFa,
              projectTitleEn: project.titleEn,
              count,
              deskUrl: deskDemoUrl(r.locale, contractId),
            }),
          }).catch((err) => console.error('[mail] feedback-ratified send failed', err)),
        ),
      );
    }

    return reload(await firstContractId(demo.phase.projectId));
  },
};
