import { test, expect } from '@playwright/test';
import { ADMIN, CUSTOMER, SALES, resetTestDatabase, signIn } from './helpers';

/**
 * S3's acceptance tests: sales looks after a customer — disables and restores
 * the account, gives and takes back a tool — and an administrator invites a
 * member of staff from the Users place. The customer's side is watched from
 * the customer's own browser session, because "disabled" and "no such tool"
 * are things the customer experiences, not things the desk displays.
 *
 * The customer is the seeded one (نهال رضایی), who holds the product import.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const CUSTOMER_NAME = 'نهال رضایی';

/** Opens the seeded customer's page the way a person does: from the list. */
async function openCustomerPage(page: import('@playwright/test').Page, lang = 'en') {
  await page.goto(`/${lang}/desk/customers`);
  await page.getByRole('link', { name: CUSTOMER_NAME }).click();
  await page.waitForURL(/\/desk\/customers\/[^/]+$/);
}

test('sales opens a customer from the list and sees who they are and what they hold', async ({ page }) => {
  await signIn(page, SALES);
  await openCustomerPage(page);

  await expect(page.getByRole('heading', { name: CUSTOMER_NAME })).toBeVisible();
  await expect(page.getByText(CUSTOMER.email)).toBeVisible();
  // The seed grants the import tool to this customer.
  await expect(page.locator('.workspace-row', { hasText: 'Product import' }).locator('.badge')).toHaveText('Available');
  // The seeded contract, linked to its workspace.
  await expect(page.getByRole('link', { name: 'RC-2026-014' })).toBeVisible();
  // Sales holds money.read, so the billing summary is figures rather than the notice.
  await expect(page.getByText('Billing figures are shown only to people who can read money.')).toHaveCount(0);
});

test('sales disables a customer, who can no longer sign in — then restores them, and they can', async ({ page }) => {
  await signIn(page, SALES);
  await openCustomerPage(page);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Disable account' }).click();
  await expect(page.locator('.card .badge-danger')).toHaveText('Disabled');
  await expect(page.getByRole('button', { name: 'Restore account' })).toBeVisible();

  // The customer's side: the password is right and it does not matter.
  await page.context().clearCookies();
  await page.goto('/en/portal');
  await page.locator('#email').fill(CUSTOMER.email);
  await page.locator('#password').fill(CUSTOMER.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('alert')).toHaveText("That didn't match an account.");
  await expect(page).toHaveURL(/\/en\/portal\/?$/);

  // …and back.
  await signIn(page, SALES);
  await openCustomerPage(page);
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Restore account' }).click();
  await expect(page.getByRole('button', { name: 'Disable account' })).toBeVisible();

  await signIn(page, CUSTOMER);
  await expect(page).toHaveURL(/\/en\/app\/?$/);
});

test('the customer\'s Tools page: /app/services redirects to it, and it goes away when the tool is taken back', async ({
  page,
}) => {
  await signIn(page, CUSTOMER, 'fa');
  const rail = page.locator('.side-nav');
  await expect(rail.getByText('ابزارها', { exact: true })).toBeVisible();

  await page.goto('/fa/app/services');
  await expect(page).toHaveURL(/\/fa\/app\/tools$/);
  await expect(page.locator('h1.t-h2', { hasText: 'ابزارها' })).toBeVisible();
  // The strings L7 shipped without: a real title, not a translation key.
  await expect(page.getByText('services.pageTitle')).toHaveCount(0);
  await expect(page.getByText('بارگذاری فایل اکسل')).toBeVisible();

  // Sales takes the tool away…
  await signIn(page, SALES);
  await openCustomerPage(page);
  page.once('dialog', (d) => d.accept());
  await page.locator('.workspace-row', { hasText: 'Product import' }).getByRole('button', { name: 'Take away' }).click();
  await expect(page.locator('.workspace-row', { hasText: 'Product import' }).locator('.badge')).toHaveText('Not available');

  // …and for the customer there is no rail item, and the page says why it is empty.
  await signIn(page, CUSTOMER, 'fa');
  await expect(page.locator('.side-nav').getByText('ابزارها', { exact: true })).toHaveCount(0);
  await page.goto('/fa/app/tools');
  await expect(page.getByText('هنوز ابزاری برای حساب تو فعال نشده است.')).toBeVisible();

  // Give it back, so the database is as the seed left it.
  await signIn(page, SALES);
  await openCustomerPage(page);
  await page.locator('.workspace-row', { hasText: 'Product import' }).getByRole('button', { name: 'Give access' }).click();
  await expect(page.locator('.workspace-row', { hasText: 'Product import' }).locator('.badge')).toHaveText('Available');
});

test('sales has no Users place; an administrator invites a member of staff from it, in Persian', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/users');
  // Not a page they are refused on — a section they do not have.
  // (J12: the staff index is My work; it was Overview.)
  await expect(page).toHaveURL(/\/en\/desk(\/work|\/overview)?\/?$/);

  await signIn(page, ADMIN, 'fa');
  await page.locator('.desk-nav').getByText('کاربران', { exact: true }).click();
  await page.waitForURL(/\/fa\/desk\/users$/);

  await page.locator('#u-name').fill('سارا طراح');
  await page.locator('#u-phone').fill('09121234567');
  await page.locator('#invite-role-DESIGNER').check();
  await page.getByRole('button', { name: 'ساخت لینک دعوت' }).click();

  // The desk always shows the link (PD-18).
  await expect(page.getByText(/\/portal\/invite\//)).toBeVisible({ timeout: 10_000 });

  const row = page.locator('tr', { hasText: 'سارا طراح' });
  await expect(row).toBeVisible();
  await expect(row.locator('.badge', { hasText: 'دعوت‌شده' })).toBeVisible();
  await expect(row.locator('.badge', { hasText: 'طراح' })).toBeVisible();
});

test('an administrator changes a role, cannot disable themselves, and is told why the last administrator cannot step down', async ({
  page,
}) => {
  await signIn(page, ADMIN);
  await page.goto('/en/desk/users');

  // Change the invited designer's roles: Designer -> Developer.
  const row = page.locator('tr', { hasText: 'سارا طراح' });
  await row.getByRole('button', { name: 'Edit roles' }).click();
  await row.locator('input[id$="-DEVELOPER"]').check();
  await row.locator('input[id$="-DESIGNER"]').uncheck();
  await row.getByRole('button', { name: 'Save roles' }).click();
  await expect(row.locator('.badge', { hasText: 'Developer' })).toBeVisible();
  await expect(row.locator('.badge', { hasText: 'Designer' })).toHaveCount(0);

  // An empty set is refused in words.
  await row.getByRole('button', { name: 'Edit roles' }).click();
  await row.locator('input[id$="-DEVELOPER"]').uncheck();
  await row.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.locator('.error')).toContainText('at least one role');
  await row.getByRole('button', { name: 'Cancel' }).click();

  // The administrator's own row: no Disable button, and the only administrator cannot drop ADMIN.
  const own = page.locator('tr', { has: page.locator('.people-you') });
  await expect(own.getByRole('button', { name: 'Disable' })).toHaveCount(0);
  await own.getByRole('button', { name: 'Edit roles' }).click();
  await own.locator('input[id$="-ADMIN"]').uncheck();
  await own.locator('input[id$="-SALES"]').check();
  await own.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.locator('.error')).toContainText('last active administrator');
});
