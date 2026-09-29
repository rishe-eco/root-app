import test from 'node:test';
import assert from 'node:assert/strict';
import { smsAvailable, DevSmsTransport } from './sms.js';

/**
 * PD-18's own decision, as a literal truth table — the same reasoning
 * `env.test.ts` gives for pulling `assertCookieNameIsHardened` out on its
 * own: this cannot be exercised by booting a second process with
 * `NODE_ENV=production` inside a test suite, so it is a pure function of
 * the two things it actually depends on, tested here directly. The
 * integration suite (`j1.test.ts`) covers the other half — real behaviour
 * against the dev transport, which is what every environment this suite
 * can actually boot in uses.
 */
test('smsAvailable: unenforced only in production with no provider — every other combination is available', () => {
  assert.equal(smsAvailable('production', false), false);
  assert.equal(smsAvailable('production', true), true);
  assert.equal(smsAvailable('development', false), true);
  assert.equal(smsAvailable('development', true), true);
  assert.equal(smsAvailable('test', false), true);
  assert.equal(smsAvailable('test', true), true);
});

test('DevSmsTransport.latestFor returns null until something has been sent to that phone', () => {
  const transport = new DevSmsTransport();
  assert.equal(transport.latestFor('+989120000009'), null);
});

test('DevSmsTransport.sendCode records the code in the outbox and latestFor finds it', async () => {
  const transport = new DevSmsTransport();
  await transport.sendCode('+989120000009', '123456', 'fa');
  const entry = transport.latestFor('+989120000009');
  assert.ok(entry);
  assert.equal(entry?.code, '123456');
});

test('DevSmsTransport.latestFor returns the most recent entry for that phone, not the first', async () => {
  const transport = new DevSmsTransport();
  await transport.sendCode('+989120000009', '111111', 'fa');
  await transport.sendCode('+989120000009', '222222', 'fa');
  assert.equal(transport.latestFor('+989120000009')?.code, '222222');
});

test('DevSmsTransport.latestFor never mixes up two different phones', async () => {
  const transport = new DevSmsTransport();
  await transport.sendCode('+989120000009', '111111', 'fa');
  await transport.sendCode('+989120000010', '222222', 'fa');
  assert.equal(transport.latestFor('+989120000009')?.code, '111111');
  assert.equal(transport.latestFor('+989120000010')?.code, '222222');
});

test('DevSmsTransport.sendText records free text, not a code', async () => {
  const transport = new DevSmsTransport();
  await transport.sendText('+989120000009', 'hello');
  assert.equal(transport.latestFor('+989120000009')?.text, 'hello');
  assert.equal(transport.latestFor('+989120000009')?.code, undefined);
});

test('clear() empties the outbox', async () => {
  const transport = new DevSmsTransport();
  await transport.sendCode('+989120000009', '123456', 'fa');
  transport.clear();
  assert.equal(transport.latestFor('+989120000009'), null);
});
