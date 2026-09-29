import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateLoginCode,
  hashLoginCode,
  loginCodeExpiresAt,
  loginCodeIsValid,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_TTL_MS,
  type LoginCodeRow,
} from './loginCode.js';

test('generateLoginCode is always six digits, zero-padded', () => {
  for (let i = 0; i < 200; i++) {
    const code = generateLoginCode();
    assert.equal(code.length, 6);
    assert.match(code, /^\d{6}$/);
  }
});

test('hashLoginCode is deterministic for the same token id and code', () => {
  assert.equal(hashLoginCode('tok_1', '123456'), hashLoginCode('tok_1', '123456'));
});

test('hashLoginCode differs across token ids for the same code — a leaked hash proves nothing about another row', () => {
  assert.notEqual(hashLoginCode('tok_1', '123456'), hashLoginCode('tok_2', '123456'));
});

test('hashLoginCode differs across codes for the same token', () => {
  assert.notEqual(hashLoginCode('tok_1', '123456'), hashLoginCode('tok_1', '654321'));
});

test('loginCodeExpiresAt is exactly the TTL ahead of the given instant', () => {
  const now = 1_000_000;
  assert.equal(loginCodeExpiresAt(now).getTime(), now + LOGIN_CODE_TTL_MS);
});

function row(overrides: Partial<LoginCodeRow> = {}): LoginCodeRow {
  return {
    tokenHash: hashLoginCode('tok_1', '123456'),
    attempts: 0,
    usedAt: null,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

test('a fresh, matching code is valid', () => {
  assert.equal(loginCodeIsValid(row(), '123456', 'tok_1'), true);
});

test('the wrong code is invalid', () => {
  assert.equal(loginCodeIsValid(row(), '000000', 'tok_1'), false);
});

test('an already-used code is invalid, even with the right digits', () => {
  assert.equal(loginCodeIsValid(row({ usedAt: new Date() }), '123456', 'tok_1'), false);
});

test('a revoked code is invalid', () => {
  assert.equal(loginCodeIsValid(row({ revokedAt: new Date() }), '123456', 'tok_1'), false);
});

test('an expired code is invalid', () => {
  assert.equal(loginCodeIsValid(row({ expiresAt: new Date(Date.now() - 1000) }), '123456', 'tok_1'), false);
});

test('a code that has exhausted its attempts is invalid, even when correct', () => {
  assert.equal(
    loginCodeIsValid(row({ attempts: LOGIN_CODE_MAX_ATTEMPTS }), '123456', 'tok_1'),
    false,
  );
});

test('one attempt short of the max still allows a correct guess through', () => {
  assert.equal(
    loginCodeIsValid(row({ attempts: LOGIN_CODE_MAX_ATTEMPTS - 1 }), '123456', 'tok_1'),
    true,
  );
});

test('a code hashed against a different token id never validates against this one', () => {
  // The row was hashed for 'tok_1'; checking it as if it belonged to 'tok_2'
  // must fail even with the right six digits — otherwise a code leaked from
  // one challenge would validate a different one entirely.
  assert.equal(loginCodeIsValid(row(), '123456', 'tok_2'), false);
});
