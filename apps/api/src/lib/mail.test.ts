import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DevTransport, ResendTransport, type MailMessage } from './mail.js';

const message: MailMessage = {
  to: 'customer@example.com',
  subject: 'Reset your Root password',
  html: '<p>link</p>',
  text: 'https://example.com/fa/portal/reset/tok123',
};

test('DevTransport logs the recipient and the link, never the provider', async (t) => {
  const info = t.mock.method(console, 'info', () => {});
  await new DevTransport().send(message);
  assert.equal(info.mock.callCount(), 1);
  const [line] = info.mock.calls[0].arguments;
  assert.ok(line.includes(message.to));
  assert.ok(line.includes(message.text));
});

test('ResendTransport posts to the Resend API with the right auth and body', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 200 }));
  const transport = new ResendTransport({ apiKey: 're_test_key', from: 'Root <hello@example.com>' });

  await transport.send(message);

  assert.equal(fetchMock.mock.callCount(), 1);
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit];
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.method, 'POST');
  assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer re_test_key');
  const body = JSON.parse(init.body as string);
  assert.deepEqual(body, {
    from: 'Root <hello@example.com>',
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
});

test('ResendTransport rejects when Resend responds with a non-ok status', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('bad request', { status: 422 }),
  );
  const transport = new ResendTransport({ apiKey: 're_test_key', from: 'Root <hello@example.com>' });

  await assert.rejects(() => transport.send(message), /422/);
});
