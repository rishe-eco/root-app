import { test, expect, type Page } from '@playwright/test';
import { SALES, apiSignIn, completeStepOneViaApi, gql, resetTestDatabase, signIn } from './helpers';

/**
 * DX3c — duplicate a contract (desk UX review 30): the Duplicate button in the
 * workspace header opens a dialog with the customer picker (the same customer
 * by default) and both titles prefilled "Copy of …"; choosing another customer
 * and confirming opens the new contract's Steps tab, for that customer, with the
 * title typed. Both languages, 360 px and 180 px; each control is measured
 * against the viewport after `document.fonts.ready`.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await apiSignIn(request, SALES);
  await gql(request, 'mutation{ inviteCustomer(phone: "09120000888", name: "Dina Other", clientName: "Dina Co") { userId } }');
});

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
  test(`Duplicate from the workspace, to another customer, lands on the new contract's Steps — ${lang}, ${width} px`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, SALES, lang);
    await page.goto(`/${lang}/desk/contracts/${contractId}/steps`);
    await expect(page.getByTestId('contract-customer')).toBeVisible();
    await expectFits(page, '.workspace-head');

    await page.getByTestId('duplicate-contract').click();
    const modal = page.getByTestId('duplicate-modal');
    await expect(modal).toBeVisible();
    // Same customer by default; both titles prefilled with the "copy" prefix.
    await expect(modal.locator('#dc-customer option:checked')).toHaveText('استودیو نهال · نهال رضایی');
    await expect(modal.locator('#dc-en')).toHaveValue(/^Copy of /);
    await expect(modal.locator('#dc-fa')).toHaveValue(/^رونوشتِ /);
    await expectFits(page, '[data-testid="duplicate-modal"]');

    const title = `Copied ${lang}${width}`;
    await modal.locator('#dc-en').fill(title);
    await modal.locator('#dc-customer').selectOption({ label: 'Dina Co · Dina Other' });
    await modal.getByTestId('duplicate-submit').click();

    await page.waitForURL(new RegExp(`/${lang}/desk/contracts/(?!${contractId})[^/]+/steps$`));
    if (lang === 'en') await expect(page.locator('.workspace-head h2')).toHaveText(title);
    await expect(page.getByTestId('contract-customer')).toContainText('Dina Co');
    await expect(page.getByTestId('duplicate-modal')).toHaveCount(0);
  });
}

test('Escape and Cancel close the dialog without creating anything', async ({ page }) => {
  await signIn(page, SALES, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await page.getByTestId('duplicate-contract').click();
  await expect(page.getByTestId('duplicate-modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('duplicate-modal')).toHaveCount(0);
  await page.getByTestId('duplicate-contract').click();
  await page.getByTestId('duplicate-modal').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('duplicate-modal')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/desk/contracts/${contractId}/steps$`));
});
