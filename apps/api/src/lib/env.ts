import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// Load apps/api/.env into process.env before we validate it. The Prisma CLI
// loads .env on its own, which is why migrate and seed work without this — but
// the server process does not, so it must ask. Native (Node >=20.12); no
// dotenv dependency. Missing file is fine: in production the vars are injected
// by the environment and there is no file to read.
try {
  loadEnvFile();
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

/** docker-compose.prod.yml's `${VAR}` interpolation defines a var as "" rather than omitting it when the operator leaves it blank; treat that the same as unset. */
const emptyToUndefined = (v: unknown) => (v === '' ? undefined : v);

/**
 * P0-7 (defect D-8): the session cookie carries no `__Host-` prefix today, so
 * nothing stops a same-site subdomain — a staging site or an uploaded mockup,
 * both living under `m-root.com` per the journeys build plan's PD-8 — from
 * planting or overwriting it for the parent domain (cookie tossing). The
 * prefix is what closes that: a browser refuses any `Set-Cookie` by a
 * `__Host-` name that carries a `Domain` attribute, lacks `Secure`, or names a
 * path other than `/`. `Secure` is what the prefix costs — plain-HTTP
 * development cannot give it — so development keeps the unprefixed name
 * rather than silently never seeing its own cookie.
 *
 * A pure function, not a schema default, because the right value depends on
 * `NODE_ENV` and `z.object`'s per-field defaults cannot see a sibling field.
 */
export function defaultCookieName(nodeEnv: string): string {
  return nodeEnv === 'production' ? '__Host-root_session' : 'root_session';
}

/**
 * The trap changing the default alone would leave open: an operator's
 * existing `.env` (or `docker-compose.prod.yml`'s own `${COOKIE_NAME:-…}`
 * fallback, before this change) sets `COOKIE_NAME=root_session` explicitly,
 * which would keep booting, keep working, and keep the weak cookie forever —
 * same-site hardening only on paper. Refuse instead of defaulting around it.
 *
 * A plain function, exported and tested on its own (`env.test.ts`), so the
 * refusal is checked without booting a second process with `NODE_ENV=production`.
 */
export function assertCookieNameIsHardened(nodeEnv: string, cookieName: string): void {
  if (nodeEnv === 'production' && !cookieName.startsWith('__Host-')) {
    throw new Error(
      'Invalid environment:\n  - COOKIE_NAME must start with "__Host-" in production ' +
        '(see .env.production.example) — the prefix is what stops a sibling ' +
        'subdomain from planting or overwriting this cookie',
    );
  }
}

/**
 * Fail loudly at boot rather than mysteriously at the first request. In
 * particular JWT_SECRET has no default — an unset signing key is a silent
 * security hole, not a convenience.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (see .env.example)'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Where the customer-facing app lives; invite and reset links point here. */
  APP_ORIGIN: z.string().url().default('http://localhost:5173'),
  /**
   * How many reverse proxies sit in front of this process. Express counts hops
   * back from the socket, so a wrong number means `req.ip` is a proxy's
   * address rather than the visitor's — and `req.ip` is what gets written to
   * `Signature.ip` on a legal signing record. Guessing it is not acceptable,
   * hence an explicit setting: 1 for host Nginx alone, 2 if a container Nginx
   * also sits in the chain, 0 when nothing is in front.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /**
   * No default in the schema itself — the right default depends on
   * `NODE_ENV`, which this object cannot see while it is still being parsed —
   * see `defaultCookieName` and the production check below, both applied
   * after `safeParse` returns.
   */
  COOKIE_NAME: z.string().optional(),
  SESSION_DAYS: z.coerce.number().default(14),
  INVITE_DAYS: z.coerce.number().default(14),
  RESET_HOURS: z.coerce.number().default(2),
  /**
   * Where uploaded files are written. Deliberately **has no default in
   * production**: the release script swaps the whole app directory on every
   * deploy, so a relative default would put customers' design files inside a
   * directory the next release deletes. A path that survives redeploy is a
   * decision the operator has to make, not one this file can guess.
   */
  STORAGE_DIR: z.string().min(1).optional(),
  /**
   * Public origin for the `public/` class, which Nginx serves straight off
   * disk without touching Node. Private files are never addressable this way.
   */
  PUBLIC_FILES_BASE: z.string().url().optional(),
  /**
   * Resend's key and the address to send from. Both optional — and, unlike
   * STORAGE_DIR, optional even in production: the founder may legitimately
   * not have wired a provider yet, and a missing one degrades invite/reset
   * links to a console log rather than refusing to boot (see `lib/mail.ts`).
   * What *is* rejected below is a half-set pair, since one without the other
   * cannot send anything and so is a mistake, not a partial config.
   *
   * `emptyToUndefined` matters here specifically because of
   * docker-compose.prod.yml: its `${RESEND_API_KEY}` interpolation always
   * defines the variable inside the container — as an empty string when the
   * operator hasn't set it, never as truly absent — so without this an
   * unconfigured provider would fail boot instead of degrading to logging.
   */
  RESEND_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /** e.g. "Root <hello@yourdomain.com>" — must be on a domain verified in Resend. */
  MAIL_FROM: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * The Research Lab's agent (R4). Optional everywhere, exactly like
   * RESEND_API_KEY: no key means the Ask surface is not offered at all —
   * `askAvailable` is false, the client renders no Ask panel, and the route
   * refuses with UNAVAILABLE for anyone who reaches it anyway.
   *
   * This reverses R4.md §6, which required the key in production so that the
   * first per-request money this product spends could not be discovered at the
   * first question. That reasoning was sound about *cost* and wrong about
   * *mechanism*: refusing to boot doesn't reveal the spend, it takes down the
   * portal, the desk and the contracts along with the Ask box — a whole
   * product held hostage by one optional feature. Not rendering the surface
   * makes the same fact visible without the outage, and does it on every
   * screen a reader could have spent from. §6 records the reversal.
   */
  ANTHROPIC_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * e2e-only (R4.md §8: "stub the transport"). A real SSE mock of the
   * Messages API is a lot of low-level protocol to get exactly right for a
   * single spec; this reuses the same in-process seam the integration suite
   * already trusts (`lib/anthropicClient.ts`'s `__setAnthropicClientForTests`)
   * instead, wired on at boot rather than by a direct function call, since
   * Playwright drives the API as a separate process it can only configure
   * through env vars — the same way `playwright.config.ts` already injects
   * `JWT_SECRET` and `DATABASE_URL`. Rejected outright in production so it
   * can never become a way to fake an answer for a real reader.
   */
  ANTHROPIC_E2E_STUB: z.preprocess(emptyToUndefined, z.enum(['1']).optional()),
  /**
   * The SMS provider slot (journeys build plan J1; P0-4, PD-18). All five
   * optional, exactly like Resend above — the founder may legitimately not
   * have chosen a provider yet (P0-4: on purpose, left empty), and an
   * unconfigured one degrades rather than refuses to boot: invites still
   * show their link on the desk, phone recovery refuses `SMS_UNAVAILABLE`,
   * and the staff second factor goes unenforced in production only (see
   * `lib/sms.ts`'s `smsAvailable`). `SMS_API_KEY`/`SMS_SENDER` are required
   * together with `SMS_PROVIDER` below, the same pairing discipline as
   * Resend's pair — a provider named with no key or no sender line cannot
   * send regardless. `SMS_CODE_PATTERN`/`SMS_INVITE_PATTERN` stay optional
   * even then: not every provider requires a pre-approved template, and the
   * ones that do are named in `smsProvider.ts`'s own header.
   */
  SMS_PROVIDER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMS_API_KEY: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMS_SENDER: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMS_CODE_PATTERN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  SMS_INVITE_PATTERN: z.preprocess(emptyToUndefined, z.string().min(1).optional()),
  /**
   * e2e-only, the same shape and the same production refusal as
   * `ANTHROPIC_E2E_STUB` above: a test-only route (mounted only when this is
   * set) that reads back what `DevSmsTransport` last sent to a phone, so
   * Playwright can complete a phone-code or staff-factor challenge without
   * a real SMS provider. `lib/sms.ts` never logs a message body outside
   * `DevSmsTransport` in development, and this outbox is that same
   * transport's own memory — nothing new is exposed by reading it.
   */
  SMS_E2E_OUTBOX: z.preprocess(emptyToUndefined, z.enum(['1']).optional()),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment:\n${issues.join('\n')}`);
}

if (parsed.data.NODE_ENV === 'production' && !parsed.data.STORAGE_DIR) {
  throw new Error(
    'Invalid environment:\n  - STORAGE_DIR is required in production ' +
      '(a path outside the release directory — see docs/deploy.md)',
  );
}

if (Boolean(parsed.data.RESEND_API_KEY) !== Boolean(parsed.data.MAIL_FROM)) {
  throw new Error(
    'Invalid environment:\n  - RESEND_API_KEY and MAIL_FROM must both be set, or both left unset',
  );
}

// Deliberately no production check on ANTHROPIC_API_KEY — see its comment
// above. Say so once at boot instead, because "the Ask box is gone" is
// otherwise a silent symptom an operator has to guess the cause of.
if (parsed.data.NODE_ENV === 'production' && !parsed.data.ANTHROPIC_API_KEY) {
  console.warn(
    '[env] no ANTHROPIC_API_KEY — the Research Lab\'s Ask surface is disabled. ' +
      'Set it in .env to enable it (see .env.production.example).',
  );
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.ANTHROPIC_E2E_STUB) {
  throw new Error('Invalid environment:\n  - ANTHROPIC_E2E_STUB must never be set in production');
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.SMS_E2E_OUTBOX) {
  throw new Error('Invalid environment:\n  - SMS_E2E_OUTBOX must never be set in production');
}

if (parsed.data.SMS_PROVIDER && !(parsed.data.SMS_API_KEY && parsed.data.SMS_SENDER)) {
  throw new Error(
    'Invalid environment:\n  - SMS_PROVIDER requires SMS_API_KEY and SMS_SENDER — a provider named with neither cannot send anything',
  );
}

// PD-18, founder 2026-09-28: the slot is deliberately left empty until a
// provider is chosen (P0-4) — this is a warning, not a boot refusal, for
// exactly the reason ANTHROPIC_API_KEY's own comment gives above: the rest
// of the product works without SMS, and a boot failure would take the
// portal down with a feature nobody has wired yet. What actually changes
// while this is unset is PD-18's own list — invites keep showing their link,
// phone recovery refuses SMS_UNAVAILABLE, and the staff second factor goes
// unenforced (see lib/sms.ts's smsAvailable and the desk banner it feeds).
if (parsed.data.NODE_ENV === 'production' && !parsed.data.SMS_PROVIDER) {
  console.warn(
    '[env] no SMS_PROVIDER — the staff second factor is not enforced and phone ' +
      'recovery is unavailable. Invites still show their link on the desk. ' +
      'Set the five SMS_* variables to enable it (see .env.production.example).',
  );
}

const cookieName = parsed.data.COOKIE_NAME ?? defaultCookieName(parsed.data.NODE_ENV);
assertCookieNameIsHardened(parsed.data.NODE_ENV, cookieName);

export const env = {
  ...parsed.data,
  COOKIE_NAME: cookieName,
  // Development and test write beside the app, which is fine precisely because
  // nothing there is swapped out from under them.
  STORAGE_DIR: parsed.data.STORAGE_DIR ?? fileURLToPath(new URL('../../storage', import.meta.url)),
  PUBLIC_FILES_BASE: parsed.data.PUBLIC_FILES_BASE ?? `${parsed.data.APP_ORIGIN}/public-files`,
};
