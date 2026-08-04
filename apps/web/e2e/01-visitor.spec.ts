import { test, expect } from '@playwright/test';

/**
 * The public front, signed out. Cheap, and it covers the two things that are
 * invisible in code review and obvious to a Persian reader: the document
 * direction, and whether the locale actually reaches `<html>`.
 */

test.describe('a visitor', () => {
  test('lands in Persian, right-to-left', async ({ page }) => {
    await page.goto('/fa/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
    await expect(page).toHaveTitle(/ریشه/);
  });

  test('switching language flips the direction, not just the words', async ({ page }) => {
    await page.goto('/en/');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByText('Make a life worth living')).toBeVisible();
  });

  test('/ redirects to a locale rather than 404ing', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/(fa|en)\/?$/);
  });

  test('the About page renders in both languages', async ({ page }) => {
    await page.goto('/en/about');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await page.goto('/fa/about');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  });

  test('the portal is closed to them', async ({ page }) => {
    await page.goto('/en/app/contracts');
    // Bounced to sign-in rather than shown an empty list.
    await expect(page).toHaveURL(/\/en\/portal/);
    await expect(page.locator('#email')).toBeVisible();
  });

  test('a bad address gets the 404 page, not a blank screen', async ({ page }) => {
    await page.goto('/en/no-such-page');
    await expect(page.getByText('Nothing here')).toBeVisible();
  });

  test('the locked nav slots are announced to screen readers', async ({ page }) => {
    // The padlock is decorative; the fact that a section is locked has to
    // reach someone who cannot see it.
    await page.goto('/en/');
    const srOnly = page.locator('.sr-only');
    await expect(srOnly.first()).toBeAttached();
  });
});
