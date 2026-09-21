import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, type Context } from '../../context.js';
import {
  missingDispositions,
  hasAtMostOneOrigin,
  outcomeAllowedForStatus,
  declinedRequiresNote,
  noOriginRequiresNote,
  noteAndLangTogether,
  nextFeedbackStatus,
  nextBuildNumber,
  type BuildChangeInputLike,
  type BuildChangeOutcomeLike,
} from '../../lib/build.js';
import { sendMail } from '../../lib/mail.js';
import { buildPublishedEmail } from '../../lib/mailTemplates.js';
import { env } from '../../lib/env.js';
import { feedbackItemInclude } from './feedback.js';
import { firstContractId } from './admin/shared.js';

/**
 * Builds and the resolution ledger (build plan L3b; spec §6's gap). Lives
 * outside `resolvers/admin/` on purpose, same reasoning as
 * `resolvers/demo.ts` and `resolvers/feedback.ts`: everything here is gated
 * on `builds.author`, a different capability from `contracts.manage` — a
 * `DEVELOPER` holding only `builds.author` must reach every mutation and
 * query below without ever touching a resolver gated on the admin's verb.
 *
 * **Nothing here returns `Contract!`.** Every other admin-side mutation in
 * this codebase does, so Apollo's cache stays consistent (T9 in V2.md) — but
 * that convention was built for callers who already hold `contracts.manage`.
 * A `Contract!` payload carries `amount`, `customer`, `draft`'s escape hatch,
 * and the rest of what a `DEVELOPER` must never see (build plan D6). Every
 * mutation and query in this file returns a `Build!`, a `FeedbackItem!`, a
 * `ScopeItem!` or a thin `BuildPhase!` instead — none of which reach
 * `Contract` at all.
 */

const buildInclude = {
  declaredBy: true,
  changes: {
    include: { feedbackItem: { include: feedbackItemInclude }, scopeItem: true },
    orderBy: { createdAt: 'asc' as const },
  },
} satisfies Prisma.BuildInclude;

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

type BuildChangeInputArg = {
  feedbackItemId?: string | null;
  scopeItemId?: string | null;
  outcome?: BuildChangeOutcomeLike | null;
  note?: string | null;
  noteLang?: string | null;
};

export const buildQueries = {
  /** Staff (builds.author). Every phase across every active project, thin —
   *  the build-authoring form's phase picker. Never touches Contract. */
  phasesForBuilds: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const phases = await prisma.phase.findMany({
      where: { project: { status: 'ACTIVE' } },
      include: { project: true },
      orderBy: [{ project: { createdAt: 'asc' } }, { number: 'asc' }],
    });
    return phases.map((p) => ({
      id: p.id,
      number: p.number,
      titleFa: p.titleFa,
      titleEn: p.titleEn,
      projectId: p.projectId,
      projectTitleFa: p.project.titleFa,
      projectTitleEn: p.project.titleEn,
    }));
  },

  /** Staff (builds.author). Every OPEN/RATIFIED feedback item on this
   *  project, oldest first — the queue declareBuild's disposition list must
   *  exhaust. "An empty queue means done" (build plan D6).
   *
   *  Build plan L4: an item already converted to a ticket (`ticket` set) is
   *  excluded — it has been moved to a different channel, and requiring a
   *  build disposition for it forever would mean the queue could never
   *  drain once a single item took that path. `declareBuild`'s own read
   *  below applies the same exclusion, so the two can never disagree about
   *  what "open" means. */
  openFeedbackQueue: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    return prisma.feedbackItem.findMany({
      where: { status: { in: ['OPEN', 'RATIFIED'] }, ticket: null, demo: { phase: { projectId: args.projectId } } },
      include: feedbackItemInclude,
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Staff (builds.author). Every scope item on this project currently
   *  IN_BUILD and assigned to a phase — candidates for a "this was on the
   *  plan" change entry. */
  scopeItemsAwaitingBuild: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    return prisma.scopeItem.findMany({
      where: { projectId: args.projectId, status: 'IN_BUILD', phaseId: { not: null } },
      orderBy: { position: 'asc' },
    });
  },

  /** Staff (builds.author). Every build declared for this project, newest first. */
  projectBuilds: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    return prisma.build.findMany({
      where: { projectId: args.projectId },
      include: buildInclude,
      orderBy: { number: 'desc' },
    });
  },
};

export const buildMutations = {
  /**
   * Declares a build (build plan L3b.1) — number is project-wide and
   * monotonic (lib/build.ts's nextBuildNumber), never per-phase. Requires a
   * disposition for every currently open feedback item on the *project*
   * (not only this phase — one staging site typically outlives a single
   * phase) before anything is written: L3b.2's "a fate must never be
   * silent," enforced here rather than discovered after the fact.
   *
   * FeedbackItem/ScopeItem transitions happen now, at declaration — this is
   * "the moment they put a new version on staging," not held back for
   * publishBuild's separate notification step.
   */
  declareBuild: async (
    _p: unknown,
    args: { phaseId: string; ref?: string | null; changes: BuildChangeInputArg[] },
    ctx: Context,
  ) => {
    const developer = requireCapability(ctx, 'builds.author');
    const phase = await prisma.phase.findUnique({ where: { id: args.phaseId } });
    if (!phase) throw notFound('phase');

    // Build plan L4: excludes items already moved to the ticket channel —
    // see openFeedbackQueue's own comment above, which this must agree with.
    const openItems = await prisma.feedbackItem.findMany({
      where: { status: { in: ['OPEN', 'RATIFIED'] }, ticket: null, demo: { phase: { projectId: phase.projectId } } },
      select: { id: true, status: true },
    });
    const openIds = openItems.map((i) => i.id);
    const missing = missingDispositions(openIds, args.changes as BuildChangeInputLike[]);
    if (missing.length > 0) {
      throw new GraphQLError('Every open feedback item needs a disposition before a build can be declared.', {
        extensions: { code: 'MISSING_DISPOSITION', missingFeedbackItemIds: missing },
      });
    }
    const statusById = new Map(openItems.map((i) => [i.id, i.status] as const));

    const feedbackIdsSeen = new Set<string>();
    for (const change of args.changes) {
      if (!hasAtMostOneOrigin(change)) {
        throw new GraphQLError('A change entry may name a feedback item or a scope item, never both.', {
          extensions: { code: 'INVALID_CHANGE_ORIGIN' },
        });
      }
      if (!noOriginRequiresNote(change)) {
        throw new GraphQLError('A change with no origin needs a note — the note is the entry.', {
          extensions: { code: 'NOTE_REQUIRED' },
        });
      }
      if (!declinedRequiresNote(change)) {
        throw new GraphQLError('A declined item needs its reason.', {
          extensions: { code: 'DECLINE_REASON_REQUIRED' },
        });
      }
      if (!noteAndLangTogether(change)) {
        throw new GraphQLError('A note needs the language it was authored in, and vice versa.', {
          extensions: { code: 'NOTE_LANG_REQUIRED' },
        });
      }

      if (change.feedbackItemId) {
        if (feedbackIdsSeen.has(change.feedbackItemId)) {
          throw new GraphQLError("A feedback item may only appear once in a build's change list.", {
            extensions: { code: 'DUPLICATE_DISPOSITION' },
          });
        }
        feedbackIdsSeen.add(change.feedbackItemId);

        const status = statusById.get(change.feedbackItemId);
        if (!status) throw notFound('open feedback item on this project');
        if (!change.outcome) {
          throw new GraphQLError('A feedback-item change needs an outcome.', {
            extensions: { code: 'OUTCOME_REQUIRED' },
          });
        }
        if (!outcomeAllowedForStatus(change.outcome, status)) {
          throw new GraphQLError('An item nobody has ratified yet can only be carried forward.', {
            extensions: { code: 'NOT_RATIFIED' },
          });
        }
      } else if (change.outcome) {
        throw new GraphQLError('Only a feedback-item change may carry an outcome.', {
          extensions: { code: 'INVALID_CHANGE_ORIGIN' },
        });
      }
    }

    const scopeItemIds = args.changes.map((c) => c.scopeItemId).filter((id): id is string => !!id);
    const scopeItems = scopeItemIds.length
      ? await prisma.scopeItem.findMany({ where: { id: { in: scopeItemIds } } })
      : [];
    const scopeById = new Map(scopeItems.map((s) => [s.id, s]));
    for (const id of scopeItemIds) {
      const item = scopeById.get(id);
      if (!item || item.projectId !== phase.projectId) throw notFound('scope item on this project');
      if (item.status !== 'IN_BUILD') {
        throw new GraphQLError('Only an item currently in build can ship in a build.', {
          extensions: { code: 'SCOPE_ITEM_NOT_IN_BUILD' },
        });
      }
    }

    let buildId: string;
    try {
      buildId = await prisma.$transaction(async (tx) => {
        const highest = await tx.build.aggregate({ where: { projectId: phase.projectId }, _max: { number: true } });
        const number = nextBuildNumber(highest._max.number);

        const created = await tx.build.create({
          data: { phaseId: phase.id, projectId: phase.projectId, number, declaredById: developer.id, ref: args.ref ?? null },
        });

        for (const change of args.changes) {
          const note = change.note?.trim() || null;
          await tx.buildChangeEntry.create({
            data: {
              buildId: created.id,
              feedbackItemId: change.feedbackItemId ?? null,
              scopeItemId: change.scopeItemId ?? null,
              outcome: change.outcome ?? null,
              note,
              noteLang: note ? (change.noteLang ?? null) : null,
            },
          });

          if (change.feedbackItemId && change.outcome) {
            const nextStatus = nextFeedbackStatus(change.outcome);
            if (nextStatus) {
              await tx.feedbackItem.update({
                where: { id: change.feedbackItemId },
                data: { status: nextStatus, addressedInBuildId: nextStatus === 'ADDRESSED' ? created.id : null },
              });
            }
          }

          if (change.scopeItemId) {
            await tx.scopeItem.update({ where: { id: change.scopeItemId }, data: { status: 'IN_DEMO' } });
          }
        }

        return created.id;
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw new GraphQLError('Someone else declared a build at the same moment — try again.', {
          extensions: { code: 'CONCURRENT_BUILD' },
        });
      }
      throw err;
    }

    return prisma.build.findUniqueOrThrow({ where: { id: buildId }, include: buildInclude });
  },

  /**
   * Publishing notifies the project's customer (build plan L3b.2's fourth
   * rule) — "a build the customer is not told about is a deployment, not a
   * version." Every FeedbackItem/ScopeItem transition already happened at
   * declareBuild; this only sets publishedAt and sends the mail.
   */
  publishBuild: async (_p: unknown, args: { buildId: string }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const build = await prisma.build.findUnique({
      where: { id: args.buildId },
      include: { project: { include: { customer: true } } },
    });
    if (!build) throw notFound('build');
    if (build.publishedAt) {
      throw new GraphQLError('This build is already published.', { extensions: { code: 'ALREADY_PUBLISHED' } });
    }

    await prisma.build.update({ where: { id: build.id }, data: { publishedAt: new Date() } });

    const customer = build.project.customer;
    const contractId = await firstContractId(build.projectId);
    await sendMail({
      to: customer.email,
      ...buildPublishedEmail(customer.locale, {
        customerName: customer.name,
        projectTitleFa: build.project.titleFa,
        projectTitleEn: build.project.titleEn,
        buildNumber: build.number,
        portalUrl: `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`,
      }),
    }).catch((err) => console.error('[mail] build-published send failed', err));

    return prisma.build.findUniqueOrThrow({ where: { id: build.id }, include: buildInclude });
  },
};
