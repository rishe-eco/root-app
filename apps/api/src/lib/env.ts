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
  COOKIE_NAME: z.string().default('root_session'),
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
   * The Research Lab's agent (R4). Unlike RESEND_API_KEY, this is **not**
   * optional in production — R4.md §6 is explicit that the first per-request
   * money this product spends must not be discovered at the first question.
   * It *is* optional in development, the same shape `lib/mail.ts` already
   * uses for a provider the founder hasn't wired up yet: a missing key
   * degrades the Ask surface to "unavailable" rather than refusing to boot,
   * so the rest of the app still runs for someone working on R2's reader.
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

if (parsed.data.NODE_ENV === 'production' && !parsed.data.ANTHROPIC_API_KEY) {
  throw new Error(
    'Invalid environment:\n  - ANTHROPIC_API_KEY is required in production ' +
      '(the Research Lab agent spends money on an anonymous request — see R4.md §6)',
  );
}

if (parsed.data.NODE_ENV === 'production' && parsed.data.ANTHROPIC_E2E_STUB) {
  throw new Error('Invalid environment:\n  - ANTHROPIC_E2E_STUB must never be set in production');
}

export const env = {
  ...parsed.data,
  // Development and test write beside the app, which is fine precisely because
  // nothing there is swapped out from under them.
  STORAGE_DIR: parsed.data.STORAGE_DIR ?? fileURLToPath(new URL('../../storage', import.meta.url)),
  PUBLIC_FILES_BASE: parsed.data.PUBLIC_FILES_BASE ?? `${parsed.data.APP_ORIGIN}/public-files`,
};
