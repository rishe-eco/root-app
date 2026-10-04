import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkStagingUrl } from './stagingHost.js';

const PROD = { baseDomain: 'staging.m-root.com', production: true };
const DEV = { baseDomain: 'staging.localhost', production: false };

const refusal = (url: string, options = PROD) => {
  const result = checkStagingUrl(url, options);
  return result.ok ? 'ok' : result.reason;
};

describe('checkStagingUrl — production', () => {
  test('exactly one label under the base, over https, passes', () => {
    const result = checkStagingUrl('https://nahal.staging.m-root.com/', PROD);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.host, 'nahal.staging.m-root.com');
    assert.equal(refusal('https://nahal-2.staging.m-root.com/shop?x=1'), 'ok', 'a path and query are part of the address, not of the host');
  });

  test('a host that merely contains the base is refused — the check is on the suffix', () => {
    assert.equal(refusal('https://staging.m-root.com.evil.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://nahal.staging.m-root.com.evil.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://evilstaging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED', 'a label run into the base is not a label under it');
    assert.equal(refusal('https://nahal.staging.m-root.org/'), 'STAGING_HOST_NOT_ALLOWED');
  });

  test('two labels, the bare base and an empty label are refused', () => {
    assert.equal(refusal('https://a.b.staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://.staging.m-root.com/'), 'INVALID_STAGING_URL');
  });

  test('a label must be a DNS label: no leading or trailing hyphen, no underscore', () => {
    assert.equal(refusal('https://-a.staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://a-.staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://a_b.staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal(`https://${'a'.repeat(64)}.staging.m-root.com/`), 'INVALID_STAGING_URL', 'the parser itself refuses a label over 63 characters');
  });

  test('userinfo is refused whatever the host is', () => {
    assert.equal(refusal('https://staging.m-root.com@evil.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://user:pw@nahal.staging.m-root.com/'), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('https://nahal.staging.m-root.com@evil.com/'), 'STAGING_HOST_NOT_ALLOWED');
  });

  test('production refuses http and an explicit port', () => {
    assert.equal(refusal('http://nahal.staging.m-root.com/'), 'STAGING_NOT_HTTPS');
    assert.equal(refusal('https://nahal.staging.m-root.com:8443/'), 'STAGING_HOST_NOT_ALLOWED');
  });

  test('uppercase is the same host: accepted, and stored lowercased', () => {
    const result = checkStagingUrl('HTTPS://Nahal.STAGING.M-Root.com/Shop', PROD);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.normalized, 'https://nahal.staging.m-root.com/Shop');
  });

  test('a trailing dot is the DNS root, not a label', () => {
    assert.equal(refusal('https://nahal.staging.m-root.com./'), 'ok');
    assert.equal(refusal('https://staging.m-root.com./'), 'STAGING_HOST_NOT_ALLOWED');
  });

  test('what is not an http(s) URL is invalid', () => {
    for (const bad of ['', 'nahal.staging.m-root.com', 'ftp://nahal.staging.m-root.com/', 'javascript:alert(1)', 'data:text/html,hi', '//nahal.staging.m-root.com']) {
      assert.equal(refusal(bad), 'INVALID_STAGING_URL', bad);
    }
  });
});

describe('checkStagingUrl — development and e2e', () => {
  test('http, https and a port are accepted on *.staging.localhost', () => {
    assert.equal(refusal('http://nahal.staging.localhost:5179/', DEV), 'ok');
    assert.equal(refusal('https://nahal.staging.localhost/', DEV), 'ok');
  });

  test('the host rule is as strict as in production', () => {
    assert.equal(refusal('http://staging.localhost.evil.com/', DEV), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('http://a.b.staging.localhost:5179/', DEV), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('http://staging.localhost:5179/', DEV), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('http://x.staging.localhost:5179@evil.com/', DEV), 'STAGING_HOST_NOT_ALLOWED');
    assert.equal(refusal('http://nahal.staging.m-root.com/', DEV), 'STAGING_HOST_NOT_ALLOWED', 'the production base is not the development one');
  });
});
