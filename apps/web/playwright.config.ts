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
 * ## Ports
 *
 * Everything runs beside the ordinary dev servers rather than replacing them:
 * API on 4101, web on 4173, against `root_website_test`. You can keep working
 * on :5173/:4000 while these run, and — more importantly — a suite that resets
 * its database can never reach the one you have been clicking through.
 */

const API_PORT = 4101;
const WEB_PORT = 4173;
const TEST_DATABASE_URL = 'postgresql://root:root@localhost:5432/root_website_test?schema=public';

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
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],

  webServer: [
    {
      // NODE_ENV stays at development: production would disable introspection
      // and mask error messages, and a failing test wants to be told why.
      command: 'npm run start:e2e',
      cwd: '../api', // webServer commands run beside this config, not at the repo root
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL: TEST_DATABASE_URL,
        PORT: String(API_PORT),
        JWT_SECRET: 'e2e-only-secret-not-used-anywhere-else-0123456789',
        APP_ORIGIN: `http://localhost:${WEB_PORT}`,
        TRUST_PROXY_HOPS: '0',
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
