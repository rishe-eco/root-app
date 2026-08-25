/**
 * Personal access tokens — the second way into this API.
 *
 * Until now there was exactly one: the session cookie, minted by `signIn` and
 * read by `buildContext`. That is the right credential for a browser and the
 * wrong one for everything else — a script, a cron job, an operator with curl
 * — because obtaining it means holding a password and completing a login.
 *
 * **Why a random secret and not a signed token.** A JWT would need no table,
 * which is exactly the problem: a credential that lives for months has to be
 * revocable, and revoking a JWT means keeping a list of the revoked ones,
 * which is the table you were avoiding, only now it is the unhappy path. So
 * the token is opaque, the row is the credential, and revocation is a column.
 *
 * **Why the digest is unsalted.** Password hashing is slow on purpose because
 * a password is low-entropy and guessable. These are 32 bytes of CSPRNG
 * output; there is nothing to guess, so a slow KDF would buy no security and
 * would cost a comparison against every row instead of one indexed lookup.
 * This is the same reasoning `auth/tokens.ts` already applies to invite links.
 */

import crypto from 'node:crypto';
import type { PrismaClient, User } from '@prisma/client';
import { can } from './capabilities.js';

/**
 * Marks a value as a Root API token wherever it turns up — a log line, a
 * pasted support ticket, a secret scanner's ruleset. It also lets
 * `buildContext` tell a token from a session cookie without a database read.
 */
export const TOKEN_PREFIX = 'root_';

/** How much of the token stays readable, so a listed token is identifiable. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 8;

/** 32 bytes. Base64url of that is 43 characters — no padding, URL- and
 *  header-safe, and far past anything worth trying to guess. */
const SECRET_BYTES = 32;

export const hashApiToken = (raw: string) =>
  crypto.createHash('sha256').update(raw).digest('hex');

export const looksLikeApiToken = (value: string) => value.startsWith(TOKEN_PREFIX);

/**
 * The raw token exists exactly once, here. Everything downstream stores or
 * compares the digest.
 */
export function newApiToken(): { raw: string; hash: string; prefix: string } {
  const raw = TOKEN_PREFIX + crypto.randomBytes(SECRET_BYTES).toString('base64url');
  return { raw, hash: hashApiToken(raw), prefix: raw.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/**
 * Constant-time digest comparison.
 *
 * The lookup is already by unique digest, so this is not what decides the
 * match — it is what keeps *how long the decision took* from being an oracle.
 * `timingSafeEqual` throws on a length mismatch, which would leak the very
 * thing it exists to hide, so the lengths are checked first and equal-length
 * buffers are all it ever sees.
 */
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

export type ApiTokenAuth = {
  user: User;
  tokenId: string;
  scope: 'READ' | 'WRITE';
};

/**
 * Resolve a raw token to its owner, or null if it is unknown, revoked,
 * expired, or no longer allowed.
 *
 * **Four ways to fail, one answer.** The caller gets null for all of them and
 * `buildContext` turns that into "you are nobody". Distinguishing them would
 * tell an attacker holding a stale token which kind of stale it is, and would
 * tell someone holding a *guess* that they had guessed a real row.
 *
 * **The capability is re-read, not remembered.** A token is issued to someone
 * who held `apiTokens.manage` at the time; this checks they still do, on every
 * request. That is what makes demotion sufficient — an account that loses ADMIN
 * loses its tokens in the same instant, with nobody having to remember that the
 * tokens existed. It is the same principle that made `SessionClaims` drop its
 * `role` claim: permissions are read from the user, never carried in the
 * credential.
 */
export async function authenticateApiToken(
  prisma: PrismaClient,
  raw: string,
): Promise<ApiTokenAuth | null> {
  const hash = hashApiToken(raw);
  const record = await prisma.apiToken.findUnique({
    where: { tokenHash: hash },
    include: { user: true },
  });

  if (!record) return null;
  if (!digestsMatch(record.tokenHash, hash)) return null;
  if (record.revokedAt !== null) return null;
  if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) return null;

  // The same two checks the cookie path makes, for the same reasons: a
  // disabled account keeps its credentials and loses its access, and staff
  // surfaces are capability-gated rather than role-compared.
  if (record.user.state === 'DISABLED') return null;
  if (!can(record.user, 'apiTokens.manage')) return null;

  // Bookkeeping, and bookkeeping only: a write that fails here must not turn
  // a valid request into a rejected one. Deliberately not awaited into the
  // request's critical path beyond the catch — see the note in context.ts.
  await prisma.apiToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { user: record.user, tokenId: record.id, scope: record.scope };
}

/**
 * `expiresInDays` → a concrete instant, or null for a token that does not
 * expire.
 *
 * Rejecting zero and negative values matters more than it looks: an
 * already-expired token is not a short-lived one, it is a token that never
 * works, and returning it as though it did would send someone debugging their
 * client instead of their input.
 */
export function expiryFromDays(days: number | null | undefined): Date | null {
  if (days === null || days === undefined) return null;
  if (!Number.isInteger(days) || days < 1) {
    throw new RangeError('expiresInDays must be a whole number of days, at least 1.');
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}
