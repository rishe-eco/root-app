import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../lib/env.js';

export type SessionClaims = { sub: string; role: 'CUSTOMER' | 'ADMIN' };

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
