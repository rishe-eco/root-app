import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end, against the built app and a real API and database.
 *
 * ## channel: 'chrome'
 *
 * Playwright's own browser download is **geo-blocked from here** — the CDN
 * answers 403 "this service is not available in your location". So these run
 * against the Chrome already installed on the machine instead, which needs no
 * download and no mirror. The cost is that the browser version is whatever is
 * installed rather than one pinned by Playwright; if a test ever fails only in
 * CI, that difference is the first thing to check.
 *
 * `E2E_BROWSER_CHANNEL` overrides it, for a machine with no Chrome:
 * `msedge` drives an installed Edge, the same engine.
 *
 * ## Ports
 *
 * Everything runs beside the ordinary dev servers rather than replacing them:
 * API on 4101, web on 4173, against `root_website_test`. You can keep working
 * on :5173/:4000 while these run, and — more importantly — a suite that resets
 * its database can never reach the one you have been clicking through.
 *
 * ## Parallel checkouts
 *
 * `ROOT_TEST_DB`, `E2E_API_PORT` and `E2E_WEB_PORT` move all three, so two git
 * worktrees can run e2e at once. The ports matter as much as the database:
 * `reuseExistingServer` would otherwise attach the second run to the first
 * run's servers, and it would test the other checkout's code without saying
 * so. `e2e/helpers.ts` reads the same three variables.
 */

const CHANNEL = process.env.E2E_BROWSER_CHANNEL || 'chrome';
const API_PORT = Number(process.env.E2E_API_PORT || 4101);
const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4173);
const TEST_DB = process.env.ROOT_TEST_DB || 'root_website_test';
const TEST_DATABASE_URL = `postgresql://root:root@localhost:5432/${TEST_DB}?schema=public`;

export default defineConfig({
  testDir: './e2e',
  // The suite drives one contract through a flow that ends in an irreversible
  // signature. Parallel workers would be racing over a single row.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: CHANNEL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: CHANNEL } }],

  webServer: [
    {
      // NODE_ENV stays at development: production would disable introspection
      // and mask error messages, and a failing test wants to be told why.
      // test:db first: creates the database if this checkout has never had one,
      // and migrates it, before the API opens a connection to it.
      command: 'npm run test:db && npm run start:e2e',
      cwd: '../api', // webServer commands run beside this config, not at the repo root
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        ROOT_TEST_DB: TEST_DB,
        PORT: String(API_PORT),
        JWT_SECRET: 'e2e-only-secret-not-used-anywhere-else-0123456789',
        APP_ORIGIN: `http://localhost:${WEB_PORT}`,
        TRUST_PROXY_HOPS: '0',
        // J9: pinned like the provider keys — a mockup view is
        // http://<grant-id>.mockup.localhost:<API port>/, which a real browser
        // resolves to loopback with no DNS, whatever this checkout's .env says.
        MOCKUP_BASE_DOMAIN: 'mockup.localhost',
        // J10: a staging site plays on http://<slug>.staging.localhost:<port>
        // (a local static server), which a real browser resolves to loopback.
        STAGING_BASE_DOMAIN: 'staging.localhost',
        // C2 is the first stage whose flows (opening/replying to a thread,
        // inviting a reviewer) actually call sendMail. Blank, not omitted —
        // env.ts's loadEnvFile() only skips a var already present in
        // process.env, and apps/api/.env carries a real Resend key that
        // would otherwise place a live outbound call on every run.
        RESEND_API_KEY: '',
        MAIL_FROM: '',
        // R4: a canned in-process client, not a live API — see
        // lib/anthropicClient.ts's buildE2EStubClient and env.ts's refusal
        // to ever honor this in production. ANTHROPIC_API_KEY is left
        // unset rather than blanked: env.ts only requires it in production,
        // and the stub takes precedence over a key in any case.
        ANTHROPIC_E2E_STUB: '1',
        // J1's test-env pinning rule — blank whatever this checkout's .env
        // holds, so e2e can never place a real SMS send (C2's Resend lesson).
        SMS_PROVIDER: '',
        SMS_API_KEY: '',
        SMS_SENDER: '',
        SMS_CODE_PATTERN: '',
        SMS_INVITE_PATTERN: '',
        // The e2e-only outbox route (routes/smsOutbox.ts) — every existing
        // spec signs in as a factor-requiring staff account now that
        // DevSmsTransport makes the factor live in this environment (see
        // e2e/helpers.ts's signIn), so this has to be on for the *whole*
        // suite, not opted into per spec.
        SMS_E2E_OUTBOX: '1',
        // J13: the invoice specs assert due days; pinned to the shipped 7
        // whatever this checkout's .env says.
        DEFAULT_PAYMENT_TERM_DAYS: '7',
      },
    },
    {
      command: 'npm run build && npx vite preview',
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        PREVIEW_PORT: String(WEB_PORT),
        VITE_API_PROXY: `http://localhost:${API_PORT}`,
      },
    },
  ],
});
