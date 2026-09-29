import { GraphQLError } from 'graphql';
import { prisma } from '../../../lib/prisma.js';
import { env } from '../../../lib/env.js';
import { requireCapability, type Context } from '../../../context.js';
import { newLinkToken } from '../../../auth/tokens.js';
import { notify } from '../../../lib/notify.js';
import { resolveLocale } from '../../../lib/mailTemplates.js';
import { normalizePhone } from '../../../lib/phone.js';

/** Invites and revocations — customers and reviewers. Part of the L1 split of
 *  the former `admin.ts`; see `index.ts`. */
export const customerMutations = {
  /**
   * Journeys build plan J1: phone is now the required identifier, email
   * optional (Q1) — the SMS carries the link, email too if given, and the
   * desk always shows the link either way (today's fallback, kept, for when
   * no provider is configured or a send bounces).
   */
  inviteCustomer: async (
    _p: unknown,
    args: { phone: string; name: string; clientName?: string; locale?: string; email?: string },
    ctx: Context,
  ) => {
    const admin = requireCapability(ctx, 'customers.manage');
    const phone = normalizePhone(args.phone);
    if (!phone) {
      throw new GraphQLError('That does not look like a phone number.', {
        extensions: { code: 'PHONE_INVALID' },
      });
    }
    const email = args.email?.trim().toLowerCase() || null;
    // D9: default to the *inviting* admin's own locale, a better guess than
    // the schema's hardcoded 'fa', when the caller doesn't say otherwise.
    const locale = resolveLocale(args.locale ?? admin.locale);

    const existing = await prisma.user.findUnique({ where: { phone } });
    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: { name: args.name.trim(), clientName: args.clientName ?? null, locale, email },
        })
      : await prisma.user.create({
          data: { phone, name: args.name.trim(), clientName: args.clientName ?? null, locale, email },
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

    // Still returned unconditionally: the fallback for when every channel
    // bounces or no SMS provider is configured, not something notify()
    // makes redundant.
    const inviteUrl = `${env.APP_ORIGIN}/${user.locale}/portal/invite/${raw}`;
    await notify(user, { kind: 'INVITE_CUSTOMER', params: { name: user.name, inviteUrl } });
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
    // A reviewer never carries a phone (PD-20) — notify() sends email only,
    // which is exactly what this call site needs.
    await notify(user, { kind: 'INVITE_REVIEWER', params: { name: user.name, inviteUrl } });
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
