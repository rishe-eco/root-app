import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_REASON_MAX,
  MESSAGE_MAX,
  REQUEST_BODY_MAX,
  REQUEST_TITLE_MAX,
  acceptsMessages,
  checkArchiveReason,
  checkNewRequest,
  checkRequestMessage,
} from './requests.js';

/** Journeys build plan J2 — the request rules, as tables. The resolver only has to prove it asks. */

test('checkNewRequest: the first refusal a request earns, in the order a person would fix them', () => {
  const ok = { title: 'A shop', body: 'Sell prints.', lang: 'fa' };
  assert.equal(checkNewRequest(ok), null);
  assert.equal(checkNewRequest({ ...ok, lang: 'en' }), null);
  assert.equal(checkNewRequest({ ...ok, title: '  \n' }), 'EMPTY_TITLE');
  assert.equal(checkNewRequest({ ...ok, body: '' }), 'EMPTY_BODY');
  assert.equal(checkNewRequest({ ...ok, title: '' , body: '' }), 'EMPTY_TITLE');
  assert.equal(checkNewRequest({ ...ok, title: 'x'.repeat(REQUEST_TITLE_MAX + 1) }), 'TOO_LONG');
  assert.equal(checkNewRequest({ ...ok, body: 'y'.repeat(REQUEST_BODY_MAX + 1) }), 'TOO_LONG');
  assert.equal(checkNewRequest({ ...ok, lang: 'de' }), 'INVALID_LANG');
  // The limits are on the trimmed text: padding does not count against a person.
  assert.equal(checkNewRequest({ ...ok, title: ` ${'x'.repeat(REQUEST_TITLE_MAX)} ` }), null);
});

test('checkRequestMessage and checkArchiveReason', () => {
  assert.equal(checkRequestMessage('hello'), null);
  assert.equal(checkRequestMessage('   '), 'EMPTY_COMMENT');
  assert.equal(checkRequestMessage('m'.repeat(MESSAGE_MAX + 1)), 'TOO_LONG');
  assert.equal(checkArchiveReason('Out of scope'), null);
  assert.equal(checkArchiveReason(' \t'), 'REASON_REQUIRED');
  assert.equal(checkArchiveReason('r'.repeat(ARCHIVE_REASON_MAX + 1)), 'TOO_LONG');
});

test('a thread accepts messages only while the request is pending', () => {
  assert.equal(acceptsMessages('REQUESTED'), true);
  assert.equal(acceptsMessages('ACTIVE'), false, 'converted: read-only');
  assert.equal(acceptsMessages('ARCHIVED'), false);
});
