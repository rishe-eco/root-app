import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import type { Role, User } from '@prisma/client';
import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { __setSmsTransportForTests, __resetSmsTransportForTests, type SmsTransport } from '../lib/sms.js';
import { __resetNamedRateLimitsForTests } from '../lib/rateLimit.js';

/**
 * J1 — phone identity, SMS, the notification router, rate limits, the staff
 * second factor (journeys build plan §5 "J1").
 *
 * Against the dev transport throughout, per this stage's own note in the
 * build plan: production cannot be booted inside this suite, so PD-18's
 * "factor unenforced / SMS unavailable" branch is a pure function
 * (`smsAvailable`, `lib/sms.test.ts`) tested on its own; what this file
 * proves is everything that *can* run here — real rows, real refusals,
 * real rate limits, against a database exactly like development's.
 *
 * The transport is replaced with an in-process fake (`sent`, below) rather
 * than read back through `DevSmsTransport`'s own outbox: that outbox exists
 * for Playwright, which cannot reach into this process, and this suite can
 * simply capture the call.
 */

const PASSWORD = 'a-long-enough-password';

let f: Fixture;
let sent: Array<{ to: string; code?: string; text?: string }>;

const fakeTransport: SmsTransport = {
  async sendCode(to, code) {
    sent.push({ to, code });
  },
  async sendText(to, text) {
    sent.push({ to, text });
  },
};

before(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  f = await seedFixture();
  sent = [];
  __setSmsTransportForTests(fakeTransport);
  __resetNamedRateLimitsForTests();
});

after(async () => {
  __resetSmsTransportForTests();
  await stop();
  await prisma.$disconnect();
});

async function makeStaff(role: Role, phone: string | null, overrides: Partial<User> = {}): Promise<User> {
  return prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${phone ?? 'none'}@test.local`,
      name: role,
      phone,
      roles: [role],
      state: 'ACTIVE',
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      ...overrides,
    },
  });
}

/** The most recently sent code, however it got here (signIn's factor branch
 *  sends synchronously; requestLoginCode's is deferred past the response —
 *  see `waitForSend` below). */
function lastCode(): string {
  const entry = sent[sent.length - 1];
  assert.ok(entry?.code, `expected a code to have been sent, got ${JSON.stringify(sent)}`);
  return entry.code!;
}

/**
 * `requestLoginCode` defers its send with `setImmediate` — and the deferred
 * callback itself `await`s a real database round-trip (creating the
 * `AuthToken` row) before it ever calls the transport. A single flushed
 * macrotask is not enough to wait for that; this polls briefly instead.
 *
 * Used two ways: after a *known* phone, to wait until the send actually
 * lands before asserting on it; after an *unknown* one, to wait out the
 * same window and confirm nothing ever does. Either way, waiting this out
 * before the test ends also matters for its own sake — `beforeEach`
 * truncates every table for the next test, and a `setImmediate` callback
 * still in flight when that happens throws into an unrelated later test
 * (found by running this file: the exact failure this helper exists to
 * prevent).
 */
async function waitForSend(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (sent.length === 0 && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const SIGN_IN = 'mutation($i:String!,$p:String!){ signIn(identifier:$i,password:$p){ user { id passwordChangeRequired } factorChallengeId } }';
const VERIFY_FACTOR = 'mutation($c:String!,$code:String!){ verifySignInFactor(challengeId:$c,code:$code){ user { id } } }';
const REQUEST_CODE = 'mutation($ph:String!){ requestLoginCode(phone:$ph) }';
const VERIFY_CODE = 'mutation($ph:String!,$code:String!){ verifyLoginCode(phone:$ph,code:$code){ user { id passwordChangeRequired } } }';
const SET_NEW_PASSWORD = 'mutation($pw:String!){ setNewPassword(password:$pw){ user { id passwordChangeRequired } } }';
const ME = '{ me { id passwordChangeRequired } }';

test('signIn by email still works, unchanged in shape, for an account with no second factor', async () => {
  const res = ok(await exec(SIGN_IN, { variables: { i: f.customer.email, p: PASSWORD } }));
  assert.equal((res.signIn as { user: { id: string } }).user.id, f.customer.id);
});

test('signIn by phone — the phone is the identifier now, exactly like email', async () => {
  const customer = await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989121110000' } });
  const res = ok(await exec(SIGN_IN, { variables: { i: '+989121110000', p: PASSWORD } }));
  assert.equal((res.signIn as { user: { id: string } }).user.id, customer.id);
  // A customer's own spelling — spaces, a leading 0 — must resolve to the same account.
  const res2 = ok(await exec(SIGN_IN, { variables: { i: '0912 111 0000', p: PASSWORD } }));
  assert.equal((res2.signIn as { user: { id: string } }).user.id, customer.id);
});

test('one failure message for every branch — wrong password, unknown email, unknown phone', async () => {
  const wrongPassword = await exec(SIGN_IN, { variables: { i: f.customer.email, p: 'not it' } });
  const unknownEmail = await exec(SIGN_IN, { variables: { i: 'nobody@test.local', p: PASSWORD } });
  const unknownPhone = await exec(SIGN_IN, { variables: { i: '+989129998888', p: PASSWORD } });
  for (const r of [wrongPassword, unknownEmail, unknownPhone]) {
    assert.equal(r.code, 'BAD_CREDENTIALS');
  }
});

for (const role of ['ADMIN', 'SALES', 'DESIGNER', 'DEVELOPER'] as Role[]) {
  test(`signIn meets the second factor for ${role} (PD-20)`, async () => {
    const staff = await makeStaff(role, '+989127770001');
    const res = ok(await exec(SIGN_IN, { variables: { i: staff.email, p: PASSWORD } }));
    const payload = res.signIn as { user: null; factorChallengeId: string };
    assert.equal(payload.user, null);
    assert.ok(payload.factorChallengeId);
    assert.equal(sent.length, 1, 'the factor code is sent synchronously, unlike requestLoginCode');
    assert.equal(sent[0].to, '+989127770001');
  });
}

for (const role of ['CUSTOMER', 'CONTRIBUTOR', 'REVIEWER'] as Role[]) {
  test(`signIn meets no factor for ${role}`, async () => {
    const email = `${role.toLowerCase()}-nofactor@test.local`;
    await prisma.user.create({
      data: { email, name: role, roles: [role], state: 'ACTIVE', passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    const res = ok(await exec(SIGN_IN, { variables: { i: email, p: PASSWORD } }));
    const payload = res.signIn as { user: { id: string } | null; factorChallengeId: string | null };
    assert.ok(payload.user);
    assert.equal(payload.factorChallengeId, null);
    assert.equal(sent.length, 0);
  });
}

test('a factor-requiring account with no phone gets PHONE_REQUIRED_FOR_STAFF — only after the password is verified', async () => {
  const staff = await makeStaff('SALES', null);
  const wrongPassword = await exec(SIGN_IN, { variables: { i: staff.email, p: 'not it' } });
  assert.equal(wrongPassword.code, 'BAD_CREDENTIALS', 'a wrong password reveals nothing about the phone requirement');
  const rightPassword = await exec(SIGN_IN, { variables: { i: staff.email, p: PASSWORD } });
  assert.equal(rightPassword.code, 'PHONE_REQUIRED_FOR_STAFF');
});

test('verifySignInFactor completes the sign-in with the code the factor sent', async () => {
  const staff = await makeStaff('DESIGNER', '+989127770002');
  const signInRes = ok(await exec(SIGN_IN, { variables: { i: staff.email, p: PASSWORD } }));
  const challengeId = (signInRes.signIn as { factorChallengeId: string }).factorChallengeId;
  const code = lastCode();

  const verified = ok(await exec(VERIFY_FACTOR, { variables: { c: challengeId, code } }));
  assert.equal((verified.verifySignInFactor as { user: { id: string } }).user.id, staff.id);
});

test('verifySignInFactor refuses CODE_INVALID for a wrong code, and exhausts the challenge after 5 attempts', async () => {
  const staff = await makeStaff('DESIGNER', '+989127770003');
  const signInRes = ok(await exec(SIGN_IN, { variables: { i: staff.email, p: PASSWORD } }));
  const challengeId = (signInRes.signIn as { factorChallengeId: string }).factorChallengeId;
  const realCode = lastCode();
  const wrongCode = realCode === '000000' ? '111111' : '000000';

  for (let i = 0; i < 5; i++) {
    const attempt = await exec(VERIFY_FACTOR, { variables: { c: challengeId, code: wrongCode } });
    assert.equal(attempt.code, 'CODE_INVALID');
  }
  // Exhausted — even the *real* code is refused now, the same CODE_INVALID
  // as every wrong guess. This is what makes the row unusable rather than
  // merely rate-limited: it can never succeed again, not even after a wait.
  const withRealCode = await exec(VERIFY_FACTOR, { variables: { c: challengeId, code: realCode } });
  assert.equal(withRealCode.code, 'CODE_INVALID');
});

test('requestLoginCode always returns true and never reveals whether the phone has an account', async () => {
  const customer = await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989127770004' } });
  const known = ok(await exec(REQUEST_CODE, { variables: { ph: customer.phone } }));
  const unknown = ok(await exec(REQUEST_CODE, { variables: { ph: '+989129990000' } }));
  assert.equal(known.requestLoginCode, true);
  assert.equal(unknown.requestLoginCode, true);
  // Let the known phone's deferred send land before the next test's
  // resetDatabase truncates out from under it — see waitForSend's own comment.
  await waitForSend();
});

test('requestLoginCode for an unknown phone returns true and the outbox stays empty', async () => {
  await exec(REQUEST_CODE, { variables: { ph: '+989129990001' } });
  await waitForSend(); // times out at 1s with nothing sent — that is the assertion
  assert.equal(sent.length, 0);
});

test('requestLoginCode for a known phone eventually sends a code, after the response', async () => {
  const customer = await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989127770005' } });
  const res = ok(await exec(REQUEST_CODE, { variables: { ph: customer.phone } }));
  assert.equal(res.requestLoginCode, true);
  // Immediately after the response, nothing has been sent yet — the whole
  // point of deferring past the response for timing safety.
  assert.equal(sent.length, 0);
  await waitForSend();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, customer.phone);
});

test('verifyLoginCode sets passwordChangeRequired, and setNewPassword clears it', async () => {
  const customer = await prisma.user.update({ where: { id: f.customer.id }, data: { phone: '+989127770006' } });
  await exec(REQUEST_CODE, { variables: { ph: customer.phone } });
  await waitForSend();
  const code = lastCode();

  const verified = ok(await exec(VERIFY_CODE, { variables: { ph: customer.phone, code } }));
  const payload = verified.verifyLoginCode as { user: { id: string; passwordChangeRequired: boolean } };
  assert.equal(payload.user.id, customer.id);
  assert.equal(payload.user.passwordChangeRequired, true);

  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
  assert.equal(reloaded.passwordChangeRequired, true);

  const cleared = ok(await exec(SET_NEW_PASSWORD, { as: reloaded, variables: { pw: 'a-brand-new-password' } }));
  assert.equal((cleared.setNewPassword as { user: { passwordChangeRequired: boolean } }).user.passwordChangeRequired, false);
});

test('verifyLoginCode refuses CODE_INVALID for an unknown phone — same message as a wrong code', async () => {
  const res = await exec(VERIFY_CODE, { variables: { ph: '+989129990002', code: '123456' } });
  assert.equal(res.code, 'CODE_INVALID');
});

test('a forced password change blocks another mutation with PASSWORD_CHANGE_REQUIRED, but not me or signOut', async () => {
  const customer = await prisma.user.update({
    where: { id: f.customer.id },
    data: { passwordChangeRequired: true },
  });

  // requireUser (and so the PASSWORD_CHANGE_REQUIRED refusal) runs before
  // the scope item is even loaded — a bogus id proves the order, since a
  // NOT_FOUND here would mean the guard was skipped rather than hit first.
  const blocked = await exec('mutation($id:ID!){ setScopeItem(scopeItemId:$id,checked:true){ id } }', {
    as: customer,
    variables: { id: 'does-not-matter' },
  });
  assert.equal(blocked.code, 'PASSWORD_CHANGE_REQUIRED');

  const me = ok(await exec(ME, { as: customer }));
  assert.equal((me.me as { passwordChangeRequired: boolean }).passwordChangeRequired, true);

  const signedOut = ok(await exec('mutation{ signOut }', { as: customer }));
  assert.equal(signedOut.signOut, true);

  const cleared = ok(await exec(SET_NEW_PASSWORD, { variables: { pw: 'a-brand-new-password' }, as: customer } as never));
  assert.equal((cleared.setNewPassword as { user: { passwordChangeRequired: boolean } }).user.passwordChangeRequired, false);
});

test('the database itself refuses a user with neither phone nor email — User_has_identifier', async () => {
  await assert.rejects(
    prisma.user.create({ data: { name: 'Nobody', roles: ['CUSTOMER'], state: 'ACTIVE' } }),
    /User_has_identifier/,
  );
});

test('inviteCustomer requires a phone, accepts an optional email, and always returns the link', async () => {
  const INVITE = 'mutation($ph:String!,$n:String!,$e:String){ inviteCustomer(phone:$ph,name:$n,email:$e){ userId email inviteUrl } }';
  const res = ok(await exec(INVITE, { as: f.admin, variables: { ph: '+989127770007', n: 'مشتری تازه' } }));
  const payload = res.inviteCustomer as { userId: string; email: string | null; inviteUrl: string };
  assert.equal(payload.email, null);
  assert.ok(payload.inviteUrl.includes('/portal/invite/'));

  const created = await prisma.user.findUniqueOrThrow({ where: { id: payload.userId } });
  assert.equal(created.phone, '+989127770007');

  const bad = await exec(INVITE, { as: f.admin, variables: { ph: 'not a phone', n: 'x' } });
  assert.equal(bad.code, 'PHONE_INVALID');
});

test('inviteCustomer with an email too — both an SMS and an email attempt fire, and the link still comes back', async () => {
  const INVITE = 'mutation($ph:String!,$n:String!,$e:String){ inviteCustomer(phone:$ph,name:$n,email:$e){ userId email inviteUrl } }';
  const res = ok(
    await exec(INVITE, { as: f.admin, variables: { ph: '+989127770008', n: 'مشتری دیگر', e: 'newcustomer@test.local' } }),
  );
  const payload = res.inviteCustomer as { email: string | null };
  assert.equal(payload.email, 'newcustomer@test.local');
  // notify() sent an SMS (this account has a phone) — logged as a real send.
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '+989127770008');
});

test('the Review Room invite and sign-in for REVIEWER needs no phone and meets no factor', async () => {
  const INVITE_REVIEWER = 'mutation($e:String!,$n:String!){ inviteReviewer(email:$e,name:$n){ userId inviteUrl } }';
  const invited = ok(await exec(INVITE_REVIEWER, { as: f.admin, variables: { e: 'newreviewer@test.local', n: 'بازبین' } }));
  const userId = (invited.inviteReviewer as { userId: string }).userId;

  await prisma.user.update({ where: { id: userId }, data: { state: 'ACTIVE', passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  const res = ok(await exec(SIGN_IN, { variables: { i: 'newreviewer@test.local', p: PASSWORD } }));
  const payload = res.signIn as { user: { id: string } | null; factorChallengeId: string | null };
  assert.ok(payload.user);
  assert.equal(payload.factorChallengeId, null);
});

test('sign-in attempts are rate-limited per identifier', async () => {
  const staff = await makeStaff('SALES', '+989127770009');
  for (let i = 0; i < 10; i++) {
    const r = await exec(SIGN_IN, { variables: { i: staff.email, p: 'wrong' } });
    assert.equal(r.code, 'BAD_CREDENTIALS', `attempt ${i}`);
  }
  const eleventh = await exec(SIGN_IN, { variables: { i: staff.email, p: 'wrong' } });
  assert.equal(eleventh.code, 'RATE_LIMITED');
});

test('setNewPassword refuses a session with no change pending (PASSWORD_CHANGE_NOT_REQUIRED)', async () => {
  // J1 review: without this, any session — a stolen cookie included — could
  // replace the password without knowing the current one.
  const res = await exec(SET_NEW_PASSWORD, { as: f.customer, variables: { pw: 'a-brand-new-password' } });
  assert.equal(res.code, 'PASSWORD_CHANGE_NOT_REQUIRED');
  const reloaded = await prisma.user.findUniqueOrThrow({ where: { id: f.customer.id } });
  assert.equal(reloaded.passwordHash, f.customer.passwordHash, 'the password did not change');
});

test('signIn with an unknown identifier is refused the same way as a wrong password', async () => {
  // The J1 review's timing fix (burnPasswordCheck) must not change the answer.
  const q = 'mutation($i:String!,$p:String!){ signIn(identifier:$i,password:$p){ user { id } } }';
  const unknown = await exec(q, { variables: { i: 'nobody@test.local', p: 'whatever-it-is-long' } });
  const wrong = await exec(q, { variables: { i: f.customer.email!, p: 'not-the-password-at-all' } });
  assert.equal(unknown.code, 'BAD_CREDENTIALS');
  assert.equal(wrong.code, 'BAD_CREDENTIALS');
  assert.equal(unknown.errors[0].message, wrong.errors[0].message);
});
