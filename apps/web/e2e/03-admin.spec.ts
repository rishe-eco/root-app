import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, resetTestDatabase, signIn } from './helpers';

/**
 * The thin operational admin, and the role boundary around it.
 *
 * The boundary is checked from the browser as well as from the resolvers,
 * because they can fail independently: the server refusing a query is not the
 * same as the UI declining to show the screen, and a customer who reaches an
 * admin page and sees it half-render has still been shown something.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

test('a customer cannot reach the admin', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await page.goto('/en/admin');

  // Two redirects, not one: Admin sends a non-admin to /portal, and /portal
  // sends an already-signed-in user on to their workspace. So the customer
  // ends up where they belong rather than staring at a sign-in form they do
  // not need. What matters is that they never land on the admin, and never
  // see any of it.
  await expect(page).toHaveURL(/\/en\/app\/contracts/);
  await expect(page.getByRole('heading', { name: 'Admin' })).toHaveCount(0);
  await expect(page.getByText('RC-2026-014')).toHaveCount(0);
});

test('an anonymous visitor cannot reach the admin', async ({ page }) => {
  await page.goto('/en/admin');
  await expect(page).toHaveURL(/\/en\/portal/);
  await expect(page.locator('#email')).toBeVisible();
});

test('an admin can issue an invite and gets a link back', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/admin');
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();

  const stamp = Date.now();
  const email = `invitee-${stamp}@example.com`;

  // The form has no ids; fill by position within it, which is what the admin
  // screen actually is — three text fields and a button.
  const form = page.locator('form').first();
  await form.locator('input').nth(0).fill(email);
  await form.locator('input').nth(1).fill('New Person');
  await form.locator('input').nth(2).fill('New Studio');
  await form.getByRole('button').first().click();

  // Nothing sends mail yet, so the raw link is shown once for an operator to
  // pass on by hand. If that ever stops appearing, invites silently stop
  // working — there is no other copy of the token.
  await expect(page.getByText(/\/portal\/invite\//)).toBeVisible({ timeout: 10_000 });
});

test('an admin sees every contract, not just their own', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/admin');
  await expect(page.getByText('RC-2026-014')).toBeVisible();
});
