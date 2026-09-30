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
import { notify } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { feedbackItemInclude } from './feedback.js';
import { linkContractId } from './admin/shared.js';
import { buildPhaseScope, requireBuildAuthorOnPhase, requireBuildAuthorOnProject } from './access.js';

/**
 * Builds and the resolution ledger (build plan L3b; spec §6's gap). Lives
 * outside `resolvers/admin/` on purpose, same reasoning as
 * `resolvers/demo.ts` and `resolvers/feedback.ts`: everything here is gated
 * on `builds.author`, a different capability from any contract verb — a
 * `DEVELOPER` must reach every mutation and query below without holding
 * `contracts.author`. Since journeys build plan S1 it is also gated on the
 * assignment edge: a developer sees and builds the projects of the contracts
 * they develop (`requireBuildAuthorOnProject`), not every project — the same
 * rule the demo and frame mutations apply, so the queue and the demo cannot
 * disagree about whose work this is. `assignments.override` (ADMIN) sees all.
 *
 * **Nothing here returns `Contract!`.** Every other admin-side mutation in
 * this codebase does, so Apollo's cache stays consistent (T9 in V2.md) — but
 * that convention was built for callers who hold `contracts.author`.
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

/**
 * The one definition of "open feedback the build queue owes an answer": the
 * demo step's, on this project, still `OPEN` — optionally on one phase. The
 * queue and `declareBuild` both use it (see `openFeedbackQueue`).
 */
const openDemoItems = (projectId: string, phaseId: string | null): Prisma.FeedbackItemWhereInput => ({
  step: 'DEMO',
  status: 'OPEN',
  projectId,
  ...(phaseId ? { phaseId } : {}),
});

/**
 * Narrows a read to the phases the caller works (journeys build plan J4): a
 * project with two contracts and two developers gives each their own queue,
 * because a phase's claim is its own contract's developer. For
 * `assignments.override` the scope is empty and **no clause is added at all**:
 * Prisma reads `phase: {}` on an optional relation as "has a phase", which is
 * not the same as "any".
 */
const ownPhases = (user: Parameters<typeof buildPhaseScope>[0]): { phase?: Prisma.PhaseWhereInput } => {
  const scope = buildPhaseScope(user);
  return Object.keys(scope).length > 0 ? { phase: scope } : {};
};

type BuildChangeInputArg = {
  feedbackItemId?: string | null;
  scopeItemId?: string | null;
  outcome?: BuildChangeOutcomeLike | null;
  note?: string | null;
  noteLang?: string | null;
};

export const buildQueries = {
  /** Staff (builds.author). Every phase across the active projects this
   *  caller develops (every active project, with `assignments.override`),
   *  thin — the build-authoring form's phase picker. Never touches Contract. */
  phasesForBuilds: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireCapability(ctx, 'builds.author');
    const phases = await prisma.phase.findMany({
      where: { project: { status: 'ACTIVE' }, ...buildPhaseScope(user) },
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

  /** Staff (builds.author). Every OPEN item of the **demo step** on this
   *  project (narrowed to one phase when given), oldest first — the queue
   *  declareBuild's disposition list must exhaust. "An empty queue means
   *  done" (build plan D6).
   *
   *  **`step: 'DEMO'` is the point of S2's second trap.** The queue used to be
   *  every open item on the project; with one feedback model for every step,
   *  that would put a customer's note on the budget or the design in the
   *  developer's queue, and a build that "dispositioned" it would drain another
   *  step's feedback — silently, in exactly the direction that looks like the
   *  queue working. Every `feedbackItem` read in this file names its step.
   *
   *  Build plan L4's exclusion of items moved to a ticket is now the status
   *  itself (`MOVED` is not `OPEN`); an item the customer reopened after a move
   *  is open again and belongs in the queue. `declareBuild`'s own read below
   *  uses the same `where`, so the two can never disagree about what "open"
   *  means. */
  openFeedbackQueue: async (_p: unknown, args: { projectId: string; phaseId?: string | null }, ctx: Context) => {
    const user = await requireBuildAuthorOnProject(ctx, args.projectId);
    return prisma.feedbackItem.findMany({
      where: { ...openDemoItems(args.projectId, args.phaseId ?? null), ...ownPhases(user) },
      include: feedbackItemInclude,
      orderBy: { createdAt: 'asc' },
    });
  },

  /** Staff (builds.author). Every scope item on this project currently
   *  IN_BUILD and assigned to a phase — candidates for a "this was on the
   *  plan" change entry. */
  scopeItemsAwaitingBuild: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    const user = await requireBuildAuthorOnProject(ctx, args.projectId);
    return prisma.scopeItem.findMany({
      where: { projectId: args.projectId, status: 'IN_BUILD', phaseId: { not: null }, ...ownPhases(user) },
      orderBy: { position: 'asc' },
    });
  },

  /** Staff (builds.author). Every build declared for this project, newest first. */
  projectBuilds: async (_p: unknown, args: { projectId: string }, ctx: Context) => {
    const user = await requireBuildAuthorOnProject(ctx, args.projectId);
    return prisma.build.findMany({
      // SITE only: this is the developer's queue of staging-site versions. A
      // MOCKUP build (J9) has no phase, so the phase scope below would already
      // leave it out — `kind` says so out loud rather than leaving it to how
      // Prisma reads a relation filter on a nullable column.
      where: { projectId: args.projectId, kind: 'SITE', phase: buildPhaseScope(user) },
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
    // A disposition resolves the item directly, so the declarer must be one
    // whose demo answers are direct (`answerRoute`). Both roles that hold
    // `builds.author` hold this too; asked separately so a future grant that
    // splits them fails here, loudly, instead of publishing an answer nobody
    // approved.
    requireCapability(ctx, 'answers.direct.demo');
    const phase = await prisma.phase.findUnique({ where: { id: args.phaseId } });
    if (!phase) throw notFound('phase');
    await requireBuildAuthorOnPhase(ctx, phase.id);

    // Journeys build plan S2: the demo step's open items **on this phase** —
    // `openFeedbackQueue`'s own `where`, which this must agree with, and which
    // names the step so a build never dispositions (and so drains) the
    // budget's, the design's or any other step's feedback.
    const openItems = await prisma.feedbackItem.findMany({
      where: openDemoItems(phase.projectId, phase.id),
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
          throw new GraphQLError('That item is no longer open.', { extensions: { code: 'NOT_OPEN' } });
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
        // Numbered per (project, kind) since J9: a site's "version 4" must not
        // count the mockup's iterations (the unique index says the same).
        const highest = await tx.build.aggregate({
          where: { projectId: phase.projectId, kind: 'SITE' },
          _max: { number: true },
        });
        const number = nextBuildNumber(highest._max.number);

        const created = await tx.build.create({
          data: {
            kind: 'SITE',
            phaseId: phase.id,
            projectId: phase.projectId,
            number,
            declaredById: developer.id,
            ref: args.ref ?? null,
          },
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
              // **A disposition is the developer's answer** (S2, PD-4): a
              // staff comment carrying the resolution, direct because the
              // caller holds `answers.direct.demo` (required above). The
              // note is the answer's text; an ADDRESSED with none is an
              // answer with no words — "addressed in build N" says it. Without
              // the comment, a designer's older pending answer approved later
              // would be judged against a ledger that is not in the thread.
              await tx.feedbackComment.create({
                data: {
                  feedbackItemId: change.feedbackItemId,
                  authorId: developer.id,
                  body: note ?? '',
                  resolution: nextStatus,
                  approval: 'NOT_REQUIRED',
                },
              });
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
      include: { project: { include: { customer: true } }, phase: { select: { contractId: true } } },
    });
    if (!build) throw notFound('build');
    // A MOCKUP build (J9) has no phase and is the designer's, not the
    // developer's: this mutation is the SITE builds' publish. J9b widens it
    // (the mockup branch, and the allowance check) rather than this file
    // guessing at a designer guard now.
    if (build.phaseId === null || !build.phase) throw notFound('build');
    await requireBuildAuthorOnPhase(ctx, build.phaseId);
    if (build.publishedAt) {
      throw new GraphQLError('This build is already published.', { extensions: { code: 'ALREADY_PUBLISHED' } });
    }

    await prisma.build.update({ where: { id: build.id }, data: { publishedAt: new Date() } });

    const customer = build.project.customer;
    // The build's phase names its contract (J4): link the customer there when
    // they can open it (`linkContractId`).
    const contractId = await linkContractId(build.projectId, 'customer', build.phase.contractId);
    await notify(customer, {
      kind: 'BUILD_PUBLISHED',
      params: {
        customerName: customer.name,
        projectTitleFa: build.project.titleFa,
        projectTitleEn: build.project.titleEn,
        buildNumber: build.number,
        portalUrl: `${env.APP_ORIGIN}/${customer.locale === 'en' ? 'en' : 'fa'}/app/contracts/${contractId}`,
      },
    });

    return prisma.build.findUniqueOrThrow({ where: { id: build.id }, include: buildInclude });
  },
};
