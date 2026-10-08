import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  WIZARD_CONTRACT_REF,
  apiSignIn,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * wp-design-review.md Phase H2 — what the design review found, held in a browser:
 * the portal on a phone (a bottom tab bar whose items have names, one h1, no
 * sideways scroll, 44px targets), the public nav as a disclosure on a phone and
 * unchanged on a desktop, the Library's labelled search and its two empty states,
 * and the dark appearance (with paper staying light).
 *
 * Read-only against the seeded data — nothing here mutates, so the database is
 * reset once.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const PHONE = { width: 390, height: 844 };

async function noSidewaysScroll(page: Page) {
  const [scrollWidth, innerWidth] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollWidth, 'the page must not scroll sideways').toBeLessThanOrEqual(innerWidth);
}

test.describe('the portal on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  for (const lang of ['fa', 'en'] as const) {
    test(`${lang}: the rail is a named tab bar at the bottom; one h1; no sideways scroll; 44px actions`, async ({ page }) => {
      await signIn(page, CUSTOMER, lang);
      await page.goto(`/${lang}/app`);
      await expect(page.getByTestId('dashboard')).toBeVisible();

      const nav = page.locator('.side-nav');
      await expect(nav).toBeVisible();
      const box = (await nav.boundingBox())!;
      expect(box.y + box.height, 'the tab bar sits at the bottom of the viewport').toBeGreaterThan(PHONE.height - 16);
      expect(box.y + box.height).toBeLessThanOrEqual(PHONE.height + 1);

      const links = page.locator('.side-nav a');
      const count = await links.count();
      expect(count).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < count; i++) {
        await expect(links.nth(i)).toBeVisible();
        await expect(links.nth(i)).toHaveAccessibleName(/\S/);
        // The label is shown, not just announced.
        await expect(links.nth(i).locator('.side-label')).toBeVisible();
      }
      await expect(page.getByRole('navigation').getByRole('link').first()).toHaveAccessibleName(/\S/);

      await expect(page.locator('h1')).toHaveCount(1);
      await noSidewaysScroll(page);

      const newRequest = page.getByTestId('home-actions').getByRole('button').first();
      expect((await newRequest.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    });
  }

  test('contracts, invoices and support: one h1 and no sideways scroll', async ({ page }) => {
    await signIn(page, CUSTOMER, 'en');
    for (const path of ['/en/app/contracts', '/en/app/invoices', '/en/app/support']) {
      await page.goto(path);
      await expect(page.locator('.content h1')).toHaveCount(1);
      await expect(page.locator('h1')).toHaveCount(1);
      await noSidewaysScroll(page);
    }
  });
});

test.describe('the public nav on a phone', () => {
  test.use({ viewport: PHONE, hasTouch: true });

  for (const lang of ['fa', 'en'] as const) {
    test(`${lang}: closed by default; the button opens it; Escape closes it and returns focus`, async ({ page }) => {
      await page.goto(`/${lang}`);
      const toggle = page.locator('.menu-toggle');
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const about = page.locator('#site-menu').getByRole('link').first();
      await expect(about).toBeHidden();

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(about).toBeVisible();
      expect((await about.boundingBox())!.height).toBeGreaterThanOrEqual(44);

      await page.keyboard.press('Escape');
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await expect(about).toBeHidden();
      await expect(toggle).toBeFocused();
    });
  }

  test('choosing a link closes the menu', async ({ page }) => {
    await page.goto('/en');
    await page.locator('.menu-toggle').click();
    await page.locator('#site-menu').getByRole('link', { name: 'About us' }).click();
    await page.waitForURL(/\/en\/about$/);
    await expect(page.locator('.menu-toggle')).toHaveAttribute('aria-expanded', 'false');
  });

  for (const path of ['/fa', '/en', '/fa/about', '/fa/library', '/en/library/research']) {
    test(`${path}: no sideways scroll`, async ({ page }) => {
      await page.goto(path);
      await expect(page.locator('h1').first()).toBeVisible();
      await noSidewaysScroll(page);
    });
  }
});

test.describe('the public nav on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('no toggle; About, Library and Portal are in the bar', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('.menu-toggle')).toBeHidden();
    await expect(page.getByRole('link', { name: 'About us' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Library' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Portal' })).toBeVisible();
  });
});

test.describe('the Library', () => {
  test('the search is a labelled searchbox; an unmatched query says so and Clear search restores the list', async ({ page }) => {
    await page.goto('/en/library/research');
    const search = page.getByRole('searchbox', { name: 'Search the Library' });
    await expect(search).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Type' })).toBeVisible();

    // Nothing is published in the seed: the unfiltered list says "nothing yet", not "nothing matches".
    await expect(page.getByText('Nothing has been published here yet.')).toBeVisible();

    await search.fill('zzzz-no-such-entry');
    await expect(page.getByText('Nothing matches your search. Try fewer words, or clear the search.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByText('Nothing has been published here yet.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
  });
});

test.describe('the dark appearance', () => {
  test.use({ colorScheme: 'dark' });

  test('the public page and the portal take the dark ground', async ({ page }) => {
    await page.goto('/en');
    await expect(page.locator('.root-ui').first()).toHaveCSS('background-color', 'rgb(16, 25, 37)');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(16, 25, 37)');

    await signIn(page, CUSTOMER, 'en');
    await page.goto('/en/app');
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.locator('.root-ui').first()).toHaveCSS('background-color', 'rgb(16, 25, 37)');
  });

  test('a printed contract stays paper', async ({ page, request }) => {
    // Steps 1 and 2 take the new-road contract to a published draft — the first
    // state in which there is something to print. Last in the file, because it mutates.
    const contractId = await completeStepOneViaApi(request);
    await completeStepTwoViaApi(request, contractId);
    await apiSignIn(request, CUSTOMER);
    const { myContracts } = await gql<{ myContracts: Array<{ id: string; ref: string }> }>(request, '{ myContracts { id ref } }');
    expect(myContracts.some((c) => c.ref === WIZARD_CONTRACT_REF)).toBe(true);

    await signIn(page, CUSTOMER, 'en');
    await page.goto(`/en/app/contracts/${contractId}/print`);
    const sheet = page.locator('article.doc');
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(sheet).toHaveCSS('color', 'rgb(12, 21, 33)');
    // …while the page around it is the dark ground.
    await expect(page.locator('.root-ui').first()).toHaveCSS('background-color', 'rgb(16, 25, 37)');
  });
});
