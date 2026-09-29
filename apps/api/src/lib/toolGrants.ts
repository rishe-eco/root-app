import type { Prisma, ToolKey } from '@prisma/client';
import { prisma } from './prisma.js';

/**
 * Tool grants (journeys build plan S3) — the one question "may this customer
 * use this tool", asked from the resolvers and from the upload route so the
 * answer cannot be written two ways (house rule 3).
 *
 * A grant is *active* while `revokedAt` is null; the partial unique index
 * `ToolGrant_one_active_per_tool` guarantees there is at most one. Revoked
 * rows are history and never count.
 *
 * This is an ownership-side fact about a customer, not a capability: staff
 * (`customers.manage`) act for customers with or without it, and callers
 * apply the grant only on the customer's own path.
 */

type Db = typeof prisma | Prisma.TransactionClient;

export async function hasToolGrant(customerId: string, tool: ToolKey, db: Db = prisma): Promise<boolean> {
  const grant = await db.toolGrant.findFirst({
    where: { customerId, tool, revokedAt: null },
    select: { id: true },
  });
  return grant !== null;
}
