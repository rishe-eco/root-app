import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER, SALES, WIZARD_CONTRACT_REF, WIZARD_CONTRACT_TITLE, completeStepOneViaApi, resetTestDatabase, signIn } from './helpers';

/**
 * SC1 — Root adds pages, features and deliverables straight into step 2a, in
 * the desk's Steps tab, without touching the site type's list; the starting
 * list stays available after a hand-added item; an item the customer has
 * been handed is taken out with a reason they read.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  await completeStepOneViaApi(request);
});

async function staffScope(page: Page, lang: 'en' | 'fa' = 'en') {
  await signIn(page, SALES, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
  await page.locator('.stepper-item[data-step="SCOPE"] button').click();
  await expect(page.getByTestId('scope-panel')).toBeVisible();
}

test('sales adds a page by hand, then still applies the starting list beside it', async ({ page }) => {
  await staffScope(page);
  await expect(page.getByTestId('scope-empty')).toBeVisible();
  await expect(page.getByTestId('scope-seed')).toBeVisible();

  const form = page.getByTestId('scope-add');
  await expect(page.getByTestId('scope-add-submit')).toBeDisabled();
  await form.locator('#scope-add-fa').fill('وبلاگ');
  await form.locator('#scope-add-en').fill('Blog');
  await page.getByTestId('scope-add-submit').click();
  await expect(page.getByTestId('scope-add-done')).toBeVisible();
  const blog = page.locator('[data-testid="scope-item"][data-key="custom.1"]');
  await expect(blog).toContainText('Blog');
  await expect(blog).toHaveAttribute('data-status', 'AGREED');
  // The form is cleared for the next one.
  await expect(form.locator('#scope-add-en')).toHaveValue('');

  // A hand-added item is not the template: the starting list is still offered.
  await expect(page.getByTestId('scope-seed')).toBeVisible();
  await page.getByTestId('scope-seed-button').click();
  await expect(page.getByTestId('scope-item')).toHaveCount(4);
  await expect(page.getByTestId('scope-seed')).toHaveCount(0);
  await expect(blog).toBeVisible();
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).toHaveAttribute('data-status', 'DONE');
});

test('in Persian the form is translated; the customer sees the item and no form of Root’s', async ({ page }) => {
  await staffScope(page, 'fa');
  await expect(page.getByTestId('scope-add')).toContainText('افزودن مورد');
  expect(await page.getByTestId('scope-panel').innerText()).not.toMatch(/\bscope\.[A-Za-z_.]+/);

  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  await page.locator('tr.crow', { hasText: 'فروشگاه آنلاین نهال' }).click();
  await page.locator('.stepper-item[data-step="SCOPE"] button').click();
  await expect(page.locator('[data-testid="scope-item"][data-key="custom.1"]')).toContainText('وبلاگ');
  await expect(page.getByTestId('scope-add')).toHaveCount(0);
  await expect(page.getByTestId('scope-staff-decline')).toHaveCount(0);
});

test('after the handover, taking an item out asks for a reason — and the customer reads it under “left out”', async ({ page }) => {
  await staffScope(page);
  const blog = page.locator('[data-testid="scope-item"][data-key="custom.1"]');
  // The customer has been handed this contract, so it is a decline, not a delete.
  await expect(page.getByTestId('scope-staff-delete')).toHaveCount(0);
  await page.getByTestId('feedback-target').filter({ has: blog }).getByTestId('scope-staff-decline').click();
  const form = page.getByTestId('scope-staff-decline-form');
  await form.locator('textarea').fill('Not in this phase — we will add it with the second contract.');
  await form.getByRole('button', { name: 'Take it out with this reason' }).click();
  await expect(blog).toHaveAttribute('data-status', 'DECLINED');

  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_TITLE }).click();
  await page.locator('.stepper-item[data-step="SCOPE"] button').click();
  const out = page.locator('[data-testid="scope-item"][data-key="custom.1"]');
  await expect(out).toHaveAttribute('data-status', 'DECLINED');
  await expect(out).toContainText('Not in this phase');
});
