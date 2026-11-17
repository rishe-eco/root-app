import { test, expect, type Page } from '@playwright/test';
import {
  DEVELOPER,
  DRAFT_CONTRACT_REF,
  SALES,
  WIZARD_CONTRACT_REF,
  apiSignIn,
  completeStepOneViaApi,
  gql,
  insertDraftNewRoadContract,
  makeContractLegacy,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * DX2a — the new step order, and the tabs come off (desk UX review 4, 9–12, 18,
 * 19), driven the way sales and the developer drive them, in both languages and
 * at 360 px and 180 px.
 *
 * One story, in order: a new-road contract has five tabs and its old links go to
 * the steps that hold their work; a legacy contract keeps its seven; the Phases
 * and payment step shows "X of Y allocated", warns while the plan does not add up
 * and is edited in place (a phase, a payment row); Pages and features holds the
 * extras and the registry's controls the Scope tab used to; a phase's Demo step
 * sets the demo up.
 *
 * Every measurement waits for `document.fonts.ready` (brief-common, Tests).
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';
const WIDTHS = [360, 180] as const;

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  resetTestDatabase();
  insertDraftNewRoadContract();
  // Step 1 over the API gives the wizard contract its brief, one phase and a plan of 150,000,000; the price is
  // set to 180,000,000 so the plan starts out 30,000,000 short.
  contractId = await completeStepOneViaApi(request);
  await apiSignIn(request, SALES);
  await gql(request, 'mutation($c: ID!, $fa: String!, $en: String!, $a: String){ updateContractDraft(contractId: $c, titleFa: $fa, titleEn: $en, amount: $a) { id } }', {
    c: contractId,
    fa: 'فروشگاه آنلاین نهال',
    en: 'Nahal online shop',
    a: '180000000',
  });
});

/** The controls inside `scope` that stick out of the viewport (the column itself, not the desk's nav row). */
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
      if (r.left < -1 || r.right > w + 1) stuck.push(`${el.tagName.toLowerCase()} ${el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 24) ?? ''} [${Math.round(r.left)}..${Math.round(r.right)}] of ${w}`);
    });
    const rect = root?.getBoundingClientRect();
    const out = !root || !rect || rect.left < -1 || rect.right > w + 1 || root.scrollWidth > root.clientWidth + 1;
    return { stuck, out, detail: root ? `scrollWidth ${root.scrollWidth} clientWidth ${root.clientWidth} of ${w}` : 'no column' };
  }, scope);
  const width = page.viewportSize()?.width;
  expect(result.stuck, `controls outside the column at ${width}px`).toEqual([]);
  expect(result.out, `the column overflows at ${width}px: ${result.detail}`).toBe(false);
}

async function openWorkspace(page: Page, who: typeof SALES, ref: string, lang: 'en' | 'fa' = 'en') {
  await signIn(page, who, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: ref }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
}

const item = (page: Page, step: string) => page.locator(`.stepper-item[data-step="${step}"]`);
const stepButton = (page: Page, step: string) => item(page, step).locator('button');

test('a new-road contract has five tabs and its old Scope, Phases and Design links go to the steps; Phases and payment sits between Pages and features and the draft', async ({ page }) => {
  await openWorkspace(page, SALES, WIZARD_CONTRACT_REF);
  await expect(page.locator('.workspace-tab')).toHaveText(['Steps', 'Contract', 'Dependencies', 'Activity', 'Notes']);

  const order = await page.locator('.stepper-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-step')));
  expect(order.slice(0, 4)).toEqual(['REQUIREMENTS', 'SCOPE', 'PHASES', 'DRAFT']);

  // Staff open any of the first three at once, whatever the road is at.
  for (const step of ['PHASES', 'SCOPE', 'REQUIREMENTS']) {
    await stepButton(page, step).click();
    await expect(page.getByTestId('step-panel')).toHaveAttribute('data-step', step);
  }

  // The removed tabs' addresses still work: they land on the step that holds the work.
  for (const [tab, step] of [['scope', 'SCOPE'], ['phases', 'PHASES'], ['design', 'DESIGN']] as const) {
    await page.goto(`/en/desk/contracts/${contractId}/${tab}`);
    await expect(page).toHaveURL(new RegExp(`/steps\\?step=${step}$`));
    await expect(page.getByTestId('step-panel')).toHaveAttribute('data-step', step);
  }
});

test('Phases and payment: "X of Y allocated", a warning while the plan is short and a publish blocker, then the plan is fixed in place — in both languages, at 360 and 180 px', async ({ page }) => {
  await openWorkspace(page, SALES, WIZARD_CONTRACT_REF);
  await stepButton(page, 'PHASES').click();
  const panel = page.getByTestId('phases-panel');
  await expect(panel).toBeVisible();

  // The plan (one row, 150,000,000) against the price (180,000,000, set on the Contract tab).
  const allocated = panel.getByTestId('plan-allocated');
  await expect(allocated).toContainText('150,000,000 of 180,000,000 Toman allocated');
  await expect(allocated).toHaveAttribute('data-balanced', 'false');
  await expect(allocated).toContainText('does not add up');
  await expect(item(page, 'PHASES')).not.toHaveAttribute('data-status', 'DONE');
  await expect(panel.getByTestId('plan-missing').locator('[data-code="PAYMENT_PLAN_TOTAL"]')).toBeVisible();

  // The same fact is a publish blocker, pointing back here (the Contract tab's readiness box).
  await page.locator('.workspace-tab', { hasText: 'Contract' }).click();
  const blocker = page.getByTestId('readiness-blockers').locator('[data-code="PLAN_UNBALANCED"]');
  await expect(blocker).toContainText('does not add up to the price');
  await blocker.getByRole('link').click();
  await expect(page.getByTestId('step-panel')).toHaveAttribute('data-step', 'PHASES');

  // A phase is edited where it is read.
  const acc = page.getByTestId('acc-phases');
  await expect(acc).toHaveAttribute('data-open', 'true');
  const row = page.getByTestId('brief-phase').first();
  await row.locator('input').nth(1).fill('Kick-off');
  await page.getByTestId('phase-milestone-1').fill('Deposit');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('phases-readout')).toContainText('Kick-off');
  // The milestone label (the old Phases tab edited it) round-trips: the row remounts with what the server now holds.
  await expect(page.getByTestId('phase-milestone-1')).toHaveValue('Deposit');

  // The plan is fixed: the one row takes the whole price, and the step is done.
  await page.getByTestId('acc-plan').getByRole('button').first().click();
  await page.getByTestId('plan-row').first().getByLabel('Amount (Toman)').fill('180000000');
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-saved')).toBeVisible();
  await expect(allocated).toHaveAttribute('data-balanced', 'true');
  await expect(allocated).toContainText('180,000,000 of 180,000,000');
  await expect(item(page, 'PHASES')).toHaveAttribute('data-status', 'DONE');
  await expect(page.getByTestId('plan-missing')).toHaveCount(0);

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});

test('the same step in Persian: Persian digits, right-to-left, fits at 360 and 180 px', async ({ page }) => {
  await openWorkspace(page, SALES, WIZARD_CONTRACT_REF, 'fa');
  await stepButton(page, 'PHASES').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const panel = page.getByTestId('phases-panel');
  await expect(panel.getByTestId('plan-allocated')).toContainText('۱۸۰٬۰۰۰٬۰۰۰ از ۱۸۰٬۰۰۰٬۰۰۰ تومان');
  await expect(item(page, 'PHASES')).toContainText('فازها و پرداخت');
  await expect(page.locator('.workspace-tab')).toHaveCount(5);
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});

test('Pages and features holds the extras and the registry the Scope tab had: an item with its own key, its phase, its status — in both languages, at 360 and 180 px', async ({ page }) => {
  await openWorkspace(page, SALES, WIZARD_CONTRACT_REF);
  await stepButton(page, 'SCOPE').click();
  const panel = page.getByTestId('scope-panel');

  // An item typed with its key (the old tab asked for one).
  const add = page.getByTestId('scope-add');
  await add.getByLabel('Key (optional)').fill('sample.page');
  await add.getByLabel('Label (Persian)').fill('صفحه‌ی نمونه');
  await add.getByLabel('Label (English)').fill('Sample page');
  await page.getByTestId('scope-add-submit').click();
  await expect(page.getByTestId('scope-add-done')).toBeVisible();

  // The extras are a group here, switched by a checkbox.
  const payment = panel.locator('[data-testid="scope-extra"][data-key="checklist.payment"]');
  await expect(payment).toHaveAttribute('data-included', 'false');
  const box = panel.locator('input[type="checkbox"][data-key="checklist.payment"]');
  await box.click();
  await expect(box).toBeChecked();
  await expect(payment).toHaveAttribute('data-included', 'true');

  // The registry's controls: status, flags, phase.
  await page.getByTestId('acc-registry').getByRole('button').first().click();
  const card = page.locator('[data-testid="registry-item"][data-key="sample.page"]');
  await expect(card).toBeVisible();
  await card.getByTestId('registry-status').selectOption('IN_BUILD');
  await expect(card.getByTestId('registry-status')).toHaveValue('IN_BUILD');
  await card.getByTestId('registry-phase').selectOption({ index: 1 });
  await expect(card.getByTestId('registry-phase')).not.toHaveValue('');
  await card.getByLabel('Temporary').click();
  await expect(card.getByLabel('Temporary')).toBeChecked();

  // The registry persists across a reload: the status and the phase are the API's.
  await page.reload();
  await stepButton(page, 'SCOPE').click();
  await page.getByTestId('acc-registry').getByRole('button').first().click();
  const again = page.locator('[data-testid="registry-item"][data-key="sample.page"]');
  await expect(again.getByTestId('registry-status')).toHaveValue('IN_BUILD');
  await expect(again.getByTestId('registry-phase')).not.toHaveValue('');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Persian: the group and the registry are titled.
  await page.goto(page.url().replace('/en/', '/fa/'));
  await stepButton(page, 'SCOPE').click();
  await expect(page.getByTestId('scope-panel')).toContainText('افزونه‌ها');
  await expect(page.getByTestId('acc-registry')).toContainText('وضعیت، نشان‌ها، جایگزینی و فاز');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});

test('a phase’s Demo step sets the demo up: the live demo link, the readiness check and the declared pages — in both languages, at 360 and 180 px', async ({ page }) => {
  await openWorkspace(page, DEVELOPER, WIZARD_CONTRACT_REF);
  await stepButton(page, 'DEMO').click();
  const panel = page.getByTestId('demo-panel');
  await expect(panel).toBeVisible();

  // No demo yet: the developer creates it with its staging address.
  await page.getByTestId('demo-create').getByLabel('Staging URL').fill('http://nahal.staging.localhost:1/');
  await page.getByTestId('demo-create').getByRole('button', { name: 'Add a demo' }).click();
  await expect(page.getByTestId('demo-readiness')).toBeVisible();
  await expect(page.locator('.demo-card input[dir="ltr"]').first()).toHaveValue('http://nahal.staging.localhost:1/');

  // The declared pages.
  await page.getByRole('button', { name: 'Declare a page' }).click();
  const form = page.locator('form.auth-form').filter({ hasText: 'Path (as it appears in the browser)' });
  const inputs = form.locator('input'); // key, title (Persian), title (English), path — in that order
  await inputs.nth(0).fill('home');
  await inputs.nth(1).fill('خانه');
  await inputs.nth(2).fill('Home page');
  await inputs.nth(3).fill('/');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.demo-page-row').first()).toContainText('Home page');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Persian.
  await page.goto(page.url().replace('/en/', '/fa/'));
  await stepButton(page, 'DEMO').click();
  await expect(page.getByTestId('demo-readiness')).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});

test('a legacy (DESIGN_FIRST) contract keeps all seven of its tabs, and its Scope link is still the tab', async ({ page }) => {
  makeContractLegacy('e2e-draft-contract');
  await signIn(page, SALES);
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: DRAFT_CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/contract$/);
  await expect(page.locator('.workspace-tab')).toHaveText(['Contract', 'Design', 'Scope', 'Phases', 'Dependencies', 'Activity', 'Notes']);

  await page.getByRole('link', { name: 'Scope', exact: true }).click();
  await expect(page).toHaveURL(/\/scope$/);
  await expect(page.locator('.workspace-tab-active')).toHaveText('Scope');
  await page.getByRole('link', { name: 'Phases', exact: true }).click();
  await expect(page).toHaveURL(/\/phases$/);
  await expect(page.locator('.workspace-tab-active')).toHaveText('Phases');
  void apiSignIn;
});
