import { test, expect, type Page } from '@playwright/test';
import { ADMIN, CUSTOMER, REVIEWER, SALES, DESIGNER, DEVELOPER, CONTRACT_REF, resetTestDatabase, signIn } from './helpers';

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

  // Journeys build plan J1: phone is now the required identifier on this
  // form, email optional — a minimal touch to this otherwise-untouched spec
  // so it keeps passing against Customers.tsx's new required field.
  await page.locator('#i-phone').fill(`+9891${String(stamp).slice(-8)}`);
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

/**
 * Journeys build plan S1's own acceptance criterion, in both languages —
 * the plan says so explicitly, because the desk's Persian nav is a second,
 * independent read of `desk/sections.ts` through `i18next`, not a mirror
 * that could silently drift from the English one.
 */
const NAV_LABELS = {
  en: {
    overview: 'Overview',
    contracts: 'Contracts',
    customers: 'Customers',
    library: 'Library',
    review: 'Review',
    builds: 'Builds',
    tickets: 'Tickets',
    billing: 'Billing',
    services: 'Services',
    templates: 'Templates',
    apiTokens: 'Tokens',
  },
  fa: {
    overview: 'نمای کلی',
    contracts: 'قراردادها',
    customers: 'مشتریان',
    library: 'کتابخانه',
    review: 'بازبینی',
    builds: 'بیلدها',
    tickets: 'تیکت‌ها',
    billing: 'صورت‌حساب',
    services: 'خدمات',
    templates: 'قالب‌ها',
    apiTokens: 'توکن‌ها',
  },
} as const;

/** Checks the nav actually rendered in `lang` — never the other language's
 *  labels, which are simply absent from an `lang` page and would otherwise
 *  pass `toHaveCount(0)` for the wrong reason. */
async function assertNavShowsExactly(
  page: Page,
  lang: 'en' | 'fa',
  visible: Array<keyof (typeof NAV_LABELS)['en']>,
) {
  const nav = page.locator('.desk-nav');
  const labels = NAV_LABELS[lang];
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    const locator = nav.getByText(labels[key], { exact: true });
    if (visible.includes(key)) {
      await expect(locator).toBeVisible();
    } else {
      await expect(locator).toHaveCount(0);
    }
  }
}

test('a sales user sees Overview, Contracts, Customers, Tickets, Billing, Services and Templates — in both languages', async ({
  page,
}) => {
  const sections = ['overview', 'contracts', 'customers', 'tickets', 'billing', 'services', 'templates'] as const;
  await signIn(page, SALES, 'en');
  await assertNavShowsExactly(page, 'en', sections);
  await signIn(page, SALES, 'fa');
  await assertNavShowsExactly(page, 'fa', sections);
});

// Templates (T1) is the designer's second row: `templates.types` opens it.
test('a designer sees only Overview, Contracts and Templates — in both languages', async ({ page }) => {
  await signIn(page, DESIGNER, 'en');
  await assertNavShowsExactly(page, 'en', ['overview', 'contracts', 'templates']);
  await signIn(page, DESIGNER, 'fa');
  await assertNavShowsExactly(page, 'fa', ['overview', 'contracts', 'templates']);
});

test('a developer sees Overview, Contracts and Builds — in both languages (D-2 closed: a developer can open a demo)', async ({
  page,
}) => {
  await signIn(page, DEVELOPER, 'en');
  await assertNavShowsExactly(page, 'en', ['overview', 'contracts', 'builds']);
  await signIn(page, DEVELOPER, 'fa');
  await assertNavShowsExactly(page, 'fa', ['overview', 'contracts', 'builds']);
});

test('the seeded designer opens the seeded contract and sees no fee', async ({ page }) => {
  await signIn(page, DESIGNER);
  await page.goto('/en/desk/contracts');
  // The ref cell, not the row's centre: for sales the centre is the status
  // select, whose cell rightly keeps the click from opening the contract.
  await page.locator('tr.crow', { hasText: CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/contract$/);

  // money.read is SALES/ADMIN only (PD-14) — a designer reading their own
  // assigned contract must see a neutral placeholder, never "0" or a blank
  // standing in for the real figure.
  await expect(page.getByText('Not shown')).toBeVisible();
  await expect(page.getByText('180,000,000')).toHaveCount(0);

  // Read-only: the tab shows the published articles but no author controls.
  await expect(page.getByRole('button', { name: 'Add article' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Publish revision' })).toHaveCount(0);
});

test('sales assigns and then changes the contract designer through the workspace header', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/contracts');
  // The ref cell, not the row's centre: for sales the centre is the status
  // select, whose cell rightly keeps the click from opening the contract.
  await page.locator('tr.crow', { hasText: CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/contract$/);

  // The seed assigns both designer@ and developer@ to this contract.
  await expect(page.getByText('Designer: Designer')).toBeVisible();

  await page.getByRole('button', { name: 'Change' }).click();
  const selects = page.locator('form.workspace-row select');
  await selects.first().selectOption({ label: 'Root' });
  await page.locator('form.workspace-row').getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('Designer: Root')).toBeVisible();
  // Changing the designer did not touch the developer side.
  await expect(page.getByText('Developer: Developer')).toBeVisible();
});
