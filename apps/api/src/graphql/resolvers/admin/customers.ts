import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../lib/env.js';
import { requireCapability, type Context } from '../../../context.js';
import { newLinkToken } from '../../../auth/tokens.js';
import { sendMail } from '../../../lib/mail.js';
import { resolveLocale, inviteEmail, reviewerInviteEmail } from '../../../lib/mailTemplates.js';

/** Invites and revocations — customers and reviewers. Part of the L1 split of
 *  the former `admin.ts`; see `index.ts`. */
export const customerMutations = {
  inviteCustomer: async (
    _p: unknown,
    args: { email: string; name: string; clientName?: string; locale?: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'customers.manage');
    const email = args.email.trim().toLowerCase();
    // D9: default to the *inviting* admin's own locale, a better guess than
    // the schema's hardcoded 'fa', when the caller doesn't say otherwise.
    const locale = resolveLocale(args.locale ?? admin.locale);

    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name: args.name.trim(), clientName: args.clientName ?? null, locale },
      update: { name: args.name.trim(), clientName: args.clientName ?? null, locale },
    });
    if (user.state === 'ACTIVE') {
      throw new GraphQLError('That account is already active.', {
        extensions: { code: 'ALREADY_ACTIVE' },
      });
    }

    const { raw, hash } = newLinkToken();
    const expiresAt = new Date(Date.now() + env.INVITE_DAYS * 24 * 60 * 60 * 1000);
    await prisma.authToken.create({
      data: { userId: user.id, purpose: 'INVITE', tokenHash: hash, expiresAt },
    });

    // Still returned unconditionally: the fallback for when mail bounces or
    // no provider is configured, not something mail makes redundant.
    const inviteUrl = `${env.APP_ORIGIN}/${user.locale}/portal/invite/${raw}`;
    try {
      await sendMail({ to: user.email, ...inviteEmail(user.locale, { name: user.name, inviteUrl }) });
    } catch (err) {
      console.error('[mail] invite send failed', err);
    }
    return { userId: user.id, email: user.email, inviteUrl, expiresAt };
  },

  revokeInvite: async (_p: unknown, args: { userId: string }, ctx: Context) => {
    requireCapability(ctx, 'customers.manage');
    await prisma.authToken.updateMany({
      where: { userId: args.userId, purpose: 'INVITE', usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return true;
  },

  /**
   * C2 §5. Deliberately its own mutation rather than a role argument on
   * `inviteCustomer` — guarded by `review.admin`, not `customers.manage`,
   * because inviting a specialist to read a corpus is not account
   * administration (capabilities.ts's own reasoning for keeping the two
   * apart). Same shape otherwise: upsert, issue an invite token, mail it,
   * always return the link too.
   */
  inviteReviewer: async (
    _p: unknown,
    args: { email: string; name: string; locale?: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'review.admin');
    const email = args.email.trim().toLowerCase();
    const locale = resolveLocale(args.locale ?? admin.locale);

    const user = await prisma.user.upsert({
      where: { email },
      create: { email, name: args.name.trim(), roles: ['REVIEWER'], locale },
      update: { name: args.name.trim(), locale },
    });
    if (user.state === 'ACTIVE') {
      throw new GraphQLError('That account is already active.', { extensions: { code: 'ALREADY_ACTIVE' } });
    }

    const { raw, hash } = newLinkToken();
    const expiresAt = new Date(Date.now() + env.INVITE_DAYS * 24 * 60 * 60 * 1000);
    await prisma.authToken.create({
      data: { userId: user.id, purpose: 'INVITE', tokenHash: hash, expiresAt },
    });

    const inviteUrl = `${env.APP_ORIGIN}/${user.locale}/portal/invite/${raw}`;
    try {
      await sendMail({ to: user.email, ...reviewerInviteEmail(user.locale, { name: user.name, inviteUrl }) });
    } catch (err) {
      console.error('[mail] reviewer-invite send failed', err);
    }
    return { userId: user.id, email: user.email, inviteUrl, expiresAt };
  },

  /**
   * C2 §5. Drops REVIEWER and nothing else — the account, its other roles
   * (if any) and every thread and comment it ever wrote stay exactly as
   * they were. Refused, not silently worked around, when REVIEWER is the
   * account's only role: `roles: []` would violate User_roles_non_empty,
   * and inventing a fallback role or auto-disabling the account are both
   * decisions only Root should make, not this mutation.
   */
  revokeReviewer: async (_p: unknown, args: { userId: string }, ctx: Context) => {
    requireCapability(ctx, 'review.admin');
    const user = await prisma.user.findUnique({ where: { id: args.userId } });
    if (!user) {
      throw new GraphQLError('No such reviewer.', { extensions: { code: 'NOT_FOUND' } });
    }
    if (!user.roles.includes('REVIEWER')) {
      throw new GraphQLError('That account does not hold the reviewer role.', {
        extensions: { code: 'NOT_REVIEWER' },
      });
    }
    const remaining = user.roles.filter((r) => r !== 'REVIEWER');
    if (remaining.length === 0) {
      throw new GraphQLError(
        'Reviewer is the only role on this account — removing it would leave none. Grant another role first if this person should lose reviewer access.',
        { extensions: { code: 'LAST_ROLE' } },
      );
    }
    await prisma.user.update({ where: { id: user.id }, data: { roles: remaining } });
    return true;
  },
};
