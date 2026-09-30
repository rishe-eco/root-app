import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  DESIGNER,
  PIXEL,
  SALES,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  resetTestDatabase,
  seedThemesViaApi,
  signIn,
} from './helpers';

/**
 * J8 — step 4, the design, in both paths (journeys build plan §5 "T2 + J8").
 * The contract is taken through steps 1–3 over the API (`17`, `18` and `20` are
 * those stories) and the customer signs — which is what opens the design.
 *
 * **Pre-made:** the designer proposes two themes and publishes round 1; the
 * customer (in Persian) opens the gallery, sees each theme's preview, opens the
 * demo in a new tab (never framed), asks for other options; the designer
 * proposes a third and publishes round 2, which answers the request; the
 * customer chooses and approves. **Custom:** the designer uploads a wireframe for
 * one page and sets a colour and a typeface; the customer approves the page and
 * the design. The typeface specimen is set in Persian as well as Latin.
 *
 * Each test on a fresh database: an approved design is locked for good.
 */

test.describe.configure({ mode: 'serial' });

const TITLE_FA = 'فروشگاه آنلاین نهال';

let contractId = '';

async function openCustomerDesign(page: Page, lang: 'fa' | 'en' = 'fa') {
  await signIn(page, CUSTOMER, lang);
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: lang === 'fa' ? TITLE_FA : 'Nahal online shop' }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
  await expect(page.locator('.stepper-item[data-step="DESIGN"]')).toHaveAttribute('data-status', 'CURRENT');
  await page.locator('.stepper-item[data-step="DESIGN"] button').click();
  await expect(page.getByTestId('design-panel')).toBeVisible();
}

async function openDesignerDesign(page: Page, who = DESIGNER) {
  await signIn(page, who, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await page.locator('.stepper-item[data-step="DESIGN"] button').click();
  await expect(page.getByTestId('design-panel')).toBeVisible();
}

test.describe('pre-made', () => {
  test.beforeEach(async ({ request }) => {
    resetTestDatabase();
    contractId = await completeStepOneViaApi(request);
    await completeStepTwoViaApi(request, contractId);
    await approveAndSignViaApi(request, contractId);
    await seedThemesViaApi(request, ['Astra', 'Bravo', 'Cedar']);
  });

  test('the designer proposes two themes, the customer (Persian) asks for other options, round 2 answers, the customer chooses and approves', async ({ page }) => {
    test.setTimeout(240_000);

    // --- round 1: the designer proposes Astra and Bravo -------------------------------
    await openDesignerDesign(page);
    await expect(page.getByTestId('design-author-premade')).toBeVisible();
    await expect(page.getByTestId('design-round')).toContainText('No round yet');
    // Only the catalogue for this kind of site, active themes: all three are offered.
    await expect(page.getByTestId('theme-option')).toHaveCount(3);
    await page.locator('[data-testid="theme-option"][data-theme="Astra"] input').check();
    await page.locator('[data-testid="theme-option"][data-theme="Bravo"] input').check();
    await page.getByTestId('save-themes').click();
    await expect(page.getByTestId('publish-round')).toBeVisible();
    await page.getByTestId('publish-round').click();
    await expect(page.getByTestId('design-round')).toContainText('Round 1 of 2');
    await expect(page.getByTestId('theme-card')).toHaveCount(2);

    // --- the customer, in Persian ------------------------------------------------------
    await openCustomerDesign(page, 'fa');
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.getByTestId('design-round')).toContainText('دورِ ۱ از ۲');
    const cards = page.getByTestId('theme-card');
    await expect(cards).toHaveCount(2);
    // The preview is the contract's own copy, served to the customer.
    const image = cards.first().locator('img');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    // The demo opens in a new tab and is never framed; nothing in the page is an iframe.
    const demo = cards.first().getByTestId('theme-demo');
    await expect(demo).toHaveAttribute('target', '_blank');
    await expect(demo).toHaveAttribute('rel', /noopener/);
    await expect(demo).toHaveAttribute('rel', /noreferrer/);
    await expect(page.locator('iframe')).toHaveCount(0);
    // No licence cost anywhere on the page.
    expect(await page.getByTestId('design-panel').innerText()).not.toMatch(/4[,٬]?500[,٬]?000|۴٬?۵۰۰٬?۰۰۰/);
    // Nothing chosen: approving is off and says why.
    await expect(page.getByTestId('approve-design')).toBeDisabled();
    await expect(page.getByTestId('design-missing')).toContainText('اول یک پوسته انتخاب کن');

    // --- "show me other options" ----------------------------------------------------------
    await page.getByTestId('other-open').click();
    await page.getByTestId('other-note').fill('هیچ‌کدام به یک نانوایی نمی‌خورد.');
    await page.getByTestId('other-send').click();
    await expect(page.getByTestId('other-options-waiting')).toBeVisible();
    await expect(page.getByTestId('other-options-waiting')).toContainText('گزینه‌های دیگری خواسته‌ای');

    // --- round 2: the designer proposes Cedar instead ---------------------------------------
    await openDesignerDesign(page);
    await expect(page.getByTestId('design-allowance')).toContainText('1 of 2 rounds used');
    await page.locator('[data-testid="theme-option"][data-theme="Cedar"] input').check();
    await page.getByTestId('save-themes').click();
    await page.getByTestId('publish-round').click();
    await expect(page.getByTestId('design-round')).toContainText('Round 2 of 2');
    await expect(page.getByTestId('design-allowance')).toContainText('2 of 2 rounds used');
    // The allowance is spent: the desk says so, and sales is the one who can extend it.
    await expect(page.getByTestId('allowance-exhausted')).toBeVisible();

    // --- the customer: the request was answered by the round ---------------------------------
    await openCustomerDesign(page, 'fa');
    await expect(page.getByTestId('design-round')).toContainText('دورِ ۲ از ۲');
    await expect(page.getByTestId('theme-card')).toHaveCount(1);
    await expect(page.getByTestId('other-options-waiting')).toHaveCount(0);
    await expect(page.getByTestId('other-open')).toBeVisible();
    // The designer's answer sits in the thread, in Persian, naming the round.
    await expect(page.getByTestId('feedback-panel')).toContainText('دورِ ۲ با گزینه‌های تازه منتشر شد');

    await page.getByTestId('theme-choose').click();
    await expect(page.getByTestId('theme-chosen')).toBeVisible();
    await expect(page.getByTestId('approve-design')).toBeEnabled();
    await page.getByTestId('approve-design').click();
    await expect(page.getByTestId('design-approved')).toBeVisible();
    await expect(page.locator('.stepper-item[data-step="DESIGN"]')).toHaveAttribute('data-status', 'DONE');
    // A pre-made contract has no mockup step.
    await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).toHaveCount(0);
    // Locked: no choose, no approve, no other options.
    await expect(page.getByTestId('theme-choose')).toHaveCount(0);
    await expect(page.getByTestId('approve-design')).toHaveCount(0);

    // --- the designer finds the step locked --------------------------------------------------
    await openDesignerDesign(page);
    await expect(page.getByTestId('design-author-premade')).toHaveCount(0);
    await expect(page.locator('.locknote')).toBeVisible();
  });

  test('sales reads the design without authoring controls, and can extend the allowance', async ({ page }) => {
    test.setTimeout(120_000);
    await openDesignerDesign(page, SALES);
    await expect(page.getByTestId('design-read-only')).toBeVisible();
    await expect(page.getByTestId('design-author-premade')).toHaveCount(0);
    await expect(page.getByTestId('extend-open')).toBeVisible();
    await page.getByTestId('extend-open').click();
    await page.getByTestId('extend-extra').fill('1');
    await page.getByTestId('extend-reason').fill('The customer changed direction');
    await page.getByTestId('extend-submit').click();
    await expect(page.getByTestId('extension-list')).toContainText('+1 — The customer changed direction');
    await expect(page.getByTestId('design-allowance')).toContainText('0 of 3 rounds used');
  });
});

test.describe('custom', () => {
  test.beforeEach(async ({ request }) => {
    resetTestDatabase();
    contractId = await completeStepOneViaApi(request, undefined, { designTier: 'SENIOR_DESIGNER' });
    await completeStepTwoViaApi(request, contractId);
    await approveAndSignViaApi(request, contractId);
  });

  test('the designer uploads a wireframe and sets a palette; the customer approves the page and the design — the typeface is shown in Persian', async ({ page }) => {
    test.setTimeout(240_000);

    await openDesignerDesign(page);
    await expect(page.getByTestId('design-author-custom')).toBeVisible();
    // A custom contract has the mockup step on its road.
    await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).toHaveCount(1);
    await page.getByTestId('start-round').click();

    // A wireframe page — from this contract's own scope — with its image.
    await page.getByTestId('page-select').selectOption({ index: 1 });
    await page.getByTestId('add-page').click();
    const row = page.getByTestId('wireframe-row');
    await expect(row).toHaveCount(1);
    await row.getByTestId('image-input').setInputFiles({ name: 'home.png', mimeType: 'image/png', buffer: PIXEL });
    await expect(row.locator('.thumb img')).toBeVisible();

    // A colour and a typeface.
    await page.getByTestId('palette-kind').selectOption('COLOR');
    await page.getByTestId('palette-role').fill('primary');
    await page.getByTestId('palette-new-value').fill('#1F3A5C');
    await page.getByTestId('palette-label-fa').fill('رنگ اصلی');
    await page.getByTestId('palette-label-en').fill('Primary');
    await page.getByTestId('palette-add-submit').click();
    await expect(page.getByTestId('palette-row')).toHaveCount(1);
    // An invalid colour is refused in words.
    await page.getByTestId('palette-role').fill('accent');
    await page.getByTestId('palette-new-value').fill('blue');
    await page.getByTestId('palette-label-fa').fill('رنگ');
    await page.getByTestId('palette-label-en').fill('Accent');
    await page.getByTestId('palette-add-submit').click();
    await expect(page.getByTestId('palette-add').getByTestId('design-error')).toContainText('A colour is a hex');
    await page.getByTestId('palette-kind').selectOption('FONT');
    await page.getByTestId('palette-role').fill('heading');
    await page.getByTestId('palette-new-value').fill('Vazirmatn');
    await page.getByTestId('palette-label-fa').fill('قلم تیتر');
    await page.getByTestId('palette-label-en').fill('Headings');
    await page.getByTestId('palette-add-submit').click();
    await expect(page.getByTestId('palette-row')).toHaveCount(2);

    await page.getByTestId('publish-round').click();
    await expect(page.getByTestId('design-round')).toContainText('Round 1 of 2');

    // --- the customer ----------------------------------------------------------------------
    await openCustomerDesign(page, 'fa');
    await expect(page.getByTestId('design-round')).toContainText('دورِ ۱ از ۲');
    const pageCard = page.getByTestId('page-card');
    await expect(pageCard).toHaveCount(1);
    const wireframe = pageCard.locator('img');
    await expect.poll(() => wireframe.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    // The swatch shows the colour and its hex.
    const swatch = page.getByTestId('palette-swatch');
    await expect(swatch).toContainText('#1f3a5c');
    await expect(swatch.locator('.palette-chip')).toHaveCSS('background-color', 'rgb(31, 58, 92)');
    // The specimen is set in Persian AND Latin, the Persian line first, right-to-left.
    const lines = page.getByTestId('palette-specimen').locator('.palette-specimen-line');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toHaveAttribute('lang', 'fa');
    await expect(lines.nth(0)).toHaveAttribute('dir', 'rtl');
    await expect(lines.nth(0)).toContainText('گروهی از کارشناسان');
    await expect(lines.nth(1)).toHaveAttribute('lang', 'en');
    expect(await lines.nth(0).evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/Vazirmatn/);

    // Approving is off until the page is approved.
    await expect(page.getByTestId('approve-design')).toBeDisabled();
    await expect(page.getByTestId('design-missing')).toContainText('اول همه‌ی صفحه‌ها را تأیید کن');
    await pageCard.getByTestId('page-approve').click();
    await expect(pageCard).toHaveAttribute('data-approved', 'true');
    await expect(page.getByTestId('approve-design')).toBeEnabled();
    await page.getByTestId('approve-design').click();
    await expect(page.getByTestId('design-approved')).toBeVisible();
    await expect(page.locator('.stepper-item[data-step="DESIGN"]')).toHaveAttribute('data-status', 'DONE');
    await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).toHaveAttribute('data-status', 'CURRENT');
  });
});
