import { GraphQLError } from 'graphql';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import { setSessionCookie, clearSessionCookie, type Context } from '../../context.js';
import { signSession, newLinkToken, hashToken } from '../../auth/tokens.js';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../../auth/password.js';

/**
 * Sign in, sign out, and the two link-token flows.
 *
 * The recurring rule across this file is that failure says as little as
 * possible: one message for a wrong password and an unknown address, `true`
 * for a reset requested against an address with no account, one message for
 * every way a token can be unusable. Whether a given email has an account here
 * is not ours to leak.
 */
export const authMutations = {
  signIn: async (_p: unknown, args: { email: string; password: string }, ctx: Context) => {
    const user = await prisma.user.findUnique({
      where: { email: args.email.trim().toLowerCase() },
    });
    // One message for both branches — never reveal which accounts exist.
    const bad = () =>
      new GraphQLError('That email and password do not match.', {
        extensions: { code: 'BAD_CREDENTIALS' },
      });

    if (!user || !user.passwordHash || user.state !== 'ACTIVE') throw bad();
    if (!(await verifyPassword(args.password, user.passwordHash))) throw bad();

    setSessionCookie(ctx.res, signSession({ sub: user.id }));
    return { user };
  },

  signOut: (_p: unknown, _a: unknown, ctx: Context) => {
    clearSessionCookie(ctx.res);
    return true;
  },

  acceptInvite: async (
    _p: unknown,
    args: { token: string; name: string; password: string },
    ctx: Context,
  ) => {
    if (args.password.length < MIN_PASSWORD_LENGTH) {
      throw new GraphQLError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, {
        extensions: { code: 'PASSWORD_TOO_SHORT' },
      });
    }
    const record = await prisma.authToken.findUnique({
      where: { tokenHash: hashToken(args.token) },
      include: { user: true },
    });
    if (
      !record ||
      record.purpose !== 'INVITE' ||
      record.usedAt ||
      record.revokedAt ||
      record.expiresAt < new Date()
    ) {
      throw new GraphQLError('This link is no longer valid.', {
        extensions: { code: 'TOKEN_INVALID' },
      });
    }

    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: {
          name: args.name.trim() || record.user.name,
          passwordHash: await hashPassword(args.password),
          state: 'ACTIVE',
        },
      }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);

    setSessionCookie(ctx.res, signSession({ sub: user.id }));
    return { user };
  },

  requestPasswordReset: async (_p: unknown, args: { email: string }) => {
    const user = await prisma.user.findUnique({
      where: { email: args.email.trim().toLowerCase() },
    });
    // Always true: whether the address has an account is not ours to leak.
    if (!user || user.state !== 'ACTIVE') return true;

    const { raw, hash } = newLinkToken();
    const expiresAt = new Date(Date.now() + env.RESET_HOURS * 60 * 60 * 1000);
    await prisma.authToken.create({
      data: { userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: hash, expiresAt },
    });

    // TODO(email): no mail provider is wired yet, so the link is logged for
    // an operator to pass on by hand. Swap this for the provider call.
    console.info(
      `[reset] ${user.email} -> ${env.APP_ORIGIN}/${user.locale}/portal/reset/${raw}`,
    );
    return true;
  },

  resetPassword: async (
    _p: unknown,
    args: { token: string; password: string },
    ctx: Context,
  ) => {
    if (args.password.length < MIN_PASSWORD_LENGTH) {
      throw new GraphQLError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, {
        extensions: { code: 'PASSWORD_TOO_SHORT' },
      });
    }
    const record = await prisma.authToken.findUnique({
      where: { tokenHash: hashToken(args.token) },
    });
    if (
      !record ||
      record.purpose !== 'PASSWORD_RESET' ||
      record.usedAt ||
      record.revokedAt ||
      record.expiresAt < new Date()
    ) {
      throw new GraphQLError('This link is no longer valid.', {
        extensions: { code: 'TOKEN_INVALID' },
      });
    }

    const [user] = await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await hashPassword(args.password), state: 'ACTIVE' },
      }),
      prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);

    setSessionCookie(ctx.res, signSession({ sub: user.id }));
    return { user };
  },
};
