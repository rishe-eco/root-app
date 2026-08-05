import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Page } from '@playwright/test';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../api');

export const TEST_DATABASE_URL =
  'postgresql://root:root@localhost:5432/root_website_test?schema=public';

/** The accounts prisma/seed.ts creates. */
export const ADMIN = { email: 'admin@root.local', password: 'change-me-please' };
export const CUSTOMER = { email: 'nahal@example.com', password: 'change-me-please' };
export const REVIEWER = { email: 'reviewer@root.local', password: 'change-me-please' };
export const CONTRACT_REF = 'RC-2026-014';
/** What the contracts list actually shows — the ref is not on that screen. */
export const CONTRACT_TITLE = 'Nahal website & portal';

/**
 * Drops the test database, reapplies every migration and re-seeds.
 *
 * Called from each spec that mutates, because the flow these tests drive ends
 * in a signature and a signature is terminal — a second run against the same
 * rows would be testing "already signed" instead of the gate.
 *
 * The URL is passed explicitly rather than inherited, so this cannot be
 * pointed at the development database by an environment that happens to be
 * set. `migrate reset` is not something to be casual with.
 */
export function resetTestDatabase() {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execFileSync('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-generate'], {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
    timeout: 120_000,
  });
}

/**
 * Renames the contract's *draft* title, leaving the published revision alone.
 *
 * There is no mutation for this — nothing in the GraphQL surface edits a
 * contract's title after `createContract` — so it goes in as SQL. That is also
 * the honest reproduction: the drift this sets up is exactly what a direct
 * database edit, or the `updateContract` the admin screen will eventually want,
 * would produce.
 */
export function renameContractDraft(titleEn: string) {
  if (!TEST_DATABASE_URL.includes('_test')) throw new Error('refusing: not a test database');
  execFileSync('npx', ['prisma', 'db', 'execute', '--stdin', '--url', TEST_DATABASE_URL], {
    cwd: API_DIR,
    input: `UPDATE "Contract" SET "titleEn" = '${titleEn.replace(/'/g, "''")}' WHERE "ref" = '${CONTRACT_REF}';`,
    stdio: 'pipe',
    timeout: 60_000,
  });
}

/**
 * Signs in through the real form, so the session cookie is set the real way.
 *
 * Waits for navigation away from the sign-in page rather than a fixed
 * destination: a customer lands in `/app/`, staff land on `/desk` (F2's
 * `homeFor`), and this helper is shared by both.
 */
export async function signIn(page: Page, who: { email: string; password: string }, lang = 'en') {
  await page.goto(`/${lang}/portal`);
  await page.locator('#email').fill(who.email);
  await page.locator('#password').fill(who.password);
  await page.getByRole('button', { name: /sign in|ورود/i }).click();
  await page.waitForURL((url) => !/\/portal\/?$/.test(url.pathname));
}
