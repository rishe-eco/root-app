import { GraphQLError } from 'graphql';
import type { Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireCapability, requireUser, viewerOf, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { approveStepTx, lockContract } from '../../lib/stepApproval.js';
import { assertWithinAllowance } from '../../lib/allowance.js';
import { computeWizard } from '../../lib/steps.js';
import { buildTimelineOf } from '../../lib/buildTimeline.js';
import { canAuthorBuildOnPhase, contractVisibleTo, isContractReader, mayReadPlannedDates } from '../../lib/visibility.js';
import { notify, recipientsHolding } from '../../lib/notify.js';
import { env } from '../../lib/env.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { assertStepOpenOn, wizardStateOn } from './wizard.js';
import { requireBuildAuthorOnPhase, siteDemo } from './access.js';
import { allowanceStateOn, tellSalesAllowanceExhausted } from './allowance.js';
import { stepOwners } from './feedback.js';
import { buildInclude } from './buildLedger.js';
import { linkContractId, reloadOnProject } from './admin/shared.js';

/**
 * Step 6 — the demo, per phase (journeys build plan J10): the staging site's
 * **readiness**, the developer's **page-map confirmation**, the phase's
 * **approval**, and the **lock** that approval puts on everything the developer
 * does to that phase. The demo itself, its frame and its builds are L2, L3 and
 * L3b's; this is what J10 adds around them.
 *
 * ## Who may do what
 *
 * | mutation | who | edge | step |
 * |---|---|---|---|
 * | `verifyDemoReadiness` | `builds.author` **or** `contracts.author` | the phase's developer; for sales, a contract they see | open (`openDemo`) |
 * | `confirmPageMap` | `builds.author` | the phase's developer | open |
 * | `approveDemo` | — | the contract's own customer | `approveStepTx` |
 * | every other demo, frame and build write | as before | as before | **open** — `STEP_LOCKED` once approved |
 *
 * ## The lock
 *
 * **Every developer-side write to a phase goes through `openDemo`**, which takes
 * the contract's row lock (so a write cannot interleave with the customer's
 * approval, which takes the same lock) and refuses `STEP_LOCKED` once the phase's
 * DEMO `StepApproval` exists. `j10.test.ts` holds a table of them against
 * `STEP_LOCKED` and a source scan that fails when a call site is added without a
 * row, as `j7.test.ts`, `j8.test.ts` and `j9b.test.ts` do for their steps. The
 * customer's own writes (`submitFeedback`, the answers) are locked by S2's
 * `assertStepOpenOn` and need nothing here.
 */

type Tx = Prisma.TransactionClient;

const refuse = (code: string, message: string, extensions: Record<string, unknown> = {}) =>
  new GraphQLError(message, { extensions: { code, ...extensions } });
const notFound = (what: string) => refuse('NOT_FOUND', `No such ${what}.`);

/**
 * **Every write to a phase's demo, frame or builds starts here.** Under the
 * contract's row lock, the phase's demo step must be open (`STEP_LOCKED` once the
 * customer has approved it). A legacy contract is never locked
 * (`computeWizard`: `DESIGN_FIRST` has no `StepApproval`-driven lock), so its
 * demos behave as they always did. Returns the phase.
 *
 * The lock comes first and the state after, the order `openDesign` and
 * `openMockup` use: a refusal that depends on state must read that state under
 * the lock.
 */
export async function openDemo(tx: Tx, phaseId: string) {
  const phase = await tx.phase.findUnique({
    where: { id: phaseId },
    select: { id: true, number: true, projectId: true, contractId: true },
  });
  if (!phase) throw notFound('phase');
  await lockContract(tx, phase.contractId);
  await assertStepOpenOn(phase.contractId, 'DEMO', phase.id, tx);
  return phase;
}

/**
 * The page map is confirmed per build (journeys §7.5, the second banked trap), and
 * the confirmation attests to the map *as it stood*: a page declared, re-pointed
 * or deleted afterwards un-confirms every build of the phase that has not been
 * published yet, so a confirmed-then-edited map cannot be published on the strength
 * of a look at a different one. A published build keeps what it was published with.
 */
export async function clearPageMapConfirmation(tx: Tx, phaseId: string): Promise<void> {
  await tx.build.updateMany({
    where: { phaseId, kind: 'SITE', publishedAt: null, pageMapConfirmedAt: { not: null } },
    data: { pageMapConfirmedAt: null },
  });
}

// --- readiness ---------------------------------------------------------------------------

/**
 * **Who may record a staging site's readiness** (trap 1): the phase's developer
 * (`builds.author` and the assignment edge — `canAuthorBuildOnPhase`, the guard
 * every demo mutation uses) or sales (`contracts.author`, on a contract they can
 * see). Not the designer, not the customer: readiness is a claim about a
 * deployment, made by someone who answers for it. The capability comes first, so
 * someone with neither hears `FORBIDDEN` whatever id they name; a developer who is
 * not this contract's hears `NOT_ASSIGNED`, and a demo nobody can see is `NOT_FOUND`.
 */
async function requireReadinessRecorder(ctx: Context, phaseId: string): Promise<User> {
  const user = requireUser(ctx);
  const developer = can(user, 'builds.author');
  const sales = can(user, 'contracts.author');
  if (!developer && !sales) {
    throw refuse('FORBIDDEN', 'You do not have access to that.');
  }
  const phase = await prisma.phase.findUnique({
    where: { id: phaseId },
    select: {
      contract: {
        select: { customerId: true, publishedAt: true, status: true, deliveredAt: true, developerId: true, project: { select: { status: true } } },
      },
    },
  });
  if (!phase || !contractVisibleTo(user, phase.contract)) throw notFound('demo');
  if (sales) return user;
  if (!canAuthorBuildOnPhase(user, phase.contract)) {
    throw refuse('NOT_ASSIGNED', 'You are not the developer of this phase.');
  }
  return user;
}

const originOf = (url: string | null): string | null => {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

export const demoStepMutations = {
  /**
   * **Records that a named staff member's browser heard from the staging site.**
   * Called by `DemoViewport` when the reporter snippet's first report arrives from
   * the demo's own origin — the origin check is the browser's (`event.origin`,
   * `lib/frameOrigin.ts`), because the server cannot see `postMessage` origins at
   * all. So what is stored is exactly that claim and its claimant (`readyAt`,
   * `readyVerifiedById`), never "the server verified the site"; this is the owed
   * snippet test (lifecycle plan §0.3.2) made a precondition of publishing
   * (`DEMO_NOT_READY`).
   *
   * `origin` is the origin the browser heard from. It must be the demo's *current*
   * staging origin (`READINESS_ORIGIN_MISMATCH` otherwise): a claim made about the
   * address the demo had a moment ago — the URL was changed while the viewport was
   * open — must not become the readiness of the new one.
   *
   * Idempotent: a second report leaves the first claim, and its claimant, standing.
   * Refusals, in order: `FORBIDDEN`, `NOT_FOUND`, `NOT_ASSIGNED`, `STEP_LOCKED`,
   * `READINESS_ORIGIN_MISMATCH`. SITE demos only — a mockup has nothing to prove
   * (Root's own server injects the snippet into it) and is `NOT_FOUND` here.
   */
  verifyDemoReadiness: async (
    _p: unknown,
    args: { demoId: string; origin: string; contractId?: string | null },
    ctx: Context,
  ) => {
    const user = requireUser(ctx);
    if (!can(user, 'builds.author') && !can(user, 'contracts.author')) {
      throw refuse('FORBIDDEN', 'You do not have access to that.');
    }
    const found = await prisma.demo.findUnique({ where: { id: args.demoId }, include: { phase: true } });
    if (!found) throw notFound('demo');
    const demo = siteDemo(found);
    const recorder = await requireReadinessRecorder(ctx, demo.phaseId);

    await prisma.$transaction(async (tx) => {
      await openDemo(tx, demo.phaseId);
      const fresh = await tx.demo.findUniqueOrThrow({ where: { id: demo.id }, select: { stagingUrl: true, readyAt: true } });
      if (originOf(fresh.stagingUrl) !== args.origin) {
        throw refuse('READINESS_ORIGIN_MISMATCH', 'That is not the origin this demo is staged at.');
      }
      if (fresh.readyAt) return;
      await tx.demo.update({ where: { id: demo.id }, data: { readyAt: new Date(), readyVerifiedById: recorder.id } });
    });
    return reloadOnProject(demo.projectId, args.contractId ?? demo.phase.contractId);
  },

  /**
   * **The developer confirms the page map for this build** (journeys §7.5, the
   * second banked trap): the map is per phase and the staging site per project, so
   * an iteration's map is pre-filled and never trusted. `publishBuild` refuses
   * `PAGE_MAP_UNCONFIRMED` until it has been confirmed, and any later edit of the
   * map un-confirms the phase's unpublished builds (`clearPageMapConfirmation`).
   *
   * `builds.author` and the phase's developer. Refusals: `FORBIDDEN`, `NOT_FOUND`
   * (also a mockup build — not this surface's), `NOT_ASSIGNED`, `STEP_LOCKED`,
   * `ALREADY_PUBLISHED`, `NO_DEMO` (a phase with no site demo has no map).
   */
  confirmPageMap: async (_p: unknown, args: { buildId: string }, ctx: Context) => {
    requireCapability(ctx, 'builds.author');
    const build = await prisma.build.findUnique({ where: { id: args.buildId }, select: { id: true, kind: true, phaseId: true } });
    if (!build || build.kind !== 'SITE' || build.phaseId === null) throw notFound('build');
    const phaseId = build.phaseId;
    await requireBuildAuthorOnPhase(ctx, phaseId);

    await prisma.$transaction(async (tx) => {
      await openDemo(tx, phaseId);
      const fresh = await tx.build.findUniqueOrThrow({ where: { id: build.id }, select: { publishedAt: true } });
      if (fresh.publishedAt) throw refuse('ALREADY_PUBLISHED', 'This build is already published.');
      const demo = await tx.demo.findFirst({ where: { phaseId, kind: 'SITE' }, select: { id: true } });
      if (!demo) throw refuse('NO_DEMO', 'This phase has no demo, so there is no page map to confirm.');
      await tx.build.update({ where: { id: build.id }, data: { pageMapConfirmedAt: new Date() } });
    });
    return prisma.build.findUniqueOrThrow({ where: { id: build.id }, include: buildInclude });
  },
};

// --- publishing a site build ---------------------------------------------------------------

/**
 * **The SITE branch of `publishBuild`** (called by `builds.ts` once it has read the
 * build's kind and checked the developer's guards). Inside the contract's lock, in
 * this order: the demo step is open (`STEP_LOCKED`), the build is not already out
 * (`ALREADY_PUBLISHED`), **the page map was confirmed** (`PAGE_MAP_UNCONFIRMED` —
 * the trap that a phase-2 build whose map still points at phase-1 paths would show
 * the customer the wrong pages under the right labels), then **the allowance for
 * this phase** (`assertWithinAllowance` over `allowanceStateOn(DEMO, phase)`: the
 * iteration about to be published must fit, `ALLOWANCE_EXHAUSTED` — and sales is
 * told, as for a design round — until `extendAllowance` admits one more).
 *
 * Declaring costs nothing; publishing is what spends the allowance (the iteration
 * is what reached the customer, journeys §7.4). The count is the phase's published
 * SITE builds, and a legacy contract (no brief, so no allowance) is never refused.
 */
export async function publishSiteBuild(buildId: string) {
  const build = await prisma.build.findUniqueOrThrow({
    where: { id: buildId },
    include: { project: { include: { customer: true } }, phase: { select: { id: true, contractId: true } } },
  });
  const phase = build.phase;
  if (!phase) throw notFound('build');

  try {
    await prisma.$transaction(async (tx) => {
      await openDemo(tx, phase.id);
      const fresh = await tx.build.findUniqueOrThrow({ where: { id: build.id }, select: { publishedAt: true, pageMapConfirmedAt: true } });
      if (fresh.publishedAt) throw refuse('ALREADY_PUBLISHED', 'This build is already published.');
      if (!fresh.pageMapConfirmedAt) {
        throw refuse('PAGE_MAP_UNCONFIRMED', 'Confirm the page map for this build before publishing it.');
      }
      const before = await allowanceStateOn(tx, phase.contractId, 'DEMO', phase.id);
      assertWithinAllowance(before);
      await tx.build.update({ where: { id: build.id }, data: { publishedAt: new Date() } });
    });
  } catch (err) {
    const e = (err as { extensions?: { code?: string; used?: number; allowance?: number } }).extensions;
    if (e?.code === 'ALLOWANCE_EXHAUSTED' && typeof e.used === 'number' && typeof e.allowance === 'number') {
      await tellSalesAllowanceExhausted(phase.contractId, { used: e.used, allowance: e.allowance }, 'DEMO');
    }
    throw err;
  }

  const customer = build.project.customer;
  // The build's phase names its contract (J4): link the customer there when they
  // can open it (`linkContractId`).
  const contractId = await linkContractId(build.projectId, 'customer', phase.contractId);
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
}

// --- approval ---------------------------------------------------------------------------

/** A notification is best-effort: it must never fail the act that caused it. */
async function tell(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error('[demo] notification failed', err);
  }
}

/** The developer (`stepOwners`' rule: the assigned developer, and only when there
 *  is none — or they are disabled — everyone holding `answers.direct.demo`) and
 *  sales, once each however many hats they wear. */
async function tellDeveloperAndSalesOfApproval(contract: FullContract, phaseNumber: number) {
  await tell(async () => {
    const [developers, sales] = await Promise.all([stepOwners(contract, 'DEMO', false), recipientsHolding('contracts.author')]);
    const recipients = new Map<string, User>();
    for (const r of [...developers, ...sales]) recipients.set(r.id, r);
    await Promise.all(
      [...recipients.values()].map((r) =>
        notify(r, {
          kind: 'DEMO_APPROVED',
          params: {
            recipientName: r.name,
            customerName: contract.customer.name,
            projectTitleFa: contract.project.titleFa,
            projectTitleEn: contract.project.titleEn,
            phaseNumber,
            deskUrl: `${env.APP_ORIGIN}/${r.locale === 'en' ? 'en' : 'fa'}/desk/contracts/${contract.id}/phases`,
          },
        }),
      ),
    );
  });
}

/** What approving a phase accepts of the registry: the phase's items that were
 *  agreed and are not accepted yet. A `PROPOSED`, `DECLINED` or `TRADED` item is
 *  not part of the deal and stays exactly as it is; an item of another contract that
 *  was filed under this phase (the registry is the project's) is not this contract's
 *  to accept. */
const ACCEPTED_BY_APPROVAL = ['AGREED', 'IN_BUILD', 'IN_DEMO'] as const;

export const demoStepCustomerMutations = {
  /**
   * **Approving a phase's demo** — `approveStepTx(DEMO, phase)` in one transaction
   * under the contract's lock (**one approval writer**: S2's `approveStep` is gone,
   * as J8 and J9b stopped it approving the design and the mockup, so there is one
   * way to approve a phase). Refused while any note on that phase is unresolved or
   * an answer waits for sales (`STEP_HAS_OPEN_FEEDBACK`, `STEP_HAS_PENDING_ANSWERS`)
   * and, the step's own precondition, until the phase's site demo has been published
   * (`NO_PUBLISHED_DEMO`: a customer cannot approve what they have not been shown).
   *
   * **Effect: that phase's scope items become `ACCEPTED`** — the agreed ones, on this
   * phase, of this contract — in the same transaction as the lock, so the registry
   * and the approval cannot disagree. After it `declareBuild`, `publishBuild`, the
   * frame's edits and `submitFeedback` for the phase are `STEP_LOCKED`, and J13's
   * `PHASE_NOT_ACCEPTED` stops refusing the invoice tied to it (it reads the very row
   * this writes).
   *
   * The contract's own customer and nobody else (`NOT_FOUND` for staff, house rules 2
   * and 13); the new road only (`STEP_NOT_APPROVABLE` — a legacy phase is accepted
   * through its scope items). A phase that is not this contract's is
   * `STEP_NOT_ON_ROAD`. Tells the developer and sales.
   */
  approveDemo: async (_p: unknown, args: { contractId: string; phaseId: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.contractId, user);
    if (contract.customerId !== user.id) throw notFound('contract');
    if (contract.sequence !== 'AGREEMENT_FIRST') {
      throw refuse('STEP_NOT_APPROVABLE', 'That step cannot be approved this way.');
    }
    const road = computeWizard(await wizardStateOn(contract.id));
    if (!road.some((s) => s.step === 'DEMO' && s.phaseId === args.phaseId)) {
      throw refuse('STEP_NOT_ON_ROAD', 'This contract has no such step.');
    }
    const phase = await prisma.phase.findFirstOrThrow({ where: { id: args.phaseId, contractId: contract.id } });

    try {
      await prisma.$transaction(async (tx) => {
        await approveStepTx(tx, { contractId: contract.id, step: 'DEMO', phaseId: phase.id, approverId: user.id }, [
          async (inner) => {
            const shown = await inner.demo.count({ where: { phaseId: phase.id, kind: 'SITE', publishedAt: { not: null } } });
            if (shown === 0) throw refuse('NO_PUBLISHED_DEMO', 'There is no demo of this phase to approve yet.');
          },
        ]);
        await tx.scopeItem.updateMany({
          where: {
            phaseId: phase.id,
            projectId: contract.projectId,
            status: { in: [...ACCEPTED_BY_APPROVAL] },
            OR: [{ contractId: contract.id }, { contractId: null }],
          },
          data: { status: 'ACCEPTED' },
        });
      });
    } catch (err) {
      // Two approvals at once: the partial unique index on `StepApproval` refuses
      // the second — and the answer the caller should get is the lock.
      if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002') {
        throw refuse('STEP_LOCKED', 'That step is locked.');
      }
      throw err;
    }
    await tellDeveloperAndSalesOfApproval(contract, phase.number);
    return reload(contract.id);
  },
};

// --- fields ----------------------------------------------------------------------------

export const contractDemoFields = {
  /**
   * **The build timeline** (Q22): this contract's phases in order, each with its
   * published site builds and its dates (`lib/buildTimeline.ts`). What the customer
   * reads between the design's (or mockup's) approval and the first demo, and what
   * staff read to see what the customer has been shown. Published builds only, for
   * everyone: an unpublished build is a draft, and staff read those on the phase.
   * The planned end day follows the planned dates' rule (`mayReadPlannedDates`).
   */
  buildTimeline: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const [phases, approvals] = await Promise.all([
      prisma.phase.findMany({
        where: { contractId: c.id },
        select: {
          id: true,
          number: true,
          titleFa: true,
          titleEn: true,
          plannedEndAt: true,
          demos: { where: { kind: 'SITE', publishedAt: { not: null } }, select: { publishedAt: true } },
          builds: { where: { kind: 'SITE', publishedAt: { not: null } }, select: { id: true, number: true, publishedAt: true } },
        },
      }),
      prisma.stepApproval.findMany({ where: { contractId: c.id, step: 'DEMO' }, select: { phaseId: true, approvedAt: true } }),
    ]);
    const showDates = mayReadPlannedDates(viewer, true);
    return buildTimelineOf(
      phases.map((p) => ({
        id: p.id,
        number: p.number,
        titleFa: p.titleFa,
        titleEn: p.titleEn,
        plannedEndAt: showDates ? p.plannedEndAt : null,
        demoPublishedAts: p.demos.map((d) => d.publishedAt!),
        builds: p.builds.map((b) => ({ id: b.id, number: b.number, publishedAt: b.publishedAt! })),
      })),
      approvals,
    );
  },
};

/** What a demo says about its readiness, to staff only: when and by whom the claim
 *  was recorded. A customer is not told who verified a deployment. */
export const demoReadinessFields = {
  readyAt: (d: { readyAt: Date | null }, _a: unknown, ctx: Context) => (isContractReader(viewerOf(ctx)) ? d.readyAt : null),
  readyVerifiedBy: async (d: { readyVerifiedById: string | null }, _a: unknown, ctx: Context) =>
    d.readyVerifiedById && isContractReader(viewerOf(ctx))
      ? prisma.user.findUnique({ where: { id: d.readyVerifiedById } })
      : null,
};

/** A phase's site builds: staff read every one (drafts included — they are the
 *  developer's to publish); anyone else only the published, with the declarer's name
 *  and nothing else (`Build.changes` is staff's, `fields.ts`). Oldest first — the
 *  order the customer was shown them in. */
export const phaseDemoFields = {
  builds: async (p: { id: string }, _a: unknown, ctx: Context) => {
    const staff = isContractReader(viewerOf(ctx));
    return prisma.build.findMany({
      where: { phaseId: p.id, kind: 'SITE', ...(staff ? {} : { publishedAt: { not: null } }) },
      include: staff ? buildInclude : { declaredBy: true },
      orderBy: { number: 'asc' },
    });
  },
};

/** `Build.pageMapConfirmedAt` — staff's: the customer has no use for the developer's
 *  checklist. */
export const buildDemoFields = {
  pageMapConfirmedAt: (b: { pageMapConfirmedAt: Date | null }, _a: unknown, ctx: Context) =>
    isContractReader(viewerOf(ctx)) ? b.pageMapConfirmedAt : null,
};
