import { test, expect, type Page } from '@playwright/test';
import { ADMIN, CUSTOMER, SALES, resetTestDatabase, signIn } from './helpers';

/**
 * US1 — an administrator edits an account, hands over a fresh invite link
 * (copied, since no SMS or mail may be configured) and deletes an account
 * with no history; sales edits a customer and, with that customer's
 * contracts on record, is offered disable or anonymize instead of delete.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const CUSTOMER_NAME = 'نهال رضایی';
const INVITEE = 'Sara Invitee';

const row = (page: Page, name: string) => page.getByTestId('user-row').filter({ hasText: name });

test('an administrator invites, forgets the link, and copies a fresh one from the Users page — the copy is the link on screen', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, ADMIN);
  await page.goto('/en/desk/users');
  await page.locator('#u-name').fill(INVITEE);
  await page.locator('#u-email').fill('sara@example.com');
  await page.locator('#invite-role-CONTRIBUTOR').check();
  await page.getByRole('button', { name: 'Generate invite link' }).click();
  const first = await page.getByTestId('invite-link-url').innerText();

  // "Forgot to copy it": reload, and the first link is gone from the screen.
  await page.reload();
  await expect(page.getByTestId('invite-link')).toHaveCount(0);
  await row(page, INVITEE).getByTestId('user-manage').click();
  const panel = page.getByTestId('user-panel');
  await panel.getByTestId('invite-reissue').click();
  await expect(panel.getByTestId('invite-link')).toContainText('no longer works');
  const fresh = await panel.getByTestId('invite-link-url').innerText();
  expect(fresh).toMatch(/\/(fa|en)\/portal\/invite\/[^/]+$/);
  expect(fresh).not.toEqual(first);

  await panel.getByTestId('invite-link-copy').click();
  await expect(panel.getByTestId('invite-link-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toEqual(fresh);
});

test('an administrator edits the invitee’s details, then deletes the account — nothing records it, so it simply goes', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/users');
  await row(page, INVITEE).getByTestId('user-manage').click();
  const panel = page.getByTestId('user-panel');
  await panel.locator('input[id$="-name"]').fill('Sara Corrected');
  await panel.locator('input[id$="-email"]').fill('sara.corrected@example.com');
  await panel.getByTestId('account-save').click();
  await expect(row(page, 'Sara Corrected')).toContainText('sara.corrected@example.com');

  await row(page, 'Sara Corrected').getByTestId('user-manage').click();
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('user-panel').getByTestId('account-delete').click();
  await expect(row(page, 'Sara Corrected')).toHaveCount(0);
});

test('in Persian the account tools are translated', async ({ page }) => {
  await signIn(page, ADMIN, 'fa');
  await page.goto('/fa/desk/users');
  await row(page, CUSTOMER_NAME).getByTestId('user-manage').click();
  const panel = page.getByTestId('user-panel');
  await expect(panel.getByTestId('account-save')).toHaveText('ذخیرهٔ مشخصات');
  await expect(panel.getByTestId('account-delete')).toHaveText('حذف حساب');
  expect(await panel.innerText()).not.toMatch(/\bdesk\.people\.[A-Za-z_.]+/);
});

test('sales edits a customer’s company, and deleting a customer with contracts offers disable or anonymize instead', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/customers');
  await page.getByRole('link', { name: CUSTOMER_NAME }).click();
  await page.waitForURL(/\/desk\/customers\/[^/]+$/);

  await page.getByTestId('account-edit-open').click();
  await page.locator('input[id$="-client"]').fill('Nahal Studio Ltd');
  await page.getByTestId('account-save').click();
  await expect(page.getByText('Nahal Studio Ltd')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByTestId('account-delete').click();
  const history = page.getByTestId('account-has-history');
  await expect(history).toContainText('has records');
  await expect(history.getByTestId('account-disable-instead')).toBeVisible();
  // The danger zone's button waits for the name, typed exactly.
  const submit = history.getByTestId('account-anonymize-submit');
  await expect(submit).toBeDisabled();
  await history.locator('input').fill('Nahal');
  await expect(submit).toBeDisabled();
  await history.locator('input').fill(CUSTOMER_NAME);
  await submit.click();

  await expect(page.getByRole('heading', { name: 'Deleted user' })).toBeVisible();
  await expect(page.getByText(CUSTOMER.email)).toHaveCount(0);
  // Its contract is still there, on record.
  await expect(page.getByRole('link', { name: 'RC-2026-014' })).toBeVisible();

  // And the person behind it can no longer sign in.
  await page.context().clearCookies();
  await page.goto('/en/portal');
  await page.locator('#email').fill(CUSTOMER.email);
  await page.locator('#password').fill(CUSTOMER.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/en\/portal\/?$/);
});
