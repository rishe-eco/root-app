import { GraphQLError } from 'graphql';
import type { Prisma, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, viewerOf, type Context } from '../../context.js';
import { computeGate } from '../../lib/gate.js';
import { isPhaseAccepted } from '../../lib/phase.js';
import {
  assertStepOpen,
  computeWizard,
  legacyFinished,
  type WizardState,
} from '../../lib/steps.js';
import { attentionFor, type AttentionInput } from '../../lib/attention.js';
import { computeStatusSummary } from '../../lib/statusSummary.js';
import { timelineFor } from '../../lib/timeline.js';
import { checkInternalNote } from '../../lib/internalNotes.js';
import {
  isContractReader,
  mayReadInternalNotes,
  mayReadPlannedDates,
  requestVisibleTo,
} from '../../lib/visibility.js';
import { loadForActor, reload, type FullContract } from './contracts.js';
import { Contract as ContractFields } from './fields.js';
import { primaryContractId } from './admin/shared.js';

/**
 * The wizard's loader and its field resolvers (journeys build plan J3): one
 * loader, four derived views — `wizard`, `statusSummary`, `attention`,
 * `timeline` — plus the staff notes and `addInternalNote`. The rules are in
 * `lib/steps.ts`, `lib/attention.ts`, `lib/statusSummary.ts` and
 * `lib/timeline.ts`; this file only loads rows and hands them over, so every
 * later stage's extension point is named in one of those four headers.
 *
 * Spread into `Contract` in `resolvers/index.ts` (not into `fields.ts`, whose
 * `Contract.pending` this file reads — the dependency runs one way).
 *
 * **Every field asks `viewerOf(ctx)`** who is looking, never `requireUser`:
 * that is what makes view-as-customer the same rules seen through a different
 * viewer rather than a second implementation (`context.ts`).
 */

/**
 * Whose the project's phases, demos and builds are. **Until J4 puts
 * `Phase.contractId` on phases they belong to the project, not to a contract**
 * — and a project can hold several contracts since J2 — so this is a policy
 * and not a lookup: the project's **first** contract (`primaryContractId`,
 * the same answer every project-scoped mutation gave before J2) owns them, and
 * a second contract's road shows one placeholder demo with no phase. Without
 * it, a new-road contract added to a project mid-flight would inherit another
 * contract's demos as its own. J4 replaces this with the column.
 */
async function ownsProjectWork(contractId: string, projectId: string): Promise<boolean> {
  return (await primaryContractId(projectId)) === contractId;
}

type Facts = Awaited<ReturnType<typeof loadFacts>>;

async function loadFacts(c: FullContract) {
  const owns = await ownsProjectWork(c.id, c.projectId);
  const [approvals, phases, dependencies, builds, contractRevisions, designRevisions] = await Promise.all([
    prisma.stepApproval.findMany({
      where: { contractId: c.id },
      select: { id: true, step: true, phaseId: true, approvedAt: true, approvedById: true },
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
    }),
    owns
      ? prisma.phase.findMany({
          where: { projectId: c.projectId },
          orderBy: { number: 'asc' },
          select: {
            id: true,
            number: true,
            scopeItems: { select: { status: true } },
            demos: {
              where: { publishedAt: { not: null } },
              select: {
                id: true,
                feedbackItems: {
                  where: { status: 'ADDRESSED', addressedInBuild: { publishedAt: { not: null } } },
                  select: { id: true, addressedInBuild: { select: { publishedAt: true } } },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    prisma.dependency.findMany({
      where: { projectId: c.projectId },
      select: { id: true, side: true, titleFa: true, titleEn: true, dueAt: true, verifiedAt: true },
    }),
    owns
      ? prisma.build.findMany({
          where: { projectId: c.projectId, publishedAt: { not: null } },
          select: { id: true, number: true, publishedAt: true },
        })
      : Promise.resolve([]),
    prisma.contractRevision.findMany({
      where: { contractId: c.id, publishedAt: { not: null } },
      select: { id: true, version: true, publishedAt: true, approvedAt: true, signature: { select: { signedAt: true } } },
    }),
    prisma.designRevision.findMany({
      where: { contractId: c.id, publishedAt: { not: null } },
      select: { id: true, version: true, publishedAt: true },
    }),
  ]);
  return { approvals, phases, dependencies, builds, contractRevisions, designRevisions };
}

/** One load per contract per request: the four views share it. Keyed on the
 *  context, which is per request, so nothing outlives the operation. */
const factsCache = new WeakMap<Context, Map<string, Promise<Facts>>>();

function factsFor(ctx: Context, c: FullContract): Promise<Facts> {
  let perRequest = factsCache.get(ctx);
  if (!perRequest) factsCache.set(ctx, (perRequest = new Map()));
  let facts = perRequest.get(c.id);
  if (!facts) perRequest.set(c.id, (facts = loadFacts(c)));
  return facts;
}

/**
 * The rows → `WizardState`. **The one place a new-road step's "done" signal
 * is wired**: J4 pushes REQUIREMENTS when the brief is handed over, J5 SCOPE,
 * J6 DRAFT, J11 SUMMARY (see `lib/steps.ts`). Today only the legacy road has
 * any, read off the gate and the phases' scope items.
 */
function stateOf(c: FullContract, facts: Facts): WizardState {
  const gate = computeGate(c);
  return {
    sequence: c.sequence,
    designPath: null, // J8 (PD-13) derives it from the design tier
    phases: facts.phases.map((p) => ({ id: p.id, number: p.number })),
    approvals: facts.approvals,
    finished:
      c.sequence === 'DESIGN_FIRST'
        ? legacyFinished({
            designComplete: gate.designComplete,
            signed: gate.signed,
            signedAt: c.currentContractRevision?.signature?.signedAt ?? null,
            acceptedPhaseIds: facts.phases.filter((p) => isPhaseAccepted(p)).map((p) => p.id),
          })
        : [],
  };
}

async function loadAttentionInput(c: FullContract, facts: Facts, now: Date): Promise<AttentionInput> {
  const pending = await ContractFields.pending(c);
  const current = c.currentContractRevision;
  return {
    contractId: c.id,
    customerId: c.customerId,
    now,
    pending: pending
      ? {
          contract: pending.contractDiff
            ? {
                fromVersion: pending.contractDiff.fromVersion,
                toVersion: pending.contractDiff.toVersion,
                since: current?.publishedAt ?? now,
              }
            : null,
          designChangeCount: pending.designChanges.length,
          designSince: c.currentDesignRevision?.publishedAt ?? null,
          amendment: pending.amendment
            ? {
                ordinal: pending.amendment.ordinal,
                approved: pending.amendment.approvedAt !== null,
                since: pending.amendment.publishedAt ?? now,
              }
            : null,
        }
      : null,
    dependencies: facts.dependencies,
    addressed: facts.phases.flatMap((p) =>
      p.demos.flatMap((d) =>
        d.feedbackItems.map((f) => ({ id: f.id, phaseId: p.id, since: f.addressedInBuild!.publishedAt! })),
      ),
    ),
  };
}

/** `attention` and `statusSummary` (which counts what attention lists) both need
 *  this, and it includes `Contract.pending`'s own queries — so once per request. */
const inputCache = new WeakMap<Context, Map<string, Promise<AttentionInput>>>();

function attentionInputFor(ctx: Context, c: FullContract, facts: Facts): Promise<AttentionInput> {
  let perRequest = inputCache.get(ctx);
  if (!perRequest) inputCache.set(ctx, (perRequest = new Map()));
  let input = perRequest.get(c.id);
  if (!input) perRequest.set(c.id, (input = loadAttentionInput(c, facts, new Date())));
  return input;
}

const agreementApproved = (facts: Facts) => facts.approvals.some((a) => a.step === 'AGREEMENT' && a.phaseId === null);

export const contractWizardFields = {
  // The road is the same for every viewer — what differs is what is *on* it,
  // which is the panels' business (and the API's, field by field).
  wizard: async (c: FullContract, _a: unknown, ctx: Context) =>
    computeWizard(stateOf(c, await factsFor(ctx, c))),

  attention: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const facts = await factsFor(ctx, c);
    const items = attentionFor(await attentionInputFor(ctx, c, facts), viewer);
    return items.map((i) => ({
      ...i,
      params: Object.entries(i.params).map(([key, value]) => ({ key, value: String(value) })),
    }));
  },

  statusSummary: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const facts = await factsFor(ctx, c);
    const input = await attentionInputFor(ctx, c, facts);
    const now = input.now;
    const revision = c.currentContractRevision;
    const approval = facts.approvals.find((a) => a.step === 'AGREEMENT' && a.phaseId === null);
    return computeStatusSummary({
      now,
      sequence: c.sequence,
      wizard: computeWizard(stateOf(c, facts)),
      attention: attentionFor(input, viewer),
      // The agreement's approval on the new road, the signature on the old;
      // J7 makes the first the only one.
      signedAt: approval?.approvedAt ?? revision?.signature?.signedAt ?? null,
      plannedStartAt: mayReadPlannedDates(viewer, agreementApproved(facts)) ? c.plannedStartAt : null,
      plannedEndAt: mayReadPlannedDates(viewer, agreementApproved(facts)) ? c.plannedEndAt : null,
      // Every published row Root has shown the customer — the sources are
      // named in lib/statusSummary.ts's header.
      progressAt: [
        ...facts.builds.map((b) => b.publishedAt!),
        ...facts.contractRevisions.map((r) => r.publishedAt!),
        ...facts.designRevisions.map((r) => r.publishedAt!),
      ],
      facts: {
        designPublished: facts.designRevisions.length > 0,
        contractPublished: facts.contractRevisions.length > 0,
        publishedDemoPhaseIds: facts.phases.filter((p) => p.demos.length > 0).map((p) => p.id),
      },
    });
  },

  timeline: async (c: FullContract, _a: unknown, ctx: Context) => {
    const viewer = viewerOf(ctx);
    const facts = await factsFor(ctx, c);
    const phaseNumber = new Map(facts.phases.map((p) => [p.id, p.number]));
    return timelineFor({
      // The request is the sales conversation that preceded the contract — a
      // designer assigned to it does not read that (`requestVisibleTo`).
      requestedAt: requestVisibleTo(viewer, c.project) ? c.project.requestedAt : null,
      publishedAt: c.publishedAt,
      customerId: c.customerId,
      approvals: facts.approvals.map((a) => ({
        ...a,
        phaseNumber: a.phaseId ? (phaseNumber.get(a.phaseId) ?? null) : null,
      })),
      contractRevisions: facts.contractRevisions.map((r) => ({
        id: r.id,
        version: r.version,
        publishedAt: r.publishedAt!,
        approvedAt: r.approvedAt,
        signedAt: r.signature?.signedAt ?? null,
      })),
      designRevisions: facts.designRevisions.map((r) => ({ id: r.id, version: r.version, publishedAt: r.publishedAt! })),
      builds: facts.builds.map((b) => ({ id: b.id, number: b.number, publishedAt: b.publishedAt! })),
    });
  },

  /**
   * Root's private notes. **An empty list for anyone who may not read them —
   * never an error**, so a fragment shared with the portal cannot break the
   * customer's page (the plan's requirement), and never a note under view-as:
   * the viewer there is the customer.
   */
  internalNotes: async (c: FullContract, _a: unknown, ctx: Context) => {
    if (!mayReadInternalNotes(viewerOf(ctx), c)) return [];
    return prisma.internalNote.findMany({
      where: { contractId: c.id },
      include: { author: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  },
};

export const wizardMutations = {
  /**
   * A private note on a contract. `contracts.readActive` or `readAll` (any
   * staff reader — a designer's hand-over note to the developer is the case),
   * and the contract visible to them. Capability first (`FORBIDDEN`, so no id
   * leaks), then the ownership edge (`NOT_FOUND`, house rule 13). Sends no
   * notification: J3 adds none.
   */
  addInternalNote: async (_p: unknown, args: { contractId: string; body: string }, ctx: Context) => {
    const user = requireUser(ctx);
    if (!isContractReader(user)) {
      throw new GraphQLError('You do not have access to that.', { extensions: { code: 'FORBIDDEN' } });
    }
    const contract = await loadForActor(args.contractId, user);
    if (!mayReadInternalNotes(user, contract)) {
      throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
    }
    const refusal = checkInternalNote(args.body);
    if (refusal) {
      throw new GraphQLError(refusal === 'EMPTY_COMMENT' ? 'Write something first.' : 'That note is too long.', {
        extensions: { code: refusal },
      });
    }
    await prisma.internalNote.create({
      data: { contractId: contract.id, authorId: user.id, body: args.body.trim() },
    });
    return reload(contract.id);
  },
};

/**
 * `assertStepOpen` (lib/steps.ts) over the database: the call every mutation
 * that edits a step's content makes before it writes. **Nothing calls it yet.**
 *
 * The survey J3 made, so the stages that wire it need not repeat it: three
 * groups of existing mutations edit content a `StepApproval` will one day lock.
 * (1) the contract draft — `admin/contracts.ts`'s article, title, fee and
 * template edits, which are DRAFT (locked by AGREEMENT's approval, J7);
 * (2) the scope registry — `admin/registry.ts`'s item edits and trades, which
 * are SCOPE (likewise); (3) the design — all of `admin/design.ts`, which is
 * DESIGN (J8). No mutation writes a `StepApproval` before J7, so a call added
 * now could never fire — it would be dead code guarding a state that cannot
 * exist. Each of those stages adds its calls in the same commit as the
 * approval that makes them reachable.
 *
 * Takes a transaction client so the check and the write share a snapshot.
 */
export async function assertStepOpenOn(
  contractId: string,
  step: StepKind,
  phaseId: string | null = null,
  db: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<void> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: {
      sequence: true,
      projectId: true,
      stepApprovals: { select: { step: true, phaseId: true, approvedAt: true } },
    },
  });
  if (!contract) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  const phases =
    (await ownsProjectWork(contractId, contract.projectId))
      ? await db.phase.findMany({ where: { projectId: contract.projectId }, select: { id: true, number: true } })
      : [];
  assertStepOpen(
    { sequence: contract.sequence, designPath: null, phases, approvals: contract.stepApprovals, finished: [] },
    step,
    phaseId,
  );
}
