import { test, expect } from '@playwright/test';
import { DESIGNER, SALES, resetTestDatabase, signIn } from './helpers';

/**
 * T1's acceptance test, in Persian — the product is the Persian side: a
 * designer adds a site type, then sales sets what a contract of that type
 * starts with. Each half is read-only to the other role, and the refusal a
 * bad list earns is said in Persian, never as the API's English message.
 *
 * Selectors that would repeat a Persian string (with its ZWNJs and ezafe
 * marks) use the ids and structure the screens expose instead; the Persian
 * text asserted is what a person reads, spelled as `fa.json` spells it.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const TYPE_FA = 'گالری تصویر';
const TYPE_SLUG = 'photo-gallery';

test('a designer adds a type; the Scope tab is theirs to read and not to edit', async ({ page }) => {
  await signIn(page, DESIGNER, 'fa');
  await expect(page.locator('.desk-nav').getByText('قالب‌ها', { exact: true })).toBeVisible();

  // Holding only `templates.types`, the designer lands on Types.
  await page.goto('/fa/desk/templates');
  await expect(page).toHaveURL(/\/fa\/desk\/templates\/types$/);

  // The five seeded types are there before anything is added.
  await expect(page.locator('.editor-card[data-slug]')).toHaveCount(5);

  await page.locator('#tt-fa').fill(TYPE_FA);
  await page.locator('#tt-en').fill('Photo gallery');
  await page.locator('#tt-slug').fill(TYPE_SLUG);
  await page.locator('form').filter({ has: page.locator('#tt-slug') }).locator('button[type="submit"]').click();

  const card = page.locator(`.editor-card[data-slug="${TYPE_SLUG}"]`);
  await expect(card).toBeVisible();
  await expect(page.locator('.editor-card[data-slug]')).toHaveCount(6);
  await expect(card.locator('.badge')).toHaveText('فعال');

  // The same slug again is refused in Persian, not by a leaked constraint.
  await page.locator('#tt-fa').fill('دیگر');
  await page.locator('#tt-en').fill('Another');
  await page.locator('#tt-slug').fill(TYPE_SLUG);
  await page.locator('form').filter({ has: page.locator('#tt-slug') }).locator('button[type="submit"]').click();
  await expect(page.locator('.error')).toContainText('از پیش هست');
  await expect(page.locator('.editor-card[data-slug]')).toHaveCount(6);

  // The Scope tab: visible, read-only — no list to save, no item to add.
  await page.locator('.workspace-tab').filter({ hasText: 'دامنه' }).click();
  await expect(page).toHaveURL(/\/fa\/desk\/templates\/scope$/);
  await expect(page.locator('#ts-type')).toBeVisible();
  await expect(page.locator('.template-row')).toHaveCount(0);
  await expect(page.locator('.workspace-panel button.btn-primary')).toHaveCount(0);
  await expect(page.locator('.workspace-panel button.btn-secondary')).toHaveCount(0);
});

test('sales sets the new type\'s scope; a repeated key is refused in Persian and the list is kept', async ({ page }) => {
  await signIn(page, SALES, 'fa');

  // Holding only `templates.scope`, sales lands on Scope.
  await page.goto('/fa/desk/templates');
  await expect(page).toHaveURL(/\/fa\/desk\/templates\/scope$/);

  await page.locator('#ts-type').selectOption({ label: TYPE_FA });
  await expect(page.locator('.template-row')).toHaveCount(0);

  const add = page.locator('.workspace-panel button.btn-secondary');
  const save = page.locator('.workspace-panel button.btn-primary');
  await expect(save).toBeDisabled(); // nothing to save yet

  await add.click();
  const first = page.locator('.template-row').nth(0);
  await first.locator('input.num-latin').fill('gallery-page');
  await first.locator('select').selectOption('PAGE');
  await first.locator('input[dir="rtl"]').fill('صفحه‌ی گالری');
  await first.locator('input[dir="ltr"]:not(.num-latin)').fill('Gallery page');

  await add.click();
  const second = page.locator('.template-row').nth(1);
  await second.locator('input.num-latin').fill('lightbox');
  await second.locator('select').selectOption('FEATURE');
  await second.locator('input[dir="rtl"]').fill('نمایشِ بزرگ');
  await second.locator('input[dir="ltr"]:not(.num-latin)').fill('Lightbox');

  await expect(page.locator('.dirty-dot:not(.dirty-dot-clean)')).toBeVisible();

  // A third row that repeats the first key: refused with the code's Persian,
  // and nothing was written.
  await add.click();
  const third = page.locator('.template-row').nth(2);
  await third.locator('input.num-latin').fill('lightbox');
  await third.locator('input[dir="rtl"]').fill('تکراری');
  await third.locator('input[dir="ltr"]:not(.num-latin)').fill('Repeat');
  await save.click();
  await expect(page.locator('.error')).toContainText('کلیدِ یکسان');
  await expect(page.locator('.dirty-dot:not(.dirty-dot-clean)')).toBeVisible();

  // Remove it and save for real.
  await third.getByRole('button').last().click();
  await expect(page.locator('.template-row')).toHaveCount(2);
  await save.click();
  await expect(page.locator('.dirty-dot-clean')).toBeVisible();

  // It is persisted: a fresh page load, the type picked again, the same list.
  await page.reload();
  await page.locator('#ts-type').selectOption({ label: TYPE_FA });
  await expect(page.locator('.template-row')).toHaveCount(2);
  await expect(page.locator('.template-row').nth(0).locator('input.num-latin')).toHaveValue('gallery-page');
  await expect(page.locator('.template-row').nth(1).locator('input.num-latin')).toHaveValue('lightbox');
  await expect(page.locator('.template-row').nth(0).locator('select')).toHaveValue('PAGE');
});

test('sales reads the types and cannot edit them', async ({ page }) => {
  await signIn(page, SALES, 'fa');
  await page.goto('/fa/desk/templates/types');

  await expect(page.locator(`.editor-card[data-slug="${TYPE_SLUG}"]`)).toBeVisible();
  await expect(page.locator('.editor-card[data-slug]')).toHaveCount(6);
  // No form, no controls: the new-type form and every card's inputs are gone.
  await expect(page.locator('#tt-slug')).toHaveCount(0);
  await expect(page.locator('.editor-card input')).toHaveCount(0);
  await expect(page.locator('.editor-card button')).toHaveCount(0);
});
