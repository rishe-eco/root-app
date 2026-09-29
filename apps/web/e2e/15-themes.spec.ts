import { test, expect } from '@playwright/test';
import { DESIGNER, SALES, resetTestDatabase, signIn } from './helpers';

/**
 * T2's acceptance test, in Persian — the product is the Persian side: a
 * designer adds a theme to the catalogue with a preview, is told in Persian
 * when the demo link is not https, and assigns the theme to a site type. Sales
 * then reads the catalogue and cannot edit it.
 *
 * Selectors that would repeat a Persian string (with its ZWNJs and ezafe
 * marks) use the ids and structure the screens expose instead; the Persian
 * text asserted is what a person reads, spelled as `fa.json` spells it.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

/** A real 1×1 PNG, so the browser can decode what the private route serves —
 *  `helpers.ts`'s PNG is only the magic bytes, enough to pass the sniff and not
 *  enough to be an image. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const NAME = 'آسترا';
const DEMO = 'https://demo.example.com/astra';

test('a designer adds a theme, uploads its preview and assigns it to a type', async ({ page }) => {
  await signIn(page, DESIGNER, 'fa');
  await page.goto('/fa/desk/templates/themes');
  await expect(page.locator('.workspace-tab-active')).toHaveText('پوسته‌ها');
  await expect(page.locator('.editor-card[data-theme-name]')).toHaveCount(0);

  await page.locator('#th-new-name').fill(NAME);
  await page.locator('#th-new-vendor').fill('استودیوی نمونه');
  // An http link is refused in Persian, and nothing is added.
  await page.locator('#th-new-demo').fill('http://demo.example.com/astra');
  const add = page.locator('form').filter({ has: page.locator('#th-new-name') }).locator('button[type="submit"]');
  await add.click();
  await expect(page.locator('.error')).toContainText('نشانیِ امن');
  await expect(page.locator('.editor-card[data-theme-name]')).toHaveCount(0);

  await page.locator('#th-new-demo').fill(DEMO);
  await page.locator('#th-new-rtl').selectOption('FULL');
  // Persian digits are typed; the API takes Latin ones and the screen converts.
  await page.locator('#th-new-cost').fill('۴۵۰۰۰۰۰');
  await page.locator('#th-new-nfa').fill('پشتیبانی کاملِ راست‌به‌چپ دارد.');
  await add.click();

  const card = page.locator(`.editor-card[data-theme-name="${NAME}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('.badge')).toHaveText('فعال');
  await expect(card.locator('#th-new-name')).toHaveCount(0);
  await expect(page.locator('#th-new-name')).toHaveValue('', 'the form is cleared after a successful add');
  await expect(card.locator('select')).toHaveValue('FULL');
  await expect(card.locator('input[inputmode="numeric"]')).toHaveValue('4500000');

  // The demo link opens in a new tab and is never framed.
  const link = card.locator('a[href="' + DEMO + '"]');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('iframe')).toHaveCount(0);

  // The preview: uploaded through the private route, and served back to the
  // designer's own session.
  await card.locator('[data-testid="theme-preview-input"]').setInputFiles({
    name: 'astra.png',
    mimeType: 'image/png',
    buffer: PIXEL,
  });
  const img = card.locator('.theme-preview img');
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute('src', /^\/files\//);
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Assign it to the Store type ("فروشگاهی" in the seed).
  const panel = page.locator('[data-testid="theme-assign"]');
  await panel.locator('#th-assign-type').selectOption({ label: 'فروشگاهی' });
  const save = panel.locator('button.btn-primary');
  await expect(save).toBeDisabled();
  await panel.locator(`.theme-check[data-theme-name="${NAME}"] input`).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect(card).toContainText('فروشگاهی');

  // Another type is untouched, and the assignment survives a reload.
  await page.reload();
  await page.locator('#th-assign-type').selectOption({ label: 'فروشگاهی' });
  await expect(page.locator(`.theme-check[data-theme-name="${NAME}"] input`)).toBeChecked();
  await page.locator('#th-assign-type').selectOption({ label: 'وبلاگ' });
  await expect(page.locator(`.theme-check[data-theme-name="${NAME}"] input`)).not.toBeChecked();

  // Deactivating keeps the card, set aside, and its assignment.
  await page.locator(`.editor-card[data-theme-name="${NAME}"] button.btn-ghost`).click();
  await expect(page.locator(`.editor-card[data-theme-name="${NAME}"] .badge`)).toHaveText('غیرفعال');
  await expect(page.locator(`.editor-card[data-theme-name="${NAME}"]`)).toContainText('فروشگاهی');
});

test('sales reads the catalogue — cost in Persian digits — and cannot edit it', async ({ page }) => {
  await signIn(page, SALES, 'fa');
  await page.goto('/fa/desk/templates/themes');

  const card = page.locator(`.editor-card[data-theme-name="${NAME}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('۴٬۵۰۰٬۰۰۰');
  await expect(card).toContainText('تومان');
  await expect(card.locator('.theme-preview img')).toBeVisible();
  await expect(card.locator(`a[href="${DEMO}"]`)).toHaveAttribute('target', '_blank');

  // No form, no controls: the new-theme form, the assignment panel and every
  // card's inputs and buttons are gone.
  await expect(page.locator('#th-new-name')).toHaveCount(0);
  await expect(page.locator('[data-testid="theme-assign"]')).toHaveCount(0);
  await expect(page.locator('.editor-card input')).toHaveCount(0);
  await expect(page.locator('.editor-card button')).toHaveCount(0);
});
