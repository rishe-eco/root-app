import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  resolveLocale,
  inviteEmail,
  resetEmail,
  reviewerInviteEmail,
  staffInviteEmail,
  newCommentEmail,
  requestSubmittedEmail,
  requestMessageEmail,
  requestArchivedEmail,
  briefSharedEmail,
  scopeProposedEmail,
  scopeProposalDecidedEmail,
  draftPublishedEmail,
  feedbackSubmittedEmail,
  answerPendingEmail,
  answerPublishedEmail,
  answerDeclinedEmail,
  type MailContent,
} from './mailTemplates.js';

const INVITE_URL = 'https://example.com/fa/portal/invite/tok123';
const RESET_URL = 'https://example.com/en/portal/reset/tok456';
const REVIEWER_INVITE_URL = 'https://example.com/fa/portal/invite/tok789';
const STAFF_INVITE_URL = 'https://example.com/fa/portal/invite/tokstaff';
const THREAD_URL = 'https://example.com/en/desk/review/round1/doc1#thread-abc';
const DESK_REQUEST_URL = 'https://example.com/en/desk/requests/proj1';
const PORTAL_REQUEST_URL = 'https://example.com/fa/app/contracts?request=proj1';
const PORTAL_CONTRACT_URL = 'https://example.com/fa/app/contracts/c1';

const builders: Array<{ name: string; build: (locale: string) => MailContent; link: string }> = [
  { name: 'invite', build: (l) => inviteEmail(l, { name: 'کاربر', inviteUrl: INVITE_URL }), link: INVITE_URL },
  { name: 'reset', build: (l) => resetEmail(l, { resetUrl: RESET_URL }), link: RESET_URL },
  {
    name: 'reviewer-invite',
    build: (l) => reviewerInviteEmail(l, { name: 'کاربر', inviteUrl: REVIEWER_INVITE_URL }),
    link: REVIEWER_INVITE_URL,
  },
  {
    name: 'staff-invite',
    build: (l) => staffInviteEmail(l, { name: 'کاربر', inviteUrl: STAFF_INVITE_URL }),
    link: STAFF_INVITE_URL,
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
  // Journeys build plan J4 — step 1 handed to the customer.
  {
    name: 'brief-shared',
    build: (l) =>
      briefSharedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
  },
  // Journeys build plan J5 — a proposal made (to sales), decided (to the customer).
  {
    name: 'scope-proposed',
    build: (l) =>
      scopeProposedEmail(l, {
        recipientName: 'فروش',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        proposalKind: 'ADD',
        text: 'یک صفحه‌ی وبلاگ',
        deskUrl: DESK_REQUEST_URL,
      }),
    link: DESK_REQUEST_URL,
  },
  {
    name: 'scope-proposal-accepted',
    build: (l) =>
      scopeProposalDecidedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        decision: 'ACCEPTED',
        reason: null,
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
  },
  {
    name: 'scope-proposal-declined',
    build: (l) =>
      scopeProposalDecidedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        decision: 'DECLINED',
        reason: 'خارج از حوزه‌ی کار است.',
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
  },
  // Journeys build plan J6 — the draft contract published (C0's promised contract-revised).
  {
    name: 'draft-published',
    build: (l) =>
      draftPublishedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        version: 1,
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
  },
  {
    name: 'draft-revised',
    build: (l) =>
      draftPublishedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'یک فروشگاه',
        projectTitleEn: 'A shop',
        version: 3,
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
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

test('the S2 feedback emails name the step in the reader’s language, carry the link, and escape what a person typed', () => {
  const base = { projectTitleFa: 'فروشگاه', projectTitleEn: 'A <shop>', step: 'DESIGN' };
  const cases: Array<[string, (l: string) => MailContent, string, string]> = [
    ['submitted', (l) => feedbackSubmittedEmail(l, { ...base, recipientName: 'Sales', deskUrl: 'https://x.test/d' }), 'https://x.test/d', 'Design'],
    ['pending', (l) => answerPendingEmail(l, { ...base, recipientName: 'Sales', deskUrl: 'https://x.test/a' }), 'https://x.test/a', 'Design'],
    ['published', (l) => answerPublishedEmail(l, { ...base, customerName: 'Nahal', portalUrl: 'https://x.test/p' }), 'https://x.test/p', 'Design'],
    ['declined', (l) => answerDeclinedEmail(l, { ...base, recipientName: 'Designer', reason: 'Not <ours>\nsay so', deskUrl: 'https://x.test/d2' }), 'https://x.test/d2', 'Design'],
  ];
  for (const [name, make, url, stepEn] of cases) {
    const en = make('en');
    const fa = make('fa');
    assert.ok(en.text.includes(url) && fa.text.includes(url), `${name}: the link`);
    assert.ok(en.text.includes(stepEn), `${name}: the English step name`);
    assert.ok(fa.text.includes('طرح'), `${name}: the Persian step name`);
    assert.ok(!en.html.includes('<shop>'), `${name}: a title is escaped in html`);
    assert.ok(fa.html.includes('dir="rtl"'));
  }
  const declined = answerDeclinedEmail('en', { ...base, recipientName: 'D', reason: 'Not <ours>\nsay so', deskUrl: 'https://x.test/d2' });
  assert.ok(declined.html.includes('Not &lt;ours&gt;<br>say so'));
  assert.ok(declined.text.includes('Not <ours>\nsay so'));
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

test('J5: a proposal’s words are escaped in html and verbatim in text, and a decline carries its reason — an acceptance has none', () => {
  const text = 'Add a <blog>\nand a "news" page';
  for (const locale of LOCALES) {
    const proposed = scopeProposedEmail(locale, {
      recipientName: 'Sales',
      projectTitleFa: 'فروشگاه',
      projectTitleEn: 'A <shop>',
      proposalKind: 'ADD',
      text,
      deskUrl: DESK_REQUEST_URL,
    });
    assert.ok(proposed.html.includes('Add a &lt;blog&gt;<br>and a &quot;news&quot; page'), `${locale}: escaped, line breaks kept`);
    assert.ok(!proposed.html.includes('<blog>'));
    assert.ok(proposed.text.includes(text), `${locale}: verbatim in text`);
  }
  // Each kind reads differently, in both languages.
  for (const locale of LOCALES) {
    const bodies = (['ADD', 'REMOVE', 'RESTORE'] as const).map(
      (proposalKind) =>
        scopeProposedEmail(locale, { recipientName: 'S', projectTitleFa: 'ا', projectTitleEn: 'a', proposalKind, text: 'x', deskUrl: DESK_REQUEST_URL }).text,
    );
    assert.equal(new Set(bodies).size, 3, `${locale}: three kinds, three sentences`);
  }

  const reason = 'Out of <scope>\nsorry';
  const declined = scopeProposalDecidedEmail('en', {
    customerName: 'N',
    projectTitleFa: 'ا',
    projectTitleEn: 'A shop',
    decision: 'DECLINED',
    reason,
    portalUrl: PORTAL_CONTRACT_URL,
  });
  assert.ok(declined.html.includes('Out of &lt;scope&gt;<br>sorry'));
  assert.ok(declined.text.includes(reason));
  assert.match(declined.subject, /declined/);
  const declinedFa = scopeProposalDecidedEmail('fa', {
    customerName: 'N',
    projectTitleFa: 'فروشگاه',
    projectTitleEn: 'a',
    decision: 'DECLINED',
    reason,
    portalUrl: PORTAL_CONTRACT_URL,
  });
  assert.ok(declinedFa.text.includes(reason));
  assert.match(declinedFa.text, /نپذیرفت/);
  const accepted = scopeProposalDecidedEmail('en', {
    customerName: 'N',
    projectTitleFa: 'ا',
    projectTitleEn: 'A shop',
    decision: 'ACCEPTED',
    reason: 'ignored on an acceptance',
    portalUrl: PORTAL_CONTRACT_URL,
  });
  assert.match(accepted.subject, /accepted/);
  assert.ok(!accepted.text.includes('ignored on an acceptance'));
});

test('J6: the draft email says whether it is the first look or a revision, the version in Latin digits', () => {
  const first = draftPublishedEmail('en', { customerName: 'N', projectTitleFa: 'ا', projectTitleEn: 'A shop', version: 1, portalUrl: PORTAL_CONTRACT_URL });
  const later = draftPublishedEmail('en', { customerName: 'N', projectTitleFa: 'ا', projectTitleEn: 'A shop', version: 3, portalUrl: PORTAL_CONTRACT_URL });
  assert.match(first.subject, /ready to read/);
  assert.ok(!/v1|version 1/.test(first.text), 'a first draft has no version to announce');
  assert.match(later.subject, /revised \(v3\)/);
  assert.ok(later.text.includes('version 3'));
  assert.ok(later.text.includes('earlier notes'), 'a revision says the notes show what changed');
  const laterFa = draftPublishedEmail('fa', { customerName: 'N', projectTitleFa: 'فروشگاه', projectTitleEn: 'a', version: 3, portalUrl: PORTAL_CONTRACT_URL });
  assert.ok(laterFa.subject.includes('v3'), 'never «v۳» — a version is an identifier (house rule 14)');
  assert.ok(laterFa.text.includes('3'));
  assert.ok(!/[۰-۹]/.test(laterFa.text));
});
