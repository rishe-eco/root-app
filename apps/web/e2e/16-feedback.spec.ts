import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  DESIGNER,
  DEVELOPER,
  SALES,
  WIZARD_CONTRACT_REF,
  WIZARD_CONTRACT_TITLE,
  insertPublishedDemo,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * S2 — the feedback panel, driven end to end (journeys build plan §5 "S2"; the
 * first spec that drives it at all, lifecycle plan §0.3.3).
 *
 * One story, told in order, because each step is the next one's precondition:
 * the customer comments on a demo page; the developer answers directly and the
 * customer reads it; the customer reopens; **the customer cannot approve the
 * step while an item is open**; a designer's answer outside their own step
 * waits, invisible to the customer, until sales sends it back with a reason
 * the designer reads; then everything is resolved, the customer approves, and
 * the step locks — in both languages.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
  insertPublishedDemo();
});

const HOME = '[data-key="page:e2e-page-home"]';
const ABOUT = '[data-key="page:e2e-page-about"]';

/** The customer's wizard for the seeded new-road contract, on its demo step. */
async function customerDemoStep(page: Page, lang = 'en') {
  await signIn(page, CUSTOMER, lang);
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: lang === 'en' ? WIZARD_CONTRACT_TITLE : 'فروشگاه آنلاین نهال' }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
  await page.locator('.stepper-item[data-step="DEMO"] button').click();
  await expect(page.getByTestId('feedback-panel')).toBeVisible();
}

/** A staff member's Phases tab on the same contract — where the demo is answered. */
async function staffPhases(page: Page, who: typeof DEVELOPER) {
  await signIn(page, who);
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).locator('td').first().click();
  await page.locator('.workspace-tab', { hasText: 'Phases' }).click();
  await expect(page.getByTestId('feedback-panel')).toBeVisible();
}

async function comment(page: Page, target: string, body: string, opener: string) {
  const t = page.locator(target);
  await t.getByRole('button', { name: opener }).click();
  await t.getByPlaceholder('What did you notice?').fill(body);
  await t.getByRole('button', { name: 'Submit' }).click();
}

async function answer(page: Page, target: string, body: string, resolution: 'ADDRESSED' | 'DECLINED' | null) {
  const t = page.locator(target);
  await t.getByRole('button', { name: 'Answer', exact: true }).click();
  await t.getByPlaceholder('Your answer').fill(body);
  if (resolution) await t.locator('#answer-resolution').selectOption(resolution);
  await t.getByRole('button', { name: 'Send answer' }).click();
}

test('the customer comments on a demo page and sees it open', async ({ page }) => {
  await customerDemoStep(page);
  await comment(page, HOME, 'The hero image is blurry', 'Add feedback');
  const thread = page.locator(HOME).getByTestId('feedback-thread');
  await expect(thread.getByTestId('feedback-status')).toHaveText('Open');
  await expect(thread).toContainText('The hero image is blurry');
  // Persists: a fresh load shows the same thread.
  await page.reload();
  await page.locator('.stepper-item[data-step="DEMO"] button').click();
  await expect(page.locator(HOME).getByTestId('feedback-status')).toHaveText('Open');
});

test('the developer answers directly — the box says the customer sees it at once — and the customer reads it', async ({ page }) => {
  await staffPhases(page, DEVELOPER);
  await page.locator(HOME).getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.locator(HOME).getByText('The customer sees your answer at once.')).toBeVisible();
  await page.locator(HOME).getByRole('button', { name: 'Cancel' }).click();
  await answer(page, HOME, 'Sharper image is in the next build', 'ADDRESSED');
  await expect(page.locator(HOME).getByTestId('feedback-status')).toHaveText('Addressed');

  await customerDemoStep(page);
  const thread = page.locator(HOME).getByTestId('feedback-thread');
  await expect(thread.getByTestId('feedback-status')).toHaveText('Addressed');
  await expect(thread).toContainText('Sharper image is in the next build');
});

test('the customer reopens — the box says so — and cannot approve the step while an item is open', async ({ page }) => {
  await customerDemoStep(page);
  const home = page.locator(HOME);
  await home.getByRole('button', { name: 'Reply and reopen' }).click();
  await expect(home.getByText('Root marked this addressed. Replying reopens it.')).toBeVisible();
  await home.getByPlaceholder('What did you notice?').fill('Still blurry on my phone');
  await home.getByRole('button', { name: 'Submit' }).click();
  await expect(home.getByTestId('feedback-status')).toHaveText('Open');

  await expect(page.getByTestId('feedback-open-count')).toContainText('1 comment is still waiting');
  await page.getByTestId('approve-step').click();
  await expect(page.getByTestId('approve-error')).toContainText('still waiting for Root’s answer');
  // Nothing was approved: the comment box is still there and the step is not done.
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).not.toHaveAttribute('data-status', 'DONE');
});

test('a designer’s answer outside their step waits, invisible to the customer; sales sends it back with a reason the designer reads', async ({
  page,
}) => {
  // The customer raises a second item.
  await customerDemoStep(page);
  await comment(page, ABOUT, 'Add the team photo', 'Add feedback');
  await expect(page.locator(ABOUT).getByTestId('feedback-status')).toHaveText('Open');

  // The designer answers in the demo — a step that is the developer's, so it needs approval, and says so.
  await staffPhases(page, DESIGNER);
  await page.locator(ABOUT).getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.locator(ABOUT).getByText(/waits for sales to approve it/)).toBeVisible();
  await page.locator(ABOUT).getByRole('button', { name: 'Cancel' }).click();
  await answer(page, ABOUT, 'We will add the photo', 'ADDRESSED');
  await expect(page.locator(ABOUT)).toContainText('Waiting for sales to approve');
  await expect(page.locator(ABOUT).getByTestId('feedback-status')).toHaveText('Open');

  // The customer sees only their own comment.
  await customerDemoStep(page);
  await expect(page.locator(ABOUT).getByTestId('feedback-thread')).not.toContainText('We will add the photo');
  await expect(page.locator(ABOUT).getByTestId('feedback-status')).toHaveText('Open');

  // Sales' queue holds it; declining needs a reason.
  await signIn(page, SALES);
  await page.locator('.desk-nav').getByText('Approvals', { exact: true }).click();
  const card = page.getByTestId('approval-card');
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('approval-body')).toHaveText('We will add the photo');
  await card.getByRole('button', { name: 'Send back…' }).click();
  await card.getByRole('button', { name: 'Send it back' }).click();
  await expect(card.getByText('Say why — its author will read it.')).toBeVisible();
  await card.getByLabel('Why (its author will read this)').fill('Photos are the customer’s to send.');
  await card.getByRole('button', { name: 'Send it back' }).click();
  await expect(page.getByText('Nothing is waiting for approval.')).toBeVisible();

  // The designer sees why; the customer still sees nothing of it.
  await staffPhases(page, DESIGNER);
  await expect(page.locator(ABOUT)).toContainText('Sent back. Reason: Photos are the customer’s to send.');
  await customerDemoStep(page);
  await expect(page.locator(ABOUT).getByTestId('feedback-thread')).not.toContainText('We will add the photo');
});

test('once everything is answered the customer approves the step, and it locks', async ({ page }) => {
  await staffPhases(page, DEVELOPER);
  await answer(page, HOME, 'Fixed for phones too', 'ADDRESSED');
  await answer(page, ABOUT, 'Send us the photo and we will add it', 'DECLINED');

  await customerDemoStep(page);
  await expect(page.getByTestId('feedback-open-count')).toHaveCount(0);
  await page.getByTestId('approve-step').click();
  await expect(page.getByTestId('feedback-approve')).toContainText('This step is approved. To change anything now, open a change request.');
  // Approved: no more comment or reopen controls anywhere on the step.
  await expect(page.getByRole('button', { name: 'Reply and reopen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add feedback' })).toHaveCount(0);
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveAttribute('data-status', 'DONE');
  // Accepted, and the declined one kept its status.
  await expect(page.locator(HOME).getByTestId('feedback-status')).toHaveText('Accepted');
  await expect(page.locator(ABOUT).getByTestId('feedback-status')).toHaveText('Declined');

  // The developer, too, is told the step is closed: no answer box.
  await staffPhases(page, DEVELOPER);
  await expect(page.locator(HOME).getByRole('button', { name: 'Answer', exact: true })).toHaveCount(0);
});

test('the same panel in Persian: right-to-left, translated, and locked', async ({ page }) => {
  await customerDemoStep(page, 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const panel = page.getByTestId('feedback-panel');
  await expect(panel.getByText('کلِ این مرحله')).toBeVisible();
  await expect(panel.getByTestId('feedback-approve')).toContainText('این مرحله تأییدشده است');
  await expect(page.locator(HOME).getByTestId('feedback-status')).toHaveText('پذیرفته‌شده');
  await expect(page.locator(ABOUT).getByTestId('feedback-status')).toHaveText('ردشده');
  // A missing key would render as the key itself.
  const text = await page.getByTestId('step-panel').innerText();
  expect(text).not.toMatch(/\bfeedback\.[A-Za-z_.]+/);
});
