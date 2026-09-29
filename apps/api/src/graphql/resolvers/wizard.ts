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
  type Finished,
  type WizardState,
} from '../../lib/steps.js';
import {
  briefCompleteness,
  isCommitmentKey,
  isIncludedExtra,
  type BriefMissing,
  type CommitmentKey,
} from '../../lib/brief.js';
import { attentionFor, type AttentionInput, type FeedbackFacts } from '../../lib/attention.js';
import { isMoneyAnchored } from '../../lib/feedbackRules.js';
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

type Facts = Awaited<ReturnType<typeof loadFacts>>;

async function loadFacts(c: FullContract) {
  // **Phases, demos and builds are this contract's own** (J4, PD-5): a phase
  // names its contract, and a build and a demo are its phase's. Until J4 this
  // was a policy — the project's first contract owned them all — and a second
  // contract's road showed a placeholder; now each contract's road has exactly
  // the phases it delivers.
  const [approvals, phases, dependencies, builds, contractRevisions, designRevisions, feedback, brief, plan, sensitiveArticles] =
    await Promise.all([
    prisma.stepApproval.findMany({
      where: { contractId: c.id },
      select: { id: true, step: true, phaseId: true, approvedAt: true, approvedById: true },
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.phase.findMany({
      where: { contractId: c.id },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        number: true,
        plannedEndAt: true,
        scopeItems: { select: { status: true } },
        demos: {
          where: { publishedAt: { not: null } },
          select: { id: true },
        },
      },
    }),
    prisma.dependency.findMany({
      where: { projectId: c.projectId },
      select: { id: true, side: true, titleFa: true, titleEn: true, dueAt: true, verifiedAt: true, briefKey: true },
    }),
    prisma.build.findMany({
      where: { projectId: c.projectId, phase: { contractId: c.id }, publishedAt: { not: null } },
      select: { id: true, number: true, publishedAt: true },
    }),
    prisma.contractRevision.findMany({
      where: { contractId: c.id, publishedAt: { not: null } },
      select: { id: true, version: true, publishedAt: true, approvedAt: true, signature: { select: { signedAt: true } } },
    }),
    prisma.designRevision.findMany({
      where: { contractId: c.id, publishedAt: { not: null } },
      select: { id: true, version: true, publishedAt: true },
    }),
    // Every step's feedback (S2), with just enough of each thread to say when
    // the customer last spoke and when an answer reached them. Items only
    // matter until the step is accepted, so an accepted one is not loaded.
    prisma.feedbackItem.findMany({
      where: { contractId: c.id, status: { not: 'ACCEPTED' } },
      select: {
        id: true,
        step: true,
        phaseId: true,
        status: true,
        briefField: true,
        articleNumber: true,
        updatedAt: true,
        createdAt: true,
        addressedInBuild: { select: { publishedAt: true } },
        comments: {
          select: { authorId: true, createdAt: true, approval: true, approvedAt: true, resolution: true },
        },
      },
    }),
    // Step 1's own rows (J4): the brief and the payment plan's amounts feed
    // `briefCompleteness`, which is REQUIREMENTS' done signal — and the
    // sensitive articles decide which DRAFT notes are about money (PD-21).
    prisma.contractBrief.findUnique({ where: { contractId: c.id } }),
    prisma.paymentPlan.findUnique({ where: { contractId: c.id }, select: { invoices: { select: { amount: true } } } }),
    prisma.article.findMany({ where: { contractId: c.id, sensitive: true }, select: { number: true } }),
  ]);
  return { approvals, phases, dependencies, builds, contractRevisions, designRevisions, feedback, brief, plan, sensitiveArticles };
}

/** The steps' own checklist extras that are in scope — `AGREED` or beyond
 *  (`INCLUDED_EXTRA_STATUSES`). Off `c.project.scopeItems`, already loaded. */
const includedExtraKeys = (c: FullContract): string[] =>
  c.project.scopeItems.filter((s) => s.kind === 'EXTRA' && isIncludedExtra(s.status)).map((s) => s.key);

/** Step 1's missing list (`lib/brief.ts`), from the loaded facts — one
 *  computation for the wizard's REQUIREMENTS signal and the `briefCompleteness`
 *  field, so the step cannot be "done" on one screen and incomplete on the other. */
function briefMissing(c: FullContract, facts: Facts): BriefMissing[] {
  const commitmentDates: Partial<Record<CommitmentKey, Date>> = {};
  for (const d of facts.dependencies) {
    if (d.briefKey && isCommitmentKey(d.briefKey)) commitmentDates[d.briefKey] = d.dueAt;
  }
  return briefCompleteness({
    brief: facts.brief,
    commitmentDates,
    includedExtraKeys: includedExtraKeys(c),
    phases: facts.phases,
    plan: facts.plan ? { invoiceAmounts: facts.plan.invoices.map((i) => i.amount) } : null,
    fee: c.amount,
  });
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
 * is wired**: REQUIREMENTS is done when `briefCompleteness` has nothing left
 * to name (J4 — the brief is complete, not merely handed over: a half-filled
 * brief the customer can already read is still Root's to finish), J5 pushes
 * SCOPE, J6 DRAFT, J11 SUMMARY (see `lib/steps.ts`). The legacy road's are read
 * off the gate and the phases' scope items.
 */
function stateOf(c: FullContract, facts: Facts): WizardState {
  const gate = computeGate(c);
  const finished: Finished[] =
    c.sequence === 'DESIGN_FIRST'
      ? legacyFinished({
          designComplete: gate.designComplete,
          signed: gate.signed,
          signedAt: c.currentContractRevision?.signature?.signedAt ?? null,
          acceptedPhaseIds: facts.phases.filter((p) => isPhaseAccepted(p)).map((p) => p.id),
        })
      : [];
  if (c.sequence === 'AGREEMENT_FIRST' && facts.brief && briefMissing(c, facts).length === 0) {
    finished.push({ step: 'REQUIREMENTS', phaseId: null, at: facts.brief.updatedAt });
  }
  return {
    sequence: c.sequence,
    designPath: null, // J8 (PD-13) derives it from the design tier
    phases: facts.phases.map((p) => ({ id: p.id, number: p.number })),
    approvals: facts.approvals,
    finished,
  };
}

/**
 * The rows → the three lists attention groups (`lib/attention.ts`). One rule
 * per list, in one place: an item that is `OPEN` is Root's to answer; a
 * comment that is `PENDING` is sales'; an item Root has resolved and the step's
 * approval has not yet accepted is the customer's move — unless it was
 * addressed in a build the customer has not been told about yet (the build's
 * publish is when the customer learns of it, as L3b decided).
 */
function feedbackFacts(customerId: string, items: Facts['feedback'], sensitiveArticles: ReadonlySet<number>): FeedbackFacts {
  const out: FeedbackFacts = { unresolved: [], pendingApproval: [], answered: [] };
  for (const item of items) {
    const articleSensitive = item.articleNumber !== null && sensitiveArticles.has(item.articleNumber);
    const fact = { step: item.step, phaseId: item.phaseId, money: isMoneyAnchored({ ...item, articleSensitive }) };

    for (const c of item.comments) {
      if (c.approval === 'PENDING') out.pendingApproval.push({ ...fact, since: c.createdAt });
    }

    if (item.status === 'OPEN') {
      const theirs = item.comments.filter((c) => c.authorId === customerId).map((c) => c.createdAt.getTime());
      out.unresolved.push({ ...fact, since: new Date(theirs.length > 0 ? Math.max(...theirs) : item.createdAt.getTime()) });
      continue;
    }

    if (item.addressedInBuild) {
      if (item.addressedInBuild.publishedAt) out.answered.push({ ...fact, since: item.addressedInBuild.publishedAt });
      continue;
    }
    // Resolved by an answer that reached the customer — or MOVED, which is
    // not an answer at all: the item's own last change is when it happened.
    const reached = item.comments
      .filter((c) => c.resolution !== null && (c.approval === 'NOT_REQUIRED' || c.approval === 'APPROVED'))
      .map((c) => (c.approvedAt ?? c.createdAt).getTime());
    out.answered.push({ ...fact, since: new Date(reached.length > 0 ? Math.max(...reached) : item.updatedAt.getTime()) });
  }
  return out;
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
    feedback: feedbackFacts(c.customerId, facts.feedback, new Set(facts.sensitiveArticles.map((a) => a.number))),
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

  /**
   * What step 1 still lacks (`lib/brief.ts`), as codes — for the desk's "still
   * missing" list and the portal's "Root is completing this". Empty means the
   * step is done, which is the same computation that marks REQUIREMENTS done.
   * A code names *that* something is missing, never what it should be: nothing
   * here carries a money value (PD-14).
   */
  briefCompleteness: async (c: FullContract, _a: unknown, ctx: Context) => briefMissing(c, await factsFor(ctx, c)),

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
 * that edits a step's content makes before it writes. **S2's feedback
 * mutations call it** (submit, answer, approve and decline an answer — staff
 * cannot answer on a locked step either, journeys §3.1) **and J4's step-1
 * writes** (`setBrief`, `setExtra`, `setPaymentPlan`, and the phase edits, all
 * REQUIREMENTS), each after `lockContract` where it writes. Nothing can lock
 * REQUIREMENTS until J7 writes the AGREEMENT approval, so those calls cannot
 * fire yet — they land now so J7 changes nothing here. The rest are still to
 * wire.
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
  assertStepOpen(await wizardStateOn(contractId, db), step, phaseId);
}

/**
 * A contract's `WizardState` as far as locks are concerned — its sequence,
 * the phases it owns (`Phase.contractId`) and its `StepApproval` rows, with no
 * "finished" signals (a lock does not depend on them). What `assertStepOpenOn`
 * and `approveStep` (which needs to know that a step is on this contract's
 * road before it approves it) both read, so the two cannot disagree.
 */
export async function wizardStateOn(
  contractId: string,
  db: typeof prisma | Prisma.TransactionClient = prisma,
): Promise<WizardState> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: {
      sequence: true,
      stepApprovals: { select: { step: true, phaseId: true, approvedAt: true } },
    },
  });
  if (!contract) {
    throw new GraphQLError('No such contract.', { extensions: { code: 'NOT_FOUND' } });
  }
  const phases = await db.phase.findMany({ where: { contractId }, select: { id: true, number: true } });
  return { sequence: contract.sequence, designPath: null, phases, approvals: contract.stepApprovals, finished: [] };
}
