import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `npm test` for the API — the unit suite, with the environment `env.ts`
 * insists on at import.
 *
 * Unit tests touch no database, but several import modules that import
 * `lib/env.ts`, which validates eagerly and refuses to load without
 * `DATABASE_URL` and a 32-character `JWT_SECRET`. On a checkout with
 * `apps/api/.env` that was invisible; a fresh git worktree has none, and the
 * suite failed there on tests that have nothing to do with either variable
 * (found by the P0-2 lane, 2026-09-28). So both get a placeholder when unset —
 * the URL names a database nothing connects to — and the mail provider is
 * pinned blank, as `test-integration.ts` does, so no unit test can ever place
 * a real send whatever `.env` holds.
 */

const run = spawnSync('npx tsx --test src/lib/*.test.ts', {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || 'postgresql://unit:unit@localhost:1/unit_tests_touch_no_database',
    JWT_SECRET: process.env.JWT_SECRET || 'unit-only-secret-not-used-anywhere-else-0123456789',
    RESEND_API_KEY: '',
    MAIL_FROM: '',
    // J1's test-env pinning rule (C2's Resend lesson, applied to the new
    // outbound provider): blank whatever this checkout's .env holds, so no
    // unit test can ever place a real SMS send.
    SMS_PROVIDER: '',
    SMS_API_KEY: '',
    SMS_SENDER: '',
    SMS_CODE_PATTERN: '',
    SMS_INVITE_PATTERN: '',
    // J9: see test-integration.ts.
    MOCKUP_BASE_DOMAIN: 'mockup.localhost',
  },
  stdio: 'inherit',
  // As in test-integration.ts: cmd.exe leaves the glob to Node's test runner.
  shell: true,
});

process.exit(run.status ?? 1);
