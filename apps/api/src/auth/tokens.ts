import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';

/**
 * Just the subject. There used to be a `role` claim beside it, and it was
 * decorative — `buildContext` has always read `sub` and re-loaded the user from
 * the database, so nothing ever consulted it. Under a role *set* a decorative
 * copy stops being harmless: it is a snapshot of someone's permissions taken
 * when they signed in, sitting in a cookie that outlives any change to them.
 * Dropping it costs nothing and removes the temptation to trust it. Cookies
 * issued before this still verify; the extra claim is simply ignored.
 */
export type SessionClaims = { sub: string };

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: `${env.SESSION_DAYS}d` });
}

export function readSession(token: string): SessionClaims | null {
  try {
    return jwt.verify(token, env.JWT_SECRET) as SessionClaims;
  } catch {
    return null;
  }
}

/**
 * Invite and reset links. The raw token is returned once, for the link; only
 * its hash is stored, so a database leak cannot be replayed into an account.
 */
export function newLinkToken() {
  const raw = crypto.randomBytes(32).toString('base64url');
  return { raw, hash: hashToken(raw) };
}

export const hashToken = (raw: string) =>
  crypto.createHash('sha256').update(raw).digest('hex');
