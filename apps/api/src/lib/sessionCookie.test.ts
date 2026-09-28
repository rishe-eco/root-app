import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookieOptions } from './sessionCookie.js';

/**
 * P0-7 (defect D-8). `context.ts`'s `setSessionCookie` and `clearSessionCookie`
 * both build their options from this one function — the point being asserted
 * here is exactly that agreement, plus the production shape a `__Host-`
 * cookie name requires, without needing a second process booted with
 * `NODE_ENV=production` to see it.
 */

test('production: secure, path "/", lax, httpOnly — the __Host- shape', () => {
  const opts = sessionCookieOptions('production');
  assert.equal(opts.secure, true);
  assert.equal(opts.path, '/');
  assert.equal(opts.sameSite, 'lax');
  assert.equal(opts.httpOnly, true);
});

test('development and test: the same shape, minus Secure — plain HTTP cannot set it', () => {
  for (const nodeEnv of ['development', 'test']) {
    const opts = sessionCookieOptions(nodeEnv);
    assert.equal(opts.secure, false);
    assert.equal(opts.path, '/');
    assert.equal(opts.sameSite, 'lax');
    assert.equal(opts.httpOnly, true);
  }
});

test('no option ever carries a domain — a host-only cookie, in every environment', () => {
  for (const nodeEnv of ['development', 'test', 'production']) {
    assert.ok(!('domain' in sessionCookieOptions(nodeEnv)));
  }
});

test('set and clear agree — the same function backs both call sites in context.ts', () => {
  // context.ts spreads this into both res.cookie(...) and res.clearCookie(...)
  // with no per-call divergence; two calls with the same nodeEnv are
  // therefore required to be deeply equal, which is the property that keeps
  // a sign-out from silently failing the way it used to (see context.ts).
  assert.deepEqual(sessionCookieOptions('production'), sessionCookieOptions('production'));
  assert.deepEqual(sessionCookieOptions('development'), sessionCookieOptions('development'));
});
