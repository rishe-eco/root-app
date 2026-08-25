import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_PREFIX,
  expiryFromDays,
  hashApiToken,
  looksLikeApiToken,
  newApiToken,
} from './apiTokens.js';

/**
 * The parts of the token service that are pure — generation, the digest, and
 * the expiry arithmetic. `authenticateApiToken` needs a database and lives in
 * the integration suite, where a real row can be revoked, expired, disabled
 * and demoted out from under it.
 */

// --- generation -------------------------------------------------------------

test('a new token carries the prefix that identifies it in a log', () => {
  const { raw, prefix } = newApiToken();
  assert.ok(raw.startsWith(TOKEN_PREFIX));
  assert.ok(looksLikeApiToken(raw));
  assert.ok(raw.startsWith(prefix), 'the display prefix must be a prefix of the real token');
});

test('the display prefix is short enough not to be the token', () => {
  const { raw, prefix } = newApiToken();
  // A safety property, not a cosmetic one: the prefix is stored in plaintext
  // and shown in the UI, so if it ever grew to most of the token the table
  // would be publishing the secret it exists to avoid publishing.
  assert.ok(prefix.length < raw.length / 3, `prefix ${prefix.length} vs token ${raw.length}`);
});

test('two tokens are never the same token', () => {
  const seen = new Set(Array.from({ length: 200 }, () => newApiToken().raw));
  assert.equal(seen.size, 200);
});

test('the raw token is not recoverable from what gets stored', () => {
  const { raw, hash, prefix } = newApiToken();
  assert.ok(!hash.includes(raw.slice(TOKEN_PREFIX.length)));
  assert.ok(!raw.includes(hash));
  // The prefix is the *only* plaintext kept, and the secret half is not in it.
  assert.ok(!prefix.includes(raw.slice(prefix.length)));
});

// --- the digest -------------------------------------------------------------

test('hashing is deterministic, and the stored hash matches it', () => {
  const { raw, hash } = newApiToken();
  assert.equal(hashApiToken(raw), hash);
  assert.equal(hashApiToken(raw), hashApiToken(raw));
});

test('the digest is a full-length hex SHA-256', () => {
  // Length is load-bearing: `digestsMatch` compares equal-length buffers only,
  // so a truncated digest would fail closed rather than match loosely — but it
  // would fail *silently*, which is worth catching here instead.
  assert.match(hashApiToken('root_whatever'), /^[0-9a-f]{64}$/);
});

test('one different character is a different digest', () => {
  assert.notEqual(hashApiToken('root_aaaa'), hashApiToken('root_aaab'));
});

// --- looksLikeApiToken ------------------------------------------------------

test('a session JWT is not mistaken for an API token', () => {
  // This is what keeps `buildContext` from spending a database lookup — and
  // an authentication decision — on a credential of the other kind.
  assert.equal(looksLikeApiToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.x'), false);
  assert.equal(looksLikeApiToken(''), false);
  assert.equal(looksLikeApiToken('Bearer root_abc'), false);
});

// --- expiry -----------------------------------------------------------------

test('no expiry is null, not a date far away', () => {
  assert.equal(expiryFromDays(null), null);
  assert.equal(expiryFromDays(undefined), null);
});

test('a day count becomes that many days from now', () => {
  const before = Date.now();
  const at = expiryFromDays(30);
  assert.ok(at !== null);
  const expected = before + 30 * 24 * 60 * 60 * 1000;
  // A second of slack for the clock moving between the two reads.
  assert.ok(Math.abs(at.getTime() - expected) < 1000);
});

test('zero, negative and fractional day counts are refused, not rounded', () => {
  // An already-expired token is not a short-lived one; it is a token that
  // never works, and accepting it would send someone debugging their client.
  for (const bad of [0, -1, 0.5, NaN]) {
    assert.throws(() => expiryFromDays(bad), RangeError, `expected ${bad} to be refused`);
  }
});
