import type { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import type { User } from '@prisma/client';
import { prisma } from './lib/prisma.js';
import { can, type Capability } from './lib/capabilities.js';
import { readSession } from './auth/tokens.js';
import { env } from './lib/env.js';

export type Context = {
  req: Request;
  res: Response;
  user: User | null;
};

export async function buildContext(req: Request, res: Response): Promise<Context> {
  const raw = req.cookies?.[env.COOKIE_NAME];
  if (!raw) return { req, res, user: null };

  const claims = readSession(raw);
  if (!claims) return { req, res, user: null };

  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  // A disabled account keeps its cookie but loses its session.
  if (!user || user.state === 'DISABLED') return { req, res, user: null };

  return { req, res, user };
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
