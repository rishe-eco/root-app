import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  DESIGNER,
  DRAFT_CONTRACT_REF,
  DRAFT_CONTRACT_TITLE,
  SALES,
  WIZARD_CONTRACT_REF,
  WIZARD_CONTRACT_TITLE,
  insertDraftNewRoadContract,
  resetTestDatabase,
  signIn,
  expectSaved,
  fillTitle,
} from './helpers';

/**
 * J4 — step 1, requirements, driven the way each side drives it (journeys build
 * plan §5 "J4").
 *
 * One story, in order, because each part is the next one's precondition: sales
 * fills step 1 for the seeded `AGREEMENT_FIRST` contract from the desk — the
 * brief, dated commitments, a phase, a payment plan, an extra — until the wizard
 * calls the step done; the customer reads it in Persian, with their commitments
 * and every date in the Jalali calendar, and comments on a field; a designer
 * reads the same step and is not shown a Toman of it; and a contract that has
 * not been handed over is refused (`BRIEF_MISSING`) until it has a brief, then
 * handed over and read.
 *
 * **Dates:** the day input is one text field (DX1); a Jalali day is typed into it
 * (the English panel accepts both calendars), and its `data-value` is the
 * Gregorian day it means — so this asserts the conversion as well as the
 * rendering (1 Aban 1405 is 2026-10-23).
 *
 * **Panels** are accordions (DX1) — `openPanel`. **DX2a** moved the phases and
 * the payment plan to their own step (Phases and payment) and the extras to Pages
 * and features, so this story now visits three steps: Requirements for the brief,
 * Phases and payment for the phases and the plan, Pages and features for the extra.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
  insertDraftNewRoadContract();
});

/** Types a Jalali day into a `DayInput` and checks the Gregorian day it stands for. */
async function pickDay(page: Page, testId: string, [year, month, day]: [number, number, number], gregorian: string) {
  const box = page.getByTestId(testId);
  await box.locator('input[data-part="text"]').fill(`${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`);
  await expect(box).toHaveAttribute('data-value', gregorian);
}

/** Opens an accordion panel if it is closed (`brief`, `handover`, `handOver` on Requirements; `phases`, `plan` on Phases and payment). */
async function openPanel(page: Page, id: string) {
  const panel = page.getByTestId(`acc-${id}`);
  if ((await panel.getAttribute('data-open')) !== 'true') await panel.getByRole('button').first().click();
  await expect(panel).toHaveAttribute('data-open', 'true');
}

/** Presses + on a count stepper `times` times. */
async function stepUp(page: Page, testId: string, times: number) {
  for (let i = 0; i < times; i += 1) await page.getByTestId(testId).getByRole('button', { name: /^Increase/ }).click();
}

/** A staff member's Steps tab for a contract, by the ref the desk list shows. */
async function staffSteps(page: Page, who: typeof SALES, ref: string) {
  await signIn(page, who);
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: ref }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/steps$/);
  // The tab opens on the *current* step, which is no longer this one once it is done.
  await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
  await expect(page.getByTestId('requirements-panel')).toBeVisible();
}

const requirementsStep = (page: Page) => page.locator('.stepper-item[data-step="REQUIREMENTS"]');
const stepItem = (page: Page, step: string) => page.locator(`.stepper-item[data-step="${step}"]`);

test('sales fills step 1 from the desk, and the wizard calls it done once nothing is missing', async ({ page }) => {
  await staffSteps(page, SALES, WIZARD_CONTRACT_REF);

  // Nothing yet: the list says what a brief needs, for staff.
  await expect(page.getByTestId('requirements-editor')).toBeVisible();
  await expect(page.getByTestId('brief-missing').locator('[data-code="BRIEF"]')).toBeVisible();
  await expect(requirementsStep(page)).toHaveAttribute('data-status', 'CURRENT');

  // The brief.
  await page.locator('#brief-type').selectOption({ label: 'Store' });
  await page.locator('#brief-budget').fill('150000000');
  await pickDay(page, 'brief-ideal', [1405, 7, 1], '2026-09-23'); // 1 Mehr 1405
  await pickDay(page, 'brief-hard', [1405, 8, 1], '2026-10-23'); // 1 Aban 1405
  await page.getByTestId('brief-support-pills').getByRole('button', { name: '6 months' }).click();
  await page.locator('#brief-domain-name').fill('nahal.ir');
  await stepUp(page, 'brief-premade', 2);
  await stepUp(page, 'brief-demos', 2);
  // DX4 (review 27): the brief saves as its fields are left (a stepper or a pill at once), with no Save button.
  await expect(page.getByTestId('brief-save')).toHaveCount(0);
  await expectSaved(page, 'brief-autosave');

  // The first save made the handover list (DX3a): one undecided, undated row for each item on the desk's default
  // list — and an undecided list is a complete one, since no provider is required. Sales then says who provides each
  // thing, and by when; the pills are Root · Customer · Not needed, and a second press clears one.
  await openPanel(page, 'handover');
  await expect(page.getByTestId('handover-row')).toHaveCount(3);
  const domainWho = page.getByTestId('handover-side-domain');
  await domainWho.getByRole('button', { name: 'Root' }).click();
  await expect(domainWho).toHaveAttribute('data-value', 'ROOT');
  await domainWho.getByRole('button', { name: 'Root' }).click();
  await expect(domainWho).toHaveAttribute('data-value', '');
  await domainWho.getByRole('button', { name: 'Customer' }).click();
  await page.getByTestId('handover-side-host').getByRole('button', { name: 'Root' }).click();
  await page.getByTestId('handover-side-content').getByRole('button', { name: 'Customer' }).click();
  await pickDay(page, 'handover-due-domain', [1405, 8, 5], '2026-10-27');
  await pickDay(page, 'handover-due-host', [1405, 8, 6], '2026-10-28');
  await pickDay(page, 'handover-due-content', [1405, 8, 10], '2026-11-01');
  await page.getByTestId('handover-due-content').locator('input[data-part="text"]').blur();
  await expectSaved(page, 'handover-autosave');

  // The brief is a brief now, and Requirements is done on the brief alone (DX2a): the phases and the plan
  // are the next step's to name, and it counts them on its pill.
  const missing = page.getByTestId('brief-missing');
  await expect(missing.locator('[data-code="BRIEF"]')).toHaveCount(0);
  await expect(missing.locator('[data-code="PHASES"]')).toHaveCount(0);
  await expect(requirementsStep(page)).toHaveAttribute('data-status', 'DONE');
  await expect(stepItem(page, 'PHASES').getByTestId('pill-missing')).toBeVisible();

  // Phases and payment: the step names what is left, and a phase gets its planned end (1 Azar 1405).
  await stepItem(page, 'PHASES').locator('button').click();
  const phasesPanel = page.getByTestId('phases-panel');
  await expect(phasesPanel.getByTestId('plan-missing').locator('[data-code="PHASES"]')).toBeVisible();
  await expect(phasesPanel.getByTestId('plan-missing').locator('[data-code="PAYMENT_PLAN"]')).toBeVisible();
  await openPanel(page, 'phases');
  const newPhase = page.getByTestId('brief-phase-new');
  await fillTitle(newPhase, 'phase-new', 'phase-title-new', 'فاز اول', 'First phase');
  await pickDay(page, 'phase-end-new', [1405, 9, 1], '2026-11-22');
  await newPhase.getByRole('button', { name: 'Add phase' }).click();
  await expect(page.getByTestId('brief-phase')).toHaveCount(1);
  await expect(phasesPanel.getByTestId('plan-missing').locator('[data-code="PHASES"]')).toHaveCount(0);

  // The payment plan: the split proposes rows, sales edits them (there is no fee on this
  // contract yet, so the proposal leaves the amounts blank), and they are stored as typed.
  await openPanel(page, 'plan');
  const plan = page.getByTestId('plan-editor');
  await plan.getByLabel('Split', { exact: true }).selectOption('INSTALLMENTS');
  await plan.getByLabel('Number of rows').fill('2');
  await page.getByTestId('plan-propose').click();
  await expect(page.getByTestId('plan-row')).toHaveCount(2);
  await page.getByTestId('plan-row').nth(0).getByLabel('Amount (Toman)').fill('90000000');
  await page.getByTestId('plan-row').nth(1).getByLabel('Amount (Toman)').fill('60000000');
  await page.getByTestId('plan-row').nth(1).getByLabel('Amount (Toman)').blur();
  await expectSaved(page, 'plan-autosave');

  // Nothing is missing: the step is done, and the road moves on to the scope (nothing there yet).
  await expect(page.getByTestId('plan-missing')).toHaveCount(0);
  await expect(stepItem(page, 'PHASES')).toHaveAttribute('data-status', 'DONE');
  await expect(stepItem(page, 'SCOPE')).toHaveAttribute('data-status', 'CURRENT');
  // The pill carries no count any more, and the step says how much of the price the plan covers.
  await expect(stepItem(page, 'PHASES').getByTestId('pill-missing')).toHaveCount(0);

  // An extra — now a checkbox in Pages and features — that needs the customer to bring something becomes a
  // commitment on Requirements that wants a date.
  // (A click and then a wait, not `check()`: the box is controlled, so it only flips once the server has answered.)
  await stepItem(page, 'SCOPE').locator('button').click();
  const payment = page.getByTestId('scope-panel').locator('input[data-key="checklist.payment"]');
  await payment.click();
  await expect(payment).toBeChecked();
  await requirementsStep(page).locator('button').click();
  await expect(missing.locator('[data-code="COMMITMENT_UNDATED"]')).toContainText('Payment gateway account');
  await openPanel(page, 'handover');
  await expect(page.getByTestId('handover-row')).toHaveCount(4);
  await pickDay(page, 'handover-due-gateway', [1405, 8, 15], '2026-11-06');
  await page.getByTestId('handover-due-gateway').locator('input[data-part="text"]').blur();
  await expectSaved(page, 'handover-autosave');
  await expect(page.getByTestId('brief-missing')).toHaveCount(0);

  // What sales typed is what the readout below says — the same cards the customer reads.
  await expect(page.locator('[data-field="hardDeadline"]')).toContainText('Oct 23, 2026');
  await expect(page.locator('[data-field="gateway"]')).toContainText('Nov 6, 2026');
  await expect(page.locator('[data-field="budgetCap"]')).toContainText('150,000,000 Toman');
  await stepItem(page, 'PHASES').locator('button').click();
  await expect(page.getByTestId('plan-readout')).toContainText('90,000,000 Toman');
});

test('the customer reads it in Persian — commitments and dates in the Jalali calendar — and comments on a field', async ({ page }) => {
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  await page.locator('tr.crow', { hasText: 'فروشگاه آنلاین نهال' }).click();
  await page.waitForURL(/\/fa\/app\/contracts\/[^/]+$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await requirementsStep(page).locator('button').click();

  const panel = page.getByTestId('requirements-panel');
  await expect(panel).toBeVisible();
  // The customer reads; they do not author.
  await expect(page.getByTestId('requirements-editor')).toHaveCount(0);

  // Dates are days, in Jalali, exactly as chosen: 1 Aban 1405 is not 30 Mehr.
  await expect(panel.locator('[data-field="hardDeadline"]')).toContainText('۱ آبان ۱۴۰۵');
  await expect(panel.locator('[data-field="idealDeadline"]')).toContainText('۱ مهر ۱۴۰۵');
  await expect(panel.locator('[data-field="idealDeadline"]')).not.toContainText('شهریور');

  // The handover items, each with who provides it and its due date — one list, the customer's and Root's together.
  await expect(panel.getByText('چه کسی چه چیزی را تأمین می‌کند', { exact: true })).toBeVisible();
  await expect(panel.locator('[data-field="domain"]')).toContainText('nahal.ir');
  await expect(panel.locator('[data-field="domain"]').getByTestId('handover-who')).toHaveText('مشتری');
  await expect(panel.locator('[data-field="domain"]').getByTestId('commitment-due')).toHaveText('مهلت: ۵ آبان ۱۴۰۵');
  await expect(panel.locator('[data-field="content"]').getByTestId('commitment-due')).toHaveText('مهلت: ۱۰ آبان ۱۴۰۵');
  await expect(panel.locator('[data-field="gateway"]').getByTestId('commitment-due')).toHaveText('مهلت: ۱۵ آبان ۱۴۰۵');
  await expect(panel.locator('[data-field="host"]').getByTestId('handover-who')).toHaveText('ریشه');

  // Money is the customer's own to read: in Persian digits, with the unit.
  await expect(panel.locator('[data-field="budgetCap"]')).toContainText('۱۵۰٬۰۰۰٬۰۰۰ تومان');

  // The phases and the plan are the next step's now (DX2a), with the same cards and the same notes.
  await stepItem(page, 'PHASES').locator('button').click();
  const phasesPanel = page.getByTestId('phases-panel');
  await expect(phasesPanel.getByTestId('phases-readout')).toContainText('۱ آذر ۱۴۰۵');
  await expect(phasesPanel.getByTestId('plan-readout')).toContainText('۹۰٬۰۰۰٬۰۰۰ تومان');
  // …and the extras are a group in Pages and features.
  await stepItem(page, 'SCOPE').locator('button').click();
  await expect(page.getByTestId('scope-panel').locator('[data-testid="scope-extra"][data-key="checklist.payment"]')).toContainText('درگاه پرداخت');
  await requirementsStep(page).locator('button').click();

  // A note on a field: one thread, open until Root answers.
  const hard = panel.locator('[data-key="hardDeadline"]');
  await hard.getByRole('button', { name: 'ثبتِ بازخورد' }).click();
  await hard.getByPlaceholder('چه چیزی توجهت را جلب کرد؟').fill('این تاریخ برای ما زود است');
  await hard.getByRole('button', { name: 'ارسال' }).click();
  await expect(hard.getByTestId('feedback-thread')).toContainText('این تاریخ برای ما زود است');
  await expect(hard.getByTestId('feedback-status')).toBeVisible();

  // Nothing untranslated leaks through.
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/\b(brief|jalali)\.[A-Za-z_.]+/);
});

test('the same step in English: Gregorian days, and Root answers the note in place', async ({ page }) => {
  await signIn(page, CUSTOMER);
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_TITLE }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+$/);
  await requirementsStep(page).locator('button').click();
  const panel = page.getByTestId('requirements-panel');
  await expect(panel.locator('[data-field="hardDeadline"]')).toContainText('Oct 23, 2026');
  await expect(panel.locator('[data-field="domain"]').getByTestId('commitment-due')).toHaveText('due Oct 27, 2026');
  // Their note is there, and open.
  await expect(panel.locator('[data-key="hardDeadline"]').getByTestId('feedback-status')).toHaveText('Open');

  // Sales answers it where it was written.
  await staffSteps(page, SALES, WIZARD_CONTRACT_REF);
  const hard = page.locator('[data-key="hardDeadline"]');
  await expect(hard).toContainText('این تاریخ برای ما زود است');
  await hard.getByRole('button', { name: 'Answer', exact: true }).click();
  await hard.getByPlaceholder('Your answer').fill('We can move it to the 15th of Aban');
  await hard.locator('#answer-resolution').selectOption('ADDRESSED');
  await hard.getByRole('button', { name: 'Send answer' }).click();
  await expect(hard.getByTestId('feedback-status')).toHaveText('Addressed');
});

test('a designer reads step 1 and is shown none of its money — no budget, no payment plan', async ({ page }) => {
  await staffSteps(page, DESIGNER, WIZARD_CONTRACT_REF);
  const panel = page.getByTestId('requirements-panel');
  // The rest of the brief is theirs to read…
  await expect(panel.locator('[data-field="hardDeadline"]')).toContainText('Oct 23, 2026');
  await expect(panel.locator('[data-field="templateType"]')).toContainText('Store');
  // …and the money is not drawn at all, nor is the form (they author nothing here).
  await expect(panel.locator('[data-field="budgetCap"]')).toHaveCount(0);
  await expect(panel.locator('[data-field="paymentPlan"]')).toHaveCount(0);
  await expect(page.getByTestId('requirements-editor')).toHaveCount(0);
  await expect(panel).not.toContainText('150,000,000');
  // Phases and payment: the phases are theirs to read; the plan and the allocation line are money, and not drawn.
  await stepItem(page, 'PHASES').locator('button').click();
  const phasesPanel = page.getByTestId('phases-panel');
  await expect(phasesPanel.getByTestId('phases-readout')).toBeVisible();
  await expect(phasesPanel.getByTestId('plan-readout')).toHaveCount(0);
  await expect(phasesPanel.getByTestId('plan-allocated')).toHaveCount(0);
  await expect(page.getByTestId('plan-editor')).toHaveCount(0);
  await expect(phasesPanel).not.toContainText('90,000,000');
});

test('a contract that has not been handed over is refused without a brief, then handed over and read by the customer', async ({ page }) => {
  await staffSteps(page, SALES, DRAFT_CONTRACT_REF);
  await expect(page.getByTestId('not-handed-over')).toBeVisible();

  // No brief: the refusal is a sentence, not a code.
  await openPanel(page, 'handOver');
  await page.getByTestId('hand-over-button').click();
  await expect(page.getByTestId('hand-over-error')).toContainText('Fill in the requirements');

  // The kind of site and its type are all a brief needs to be handed over.
  await page.locator('#brief-type').selectOption({ label: 'Store' });
  await expectSaved(page, 'brief-autosave');
  await page.getByTestId('hand-over-button').click();
  await expect(page.getByTestId('hand-over')).toHaveCount(0);
  await expect(page.getByTestId('not-handed-over')).toHaveCount(0);

  // The customer now has it — and what is still open is named, not hidden.
  await signIn(page, CUSTOMER);
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: DRAFT_CONTRACT_TITLE }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+$/);
  const panel = page.getByTestId('requirements-panel');
  await expect(panel.getByTestId('brief-missing')).toContainText('Root is completing this');
  await expect(panel.getByTestId('brief-missing').locator('[data-code="BUDGET_CAP"]')).toBeVisible();
  await expect(panel.locator('[data-field="templateType"]')).toContainText('Store');
});
