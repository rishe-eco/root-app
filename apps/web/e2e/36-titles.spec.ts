import { test, expect, type Page } from '@playwright/test';
import { SALES, expectSaved, resetTestDatabase, signIn } from './helpers';

/**
 * DX4 — one title field, and fields that save when you leave them (desk UX
 * review 26 and 27).
 *
 * A contract is made from a title typed in one language (Persian), and the
 * English panel shows that title as the fallback, plainly. "Add the other
 * language" opens the second input. A field on the Contract tab saves when it is
 * left, with the small "Saved" mark and no Save button.
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
  { lang: 'en', width: 360 },
  { lang: 'fa', width: 360 },
  { lang: 'en', width: 180 },
  { lang: 'fa', width: 180 },
] as const;

for (const { lang, width } of CASES) {
  test(`a contract titled in Persian only reads in both panels; the other language is added; the Contract tab saves on blur — ${lang} at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, SALES, lang);
    await page.goto(`/${lang}/desk/contracts`);
    await page.locator('.workspace-row button.btn-primary').first().click();

    // One title field. A Persian title goes to the Persian column, whichever panel it is typed in.
    const persian = `قرارداد فقط فارسی ${lang}${width}`;
    await page.locator('#nc-customer').selectOption({ index: 1 });
    const one = page.locator('#nc-title');
    await expect(one).toBeVisible();
    await expect(page.locator('#nc-en')).toHaveCount(0);
    await one.fill(persian);
    await expectFits(page, '.desk-section > section.card');
    await page.locator('form.auth-form button[type="submit"]').click();
    await page.waitForURL(/\/desk\/contracts\/[^/]+\/(contract|steps)$/);

    // The fallback is plain: the English panel shows the Persian title, as the Persian panel does.
    const head = page.locator('.workspace-head h2');
    await expect(head).toHaveText(persian);

    // The Contract tab: the same one field, holding it. No Save button anywhere on the card.
    await page.goto(page.url().replace(/\/(steps|contract)$/, '/contract'));
    const title = page.locator('#ct-title');
    await expect(title).toHaveValue(persian);
    await expect(page.getByTestId('title-fee-save')).toHaveCount(0);
    await expect(page.locator('section.card').filter({ has: title }).getByRole('button', { name: /^(Save|ذخیره)$/ })).toHaveCount(0);

    // A field saves when it is left, and the polite status says so.
    const status = page.getByTestId('title-fee-autosave-status');
    await expect(status).toHaveText('');
    await page.locator('#ct-amount').fill('2500000');
    await page.locator('#ct-amount').blur();
    await expectSaved(page, 'title-fee-autosave');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await page.reload();
    await expect(page.locator('#ct-amount')).toHaveValue('2500000');
    await expect(title).toHaveValue(persian);

    // Add the other language: a second input for the other column; both columns now hold a title.
    await page.getByTestId('contract-title-add-other').click();
    await expect(page.locator('#ct-fa')).toHaveValue(persian);
    await expect(page.locator('#ct-en')).toHaveValue('');
    const english = `Persian-only contract ${lang}${width}`;
    await page.locator('#ct-en').fill(english);
    await page.locator('#ct-en').blur();
    await expectSaved(page, 'title-fee-autosave');
    await expect(head).toHaveText(lang === 'en' ? english : persian);
    await expectFits(page, 'section.card');

    // A reload shows both (a row with both languages opens with both), and the amount is untouched by the title's save.
    await page.reload();
    await expect(page.locator('#ct-fa')).toHaveValue(persian);
    await expect(page.locator('#ct-en')).toHaveValue(english);
    await expect(page.locator('#ct-amount')).toHaveValue('2500000');

    // Clearing one language is saved (the other still names the contract); clearing the last is not: a title needs one
    // language, so nothing is sent and the saved one stays.
    await page.locator('#ct-fa').fill('');
    await page.locator('#ct-en').fill('');
    await page.locator('#ct-en').blur();
    await page.reload();
    await expect(page.locator('#ct-title')).toHaveValue(english);
    await expect(page.locator('#ct-fa')).toHaveCount(0);
  });
}
