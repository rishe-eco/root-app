/**
 * The SMS provider adapter — deliberately left empty (P0-4, PD-18, founder
 * 2026-09-28). The founder has not chosen an SMS provider yet, and nothing
 * in this stage blocks on that choice: J1 is built and tested entirely
 * against `DevSmsTransport` (`lib/sms.ts`), and ships to production with
 * this slot empty and PD-18's degraded behaviour in force — invites still
 * show their link on the desk, phone recovery refuses `SMS_UNAVAILABLE`,
 * and the staff second factor goes unenforced (with a boot warning and a
 * desk banner) until a provider is wired.
 *
 * **What filling this in later takes — exactly this, and no more:**
 *
 *   1. Replace the body of `sendViaProvider` below with a real HTTP call
 *      to the chosen provider, in the same unauthenticated-`fetch` style
 *      `lib/mail.ts`'s `ResendTransport` already uses for outbound email —
 *      no SDK dependency for one HTTP call.
 *   2. The five environment variables already exist in `env.ts`, unused
 *      until this file reads them: `SMS_PROVIDER` (which branch of this
 *      file to run, if it ever needs more than one), `SMS_API_KEY`,
 *      `SMS_SENDER` (the sender id/line the provider requires on every
 *      send).
 *   3. `SMS_CODE_PATTERN` and `SMS_INVITE_PATTERN` — most Iranian SMS
 *      verification APIs require a message to match a **pre-approved
 *      template** registered with the regulator before it can be sent at
 *      all; free-text is rejected outright. These two variables carry
 *      that provider's pattern id/name for the two messages this product
 *      actually sends a code or a link in
 *      (`smsTemplates.ts`'s `loginCodeSms` and `inviteSms`) — that file's
 *      own header names exactly which placeholders each pattern must
 *      declare, so registering them with the provider and wiring the two
 *      variables here is the whole of this step.
 *   4. Never log a message body here, under any environment — that
 *      restriction is `DevSmsTransport`'s alone (see `lib/sms.ts`), and it
 *      stays that way once a real provider exists to log accidentally.
 *
 * Until then, both exported functions below throw `SMS_PROVIDER_NOT_CONFIGURED`
 * unconditionally — even if an operator sets the five variables without
 * doing the above, because setting them is not the same as this file having
 * anything to send with yet. `lib/sms.ts` only ever reaches this file when
 * `env.SMS_PROVIDER` (and its two required companions) are set, so in every
 * environment this stage ships to, this file is simply never called.
 */

export class SmsProviderNotConfiguredError extends Error {
  constructor() {
    super('SMS_PROVIDER_NOT_CONFIGURED');
    this.name = 'SmsProviderNotConfiguredError';
  }
}

export async function sendCodeViaProvider(_to: string, _code: string, _locale: string): Promise<void> {
  throw new SmsProviderNotConfiguredError();
}

export async function sendTextViaProvider(_to: string, _text: string): Promise<void> {
  throw new SmsProviderNotConfiguredError();
}
