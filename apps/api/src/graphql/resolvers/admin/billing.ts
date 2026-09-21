import { GraphQLError } from 'graphql';
import type { BillingSource } from '@prisma/client';
import { prisma } from '../../../lib/prisma.js';
import { requireCapability, type Context } from '../../../context.js';
import { isValidTomanAmount } from '../../../lib/billing.js';
import { billingEntryInclude } from '../query.js';
import { serviceRunInclude } from '../services.js';

/**
 * Billing (build plan L6; spec §8) — authoring one-off entries, marking them
 * paid, the billable-ticket edge (build plan L4's second banked trap), and
 * subscriptions. Every mutation here is `contracts.manage`, matching every
 * other registry-adjacent surface added since L1: the desk authors entries
 * and marks them paid; a customer never writes one (spec §8: "created and
 * marked paid by Root" — the schema comment this stage surfaces).
 *
 * Reading one's own billing (`myBillingEntries`/`myBillingReport`/
 * `mySubscriptions`) is ownership-gated instead, and lives in `query.ts`,
 * not here — the same split L5 established for dependencies.
 */

const notFound = (what: string) => new GraphQLError(`No such ${what}.`, { extensions: { code: 'NOT_FOUND' } });

function parseAmountOrThrow(input: string): bigint {
  if (!isValidTomanAmount(input)) {
    throw new GraphQLError('Amount must be a whole number of Toman — no sign, no decimal point.', {
      extensions: { code: 'INVALID_AMOUNT' },
    });
  }
  return BigInt(input.trim());
}

export const billingMutations = {
  /**
   * source may not be SUBSCRIPTION (INVALID_SOURCE) — those rows are only
   * ever written by `ensureSubscriptionEntries` (lib/billing.ts), from a
   * Subscription's own periods. Letting this mutation create one too would
   * open a second door onto the exact row the unique
   * (subscriptionId, periodStart) index exists to keep singular.
   */
  createBillingEntry: async (
    _p: unknown,
    args: {
      customerId: string;
      contractId?: string | null;
      phaseId?: string | null;
      source: BillingSource;
      descriptionFa: string;
      descriptionEn: string;
      amount: string;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    if (args.source === 'SUBSCRIPTION') {
      throw new GraphQLError('Subscription charges are generated automatically, never authored by hand.', {
        extensions: { code: 'INVALID_SOURCE' },
      });
    }
    const customer = await prisma.user.findUnique({ where: { id: args.customerId } });
    if (!customer) throw notFound('customer');
    if (args.contractId) {
      const contract = await prisma.contract.findUnique({ where: { id: args.contractId } });
      if (!contract) throw notFound('contract');
    }
    if (args.phaseId) {
      const phase = await prisma.phase.findUnique({ where: { id: args.phaseId } });
      if (!phase) throw notFound('phase');
    }
    const amount = parseAmountOrThrow(args.amount);

    return prisma.billingEntry.create({
      data: {
        customerId: customer.id,
        contractId: args.contractId ?? null,
        phaseId: args.phaseId ?? null,
        source: args.source,
        descriptionFa: args.descriptionFa,
        descriptionEn: args.descriptionEn,
        amount,
      },
      include: billingEntryInclude,
    });
  },

  markBillingEntryPaid: async (_p: unknown, args: { entryId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const entry = await prisma.billingEntry.findUnique({ where: { id: args.entryId } });
    if (!entry) throw notFound('billing entry');
    return prisma.billingEntry.update({ where: { id: entry.id }, data: { paidAt: new Date() }, include: billingEntryInclude });
  },

  /** Clears a mark-paid made in error — the same decide/undecide shape
   *  `unverifyDependency` already uses. */
  unmarkBillingEntryPaid: async (_p: unknown, args: { entryId: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const entry = await prisma.billingEntry.findUnique({ where: { id: args.entryId } });
    if (!entry) throw notFound('billing entry');
    return prisma.billingEntry.update({ where: { id: entry.id }, data: { paidAt: null }, include: billingEntryInclude });
  },

  /**
   * Build plan L4's second banked trap, built here: the edge from a
   * billable ticket to the charge it produces. Refused (NOT_BILLABLE)
   * unless the ticket's own flag is set — `setTicketBillable` (L4) is the
   * only way to set it — and refused (ALREADY_BILLED) if a charge already
   * exists; the unique `ticketId` column is the backstop bypassing this
   * resolver could not get past.
   */
  createTicketBillingEntry: async (
    _p: unknown,
    args: { ticketId: string; amount: string; descriptionFa: string; descriptionEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const ticket = await prisma.ticket.findUnique({
      where: { id: args.ticketId },
      include: { billingEntry: true },
    });
    if (!ticket) throw notFound('ticket');
    if (!ticket.billable) {
      throw new GraphQLError('This ticket is not marked billable.', { extensions: { code: 'NOT_BILLABLE' } });
    }
    if (ticket.billingEntry) {
      throw new GraphQLError('This ticket already has a billing entry.', { extensions: { code: 'ALREADY_BILLED' } });
    }
    const amount = parseAmountOrThrow(args.amount);

    return prisma.billingEntry.create({
      data: {
        customerId: ticket.customerId,
        source: 'TICKET',
        descriptionFa: args.descriptionFa,
        descriptionEn: args.descriptionEn,
        amount,
        ticketId: ticket.id,
      },
      include: billingEntryInclude,
    });
  },

  /**
   * Build plan L7's edge, built with L6's rest: the charge an applied
   * import run produced. Refused (NOT_APPLIED) unless the run is APPLIED —
   * charging for a run nobody has committed yet would bill work that might
   * still be rejected wholesale at the preview stage — and refused
   * (ALREADY_BILLED) if a charge already exists (the unique
   * `ServiceRun.billingEntryId` is the backstop). Returns the run, not the
   * entry — the desk's own service-runs screen reads `run.billingEntry`
   * rather than needing a second round trip.
   */
  createServiceRunBillingEntry: async (
    _p: unknown,
    args: { runId: string; amount: string; descriptionFa: string; descriptionEn: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const run = await prisma.serviceRun.findUnique({
      where: { id: args.runId },
      include: { project: true, billingEntry: true },
    });
    if (!run) throw notFound('service run');
    if (run.status !== 'APPLIED') {
      throw new GraphQLError('Only an applied run can be billed.', { extensions: { code: 'NOT_APPLIED' } });
    }
    if (run.billingEntry) {
      throw new GraphQLError('This run already has a billing entry.', { extensions: { code: 'ALREADY_BILLED' } });
    }
    const amount = parseAmountOrThrow(args.amount);

    await prisma.$transaction(async (tx) => {
      const entry = await tx.billingEntry.create({
        data: {
          customerId: run.project.customerId,
          source: 'SERVICE',
          descriptionFa: args.descriptionFa,
          descriptionEn: args.descriptionEn,
          amount,
        },
      });
      await tx.serviceRun.update({ where: { id: run.id }, data: { billingEntryId: entry.id } });
    });

    return prisma.serviceRun.findUniqueOrThrow({ where: { id: run.id }, include: serviceRunInclude });
  },

  createSubscription: async (
    _p: unknown,
    args: {
      customerId: string;
      projectId?: string | null;
      labelFa: string;
      labelEn: string;
      amount: string;
      period: 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
      activeFrom: string;
    },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const customer = await prisma.user.findUnique({ where: { id: args.customerId } });
    if (!customer) throw notFound('customer');
    if (args.projectId) {
      const project = await prisma.project.findUnique({ where: { id: args.projectId } });
      if (!project) throw notFound('project');
    }
    const amount = parseAmountOrThrow(args.amount);

    return prisma.subscription.create({
      data: {
        customerId: customer.id,
        projectId: args.projectId ?? null,
        labelFa: args.labelFa,
        labelEn: args.labelEn,
        amount,
        period: args.period,
        activeFrom: new Date(args.activeFrom),
      },
      include: { customer: true, project: true },
    });
  },

  updateSubscription: async (
    _p: unknown,
    args: { subscriptionId: string; labelFa: string; labelEn: string; amount: string },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const sub = await prisma.subscription.findUnique({ where: { id: args.subscriptionId } });
    if (!sub) throw notFound('subscription');
    const amount = parseAmountOrThrow(args.amount);

    return prisma.subscription.update({
      where: { id: sub.id },
      data: { labelFa: args.labelFa, labelEn: args.labelEn, amount },
      include: { customer: true, project: true },
    });
  },

  /** Sets activeUntil rather than deleting — see schema.prisma's own
   *  comment on why a subscription's billing history is never erased. */
  endSubscription: async (_p: unknown, args: { subscriptionId: string; activeUntil: string }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const sub = await prisma.subscription.findUnique({ where: { id: args.subscriptionId } });
    if (!sub) throw notFound('subscription');
    if (sub.activeUntil) {
      throw new GraphQLError('This subscription has already ended.', { extensions: { code: 'ALREADY_ENDED' } });
    }
    return prisma.subscription.update({
      where: { id: sub.id },
      data: { activeUntil: new Date(args.activeUntil) },
      include: { customer: true, project: true },
    });
  },
};
