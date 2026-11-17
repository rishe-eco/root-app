import { test, expect, type Page } from '@playwright/test';
import { SALES, expectSaved, fillTitle, resetTestDatabase, signIn } from './helpers';

/**
 * DX3b — the new-contract form (desk UX review 1 and 2): the reference comes
 * prefilled and the server numbers the contract; "New customer" makes the
 * customer without leaving the form, keeps what was typed, shows a link to
 * copy and selects the customer. Then the contract is created.
 *
 * Both languages, at 360 px and 180 px. Every measurement waits for
 * `document.fonts.ready` (brief-common, Tests).
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

/** The controls inside `scope` that stick out of the viewport. */
async function expectFits(page: Page, scope: string) {
  await page.locator(scope).first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate((sel) => {
    const root = document.querySelector<HTMLElement>(sel);
    const w = document.documentElement.clientWidth;
    const stuck: string[] = [];
    root?.querySelectorAll<HTMLElement>('input, select, textarea, button, a.btn').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      if (r.left < -1 || r.right > w + 1) stuck.push(`${el.tagName.toLowerCase()} ${el.getAttribute('data-testid') ?? el.id} [${Math.round(r.left)}..${Math.round(r.right)}] of ${w}`);
    });
    const rect = root?.getBoundingClientRect();
    const out = !root || !rect || rect.left < -1 || rect.right > w + 1 || root.scrollWidth > root.clientWidth + 1;
    return { stuck, out, detail: root ? `scrollWidth ${root.scrollWidth} clientWidth ${root.clientWidth} of ${w}` : 'no column' };
  }, scope);
  expect(result.stuck, `controls outside ${scope} at ${page.viewportSize()?.width}px`).toEqual([]);
  expect(result.out, `${scope} overflows at ${page.viewportSize()?.width}px: ${result.detail}`).toBe(false);
}

const CASES = [
  { lang: 'en', width: 360, phone: '09121110001' },
  { lang: 'fa', width: 360, phone: '09121110002' },
  { lang: 'en', width: 180, phone: '09121110003' },
  { lang: 'fa', width: 180, phone: '09121110004' },
] as const;

for (const { lang, width, phone } of CASES) {
  test(`the ref is prefilled, a new customer is made in place and the contract created — ${lang}, ${width} px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, SALES, lang);
    await page.goto(`/${lang}/desk/contracts`);
    await page.locator('.workspace-row button.btn-primary').first().click();

    // The reference: numbered, shown, editable.
    const refInput = page.locator('#nc-ref');
    await expect(refInput).toHaveValue(/^R-\d{4}-\d{3,}$/);
    const prefilled = await refInput.inputValue();
    await expect(refInput).toBeEditable();

    // Typed before the customer exists: all of it must survive the dialog.
    const titleFa = `قرارداد ${lang}${width}`;
    const titleEn = `Contract ${lang}${width}`;
    await fillTitle(page, 'nc', 'nc-title', titleFa, titleEn);
    await expectFits(page, '.desk-section > section.card');

    await page.getByTestId('new-customer').click();
    const modal = page.getByTestId('new-customer-modal');
    await expect(modal).toBeVisible();
    await expectFits(page, '[data-testid="new-customer-modal"]');

    // A phone that is no phone is a sentence in this language, and the dialog stays.
    await modal.locator('#nu-name').fill('Test Customer');
    await modal.locator('#nu-phone').fill('123');
    await modal.getByTestId('new-customer-submit').click();
    await expect(page.getByTestId('new-customer-error')).toHaveText(lang === 'en' ? /doesn.t look like a phone number/ : /شماره/);

    await modal.locator('#nu-phone').fill(phone);
    await modal.locator('#nu-client').fill(`Client ${lang}${width}`);
    await modal.locator('#nu-email').fill(`new${lang}${width}@example.com`);
    await modal.getByTestId('new-customer-submit').click();

    // The link to copy, and what else went out.
    await expect(page.getByTestId('new-customer-done')).toBeVisible();
    await expect(page.getByTestId('invite-link-url')).toContainText('/portal/invite/');
    await expect(page.getByTestId('invite-link-copy')).toBeVisible();
    await expect(page.getByTestId('new-customer-sent')).toContainText(`new${lang}${width}@example.com`);
    await expectFits(page, '[data-testid="new-customer-modal"]');
    await page.getByTestId('new-customer-close').click();
    await expect(modal).toHaveCount(0);

    // The form is as it was, with the new customer selected.
    await expect(page.locator('#nc-fa')).toHaveValue(titleFa);
    await expect(page.locator('#nc-en')).toHaveValue(titleEn);
    await expect(refInput).toHaveValue(prefilled);
    await expect(page.locator('#nc-customer option:checked')).toHaveText(`Client ${lang}${width}`);

    // Created with the number the form showed (nothing was typed, so the server numbered it).
    await page.locator('form.auth-form button[type="submit"]').click();
    await page.waitForURL(/\/desk\/contracts\/[^/]+\/(contract|steps)$/);
    await expect(page.getByText(prefilled, { exact: true }).first()).toBeVisible();
  });
}

test('the reference can be changed on the Contract tab until the contract is signed', async ({ page }) => {
  await signIn(page, SALES, 'en');
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow').first().locator('td').first().click();
  await page.waitForURL(/\/desk\/contracts\/[^/]+\/(contract|steps)$/);
  await page.getByRole('link', { name: 'Contract', exact: true }).click();
  const input = page.locator('#ct-ref');
  await expect(input).toBeEditable();
  // DX4: the reference saves when the field is left, with the "Saved" mark and no button.
  await expect(page.getByTestId('ref-save')).toHaveCount(0);
  await input.fill('RC-2026-777');
  await input.blur();
  await expectSaved(page, 'ref-autosave');
  await input.fill('has space');
  await input.blur();
  await expect(page.getByTestId('ref-autosave-error')).toContainText('Latin letters');
});
