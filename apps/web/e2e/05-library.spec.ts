import { test, expect } from '@playwright/test';
import { ADMIN, CONTRIBUTOR, resetTestDatabase, signIn } from './helpers';

/**
 * R1's one e2e spec (§9): as admin, create an entry, upload a PDF, publish
 * it; as contributor, open the same entry and find publish unavailable. Kept
 * cheap on purpose — the value in this stage is in the integration tests
 * (§9, 5–9), which hold the CHECK-refusal and bytes-deletion behaviour this
 * spec has no way to see.
 */

const PDF = Buffer.from('%PDF-1.7\n%a research paper\n');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

test('an admin creates a Library entry, uploads its PDF and publishes it; a contributor cannot', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/library');
  await page.getByRole('button', { name: 'New entry' }).click();
  await expect(page).toHaveURL(/\/en\/desk\/library\/new/);

  await page.locator('#le-lang').fill('en');
  await page.locator('#le-title').fill('A Paper Worth Reading');
  await page.locator('#le-authors').fill('A. Author');

  // The two required-choice radios (§2.1) — genuinely unpreselected.
  await expect(page.locator('input[name="provenance"]:checked')).toHaveCount(0);
  await expect(page.locator('input[name="rights"]:checked')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  await page.locator('input[name="provenance"][value="NONE_YET"]').check();
  await page.locator('input[name="rights"][value="PUBLIC_DOMAIN"]').check();
  await expect(page.getByRole('button', { name: 'Save' })).toBeEnabled();
  await page.getByRole('button', { name: 'Save' }).click();

  // A real cuid, not "new" or "concepts" — both of which also match a bare
  // [a-z0-9]+ pattern.
  await expect(page).toHaveURL(/\/en\/desk\/library\/[a-z0-9]{20,}$/);
  const entryUrl = page.url();

  // The full-text section only appears once the entry exists. setInputFiles
  // works on the hidden input directly — no click needed to open a picker.
  await expect(page.getByRole('button', { name: 'Upload file' })).toBeVisible();
  await page.setInputFiles('input[type="file"]', {
    name: 'paper.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await expect(page.getByRole('link', { name: 'View file' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published').first()).toBeVisible();

  await signIn(page, CONTRIBUTOR);
  await page.goto(entryUrl);

  // T6: the section is reachable and the screen renders — publish is simply
  // not something a contributor can do, shown as unavailable rather than
  // hidden or erroring on click.
  await expect(page.getByRole('button', { name: 'Publish' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Unpublish' })).toHaveCount(0);
  await expect(page.getByText('Publishing is not available to you.')).toBeVisible();
});
