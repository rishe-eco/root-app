import { test, expect } from '@playwright/test';
import { ADMIN, resetTestDatabase, signIn } from './helpers';

/**
 * R4's e2e spec (§8): against a stubbed transport — see
 * `apps/api/src/lib/anthropicClient.ts`'s `buildE2EStubClient`, switched on
 * by `ANTHROPIC_E2E_STUB` in `playwright.config.ts` rather than a live API
 * key. Ask a question of a published entry, get a streamed answer with a
 * real citation link back to that entry — the stub always cites
 * `document_index: 0`, which for "Ask this paper" is always the one pinned
 * entry, so the link this spec follows is genuine, not hard-coded.
 *
 * Kept to one flow, same reasoning as R2's own e2e spec: the value is in
 * the integration suite (r4.test.ts), which holds the rights boundary and
 * every refusal path this spec has no way to see.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

test('an anonymous visitor asks a question of a published entry and gets a streamed, cited answer', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/library');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/library\/new/);

  await page.locator('#le-lang').fill('en');
  await page.locator('#le-title').fill('A Paper Worth Asking About');
  await page.locator('#le-authors').fill('A. Author');
  await page.locator('input[name="provenance"][value="NONE_YET"]').check();
  await page.locator('input[name="rights"][value="PUBLIC_DOMAIN"]').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/library\/[a-z0-9]{20,}$/);

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published').first()).toBeVisible();

  // The anonymous half: no session from here on.
  await page.context().clearCookies();

  await page.goto('/en/library/research/a-paper-worth-asking-about');
  await expect(page.getByRole('heading', { name: 'A Paper Worth Asking About' })).toBeVisible();

  // "Ask this paper" — pinned to this one entry (T1: the same component as
  // "Ask the Lab", just narrowed by entrySlug).
  await expect(page.getByText('Ask this paper')).toBeVisible();
  await page.getByPlaceholder('What do you want to know?').fill('What is this paper about?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();

  // The stub's canned answer, streamed in.
  await expect(page.getByText('this stub answer confirms it', { exact: false })).toBeVisible({ timeout: 10_000 });

  // A real citation link back to the entry the reader is already on.
  const citation = page.locator('.ask-lab-citations a', { hasText: 'A Paper Worth Asking About' });
  await expect(citation).toBeVisible();
  await expect(citation).toHaveAttribute('href', '/en/library/research/a-paper-worth-asking-about');
});
