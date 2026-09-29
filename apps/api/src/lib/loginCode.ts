import crypto from 'node:crypto';
import { env } from './env.js';

/**
 * The six-digit code behind both `requestLoginCode`/`verifyLoginCode` (phone
 * recovery) and `signIn`/`verifySignInFactor` (the staff second factor) —
 * one shape, one file, because a code is a code whichever `TokenPurpose` it
 * is stored under (journeys build plan J1).
 */

/** A six-digit space is a lookup table waiting to be built — 5 minutes and
 *  a handful of attempts is what keeps it from being worth building. */
export const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;

/**
 * `crypto.randomInt`, not `Math.random()` — this is a credential, however
 * short-lived. Zero-padded so every code is exactly six characters; the
 * leading digit is exactly as likely to be zero as any other, which
 * `padStart` alone does not guarantee unless the draw already covers the
 * full range `[0, 1_000_000)`, which it does.
 */
export function generateLoginCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * `HMAC(JWT_SECRET, tokenId ‖ code)`, not a bare hash of the code alone — a
 * bare hash of a six-digit space is exactly 1,000,000 rows, a table built
 * once and replayed against every future code forever. Keying it to
 * `JWT_SECRET` makes the table worthless without that secret too, and keying
 * it to the token's own id as well means the same code sent for two
 * different challenges hashes differently — a leaked hash for one `AuthToken`
 * row proves nothing about another.
 */
export function hashLoginCode(tokenId: string, code: string): string {
  return crypto.createHmac('sha256', env.JWT_SECRET).update(`${tokenId}:${code}`).digest('hex');
}

/** `Date.now() + LOGIN_CODE_TTL_MS`, pulled out only so a test can pass a
 *  fixed `now` rather than racing the clock. */
export function loginCodeExpiresAt(now: number = Date.now()): Date {
  return new Date(now + LOGIN_CODE_TTL_MS);
}

export type LoginCodeRow = {
  tokenHash: string;
  attempts: number;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
};

/**
 * The one check both `verifyLoginCode` and `verifySignInFactor` run against
 * whatever `AuthToken` row they loaded — pulled out because the two
 * resolvers otherwise repeat the same five-way "is this code still good"
 * question with the same one wrong answer (`CODE_INVALID`) for every way it
 * can fail (house rule 3: a rule that appears twice is one rule with two
 * copies to keep in step). Never distinguishes *why* a code failed in its
 * return value — wrong, expired, already used, and exhausted all read the
 * same to whoever is guessing.
 */
export function loginCodeIsValid(row: LoginCodeRow, code: string, tokenId: string, now: number = Date.now()): boolean {
  if (row.usedAt || row.revokedAt) return false;
  if (row.expiresAt.getTime() < now) return false;
  if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return false;
  return row.tokenHash === hashLoginCode(tokenId, code);
}
