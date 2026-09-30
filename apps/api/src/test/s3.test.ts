import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFileServer, upload } from './http.js';
import { buildContext } from '../context.js';
import { env } from '../lib/env.js';
import { signSession, newLinkToken } from '../auth/tokens.js';
import { capabilitiesOf } from '../lib/capabilities.js';
import { authenticateApiToken, newApiToken } from '../lib/apiTokens.js';
import { loadCustomerProfile } from '../graphql/resolvers/people.js';

/**
 * S3 — customer and staff management (journeys build plan §5 "S3").
 *
 * The plan's traps, each proved where it can actually bite: disabling is not
 * revoking invites; a mixed customer-and-staff account is a staff account;
 * the last administrator cannot be removed even by two of them at once; a
 * revoked tool is "no such thing" to the customer holding a stale tab; the
 * partial unique index by a direct insert, not only through the resolver.
 */

const PASSWORD = 'a-long-enough-password';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let f: Fixture;
let base: string;
let close: () => Promise<void>;

before(async () => {
  await resetDatabase();
  ({ base, close } = await startFileServer());
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
});

after(async () => {
  await close();
  await stop();
  await prisma.$disconnect();
});

let seq = 0;
async function makeUser(roles: Role[], overrides: Partial<User> = {}): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: {
      email: `person${seq}@test.local`,
      phone: `+98912000${String(9000 + seq)}`,
      name: `Person ${seq}`,
      roles,
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      ...overrides,
    },
  });
}

const sales = () => makeUser(['SALES']);
const admin2 = () => makeUser(['ADMIN']);

const SET_STATE = `mutation($userId: ID!, $state: UserState!) { setUserState(userId: $userId, state: $state) { id state } }`;
const SET_ROLES = `mutation($userId: ID!, $roles: [Role!]!) { setUserRoles(userId: $userId, roles: $roles) { id roles capabilities } }`;
const INVITE_STAFF = `
  mutation($name: String!, $roles: [Role!]!, $phone: String, $email: String) {
    inviteStaff(name: $name, roles: $roles, phone: $phone, email: $email) { userId email inviteUrl expiresAt }
  }
`;
const GRANT = `mutation($customerId: ID!) { grantTool(customerId: $customerId, tool: PRODUCT_IMPORT) { grants { id tool grantedBy { id } } } }`;
const REVOKE = `mutation($customerId: ID!) { revokeTool(customerId: $customerId, tool: PRODUCT_IMPORT) { grants { id tool } } }`;
const CUSTOMER = `
  query($id: ID!) {
    customer(id: $id) {
      id
      user { id name state roles }
      grants { tool }
      contracts { id ref }
      tickets { id }
      invoices { totalIssued totalPaid totalOutstanding }
    }
  }
`;

// --- setUserState: who may, and what it does --------------------------------

test('sales disables and restores a customer', async () => {
  const s = await sales();
  const off = ok(await exec(SET_STATE, { as: s, variables: { userId: f.customer.id, state: 'DISABLED' } }));
  assert.equal((off.setUserState as { state: string }).state, 'DISABLED');
  const on = ok(await exec(SET_STATE, { as: s, variables: { userId: f.customer.id, state: 'ACTIVE' } }));
  assert.equal((on.setUserState as { state: string }).state, 'ACTIVE');
});

test('disabling kills the session on the next request (buildContext)', async () => {
  const cookie = signSession({ sub: f.customer.id });
  const req = () => ({ cookies: { [env.COOKIE_NAME]: cookie }, headers: {} }) as never;
  const res = {} as never;

  const before = await buildContext(req(), res);
  assert.equal(before.user?.id, f.customer.id, 'the cookie works while the account is active');

  ok(await exec(SET_STATE, { as: await sales(), variables: { userId: f.customer.id, state: 'DISABLED' } }));

  const after = await buildContext(req(), res);
  assert.equal(after.user, null, 'the same cookie, one request later, is nobody');

  ok(await exec(SET_STATE, { as: await sales(), variables: { userId: f.customer.id, state: 'ACTIVE' } }));
  assert.equal((await buildContext(req(), res)).user?.id, f.customer.id, 'restoring brings the cookie back to life');
});

test('an API token stops working the moment its owner is disabled, and works again when they are restored', async () => {
  const { raw, hash, prefix } = newApiToken();
  await prisma.apiToken.create({ data: { userId: f.admin.id, name: 't', tokenHash: hash, prefix, scope: 'READ' } });
  const other = await admin2();
  assert.notEqual(await authenticateApiToken(prisma, raw), null);
  ok(await exec(SET_STATE, { as: other, variables: { userId: f.admin.id, state: 'DISABLED' } }));
  assert.equal(await authenticateApiToken(prisma, raw), null);
  ok(await exec(SET_STATE, { as: other, variables: { userId: f.admin.id, state: 'ACTIVE' } }));
  assert.notEqual(await authenticateApiToken(prisma, raw), null);
});

test('disabling revokes every outstanding token — invite, reset, login code, sign-in factor — in one go', async () => {
  const invitee = await makeUser(['CUSTOMER'], { state: 'INVITED', passwordHash: null });
  const raws: Record<string, string> = {};
  for (const purpose of ['INVITE', 'PASSWORD_RESET', 'LOGIN_CODE', 'SIGNIN_FACTOR'] as const) {
    const { raw, hash } = newLinkToken();
    raws[purpose] = raw;
    await prisma.authToken.create({
      data: { userId: invitee.id, purpose, tokenHash: hash, expiresAt: new Date(Date.now() + 3_600_000) },
    });
  }
  // One already used: must stay exactly as it was (not "revoked" retroactively).
  const usedHash = newLinkToken().hash;
  const usedAt = new Date('2026-01-01T00:00:00Z');
  await prisma.authToken.create({
    data: { userId: invitee.id, purpose: 'INVITE', tokenHash: usedHash, expiresAt: new Date(Date.now() + 3_600_000), usedAt },
  });

  ok(await exec(SET_STATE, { as: await sales(), variables: { userId: invitee.id, state: 'DISABLED' } }));

  const tokens = await prisma.authToken.findMany({ where: { userId: invitee.id } });
  assert.equal(tokens.length, 5);
  for (const t of tokens) {
    if (t.tokenHash === usedHash) assert.equal(t.revokedAt, null, 'a used token is history, not revoked');
    else assert.notEqual(t.revokedAt, null, `${t.purpose} must be revoked`);
  }

  // …and the revocation is what the mutations actually read.
  const accept = await exec(
    `mutation($token: String!) { acceptInvite(token: $token, name: "X", password: "${PASSWORD}") { user { id } } }`,
    { variables: { token: raws.INVITE } },
  );
  assert.equal(accept.code, 'TOKEN_INVALID');
  const reset = await exec(
    `mutation($token: String!) { resetPassword(token: $token, password: "${PASSWORD}") { user { id } } }`,
    { variables: { token: raws.PASSWORD_RESET } },
  );
  assert.equal(reset.code, 'TOKEN_INVALID');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).state, 'DISABLED');
});

test('the second lock: even an un-revoked invite or reset link cannot re-activate a disabled account', async () => {
  const invitee = await makeUser(['CUSTOMER'], { state: 'DISABLED', passwordHash: null });
  const invite = newLinkToken();
  const reset = newLinkToken();
  const expiresAt = new Date(Date.now() + 3_600_000);
  await prisma.authToken.create({ data: { userId: invitee.id, purpose: 'INVITE', tokenHash: invite.hash, expiresAt } });
  await prisma.authToken.create({ data: { userId: invitee.id, purpose: 'PASSWORD_RESET', tokenHash: reset.hash, expiresAt } });

  const a = await exec(
    `mutation($t: String!) { acceptInvite(token: $t, name: "X", password: "${PASSWORD}") { user { id } } }`,
    { variables: { t: invite.raw } },
  );
  const r = await exec(
    `mutation($t: String!) { resetPassword(token: $t, password: "${PASSWORD}") { user { id } } }`,
    { variables: { t: reset.raw } },
  );
  assert.equal(a.code, 'TOKEN_INVALID');
  assert.equal(r.code, 'TOKEN_INVALID');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).state, 'DISABLED');
});

test('a disabled account cannot be invited back in; it has to be restored first', async () => {
  const s = await sales();
  const gone = await makeUser(['CUSTOMER'], { state: 'DISABLED', phone: '+989121110001' });
  const res = await exec(
    `mutation { inviteCustomer(phone: "${gone.phone}", name: "Again") { userId } }`,
    { as: s },
  );
  assert.equal(res.code, 'ACCOUNT_DISABLED');
});

test('restoring an account that never accepted its invite returns it to INVITED, not to a passwordless ACTIVE', async () => {
  const s = await sales();
  const pending = await makeUser(['CUSTOMER'], { state: 'INVITED', passwordHash: null });
  ok(await exec(SET_STATE, { as: s, variables: { userId: pending.id, state: 'DISABLED' } }));
  const restored = ok(await exec(SET_STATE, { as: s, variables: { userId: pending.id, state: 'ACTIVE' } }));
  assert.equal((restored.setUserState as { state: string }).state, 'INVITED');
});

test('INVITED is not a state anyone can set', async () => {
  const res = await exec(SET_STATE, { as: await sales(), variables: { userId: f.customer.id, state: 'INVITED' } });
  assert.equal(res.code, 'INVALID_STATE');
});

test('nobody disables themselves (CANNOT_DISABLE_SELF)', async () => {
  const res = await exec(SET_STATE, { as: f.admin, variables: { userId: f.admin.id, state: 'DISABLED' } });
  assert.equal(res.code, 'CANNOT_DISABLE_SELF');
  // Sales is a staff account, so it is not sales's to disable at all — the
  // capability answer comes first and needs no special case for "self".
  const s = await sales();
  const res2 = await exec(SET_STATE, { as: s, variables: { userId: s.id, state: 'DISABLED' } });
  assert.equal(res2.code, 'FORBIDDEN');
});

test('a missing account is NOT_FOUND to staff.manage; and nothing is looked up for a caller with neither capability', async () => {
  const missing = await exec(SET_STATE, { as: f.admin, variables: { userId: 'nope', state: 'DISABLED' } });
  assert.equal(missing.code, 'NOT_FOUND');
  // Checked before any lookup: a designer learns nothing about which ids exist.
  const designer = await makeUser(['DESIGNER']);
  for (const userId of ['nope', f.customer.id]) {
    const r = await exec(SET_STATE, { as: designer, variables: { userId, state: 'DISABLED' } });
    assert.equal(r.code, 'FORBIDDEN', userId);
  }
  const customer = await exec(SET_STATE, { as: f.stranger, variables: { userId: f.customer.id, state: 'DISABLED' } });
  assert.equal(customer.code, 'FORBIDDEN');
});

// --- the mixed-account rule ---------------------------------------------------

test('a staff account needs staff.manage to disable; a customer only customers.manage', async () => {
  const s = await sales();
  const staffOnly = await makeUser(['DESIGNER']);
  const r = await exec(SET_STATE, { as: s, variables: { userId: staffOnly.id, state: 'DISABLED' } });
  assert.equal(r.code, 'FORBIDDEN');
  ok(await exec(SET_STATE, { as: f.admin, variables: { userId: staffOnly.id, state: 'DISABLED' } }));
});

test('a MIXED account (customer and staff roles) is a staff account: sales may not disable it, an administrator may', async () => {
  const s = await sales();
  const mixed = await makeUser(['CUSTOMER', 'DESIGNER']);

  const bySales = await exec(SET_STATE, { as: s, variables: { userId: mixed.id, state: 'DISABLED' } });
  assert.equal(bySales.code, 'FORBIDDEN');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: mixed.id } })).state, 'ACTIVE');

  const byAdmin = ok(await exec(SET_STATE, { as: f.admin, variables: { userId: mixed.id, state: 'DISABLED' } }));
  assert.equal((byAdmin.setUserState as { state: string }).state, 'DISABLED');

  // Restoring is the same act in reverse and takes the same capability.
  const restoreBySales = await exec(SET_STATE, { as: s, variables: { userId: mixed.id, state: 'ACTIVE' } });
  assert.equal(restoreBySales.code, 'FORBIDDEN');
  ok(await exec(SET_STATE, { as: f.admin, variables: { userId: mixed.id, state: 'ACTIVE' } }));
});

test('sales cannot revoke a staff invite either', async () => {
  const s = await sales();
  const pending = await makeUser(['DESIGNER'], { state: 'INVITED', passwordHash: null });
  const r = await exec(`mutation($id: ID!) { revokeInvite(userId: $id) }`, { as: s, variables: { id: pending.id } });
  assert.equal(r.code, 'FORBIDDEN');
  const ok2 = await exec(`mutation($id: ID!) { revokeInvite(userId: $id) }`, { as: f.admin, variables: { id: pending.id } });
  assert.equal(ok2.errors.length, 0);
});

// --- LAST_SUPERUSER ------------------------------------------------------------

test('LAST_SUPERUSER: an administrator cannot drop their own ADMIN when the other is disabled', async () => {
  const other = await admin2();
  ok(await exec(SET_STATE, { as: f.admin, variables: { userId: other.id, state: 'DISABLED' } }));
  const r = await exec(SET_ROLES, { as: f.admin, variables: { userId: f.admin.id, roles: ['SALES'] } });
  assert.equal(r.code, 'LAST_SUPERUSER');
  assert.deepEqual((await prisma.user.findUniqueOrThrow({ where: { id: f.admin.id } })).roles, ['ADMIN']);
});

test('LAST_SUPERUSER: with a second active ADMIN the first can step down — and then the second is the last', async () => {
  const other = await admin2();
  ok(await exec(SET_ROLES, { as: f.admin, variables: { userId: f.admin.id, roles: ['SALES'] } }));
  // `other` is now the only administrator; they cannot follow.
  const r = await exec(SET_ROLES, { as: other, variables: { userId: other.id, roles: ['SALES'] } });
  assert.equal(r.code, 'LAST_SUPERUSER');
});

test('LAST_SUPERUSER: disabling the last active administrator is refused, even for a caller whose own admin-ness has lapsed since the request began', async () => {
  const other = await admin2();
  // `f.admin` was loaded into the request; then `other` disables them.
  const stale = f.admin;
  ok(await exec(SET_STATE, { as: other, variables: { userId: stale.id, state: 'DISABLED' } }));
  const r = await exec(SET_STATE, { as: stale, variables: { userId: other.id, state: 'DISABLED' } });
  assert.equal(r.code, 'LAST_SUPERUSER');
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).state, 'ACTIVE');
});

test('LAST_SUPERUSER: two administrators disabling each other at the same moment leave exactly one standing', async () => {
  const other = await admin2();
  const results = await Promise.all([
    exec(SET_STATE, { as: f.admin, variables: { userId: other.id, state: 'DISABLED' } }),
    exec(SET_STATE, { as: other, variables: { userId: f.admin.id, state: 'DISABLED' } }),
  ]);
  const codes = results.map((r) => r.code ?? 'ok').sort();
  assert.deepEqual(codes, ['LAST_SUPERUSER', 'ok']);
  const active = await prisma.user.count({ where: { roles: { has: 'ADMIN' }, state: 'ACTIVE' } });
  assert.equal(active, 1);
});

test('LAST_SUPERUSER: the same race through setUserRoles', async () => {
  const other = await admin2();
  const results = await Promise.all([
    exec(SET_ROLES, { as: f.admin, variables: { userId: other.id, roles: ['SALES'] } }),
    exec(SET_ROLES, { as: other, variables: { userId: f.admin.id, roles: ['SALES'] } }),
  ]);
  const codes = results.map((r) => r.code ?? 'ok').sort();
  assert.deepEqual(codes, ['LAST_SUPERUSER', 'ok']);
  const active = await prisma.user.count({ where: { roles: { has: 'ADMIN' }, state: 'ACTIVE' } });
  assert.equal(active, 1);
});

test('an INVITED or DISABLED administrator does not count as "another administrator"', async () => {
  await makeUser(['ADMIN'], { state: 'INVITED', passwordHash: null });
  await makeUser(['ADMIN'], { state: 'DISABLED' });
  const r = await exec(SET_ROLES, { as: f.admin, variables: { userId: f.admin.id, roles: ['SALES'] } });
  assert.equal(r.code, 'LAST_SUPERUSER');
});

// --- setUserRoles ---------------------------------------------------------------

test('LAST_ROLE: an empty role set is refused with its own code, never a raw database error', async () => {
  const target = await makeUser(['DESIGNER']);
  const r = await exec(SET_ROLES, { as: f.admin, variables: { userId: target.id, roles: [] } });
  assert.equal(r.code, 'LAST_ROLE');
  assert.deepEqual((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).roles, ['DESIGNER']);
});

test('setUserRoles replaces the set, de-duplicates, and the new capabilities are the next request\'s', async () => {
  const target = await makeUser(['DESIGNER']);
  const data = ok(
    await exec(SET_ROLES, { as: f.admin, variables: { userId: target.id, roles: ['SALES', 'SALES', 'CONTRIBUTOR'] } }),
  ).setUserRoles as { roles: string[]; capabilities: string[] };
  assert.deepEqual([...data.roles].sort(), ['CONTRIBUTOR', 'SALES']);
  assert.ok(data.capabilities.includes('customers.manage'));
  assert.ok(!data.capabilities.includes('design.author'));
  const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
  assert.ok(capabilitiesOf(row).has('library.write'));
});

test('setUserRoles takes staff.manage — sales and designers are FORBIDDEN', async () => {
  const target = await makeUser(['DESIGNER']);
  for (const who of [await sales(), await makeUser(['DESIGNER'])]) {
    const r = await exec(SET_ROLES, { as: who, variables: { userId: target.id, roles: ['ADMIN'] } });
    assert.equal(r.code, 'FORBIDDEN');
  }
});

test('a role set can hold CUSTOMER beside staff roles (that is how a mixed account comes to be)', async () => {
  const target = await makeUser(['DESIGNER']);
  ok(await exec(SET_ROLES, { as: f.admin, variables: { userId: target.id, roles: ['DESIGNER', 'CUSTOMER'] } }));
  const row = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
  assert.deepEqual([...row.roles].sort(), ['CUSTOMER', 'DESIGNER']);
});

test('giving a second-factor role to an account with no phone is refused — it would lock them out', async () => {
  const noPhone = await makeUser(['REVIEWER'], { phone: null });
  const r = await exec(SET_ROLES, { as: f.admin, variables: { userId: noPhone.id, roles: ['REVIEWER', 'DESIGNER'] } });
  assert.equal(r.code, 'PHONE_REQUIRED_FOR_STAFF');
  // A change that does not introduce the requirement is not blocked by it.
  ok(await exec(SET_ROLES, { as: f.admin, variables: { userId: noPhone.id, roles: ['CONTRIBUTOR'] } }));
});

test('setUserRoles on a missing account is NOT_FOUND', async () => {
  const r = await exec(SET_ROLES, { as: f.admin, variables: { userId: 'nope', roles: ['SALES'] } });
  assert.equal(r.code, 'NOT_FOUND');
});

// --- inviteStaff ------------------------------------------------------------------

test('inviteStaff: staff.manage only', async () => {
  for (const who of [await sales(), await makeUser(['DEVELOPER']), f.customer]) {
    const r = await exec(INVITE_STAFF, { as: who, variables: { name: 'N', roles: ['DESIGNER'], phone: '09121112233' } });
    assert.equal(r.code, 'FORBIDDEN');
  }
});

test('inviteStaff: creates an INVITED account with the roles asked for, an invite token, and the link', async () => {
  const data = ok(
    await exec(INVITE_STAFF, {
      as: f.admin,
      variables: { name: '  New Designer ', roles: ['DESIGNER'], phone: '0912 111 2233', email: 'New.Designer@Example.com' },
    }),
  ).inviteStaff as { userId: string; email: string; inviteUrl: string };
  assert.match(data.inviteUrl, /\/portal\/invite\//);
  assert.equal(data.email, 'new.designer@example.com');

  const user = await prisma.user.findUniqueOrThrow({ where: { id: data.userId } });
  assert.equal(user.state, 'INVITED');
  assert.equal(user.name, 'New Designer');
  assert.equal(user.phone, '+989121112233');
  assert.deepEqual(user.roles, ['DESIGNER']);
  const token = await prisma.authToken.findFirstOrThrow({ where: { userId: user.id } });
  assert.equal(token.purpose, 'INVITE');
  assert.equal(token.usedAt, null);

  // …and the link works: accepting it makes an active member with that role's capabilities.
  const raw = data.inviteUrl.split('/portal/invite/')[1];
  ok(await exec(`mutation { acceptInvite(token: "${raw}", name: "New Designer", password: "${PASSWORD}") { user { id } } }`));
  const active = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(active.state, 'ACTIVE');
  assert.ok(capabilitiesOf(active).has('design.author'));
});

test('inviteStaff: a factor role needs a phone (the code is sent to it); a reviewer needs only one identifier', async () => {
  const noPhone = await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'N', roles: ['SALES'], email: 'a@b.co' } });
  assert.equal(noPhone.code, 'PHONE_REQUIRED_FOR_STAFF');
  // One factor role among several is enough.
  const mixed = await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'N', roles: ['REVIEWER', 'DEVELOPER'], email: 'a@b.co' } });
  assert.equal(mixed.code, 'PHONE_REQUIRED_FOR_STAFF');
  ok(await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'N', roles: ['REVIEWER'], email: 'rev@b.co' } }));
  ok(await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'N', roles: ['CONTRIBUTOR'], phone: '09123334455' } }));
});

test('inviteStaff: the refusals', async () => {
  const v = (o: Record<string, unknown>) => ({ as: f.admin, variables: { name: 'N', roles: ['DESIGNER'], phone: '09121112233', ...o } });
  assert.equal((await exec(INVITE_STAFF, v({ roles: [] }))).code, 'ROLES_REQUIRED');
  assert.equal((await exec(INVITE_STAFF, v({ roles: ['CUSTOMER'] }))).code, 'INVALID_ROLE');
  assert.equal((await exec(INVITE_STAFF, v({ roles: ['DESIGNER', 'CUSTOMER'] }))).code, 'INVALID_ROLE');
  assert.equal((await exec(INVITE_STAFF, v({ phone: 'abc' }))).code, 'PHONE_INVALID');
  assert.equal((await exec(INVITE_STAFF, v({ phone: null, email: null, roles: ['REVIEWER'] }))).code, 'IDENTIFIER_REQUIRED');
  assert.equal((await exec(INVITE_STAFF, v({ name: '   ' }))).code, 'NAME_REQUIRED');
  assert.equal(await prisma.user.count({ where: { name: 'N' } }), 0, 'a refused invite creates nothing');
});

test('inviteStaff never repurposes an existing account', async () => {
  const active = await makeUser(['SALES'], { phone: '+989125550001' });
  const disabled = await makeUser(['SALES'], { phone: '+989125550002', state: 'DISABLED' });
  const customer = await makeUser(['CUSTOMER'], { phone: '+989125550003', state: 'INVITED', passwordHash: null });
  const call = (phone: string) => exec(INVITE_STAFF, { as: f.admin, variables: { name: 'N', roles: ['DESIGNER'], phone } });
  assert.equal((await call(active.phone!)).code, 'ALREADY_ACTIVE');
  assert.equal((await call(disabled.phone!)).code, 'ACCOUNT_DISABLED');
  assert.equal((await call(customer.phone!)).code, 'ACCOUNT_EXISTS');
  assert.deepEqual((await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).roles, ['CUSTOMER']);
  // A phone and an email belonging to two different accounts.
  const r = await exec(INVITE_STAFF, {
    as: f.admin,
    variables: { name: 'N', roles: ['DESIGNER'], phone: active.phone, email: disabled.email },
  });
  assert.equal(r.code, 'IDENTIFIER_CONFLICT');
});

test('inviteStaff re-issues a still-pending staff invite with the roles asked for now', async () => {
  const first = ok(await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'P', roles: ['DESIGNER'], phone: '09127776655' } })).inviteStaff as { userId: string };
  const second = ok(await exec(INVITE_STAFF, { as: f.admin, variables: { name: 'P', roles: ['DEVELOPER'], phone: '09127776655' } })).inviteStaff as { userId: string };
  assert.equal(second.userId, first.userId);
  assert.deepEqual((await prisma.user.findUniqueOrThrow({ where: { id: first.userId } })).roles, ['DEVELOPER']);
  assert.equal(await prisma.authToken.count({ where: { userId: first.userId, purpose: 'INVITE' } }), 2);
});

// --- allUsers ----------------------------------------------------------------------

test('allUsers: every account with roles and state — staff.manage only', async () => {
  await makeUser(['DESIGNER'], { state: 'DISABLED' });
  const data = ok(await exec(`{ allUsers { id roles state } }`, { as: f.admin })).allUsers as Array<{ id: string; state: string }>;
  assert.equal(data.length, await prisma.user.count());
  assert.ok(data.some((u) => u.state === 'DISABLED'));
  for (const who of [await sales(), f.customer]) {
    assert.equal((await exec(`{ allUsers { id } }`, { as: who })).code, 'FORBIDDEN');
  }
});

// --- tool grants -----------------------------------------------------------------

test('grantTool / revokeTool: sales gives and takes a tool, idempotently, and history is kept', async () => {
  const s = await sales();
  // The fixture customer already holds the import (test/db.ts); take it, give it, give it again.
  const revoked = ok(await exec(REVOKE, { as: s, variables: { customerId: f.customer.id } })).revokeTool as { grants: unknown[] };
  assert.equal(revoked.grants.length, 0);
  ok(await exec(REVOKE, { as: s, variables: { customerId: f.customer.id } })); // idempotent

  const granted = ok(await exec(GRANT, { as: s, variables: { customerId: f.customer.id } })).grantTool as { grants: Array<{ tool: string; grantedBy: { id: string } }> };
  assert.equal(granted.grants.length, 1);
  assert.equal(granted.grants[0].tool, 'PRODUCT_IMPORT');
  assert.equal(granted.grants[0].grantedBy.id, s.id);
  ok(await exec(GRANT, { as: s, variables: { customerId: f.customer.id } })); // idempotent

  const rows = await prisma.toolGrant.findMany({ where: { customerId: f.customer.id }, orderBy: { grantedAt: 'asc' } });
  assert.equal(rows.length, 2, 'the original grant, revoked, and the new one — a re-grant is a new row');
  assert.notEqual(rows[0].revokedAt, null);
  assert.equal(rows[0].revokedById, s.id);
  assert.equal(rows[1].revokedAt, null);
});

test('grantTool / revokeTool: customers.manage only, and only for a customer', async () => {
  const designer = await makeUser(['DESIGNER']);
  for (const who of [designer, f.customer]) {
    assert.equal((await exec(GRANT, { as: who, variables: { customerId: f.stranger.id } })).code, 'FORBIDDEN');
    assert.equal((await exec(REVOKE, { as: who, variables: { customerId: f.stranger.id } })).code, 'FORBIDDEN');
  }
  const staffOnly = await makeUser(['DEVELOPER']);
  assert.equal((await exec(GRANT, { as: f.admin, variables: { customerId: staffOnly.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(GRANT, { as: f.admin, variables: { customerId: 'nope' } })).code, 'NOT_FOUND');
});

test('the partial unique index: a second ACTIVE grant is refused by the database itself; a revoked one is not in the way', async () => {
  // The fixture customer already holds an active PRODUCT_IMPORT grant.
  await assert.rejects(
    prisma.toolGrant.create({ data: { customerId: f.customer.id, tool: 'PRODUCT_IMPORT', grantedById: f.admin.id } }),
    (err: { code?: string }) => err.code === 'P2002',
  );
  // Revoke, and a new active grant fits; the revoked row is history.
  await prisma.toolGrant.updateMany({
    where: { customerId: f.customer.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: f.admin.id },
  });
  await prisma.toolGrant.create({ data: { customerId: f.customer.id, tool: 'PRODUCT_IMPORT', grantedById: f.admin.id } });
  // …and a different customer is unaffected by the first one's grants.
  await prisma.toolGrant.create({ data: { customerId: f.stranger.id, tool: 'PRODUCT_IMPORT', grantedById: f.admin.id } });
});

test('the partial unique index, by raw SQL — not only through Prisma\'s error mapping', async () => {
  await assert.rejects(
    prisma.$executeRaw`
      INSERT INTO "ToolGrant" ("id", "customerId", "tool", "grantedById")
      VALUES ('dup-grant', ${f.customer.id}, 'PRODUCT_IMPORT'::"ToolKey", ${f.admin.id})
    `,
    /23505|already exists/i,
  );
});

test('two simultaneous grantTool calls leave exactly one active grant', async () => {
  await prisma.toolGrant.deleteMany({ where: { customerId: f.customer.id } });
  const s = await sales();
  const results = await Promise.all(
    [1, 2, 3].map(() => exec(GRANT, { as: s, variables: { customerId: f.customer.id } })),
  );
  for (const r of results) assert.equal(r.errors.length, 0);
  assert.equal(await prisma.toolGrant.count({ where: { customerId: f.customer.id, revokedAt: null } }), 1);
});

// --- the grant gates the import tool ---------------------------------------------

const projectId = () => f.contract.projectId!;

async function workbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Products');
  sheet.addRow(['کد', 'نام', 'Name (EN)', 'قیمت', 'موجودی']);
  sheet.addRow(['A-1', 'کالای یک', 'Item One', '10000', '5']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const CREATE_RUN = `mutation($projectId: ID!, $fileId: ID!) { createServiceRun(projectId: $projectId, fileId: $fileId) { id status } }`;
const PREVIEW = `mutation($runId: ID!) { previewServiceRun(runId: $runId) { id status } }`;
const APPLY = `mutation($runId: ID!) { applyServiceRun(runId: $runId) { id status } }`;

test('a revoked grant turns every import query and mutation into NOT_FOUND for the customer', async () => {
  // A run made while the tool was theirs, previewed and waiting to apply.
  const up = await upload(base, { as: f.customer, fileClass: 'SERVICE_IMPORT', projectId: projectId(), body: await workbook(), type: XLSX, filename: 'p.xlsx' });
  assert.equal(up.status, 201);
  const run = ok(await exec(CREATE_RUN, { as: f.customer, variables: { projectId: projectId(), fileId: up.body!.id } })).createServiceRun as { id: string };
  ok(await exec(PREVIEW, { as: f.customer, variables: { runId: run.id } }));
  assert.equal(ok(await exec(`{ myProjects { id } }`, { as: f.customer })).myProjects instanceof Array, true);

  ok(await exec(REVOKE, { as: await sales(), variables: { customerId: f.customer.id } }));

  const asCustomer = { as: f.customer };
  assert.equal((await exec(`{ myProjects { id } }`, asCustomer)).code, 'NOT_FOUND');
  assert.equal((await exec(`query($p: ID!) { projectServiceRuns(projectId: $p) { id } }`, { ...asCustomer, variables: { p: projectId() } })).code, 'NOT_FOUND');
  assert.equal((await exec(CREATE_RUN, { ...asCustomer, variables: { projectId: projectId(), fileId: up.body!.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(PREVIEW, { ...asCustomer, variables: { runId: run.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(APPLY, { ...asCustomer, variables: { runId: run.id } })).code, 'NOT_FOUND');
  // The upload door is shut the same way: there is no project to upload to.
  const again = await upload(base, { as: f.customer, fileClass: 'SERVICE_IMPORT', projectId: projectId(), body: await workbook(), type: XLSX, filename: 'p2.xlsx' });
  assert.equal(again.status, 404);
  assert.equal(await prisma.serviceRun.count({ where: { status: 'APPLIED' } }), 0, 'nothing was applied through the closed door');

  // Staff still see and act on the customer's history.
  const seen = ok(await exec(`query($p: ID!) { projectServiceRuns(projectId: $p) { id } }`, { as: await sales(), variables: { p: projectId() } }));
  assert.equal((seen.projectServiceRuns as unknown[]).length, 1);

  // Give it back and the customer's own run is theirs again.
  ok(await exec(GRANT, { as: await sales(), variables: { customerId: f.customer.id } }));
  const applied = ok(await exec(APPLY, { ...asCustomer, variables: { runId: run.id } }));
  assert.equal((applied.applyServiceRun as { status: string }).status, 'APPLIED');
});

test('myTools lists exactly the active grants — what the portal rail offers', async () => {
  const ask = (as: User) => exec(`{ myTools }`, { as });
  assert.deepEqual(ok(await ask(f.customer)).myTools, ['PRODUCT_IMPORT']);
  assert.deepEqual(ok(await ask(f.stranger)).myTools, []);
  ok(await exec(REVOKE, { as: await sales(), variables: { customerId: f.customer.id } }));
  assert.deepEqual(ok(await ask(f.customer)).myTools, []);
  assert.equal((await exec(`{ myTools }`)).code, 'UNAUTHENTICATED');
});

test('a customer who was never granted the tool meets the same NOT_FOUND', async () => {
  const fresh = await makeUser(['CUSTOMER']);
  assert.equal((await exec(`{ myProjects { id } }`, { as: fresh })).code, 'NOT_FOUND');
  assert.equal((await exec(`query($p: ID!) { projectServiceRuns(projectId: $p) { id } }`, { as: fresh, variables: { p: projectId() } })).code, 'NOT_FOUND');
});

// --- customer(id) ----------------------------------------------------------------

test('customer(id): the profile — user, grants, contracts, tickets and the invoices summary', async () => {
  // J13: an entry inserted with no `issuedAt` is a draft and is in no total, so
  // this is an issued invoice (numbered and dated, as the CHECK requires) — and
  // a draft beside it, which the summary must not count.
  await prisma.billingEntry.create({
    data: {
      customerId: f.customer.id,
      source: 'CONTRACT',
      descriptionFa: 'مرحله اول',
      descriptionEn: 'First instalment',
      amount: 5_000_000n,
      issuedAt: new Date('2026-09-01T00:00:00Z'),
      invoiceNumber: 'INV-000001',
      dueAt: new Date('2026-09-08T00:00:00Z'),
      paymentTermDays: 7,
    },
  });
  await prisma.billingEntry.create({
    data: { customerId: f.customer.id, source: 'CONTRACT', descriptionFa: 'پیش‌نویس', descriptionEn: 'A draft', amount: 999n },
  });
  const data = ok(await exec(CUSTOMER, { as: await sales(), variables: { id: f.customer.id } })).customer as {
    user: { id: string; state: string };
    grants: Array<{ tool: string }>;
    contracts: Array<{ ref: string }>;
    invoices: { totalIssued: string; totalOutstanding: string };
  };
  assert.equal(data.user.id, f.customer.id);
  assert.equal((data as unknown as { id: string }).id, f.customer.id, 'the profile is keyed by the customer, so a client cache can merge it');
  assert.deepEqual(data.grants.map((g) => g.tool), ['PRODUCT_IMPORT']);
  assert.deepEqual(data.contracts.map((c) => c.ref), ['RC-TEST-001']);
  assert.equal(data.invoices.totalIssued, '5000000');
  assert.equal(data.invoices.totalOutstanding, '5000000');
});

test('customer(id): null for a staff-only id and for a missing one; FORBIDDEN without customers.manage', async () => {
  const staffOnly = await makeUser(['DEVELOPER']);
  assert.equal(ok(await exec(CUSTOMER, { as: f.admin, variables: { id: staffOnly.id } })).customer, null);
  assert.equal(ok(await exec(CUSTOMER, { as: f.admin, variables: { id: 'nope' } })).customer, null);
  for (const who of [await makeUser(['DESIGNER']), f.customer]) {
    assert.equal((await exec(CUSTOMER, { as: who, variables: { id: f.customer.id } })).code, 'FORBIDDEN');
  }
});

test('customer(id): the invoices summary is money — withheld (null, not zero) from a viewer without money.read', async () => {
  await prisma.billingEntry.create({
    data: { customerId: f.customer.id, source: 'CONTRACT', descriptionFa: 'x', descriptionEn: 'x', amount: 1_000n },
  });
  // No role that holds customers.manage lacks money.read today, so the gate is
  // proved on the loader itself with a viewer who has one and not the other —
  // which is the day a role split would make it matter.
  const designer = await makeUser(['DESIGNER']);
  const withoutMoney = await loadCustomerProfile(f.customer.id, designer);
  assert.equal(withoutMoney!.invoices, null);
  assert.deepEqual(withoutMoney!.tickets, [], 'tickets need tickets.answer, which a designer lacks');
  const withMoney = await loadCustomerProfile(f.customer.id, await sales());
  assert.notEqual(withMoney!.invoices, null);
});

test('customer(id): a mixed account still has a profile', async () => {
  const mixed = await makeUser(['CUSTOMER', 'DESIGNER']);
  const data = ok(await exec(CUSTOMER, { as: f.admin, variables: { id: mixed.id } })).customer as { user: { id: string }; contracts: unknown[] };
  assert.equal(data.user.id, mixed.id);
  assert.deepEqual(data.contracts, []);
});

test('customer(id): contracts are filtered by the viewer\'s visibility, not listed wholesale', async () => {
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  // A viewer who reads only active contracts does not see a discarded one on
  // someone else's page — the page's capability is not a bypass of S1's rule.
  const designer = await makeUser(['DESIGNER']);
  assert.deepEqual((await loadCustomerProfile(f.customer.id, designer))!.contracts, []);
  assert.equal((await loadCustomerProfile(f.customer.id, await sales()))!.contracts.length, 1);
});
