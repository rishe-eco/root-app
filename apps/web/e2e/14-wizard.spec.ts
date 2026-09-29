import { test, expect, type Page } from '@playwright/test';
import {
  CONTRACT_REF,
  CONTRACT_TITLE,
  CUSTOMER,
  SALES,
  WIZARD_CONTRACT_REF,
  WIZARD_CONTRACT_TITLE,
  insertOverdueCustomerCommitment,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * J3 — the wizard, driven the way each side drives it (journeys build plan §5
 * "J3").
 *
 * What only a browser can show: the seeded `AGREEMENT_FIRST` contract renders
 * its seven steps and the status area for the customer, in both languages and
 * both directions; the legacy contract renders its own page as ever, with the
 * status area and a two-step strip added; sales reads the same steps in the
 * workspace, writes an internal note, and "view as customer" is the portal's
 * own screen — read-only, and with no trace of the note.
 *
 * `02-contract-flow` and `04-workspace` are the regression for the legacy
 * road; they were not touched.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
  insertOverdueCustomerCommitment();
});

const NOTE = 'Internal: the budget is tight, do not mention the discount.';

/** Opens a contract from the customer's list by the title the list shows. */
async function openFromPortalList(page: Page, title: string, lang = 'en') {
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: title }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
}

test('the customer sees the new road: seven steps, the status area, an honest "not available yet"', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await openFromPortalList(page, WIZARD_CONTRACT_TITLE);

  const wizard = page.getByTestId('wizard');
  await expect(wizard).toBeVisible();
  // No phases yet: requirements … design, one placeholder demo, summary.
  const items = page.locator('.stepper-item');
  await expect(items).toHaveCount(7);
  await expect(items.first()).toHaveAttribute('data-step', 'REQUIREMENTS');
  await expect(items.first()).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.locator('.stepper-item[data-status="CURRENT"]')).toHaveCount(1);
  await expect(page.locator('.stepper-item[data-status="UPCOMING"]')).toHaveCount(6);

  const status = page.getByTestId('status-area');
  await expect(status.locator('[data-fact="current"] dd')).toHaveText('Requirements');
  // Nothing exists yet for the customer to act on, so the move is Root's.
  await expect(status.locator('[data-fact="move"] dd')).toHaveText("Root's");
  await expect(status.locator('[data-fact="started"] dt')).toHaveText('Not started yet');

  // The current step opens by default. Step 1 is built (J4) — with no brief yet it says
  // Root has not written one, rather than "not available".
  const panel = page.getByTestId('step-panel');
  await expect(panel).toHaveAttribute('data-step', 'REQUIREMENTS');
  await expect(panel.getByTestId('brief-empty')).toHaveText('Root has not written the requirements yet.');

  // Any step can be looked at; the ones not built yet do not pretend to have content.
  await page.locator('.stepper-item[data-step="DRAFT"] button').click();
  await expect(panel).toHaveAttribute('data-step', 'DRAFT');
  await expect(panel.getByRole('heading', { name: 'The draft' })).toBeVisible();
  await expect(panel.getByText('Not available yet')).toBeVisible();

  // The legacy sections are not on this road.
  await expect(page.getByText('Design selection & approval')).toHaveCount(0);
  // The rail is the new road's: a derived history, with the handover in it.
  await expect(page.getByTestId('timeline').locator('[data-kind="CONTRACT_HANDED_OVER"]')).toBeVisible();
});

test('the same contract in Persian: right-to-left, every label translated, nothing untranslated leaking through', async ({ page }) => {
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  await page.locator('tr.crow', { hasText: 'فروشگاه آنلاین نهال' }).click();
  await page.waitForURL(/\/fa\/app\/contracts\/[^/]+$/);

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fa');
  await expect(page.locator('.stepper-item')).toHaveCount(7);

  const status = page.getByTestId('status-area');
  await expect(status.getByRole('heading', { name: 'وضعیت کار' })).toBeVisible();
  await expect(status.locator('[data-fact="current"] dd')).toHaveText('نیازمندی‌ها');
  await expect(status.locator('[data-fact="move"] dd')).toHaveText('با ریشه');
  await expect(page.getByTestId('step-panel').getByTestId('brief-empty')).toHaveText('ریشه هنوز نیازمندی‌ها را ننوشته است.');

  // A missing key would render as the key itself.
  const text = await page.locator('main, .work, body').first().innerText();
  expect(text).not.toMatch(/\b(wizard|statusArea|attention|timeline)\.[A-Za-z_.]+/);
  // …and no English step name has crept into the step list.
  await expect(page.locator('.stepper')).not.toContainText(/Requirements|Design|Summary/);
});

test('an overdue commitment is the customer’s to see, in the status area and in the counts — in both languages', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await openFromPortalList(page, WIZARD_CONTRACT_TITLE);
  const item = page.getByTestId('attention-item');
  await expect(item).toHaveCount(1);
  await expect(item).toHaveAttribute('data-kind', 'COMMITMENT_OVERDUE');
  await expect(item).toContainText('“Send the brand assets” is past its due date and has not been confirmed.');
  const status = page.getByTestId('status-area');
  await expect(status.locator('[data-fact="waiting-customer"] dt')).toHaveText('Waiting on you');
  await expect(status.locator('[data-fact="waiting-customer"] dd')).toHaveText('1');
  await expect(status.locator('[data-fact="overdue"] dd')).toHaveText('1');

  await page.goto(page.url().replace('/en/', '/fa/'));
  await expect(page.getByTestId('attention-item')).toContainText('ارسال دارایی‌های برند');
  await expect(page.getByTestId('status-area').locator('[data-fact="waiting-customer"] dt')).toHaveText('منتظر تو');
  // Persian digits for a count.
  await expect(page.getByTestId('status-area').locator('[data-fact="waiting-customer"] dd')).toHaveText('۱');
});

test('the legacy contract renders exactly its old page, under a status area and a two-step strip', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await openFromPortalList(page, CONTRACT_TITLE);

  // Today's page, untouched.
  await expect(page.getByText('Design selection & approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve contract' })).toHaveCount(0);
  await expect(page.locator('.concept')).toHaveCount(3);
  await expect(page.getByTestId('wizard')).toHaveCount(0);

  // The additions: design is current, agreement upcoming, the design is the customer's to choose.
  const items = page.locator('.stepper-item');
  await expect(items).toHaveCount(2);
  await expect(page.locator('.stepper-item[data-step="DESIGN"]')).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.locator('.stepper-item[data-step="AGREEMENT"]')).toHaveAttribute('data-status', 'UPCOMING');
  const status = page.getByTestId('status-area');
  await expect(status.locator('[data-fact="current"] dd')).toHaveText('Design');
  await expect(status.locator('[data-fact="move"] dd')).toHaveText('Yours');
  // The strip is display-only on this road.
  await expect(page.locator('.stepper button')).toHaveCount(0);
});

test('sales reads the same steps in the workspace, writes a note, and "view as customer" shows none of it', async ({ page }) => {
  await signIn(page, SALES);

  // The desk list says where each contract is, beside the status.
  await page.goto('/en/desk/contracts');
  await expect(page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).getByTestId('contract-step')).toHaveText(
    'Requirements · waiting on Root',
  );
  await expect(page.locator('tr.crow', { hasText: CONTRACT_REF }).getByTestId('contract-step')).toHaveText(
    'Design · waiting on the customer',
  );

  // A new-road contract opens on its steps; the tabs lead with them.
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/steps$/);
  const contractId = page.url().match(/contracts\/([^/]+)\//)![1];
  await expect(page.locator('.workspace-tab').first()).toHaveText('Steps');
  await expect(page.locator('.stepper-item')).toHaveCount(7);
  const status = page.getByTestId('status-area');
  // Written for staff: it is not "waiting on you".
  await expect(status.locator('[data-fact="waiting-customer"] dt')).toHaveText('Waiting on the customer');
  await expect(status.locator('[data-fact="move"] dd')).toHaveText("Root's");
  // Staff get the step-1 form (J4) where the customer gets the cards.
  await expect(page.getByTestId('requirements-editor')).toBeVisible();
  await expect(page.getByTestId('brief-empty')).toHaveText('Nothing is written yet — fill in the form above.');
  // The overdue commitment reads as the customer's lateness, to Root.
  await expect(page.getByTestId('attention-item')).toContainText('The customer is late on “Send the brand assets”.');

  // An internal note.
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByTestId('internal-notes').getByText('No notes yet.')).toBeVisible();
  await page.getByPlaceholder('Write a note for the team…').fill(NOTE);
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByTestId('internal-note')).toContainText(NOTE);

  // View as customer: the portal's screen, read-only, and no note.
  await page.getByRole('link', { name: 'Steps', exact: true }).click();
  await page.getByRole('link', { name: 'View as customer' }).click();
  await page.waitForURL(new RegExp(`/en/desk/contracts/${contractId}/as-customer$`));
  await expect(page.getByTestId('view-as-banner')).toContainText('sees it');
  // …naming the customer as the customer's own list does (the seeded studio is named in Persian).
  await expect(page.getByTestId('view-as-banner')).toContainText('استودیو نهال');
  await expect(page.getByTestId('wizard')).toBeVisible();
  // The customer's wording, not the staff's: the same item, written for them.
  await expect(page.getByTestId('attention-item')).toContainText('is past its due date and has not been confirmed');
  await expect(page.getByTestId('status-area').locator('[data-fact="waiting-customer"] dt')).toHaveText('Waiting on you');
  // Nothing of the note anywhere on the page, and nothing to type into.
  await expect(page.locator('body')).not.toContainText('the budget is tight');
  await expect(page.locator('body')).not.toContainText('Internal notes');
  await expect(page.locator('textarea')).toHaveCount(0);
  // Read-only: the step buttons are disabled by the browser.
  await expect(page.locator('.stepper-item button').first()).toBeDisabled();

  // And the note is really there for staff.
  await page.getByRole('link', { name: 'Back to the desk' }).click();
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page.getByTestId('internal-note')).toContainText(NOTE);
});

test('a legacy contract in the workspace keeps its tabs and its landing, and gains Notes', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/contract$/);
  await expect(page.locator('.workspace-tab')).toHaveText([
    'Contract',
    'Design',
    'Scope',
    'Phases',
    'Dependencies',
    'Activity',
    'Notes',
  ]);
  // The two-step strip, display-only.
  await expect(page.locator('.stepper-item')).toHaveCount(2);

  // View as customer on the legacy road is the old page, read-only.
  await page.getByRole('link', { name: 'View as customer' }).click();
  await expect(page.getByText('Design selection & approval')).toBeVisible();
  await expect(page.locator('.concept').first()).toBeDisabled();
  await expect(page.getByTestId('view-as-banner')).toBeVisible();
});
