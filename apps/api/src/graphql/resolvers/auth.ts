import crypto from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { AuthToken } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../lib/env.js';
import {
  setSessionCookie,
  clearSessionCookie,
  requireUserAllowingPasswordChange,
  type Context,
} from '../../context.js';
import { signSession, newLinkToken, hashToken } from '../../auth/tokens.js';
import { burnPasswordCheck, hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../../auth/password.js';
import { notify } from '../../lib/notify.js';
import { normalizePhone } from '../../lib/phone.js';
import {
  generateLoginCode,
  hashLoginCode,
  loginCodeExpiresAt,
  loginCodeIsValid,
  LOGIN_CODE_MAX_ATTEMPTS,
} from '../../lib/loginCode.js';
import { sendSmsCode, smsAvailable, smsProviderConfigured } from '../../lib/sms.js';
import { requiresSecondFactor } from '../../lib/capabilities.js';
import {
  checkAll,
  loginCodePerIpPerHour,
  loginCodePerPhonePerDay,
  loginCodePerPhonePerMinute,
  signInAttemptsPerIdentifier,
  signInAttemptsPerIp,
} from '../../lib/rateLimit.js';

/**
 * Sign in, sign out, the staff second factor, phone recovery, and the two
 * link-token flows (journeys build plan J1 rewrites the first three; the
 * last two are unchanged in shape).
 *
 * The recurring rule across this file is that failure says as little as
 * possible: one message for a wrong password and an unknown identifier,
 * `true` for a reset or a code requested against an identifier with no
 * account, one message (`CODE_INVALID`) for every way a code can be
 * unusable. Whether a given phone or email has an account here is not ours
 * to leak — and, new in this stage, **timing** is part of that: see
 * `requestLoginCode`'s own comment.
 */

const codeInvalid = () =>
  new GraphQLError('That code is not valid.', { extensions: { code: 'CODE_INVALID' } });

/**
 * Creates a LOGIN_CODE/SIGNIN_FACTOR challenge, sends it, and logs the send
 * — the one place both `signIn`'s factor branch and `requestLoginCode`
 * create a code, so the "generate, store, send, log" sequence is written
 * once. Deliberately *not* in `lib/loginCode.ts`: that file is pure and
 * unit-tested with no database or transport in sight (the build plan's own
 * list), and this function is nothing but their orchestration.
 */
async function issueCode(
  userId: string,
  phone: string,
  locale: string,
  purpose: 'LOGIN_CODE' | 'SIGNIN_FACTOR',
): Promise<string> {
  const tokenId = crypto.randomUUID();
  const code = generateLoginCode();
  await prisma.authToken.create({
    data: {
      id: tokenId,
      userId,
      purpose,
      tokenHash: hashLoginCode(tokenId, code),
      expiresAt: loginCodeExpiresAt(),
    },
  });

  // Never lets a transport failure become visible to the caller — the same
  // discipline `notify()` applies, extended here to the code-delivery path
  // it does not cover.
  await sendSmsCode(phone, code, locale).catch((err) => {
    console.error(`[sms] ${purpose} send failed`, err);
  });
  await prisma.smsLog.create({ data: { userId, toPhone: phone, purpose } }).catch(() => undefined);

  return tokenId;
}

/**
 * The one check every `verify*` mutation runs against whatever `AuthToken`
 * row it loaded: valid, record the success by marking it used; invalid,
 * record the attempt (revoking at `LOGIN_CODE_MAX_ATTEMPTS`) and refuse.
 * Never distinguishes *why* a code failed to whoever is guessing — house
 * rule 13's own shape, applied to a code instead of a contract id.
 */
async function checkAndConsumeCode(record: AuthToken | null, code: string): Promise<boolean> {
  if (!record || !loginCodeIsValid(record, code, record.id)) {
    if (record) {
      const attempts = record.attempts + 1;
      await prisma.authToken
        .update({
          where: { id: record.id },
          data: { attempts, ...(attempts >= LOGIN_CODE_MAX_ATTEMPTS ? { revokedAt: new Date() } : {}) },
        })
        .catch(() => undefined);
    }
    return false;
  }
  await prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
  return true;
}

async function loadLatestLoginCodeToken(userId: string): Promise<AuthToken | null> {
  return prisma.authToken.findFirst({
    where: { userId, purpose: 'LOGIN_CODE', usedAt: null, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

export const authMutations = {
  /**
   * `identifier` is a phone or an email — an `@` decides which (journeys
   * build plan J1). One failure message for every branch, as before
   * signIn had two identifiers to be wrong about instead of one.
   */
  signIn: async (_p: unknown, args: { identifier: string; password: string }, ctx: Context) => {
    const identifier = args.identifier.trim();
    const isEmail = identifier.includes('@');
    const normalizedPhone = isEmail ? null : normalizePhone(identifier);

    const bad = () =>
      new GraphQLError('That did not match an account.', {
        extensions: { code: 'BAD_CREDENTIALS' },
      });

    // PD-15: sign-in attempts, 10/15min per identifier and per IP — checked
    // before the password is even looked at, so a guessing loop is
    // throttled whether or not it ever finds a real account. The key is the
    // identifier exactly as normalized for lookup, so two spellings of one
    // phone share a budget the way two accounts never could (lib/phone.ts).
    const identifierKey = isEmail ? identifier.toLowerCase() : (normalizedPhone ?? identifier);
    const ip = ctx.req.ip ?? 'unknown';
    if (
      !checkAll([
        { bucket: signInAttemptsPerIdentifier, key: identifierKey },
        { bucket: signInAttemptsPerIp, key: ip },
      ])
    ) {
      throw new GraphQLError('Too many attempts. Try again later.', {
        extensions: { code: 'RATE_LIMITED' },
      });
    }

    const user = isEmail
      ? await prisma.user.findUnique({ where: { email: identifier.toLowerCase() } })
      : normalizedPhone
        ? await prisma.user.findUnique({ where: { phone: normalizedPhone } })
        : null;

    if (!user || !user.passwordHash || user.state !== 'ACTIVE') {
      // Same cost as a real comparison, so response time does not say which
      // identifiers have an account — see burnPasswordCheck (J1 review).
      await burnPasswordCheck(args.password);
      throw bad();
    }
    if (!(await verifyPassword(args.password, user.passwordHash))) throw bad();

    // PD-20: only after the password has been verified, so a code alone
    // reveals nothing about an account nobody has proven they control yet.
    if (requiresSecondFactor(user) && smsAvailable(env.NODE_ENV, smsProviderConfigured)) {
      if (!user.phone) {
        throw new GraphQLError(
          'This account needs a phone number before it can sign in. Ask an administrator to set one.',
          { extensions: { code: 'PHONE_REQUIRED_FOR_STAFF' } },
        );
      }
      const factorChallengeId = await issueCode(user.id, user.phone, user.locale, 'SIGNIN_FACTOR');
      return { user: null, factorChallengeId };
    }

    setSessionCookie(ctx.res, signSession({ sub: user.id }));
    return { user };
  },

  /** PD-20: the code `signIn` sent to the account's phone. */
  verifySignInFactor: async (_p: unknown, args: { challengeId: string; code: string }, ctx: Context) => {
    const record = await prisma.authToken.findUnique({
      where: { id: args.challengeId },
      include: { user: true },
    });
    if (!record || record.purpose !== 'SIGNIN_FACTOR') throw codeInvalid();
    if (!(await checkAndConsumeCode(record, args.code))) throw codeInvalid();

    setSessionCookie(ctx.res, signSession({ sub: record.user.id }));
    return { user: record.user };
  },

  /**
   * Phone recovery, step 1. **The response never waits on the send** — both
   * branches (a real account, and none) do the same rate-limit check and
   * the same single user lookup, then return `true`; the code is created
   * and the SMS dispatched *after* the response (`setImmediate`), so timing
   * cannot distinguish an account from none. With no provider configured
   * this refuses `SMS_UNAVAILABLE` for every phone alike (PD-18) — checked
   * first, before the rate limit or the lookup, since it too must not vary
   * by whether the phone is real.
   */
  requestLoginCode: async (_p: unknown, args: { phone: string }, ctx: Context) => {
    if (!smsAvailable(env.NODE_ENV, smsProviderConfigured)) {
      throw new GraphQLError('SMS is not available right now.', {
        extensions: { code: 'SMS_UNAVAILABLE' },
      });
    }

    const normalized = normalizePhone(args.phone);
    // Rate-limited on the normalized phone when it parses, and on the raw
    // trimmed input when it does not — garbage input still costs a bounded
    // budget rather than an unlimited one, and either way the check and the
    // lookup below run identically regardless of which branch this is.
    const phoneKey = normalized ?? args.phone.trim();
    const ip = ctx.req.ip ?? 'unknown';
    if (
      !checkAll([
        { bucket: loginCodePerPhonePerMinute, key: phoneKey },
        { bucket: loginCodePerPhonePerDay, key: phoneKey },
        { bucket: loginCodePerIpPerHour, key: ip },
      ])
    ) {
      throw new GraphQLError('Too many attempts. Try again later.', {
        extensions: { code: 'RATE_LIMITED' },
      });
    }

    // The one lookup, on both branches — see this mutation's own comment.
    const user = normalized ? await prisma.user.findUnique({ where: { phone: normalized } }) : null;

    setImmediate(() => {
      if (!user || user.state !== 'ACTIVE' || !normalized) return;
      // Caught here, not left to `void`: this runs after the response, so a
      // rejection (the token insert failing) would be an unhandled rejection,
      // which terminates a Node process by default (J1 review).
      issueCode(user.id, normalized, user.locale, 'LOGIN_CODE').catch((err) => {
        console.error('[auth] requestLoginCode: could not issue a code', err);
      });
    });

    return true;
  },

  /** Phone recovery, step 2. Sets `passwordChangeRequired` (PD-10) — the
   *  account proved it controls the phone, not that it remembers the
   *  password, so the password stops being trusted until it sets a new one. */
  verifyLoginCode: async (_p: unknown, args: { phone: string; code: string }, ctx: Context) => {
    const normalized = normalizePhone(args.phone);
    const user = normalized ? await prisma.user.findUnique({ where: { phone: normalized } }) : null;
    const record = user ? await loadLatestLoginCodeToken(user.id) : null;

    if (!user || !record || !(await checkAndConsumeCode(record, args.code))) throw codeInvalid();

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordChangeRequired: true },
    });

    setSessionCookie(ctx.res, signSession({ sub: updated.id }));
    return { user: updated };
  },

  /** The one mutation an account with `passwordChangeRequired` set may
   *  still call — see context.ts's own comment on the two `requireUser*`
   *  functions. */
  setNewPassword: async (_p: unknown, args: { password: string }, ctx: Context) => {
    const user = requireUserAllowingPasswordChange(ctx);
    // Only for the forced change (J1 review). Without this, any session — a
    // stolen cookie included — could replace the password without knowing
    // the current one and lock the owner out. This mutation is the second
    // half of the SMS recovery, where the code already proved control of the
    // phone; a voluntary change, if one is ever built, asks for the current
    // password instead.
    if (!user.passwordChangeRequired) {
      throw new GraphQLError('There is no password change pending on this account.', {
        extensions: { code: 'PASSWORD_CHANGE_NOT_REQUIRED' },
      });
    }
    if (args.password.length < MIN_PASSWORD_LENGTH) {
      throw new GraphQLError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`, {
        extensions: { code: 'PASSWORD_TOO_SHORT' },
      });
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(args.password), passwordChangeRequired: false },
    });
    return { user: updated };
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
      record.expiresAt < new Date() ||
      // S3: `setUserState(DISABLED)` revokes the invite in the same
      // transaction, so this cannot normally be reached — it is the second
      // lock on a door whose first lock is a write in another file, and the
      // state change here would otherwise be a way to re-activate oneself.
      record.user.state === 'DISABLED'
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

    const resetUrl = `${env.APP_ORIGIN}/${user.locale}/portal/reset/${raw}`;
    // notify() never throws on its own — this resolver returns `true`
    // unconditionally by design (see above), and a distinguishable error
    // would leak exactly what that hides.
    await notify(user, { kind: 'PASSWORD_RESET', params: { resetUrl } });
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
      include: { user: true },
    });
    if (
      !record ||
      record.purpose !== 'PASSWORD_RESET' ||
      record.usedAt ||
      record.revokedAt ||
      record.expiresAt < new Date() ||
      // S3: this mutation sets the account ACTIVE, so a reset link issued
      // before a disable would otherwise be a way to undo it. Disabling
      // revokes it too; this is the second lock (see acceptInvite).
      record.user.state === 'DISABLED'
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
