import { GraphQLError } from 'graphql';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, requireCapability, viewerOf, type Context } from '../../context.js';
import { ensureDueEntriesFor } from '../../lib/billing.js';
import { plannedInvoiceState } from '../../lib/invoice.js';
import { agreementSignedAt } from '../../lib/steps.js';
import { invoiceVisibleTo } from '../../lib/visibility.js';
import { contractInclude } from './contracts.js';
import { billingEntryInclude } from './query.js';

/**
 * What the customer reads of their invoices, and the fields that say where each
 * row of a payment plan stands (journeys build plan J13). The rules are
 * `lib/invoice.ts`; what may be *shown* is `invoiceVisibleTo`
 * (`lib/visibility.ts`); this file loads rows and hands them over. The desk's
 * mutations — drafts, issuing, marking paid — are `admin/invoices.ts` and
 * `admin/billing.ts`.
 *
 * **Every edge that can return a `BillingEntry` is listed here or asks
 * `invoiceVisibleTo`**, because a draft (`issuedAt` null) must reach no
 * customer by any of them: `myInvoices` and `invoice` (the entry's own
 * customer, issued only, in the `where` — a draft is `NOT_FOUND`, not
 * "not allowed", rule 13), `myBillingReport` and the desk's reports
 * (`computeBillingReport` skips drafts), `ServiceRun.billingEntry`
 * (`fields.ts`), and `PlannedInvoice.invoice` below. `j13.test.ts` reads every
 * resolver file as text and holds the list, so a new edge cannot be added
 * without meeting it.
 */

type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Everything the plan rule reads about one payment plan, in one load: the rows
 * in order, the entries they were issued as, the contract's step approvals and
 * when its agreement was signed. What both `canIssuePlanned`'s callers — the
 * field that shows a row's state and the mutation that refuses on it — read,
 * so the button and the refusal cannot disagree. Takes a client so the
 * mutation can read inside its transaction.
 */
export async function loadPlanFacts(db: Db, planId: string) {
  const plan = await db.paymentPlan.findUniqueOrThrow({
    where: { id: planId },
    include: { invoices: { orderBy: { ordinal: 'asc' } } },
  });
  const [entries, approvals, contract] = await Promise.all([
    db.billingEntry.findMany({
      where: { plannedInvoiceId: { in: plan.invoices.map((i) => i.id) } },
      include: billingEntryInclude,
    }),
    db.stepApproval.findMany({
      where: { contractId: plan.contractId },
      select: { step: true, phaseId: true, approvedAt: true },
    }),
    db.contract.findUniqueOrThrow({
      where: { id: plan.contractId },
      select: { currentContractRevision: { select: { signature: { select: { signedAt: true } } } } },
    }),
  ]);
  const signedAt = agreementSignedAt({
    signatureSignedAt: contract.currentContractRevision?.signature?.signedAt ?? null,
  });
  return { plan, entries, approvals, signedAt };
}

export type PlanFacts = Awaited<ReturnType<typeof loadPlanFacts>>;

/** One load per plan per request — a plan's rows each ask for their state and
 *  their invoice, and each ask would otherwise be four queries. Keyed on the
 *  context (per request), like the wizard's facts. */
const factsCache = new WeakMap<Context, Map<string, Promise<PlanFacts>>>();

function planFactsFor(ctx: Context, planId: string): Promise<PlanFacts> {
  let perRequest = factsCache.get(ctx);
  if (!perRequest) factsCache.set(ctx, (perRequest = new Map()));
  let facts = perRequest.get(planId);
  if (!facts) perRequest.set(planId, (facts = loadPlanFacts(prisma, planId)));
  return facts;
}

const rowsOf = (facts: PlanFacts) => facts.plan.invoices.map((i) => ({ id: i.id, ordinal: i.ordinal, phaseId: i.phaseId }));

async function standing(ctx: Context, row: { id: string; planId: string }) {
  const facts = await planFactsFor(ctx, row.planId);
  const plan = rowsOf(facts);
  const index = plan.findIndex((r) => r.id === row.id);
  return { facts, ...plannedInvoiceState(plan, index, facts.entries, facts.approvals, facts.signedAt !== null, new Date()) };
}

/** `PlannedInvoice`'s J13 fields. The row itself (label, amount, term) is
 *  `Contract.paymentPlan`'s (`brief.ts`), which is null for anyone who may not
 *  read money — so these are only ever asked of someone who may. */
export const PlannedInvoice = {
  state: async (row: { id: string; planId: string }, _a: unknown, ctx: Context) => (await standing(ctx, row)).state,
  blockedBy: async (row: { id: string; planId: string }, _a: unknown, ctx: Context) => (await standing(ctx, row)).blockedBy,
  invoice: async (row: { id: string; planId: string }, _a: unknown, ctx: Context) => {
    const facts = await planFactsFor(ctx, row.planId);
    const entry = facts.entries.find((e) => e.plannedInvoiceId === row.id);
    return entry && invoiceVisibleTo(viewerOf(ctx), entry) ? entry : null;
  },
};

export const invoiceQueries = {
  /**
   * The caller's own **issued** invoices, newest first. Lazily catches up their
   * subscriptions first (`ensureDueEntriesFor`, lib/billing.ts) so a customer
   * opening this for the first time in months sees every period they owe. The
   * `issuedAt: { not: null }` is the draft rule for this edge, in the `where` —
   * a draft is not filtered out of a result, it is never selected.
   */
  myInvoices: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    await ensureDueEntriesFor(prisma, { customerId: user.id });
    return prisma.billingEntry.findMany({
      where: { customerId: user.id, issuedAt: { not: null } },
      include: billingEntryInclude,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** One of the caller's own issued invoices. Somebody else's, a draft and a
   *  missing id all answer the same `NOT_FOUND` (rule 13). */
  invoice: async (_p: unknown, args: { id: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const entry = await prisma.billingEntry.findFirst({
      where: { id: args.id, customerId: user.id, issuedAt: { not: null } },
      include: billingEntryInclude,
    });
    if (!entry) throw new GraphQLError('No such invoice.', { extensions: { code: 'NOT_FOUND' } });
    return entry;
  },

  /** Staff (billing.manage). The contracts that carry a payment plan, newest
   *  first — the desk's billing screen lists each with its *Issue next*. */
  contractsWithPaymentPlan: async (_p: unknown, args: { customerId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    return prisma.contract.findMany({
      where: { paymentPlan: { isNot: null }, ...(args.customerId ? { customerId: args.customerId } : {}) },
      include: contractInclude,
      orderBy: { createdAt: 'desc' },
    });
  },
};
