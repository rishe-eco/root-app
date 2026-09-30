import { LOCALES, resolveLocale } from './mailTemplates.js';

export { LOCALES, resolveLocale };

/**
 * SMS bodies (journeys build plan J1) — one line each, no HTML, no subject,
 * unlike `mailTemplates.ts`. Unlike email, a segment of Persian SMS is
 * *cost*, not merely bytes: Persian text forces UCS-2 encoding (~70
 * characters a segment) rather than GSM-7's 160, so every body below is
 * written to fit in one segment in both languages — a habit worth keeping
 * even where the exact count is not asserted, because the failure mode of
 * forgetting it is an invite that silently costs the founder 3x per send.
 *
 * The two message kinds this product ever sends a **code** or a **link**
 * in — `loginCodeSms` and `inviteSms` — are also the two a real provider
 * will usually require a **pre-approved template** for before it can be
 * sent at all (`smsProvider.ts`'s own header). Each one's placeholders, in
 * the order a registered pattern must declare them, so registering these
 * with whatever provider is eventually chosen is a matter of copying this
 * list rather than re-deriving it from the code:
 *
 *   - `loginCodeSms` (and `signInFactorSms`, which reuses it verbatim — a
 *     staff reader has no reason to be told "sign-in code" instead of
 *     "verification code," and one fewer template is one fewer pattern to
 *     register): **one placeholder**, the six-digit code.
 *   - `inviteSms`: **one placeholder**, the invite URL.
 *   - `requestSubmittedSms`, `requestMessageSms`, `requestArchivedSms`
 *     (journeys build plan J2): **one placeholder** each, the URL. None of them
 *     carries the request's title or the archive reason — both are free text
 *     of unbounded length, which would make the segment count (and the price)
 *     the customer's to set; the email carries them and the SMS points at the
 *     page.
 *   - `briefSharedSms` (journeys build plan J4): **one placeholder**, the URL —
 *     no title, for the same reason.
 *   - `scopeProposedSms`, `scopeProposalDecidedSms` (J5) and `draftPublishedSms`
 *     (J6): **one placeholder** each, the URL — a proposal's text and a
 *     decline's reason are free text and stay in the email.
 *   - `agreementApprovedSms`, `agreementSignedSms` (journeys build plan J7): **one
 *     placeholder** each, the URL — the customer's name and the project's title are
 *     the email's.
 *   - `invoiceIssuedSms` (journeys build plan J13): **one placeholder**, the URL —
 *     no number, no amount.
 *   - `designRoundPublishedSms`, `designConceptChosenSms`, `designOtherOptionsSms`,
 *     `designApprovedSms`, `allowanceExhaustedSms` (journeys build plan J8): **one
 *     placeholder** each, the URL — the round count and the names are the email's.
 *   - `mockupIterationPublishedSms`, `mockupApprovedSms` (journeys build plan J9b):
 *     **one placeholder** each, the URL.
 *
 * Codes are printed in Latin digits in both languages, never through
 * `toPersianDigits` — house rule 14's own exception for an identifier
 * that has to be typed back exactly, the same reasoning `mailTemplates.ts`'s
 * `buildNumber` already applies.
 */

export type SmsContent = { text: string };

export function loginCodeSms(locale: string | null | undefined, params: { code: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `Root verification code: ${params.code}. Expires in 5 minutes.` };
  }
  return { text: `کد تأیید ریشه: ${params.code}. تا ۵ دقیقه دیگر معتبر است.` };
}

/** The staff second factor (PD-20) — same wording, same one placeholder. */
export const signInFactorSms = loginCodeSms;

export function inviteSms(locale: string | null | undefined, params: { inviteUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `You're invited to Root. Set your password: ${params.inviteUrl}` };
  }
  return { text: `به ریشه دعوت شدید. برای تعیین رمز عبور: ${params.inviteUrl}` };
}

/** J2 — to every account that can answer a request. */
export function requestSubmittedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `New request on Root: ${params.deskUrl}` };
  }
  return { text: `درخواست تازه‌ای در ریشه ثبت شد: ${params.deskUrl}` };
}

/** J2 — to whichever side did not write the message. */
export function requestMessageSms(locale: string | null | undefined, params: { url: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `New message on a Root request: ${params.url}` };
  }
  return { text: `پیام تازه‌ای روی یک درخواست در ریشه ثبت شد: ${params.url}` };
}

/** J2 — to the customer; the reason is one tap away, not in the SMS. */
export function requestArchivedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `Your Root request was archived. See why: ${params.portalUrl}` };
  }
  return { text: `درخواست شما در ریشه بایگانی شد. دلیل را ببینید: ${params.portalUrl}` };
}

/**
 * J13 — to the customer, when an invoice is issued. One placeholder, the URL: no
 * number and no amount, for the reason the request bodies carry no title (a
 * registered pattern's placeholder count is part of what is registered) — the
 * email has the facts, and the page is one tap away.
 */
export function invoiceIssuedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A new invoice was issued on Root: ${params.portalUrl}` };
  }
  return { text: `صورت‌حساب تازه‌ای در ریشه صادر شد: ${params.portalUrl}` };
}

/** J4 — to the customer, when sales hands step 1 over. */
export function briefSharedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `Your project requirements are ready on Root: ${params.portalUrl}` };
  }
  return { text: `نیازمندی‌های پروژه‌ی شما در ریشه آماده است: ${params.portalUrl}` };
}

/** J5 — to whoever can decide a scope proposal; the customer's words are one tap away, not in the SMS. */
export function scopeProposedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `New scope proposal on Root: ${params.deskUrl}` };
  }
  return { text: `پیشنهادِ تازه‌ای برای دامنه در ریشه ثبت شد: ${params.deskUrl}` };
}

/** J5 — to the customer; accepted or declined, the details (and a decline's reason) are in the portal. */
export function scopeProposalDecidedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `Root answered your scope proposal: ${params.portalUrl}` };
  }
  return { text: `ریشه به پیشنهادِ تو برای دامنه پاسخ داد: ${params.portalUrl}` };
}

/** J6 — to the customer, when the contract draft (or a new version of it) is published. */
export function draftPublishedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `Your contract draft is ready on Root: ${params.portalUrl}` };
  }
  return { text: `پیش‌نویسِ قرارداد تو در ریشه آماده است: ${params.portalUrl}` };
}

/** J7 — to sales, when the customer approves the agreement (they sign next, on the same screen). */
export function agreementApprovedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer approved their agreement on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری توافق‌نامه‌اش را در ریشه تأیید کرد: ${params.deskUrl}` };
}

/** J7 — to sales, when the customer signs. */
export function agreementSignedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer signed their agreement on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری توافق‌نامه‌اش را در ریشه امضا کرد: ${params.deskUrl}` };
}

/** J8 — to the customer, when a design round is published. No count, no
 *  title: the email carries "round 2 of 3", the SMS points at the page. */
export function designRoundPublishedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A new design round is ready on Root: ${params.portalUrl}` };
  }
  return { text: `دورِ تازه‌ی طراحی در ریشه آماده است: ${params.portalUrl}` };
}

/** J8 — to the designer, when the customer chooses a design. */
export function designConceptChosenSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer chose a design on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری در ریشه یک طرح را انتخاب کرد: ${params.deskUrl}` };
}

/** J8 — to the designer, when the customer asks for other options. */
export function designOtherOptionsSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer asked for other design options on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری در ریشه گزینه‌های دیگری برای طراحی خواست: ${params.deskUrl}` };
}

/** J8 — to the designer, when the customer approves the design. */
export function designApprovedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer approved their design on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری طراحی‌اش را در ریشه تأیید کرد: ${params.deskUrl}` };
}

/** J9b — to the customer, when a mockup iteration is published. No count, no
 *  title, like the design round's: the email carries "mockup 2 of 3". */
export function mockupIterationPublishedSms(locale: string | null | undefined, params: { portalUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A new mockup is ready on Root: ${params.portalUrl}` };
  }
  return { text: `ماکتِ تازه در ریشه آماده است: ${params.portalUrl}` };
}

/** J9b — to the designer, when the customer approves the mockup. */
export function mockupApprovedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A customer approved their mockup on Root: ${params.deskUrl}` };
  }
  return { text: `مشتری ماکتش را در ریشه تأیید کرد: ${params.deskUrl}` };
}

/** J8 — to sales, when a step's rounds are used up and another is wanted. */
export function allowanceExhaustedSms(locale: string | null | undefined, params: { deskUrl: string }): SmsContent {
  if (resolveLocale(locale) === 'en') {
    return { text: `A step has used up its rounds on Root — extend it? ${params.deskUrl}` };
  }
  return { text: `یک مرحله در ریشه دورهای مجازش را مصرف کرد؛ افزایش می‌دهید؟ ${params.deskUrl}` };
}
