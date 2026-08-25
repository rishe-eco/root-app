import { GraphQLError } from 'graphql';
import type { ApiTokenScope } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { requireSessionCapability, type Context } from '../../context.js';
import { expiryFromDays, newApiToken } from '../../lib/apiTokens.js';

/**
 * Issuing and revoking personal access tokens.
 *
 * Its own file rather than a section of `admin.ts`, and the split is the one
 * `resolvers/index.ts` describes: those resolvers are guarded by capability
 * and write contract drafts, these are guarded by capability *and a session*
 * and write credentials. Different rule, different blast radius.
 *
 * **Everything here is scoped to the caller's own tokens.** There is no
 * `allApiTokens`, and no `revokeApiToken(userId:)`. An admin who needs
 * someone else's access gone has a bigger instrument — disable the account,
 * or take away the role — and both work instantly, because
 * `authenticateApiToken` re-reads state on every request. Adding a
 * reach-across-accounts verb would buy nothing those two do not already
 * cover, and would make a leaked admin token able to lock out other admins.
 */

/** Long enough to be descriptive, short enough to stay readable in a table. */
const MAX_NAME_LENGTH = 60;

/**
 * Ten years. Not a policy about how long a credential should live — an
 * expiry is optional here — but a guard against `expiresInDays` arriving as
 * something that overflows a Date and silently produces `Invalid Date`, which
 * Postgres would then refuse with an error about nothing the caller can see.
 */
const MAX_EXPIRY_DAYS = 3650;

export const apiTokenQueries = {
  myApiTokens: async (_p: unknown, _a: unknown, ctx: Context) => {
    // Session-gated like the two mutations, though this one only reads. The
    // whole surface is "manage your own credentials", and it is reached from
    // one browser screen; letting a token read the list would mean a leaked
    // token could enumerate its siblings — telling an attacker which other
    // credentials to look for and which are stale enough to go unnoticed.
    const user = requireSessionCapability(ctx, 'apiTokens.manage');
    return prisma.apiToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
  },
};

export const apiTokenMutations = {
  createApiToken: async (
    _p: unknown,
    args: { name: string; scope: ApiTokenScope; expiresInDays?: number | null },
    ctx: Context,
  ) => {
    const user = requireSessionCapability(ctx, 'apiTokens.manage');

    const name = args.name.trim();
    if (name === '') {
      throw new GraphQLError('Give the token a name, so you can tell it apart later.', {
        extensions: { code: 'NAME_REQUIRED' },
      });
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new GraphQLError(`A token name is at most ${MAX_NAME_LENGTH} characters.`, {
        extensions: { code: 'NAME_TOO_LONG' },
      });
    }

    if (args.expiresInDays != null && args.expiresInDays > MAX_EXPIRY_DAYS) {
      throw new GraphQLError(`An expiry is at most ${MAX_EXPIRY_DAYS} days out.`, {
        extensions: { code: 'EXPIRY_TOO_FAR' },
      });
    }

    let expiresAt: Date | null;
    try {
      expiresAt = expiryFromDays(args.expiresInDays);
    } catch {
      // A RangeError from the helper means the input was not a usable number
      // of days. Rewritten rather than propagated: the helper's message is
      // written for a caller reading a stack trace, not for a person.
      throw new GraphQLError('An expiry must be a whole number of days, at least 1.', {
        extensions: { code: 'EXPIRY_INVALID' },
      });
    }

    const { raw, hash, prefix } = newApiToken();
    const apiToken = await prisma.apiToken.create({
      data: { userId: user.id, name, tokenHash: hash, prefix, scope: args.scope, expiresAt },
    });

    // The only return of `raw` anywhere. It is deliberately not logged, not
    // put in the ChangeLog, and not mailed — every one of those would be a
    // second copy of a secret whose whole design is that only one exists.
    return { apiToken, token: raw };
  },

  revokeApiToken: async (_p: unknown, args: { id: string }, ctx: Context) => {
    const user = requireSessionCapability(ctx, 'apiTokens.manage');

    // Found by id *and* owner, in one query rather than a load-then-compare.
    // Someone else's token id and a nonexistent one give the same answer,
    // which is what keeps this from confirming that an id is real.
    const existing = await prisma.apiToken.findFirst({
      where: { id: args.id, userId: user.id },
    });
    if (!existing) {
      throw new GraphQLError('No such token.', { extensions: { code: 'TOKEN_NOT_FOUND' } });
    }

    if (existing.revokedAt !== null) return existing;

    return prisma.apiToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    });
  },
};
