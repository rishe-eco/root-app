import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultCookieName, assertCookieNameIsHardened } from './env.js';

/**
 * P0-7 (defect D-8): the cookie name's production default and the refusal
 * that backs it, tested as pure functions rather than by booting a second
 * process with `NODE_ENV=production` — the whole point of pulling them out of
 * the `parsed.data` pipeline (see env.ts's own comments on both).
 *
 * Importing `env.js` here does run its module-level `safeParse` once, exactly
 * as every other test in this workspace does — see `apps/api/.env` (gitignored,
 * created once per checkout) and package.json's `test:integration`, which
 * pins `JWT_SECRET` for the same reason. It parses this *process's* real
 * `NODE_ENV` (`test` under `node:test`), so it never actually exercises the
 * production branch this file is testing — that is exactly why these two
 * functions had to be pulled out and given their own `nodeEnv` parameter.
 */

test('defaultCookieName: __Host- in production, unprefixed everywhere else', () => {
  assert.equal(defaultCookieName('production'), '__Host-root_session');
  assert.equal(defaultCookieName('development'), 'root_session');
  assert.equal(defaultCookieName('test'), 'root_session');
});

test('assertCookieNameIsHardened: refuses a production COOKIE_NAME without the __Host- prefix', () => {
  assert.throws(
    () => assertCookieNameIsHardened('production', 'root_session'),
    /COOKIE_NAME must start with "__Host-" in production/,
  );
});

test('assertCookieNameIsHardened: an operator’s old .env (COOKIE_NAME=root_session, today’s default) fails loudly rather than silently keeping the weak cookie', () => {
  // The exact trap named in the P0-7 brief: today's own default, carried
  // forward unchanged into a production .env after this change ships.
  assert.throws(() => assertCookieNameIsHardened('production', 'root_session'));
});

test('assertCookieNameIsHardened: a correctly prefixed name in production passes', () => {
  assert.doesNotThrow(() => assertCookieNameIsHardened('production', '__Host-root_session'));
  assert.doesNotThrow(() => assertCookieNameIsHardened('production', '__Host-something-else'));
});

test('assertCookieNameIsHardened: development and test are never checked, whatever the name is', () => {
  assert.doesNotThrow(() => assertCookieNameIsHardened('development', 'root_session'));
  assert.doesNotThrow(() => assertCookieNameIsHardened('test', 'root_session'));
  assert.doesNotThrow(() => assertCookieNameIsHardened('development', 'anything-at-all'));
});
