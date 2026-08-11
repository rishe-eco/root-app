import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, REVIEWER, resetTestDatabase, signIn } from './helpers';

/**
 * The staff shell at `/desk`, and the role boundary around it.
 *
 * The boundary is checked from the browser as well as from the resolvers,
 * because they can fail independently: the server refusing a query is not the
 * same as the UI declining to show the screen, and a customer who reaches a
 * desk section and sees it half-render has still been shown something.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

test('a customer cannot reach the desk', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await page.goto('/en/desk');

  // Two redirects, not one: DeskLayout sends a non-staff user to /portal, and
  // /portal sends an already-signed-in user on to their workspace. So the
  // customer ends up where they belong rather than staring at a sign-in form
  // they do not need. What matters is that they never land on the desk, and
  // never see any of it.
  await expect(page).toHaveURL(/\/en\/app\/contracts/);
  await expect(page.getByRole('heading', { name: 'Desk' })).toHaveCount(0);
  await expect(page.getByText('RC-2026-014')).toHaveCount(0);
});

test('an anonymous visitor cannot reach the desk', async ({ page }) => {
  await page.goto('/en/desk');
  await expect(page).toHaveURL(/\/en\/portal/);
  await expect(page.locator('#email')).toBeVisible();
});

test('an admin signing in lands on the desk directly', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page).toHaveURL(/\/en\/desk/);
  await expect(page.getByRole('heading', { name: 'Desk' })).toBeVisible();
});

test('an admin sees every section in the nav', async ({ page }) => {
  await signIn(page, ADMIN);
  const nav = page.locator('.desk-nav');
  await expect(nav.getByText('Overview')).toBeVisible();
  await expect(nav.getByText('Contracts')).toBeVisible();
  await expect(nav.getByText('Customers')).toBeVisible();
});

test('an admin can issue an invite and gets a link back', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/customers');

  const stamp = Date.now();
  const email = `invitee-${stamp}@example.com`;

  await page.locator('#i-email').fill(email);
  await page.locator('#i-name').fill('New Person');
  await page.locator('#i-client').fill('New Studio');
  await page.getByRole('button', { name: 'Generate invite link' }).click();

  // Nothing sends mail yet, so the raw link is shown once for an operator to
  // pass on by hand. If that ever stops appearing, invites silently stop
  // working — there is no other copy of the token.
  await expect(page.getByText(/\/portal\/invite\//)).toBeVisible({ timeout: 10_000 });
});

test('an admin sees every contract, not just their own', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/contracts');
  await expect(page.getByText('RC-2026-014')).toBeVisible();
});

test('a reviewer sees Overview and Review and nothing else, and cannot type their way into Contracts', async ({
  page,
}) => {
  await signIn(page, REVIEWER);
  await expect(page).toHaveURL(/\/en\/desk\/overview/);

  const nav = page.locator('.desk-nav');
  await expect(nav.getByText('Overview')).toBeVisible();
  // review.participate (C1) is the one capability REVIEWER holds beyond the
  // implicit "any staff" Overview — so this is the one other section that
  // should be here, not a hole where every other capability's section is not.
  await expect(nav.getByText('Review')).toBeVisible();
  await expect(nav.getByText('Contracts')).toHaveCount(0);
  await expect(nav.getByText('Customers')).toHaveCount(0);
  await expect(nav.getByText('Library')).toHaveCount(0);

  // The acceptance criterion: a capability filter, not an isAdmin in disguise.
  await page.goto('/en/desk/contracts');
  await expect(page).toHaveURL(/\/en\/desk\/overview/);
  await expect(page.getByText('RC-2026-014')).toHaveCount(0);
});
