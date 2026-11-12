import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { newLinkToken } from '../auth/tokens.js';
import { ERASED_NAME, isErased } from '../lib/erasure.js';

/**
 * US1 — editing an account, a fresh invite link, deleting an account with no
 * history, and anonymizing one with history.
 *
 * Who may is S3's rule (sales: customers; an administrator: anyone with a
 * staff role); an identifier change revokes every link sent to the old one;
 * a new invite link kills the old; `deleteUser` refuses every kind of record —
 * the ones the database would refuse and the `SetNull` / cascade ones it
 * would silently let go; `anonymizeUser` keeps every record and identifies
 * no one, and an erased account can be neither restored nor edited.
 */

const PASSWORD = 'a-long-enough-password';

let f: Fixture;
let seq = 0;

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

const USER = 'id name phone email clientName state erased';
const UPDATE = `mutation($u: ID!, $name: String!, $phone: String, $email: String, $client: String){
  updateUser(userId: $u, name: $name, phone: $phone, email: $email, clientName: $client) { ${USER} } }`;
const REISSUE = `mutation($u: ID!){ reissueInvite(userId: $u) { userId inviteUrl expiresAt } }`;
const DELETE = `mutation($u: ID!){ deleteUser(userId: $u) }`;
const ANONYMIZE = `mutation($u: ID!, $c: String!){ anonymizeUser(userId: $u, confirmName: $c) { ${USER} } }`;
const SET_STATE = `mutation($u: ID!, $s: UserState!){ setUserState(userId: $u, state: $s) { id state } }`;
const ACCEPT = `mutation($t: String!){ acceptInvite(token: $t, name: "Invitee", password: "${PASSWORD}") { user { id } } }`;

const tokenOf = (inviteUrl: string) => inviteUrl.split('/').pop()!;

// --- updateUser -------------------------------------------------------------

test('sales edits a customer: name, normalized phone, lower-cased email, company', async () => {
  const sales = await makeUser(['SALES']);
  const r = ok(
    await exec(UPDATE, {
      as: sales,
      variables: { u: f.customer.id, name: '  Nahal R. ', phone: '0912 000 7777', email: ' Nahal@Example.COM ', client: 'Nahal Studio' },
    }),
  ).updateUser as Record<string, unknown>;
  assert.deepEqual(
    [r.name, r.phone, r.email, r.clientName],
    ['Nahal R.', '+989120007777', 'nahal@example.com', 'Nahal Studio'],
  );
});

test('who may: sales edits customers but not staff, nor a mixed account; an administrator edits anyone; a customer edits no one', async () => {
  const sales = await makeUser(['SALES']);
  const designer = await makeUser(['DESIGNER']);
  const mixed = await makeUser(['CUSTOMER', 'CONTRIBUTOR']);
  const vars = (u: User) => ({ u: u.id, name: 'Renamed', phone: u.phone, email: u.email });
  assert.equal((await exec(UPDATE, { as: sales, variables: vars(designer) })).code, 'FORBIDDEN');
  assert.equal((await exec(UPDATE, { as: sales, variables: vars(mixed) })).code, 'FORBIDDEN');
  ok(await exec(UPDATE, { as: f.admin, variables: vars(designer) }));
  ok(await exec(UPDATE, { as: f.admin, variables: vars(mixed) }));
  assert.equal((await exec(UPDATE, { as: f.customer, variables: vars(designer) })).code, 'FORBIDDEN');
});

test('refusals: name, phone shape, email shape, an identifier left, a staff factor keeps its phone, another account’s identifier', async () => {
  const designer = await makeUser(['DESIGNER']);
  const other = await makeUser(['CUSTOMER']);
  const run = (over: Record<string, unknown>, u: User = f.customer) =>
    exec(UPDATE, { as: f.admin, variables: { u: u.id, name: 'X', phone: u.phone, email: u.email, ...over } });
  assert.equal((await run({ name: '  ' })).code, 'NAME_REQUIRED');
  assert.equal((await run({ phone: 'not a phone' })).code, 'PHONE_INVALID');
  assert.equal((await run({ email: 'nope' })).code, 'EMAIL_INVALID');
  assert.equal((await run({ phone: null, email: null })).code, 'IDENTIFIER_REQUIRED');
  assert.equal((await run({ phone: null }, designer)).code, 'PHONE_REQUIRED_FOR_STAFF');
  assert.equal((await run({ email: other.email })).code, 'IDENTIFIER_CONFLICT');
  assert.equal((await run({ phone: other.phone })).code, 'IDENTIFIER_CONFLICT');
});

test('changing an identifier revokes every outstanding link and code; a name-only edit revokes nothing', async () => {
  const { hash } = newLinkToken();
  const expiresAt = new Date(Date.now() + 86_400_000);
  await prisma.authToken.create({ data: { userId: f.customer.id, purpose: 'PASSWORD_RESET', tokenHash: hash, expiresAt } });
  const live = () => prisma.authToken.count({ where: { userId: f.customer.id, usedAt: null, revokedAt: null } });

  ok(await exec(UPDATE, { as: f.admin, variables: { u: f.customer.id, name: 'Only the name', phone: f.customer.phone, email: f.customer.email } }));
  assert.equal(await live(), 1);

  ok(await exec(UPDATE, { as: f.admin, variables: { u: f.customer.id, name: 'Only the name', phone: f.customer.phone, email: 'new@test.local' } }));
  assert.equal(await live(), 0);
});

// --- reissueInvite ----------------------------------------------------------

test('a fresh invite link works and the old one stops; refused for an active or disabled account and by the usual rule', async () => {
  const sales = await makeUser(['SALES']);
  const invitee = await makeUser(['CUSTOMER'], { state: 'INVITED', passwordHash: null });
  const first = ok(await exec(REISSUE, { as: sales, variables: { u: invitee.id } })).reissueInvite as { inviteUrl: string };
  const second = ok(await exec(REISSUE, { as: sales, variables: { u: invitee.id } })).reissueInvite as { inviteUrl: string };
  assert.notEqual(first.inviteUrl, second.inviteUrl);
  assert.match(second.inviteUrl, /\/portal\/invite\/[^/]+$/);

  assert.ok((await exec(ACCEPT, { variables: { t: tokenOf(first.inviteUrl) } })).code, 'the earlier link is revoked');
  ok(await exec(ACCEPT, { variables: { t: tokenOf(second.inviteUrl) } }));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: invitee.id } })).state, 'ACTIVE');

  assert.equal((await exec(REISSUE, { as: sales, variables: { u: invitee.id } })).code, 'ALREADY_ACTIVE');
  const disabled = await makeUser(['CUSTOMER'], { state: 'DISABLED', passwordHash: null });
  assert.equal((await exec(REISSUE, { as: sales, variables: { u: disabled.id } })).code, 'ACCOUNT_DISABLED');
  const invitedStaff = await makeUser(['DESIGNER'], { state: 'INVITED', passwordHash: null });
  assert.equal((await exec(REISSUE, { as: sales, variables: { u: invitedStaff.id } })).code, 'FORBIDDEN');
  ok(await exec(REISSUE, { as: f.admin, variables: { u: invitedStaff.id } }));
});

// --- deleteUser -------------------------------------------------------------

test('an account with no records is deleted, its invite tokens with it', async () => {
  const invitee = await makeUser(['CUSTOMER'], { state: 'INVITED', passwordHash: null });
  ok(await exec(REISSUE, { as: f.admin, variables: { u: invitee.id } }));
  assert.equal(ok(await exec(DELETE, { as: f.admin, variables: { u: invitee.id } })).deleteUser, true);
  assert.equal(await prisma.user.count({ where: { id: invitee.id } }), 0);
  assert.equal(await prisma.authToken.count({ where: { userId: invitee.id } }), 0);
});

test('HAS_HISTORY: a customer with a contract (Restrict) — and the edges the database would let go silently', async () => {
  assert.equal((await exec(DELETE, { as: f.admin, variables: { u: f.customer.id } })).code, 'HAS_HISTORY');
  assert.equal(await prisma.user.count({ where: { id: f.customer.id } }), 1);

  // Assigned as the contract's designer: SetNull in the schema, so only the
  // resolver's own check stands between a delete and a blanked assignment.
  const designer = await makeUser(['DESIGNER']);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { designerId: designer.id } });
  assert.equal((await exec(DELETE, { as: f.admin, variables: { u: designer.id } })).code, 'HAS_HISTORY');
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).designerId, designer.id);

  // A tool grant cascades on delete; it is still a record of the customer.
  const granted = await makeUser(['CUSTOMER']);
  await prisma.toolGrant.create({ data: { customerId: granted.id, tool: 'PRODUCT_IMPORT', grantedById: f.admin.id } });
  assert.equal((await exec(DELETE, { as: f.admin, variables: { u: granted.id } })).code, 'HAS_HISTORY');
  assert.equal(await prisma.toolGrant.count({ where: { customerId: granted.id } }), 1);
});

test('deleteUser: not yourself, not the last administrator, and by the usual rule', async () => {
  assert.equal((await exec(DELETE, { as: f.admin, variables: { u: f.admin.id } })).code, 'CANNOT_DELETE_SELF');
  const sales = await makeUser(['SALES']);
  const fresh = await makeUser(['CONTRIBUTOR'], { state: 'INVITED', passwordHash: null });
  assert.equal((await exec(DELETE, { as: sales, variables: { u: fresh.id } })).code, 'FORBIDDEN');
  assert.equal((await exec(DELETE, { as: sales, variables: { u: f.admin.id } })).code, 'FORBIDDEN');
});

// --- anonymizeUser ----------------------------------------------------------

test('anonymizing keeps every record and identifies no one; the account is disabled and every way in is gone', async () => {
  const { hash } = newLinkToken();
  await prisma.authToken.create({
    data: { userId: f.customer.id, purpose: 'PASSWORD_RESET', tokenHash: hash, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  assert.equal((await exec(ANONYMIZE, { as: f.admin, variables: { u: f.customer.id, c: 'someone else' } })).code, 'CONFIRM_MISMATCH');

  const r = ok(await exec(ANONYMIZE, { as: f.admin, variables: { u: f.customer.id, c: ` ${f.customer.name} ` } }))
    .anonymizeUser as Record<string, unknown>;
  assert.deepEqual([r.name, r.phone, r.email, r.clientName, r.state, r.erased], [ERASED_NAME, null, null, null, 'DISABLED', true]);

  const row = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  assert.ok(isErased(row));
  assert.equal(row.passwordHash, null);
  assert.equal(await prisma.authToken.count({ where: { userId: row.id, usedAt: null, revokedAt: null } }), 0);
  // The records stay, pointing at the same row.
  assert.equal((await prisma.contract.findUniqueOrThrow({ where: { id: f.contract.id } })).customerId, row.id);

  // Irreversible: not restored, not edited, not anonymized twice.
  assert.equal((await exec(SET_STATE, { as: f.admin, variables: { u: row.id, s: 'ACTIVE' } })).code, 'ACCOUNT_ERASED');
  assert.equal(
    (await exec(UPDATE, { as: f.admin, variables: { u: row.id, name: 'Back', email: 'back@test.local' } })).code,
    'ACCOUNT_ERASED',
  );
  assert.equal((await exec(ANONYMIZE, { as: f.admin, variables: { u: row.id, c: ERASED_NAME } })).code, 'ACCOUNT_ERASED');
});

test('anonymizeUser: not yourself, sales only for customers, and an administrator for another administrator', async () => {
  assert.equal((await exec(ANONYMIZE, { as: f.admin, variables: { u: f.admin.id, c: f.admin.name } })).code, 'CANNOT_DELETE_SELF');
  const sales = await makeUser(['SALES']);
  assert.equal((await exec(ANONYMIZE, { as: sales, variables: { u: f.admin.id, c: f.admin.name } })).code, 'FORBIDDEN');
  // LAST_SUPERUSER cannot be reached one request at a time — only an active
  // administrator may act on one, so there are always two — and is S3's
  // locked guard against two administrators erasing each other at once.
  const admin2 = await makeUser(['ADMIN']);
  ok(await exec(ANONYMIZE, { as: admin2, variables: { u: f.admin.id, c: f.admin.name } }));
});
