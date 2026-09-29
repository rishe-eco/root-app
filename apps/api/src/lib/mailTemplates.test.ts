import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  resolveLocale,
  inviteEmail,
  resetEmail,
  reviewerInviteEmail,
  newCommentEmail,
  requestSubmittedEmail,
  requestMessageEmail,
  requestArchivedEmail,
  type MailContent,
} from './mailTemplates.js';

const INVITE_URL = 'https://example.com/fa/portal/invite/tok123';
const RESET_URL = 'https://example.com/en/portal/reset/tok456';
const REVIEWER_INVITE_URL = 'https://example.com/fa/portal/invite/tok789';
const THREAD_URL = 'https://example.com/en/desk/review/round1/doc1#thread-abc';
const DESK_REQUEST_URL = 'https://example.com/en/desk/requests/proj1';
const PORTAL_REQUEST_URL = 'https://example.com/fa/app/contracts?request=proj1';

const builders: Array<{ name: string; build: (locale: string) => MailContent; link: string }> = [
  { name: 'invite', build: (l) => inviteEmail(l, { name: 'کاربر', inviteUrl: INVITE_URL }), link: INVITE_URL },
  { name: 'reset', build: (l) => resetEmail(l, { resetUrl: RESET_URL }), link: RESET_URL },
  {
    name: 'reviewer-invite',
    build: (l) => reviewerInviteEmail(l, { name: 'کاربر', inviteUrl: REVIEWER_INVITE_URL }),
    link: REVIEWER_INVITE_URL,
  },
  {
    name: 'new-comment',
    build: (l) => newCommentEmail(l, { recipientName: 'کاربر', documentTitle: 'Learn', threadUrl: THREAD_URL }),
    link: THREAD_URL,
  },
  // Journeys build plan J2 — the three request notifications.
  {
    name: 'request-submitted',
    build: (l) =>
      requestSubmittedEmail(l, {
        recipientName: 'فروش',
        customerName: 'نهال',
        requestTitle: 'یک فروشگاه',
        deskUrl: DESK_REQUEST_URL,
      }),
    link: DESK_REQUEST_URL,
  },
  {
    name: 'request-message',
    build: (l) =>
      requestMessageEmail(l, { recipientName: 'نهال', requestTitle: 'یک فروشگاه', url: PORTAL_REQUEST_URL }),
    link: PORTAL_REQUEST_URL,
  },
  {
    name: 'request-archived',
    build: (l) =>
      requestArchivedEmail(l, {
        customerName: 'نهال',
        requestTitle: 'یک فروشگاه',
        reason: 'خارج از حوزهٔ کار ماست.',
        portalUrl: PORTAL_REQUEST_URL,
      }),
    link: PORTAL_REQUEST_URL,
  },
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

test('a request\'s title and an archive reason are escaped in html, verbatim in text; the reason keeps its line breaks', () => {
  const title = '<b>Shop</b> & "more"';
  const reason = 'Not a fit <yet>\nTry again in spring';
  const submitted = requestSubmittedEmail('en', {
    recipientName: 'Sales',
    customerName: '<i>Nahal</i>',
    requestTitle: title,
    deskUrl: DESK_REQUEST_URL,
  });
  assert.ok(!submitted.html.includes('<b>Shop</b>'));
  assert.ok(!submitted.html.includes('<i>Nahal</i>'));
  assert.ok(submitted.html.includes('&lt;b&gt;Shop&lt;/b&gt; &amp; &quot;more&quot;'));
  assert.ok(submitted.text.includes(title));

  const archived = requestArchivedEmail('en', {
    customerName: 'Nahal',
    requestTitle: title,
    reason,
    portalUrl: PORTAL_REQUEST_URL,
  });
  assert.ok(archived.html.includes('Not a fit &lt;yet&gt;<br>Try again in spring'));
  assert.ok(archived.text.includes(reason));
  assert.ok(archived.subject.includes(title), 'a subject is plain text, not html');
});
