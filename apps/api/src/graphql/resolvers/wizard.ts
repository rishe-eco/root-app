import { GraphQLError } from 'graphql';
import type { ContractSequence, Prisma, ScopeKind, ScopeStatus, StepKind } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, viewerOf, type Context } from '../../context.js';
import { computeGate } from '../../lib/gate.js';
import { isPhaseAccepted } from '../../lib/phase.js';
import { canIssuePlanned, firstInvoicePaidAt } from '../../lib/invoice.js';
import {
  agreementSignedAt,
  assertStepOpen,
  computeWizard,
  currentStepOf,
  designPathOf,
  legacyFinished,
  type Finished,
  type WizardState,
  type WizardStep,
} from '../../lib/steps.js';
import { allowanceFor } from '../../lib/allowance.js';
import {
  briefCompleteness,
  isCommitmentKey,
  isIncludedExtra,
  type BriefMissing,
  type CommitmentKey,
} from '../../lib/brief.js';
import {
  attentionFor,
  type AttentionInput,
  type FeedbackFacts,
  type PendingFacts,
  type StepFacts,
} from '../../lib/attention.js';
import { scopeStepDone } from '../../lib/scopeProposals.js';
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
import { Contract as ContractFields, pendingOf } from './fields.js';

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
 *
 * **The loader is batched (J12).** `loadFactsMany` reads the rows of any number
 * of contracts in one round of `IN` queries and groups them in memory; the
 * single-contract path every field resolver takes is `loadFactsMany([c])`, so
 * the home screen's "every contract a sales user can see" and the contract page
 * run *the same loader* — there is no second set of queries to drift. What a
 * home screen costs is stated in `resolvers/home.ts`.
 */

/**
 * What the loader and the wizard's rules read of a contract. Structural, so a
 * `FullContract` satisfies it and so does the lean select the home screen makes
 * (it must not drag every contract's comments, change log and articles along to
 * learn which step it is on).
 */
export type WizardContract = {
  id: string;
  projectId: string;
  customerId: string;
  sequence: ContractSequence;
  amount: bigint | null;
  deliveredAt: Date | null;
  createdAt: Date;
  publishedAt: Date | null;
  currentContractRevision: {
    version: number;
    approvedAt: Date | null;
    contentHash: string | null;
    publishedAt: Date | null;
    signature: { signedAt: Date } | null;
  } | null;
  currentDesignRevision: {
    publishedAt: Date | null;
    concepts: Array<{ chosenAt: Date | null; pages: Array<{ approvedAt: Date | null }> }>;
  } | null;
  project: {
    scopeItems: Array<{ kind: ScopeKind; contractId: string | null; originAskedAt: Date; status: ScopeStatus; key: string }>;
  };
};

/** Keyed rows → a list per key, in the rows' own order (the queries order them). */
function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k === null) continue;
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

export type Facts = ReturnType<typeof factsOf>;
type Rows = Awaited<ReturnType<typeof fetchRows>>;

/**
 * Every fact the wizard's views read, for any number of contracts: fifteen
 * `IN` queries (plus the relations nested in three of them), *not* fifteen per
 * contract. Rows come back keyed; `factsOf` hands each contract its own.
 */
async function fetchRows(contractIds: string[], projectIds: string[]) {
  const inContracts = { in: contractIds };
  return Promise.all([
    prisma.stepApproval.findMany({
      where: { contractId: inContracts },
      select: { id: true, contractId: true, step: true, phaseId: true, approvedAt: true, approvedById: true },
      orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
    }),
    // **Phases, demos and builds are this contract's own** (J4, PD-5): a phase
    // names its contract, and a build and a demo are its phase's. Every demo
    // of the phase is read (J12 — readiness and "out for review" both need to
    // tell a published one from one still being prepared); the consumers that
    // used to see only published ones filter.
    prisma.phase.findMany({
      where: { contractId: inContracts },
      orderBy: { number: 'asc' },
      select: {
        id: true,
        contractId: true,
        number: true,
        plannedEndAt: true,
        scopeItems: { select: { status: true } },
        demos: { select: { id: true, publishedAt: true, readyAt: true, stagingUrl: true, updatedAt: true } },
      },
    }),
    prisma.dependency.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, projectId: true, side: true, titleFa: true, titleEn: true, dueAt: true, verifiedAt: true, briefKey: true, technical: true },
    }),
    prisma.build.findMany({
      where: { phase: { contractId: inContracts }, publishedAt: { not: null } },
      select: { id: true, number: true, publishedAt: true, phaseId: true, phase: { select: { contractId: true } } },
    }),
    // The mockup's published iterations (J9b): a mockup build has no phase, so it
    // is this contract's through its demo. Oldest first — the position in this
    // list is the iteration's ordinal ("mockup 2"), which is not the build's
    // number whenever a declared draft was never published.
    prisma.build.findMany({
      where: { kind: 'MOCKUP', demo: { contractId: inContracts }, publishedAt: { not: null } },
      select: { id: true, publishedAt: true, demo: { select: { contractId: true } } },
      orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.contractRevision.findMany({
      where: { contractId: inContracts, publishedAt: { not: null } },
      select: { id: true, contractId: true, version: true, publishedAt: true, approvedAt: true, signature: { select: { signedAt: true } } },
    }),
    prisma.designRevision.findMany({
      where: { contractId: inContracts, publishedAt: { not: null } },
      select: { id: true, contractId: true, version: true, publishedAt: true },
    }),
    // Every step's feedback (S2), with just enough of each thread to say when
    // the customer last spoke and when an answer reached them. Items only
    // matter until the step is accepted, so an accepted one is not loaded.
    prisma.feedbackItem.findMany({
      where: { contractId: inContracts, status: { not: 'ACCEPTED' } },
      select: {
        id: true,
        contractId: true,
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
    prisma.contractBrief.findMany({ where: { contractId: inContracts } }),
    // The plan's rows with what became of each (J13): `briefCompleteness` reads
    // the amounts; "started" reads whether the first row's invoice is paid; J12's
    // `INVOICE_ISSUABLE` reads the plan rule over them.
    prisma.paymentPlan.findMany({
      where: { contractId: inContracts },
      select: {
        contractId: true,
        invoices: {
          orderBy: { ordinal: 'asc' },
          select: { id: true, ordinal: true, phaseId: true, amount: true, billingEntry: { select: { issuedAt: true, paidAt: true } } },
        },
      },
    }),
    prisma.article.findMany({ where: { contractId: inContracts, sensitive: true }, select: { contractId: true, number: true } }),
    // Step 2a's own rows (J5): the customer's proposals — SCOPE's done signal
    // and the attention module's "Root has proposals to decide" — and the scope
    // trades still open on this contract's agreement (`TRADE_TO_CONFIRM`). A
    // trade belongs to the contract that agreed its outgoing item (T1), which
    // is the document it amends.
    prisma.scopeProposal.findMany({
      where: { contractId: inContracts },
      select: { contractId: true, decidedAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.scopeTrade.findMany({
      where: { projectId: { in: projectIds }, executedAt: null, outItem: { contractId: inContracts } },
      select: { id: true, proposedAt: true, rootConfirmedAt: true, customerConfirmedAt: true, outItem: { select: { contractId: true } } },
      orderBy: { proposedAt: 'asc' },
    }),
    // Issued and unpaid, with the due day: the status area's overdue invoices
    // (J13) and J12's "due" lines. Nothing here is money the viewer may read
    // until `attentionVisibleTo` says so — it is dates, a number and an id.
    prisma.billingEntry.findMany({
      where: { contractId: inContracts, issuedAt: { not: null }, paidAt: null },
      select: { id: true, contractId: true, invoiceNumber: true, issuedAt: true, dueAt: true, paidAt: true },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    }),
    // The rounds sales has granted beyond the brief (J8), which the step counters read.
    prisma.allowanceExtension.findMany({ where: { contractId: inContracts }, select: { contractId: true, step: true, phaseId: true, extra: true } }),
  ]);
}

/** One contract's slice of the batched rows. */
function factsOf(c: { id: string; projectId: string }, grouped: ReturnType<typeof groupRows>) {
  const mine = <T>(m: Map<string, T[]>) => m.get(c.id) ?? [];
  return {
    approvals: mine(grouped.approvals),
    phases: mine(grouped.phases),
    dependencies: grouped.dependencies.get(c.projectId) ?? [],
    builds: mine(grouped.builds),
    mockupBuilds: mine(grouped.mockupBuilds),
    contractRevisions: mine(grouped.contractRevisions),
    designRevisions: mine(grouped.designRevisions),
    feedback: mine(grouped.feedback),
    brief: grouped.briefs.get(c.id) ?? null,
    plan: grouped.plans.get(c.id) ?? null,
    sensitiveArticles: mine(grouped.sensitiveArticles),
    scopeProposals: mine(grouped.scopeProposals),
    scopeTrades: mine(grouped.scopeTrades),
    invoices: mine(grouped.invoices),
    allowanceExtensions: mine(grouped.allowanceExtensions),
  };
}

function groupRows(rows: Rows) {
  const [
    approvals,
    phases,
    dependencies,
    builds,
    mockupBuilds,
    contractRevisions,
    designRevisions,
    feedback,
    briefs,
    plans,
    sensitiveArticles,
    scopeProposals,
    scopeTrades,
    invoices,
    allowanceExtensions,
  ] = rows;
  return {
    approvals: groupBy(approvals, (r) => r.contractId),
    phases: groupBy(phases, (r) => r.contractId),
    dependencies: groupBy(dependencies, (r) => r.projectId),
    builds: groupBy(builds, (r) => r.phase?.contractId ?? null),
    mockupBuilds: groupBy(mockupBuilds, (r) => r.demo?.contractId ?? null),
    contractRevisions: groupBy(contractRevisions, (r) => r.contractId),
    designRevisions: groupBy(designRevisions, (r) => r.contractId),
    feedback: groupBy(feedback, (r) => r.contractId),
    briefs: new Map(briefs.map((b) => [b.contractId, b] as const)),
    plans: new Map(plans.map((p) => [p.contractId, p] as const)),
    sensitiveArticles: groupBy(sensitiveArticles, (r) => r.contractId),
    scopeProposals: groupBy(scopeProposals, (r) => r.contractId),
    scopeTrades: groupBy(scopeTrades, (r) => r.outItem.contractId),
    invoices: groupBy(invoices, (r) => r.contractId),
    allowanceExtensions: groupBy(allowanceExtensions, (r) => r.contractId),
  };
}

/**
 * The facts for a list of contracts, keyed by contract id. Fifteen queries
 * whatever the length of the list (`fetchRows`).
 */
export async function loadFactsMany(cs: ReadonlyArray<{ id: string; projectId: string }>): Promise<Map<string, Facts>> {
  if (cs.length === 0) return new Map();
  const rows = await fetchRows(
    cs.map((c) => c.id),
    [...new Set(cs.map((c) => c.projectId))],
  );
  const grouped = groupRows(rows);
  return new Map(cs.map((c) => [c.id, factsOf(c, grouped)] as const));
}

async function loadFacts(c: { id: string; projectId: string }): Promise<Facts> {
  return (await loadFactsMany([c])).get(c.id)!;
}

/** The steps' own checklist extras that are in scope — `AGREED` or beyond
 *  (`INCLUDED_EXTRA_STATUSES`). Off `c.project.scopeItems`, already loaded. */
const includedExtraKeys = (c: WizardContract): string[] =>
  c.project.scopeItems.filter((s) => s.kind === 'EXTRA' && isIncludedExtra(s.status)).map((s) => s.key);

/** Step 1's missing list (`lib/brief.ts`), from the loaded facts — one
 *  computation for the wizard's REQUIREMENTS signal and the `briefCompleteness`
 *  field, so the step cannot be "done" on one screen and incomplete on the other. */
function briefMissing(c: WizardContract, facts: Facts): BriefMissing[] {
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

/**
 * `briefMissing` for a caller outside the field resolvers — `publishContractRevision`'s
 * `BRIEF_INCOMPLETE` gate (J6). The same function the wizard's REQUIREMENTS
 * signal and `Contract.briefCompleteness` call, over the same facts, so the
 * gate refuses exactly when the step says it is not done.
 */
export async function briefIncompleteOn(c: FullContract): Promise<BriefMissing[]> {
  return briefMissing(c, await loadFacts(c));
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

/** Whether a phase has a demo the customer can open. */
const phaseDemoOut = (p: Facts['phases'][number]) => p.demos.some((d) => d.publishedAt !== null);

/**
 * The rows → `WizardState`. **The one place a new-road step's "done" signal
 * is wired**: REQUIREMENTS is done when `briefCompleteness` has nothing left
 * to name (J4 — the brief is complete, not merely handed over: a half-filled
 * brief the customer can already read is still Root's to finish), SCOPE (J5) is
 * done when the contract has a scope of its own and no proposal is waiting for
 * Root, DRAFT (J6) when a revision is published and no note on it is waiting for
 * Root, J11 pushes SUMMARY (see `lib/steps.ts`). The legacy road's are read off
 * the gate and the phases' scope items.
 */
export function stateOf(c: WizardContract, facts: Facts): WizardState {
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
  if (c.sequence === 'AGREEMENT_FIRST') {
    // SCOPE (J5): the contract has a scope of its own and nothing the customer
    // proposed is waiting for Root — `scopeStepDone`, the same function the
    // draft's publish gate asks. `at` is when the last thing that settled it
    // happened: the last decision, or the scope's own creation.
    const own = c.project.scopeItems.filter((s) => s.kind !== 'EXTRA' && s.contractId === c.id);
    if (scopeStepDone({ items: c.project.scopeItems, proposals: facts.scopeProposals, contractId: c.id })) {
      const decided = facts.scopeProposals.map((p) => p.decidedAt!.getTime());
      const seeded = own.map((s) => s.originAskedAt.getTime());
      finished.push({ step: 'SCOPE', phaseId: null, at: new Date(Math.max(...decided, ...seeded)) });
    }
    // DRAFT (J6): a revision has been published and no note on it is waiting
    // for Root. Notes Root has answered do not hold the step open — approval
    // (J7) is what requires them *accepted*; "done" here is Root's half.
    const openNote = facts.feedback.some((i) => i.step === 'DRAFT' && i.status === 'OPEN');
    if (facts.contractRevisions.length > 0 && !openNote) {
      const latest = Math.max(...facts.contractRevisions.map((r) => r.publishedAt!.getTime()));
      finished.push({ step: 'DRAFT', phaseId: null, at: new Date(latest) });
    }
    // AGREEMENT (J7) is done when it is *signed* — the current revision's
    // signature, `agreementSignedAt`'s one rule. Its lock is the approval, which
    // arrives in `facts.approvals`; between the two the step is locked and still
    // current, and the status area says so.
    const signedAt = agreementSignedAt({ signatureSignedAt: c.currentContractRevision?.signature?.signedAt ?? null });
    if (signedAt) finished.push({ step: 'AGREEMENT', phaseId: null, at: signedAt });
    // SUMMARY (J11) is done when sales has closed the contract — `deliveredAt`,
    // which `closeContract` writes and nothing else does. It is never *locked*
    // (it takes no input: `takesInput` is false), so this is its only signal, and
    // until then it is the current step only once every step before it is done.
    if (c.deliveredAt) finished.push({ step: 'SUMMARY', phaseId: null, at: c.deliveredAt });
  }
  // The design path is the brief's tier through `designPathOf` (J8, PD-13); the
  // legacy road has none. The design step's rounds are the published design
  // revisions against the brief's allowance and any extension; the mockup's (J9b)
  // are its published iterations against `mockupIterations`. A demo's are J10's
  // and are simply not listed.
  const newRoad = c.sequence === 'AGREEMENT_FIRST';
  return {
    sequence: c.sequence,
    designPath: newRoad && facts.brief ? designPathOf(facts.brief.designTier) : null,
    phases: facts.phases.map((p) => ({ id: p.id, number: p.number })),
    approvals: facts.approvals,
    finished,
    iterations: newRoad
      ? [
          {
            step: 'DESIGN',
            phaseId: null,
            used: facts.designRevisions.length,
            allowance: allowanceFor('DESIGN', null, facts.brief, facts.allowanceExtensions),
          },
          {
            step: 'MOCKUP',
            phaseId: null,
            used: facts.mockupBuilds.length,
            allowance: allowanceFor('MOCKUP', null, facts.brief, facts.allowanceExtensions),
          },
          // J10: a phase's demo rounds are its published site builds, against
          // `demoIterationsPerPhase` and that phase's extensions (Q-S6).
          ...facts.phases.map((p) => ({
            step: 'DEMO' as const,
            phaseId: p.id,
            used: facts.builds.filter((b) => b.phaseId === p.id).length,
            allowance: allowanceFor('DEMO', p.id, facts.brief, facts.allowanceExtensions),
          })),
        ]
      : [],
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

const latest = (...dates: Array<Date | null | undefined>): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (a === null || d > a) ? d : a), null);

/**
 * Steps 4–6 as attention facts (J12; `lib/attention.ts` words them). The
 * membership rules live here, beside the wizard they read:
 *
 * - **waiting** — the wizard's *current* step is the design, the mockup or a
 *   phase's demo and nothing has been shown for it: the step's owner's move.
 *   `since` is when the road reached it, so the line ages from the right day.
 * - **out for review** — a mockup iteration or a phase's demo is published, the
 *   step is not locked (not approved) and nothing on it waits for Root or has
 *   just been answered. A note open — or one whose fate is written in a build
 *   the customer has not been shown yet — means the ball is Root's, as
 *   `nextMoveOn` already says for the design; and an answer that has reached
 *   them (`ANSWER_PUBLISHED`) already says "read it, or approve the step", so a
 *   second line saying the same thing is left out.
 * - **not ready** — a phase's staging site has a URL and no demo of the phase
 *   is published, and no browser of Root's has seen the site report (J10's
 *   `readyAt`). A phase already accepted has nothing left to ready.
 */
function stepFacts(c: WizardContract, facts: Facts, wizard: WizardStep[], feedback: FeedbackFacts): StepFacts {
  const out: StepFacts = { waiting: [], mockupOut: null, demosOut: [], demosNotReady: [] };
  const stepOf = (step: StepKind, phaseId: string | null) => wizard.find((s) => s.step === step && s.phaseId === phaseId);
  const here = (step: StepKind, phaseId: string | null) => (i: { step: StepKind; phaseId: string | null }) =>
    i.step === step && (step !== 'DEMO' || i.phaseId === phaseId);
  // The ball is Root's while a note is open, or while its fate is declared in a build that has not been published.
  const owed = (step: StepKind, phaseId: string | null = null) =>
    facts.feedback.some((i) => here(step, phaseId)(i) && (i.status === 'OPEN' || (i.addressedInBuild !== null && i.addressedInBuild.publishedAt === null)));
  const answered = (step: StepKind, phaseId: string | null = null) => feedback.answered.some(here(step, phaseId));
  const openNote = (step: StepKind, phaseId: string | null = null) => owed(step, phaseId) || answered(step, phaseId);

  const current = currentStepOf(wizard);
  if (current) {
    const index = wizard.indexOf(current);
    const previous = index > 0 ? wizard[index - 1] : null;
    const since = previous?.finishedAt ?? previous?.lockedAt ?? c.publishedAt ?? c.createdAt;
    if (current.step === 'DESIGN' && facts.designRevisions.length === 0) {
      out.waiting.push({ step: 'DESIGN', phaseId: null, phaseNumber: null, since });
    } else if (current.step === 'MOCKUP' && facts.mockupBuilds.length === 0) {
      out.waiting.push({ step: 'MOCKUP', phaseId: null, phaseNumber: null, since });
    } else if (current.step === 'DEMO' && current.phaseId !== null) {
      const phase = facts.phases.find((p) => p.id === current.phaseId);
      if (phase && !phaseDemoOut(phase)) {
        out.waiting.push({ step: 'DEMO', phaseId: phase.id, phaseNumber: phase.number, since });
      }
    }
  }

  const mockup = stepOf('MOCKUP', null);
  if (mockup && !mockup.locked && facts.mockupBuilds.length > 0 && !openNote('MOCKUP')) {
    out.mockupOut = {
      count: facts.mockupBuilds.length,
      since: latest(...facts.mockupBuilds.map((b) => b.publishedAt))!,
    };
  }

  for (const phase of facts.phases) {
    const demo = stepOf('DEMO', phase.id);
    // DONE, not `locked`: a legacy contract has no approval rows and its phase is
    // accepted by its scope items (`isPhaseAccepted`), which `computeWizard` reads
    // through `legacyFinished`.
    if (!demo || demo.status === 'DONE') continue;
    if (phaseDemoOut(phase)) {
      if (!openNote('DEMO', phase.id)) {
        const builds = facts.builds.filter((b) => b.phaseId === phase.id).map((b) => b.publishedAt);
        out.demosOut.push({
          phaseId: phase.id,
          phaseNumber: phase.number,
          since: latest(...builds, ...phase.demos.map((d) => d.publishedAt))!,
        });
      }
    } else {
      const unready = phase.demos.filter((d) => d.stagingUrl !== null && d.readyAt === null);
      if (unready.length > 0) {
        out.demosNotReady.push({ phaseId: phase.id, phaseNumber: phase.number, since: latest(...unready.map((d) => d.updatedAt))! });
      }
    }
  }
  return out;
}

/**
 * The planned invoices the plan rule lets sales issue right now (J13's
 * `canIssuePlanned`, asked of every row) with the day each became issuable: the
 * latest of the signature, the previous row's payment and the phase's approval.
 */
function issuableFacts(c: WizardContract, facts: Facts): Array<{ ordinal: number; since: Date }> {
  if (!facts.plan || facts.plan.invoices.length === 0) return [];
  const rows = facts.plan.invoices.map((i) => ({ id: i.id, ordinal: i.ordinal, phaseId: i.phaseId }));
  const entries = facts.plan.invoices.flatMap((r) => (r.billingEntry ? [{ plannedInvoiceId: r.id, ...r.billingEntry }] : []));
  const signedAt = agreementSignedAt({ signatureSignedAt: c.currentContractRevision?.signature?.signedAt ?? null });
  const out: Array<{ ordinal: number; since: Date }> = [];
  rows.forEach((row, index) => {
    if (!canIssuePlanned(rows, index, entries, facts.approvals, signedAt !== null).ok) return;
    const previous = index > 0 ? entries.find((e) => e.plannedInvoiceId === rows[index - 1].id) : undefined;
    const phaseApproval = row.phaseId ? facts.approvals.find((a) => a.step === 'DEMO' && a.phaseId === row.phaseId) : undefined;
    out.push({ ordinal: row.ordinal, since: latest(signedAt, previous?.paidAt, phaseApproval?.approvedAt)! });
  });
  return out;
}

/** What `pendingOf` (fields.ts) returns, reduced to the facts attention needs —
 *  with the dates the wait began on, which the banner never showed. */
type PendingResult = ReturnType<typeof pendingOf>;

export function pendingFactsOf(c: WizardContract, pending: PendingResult, now: Date): PendingFacts | null {
  // **The first published draft is the customer's move too** (J12 — the banner never said so,
  // because it only compares a revision with an earlier one the customer approved). On the new
  // road, from the day sales publishes the draft until the customer has approved *and* signed it,
  // the contract is theirs: first to read it and say what they want changed, then to sign. A
  // revision published after an earlier approval is `pending.contractDiff`'s own line, not this.
  const revision = c.currentContractRevision;
  const draft: PendingFacts['draft'] =
    c.sequence === 'AGREEMENT_FIRST' && revision && revision.publishedAt && !pending?.contractDiff
      ? revision.approvedAt === null
        ? { state: 'review', version: revision.version, since: revision.publishedAt }
        : revision.signature === null
          ? { state: 'sign', version: revision.version, since: revision.approvedAt }
          : null
      : null;
  if (!pending && !draft) return null;
  return {
    contract: pending?.contractDiff
      ? {
          fromVersion: pending.contractDiff.fromVersion,
          toVersion: pending.contractDiff.toVersion,
          since: c.currentContractRevision?.publishedAt ?? now,
        }
      : null,
    designChangeCount: pending?.designChanges.length ?? 0,
    designSince: c.currentDesignRevision?.publishedAt ?? null,
    amendment: pending?.amendment
      ? {
          ordinal: pending.amendment.ordinal,
          approved: pending.amendment.approvedAt !== null,
          since: pending.amendment.publishedAt ?? now,
        }
      : null,
    draft,
  };
}

/**
 * The rows → the attention module's input, for one contract. **Pure over the
 * loaded facts** and shared by the contract page (`Contract.attention`) and the
 * home screen (`myAttention`): the two differ only in how they fetched `facts`
 * and `pending`, never in what they make of them.
 */
export function attentionInputOf(c: WizardContract, facts: Facts, pending: PendingFacts | null, now: Date): AttentionInput {
  const wizard = computeWizard(stateOf(c, facts));
  const feedback = feedbackFacts(c.customerId, facts.feedback, new Set(facts.sensitiveArticles.map((a) => a.number)));
  return {
    contractId: c.id,
    customerId: c.customerId,
    now,
    pending,
    dependencies: facts.dependencies,
    feedback,
    scope: {
      undecidedProposals: facts.scopeProposals.filter((p) => p.decidedAt === null).map((p) => ({ since: p.createdAt })),
      openTrades: facts.scopeTrades,
    },
    invoices: facts.invoices,
    steps: stepFacts(c, facts, wizard, feedback),
    issuable: issuableFacts(c, facts),
  };
}

async function loadAttentionInput(c: FullContract, facts: Facts, now: Date): Promise<AttentionInput> {
  return attentionInputOf(c, facts, pendingFactsOf(c, await ContractFields.pending(c), now), now);
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

/**
 * When a customer may read the planned dates: **from the moment the draft is in
 * front of them** (a contract revision is published — journeys Q12, "Root
 * proposes them in the draft", and J6's step 2b shows them there) **or the
 * agreement is approved**, whichever is first. J3 said "not before approval";
 * that predates step 2b, whose whole point is that the customer reads the
 * proposed dates and can comment on them. Staff read them always
 * (`mayReadPlannedDates`).
 */
const plannedDatesShown = (facts: Facts) => agreementApproved(facts) || facts.contractRevisions.length > 0;

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

  /** The contract's planned start and end (J6, Q12) — `null` to a customer until
   *  the draft is in front of them (`plannedDatesShown`), and to no staff reader. */
  plannedStartAt: async (c: FullContract, _a: unknown, ctx: Context) =>
    mayReadPlannedDates(viewerOf(ctx), plannedDatesShown(await factsFor(ctx, c))) ? c.plannedStartAt : null,
  plannedEndAt: async (c: FullContract, _a: unknown, ctx: Context) =>
    mayReadPlannedDates(viewerOf(ctx), plannedDatesShown(await factsFor(ctx, c))) ? c.plannedEndAt : null,

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
    // The plan's first invoice (J13, Q11): a contract with a plan is "started"
    // once it is signed *and* that invoice is paid; one without a plan — every
    // legacy contract — keeps `started = signed`, so it passes `null`.
    const planRows = facts.plan?.invoices ?? [];
    return computeStatusSummary({
      now,
      sequence: c.sequence,
      wizard: computeWizard(stateOf(c, facts)),
      attention: attentionFor(input, viewer),
      // The current revision's signature, on both roads — approval is not
      // signing. `agreementSignedAt` is the one rule; invoice issuing reads it too.
      signedAt: agreementSignedAt({ signatureSignedAt: revision?.signature?.signedAt ?? null }),
      // The approval, separately (J7): "approved on …" is a state of its own on
      // the new road, between the draft and the signature.
      agreementApprovedAt: facts.approvals.find((a) => a.step === 'AGREEMENT' && a.phaseId === null)?.approvedAt ?? null,
      invoicePlan:
        planRows.length === 0
          ? null
          : {
              firstPaidAt: firstInvoicePaidAt(
                planRows,
                planRows.flatMap((r) => (r.billingEntry ? [{ plannedInvoiceId: r.id, ...r.billingEntry }] : [])),
              ),
            },
      plannedStartAt: mayReadPlannedDates(viewer, plannedDatesShown(facts)) ? c.plannedStartAt : null,
      plannedEndAt: mayReadPlannedDates(viewer, plannedDatesShown(facts)) ? c.plannedEndAt : null,
      // Every published row Root has shown the customer — the sources are
      // named in lib/statusSummary.ts's header.
      progressAt: [
        ...facts.builds.map((b) => b.publishedAt!),
        ...facts.mockupBuilds.map((b) => b.publishedAt!),
        ...facts.contractRevisions.map((r) => r.publishedAt!),
        ...facts.designRevisions.map((r) => r.publishedAt!),
      ],
      facts: {
        designPublished: facts.designRevisions.length > 0,
        designOpenFeedback: facts.feedback.some((i) => i.step === 'DESIGN' && i.status === 'OPEN'),
        contractPublished: facts.contractRevisions.length > 0,
        publishedDemoPhaseIds: facts.phases.filter(phaseDemoOut).map((p) => p.id),
        // J12 (J9b's owed gap): the mockup reads like the design — out, and whether
        // a note waits for Root.
        mockupPublished: facts.mockupBuilds.length > 0,
        mockupOpenFeedback: facts.feedback.some((i) => i.step === 'MOCKUP' && i.status === 'OPEN'),
        demoOpenFeedbackPhaseIds: [
          ...new Set(facts.feedback.filter((i) => i.step === 'DEMO' && i.status === 'OPEN' && i.phaseId !== null).map((i) => i.phaseId!)),
        ],
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
      deliveredAt: c.deliveredAt,
      mockupBuilds: facts.mockupBuilds.map((b, i) => ({ id: b.id, iteration: i + 1, publishedAt: b.publishedAt! })),
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
 * cannot answer on a locked step either, journeys §3.1), **J4's step-1
 * writes** (`setBrief`, `setExtra`, `setPaymentPlan`, and the phase edits, all
 * REQUIREMENTS), **J5's** proposals, decisions and `applyScopeTemplate` (SCOPE),
 * and **J6's and J7's** draft writes — `publishContractRevision`,
 * `setPlannedDates`, `applyContractTemplate`, and (J7) `setArticle`,
 * `updateContractDraft`, `deleteArticle` (DRAFT) — each after `lockContract`
 * where it writes. **J7 is the stage that writes the AGREEMENT approval
 * (`approveContract`, through `approveStepTx`), so from it on every one of
 * those calls can fire**; `j7.test.ts` holds the table of them against
 * `STEP_LOCKED`, and a source scan there fails when a guarded write is added
 * without a row. J7 also guards what the scope *is* in the registry
 * (`addScopeItem`, `updateScopeItem`, `deleteScopeItem`, in `admin/registry.ts`);
 * the registry's status, flag, decision and order edits are how a project lives
 * after the agreement and are not locked (see `inOpenScope` there).
 *
 * The design (DESIGN — all of `admin/design.ts` and the customer's `chooseConcept`,
 * `setPageApproval`, `requestOtherOptions` and `approveDesign` in `customer.ts` /
 * `design.ts`) is J8's and calls it through `openDesign`, which adds the one rule
 * the others do not need: on the new road the design opens once the agreement is
 * *signed*. The mockup (MOCKUP — J9b's `mockupStep.ts`) calls it through
 * `openMockup`, which adds its own road (custom path, design approved); a demo is
 * J10's and adds its calls in the same commit as the approval that makes them
 * reachable.
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
  // The road depends on the design path (MOCKUP is on it for the custom one), so
  // the lock check reads the brief's tier through the same `designPathOf` the
  // wizard uses (J8). The legacy road has no path.
  const brief =
    contract.sequence === 'AGREEMENT_FIRST'
      ? await db.contractBrief.findUnique({ where: { contractId }, select: { designTier: true } })
      : null;
  return {
    sequence: contract.sequence,
    designPath: brief ? designPathOf(brief.designTier) : null,
    phases,
    approvals: contract.stepApprovals,
    finished: [],
  };
}
