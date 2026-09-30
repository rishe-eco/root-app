import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  SALES,
  WIZARD_CONTRACT_TITLE,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * J7 — step 3, approve and sign, in both languages (journeys build plan §5
 * "J7"). A new-road contract is taken through steps 1 and 2 over the API (those
 * are `17-requirements` and `18-scope-draft`'s stories); the customer then reads
 * the agreement as one document — the brief, the phases and dates, the payment
 * schedule under Article 5, Appendix 1 grouped by kind — approves it, sees steps
 * 1 to 3 locked with the date, and signs.
 *
 * Two tests, one per language, each on a fresh database because a signature is
 * terminal. The Persian one is the product; the English one is its translation —
 * both assert on the same testids, so a missing key (rendered as the key itself)
 * or a mirrored-wrong layout fails one and not the other.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';

test.beforeEach(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await completeStepTwoViaApi(request, contractId);
});

const TITLE: Record<'en' | 'fa', string> = { en: WIZARD_CONTRACT_TITLE, fa: 'فروشگاه آنلاین نهال' };

/** The customer's wizard for the seeded contract, opened on the agreement. */
async function openAgreement(page: Page, lang: 'en' | 'fa') {
  await signIn(page, CUSTOMER, lang);
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: TITLE[lang] }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
  // The road is at the agreement: steps 1 and 2 are done, the draft is published.
  await expect(page.locator('.stepper-item[data-step="AGREEMENT"]')).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.getByTestId('agreement-panel')).toBeVisible();
}

/** The whole story in one language: read, approve, see the locks, sign. */
async function approveAndSign(page: Page, lang: 'en' | 'fa') {
  await openAgreement(page, lang);
  const panel = page.getByTestId('agreement-panel');
  await expect(panel).toHaveAttribute('data-state', 'open');
  await expect(page.locator('html')).toHaveAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');

  // --- the agreement is a document, rendered from the snapshot --------------------
  await expect(panel.getByTestId('agreement-brief')).toBeVisible();
  await expect(panel.getByTestId('agreement-phases')).toBeVisible();
  // The payment schedule sits under Article 5's title — rows, total, the money in
  // the locale's digits — and the article carries no body of its own.
  const article5 = panel.locator('[data-article="5"]');
  await expect(article5.getByTestId('agreement-plan')).toBeVisible();
  await expect(article5.getByTestId('article-body')).toHaveCount(0);
  const total = lang === 'fa' ? '۱۵۰٬۰۰۰٬۰۰۰' : '150,000,000';
  await expect(article5.getByTestId('agreement-plan')).toContainText(total);
  // The budget is the customer's own statement: they sign it, so they read it.
  await expect(panel.getByTestId('agreement-brief')).toContainText(lang === 'fa' ? '۱۵۰٬۰۰۰٬۰۰۰' : '150,000,000');
  await expect(panel.getByTestId('agreement-brief')).not.toContainText(lang === 'fa' ? 'برای شما نمایش داده نمی‌شود' : 'Not shown to you');
  // Appendix 1, grouped by kind.
  const appendix = panel.getByTestId('agreement-appendix');
  await expect(appendix.locator('[data-kind="PAGE"]')).toBeVisible();
  await expect(appendix.locator('[data-kind="FEATURE"]')).toBeVisible();
  await expect(appendix.locator('[data-kind="DELIVERABLE"]')).toBeVisible();
  // Nothing rendered as its own key.
  expect(await panel.innerText()).not.toMatch(/\b(agreement|brief|print)\.[A-Za-z_.]+/);

  // The status area: not approved yet.
  await expect(page.locator('[data-fact="agreement"]')).toHaveAttribute('data-state', 'open');

  // --- approve: steps 1–3 lock, with the date ------------------------------------
  await expect(page.getByTestId('agreement-sign')).toHaveCount(0);
  await page.getByTestId('agreement-approve').click();
  await expect(panel).toHaveAttribute('data-state', 'approved');
  await expect(page.getByTestId('agreement-approved')).toBeVisible();
  await expect(page.locator('[data-fact="agreement"]')).toHaveAttribute('data-state', 'approved');
  // Locked, but not done: the agreement is still the customer's until they sign.
  await expect(page.locator('.stepper-item[data-step="AGREEMENT"]')).toHaveAttribute('data-status', 'CURRENT');
  for (const step of ['REQUIREMENTS', 'SCOPE', 'DRAFT'] as const) {
    await expect(page.locator(`.stepper-item[data-step="${step}"]`)).toHaveAttribute('data-status', 'DONE');
  }

  // A locked step renders read-only with its "locked on ⟨date⟩" line.
  await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
  const requirements = page.locator('[data-testid="step-panel"][data-step="REQUIREMENTS"]');
  await expect(requirements.locator('.locknote')).toContainText(lang === 'fa' ? 'قفل شد' : 'Locked on');
  await expect(requirements.locator('.locknote')).not.toContainText('NaN');
  await expect(requirements.getByRole('button', { name: lang === 'fa' ? 'افزودنِ نظر' : 'Add feedback' })).toHaveCount(0);

  // --- sign -----------------------------------------------------------------------
  await page.locator('.stepper-item[data-step="AGREEMENT"] button').click();
  await expect(page.getByTestId('agreement-sign')).toBeDisabled();
  await page.locator('#agreement-signname').fill(lang === 'fa' ? 'نهال رضایی' : 'Nahal Rezaei');
  await page.getByTestId('agreement-sign').click();
  await expect(panel).toHaveAttribute('data-state', 'signed');
  await expect(page.getByTestId('agreement-signed')).toContainText(lang === 'fa' ? 'نهال رضایی' : 'Nahal Rezaei');
  await expect(page.locator('[data-fact="agreement"]')).toHaveAttribute('data-state', 'signed');
  // Signed: the agreement is done and the road moves on to the design.
  await expect(page.locator('.stepper-item[data-step="AGREEMENT"]')).toHaveAttribute('data-status', 'DONE');
  await expect(page.locator('.stepper-item[data-step="DESIGN"]')).toHaveAttribute('data-status', 'CURRENT');
}

test('the customer reads, approves and signs the agreement, in English — steps 1 to 3 lock on approval', async ({ page }) => {
  test.setTimeout(180_000);
  await approveAndSign(page, 'en');

  // The printable view renders the same snapshot: the plan under Article 5 and
  // the signature block.
  await page.getByRole('link', { name: 'Open the printable version' }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+\/print$/);
  await expect(page.locator('[data-article="5"]').getByTestId('agreement-plan')).toContainText('150,000,000');
  await expect(page.locator('.doc-signature')).toContainText('Nahal Rezaei');

  // Sales sees the draft locked in the desk: the date is there and the forms are off.
  await signIn(page, SALES, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/contract`);
  await expect(page.getByTestId('contract-locked-note')).toContainText('Locked on');
  await expect(page.getByRole('button', { name: 'Publish revision' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add article' })).toBeDisabled();
});

test('the same, in Persian: right-to-left, translated, and locked', async ({ page }) => {
  test.setTimeout(180_000);
  await approveAndSign(page, 'fa');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  // The approved line and the signature state are in Persian, not English.
  await expect(page.locator('[data-fact="agreement"]')).toContainText('امضا شد');
});
