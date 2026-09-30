import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { grantIdFromHost, isMockupHost, mockupUrl } from './mockupHost.js';

const BASE = 'mockup.m-root.com';
const ID = 'abcdef0123456789abcdef0123456789'; // 32 lowercase hex characters

describe('grantIdFromHost', () => {
  test('a well-formed grant host resolves to its id', () => {
    assert.equal(grantIdFromHost(`${ID}.${BASE}`, BASE), ID);
  });

  test('a port suffix is stripped before parsing', () => {
    assert.equal(grantIdFromHost(`${ID}.${BASE}:4101`, BASE), ID);
  });

  test('uppercase in the host folds to the same id — DNS is case-insensitive', () => {
    assert.equal(grantIdFromHost(`${ID.toUpperCase()}.${BASE.toUpperCase()}`, BASE), ID);
  });

  test('a trailing dot (the DNS root label) is ignored', () => {
    assert.equal(grantIdFromHost(`${ID}.${BASE}.`, BASE), ID);
  });

  test('two labels under the base domain is refused, not truncated to the first', () => {
    assert.equal(grantIdFromHost(`extra.${ID}.${BASE}`, BASE), null);
  });

  test('the bare base domain, with no label at all, is refused', () => {
    assert.equal(grantIdFromHost(BASE, BASE), null);
  });

  test('a label one character longer than 32 is refused', () => {
    assert.equal(grantIdFromHost(`${ID}a.${BASE}`, BASE), null);
  });

  test('a label one character shorter than 32 is refused', () => {
    assert.equal(grantIdFromHost(`${ID.slice(0, -1)}.${BASE}`, BASE), null);
  });

  test('non-hex characters in the label are refused', () => {
    // Exactly 32 characters — isolating "not hex" from "wrong length".
    assert.equal(grantIdFromHost(`${'z'.repeat(32)}.${BASE}`, BASE), null);
  });

  test('an empty host is refused', () => {
    assert.equal(grantIdFromHost('', BASE), null);
  });

  test('a host on an unrelated domain is refused', () => {
    assert.equal(grantIdFromHost(`${ID}.staging.m-root.com`, BASE), null);
    assert.equal(grantIdFromHost('app.m-root.com', BASE), null);
  });

  test('a host that merely ends with the base domain\'s letters, without the separating dot, is refused', () => {
    assert.equal(grantIdFromHost(`x${BASE}`, BASE), null);
  });

  test('the local/e2e base domain works the same way', () => {
    assert.equal(grantIdFromHost(`${ID}.mockup.localhost:4101`, 'mockup.localhost'), ID);
  });
});

describe('mockupUrl', () => {
  test('builds the production form by default', () => {
    assert.equal(mockupUrl(ID, BASE), `https://${ID}.${BASE}/`);
  });

  test('builds the local/e2e form with an explicit protocol and port', () => {
    assert.equal(
      mockupUrl(ID, 'mockup.localhost', { protocol: 'http', port: 4101 }),
      `http://${ID}.mockup.localhost:4101/`,
    );
  });
});

describe('isMockupHost — the fence is wider than the parser', () => {
  test('the base domain itself, and everything under it, is a mockup host', () => {
    for (const host of [
      BASE,
      `${ID}.${BASE}`,
      `${ID}.${BASE}:4101`,
      `abc.${BASE}`, // one label, not a grant id
      `a.b.${BASE}`, // two labels
      `${ID.toUpperCase()}.${BASE.toUpperCase()}`,
      `${ID}.${BASE}.`, // the DNS root label spelled out
    ]) {
      assert.equal(isMockupHost(host, BASE), true, host);
    }
  });

  test('exactly the hosts grantIdFromHost refuses are still inside the fence', () => {
    // The point of the second function: these all parse to null, and none of
    // them may reach the portal.
    for (const host of [BASE, `abc.${BASE}`, `a.b.${BASE}`, `${'z'.repeat(32)}.${BASE}`]) {
      assert.equal(grantIdFromHost(host, BASE), null, host);
      assert.equal(isMockupHost(host, BASE), true, host);
    }
  });

  test('unrelated hosts, the portal, and look-alikes are outside it', () => {
    for (const host of [
      '',
      'app.m-root.com',
      'm-root.com',
      `${ID}.staging.m-root.com`,
      `x${BASE}`, // no separating dot
      `${BASE}.evil.com`, // the base domain as a prefix of someone else's
      'localhost:5173',
      '127.0.0.1:4000',
    ]) {
      assert.equal(isMockupHost(host, BASE), false, host);
    }
  });
});
