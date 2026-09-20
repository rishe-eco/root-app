import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { can } from '../../lib/capabilities.js';
import { matchDemoPath } from '../../lib/demoPages.js';

/**
 * `reportDemoPath` — the reporter snippet's own call (build plan L2; D2).
 * Lives outside `resolvers/admin/` on purpose: it is the one demo-surface
 * mutation a customer calls too, so it does not belong beside the
 * `contracts.manage`-only phase and demo authoring mutations.
 *
 * **Ownership, not capability (house rule 2).** The question here is "may
 * this person be looking at this demo," which is an edge between a user and
 * a project — `project.customerId === user.id` — never a role test, per D3's
 * own escape-hatch note (build plan §2 D3). Staff bypass via
 * `contracts.manage`, exactly like `loadForActor`.
 */
async function loadDemoForActor(demoId: string, user: { id: string; roles: unknown[] }) {
  const demo = await prisma.demo.findUnique({
    where: { id: demoId },
    include: {
      pages: true,
      phase: { include: { project: { select: { customerId: true } } } },
    },
  });
  if (!demo) {
    throw new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });
  }
  const isStaff = can(user as Parameters<typeof can>[0], 'contracts.manage');
  if (!isStaff && demo.phase.project.customerId !== user.id) {
    // House rule 13: "no such thing," not "not allowed" — a demo belonging
    // to someone else is indistinguishable from one that does not exist.
    throw new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });
  }
  return demo;
}

export const demoMutations = {
  /**
   * Matches the reported path against the demo's declared pages
   * (`lib/demoPages.ts`) and, on a miss, upserts a `DemoUnmatchedPath` —
   * counted and timestamped rather than dropped (L2.2: an unrouted path must
   * be visible, never silent). Fires on every page-change event the
   * reporter snippet sees, so this stays a thin, frequent write, not a
   * whole-contract reload.
   */
  reportDemoPath: async (_p: unknown, args: { demoId: string; path: string }, ctx: Context) => {
    const user = requireUser(ctx);
    const demo = await loadDemoForActor(args.demoId, user);

    const result = matchDemoPath(args.path, demo.pages);
    if (result.kind === 'MATCHED') {
      const page = demo.pages.find((p) => p.id === result.pageId) ?? null;
      return { matched: true, page, normalizedPath: result.normalizedPath };
    }

    await prisma.demoUnmatchedPath.upsert({
      where: { demoId_normalizedPath: { demoId: demo.id, normalizedPath: result.normalizedPath } },
      create: { demoId: demo.id, normalizedPath: result.normalizedPath },
      update: { lastSeenAt: new Date(), count: { increment: 1 } },
    });
    return { matched: false, page: null, normalizedPath: result.normalizedPath };
  },
};
