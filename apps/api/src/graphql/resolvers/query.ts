import { GraphQLError } from 'graphql';
import type { ChangeAction, ContractStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { clampLimit } from '../../lib/pagination.js';
import { requireUser, requireCapability, type Context } from '../../context.js';
import { contractInclude, loadForActor } from './contracts.js';
import { can } from '../../lib/capabilities.js';
import { contractVisibleTo, isActiveContract, projectVisibleToStaff } from '../../lib/visibility.js';
import { ensureDueEntriesFor, computeBillingReport } from '../../lib/billing.js';
import { smsProviderConfigured } from '../../lib/sms.js';

/** Shared with resolvers/admin/billing.ts, whose mutations return the same
 *  shape — one include, imported both places, rather than two copies that
 *  could drift (house rule 3). */
export const billingEntryInclude = {
  customer: true,
  contract: true,
  phase: true,
  subscription: true,
  ticket: true,
  // J13: "what it waited on" — the plan row this issued, if any.
  plannedInvoice: true,
} satisfies Prisma.BillingEntryInclude;

/**
 * Reads. Every one of them starts by establishing who is asking — a customer's
 * queries are scoped to their own published contracts in the `where` clause,
 * and the staff queries are guarded by a capability rather than by filter.
 */

/**
 * The `ContractRef` shape (V4 T1): a `select`, not the `contractInclude`
 * every other resolver in this codebase reaches for. `ActivityItem` and the
 * Needs-Root queue are lists of links, not lists of documents — resolving
 * either through `contractInclude` would drag concepts, pages, every
 * article, every comment and the whole change log along per row, forty
 * times over for forty rows. This is the one place the "one include shape,
 * fetched once" convention is the wrong tool.
 */
const contractRefSelect = {
  id: true,
  ref: true,
  titleFa: true,
  titleEn: true,
  status: true,
  statusChangedAt: true,
  customer: { select: { name: true } },
} satisfies Prisma.ContractSelect;

type ContractRefRow = Prisma.ContractGetPayload<{ select: typeof contractRefSelect }>;

const toContractRef = (c: ContractRefRow) => ({
  id: c.id,
  ref: c.ref,
  titleFa: c.titleFa,
  titleEn: c.titleEn,
  status: c.status,
  statusChangedAt: c.statusChangedAt,
  customerName: c.customer.name,
});

/**
 * Things the customer did that change what Root should do next (V4.md §3).
 * Deliberately excludes `APPROVED_PAGE` (routine, four per concept),
 * `SCOPE_ON`/`SCOPE_OFF` (noise), and everything Root itself does — those
 * belong in a general activity feed, not a queue of things to respond to.
 */
const REVIEW_ACTIONS: ChangeAction[] = [
  'SIGNED',
  'RE_SIGNED',
  'AMENDMENT_SIGNED',
  'APPROVED_CONTRACT',
  'RE_APPROVED',
  'AMENDMENT_APPROVED',
  'DESIGN_COMPLETE',
  'CHOSE_CONCEPT',
  'UNAPPROVED_PAGE',
  'COMMENTED',
];

/**
 * Ownership — actorId === contract.customerId — can't be expressed as a
 * Prisma `where` (it compares two columns on different rows of the join,
 * not a column against a literal), so it is filtered here instead of in
 * SQL. This caps how many rows that scan considers, since `activity`'s own
 * `limit` can only be applied *after* the filter without silently
 * undercounting a page of results.
 */
const REVIEW_SCAN_CAP = 500;
export const Query = {
  me: (_p: unknown, _a: unknown, ctx: Context) => ctx.user,

  myContracts: async (_p: unknown, args: { status?: ContractStatus }, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.contract.findMany({
      where: {
        customerId: user.id,
        publishedAt: { not: null },
        ...(args.status ? { status: args.status } : {}),
      },
      include: contractInclude,
      orderBy: { updatedAt: 'desc' },
    });
  },

  contractStatusCounts: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    const grouped = await prisma.contract.groupBy({
      by: ['status'],
      where: { customerId: user.id, publishedAt: { not: null } },
      _count: { _all: true },
    });
    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  },

  /**
   * **View as customer** (journeys build plan J3). `loadForActor` first, as
   * for anyone: a staff reader who may not see this contract gets `NOT_FOUND`
   * whether or not they asked for the customer's view. Then, for
   * `asCustomer`, the contract's own customer becomes the viewer for every
   * field resolver below (`ctx.viewAs`, read through `viewerOf`) — and the
   * contract itself is put to the customer's own visibility test, so one
   * Root has not handed over yet is refused exactly as the customer would be:
   * *this is what they see* has to include "nothing".
   *
   * There is no filtering here and no second rule: the customer's view is the
   * customer's rules applied to the customer. A customer passing `asCustomer`
   * is their own viewer already, so the flag changes nothing for them.
   */
  contract: async (_p: unknown, args: { id: string; asCustomer?: boolean }, ctx: Context) => {
    const user = requireUser(ctx);
    const contract = await loadForActor(args.id, user);
    if (args.asCustomer) {
      if (!contractVisibleTo(contract.customer, contract)) {
        throw new GraphQLError('The customer cannot see this contract yet.', {
          extensions: { code: 'NOT_VISIBLE_TO_CUSTOMER' },
        });
      }
      ctx.viewAs = contract.customer;
    }
    return contract;
  },

  /**
   * Journeys build plan S1: the whole book for `contracts.readAll`, and only
   * the contracts still being worked for `contracts.readActive` — the same
   * rule `contractVisibleTo` applies to a single contract, applied here as a
   * filter so a designer's list and a designer's direct link cannot disagree.
   */
  allContracts: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    const readAll = can(user, 'contracts.readAll');
    if (!readAll) requireCapability(ctx, 'contracts.readActive');
    const rows = await prisma.contract.findMany({ include: contractInclude, orderBy: { updatedAt: 'desc' } });
    return readAll ? rows : rows.filter((c) => isActiveContract(c));
  },

  allCustomers: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'customers.manage');
    // `has`, not equality: a person may hold CUSTOMER alongside other roles.
    // This is the containment read the GIN index on User.roles exists for.
    return prisma.user.findMany({
      where: { roles: { has: 'CUSTOMER' } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** The corpus admin's reviewer list (C2 §5). Same `has` reasoning as
   *  allCustomers — a reviewer may hold another role alongside it. */
  reviewers: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'review.admin');
    return prisma.user.findMany({
      where: { roles: { has: 'REVIEWER' } },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * Counts across every contract. `contractStatusCounts` above is scoped to
   * `customerId: user.id` — reusing it for an admin would show the count of
   * their own contracts, zero, which looks like an empty database rather
   * than a bug (V4.md §1.1). This is a different query for that reason, and
   * the customer-scoped one is left exactly as it was.
   */
  /**
   * Journeys build plan S1: who sales can assign as a contract's designer
   * or developer — the active accounts holding the job's capability, which
   * is exactly what `assignContract` will accept (a list and a refusal that
   * could disagree would be a form that offers what it then refuses). Only
   * the two assignment capabilities are answerable: this is not a general
   * "who holds X" oracle for an author to probe the staff table with.
   */
  assignableUsers: async (_p: unknown, args: { job: 'DESIGN' | 'BUILD' }, ctx: Context) => {
    requireCapability(ctx, 'contracts.author');
    const capability = args.job === 'DESIGN' ? 'design.author' : 'builds.author';
    const active = await prisma.user.findMany({ where: { state: 'ACTIVE' }, orderBy: { name: 'asc' } });
    return active.filter((u) => can(u, capability));
  },

  allContractStatusCounts: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'contracts.readAll');
    const grouped = await prisma.contract.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  },

  needsRootQueue: async (_p: unknown, args: { limit?: number }, ctx: Context) => {
    requireCapability(ctx, 'contracts.readAll');
    const rows = await prisma.contract.findMany({
      where: { status: 'WAITING_ON_ROOT' },
      orderBy: { statusChangedAt: 'asc' },
      take: clampLimit(args.limit, 20, 100),
      select: contractRefSelect,
    });
    return rows.map(toContractRef);
  },

  activity: async (
    _p: unknown,
    args: { limit?: number; reviewOnly?: boolean },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.readAll');
    const limit = clampLimit(args.limit, 40, 100);

    const rows = await prisma.changeLog.findMany({
      where: args.reviewOnly ? { action: { in: REVIEW_ACTIONS } } : {},
      orderBy: { createdAt: 'desc' },
      // Only the review filter needs the wider scan window (see
      // REVIEW_SCAN_CAP above) — the unfiltered feed can take `limit`
      // straight from the database.
      take: args.reviewOnly ? REVIEW_SCAN_CAP : limit,
      include: {
        actor: true,
        contract: { select: { ...contractRefSelect, customerId: true } },
      },
    });

    const filtered = args.reviewOnly
      ? rows.filter((r) => r.actorId === r.contract.customerId)
      : rows;

    return filtered.slice(0, limit).map((r) => ({
      id: r.id,
      contract: toContractRef(r.contract),
      actor: r.actor,
      action: r.action,
      arg: r.arg,
      createdAt: r.createdAt,
    }));
  },

  /** Staff. One project with its live registry — build plan L1. */
  project: async (_p: unknown, args: { id: string }, ctx: Context) => {
    const user = requireUser(ctx);
    if (!can(user, 'contracts.readAll')) requireCapability(ctx, 'contracts.readActive');
    const project = await prisma.project.findUnique({
      where: { id: args.id },
      include: { scopeItems: { orderBy: { position: 'asc' } }, contracts: { select: { status: true, deliveredAt: true } } },
    });
    // Null for a project this reader cannot see — the field is nullable and
    // already answers null for an id that does not exist (house rule 13).
    return project && projectVisibleToStaff(user, project) ? project : null;
  },

  /**
   * The dependency board (build plan L5; spec §7) — "overdue surfaces on
   * both dashboards." This is the staff half: every overdue dependency
   * across every project, both sides, on the one board — never scoped to
   * one project, since the point of the desk dashboard is to notice Root's
   * own slippage too, not only a customer's.
   *
   * Lives here rather than in `resolvers/admin/dependencies.ts`, matching
   * `Query.project`'s own precedent: reads for this domain sit in the
   * shared query file, writes sit in the admin barrel.
   */
  overdueDependencies: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'contracts.readAll');
    return prisma.dependency.findMany({
      where: { verifiedAt: null, dueAt: { lt: new Date() } },
      include: { project: true, createdBy: true, verifiedBy: true },
      orderBy: { dueAt: 'asc' },
    });
  },

  /**
   * The customer's own half of the same board (spec §11: "own commitments
   * with due dates staring back") — every overdue CUSTOMER-side dependency
   * across every project the caller owns. Never a ROOT-side row: a customer
   * seeing "Root is late" is not what this query is for, and nothing in the
   * spec's own portal projection asks for it.
   */
  myOverdueDependencies: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.dependency.findMany({
      where: { side: 'CUSTOMER', verifiedAt: null, dueAt: { lt: new Date() }, project: { customerId: user.id } },
      include: { project: true, createdBy: true, verifiedBy: true },
      orderBy: { dueAt: 'asc' },
    });
  },

  /**
   * Billing (build plan L6; spec §8) — the caller's own report. The caller's
   * own invoices are `myInvoices` (`invoices.ts`, J13: issued only). Lazily
   * catches up every one of the caller's subscriptions first
   * (`ensureDueEntriesFor`, lib/billing.ts) so a customer opening this for
   * the first time in months sees every period they owe, not only the ones
   * some earlier read happened to generate. Drafts are not in the totals
   * (`computeBillingReport`).
   */
  myBillingReport: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    await ensureDueEntriesFor(prisma, { customerId: user.id });
    const entries = await prisma.billingEntry.findMany({ where: { customerId: user.id } });
    return computeBillingReport(entries);
  },

  mySubscriptions: async (_p: unknown, _a: unknown, ctx: Context) => {
    const user = requireUser(ctx);
    return prisma.subscription.findMany({
      where: { customerId: user.id },
      include: { customer: true, project: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  /** Staff (billing.manage). Every billing entry, optionally narrowed —
   *  the desk's own report and ledger screen. */
  allBillingEntries: async (
    _p: unknown,
    args: { customerId?: string | null; projectId?: string | null },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'billing.manage');
    // An entry names a project only indirectly, through whichever origin it
    // came from — so "this project's billing" is an OR across all four
    // possible origins rather than one column, none of which is projectId
    // itself (build plan D1's registry lives on Project; BillingEntry
    // predates it and was never re-keyed).
    const where: Prisma.BillingEntryWhereInput = {
      ...(args.customerId ? { customerId: args.customerId } : {}),
      ...(args.projectId
        ? {
            OR: [
              { phase: { projectId: args.projectId } },
              { contract: { projectId: args.projectId } },
              { subscription: { projectId: args.projectId } },
              { ticket: { projectId: args.projectId } },
            ],
          }
        : {}),
    };
    await ensureDueEntriesFor(prisma, args.customerId ? { customerId: args.customerId } : {});
    // Drafts (`issuedAt` null) sort first under DESC — unissued work is what
    // the desk wants on top — and `id` (a cuid, roughly creation order) orders
    // them among themselves, since a draft has no other date.
    return prisma.billingEntry.findMany({
      where,
      include: billingEntryInclude,
      orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
    });
  },

  /** Staff (billing.manage). One customer's report, or the whole book
   *  when customerId is omitted (spec §8: "for the desk, the same query
   *  across customers"). */
  billingReport: async (_p: unknown, args: { customerId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    await ensureDueEntriesFor(prisma, args.customerId ? { customerId: args.customerId } : {});
    const entries = await prisma.billingEntry.findMany({
      where: args.customerId ? { customerId: args.customerId } : {},
    });
    return computeBillingReport(entries);
  },

  /** Staff (billing.manage). */
  allSubscriptions: async (_p: unknown, args: { customerId?: string | null }, ctx: Context) => {
    requireCapability(ctx, 'billing.manage');
    return prisma.subscription.findMany({
      where: args.customerId ? { customerId: args.customerId } : {},
      include: { customer: true, project: true },
      orderBy: { createdAt: 'desc' },
    });
  },

  /**
   * PD-18 — feeds the desk's own banner. Gated on `staff.manage` (ADMIN
   * only) rather than left open to every staff reader: nobody but the
   * account that could actually do something about it (set the five
   * `SMS_*` variables, or reach for the `set-phone` CLI) needs to know.
   * Never the provider's name or key — a boolean, and nothing else.
   */
  smsConfigured: (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'staff.manage');
    return smsProviderConfigured;
  },
};
