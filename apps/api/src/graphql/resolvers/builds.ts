import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { notify } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { feedbackItemInclude } from './feedback.js';
import { linkContractId } from './admin/shared.js';
import { buildPhaseScope, requireBuildAuthorOnPhase, requireBuildAuthorOnProject } from './access.js';
import { buildInclude, declareBuildFor, type BuildChangeInputArg } from './buildLedger.js';
import { publishMockupBuild } from './mockupStep.js';

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

    // The rule itself — every open item disposed, each disposition a direct
    // answer, the number the next of its kind — is `declareBuildFor`'s, which
    // the designer's `declareMockupBuild` shares (J9b).
    const buildId = await declareBuildFor({
      kind: 'SITE',
      projectId: phase.projectId,
      phaseId: phase.id,
      demoId: null,
      bundleFileId: null,
      openItems,
      declarer: developer,
      ref: args.ref,
      changes: args.changes,
      scopeItems: 'SHIP',
    });

    return prisma.build.findUniqueOrThrow({ where: { id: buildId }, include: buildInclude });
  },

  /**
   * Publishing notifies the project's customer (build plan L3b.2's fourth
   * rule) — "a build the customer is not told about is a deployment, not a
   * version." Every FeedbackItem/ScopeItem transition already happened at
   * declareBuild; this only sets publishedAt and sends the mail.
   *
   * **One mutation, two surfaces** (journeys build plan J9b): a `MOCKUP` build is
   * the designer's (`design.author` and being the contract's designer —
   * `publishMockupBuild`, which also holds the allowance) and a `SITE` build the
   * developer's (`builds.author` and the phase's assignment). The kind is read
   * before either guard that needs a row, so **the first check is "do you hold
   * either capability"**: someone with neither hears `FORBIDDEN` whatever id they
   * name, and cannot use the two different refusals below to learn which ids are
   * mockups. Holding the *other* surface's capability answers `NOT_FOUND` — a
   * developer is not shown that a mockup build exists on this surface, and (as
   * before J9b) the designer is told `FORBIDDEN` for a site build.
   */
  publishBuild: async (_p: unknown, args: { buildId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    if (!can(user, 'builds.author') && !can(user, 'design.author')) {
      throw new GraphQLError('You do not have access to that.', { extensions: { code: 'FORBIDDEN' } });
    }
    const build = await prisma.build.findUnique({
      where: { id: args.buildId },
      include: { project: { include: { customer: true } }, phase: { select: { contractId: true } } },
    });
    if (!build) throw notFound('build');
    if (build.kind === 'MOCKUP') return publishMockupBuild(ctx, build.id);

    requireCapability(ctx, 'builds.author');
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
