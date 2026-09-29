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
