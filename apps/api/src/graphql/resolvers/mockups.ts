import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { requireUser, type Context } from '../../context.js';
import { contractVisibleTo } from '../../lib/visibility.js';
import { grantFor, viewUrlFor } from '../../lib/mockupGrant.js';

/**
 * The portal's way into a mockup (journeys build plan J9): a query that hands
 * back the subdomain a viewer's copy is served at. The other half — the router
 * that answers on that subdomain — is `routes/mockups.ts`, and it re-checks
 * everything this checked, on every request; this only decides whether to hand
 * out a URL at all.
 */

const notFound = () => new GraphQLError('No such demo.', { extensions: { code: 'NOT_FOUND' } });

export const mockupQueries = {
  /**
   * Mints — or reuses — the caller's `MockupViewGrant` on the demo's current
   * **published** mockup build and returns `https://<grant-id>.<base>/`.
   *
   * **Who.** Anyone who can see the demo's contract: its customer (once the
   * contract is published), or staff who can see it (`contractVisibleTo`, S1's
   * one rule — imported, not restated). `NOT_FOUND` for everyone else and for a
   * demo that is not a mockup, indistinguishably (house rule 13). The signed-in
   * user is the viewer, never a "view as customer" stand-in: that switch exists
   * for the `contract` root field, and a grant made for somebody else would be
   * a URL that opens as them.
   *
   * **A query, though it can write.** J9 specifies a query, and it is
   * idempotent in effect: repeated calls return the same grant until it is
   * close to expiring, and a grant confers nothing the caller's own session
   * does not already (the router re-checks the viewer's access on every
   * request). The one cost is that a read-only API token can cause the row to
   * be written; it could read the mockup anyway.
   */
  mockupViewUrl: async (_p: unknown, args: { demoId: string }, ctx: Context) => {
    const user = requireUser(ctx);

    const demo = await prisma.demo.findUnique({
      where: { id: args.demoId },
      include: {
        contract: { select: { customerId: true, publishedAt: true, status: true, deliveredAt: true, project: { select: { status: true } } } },
      },
    });
    // A SITE demo has no mockup to open, and a MOCKUP demo without a contract
    // (a state the schema allows and nothing creates) has nobody to be visible to.
    if (!demo || demo.kind !== 'MOCKUP' || !demo.contract || !contractVisibleTo(user, demo.contract)) {
      throw notFound();
    }

    // The current iteration: the highest-numbered one Root has told the
    // customer about. A declared-but-unpublished build is a draft.
    const build = await prisma.build.findFirst({
      where: { demoId: demo.id, kind: 'MOCKUP', publishedAt: { not: null } },
      orderBy: { number: 'desc' },
      select: { id: true },
    });
    if (!build) {
      throw new GraphQLError('This mockup has no published iteration yet.', {
        extensions: { code: 'NO_PUBLISHED_MOCKUP' },
      });
    }

    const grant = await grantFor(prisma, build.id, user.id);
    return viewUrlFor(grant.id);
  },
};
