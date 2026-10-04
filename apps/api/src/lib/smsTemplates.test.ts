import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCALES,
  loginCodeSms,
  signInFactorSms,
  inviteSms,
  requestSubmittedSms,
  requestMessageSms,
  requestArchivedSms,
  briefSharedSms,
  scopeProposedSms,
  scopeProposalDecidedSms,
  draftPublishedSms,
  invoiceIssuedSms,
  agreementApprovedSms,
  agreementSignedSms,
  designRoundPublishedSms,
  designConceptChosenSms,
  designOtherOptionsSms,
  designApprovedSms,
  allowanceExhaustedSms,
  contractClosedSms,
  mockupIterationPublishedSms,
  mockupApprovedSms,
  type SmsContent,
} from './smsTemplates.js';

const CODE = '482913';
const INVITE_URL = 'https://example.com/fa/portal/invite/tok123';
const REQUEST_URL = 'https://example.com/fa/app/contracts?request=proj1';

/** Persian SMS is UCS-2 the moment it carries a Persian character — ~70
 *  characters is one segment, per this file's own header. */
const ONE_SEGMENT = 70;

const builders: Array<{ name: string; build: (locale: string) => SmsContent; mustInclude: string }> = [
  { name: 'login-code', build: (l) => loginCodeSms(l, { code: CODE }), mustInclude: CODE },
  { name: 'signin-factor', build: (l) => signInFactorSms(l, { code: CODE }), mustInclude: CODE },
  { name: 'invite', build: (l) => inviteSms(l, { inviteUrl: INVITE_URL }), mustInclude: INVITE_URL },
  // Journeys build plan J2 — one placeholder each, the URL.
  { name: 'request-submitted', build: (l) => requestSubmittedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'request-message', build: (l) => requestMessageSms(l, { url: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'request-archived', build: (l) => requestArchivedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J4 — one placeholder, the URL; no title.
  { name: 'brief-shared', build: (l) => briefSharedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J5 and J6 — one placeholder each, the URL.
  { name: 'scope-proposed', build: (l) => scopeProposedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'scope-proposal-decided', build: (l) => scopeProposalDecidedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'draft-published', build: (l) => draftPublishedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J7 — to sales; one placeholder, the URL.
  { name: 'agreement-approved', build: (l) => agreementApprovedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'agreement-signed', build: (l) => agreementSignedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J13 — one placeholder, the URL; no number, no amount.
  { name: 'invoice-issued', build: (l) => invoiceIssuedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J8 — the design step; one placeholder each, the URL.
  { name: 'design-round-published', build: (l) => designRoundPublishedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'design-concept-chosen', build: (l) => designConceptChosenSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'design-other-options', build: (l) => designOtherOptionsSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'design-approved', build: (l) => designApprovedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'allowance-exhausted', build: (l) => allowanceExhaustedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J11 — a contract closed, to the customer; one placeholder, the URL.
  { name: 'contract-closed', build: (l) => contractClosedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  // Journeys build plan J9b — the mockup step; one placeholder each, the URL.
  { name: 'mockup-iteration-published', build: (l) => mockupIterationPublishedSms(l, { portalUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
  { name: 'mockup-approved', build: (l) => mockupApprovedSms(l, { deskUrl: REQUEST_URL }), mustInclude: REQUEST_URL },
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

test('the request SMS bodies carry no free text — only fixed words and the URL — so their length is ours to set', () => {
  for (const build of [
    (l: string) => requestSubmittedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => requestMessageSms(l, { url: REQUEST_URL }),
    (l: string) => requestArchivedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => briefSharedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => scopeProposedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => scopeProposalDecidedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => draftPublishedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => invoiceIssuedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => agreementApprovedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => agreementSignedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => designRoundPublishedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => designConceptChosenSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => designOtherOptionsSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => designApprovedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => allowanceExhaustedSms(l, { deskUrl: REQUEST_URL }),
    (l: string) => contractClosedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => mockupIterationPublishedSms(l, { portalUrl: REQUEST_URL }),
    (l: string) => mockupApprovedSms(l, { deskUrl: REQUEST_URL }),
  ]) {
    for (const locale of LOCALES) {
      const words = build(locale).text.replace(REQUEST_URL, '');
      assert.ok(words.length <= ONE_SEGMENT, `${locale}: the words around the URL fit one segment (${words.length})`);
    }
  }
});
