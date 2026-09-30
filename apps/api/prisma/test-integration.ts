import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL, TEST_DB, ensureTestDatabase } from './test-db.js';

/**
 * `npm run test:integration` — the environment the suite needs, set here
 * rather than as a `VAR=… tsx` prefix in package.json.
 *
 * The prefix form only ever worked where npm runs scripts through a POSIX
 * shell; on Windows npm uses cmd.exe, which reads `DATABASE_URL="…"` as the
 * name of a program. And it leaned on `apps/api/.env` for `JWT_SECRET`, a
 * file a fresh git worktree does not have. Everything the suite depends on is
 * therefore pinned below, so a checkout with no `.env` runs the same suite as
 * one with it — and so the provider keys are blank whatever `.env` says
 * (`env.ts`'s loader never overrides a variable that is already set).
 *
 * Storage is per test database, for the same reason the database is: two
 * checkouts writing into one directory would see each other's files.
 */

await ensureTestDatabase();

// One string, not argv: with `shell` on, Node only concatenates argv anyway
// (DEP0190), and none of it is input.
const run = spawnSync('npx tsx --test --test-concurrency=1 src/test/*.test.ts', {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    STORAGE_DIR: join(tmpdir(), `root-api-test-storage-${TEST_DB}`),
    JWT_SECRET: process.env.JWT_SECRET || 'integration-only-secret-not-used-anywhere-else-0123',
    RESEND_API_KEY: '',
    MAIL_FROM: '',
    // J1's test-env pinning rule — see test-unit.ts's identical block.
    SMS_PROVIDER: '',
    SMS_API_KEY: '',
    SMS_SENDER: '',
    SMS_CODE_PATTERN: '',
    SMS_INVITE_PATTERN: '',
    // J13: tests assert due days, so the default payment term is the shipped 7
    // whatever this checkout's .env says (it is not a provider key; it is the
    // same pinning rule for a setting a test's arithmetic depends on).
    DEFAULT_PAYMENT_TERM_DAYS: '7',
    // J9: the mockup host's base domain, pinned like the rest — j9a.test.ts
    // builds `Host` headers from it and asserts on the URLs it produces.
    MOCKUP_BASE_DOMAIN: 'mockup.localhost',
  },
  stdio: 'inherit',
  // cmd.exe does not expand the glob, and does not need to: Node's test
  // runner expands it itself. A POSIX shell expands it first; same files.
  shell: true,
});

process.exit(run.status ?? 1);
