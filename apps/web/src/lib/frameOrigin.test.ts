import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptsFrameMessage, originOf } from './frameOrigin.js';

/** Journeys build plan J9b — the viewport's postMessage origin check. */

const GRANT = 'http://0123456789abcdef0123456789abcdef.mockup.localhost:5151/';
const PROD = 'https://0123456789abcdef0123456789abcdef.mockup.m-root.com/';

test('the frame’s own origin is accepted — whatever path the page is on', () => {
  assert.equal(acceptsFrameMessage('http://0123456789abcdef0123456789abcdef.mockup.localhost:5151', GRANT), true);
  assert.equal(acceptsFrameMessage('https://0123456789abcdef0123456789abcdef.mockup.m-root.com', PROD), true);
  assert.equal(acceptsFrameMessage('https://0123456789abcdef0123456789abcdef.mockup.m-root.com', `${PROD}shop/cart.html?x=1#y`), true);
});

test('nothing broader is accepted: another viewer’s grant, a sibling or parent host, another scheme or port, a look-alike', () => {
  const refused = [
    // another viewer’s mockup on the same wildcard
    'https://fedcba9876543210fedcba9876543210.mockup.m-root.com',
    // the wildcard’s base domain and its parents
    'https://mockup.m-root.com',
    'https://m-root.com',
    // a deeper subdomain of the grant
    'https://x.0123456789abcdef0123456789abcdef.mockup.m-root.com',
    // another scheme or port
    'http://0123456789abcdef0123456789abcdef.mockup.m-root.com',
    'https://0123456789abcdef0123456789abcdef.mockup.m-root.com:8443',
    // look-alikes that a suffix or prefix test would let through
    'https://0123456789abcdef0123456789abcdef.mockup.m-root.com.evil.example',
    'https://evil-0123456789abcdef0123456789abcdef.mockup.m-root.com',
    // the portal itself, and the opaque origin
    'https://app.m-root.com',
    'null',
    '',
    '*',
  ];
  for (const origin of refused) assert.equal(acceptsFrameMessage(origin, PROD), false, origin);
  assert.equal(acceptsFrameMessage('http://0123456789abcdef0123456789abcdef.mockup.localhost:5152', GRANT), false, 'the dev port counts too');
});

test('a viewport that cannot name its frame’s origin accepts nothing — never "*"', () => {
  for (const url of [null, undefined, '', 'not a url', 'data:text/html,hi']) {
    assert.equal(originOf(url), null, String(url));
    assert.equal(acceptsFrameMessage('null', url), false, String(url));
    assert.equal(acceptsFrameMessage('https://anything.example', url), false, String(url));
  }
});
