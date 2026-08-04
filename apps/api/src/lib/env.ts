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

export const env = {
  ...parsed.data,
  // Development and test write beside the app, which is fine precisely because
  // nothing there is swapped out from under them.
  STORAGE_DIR: parsed.data.STORAGE_DIR ?? fileURLToPath(new URL('../../storage', import.meta.url)),
  PUBLIC_FILES_BASE: parsed.data.PUBLIC_FILES_BASE ?? `${parsed.data.APP_ORIGIN}/public-files`,
};
