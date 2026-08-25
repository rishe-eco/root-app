import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import type { User } from '@prisma/client';
import { prisma } from './lib/prisma.js';
import { can, type Capability } from './lib/capabilities.js';
import { readSession } from './auth/tokens.js';
import { authenticateApiToken, looksLikeApiToken } from './lib/apiTokens.js';
import { env } from './lib/env.js';

/**
 * *How* the caller proved who they are — never *whether*, which is `user`.
 *
 * The two are kept apart because almost nothing should care about this. A
 * resolver asking "am I allowed to do this" must ask a capability, not a
 * credential; the handful of places that legitimately care are the ones where
 * the credential itself is the subject (scope, and minting a new token), and
 * they are easier to audit for being few.
 *
 * Null means anonymous, which is a third thing and not a kind of session.
 */
export type Auth =
  | { kind: 'session' }
  | { kind: 'apiToken'; tokenId: string; scope: 'READ' | 'WRITE' };

export type Context = {
  req: Request;
  res: Response;
  user: User | null;
  auth: Auth | null;
};

/** `Authorization: Bearer …`, or null. Case-insensitive on the scheme, because
 *  the header's grammar says it is and clients take that at their word. */
function bearer(req: Request): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  return rest.join(' ').trim() || null;
}

/**
 * One notion of who the caller is, for both credentials and every surface.
 *
 * **The bearer header is read first, and that ordering is deliberate.** A
 * scripted client may well be running with a stale cookie in the same jar;
 * if the cookie won, the token's scope would be silently bypassed and the
 * caller would get session privileges from a credential they meant to
 * restrict. Presenting a token means being judged as that token — including
 * being rejected as one, rather than falling back to the cookie, since a
 * silent downgrade to a *different* identity is the surprise worth avoiding.
 */
export async function buildContext(req: Request, res: Response): Promise<Context> {
  const presented = bearer(req);
  if (presented !== null) {
    if (!looksLikeApiToken(presented)) return { req, res, user: null, auth: null };
    const authed = await authenticateApiToken(prisma, presented);
    if (!authed) return { req, res, user: null, auth: null };
    return {
      req,
      res,
      user: authed.user,
      auth: { kind: 'apiToken', tokenId: authed.tokenId, scope: authed.scope },
    };
  }

  const raw = req.cookies?.[env.COOKIE_NAME];
  if (!raw) return { req, res, user: null, auth: null };

  const claims = readSession(raw);
  if (!claims) return { req, res, user: null, auth: null };

  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  // A disabled account keeps its cookie but loses its session.
  if (!user || user.state === 'DISABLED') return { req, res, user: null, auth: null };

  return { req, res, user, auth: { kind: 'session' } };
}

export function requireUser(ctx: Context): User {
  if (!ctx.user) {
    throw new GraphQLError('You need to sign in.', { extensions: { code: 'UNAUTHENTICATED' } });
  }
  return ctx.user;
}

/**
 * The guard. It replaced `requireRole`, and the replacement is not cosmetic:
 * `requireRole` compared one role for equality, which is the single check that
 * cannot survive a user holding two. See lib/capabilities.ts.
 *
 * This is a *surface* guard only. It says the caller may use the thing at all;
 * it says nothing about which rows they then see, which stays with the
 * ownership edges in `loadForActor`.
 */
export function requireCapability(ctx: Context, capability: Capability): User {
  const user = requireUser(ctx);
  if (!can(user, capability)) {
    throw new GraphQLError('You do not have access to that.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  return user;
}

/**
 * Capability, *and* a browser session behind it.
 *
 * For the small set of acts that manage credentials themselves. A token that
 * could mint or revoke tokens would be self-renewing: one leak stops being an
 * incident with an end and becomes standing access that survives revoking the
 * token that started it, because by then it has issued others. Requiring the
 * cookie means those acts always cost a password.
 *
 * The order matters — capability first, so someone without it gets FORBIDDEN
 * whichever credential they used, rather than being told that a different
 * credential might have worked.
 */
export function requireSessionCapability(ctx: Context, capability: Capability): User {
  const user = requireCapability(ctx, capability);
  if (ctx.auth?.kind !== 'session') {
    throw new GraphQLError('API tokens cannot manage API tokens. Sign in to do that.', {
      extensions: { code: 'SESSION_REQUIRED' },
    });
  }
  return user;
}

export const setSessionCookie = (res: Response, token: string) =>
  res.cookie(env.COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    maxAge: env.SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });

export const clearSessionCookie = (res: Response) =>
  res.clearCookie(env.COOKIE_NAME, { path: '/' });
