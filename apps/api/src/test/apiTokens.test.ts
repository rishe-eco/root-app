import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { authenticateApiToken, hashApiToken, newApiToken } from '../lib/apiTokens.js';

/**
 * Personal access tokens, end to end against a real database.
 *
 * Three rules carry the whole feature, and each one is a place it could
 * silently fail open:
 *
 *   1. **The secret is never stored.** Only its digest is, so the row cannot
 *      be replayed into access.
 *   2. **Authority is re-read on every request**, never remembered from issue
 *      time — which is what makes disabling or demoting an account sufficient
 *      to kill its tokens.
 *   3. **Scope is enforced on the operation**, before any resolver runs.
 */

let f: Fixture;

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await stop();
  await prisma.$disconnect();
});

const CREATE = `
  mutation Create($name: String!, $scope: ApiTokenScope!, $expiresInDays: Int) {
    createApiToken(name: $name, scope: $scope, expiresInDays: $expiresInDays) {
      token
      apiToken { id name prefix scope expiresAt revokedAt lastUsedAt }
    }
  }
`;

const LIST = `query { myApiTokens { id name prefix scope revokedAt } }`;
const REVOKE = `mutation Revoke($id: ID!) { revokeApiToken(id: $id) { id revokedAt } }`;

/** Issues a token to a user directly, bypassing the mutation — for the tests
 *  that are about *using* a token rather than about creating one. */
async function issue(
  userId: string,
  overrides: Partial<{ scope: 'READ' | 'WRITE'; expiresAt: Date | null; revokedAt: Date | null }> = {},
) {
  const { raw, hash, prefix } = newApiToken();
  const row = await prisma.apiToken.create({
    data: {
      userId,
      name: 'test token',
      tokenHash: hash,
      prefix,
      scope: overrides.scope ?? 'READ',
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  });
  return { raw, row };
}

// --- who may issue one ------------------------------------------------------

test('an admin can create a token, and gets the secret exactly once', async () => {
  const data = ok(
    await exec(CREATE, { as: f.admin, variables: { name: 'ci', scope: 'READ', expiresInDays: null } }),
  );
  const created = data.createApiToken as {
    token: string;
    apiToken: { id: string; prefix: string; scope: string; expiresAt: string | null };
  };

  assert.ok(created.token.startsWith('root_'));
  assert.equal(created.apiToken.scope, 'READ');
  assert.equal(created.apiToken.expiresAt, null);
  assert.ok(created.token.startsWith(created.apiToken.prefix));

  // …and the list, which is the only other way to see a token, cannot return it.
  const listed = ok(await exec(LIST, { as: f.admin })).myApiTokens as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(created.token));
});

test('what lands in the database is the digest, not the token', async () => {
  const data = ok(
    await exec(CREATE, { as: f.admin, variables: { name: 'ci', scope: 'READ', expiresInDays: null } }),
  );
  const { token } = data.createApiToken as { token: string };

  const row = await prisma.apiToken.findFirstOrThrow();
  assert.equal(row.tokenHash, hashApiToken(token));
  assert.notEqual(row.tokenHash, token);
  // The whole row, serialized, must not contain the secret anywhere.
  assert.ok(!JSON.stringify(row).includes(token.slice('root_'.length)));
});

test('a customer cannot create a token', async () => {
  const res = await exec(CREATE, {
    as: f.customer,
    variables: { name: 'nope', scope: 'WRITE', expiresInDays: null },
  });
  assert.equal(res.code, 'FORBIDDEN');
  assert.equal(await prisma.apiToken.count(), 0);
});

test('an anonymous caller cannot create a token', async () => {
  const res = await exec(CREATE, {
    as: null,
    variables: { name: 'nope', scope: 'WRITE', expiresInDays: null },
  });
  assert.equal(res.code, 'UNAUTHENTICATED');
});

test('a contributor cannot create a token — the capability is not implied by staff', async () => {
  const contributor = await prisma.user.create({
    data: { email: 'c@test.local', name: 'C', roles: ['CONTRIBUTOR'], state: 'ACTIVE' },
  });
  const res = await exec(CREATE, {
    as: contributor,
    variables: { name: 'nope', scope: 'READ', expiresInDays: null },
  });
  assert.equal(res.code, 'FORBIDDEN');
});

// --- a token may not mint a token -------------------------------------------

test('a token cannot create another token, however privileged its owner', async () => {
  const res = await exec(CREATE, {
    as: f.admin,
    auth: { kind: 'apiToken', tokenId: 'tok_1', scope: 'WRITE' },
    variables: { name: 'second', scope: 'WRITE', expiresInDays: null },
  });
  // Not FORBIDDEN — the caller does hold the capability. The refusal is about
  // the credential, and says so, or an admin would be left thinking their
  // account had lost a permission.
  assert.equal(res.code, 'SESSION_REQUIRED');
  assert.equal(await prisma.apiToken.count(), 0);
});

test('a token cannot revoke or even list tokens', async () => {
  const { row } = await issue(f.admin.id);
  const tokenAuth = { kind: 'apiToken' as const, tokenId: row.id, scope: 'WRITE' as const };

  assert.equal((await exec(LIST, { as: f.admin, auth: tokenAuth })).code, 'SESSION_REQUIRED');
  assert.equal(
    (await exec(REVOKE, { as: f.admin, auth: tokenAuth, variables: { id: row.id } })).code,
    'SESSION_REQUIRED',
  );
});

// --- input ------------------------------------------------------------------

test('a blank name is refused, before a row exists', async () => {
  const res = await exec(CREATE, {
    as: f.admin,
    variables: { name: '   ', scope: 'READ', expiresInDays: null },
  });
  assert.equal(res.code, 'NAME_REQUIRED');
  assert.equal(await prisma.apiToken.count(), 0);
});

test('a name is stored trimmed', async () => {
  ok(await exec(CREATE, { as: f.admin, variables: { name: '  ci  ', scope: 'READ', expiresInDays: null } }));
  const row = await prisma.apiToken.findFirstOrThrow();
  assert.equal(row.name, 'ci');
});

test('an expiry of zero days is refused rather than producing a dead token', async () => {
  const res = await exec(CREATE, {
    as: f.admin,
    variables: { name: 'ci', scope: 'READ', expiresInDays: 0 },
  });
  assert.equal(res.code, 'EXPIRY_INVALID');
  assert.equal(await prisma.apiToken.count(), 0);
});

test('an absurd expiry is refused rather than overflowing into an invalid date', async () => {
  const res = await exec(CREATE, {
    as: f.admin,
    variables: { name: 'ci', scope: 'READ', expiresInDays: 100_000_000 },
  });
  assert.equal(res.code, 'EXPIRY_TOO_FAR');
});

// --- authenticating ---------------------------------------------------------

test('a live token authenticates as its owner and records the use', async () => {
  const { raw, row } = await issue(f.admin.id, { scope: 'WRITE' });
  assert.equal(row.lastUsedAt, null);

  const authed = await authenticateApiToken(prisma, raw);
  assert.ok(authed);
  assert.equal(authed.user.id, f.admin.id);
  assert.equal(authed.scope, 'WRITE');

  const after = await prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } });
  assert.notEqual(after.lastUsedAt, null);
});

test('an unknown token is nobody', async () => {
  assert.equal(await authenticateApiToken(prisma, 'root_not-a-real-token'), null);
});

test('a revoked token is nobody', async () => {
  const { raw } = await issue(f.admin.id, { revokedAt: new Date() });
  assert.equal(await authenticateApiToken(prisma, raw), null);
});

test('an expired token is nobody', async () => {
  const { raw } = await issue(f.admin.id, { expiresAt: new Date(Date.now() - 1000) });
  assert.equal(await authenticateApiToken(prisma, raw), null);
});

test('a token whose owner was disabled is nobody', async () => {
  const { raw } = await issue(f.admin.id);
  await prisma.user.update({ where: { id: f.admin.id }, data: { state: 'DISABLED' } });
  assert.equal(await authenticateApiToken(prisma, raw), null);
});

test('demoting the owner kills the token, with nobody having to revoke it', async () => {
  // The property the whole design rests on: authority is re-read per request,
  // never carried in the credential. An admin who becomes a plain customer
  // loses their tokens in the same instant.
  const { raw } = await issue(f.admin.id);
  assert.ok(await authenticateApiToken(prisma, raw));

  await prisma.user.update({ where: { id: f.admin.id }, data: { roles: ['CUSTOMER'] } });
  assert.equal(await authenticateApiToken(prisma, raw), null);
});

test('the revoked row survives revocation — it is the record that the token existed', async () => {
  const { row } = await issue(f.admin.id);
  ok(await exec(REVOKE, { as: f.admin, variables: { id: row.id } }));

  const after = await prisma.apiToken.findUnique({ where: { id: row.id } });
  assert.ok(after, 'revocation must not delete the row');
  assert.notEqual(after.revokedAt, null);
});

// --- scope ------------------------------------------------------------------

test('a read-only token is refused a mutation, before the resolver runs', async () => {
  const res = await exec(
    `mutation { signOut }`,
    { as: f.admin, auth: { kind: 'apiToken', tokenId: 't', scope: 'READ' } },
  );
  assert.equal(res.code, 'TOKEN_READ_ONLY');
});

test('a read-only token may still query', async () => {
  const data = ok(
    await exec(`query { me { id } }`, {
      as: f.admin,
      auth: { kind: 'apiToken', tokenId: 't', scope: 'READ' },
    }),
  );
  assert.equal((data.me as { id: string }).id, f.admin.id);
});

test('a write-scoped token may mutate', async () => {
  const data = ok(
    await exec(`mutation { signOut }`, {
      as: f.admin,
      auth: { kind: 'apiToken', tokenId: 't', scope: 'WRITE' },
    }),
  );
  assert.equal(data.signOut, true);
});

test('a session is never scope-limited — a cookie has no scope to limit', async () => {
  const data = ok(await exec(`mutation { signOut }`, { as: f.admin }));
  assert.equal(data.signOut, true);
});

// --- ownership --------------------------------------------------------------

test('one admin cannot revoke another admin’s token, and is not told it exists', async () => {
  const other = await prisma.user.create({
    data: { email: 'admin2@test.local', name: 'Admin Two', roles: ['ADMIN'], state: 'ACTIVE' },
  });
  const { row } = await issue(other.id);

  const res = await exec(REVOKE, { as: f.admin, variables: { id: row.id } });
  // The same answer a made-up id gets, which is what keeps this from
  // confirming that the id is real.
  assert.equal(res.code, 'TOKEN_NOT_FOUND');
  assert.equal(
    (await exec(REVOKE, { as: f.admin, variables: { id: 'nope' } })).code,
    'TOKEN_NOT_FOUND',
  );

  const after = await prisma.apiToken.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.revokedAt, null);
});

test('the list shows only the caller’s own tokens', async () => {
  const other = await prisma.user.create({
    data: { email: 'admin3@test.local', name: 'Admin Three', roles: ['ADMIN'], state: 'ACTIVE' },
  });
  await issue(f.admin.id);
  await issue(other.id);

  const mine = ok(await exec(LIST, { as: f.admin })).myApiTokens as unknown[];
  assert.equal(mine.length, 1);
});

test('revoking twice is idempotent, not an error', async () => {
  const { row } = await issue(f.admin.id);
  const first = ok(await exec(REVOKE, { as: f.admin, variables: { id: row.id } }));
  const second = ok(await exec(REVOKE, { as: f.admin, variables: { id: row.id } }));

  const revokedAtOf = (d: Record<string, unknown>) =>
    (d.revokeApiToken as { revokedAt: string }).revokedAt;
  assert.notEqual(revokedAtOf(first), null);
  // The same instant, not a fresh one — the second call changed nothing.
  assert.equal(revokedAtOf(first), revokedAtOf(second));
});
