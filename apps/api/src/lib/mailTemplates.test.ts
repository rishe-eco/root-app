import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCALES, resolveLocale, inviteEmail, resetEmail, type MailContent } from './mailTemplates.js';

const INVITE_URL = 'https://example.com/fa/portal/invite/tok123';
const RESET_URL = 'https://example.com/en/portal/reset/tok456';

const builders: Array<{ name: string; build: (locale: string) => MailContent; link: string }> = [
  { name: 'invite', build: (l) => inviteEmail(l, { name: 'کاربر', inviteUrl: INVITE_URL }), link: INVITE_URL },
  { name: 'reset', build: (l) => resetEmail(l, { resetUrl: RESET_URL }), link: RESET_URL },
];

for (const { name, build, link } of builders) {
  for (const locale of LOCALES) {
    test(`${name} email in ${locale} has non-empty subject/html/text`, () => {
      const content = build(locale);
      assert.ok(content.subject.length > 0);
      assert.ok(content.html.length > 0);
      assert.ok(content.text.length > 0);
    });

    test(`${name} email in ${locale} carries the link in both html and text`, () => {
      const content = build(locale);
      assert.ok(content.html.includes(link), 'link missing from html body');
      assert.ok(content.text.includes(link), 'link missing from text body');
    });
  }

  test(`${name} email subjects differ between en and fa`, () => {
    assert.notEqual(build('en').subject, build('fa').subject);
  });
}

test('resolveLocale accepts en and fa, defaults everything else to fa', () => {
  assert.equal(resolveLocale('en'), 'en');
  assert.equal(resolveLocale('fa'), 'fa');
  assert.equal(resolveLocale('xx'), 'fa');
  assert.equal(resolveLocale(undefined), 'fa');
  assert.equal(resolveLocale(null), 'fa');
});

test('a name containing HTML-sensitive characters is escaped in html but left verbatim in text', () => {
  const raw = `<b>&"'`;
  const content = inviteEmail('en', { name: raw, inviteUrl: INVITE_URL });
  assert.ok(!content.html.includes('<b>&"\'>'));
  assert.ok(content.html.includes('&lt;b&gt;&amp;&quot;&#39;'));
  assert.ok(content.text.includes(raw));
});
