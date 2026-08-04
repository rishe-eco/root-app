import type { ContractStatus } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireUser, requireRole, type Context } from '../../context.js';
import { contractInclude, loadForActor } from './contracts.js';

/**
 * Reads. Every one of them starts by establishing who is asking — a customer's
 * queries are scoped to their own published contracts in the `where` clause,
 * and the two admin queries are guarded by role rather than by filter.
 */
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
    requireRole(ctx, 'ADMIN');
    return prisma.contract.findMany({ include: contractInclude, orderBy: { updatedAt: 'desc' } });
  },

  allCustomers: async (_p: unknown, _a: unknown, ctx: Context) => {
    requireRole(ctx, 'ADMIN');
    return prisma.user.findMany({ where: { role: 'CUSTOMER' }, orderBy: { createdAt: 'desc' } });
  },
};
