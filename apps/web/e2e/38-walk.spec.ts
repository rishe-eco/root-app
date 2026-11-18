import { test, expect, type Page } from '@playwright/test';
import { ADMIN, DRAFT_CONTRACT_REF, SALES, WIZARD_CONTRACT_REF, expectSaved, insertDraftNewRoadContract, resetTestDatabase, signIn } from './helpers';

/**
 * DX6 — the founder's walk through the steps (2026-11-18). One story on the seeded new-road contracts: a site type that
 * saves (picked, and made in the modal), a count of 0 and a support term of 0, the budget and the fee as one number,
 * a dependency nobody decided, one checkbox per extra and an extra added to one contract, labelled plan rows, and the
 * desk's one way to add. Both languages, 360 and 180 px.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  test.setTimeout(120_000);
  resetTestDatabase();
  insertDraftNewRoadContract();
});

const WIDTHS = [360, 180] as const;

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
    return { stuck, out: !root || !rect || rect.left < -1 || rect.right > w + 1 || root.scrollWidth > root.clientWidth + 1 };
  }, scope);
  const width = page.viewportSize()?.width;
  expect(result.stuck, `controls outside the column at ${width}px`).toEqual([]);
  expect(result.out, `the column overflows at ${width}px`).toBe(false);
}

async function openPanel(page: Page, id: string) {
  const panel = page.getByTestId(`acc-${id}`);
  if ((await panel.getAttribute('data-open')) !== 'true') await panel.getByRole('button').first().click();
  await expect(panel).toHaveAttribute('data-open', 'true');
}

/** A contract's step on the desk, by the ref its list row shows. */
async function openStep(page: Page, ref: string, step: string, lang: 'en' | 'fa' = 'en', who: typeof SALES = SALES) {
  await signIn(page, who, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: ref }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
  await page.locator(`.stepper-item[data-step="${step}"] button`).click();
}

test('a site type saves: picked from the list, and made with New site type — still there after a reload', async ({ page }) => {
  // The admin holds `templates.types`, which "New site type" is behind.
  await openStep(page, DRAFT_CONTRACT_REF, 'REQUIREMENTS', 'en', ADMIN);
  await expect(page.getByTestId('requirements-panel')).toBeVisible();

  // Made in the modal: the picker selects it, and it is saved with the brief.
  await page.getByTestId('brief-new-type').click();
  await page.locator('#nst-fa').fill('بروشور');
  await page.locator('#nst-en').fill('Brochure');
  await page.getByTestId('new-site-type-create').click();
  await expect(page.getByTestId('new-site-type-modal')).toHaveCount(0);
  await expect(page.locator('#brief-type')).toHaveValue(/.+/);
  await expectSaved(page, 'brief-autosave');
  await page.reload();
  await expect(page.locator('#brief-type option:checked')).toHaveText('Brochure');

  // Picked from the list.
  await page.locator('#brief-type').selectOption({ label: 'Store' });
  await expectSaved(page, 'brief-autosave');
  await page.reload();
  await expect(page.locator('#brief-type option:checked')).toHaveText('Store');
});

/** A tab of the open contract's workspace (`steps`, `contract`, `dependencies`, `notes`). */
async function gotoTab(page: Page, tab: string, lang: 'en' | 'fa' = 'en') {
  const url = new URL(page.url());
  const id = url.pathname.match(/\/desk\/contracts\/([^/]+)/)![1];
  await page.goto(`/${lang}/desk/contracts/${id}/${tab}`);
}

const pressed = (page: Page, testId: string, value: string) => page.getByTestId(testId).locator(`button[data-value="${value}"]`);

test('a count of 0 and a support term of 0 are choices — saved, and still pressed after a reload', async ({ page }) => {
  await openStep(page, DRAFT_CONTRACT_REF, 'REQUIREMENTS');
  await expect(page.getByTestId('brief-form')).toBeVisible();

  await pressed(page, 'brief-premade', '0').click();
  await expect(pressed(page, 'brief-premade', '0')).toHaveAttribute('aria-pressed', 'true');
  await expectSaved(page, 'brief-autosave');
  await pressed(page, 'brief-demos', '0').click();
  await expectSaved(page, 'brief-autosave');
  await pressed(page, 'brief-support-pills', '0').click();
  await expect(pressed(page, 'brief-support-pills', '0')).toHaveAttribute('aria-pressed', 'true');
  await expectSaved(page, 'brief-autosave');

  await page.reload();
  await expect(pressed(page, 'brief-premade', '0')).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed(page, 'brief-demos', '0')).toHaveAttribute('aria-pressed', 'true');
  await expect(pressed(page, 'brief-support-pills', '0')).toHaveAttribute('aria-pressed', 'true');
  // Zero is not "unset": none of the allowance or support gaps is listed.
  const missing = page.getByTestId('brief-missing');
  for (const code of ['PREMADE_ROUNDS', 'DEMO_ITERATIONS', 'SUPPORT_MONTHS']) await expect(missing.locator(`[data-code="${code}"]`)).toHaveCount(0);
});

test('the budget and the contract’s fee are one number — typed on either, shown on the other', async ({ page }) => {
  await openStep(page, DRAFT_CONTRACT_REF, 'REQUIREMENTS');
  await page.locator('#brief-budget').fill('150000000');
  await page.locator('#brief-budget').blur();
  await expectSaved(page, 'brief-autosave');

  // The Contract tab's fee is the budget.
  await gotoTab(page, 'contract');
  await expect(page.locator('#ct-amount')).toHaveValue('150000000');

  // And the other way: a fee typed there is the budget on Requirements.
  await page.locator('#ct-amount').fill('160000000');
  await page.locator('#ct-amount').blur();
  await expectSaved(page, 'title-fee-autosave');
  await gotoTab(page, 'steps');
  await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
  await expect(page.locator('#brief-budget')).toHaveValue('160000000');
});

test('a dependency nobody decided is a gap with its own sentence, until it has a side (or is not needed) and a date', async ({ page }) => {
  await openStep(page, DRAFT_CONTRACT_REF, 'REQUIREMENTS');
  await openPanel(page, 'handover');
  await expect(page.getByTestId('handover-row')).toHaveCount(3);
  const missing = page.getByTestId('brief-missing');
  await expect(missing.locator('[data-code="COMMITMENT_UNDECIDED"]')).toHaveCount(3);
  await expect(missing.locator('[data-code="COMMITMENT_UNDECIDED"]').first()).toContainText('who provides');

  // Not needed is a decision; a side is one, and then wants a date.
  await page.getByTestId('handover-side-domain').locator('button[data-value="NOT_NEEDED"]').click();
  await page.getByTestId('handover-side-host').locator('button[data-value="NOT_NEEDED"]').click();
  await page.getByTestId('handover-side-content').locator('button[data-value="ROOT"]').click();
  await expectSaved(page, 'handover-autosave');
  await expect(missing.locator('[data-code="COMMITMENT_UNDECIDED"]')).toHaveCount(0);
  await expect(missing.locator('[data-code="COMMITMENT_UNDATED"]')).toHaveCount(1);
  const due = page.getByTestId('handover-due-content');
  await due.locator('input[data-part="text"]').fill('1405/09/30');
  await due.locator('input[data-part="text"]').blur();
  await expectSaved(page, 'handover-autosave');
  await expect(missing.locator('[data-code="COMMITMENT_UNDATED"]')).toHaveCount(0);

  // Publishing was held by it; the Contract tab's readiness box says what still stops it, and no longer this.
  await gotoTab(page, 'contract');
  await expect(page.getByTestId('readiness-box')).toBeVisible();
});

test('Pages and features: one checkbox per extra, ticked by its words; an extra added to this contract and removed again', async ({ page }) => {
  await openStep(page, WIZARD_CONTRACT_REF, 'SCOPE');
  await expect(page.getByTestId('scope-panel')).toBeVisible();
  await openPanel(page, 'scope-list');

  const payment = page.locator('[data-testid="scope-extra"][data-key="checklist.payment"]');
  await expect(payment.locator('input[type="checkbox"]')).toHaveCount(1);
  await expect(payment.getByText('☐')).toHaveCount(0);
  await expect(payment).toHaveAttribute('data-included', 'false');
  // An unticked extra is its checkbox row alone: no chips, no Details.
  await expect(page.locator('[data-testid="feedback-target"]').filter({ has: page.locator('[data-testid="scope-extra"][data-key="checklist.payment"]') }).getByTestId('scope-details')).toHaveCount(0);
  await payment.getByText('Payment', { exact: true }).click();
  await expect(payment).toHaveAttribute('data-included', 'true');
  await expect(payment.locator('input[type="checkbox"]')).toBeChecked();
  // A ticked one has the chips and the drawer's toggle.
  const row = page.locator('[data-testid="feedback-target"]').filter({ has: page.locator('[data-testid="scope-extra"][data-key="checklist.payment"]') });
  await expect(row.getByTestId('scope-chip-status')).toBeVisible();
  await expect(row.getByTestId('scope-details')).toBeVisible();
  await payment.getByText('Payment', { exact: true }).click();
  await expect(payment).toHaveAttribute('data-included', 'false');

  // Add extra: a button, then a small form; Escape cancels, Enter adds.
  await page.getByTestId('extra-add-open').click();
  await expect(page.getByTestId('extra-add')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('extra-add')).toHaveCount(0);
  await page.getByTestId('extra-add-open').click();
  await page.locator('#extra-add-title').fill('Nightly backups');
  await page.locator('#extra-add-title').press('Enter');
  await expect(page.getByTestId('extra-add')).toHaveCount(0);
  const backups = page.locator('[data-testid="scope-extra"]', { hasText: 'Nightly backups' });
  await expect(backups).toHaveCount(1);
  await expect(backups).toHaveAttribute('data-included', 'true');
  page.once('dialog', (d) => void d.accept());
  await page.locator('[data-testid="feedback-target"]').filter({ has: backups }).getByTestId('extra-remove').click();
  await expect(page.locator('[data-testid="scope-extra"]', { hasText: 'Nightly backups' })).toHaveCount(0);
  // The seeded one is still there: switched off, never deleted.
  await expect(payment).toHaveCount(1);
});

test('a scope item: its chips at a glance, one Details drawer at a time, Escape closes it', async ({ page }) => {
  await openStep(page, WIZARD_CONTRACT_REF, 'SCOPE');
  await openPanel(page, 'scope-list');
  // The seeded contract has only its extras: two pages first, added the one way.
  for (const title of ['Home page', 'About page']) {
    await page.getByTestId('scope-add-open').click();
    await page.locator('#scope-add-title').fill(title);
    await page.locator('#scope-add-title').press('Enter');
    await expect(page.locator('[data-testid="scope-item"]', { hasText: title })).toHaveCount(1);
  }
  const items = page.locator('[data-testid="scope-item"]');
  await expect(items.first()).toBeVisible();
  const target = (text: string) => page.locator('[data-testid="feedback-target"]').filter({ has: page.locator('[data-testid="scope-item"]', { hasText: text }) });
  const first = target('Home page');
  const second = target('About page');

  await expect(first.getByTestId('scope-chip-status')).toBeVisible();
  await first.getByTestId('scope-details').click();
  await expect(first.getByTestId('scope-drawer')).toBeVisible();
  await expect(first.getByTestId('scope-details')).toHaveAttribute('aria-expanded', 'true');
  // Status saves as it is changed and the chip follows.
  await first.getByTestId('registry-status').selectOption('IN_BUILD');
  await expect(first.getByTestId('scope-chip-status')).toHaveAttribute('data-status', 'IN_BUILD');
  // A flag is a toggle pill and shows as a chip only when set.
  await expect(first.getByTestId('scope-chip-temporary')).toHaveCount(0);
  await first.getByTestId('scope-flag-temporary').click();
  await expect(first.getByTestId('scope-chip-temporary')).toBeVisible();

  // One at a time.
  await second.getByTestId('scope-details').click();
  await expect(second.getByTestId('scope-drawer')).toBeVisible();
  await expect(page.getByTestId('scope-drawer')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scope-drawer')).toHaveCount(0);
  await expect(second.getByTestId('scope-details')).toBeFocused();
  await first.getByTestId('scope-details').click();
  await first.getByTestId('scope-flag-temporary').click();
  await first.getByTestId('registry-status').selectOption('AGREED');
});

test('Phases and payment: every field has a label above it; a phase and a plan row are added the same way', async ({ page }) => {
  await openStep(page, DRAFT_CONTRACT_REF, 'PHASES');
  await openPanel(page, 'phases');

  // Add phase: the button, the form, Add and Cancel.
  await page.getByTestId('brief-phase-new-open').click();
  await expect(page.getByTestId('brief-phase-new')).toBeVisible();
  await page.getByTestId('brief-phase-new-cancel').click();
  await expect(page.getByTestId('brief-phase-new')).toHaveCount(0);
  await page.getByTestId('brief-phase-new-open').click();
  await page.locator('#phase-new-title').fill('Kick-off');
  await page.getByTestId('brief-phase-new-submit').click();
  const phase = page.getByTestId('brief-phase').first();
  await expect(phase).toBeVisible();
  // Date, milestone and the demo switch each have a visible label.
  await expect(phase.locator('label.label[for="phase-milestone-1"]')).toBeVisible();
  await expect(phase.locator('span.label').first()).toBeVisible();

  await openPanel(page, 'plan');
  await page.getByTestId('plan-propose').click();
  await expect(page.getByTestId('plan-row').first()).toBeVisible();
  const row = page.getByTestId('plan-row').first();
  await expect(row.getByText('Amount (Toman)', { exact: true })).toBeVisible();
  await expect(row.getByText('Due when', { exact: true })).toBeVisible();
  await expect(row.getByText('Payment term (days)', { exact: true })).toBeVisible();
  await expect(row.getByText('Days the customer has to pay once it is issued.')).toBeVisible();
  await expect(row.getByLabel('Amount (Toman)')).toBeVisible();
  // An added row is the same editor: one title input and "Add the other language", as everywhere.
  const before = await page.getByTestId('plan-row').count();
  await page.getByRole('button', { name: 'Add row' }).click();
  await expect(page.getByTestId('plan-row')).toHaveCount(before + 1);
  const added = page.getByTestId('plan-row').last();
  await expect(added.locator('.title-field')).toHaveAttribute('data-mode', 'one');
  await expect(added.getByText('Amount (Toman)', { exact: true })).toBeVisible();
  // A proposed row with both languages shows both inputs through the same TitleField.
  await expect(page.getByTestId('plan-row').first().locator('.title-field')).toHaveAttribute('data-mode', 'two');
});

test('Dependencies tab and scope items add the same way: a button, a labelled form, Enter adds, Escape cancels', async ({ page }) => {
  await openStep(page, WIZARD_CONTRACT_REF, 'SCOPE');
  await openPanel(page, 'scope-list');
  await page.getByTestId('scope-add-open').click();
  await expect(page.getByTestId('scope-add')).toBeVisible();
  await expect(page.getByLabel('Kind', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('scope-add')).toHaveCount(0);
  await page.getByTestId('scope-add-open').click();
  await page.locator('#scope-add-title').fill('Gallery page');
  await page.locator('#scope-add-title').press('Enter');
  await expect(page.locator('[data-testid="scope-item"]', { hasText: 'Gallery page' })).toHaveCount(1);

  await gotoTab(page, 'dependencies');
  await page.getByTestId('dependency-add-open').click();
  await expect(page.getByTestId('dependency-add')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('dependency-add')).toHaveCount(0);
  await page.getByTestId('dependency-add-open').click();
  await page.locator('#dependency-add-title').fill('Logo files');
  await page.locator('#dependency-add-title').press('Enter');
  await expect(page.getByText('Logo files').first()).toBeVisible();

  await gotoTab(page, 'notes');
  await page.getByTestId('note-add-open').click();
  await page.locator('#note-add-body').fill('A private note');
  await page.getByTestId('note-add-submit').click();
  await expect(page.getByTestId('internal-note').filter({ hasText: 'A private note' })).toHaveCount(1);
});

test('Templates: the Extras tab and the Default dependencies tab, with their help lines', async ({ page }) => {
  await signIn(page, SALES);
  await page.goto('/en/desk/templates/handover');
  await expect(page.getByRole('link', { name: 'Default dependencies' })).toBeVisible();
  await expect(page.getByText('Every new contract starts with these in Requirements → Dependencies.')).toBeVisible();
  await page.getByRole('link', { name: 'Extras' }).click();
  await expect(page.getByTestId('extra-type')).toHaveCount(10);
  await page.getByTestId('extra-type-add-open').click();
  await page.locator('#et-fa').fill('جست‌وجوگر');
  await page.locator('#et-en').fill('Search engine');
  await page.locator('#et-key').fill('seo');
  await page.locator('#et-key').press('Enter');
  await expect(page.getByTestId('extra-type')).toHaveCount(11);
  await expect(page.locator('[data-testid="extra-type"][data-key="checklist.seo"]')).toBeVisible();
  // Switched off, never deleted.
  const card = page.locator('[data-testid="extra-type"][data-key="checklist.seo"]');
  await card.getByRole('button', { name: 'Deactivate' }).click();
  await expect(card.locator('.badge')).toHaveText(/Inactive/);
  await page.goto('/fa/desk/templates/handover');
  await expect(page.getByRole('link', { name: 'وابستگی‌های پیش‌فرض' })).toBeVisible();
});

for (const lang of ['fa', 'en'] as const) {
  for (const width of WIDTHS) {
    test(`${lang}, ${width}px: the new controls stay inside the column`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openStep(page, WIZARD_CONTRACT_REF, 'SCOPE', lang);
      await openPanel(page, 'scope-list');
      await page.locator('[data-testid="scope-item"]').first().waitFor();
      await page.getByTestId('extra-add-open').click();
      await expectFits(page, '[data-testid="scope-panel"]');
      await page.keyboard.press('Escape');
      await page.getByTestId('scope-details').first().click();
      await expectFits(page, '[data-testid="scope-panel"]');
      await page.keyboard.press('Escape');

      await gotoTab(page, 'steps', lang);
      await page.locator('.stepper-item[data-step="PHASES"] button').click();
      await openPanel(page, 'phases');
      await page.getByTestId('brief-phase-new-open').click();
      await expectFits(page, '[data-testid="phases-editor"]');
      await page.keyboard.press('Escape');
      await openPanel(page, 'plan');
      if ((await page.getByTestId('plan-row').count()) === 0) await page.getByTestId('plan-propose').click();
      await expectFits(page, '[data-testid="plan-editor"]');
    });
  }
}
