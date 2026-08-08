import type { ChangeAction, ContractStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, requireCapability, type Context } from '../../context.js';
import { contractInclude, loadForActor } from './contracts.js';

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

  contract: async (_p: unknown, args: { id: string }, ctx: Context) =>
    loadForActor(args.id, requireUser(ctx)),

  allContracts: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    return prisma.contract.findMany({ include: contractInclude, orderBy: { updatedAt: 'desc' } });
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

  /**
   * Counts across every contract. `contractStatusCounts` above is scoped to
   * `customerId: user.id` — reusing it for an admin would show the count of
   * their own contracts, zero, which looks like an empty database rather
   * than a bug (V4.md §1.1). This is a different query for that reason, and
   * the customer-scoped one is left exactly as it was.
   */
  allContractStatusCounts: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const grouped = await prisma.contract.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    return grouped.map((g) => ({ status: g.status, count: g._count._all }));
  },

  needsRootQueue: async (_p: unknown, args: { limit?: number }, ctx: Context) => {
    requireCapability(ctx, 'contracts.manage');
    const rows = await prisma.contract.findMany({
      where: { status: 'WAITING_ON_ROOT' },
      orderBy: { statusChangedAt: 'asc' },
      take: args.limit ?? 20,
      select: contractRefSelect,
    });
    return rows.map(toContractRef);
  },

  activity: async (
    _p: unknown,
    args: { limit?: number; reviewOnly?: boolean },
    ctx: Context,
  ) => {
    requireCapability(ctx, 'contracts.manage');
    const limit = args.limit ?? 40;

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
};
