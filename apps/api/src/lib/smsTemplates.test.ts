import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, loginCodeSms, signInFactorSms, inviteSms, type SmsContent } from './smsTemplates.js';

const CODE = '482913';
const INVITE_URL = 'https://example.com/fa/portal/invite/tok123';

/** Persian SMS is UCS-2 the moment it carries a Persian character — ~70
 *  characters is one segment, per this file's own header. */
const ONE_SEGMENT = 70;

const builders: Array<{ name: string; build: (locale: string) => SmsContent; mustInclude: string }> = [
  { name: 'login-code', build: (l) => loginCodeSms(l, { code: CODE }), mustInclude: CODE },
  { name: 'signin-factor', build: (l) => signInFactorSms(l, { code: CODE }), mustInclude: CODE },
  { name: 'invite', build: (l) => inviteSms(l, { inviteUrl: INVITE_URL }), mustInclude: INVITE_URL },
];

for (const { name, build, mustInclude } of builders) {
  for (const locale of LOCALES) {
    test(`${name} sms in ${locale} has a non-empty body`, () => {
      assert.ok(build(locale).text.length > 0);
    });

    test(`${name} sms in ${locale} carries its one placeholder verbatim`, () => {
      assert.ok(build(locale).text.includes(mustInclude));
    });
  }

  test(`${name} sms bodies differ between en and fa`, () => {
    assert.notEqual(build('en').text, build('fa').text);
  });
}

test('the code-bearing bodies (without the invite URL) fit in one SMS segment, in both languages', () => {
  for (const build of [loginCodeSms, signInFactorSms]) {
    for (const locale of LOCALES) {
      const { text } = build(locale, { code: CODE });
      assert.ok(text.length <= ONE_SEGMENT, `${locale}: "${text}" is ${text.length} chars`);
    }
  }
});

test('a code is printed in Latin digits, never folded to Persian — it must be typed back exactly', () => {
  // The Persian body legitimately carries other Persian digits ("۵ دقیقه"
  // — house rule 14, a count) — what must never happen is the *code itself*
  // being rendered in Persian digits, so this checks the code's own
  // substring survives verbatim rather than banning Persian digits outright.
  const { text } = loginCodeSms('fa', { code: CODE });
  assert.ok(text.includes(CODE), 'the six-digit code must appear in Latin digits, unchanged');
});

test('signInFactorSms is loginCodeSms — one template, one pattern to register', () => {
  assert.equal(signInFactorSms, loginCodeSms);
});
