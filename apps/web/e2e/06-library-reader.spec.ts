import { test, expect } from '@playwright/test';
import { ADMIN, resetTestDatabase, signIn } from './helpers';

/**
 * R2's e2e spec (§8): an anonymous visitor — no signIn at all — searches the
 * Research Lab, opens an entry, and reads the original beside its
 * translation. Kept cheap on purpose, same reasoning as R1's: the value is
 * in the integration suite (r2.test.ts), which holds the visibility filter
 * and the withheld-field shape this spec has no way to see.
 *
 * Setup still needs an admin to publish something first — there is nothing
 * to browse otherwise — so the test signs in, publishes one entry, then
 * clears cookies before the anonymous half begins.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

test('an anonymous visitor finds, searches and reads a published entry; /cast and /blog redirect; the language switch keeps the same entry', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/library');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/library\/new/);

  await page.locator('#le-lang').fill('en');
  await page.locator('#le-title').fill('A Paper Worth Finding');
  await page.locator('#le-authors').fill('A. Author');
  await page.locator('input[name="provenance"][value="ROOT"]').check();
  await page.locator('#le-title-tr').fill('مقاله‌ای شایسته‌ی پیدا کردن');
  await page.locator('input[name="rights"][value="PUBLIC_DOMAIN"]').check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/library\/[a-z0-9]{20,}$/);

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published').first()).toBeVisible();

  // The anonymous half: no session at all from here on.
  await page.context().clearCookies();

  await page.goto('/en/library/research');
  await page.getByPlaceholder('Search titles, authors, abstracts…').fill('Finding');
  // The card shows the translated title when there is one — content is data,
  // not UI chrome (§0.1) — so the link is found by its href, not its text.
  const result = page.locator('a[href="/en/library/research/a-paper-worth-finding"]');
  await expect(result).toBeVisible();
  await result.click();

  await expect(page).toHaveURL(/\/en\/library\/research\/a-paper-worth-finding$/);
  await expect(page.getByText('Original', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'A Paper Worth Finding' })).toBeVisible();
  await expect(page.getByText('Translation', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'مقاله‌ای شایسته‌ی پیدا کردن' })).toBeVisible();
  await expect(page.getByText('Root translation')).toBeVisible();

  // T4: switching language must land on the same entry, not the list.
  await page.getByRole('button', { name: 'فا' }).click();
  await expect(page).toHaveURL(/\/fa\/library\/research\/a-paper-worth-finding$/);
  await expect(page.getByRole('heading', { name: 'A Paper Worth Finding' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'مقاله‌ای شایسته‌ی پیدا کردن' })).toBeVisible();

  // Both reserved routes redirect rather than 404 (§3), and still with no
  // session — this browser context never signed back in.
  await page.goto('/en/cast');
  await expect(page).toHaveURL(/\/en\/library\/cast$/);
  await expect(page.getByText('Coming later', { exact: true })).toBeVisible();

  await page.goto('/en/blog');
  await expect(page).toHaveURL(/\/en\/library\/cast$/);
});
