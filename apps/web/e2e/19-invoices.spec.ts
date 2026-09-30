import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER, SALES, WIZARD_CONTRACT_REF, insertSignedPaymentPlan, resetTestDatabase, signIn } from './helpers';

/**
 * J13 — invoices, driven the way each side drives them (journeys build plan
 * §5 "J13").
 *
 * One story, in order, because each part is the next one's precondition: sales
 * opens the desk's billing on a signed new-road contract and issues the plan's
 * first invoice, sees *Issue next* refuse the second until the first is paid,
 * marks it paid and issues the second; sales also drafts a one-off charge that
 * the customer cannot see; the customer opens the list in Persian, finds both
 * planned invoices (and not the draft), opens one — numbered in Latin digits,
 * the amount in Persian ones, no pay button, how Root is paid in words — and
 * prints it; the draft is issued and the customer sees it; and the old
 * `/app/billing` address lands on `/app/invoices`.
 *
 * **The contract is signed by direct insert** (`insertSignedPaymentPlan`): the
 * agreement gate that would let an `AGREEMENT_FIRST` contract be signed through
 * the API is J7's, and this stage must not build it.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
  insertSignedPaymentPlan();
});

const planCard = (page: Page) => page.locator(`[data-testid="plan-card"][data-contract="${WIZARD_CONTRACT_REF}"]`);
const planRow = (page: Page, n: number) => planCard(page).getByTestId('plan-row').nth(n - 1);

test('sales issues the first planned invoice, is held from the second until the first is paid, then issues it', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/billing');
  await expect(planCard(page)).toBeVisible();

  // Signed, nothing issued: the first is ready, the second waits on it.
  await expect(planRow(page, 1)).toHaveAttribute('data-state', 'ISSUABLE');
  await expect(planRow(page, 2)).toHaveAttribute('data-state', 'NOT_YET_ISSUABLE');
  await expect(planCard(page).getByTestId('issue-next')).toBeEnabled();

  await planCard(page).getByTestId('issue-next').click();
  await expect(planRow(page, 1)).toHaveAttribute('data-state', 'ISSUED');
  await expect(planRow(page, 1)).toContainText('INV-000001');

  // The next row's button is disabled, and says why.
  await expect(planCard(page).getByTestId('issue-next')).toBeDisabled();
  await expect(planCard(page).getByTestId('issue-blocked')).toContainText('previous invoice to be paid');

  // Paid: the plan refetches and the second is ready.
  await planRow(page, 1).getByTestId('plan-mark-paid').click();
  await expect(planRow(page, 1)).toHaveAttribute('data-state', 'PAID');
  await expect(planRow(page, 2)).toHaveAttribute('data-state', 'ISSUABLE');
  await expect(planCard(page).getByTestId('issue-next')).toBeEnabled();

  await planCard(page).getByTestId('issue-next').click();
  await expect(planRow(page, 2)).toHaveAttribute('data-state', 'ISSUED');
  await expect(planRow(page, 2)).toContainText('INV-000002');
  // The plan is done: nothing left to issue.
  await expect(planCard(page).getByTestId('issue-next')).toHaveCount(0);
});

test('a one-off charge starts as a draft on the desk', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/billing');
  await page.getByRole('button', { name: 'Add entry' }).click();
  const form = page.locator('form.auth-form').filter({ has: page.locator('input[dir="rtl"]') });
  await form.locator('select').first().selectOption({ index: 1 });
  await form.locator('input[dir="rtl"]').fill('کار اضافه');
  await form.locator('input[dir="ltr"]').fill('Extra work');
  await form.locator('input[inputmode="numeric"]').first().fill('7500000');
  await form.getByRole('button', { name: 'Save' }).click();

  const drafts = page.locator('[data-testid="ledger-row"][data-draft="true"]');
  await expect(drafts).toHaveCount(1);
  await expect(drafts.first().getByTestId('ledger-draft-badge')).toBeVisible();
  await expect(drafts.first()).toContainText('Extra work');
  await expect(drafts.first().getByTestId('ledger-issue')).toBeEnabled();
});

test('the customer reads both planned invoices in Persian, and not the draft; the invoice is numbered, printable and has no pay button', async ({ page }) => {
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/invoices');
  await expect(page.getByRole('heading', { level: 1, name: 'صورت‌حساب‌ها' }).first()).toBeVisible();

  // Two invoices, both numbered in Latin digits; the draft is nowhere.
  const rows = page.getByTestId('invoice-row');
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('invoice-list')).not.toContainText('کار اضافه');
  await expect(rows.filter({ hasText: 'INV-000001' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'INV-000002' })).toHaveCount(1);
  // The first is paid, the second is still to pay.
  await expect(rows.filter({ hasText: 'INV-000001' }).getByTestId('invoice-status')).toHaveAttribute('data-standing', 'paid');
  await expect(rows.filter({ hasText: 'INV-000002' }).getByTestId('invoice-status')).toHaveAttribute('data-standing', 'due');

  // Open the second: it waited on the first being paid.
  await rows.filter({ hasText: 'INV-000002' }).getByRole('link').click();
  await page.waitForURL(/\/fa\/app\/invoices\/[^/]+$/);
  const detail = page.getByTestId('invoice-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('article.doc')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('invoice-detail-number')).toHaveText('INV-000002');
  await expect(page.getByTestId('invoice-detail-amount')).toHaveText('۱۰۰٬۰۰۰٬۰۰۰ تومان');
  await expect(page.getByTestId('invoice-detail-due')).not.toBeEmpty();
  await expect(page.getByTestId('invoice-detail-paid')).toHaveText('هنوز پرداخت‌نشده');
  await expect(page.getByTestId('invoice-waited-on')).toContainText('پرداختِ صورت‌حسابِ پیش از آن');
  // How Root is paid, in words; and no control that pays — the only button is print.
  await expect(page.getByTestId('invoice-how-to-pay')).toContainText('پرداخت آنلاین نداریم');
  await expect(detail.getByRole('button')).toHaveCount(1);

  // On paper the app's chrome is gone; the document stays.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.printbar')).toBeHidden();
  await expect(detail.locator('article.doc')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });

  // The first waited on the signature.
  await page.goto('/fa/app/invoices');
  await page.getByTestId('invoice-row').filter({ hasText: 'INV-000001' }).getByRole('link').click();
  await expect(page.getByTestId('invoice-waited-on')).toContainText('امضای قرارداد');
  await expect(page.getByTestId('invoice-detail-paid')).not.toHaveText('هنوز پرداخت‌نشده');
});

test('an invoice that is not the customer’s own, or does not exist, is one “no such invoice” screen', async ({ page }) => {
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/invoices/does-not-exist');
  await expect(page.getByTestId('invoice-not-found')).toBeVisible();
});

test('issuing the draft is what makes the customer see it; and the old billing address lands on invoices', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/billing');
  const draft = page.locator('[data-testid="ledger-row"][data-draft="true"]').first();
  await draft.getByTestId('ledger-issue').click();
  await expect(page.locator('[data-testid="ledger-row"][data-draft="true"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ledger-row"]', { hasText: 'INV-000003' })).toBeVisible();

  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/billing');
  await page.waitForURL(/\/en\/app\/invoices$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Invoices' }).first()).toBeVisible();
  await expect(page.getByTestId('invoice-row')).toHaveCount(3);
  await expect(page.getByTestId('invoice-list')).toContainText('Extra work');
});
