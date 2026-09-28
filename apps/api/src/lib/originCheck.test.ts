import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideOriginCheck } from './originCheck.js';

/**
 * The pure decision, exhaustively — every branch the module comment lists,
 * with no Express and no environment involved. `originCheck.ts` itself is
 * exercised end to end by `test/files.test.ts` and `test/r4.test.ts`, which
 * confirm the middleware is actually wired to this function; this file is
 * where every combination the wiring test would be tedious to repeat lives.
 */

const APP_ORIGIN = 'https://portal.m-root.com';

test('a safe method is always allowed, cookie and foreign Origin notwithstanding', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head', 'Options']) {
    assert.equal(
      decideOriginCheck({ method, hasSessionCookie: true, origin: 'https://evil.example', appOrigin: APP_ORIGIN }),
      'allow',
      `${method} must be allowed regardless`,
    );
  }
});

test('a state-changing method with no session cookie is allowed — Bearer clients and anonymous callers go to their own checks', () => {
  assert.equal(
    decideOriginCheck({ method: 'POST', hasSessionCookie: false, origin: 'https://evil.example', appOrigin: APP_ORIGIN }),
    'allow',
  );
});

test('a state-changing method with a cookie and no Origin header is allowed — a non-browser client', () => {
  assert.equal(
    decideOriginCheck({ method: 'POST', hasSessionCookie: true, origin: null, appOrigin: APP_ORIGIN }),
    'allow',
  );
});

test('a state-changing method with a cookie and the exact app Origin is allowed', () => {
  assert.equal(
    decideOriginCheck({ method: 'POST', hasSessionCookie: true, origin: APP_ORIGIN, appOrigin: APP_ORIGIN }),
    'allow',
  );
});

test('a state-changing method with a cookie and a foreign Origin is refused', () => {
  assert.equal(
    decideOriginCheck({ method: 'POST', hasSessionCookie: true, origin: 'https://evil.example', appOrigin: APP_ORIGIN }),
    'refuse',
  );
});

test('a sibling subdomain — same-site, different origin — is refused, which is the whole point of this module', () => {
  assert.equal(
    decideOriginCheck({
      method: 'POST',
      hasSessionCookie: true,
      origin: 'https://some-grant.mockup.m-root.com',
      appOrigin: APP_ORIGIN,
    }),
    'refuse',
  );
});

test('a different port on localhost is refused — origin equality is exact, not "same host"', () => {
  assert.equal(
    decideOriginCheck({
      method: 'POST',
      hasSessionCookie: true,
      origin: 'http://localhost:4000',
      appOrigin: 'http://localhost:5173',
    }),
    'refuse',
  );
});

test('http vs https on the same host is refused — scheme is part of an origin', () => {
  assert.equal(
    decideOriginCheck({
      method: 'POST',
      hasSessionCookie: true,
      origin: 'http://portal.m-root.com',
      appOrigin: 'https://portal.m-root.com',
    }),
    'refuse',
  );
});

test('the literal string "null" (a sandboxed iframe, a file: page) is a mismatch, with no special case needed', () => {
  assert.equal(
    decideOriginCheck({ method: 'POST', hasSessionCookie: true, origin: 'null', appOrigin: APP_ORIGIN }),
    'refuse',
  );
});

test('a trailing slash in APP_ORIGIN configuration must not refuse everyone', () => {
  // A browser's Origin header never carries a path or a trailing slash — it
  // is always exactly `new URL(x).origin`. If the config itself has one
  // (`https://portal.m-root.com/`, say, from a copy-pasted .env value) and
  // the raw string were compared against the header, every legitimate
  // request would be refused. originCheck.ts normalizes with `new
  // URL(env.APP_ORIGIN).origin` before ever calling decideOriginCheck — this
  // proves that normalization is what makes the comparison forgiving, not
  // some special case inside the decision itself.
  const normalized = new URL('https://portal.m-root.com/').origin;
  assert.equal(normalized, 'https://portal.m-root.com');
  assert.equal(
    decideOriginCheck({
      method: 'POST',
      hasSessionCookie: true,
      origin: 'https://portal.m-root.com',
      appOrigin: normalized,
    }),
    'allow',
  );
});

test('every other verb that changes state is covered by the same rule as POST', () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    assert.equal(
      decideOriginCheck({ method, hasSessionCookie: true, origin: 'https://evil.example', appOrigin: APP_ORIGIN }),
      'refuse',
    );
  }
});
