import { env } from './env.js';
import { sendCodeViaProvider, sendTextViaProvider } from './smsProvider.js';

/**
 * The SMS transport seam (journeys build plan J1, PD-18) — mirrors
 * `lib/mail.ts`'s shape on purpose: an interface, a development fallback
 * that logs instead of sending, and a real-provider branch chosen once at
 * module load from `env.ts`. Where it differs from mail is `DevSmsTransport`
 * also being the transport in *every* non-production environment (dev,
 * test, e2e) regardless of whether the five `SMS_*` variables happen to be
 * set — nobody tests a real vendor integration from this codebase, so there
 * is no "real" branch to fall into outside production. See `smsProvider.ts`
 * for the empty adapter slot itself.
 */

export interface SmsTransport {
  sendCode(to: string, code: string, locale: string): Promise<void>;
  sendText(to: string, text: string): Promise<void>;
}

type OutboxEntry = { to: string; code?: string; text?: string; at: number };

/**
 * The fallback in development and test, and the *only* transport this
 * stage's suites ever exercise a real send through. Logs to the console —
 * the one place a code is ever allowed to appear in a log (trap: "do not
 * log codes" applies to every other path) — and, only when
 * Always keeps an in-memory outbox — cheap, and this transport only ever
 * runs outside production, so there is nothing to guard by keeping the
 * bookkeeping conditional. What *is* gated on `SMS_E2E_OUTBOX` is whether
 * anything can read the outbox back: the test-only route
 * (`routes/smsOutbox.ts`) is mounted only when that variable is set, and
 * `env.ts` refuses it outright in production — the same guard already
 * applied to `ANTHROPIC_E2E_STUB` — so this bookkeeping is unreachable from
 * outside the process there regardless.
 */
export class DevSmsTransport implements SmsTransport {
  private outbox: OutboxEntry[] = [];

  async sendCode(to: string, code: string, locale: string): Promise<void> {
    console.info(`[sms:dev] to=${to} locale=${locale} code=${code}`);
    this.outbox.push({ to, code, at: Date.now() });
  }

  async sendText(to: string, text: string): Promise<void> {
    console.info(`[sms:dev] to=${to}\n${text}`);
    this.outbox.push({ to, text, at: Date.now() });
  }

  /** The most recent entry sent to this phone, or `null` — what the e2e
   *  outbox route answers with, and what proves `requestLoginCode`'s outbox
   *  stayed empty for an unknown phone in the integration suite. */
  latestFor(to: string): OutboxEntry | null {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      if (this.outbox[i].to === to) return this.outbox[i];
    }
    return null;
  }

  /** Test-only seam, the same shape as `askRateLimit.ts`'s own reset. */
  clear(): void {
    this.outbox = [];
  }
}

/** The real adapter, unconditionally throwing until P0-4 is done — see
 *  `smsProvider.ts`'s header for exactly what "done" takes. */
class ProviderSmsTransport implements SmsTransport {
  async sendCode(to: string, code: string, locale: string): Promise<void> {
    await sendCodeViaProvider(to, code, locale);
  }
  async sendText(to: string, text: string): Promise<void> {
    await sendTextViaProvider(to, text);
  }
}

/**
 * Whether the founder has wired a real provider at all — the same pairing
 * discipline `env.ts` already applies to `RESEND_API_KEY`/`MAIL_FROM`
 * (a half-set pair is a mistake, not a partial config), extended to three
 * required fields here because a provider without a sender line cannot
 * send regardless of having a key.
 */
export const smsProviderConfigured = Boolean(env.SMS_PROVIDER && env.SMS_API_KEY && env.SMS_SENDER);

/**
 * PD-18's own decision, factored out as a pure function of the two things it
 * actually depends on — so the "factor enforced / SMS available" question is
 * testable without booting a second process under `NODE_ENV=production`
 * (`env.test.ts`'s own reasoning, applied here).
 *
 * Unenforced/unavailable **only** when both hold: this is production, and no
 * provider is configured. Everywhere else — development, test, e2e, or a
 * production with a provider wired — SMS is available, because
 * `DevSmsTransport` is a live transport in every one of the first three.
 */
export function smsAvailable(nodeEnv: string, providerConfigured: boolean): boolean {
  return nodeEnv !== 'production' || providerConfigured;
}

const devTransport = new DevSmsTransport();

/** The transport every caller in this codebase sends through. Chosen once,
 *  not per call — the same reasoning `lib/mail.ts`'s module-level `transport`
 *  const gives, and for the same testability: `__setSmsTransportForTests`
 *  below is the seam, not a second code path. */
let transport: SmsTransport =
  env.NODE_ENV === 'production' && smsProviderConfigured ? new ProviderSmsTransport() : devTransport;

export const sendSmsCode = (to: string, code: string, locale: string): Promise<void> =>
  transport.sendCode(to, code, locale);

export const sendSmsText = (to: string, text: string): Promise<void> => transport.sendText(to, text);

/** The dev transport specifically — for the e2e outbox route, which must
 *  read the real singleton `sendSmsCode`/`sendSmsText` write into, and for
 *  the integration suite, which asserts against it directly rather than by
 *  re-parsing console output. Returns `null` once a real provider is in use,
 *  so a caller can never mistake a production transport for this one. */
export function devSmsTransport(): DevSmsTransport | null {
  return transport === devTransport ? devTransport : null;
}

/** Test-only seam — the same shape as `anthropicClient.ts`'s
 *  `__setAnthropicClientForTests`. */
export function __setSmsTransportForTests(fake: SmsTransport): void {
  transport = fake;
}

export function __resetSmsTransportForTests(): void {
  transport = env.NODE_ENV === 'production' && smsProviderConfigured ? new ProviderSmsTransport() : devTransport;
  devTransport.clear();
}
