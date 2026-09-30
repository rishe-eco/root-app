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
  invoiceIssuedEmail,
  agreementApprovedEmail,
  agreementSignedEmail,
  designRoundPublishedEmail,
  designConceptChosenEmail,
  designOtherOptionsEmail,
  designApprovedEmail,
  allowanceExhaustedEmail,
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
const PORTAL_INVOICE_URL = 'https://example.com/fa/app/invoices/e1';
const DESK_STEPS_URL = 'https://example.com/en/desk/contracts/c1/steps';

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
  // Journeys build plan J13 — an invoice was issued.
  {
    name: 'invoice-issued',
    build: (l) =>
      invoiceIssuedEmail(l, {
        customerName: 'نهال',
        invoiceNumber: 'INV-000123',
        amount: '45000000',
        dueOn: '2026-10-17',
        portalUrl: PORTAL_INVOICE_URL,
      }),
    link: PORTAL_INVOICE_URL,
  },
  // Journeys build plan J7 — the agreement moved: to sales.
  {
    name: 'agreement-approved',
    build: (l) =>
      agreementApprovedEmail(l, {
        recipientName: 'فروش',
        customerName: 'نهال',
        projectTitleFa: 'فروشگاه نهال',
        projectTitleEn: 'Nahal shop',
        deskUrl: DESK_STEPS_URL,
      }),
    link: DESK_STEPS_URL,
  },
  {
    name: 'agreement-signed',
    build: (l) =>
      agreementSignedEmail(l, {
        recipientName: 'فروش',
        customerName: 'نهال',
        projectTitleFa: 'فروشگاه نهال',
        projectTitleEn: 'Nahal shop',
        deskUrl: DESK_STEPS_URL,
      }),
    link: DESK_STEPS_URL,
  },
  // Journeys build plan J8 — the design step.
  {
    name: 'design-round-published',
    build: (l) =>
      designRoundPublishedEmail(l, {
        customerName: 'نهال',
        projectTitleFa: 'فروشگاه نهال',
        projectTitleEn: 'Nahal shop',
        round: 2,
        allowance: 3,
        premade: true,
        portalUrl: PORTAL_CONTRACT_URL,
      }),
    link: PORTAL_CONTRACT_URL,
  },
  ...(['concept-chosen', 'other-options', 'approved'] as const).map((which) => ({
    name: `design-${which}`,
    build: (l: string) =>
      (which === 'concept-chosen' ? designConceptChosenEmail : which === 'other-options' ? designOtherOptionsEmail : designApprovedEmail)(l, {
        recipientName: 'طراح',
        customerName: 'نهال',
        projectTitleFa: 'فروشگاه نهال',
        projectTitleEn: 'Nahal shop',
        deskUrl: DESK_STEPS_URL,
      }),
    link: DESK_STEPS_URL,
  })),
  {
    name: 'allowance-exhausted',
    build: (l) =>
      allowanceExhaustedEmail(l, {
        recipientName: 'فروش',
        projectTitleFa: 'فروشگاه نهال',
        projectTitleEn: 'Nahal shop',
        step: 'DESIGN',
        used: 3,
        allowance: 3,
        deskUrl: DESK_STEPS_URL,
      }),
    link: DESK_STEPS_URL,
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

test('the invoice email: the number stays Latin in both languages; the amount and the due day take the locale’s digits (house rule 14, PD-19)', () => {
  const params = {
    customerName: 'Nahal',
    invoiceNumber: 'INV-000123',
    amount: '45000000',
    dueOn: '2026-10-17',
    portalUrl: PORTAL_INVOICE_URL,
  };
  const en = invoiceIssuedEmail('en', params);
  const fa = invoiceIssuedEmail('fa', params);
  for (const mail of [en, fa]) {
    assert.ok(mail.subject.includes('INV-000123'), 'the subject names the invoice');
    assert.ok(mail.text.includes('INV-000123') && mail.html.includes('INV-000123'));
  }
  // English: Latin digits, grouped, and the day as a day (not shifted by a
  // time zone — 17 October, whatever the machine's clock says).
  assert.ok(en.text.includes('45,000,000 Toman'), en.text);
  assert.ok(en.text.includes('October 17, 2026'), en.text);
  // Persian: Persian digits for the amount, the Jalali day (25 Mehr 1405), and
  // no Latin digits anywhere but the invoice number and the link.
  assert.ok(fa.text.includes('۴۵٬۰۰۰٬۰۰۰ تومان'), fa.text);
  assert.ok(fa.text.includes('۲۵ مهر ۱۴۰۵'), fa.text);
  const faDigits = fa.text.replace('INV-000123', '').replace(PORTAL_INVOICE_URL, '');
  assert.ok(!/[0-9]/.test(faDigits), `Latin digits leaked into the Persian body: ${faDigits}`);
  // It says how Root is paid — and that it is not here.
  assert.match(en.text, /does not take payment/);
  assert.match(fa.text, /پرداخت از راه پرتال انجام نمی‌شود/);
});

test('the invoice email escapes the customer’s name in html and leaves it verbatim in text', () => {
  const mail = invoiceIssuedEmail('en', {
    customerName: '<b>N</b>',
    invoiceNumber: 'INV-000001',
    amount: '1',
    dueOn: '2026-10-17',
    portalUrl: PORTAL_INVOICE_URL,
  });
  assert.ok(!mail.html.includes('<b>N</b>'));
  assert.ok(mail.text.includes('<b>N</b>'));
});

// ---- J7 — the agreement moves: to sales ------------------------------------------

const agreementParams = {
  recipientName: 'Sara <b>',
  customerName: 'Nahal & Co',
  projectTitleFa: 'فروشگاه نهال',
  projectTitleEn: 'Nahal <shop>',
  deskUrl: DESK_STEPS_URL,
};

test('J7: the approved and signed emails go to sales in each locale, name the customer and the project, link the desk, and escape what they were given', () => {
  for (const [name, build, en, fa] of [
    ['approved', agreementApprovedEmail, /Agreement approved/, /توافق‌نامه تأیید شد/],
    ['signed', agreementSignedEmail, /Agreement signed/, /توافق‌نامه امضا شد/],
  ] as const) {
    const english = build('en', agreementParams);
    assert.match(english.subject, en, name);
    assert.ok(english.subject.includes('Nahal <shop>'), 'the plain-text subject is not escaped');
    assert.ok(english.html.includes('Nahal &amp; Co'), name);
    assert.ok(english.html.includes('Nahal &lt;shop&gt;'), name);
    assert.ok(!english.html.includes('<b>'), name + ': a name is text, not markup');
    assert.ok(english.html.includes(DESK_STEPS_URL) && english.text.includes(DESK_STEPS_URL), name);
    const persian = build('fa', agreementParams);
    assert.match(persian.subject, fa, name);
    assert.ok(persian.text.includes('فروشگاه نهال') && persian.text.includes('Nahal & Co'), name);
    assert.ok(persian.html.includes('dir="rtl"') || persian.html.includes('rtl'), name + ': Persian is right-to-left');
    assert.ok(persian.text.includes(DESK_STEPS_URL), name);
  }
});

test('J7: an approved agreement says steps 1 to 3 are locked and that the signature comes next; a signed one says the plan can be issued', () => {
  assert.match(agreementApprovedEmail('en', agreementParams).text, /locked/);
  assert.match(agreementApprovedEmail('en', agreementParams).text, /sign next/);
  assert.match(agreementSignedEmail('en', agreementParams).text, /invoice by invoice/);
  assert.match(agreementApprovedEmail('fa', agreementParams).text, /قفل/);
  assert.match(agreementSignedEmail('fa', agreementParams).text, /یکی‌یکی/);
});

const roundParams = {
  customerName: 'Nahal & Co',
  projectTitleFa: 'فروشگاه نهال',
  projectTitleEn: 'Nahal <shop>',
  round: 2,
  allowance: 3 as number | null,
  premade: true,
  portalUrl: PORTAL_CONTRACT_URL,
};

test('J8: a published round says which round of how many, in the locale’s own digits, and what the customer has to look at', () => {
  const en = designRoundPublishedEmail('en', roundParams);
  assert.match(en.subject, /Round 2 of 3/);
  assert.match(en.text, /new set of themes/);
  assert.ok(en.html.includes('Nahal &amp; Co') && en.html.includes('Nahal &lt;shop&gt;'), 'a name is text, not markup');
  const fa = designRoundPublishedEmail('fa', roundParams);
  // House rule 14: a round is a count, so Persian digits — not the Latin ones an identifier would keep.
  assert.match(fa.subject, /دورِ ۲ از ۳/);
  assert.ok(!/[0-9]/.test(fa.subject.replace('Nahal', '')), 'no Latin digit in the Persian subject');
  assert.match(fa.text, /پوسته/);
  // A custom round talks about the wireframes and palette, not themes.
  assert.match(designRoundPublishedEmail('en', { ...roundParams, premade: false }).text, /wireframes and palette/);
  assert.match(designRoundPublishedEmail('fa', { ...roundParams, premade: false }).text, /وایرفریم/);
  // No allowance recorded: the sentence drops the "of".
  assert.match(designRoundPublishedEmail('en', { ...roundParams, allowance: null }).subject, /Round 2 of the design/);
});

test('J8: the customer’s Persian is «تو», the desk’s is formal', () => {
  // Customer: the imperative singular. Desk: the formal plural.
  assert.match(designRoundPublishedEmail('fa', roundParams).text, /نگاهی بینداز/);
  const desk = designOtherOptionsEmail('fa', { ...agreementParams, recipientName: 'طراح' });
  assert.match(desk.text, /پیشنهاد دهید/);
  assert.ok(!/بینداز|بگذار/.test(desk.text), 'the desk is not addressed as «تو»');
});

test('J8: the three designer emails say what the customer did, in each locale', () => {
  assert.match(designConceptChosenEmail('en', agreementParams).subject, /A design was chosen/);
  assert.match(designOtherOptionsEmail('en', agreementParams).text, /publish the next round/);
  assert.match(designApprovedEmail('en', agreementParams).text, /locked/);
  assert.match(designConceptChosenEmail('fa', agreementParams).subject, /انتخاب شد/);
  assert.match(designOtherOptionsEmail('fa', agreementParams).text, /دور بعد/);
  assert.match(designApprovedEmail('fa', agreementParams).text, /قفل/);
  for (const build of [designConceptChosenEmail, designOtherOptionsEmail, designApprovedEmail]) {
    const en = build('en', agreementParams);
    assert.ok(en.html.includes('Nahal &amp; Co') && !en.html.includes('<b>'), 'escaped');
  }
});

test('J8: the exhausted-allowance email names the step and how many rounds it had', () => {
  const params = { recipientName: 'Sara', projectTitleFa: 'فروشگاه نهال', projectTitleEn: 'Nahal shop', step: 'DESIGN', used: 3, allowance: 3, deskUrl: DESK_STEPS_URL };
  assert.match(allowanceExhaustedEmail('en', params).text, /"Design" step .*all 3 of its rounds/s);
  assert.match(allowanceExhaustedEmail('fa', params).text, /هر ۳ دورِ مجاز/);
});
