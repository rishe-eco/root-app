import { env } from './env.js';

export type MailMessage = { to: string; subject: string; html: string; text: string };

export interface MailTransport {
  send(message: MailMessage): Promise<void>;
}

/**
 * The fallback whenever no provider is configured — in development, and in
 * production too if the founder hasn't wired one yet (see `env.ts`). This is
 * the only place a raw invite/reset link is ever logged; once a provider is
 * configured, `ResendTransport` is what runs instead, so that never happens
 * by construction rather than by an environment check that could be gotten
 * wrong.
 */
export class DevTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    console.info(`[mail:dev] to=${message.to} subject="${message.subject}"\n${message.text}`);
  }
}

/** Plain `fetch` against Resend's HTTP API — no SDK, matching this codebase's other outbound calls. */
export class ResendTransport implements MailTransport {
  constructor(private readonly opts: { apiKey: string; from: string }) {}

  async send(message: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.opts.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend send failed (${res.status}): ${body}`);
    }
  }
}

const defaultTransport = (): MailTransport =>
  env.RESEND_API_KEY && env.MAIL_FROM
    ? new ResendTransport({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM })
    : new DevTransport();

let transport: MailTransport = defaultTransport();

export const sendMail = (message: MailMessage): Promise<void> => transport.send(message);

/** Test-only seam, the same shape as `sms.ts`'s: the dev transport only logs,
 *  so a suite that has to assert what was sent (J2's notifications) swaps in
 *  one that records it. */
export function __setMailTransportForTests(fake: MailTransport): void {
  transport = fake;
}

export function __resetMailTransportForTests(): void {
  transport = defaultTransport();
}
