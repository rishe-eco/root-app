import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  SALES,
  WIZARD_CONTRACT_REF,
  WIZARD_CONTRACT_TITLE,
  apiSignIn,
  completeStepOneViaApi,
  gql,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * J5 and J6 — step 2, the scope and the draft, driven the way each side drives
 * it (journeys build plan §5 "J5", "J6").
 *
 * One story, in order, because each part is the next one's precondition. Sales
 * seeds the seeded new-road contract's scope from its site type; the customer
 * asks for a page in Persian; sales confirms it with a bilingual label and the
 * customer sees it agreed; the customer asks for something to come out and is
 * told no, with the reason; sales fills the articles and publishes the draft;
 * the customer reads it, leaves a note on an article, and sees its fate once
 * sales answers; a later version changes that article and the note says so.
 *
 * Step 1 is completed over the API (`completeStepOneViaApi`): `17-requirements`
 * is the spec that fills it in by hand, and this one is about what comes after.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
});

const NOTE = 'Please explain what the timeline covers';

/** A staff member's Steps tab on the seeded contract, opened on the given step. */
async function staffStep(page: Page, step: 'SCOPE' | 'DRAFT') {
  await signIn(page, SALES);
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/steps$/);
  await page.locator(`.stepper-item[data-step="${step}"] button`).click();
  await expect(page.getByTestId(step === 'SCOPE' ? 'scope-panel' : 'draft-panel')).toBeVisible();
}

/** The customer's wizard for the same contract, opened on the given step. */
async function customerStep(page: Page, step: 'SCOPE' | 'DRAFT', lang: 'en' | 'fa' = 'en') {
  await signIn(page, CUSTOMER, lang);
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: lang === 'en' ? WIZARD_CONTRACT_TITLE : 'فروشگاه آنلاین نهال' }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
  await page.locator(`.stepper-item[data-step="${step}"] button`).click();
  await expect(page.getByTestId(step === 'SCOPE' ? 'scope-panel' : 'draft-panel')).toBeVisible();
}

test('sales seeds the scope from the site type, once — and the step is done', async ({ page }) => {
  await staffStep(page, 'SCOPE');
  // Step 1 is complete (over the API), so the road is at the scope.
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.getByTestId('scope-empty')).toBeVisible();

  await page.getByTestId('scope-seed-button').click();
  // The store type's three placeholder items: a page, a feature, a deliverable.
  await expect(page.getByTestId('scope-item')).toHaveCount(3);
  await expect(page.getByTestId('scope-seed')).toHaveCount(0);
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).toHaveAttribute('data-status', 'DONE');
  await expect(page.locator('[data-testid="scope-item"][data-key="placeholder-page"]')).toContainText('Page — placeholder, replace');
});

test('the customer asks for a page in Persian — and sees it waiting for Root', async ({ page }) => {
  await customerStep(page, 'SCOPE', 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // Grouped, in their language: pages, features, deliverables.
  const panel = page.getByTestId('scope-panel');
  await expect(panel.getByText('صفحه‌ها', { exact: true })).toBeVisible();
  await expect(panel.getByText('ویژگی‌ها', { exact: true })).toBeVisible();
  await expect(panel.getByText('تحویلی‌ها', { exact: true })).toBeVisible();

  await page.locator('#scope-ask-text').fill('یک صفحه‌ی وبلاگ');
  await page.getByTestId('scope-ask-submit').click();
  await expect(page.getByTestId('scope-ask-sent')).toBeVisible();
  const mine = page.getByTestId('scope-mine').getByTestId('scope-request');
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText('یک صفحه‌ی وبلاگ');
  await expect(mine.getByTestId('scope-request-state')).toHaveText('منتظر ریشه');
  // The step is no longer done: something is waiting for Root.
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).not.toHaveAttribute('data-status', 'DONE');
  await expect(page.getByTestId('attention-item').filter({ hasText: 'پیشنهادِ تو برای دامنه' })).toBeVisible();
  // A missing key would render as the key itself.
  expect(await page.locator('main, .work, body').first().innerText()).not.toMatch(/\b(scope|draft)\.[A-Za-z_.]+/);
});

test('sales confirms it with a bilingual label — the customer’s words are the Persian one — and the customer sees it agreed', async ({ page }) => {
  await staffStep(page, 'SCOPE');
  const queue = page.getByTestId('scope-queue');
  await expect(queue).toContainText('1 request waiting for a decision');
  // The customer wrote Persian, so that label starts as their words and sales writes the English one.
  await expect(page.getByTestId('scope-label-fa')).toHaveValue('یک صفحه‌ی وبلاگ');
  await expect(page.getByTestId('scope-confirm')).toBeDisabled();
  await page.getByTestId('scope-label-en').fill('Blog page');
  await page.getByTestId('scope-confirm').click();

  await expect(page.getByTestId('scope-queue')).toHaveCount(0);
  const created = page.locator('[data-testid="scope-item"][data-key="custom.1"]');
  await expect(created).toContainText('Blog page');
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).toHaveAttribute('data-status', 'DONE');
  await expect(page.getByTestId('scope-history').getByTestId('scope-request')).toHaveAttribute('data-decision', 'ACCEPTED');

  await customerStep(page, 'SCOPE', 'fa');
  const item = page.locator('[data-testid="scope-item"][data-key="custom.1"]');
  await expect(item).toContainText('یک صفحه‌ی وبلاگ');
  const request = page.getByTestId('scope-mine').getByTestId('scope-request');
  await expect(request).toHaveAttribute('data-decision', 'ACCEPTED');
  await expect(request.getByTestId('scope-request-state')).toContainText('افزوده شد');
  await expect(page.locator('.stepper-item[data-step="SCOPE"]')).toHaveAttribute('data-status', 'DONE');
});

test('the customer asks for something to come out and is told no — with the reason, which they read', async ({ page }) => {
  await customerStep(page, 'SCOPE');
  const feature = page.locator('[data-testid="scope-item"][data-key="placeholder-feature"]');
  const row = page.getByTestId('feedback-target').filter({ has: feature });
  await row.getByTestId('scope-remove').click();
  await row.getByPlaceholder('Why should this come out?').fill('We do not need this one');
  await row.getByRole('button', { name: 'Ask Root to remove it' }).click();
  await expect(row.getByTestId('scope-item-waiting')).toHaveText('Waiting for Root');

  await staffStep(page, 'SCOPE');
  await expect(page.getByTestId('scope-queue')).toContainText('We do not need this one');
  await page.getByTestId('scope-decline').click();
  // A decline needs a reason: the button waits for one.
  await expect(page.getByTestId('scope-decline-send')).toBeDisabled();
  await page.getByTestId('scope-decline-reason').fill('The checkout is what the whole design hangs on.');
  await page.getByTestId('scope-decline-send').click();
  await expect(page.getByTestId('scope-queue')).toHaveCount(0);
  // Nothing left the registry.
  await expect(page.locator('[data-testid="scope-item"][data-key="placeholder-feature"]')).toHaveAttribute('data-status', 'AGREED');

  await customerStep(page, 'SCOPE');
  const declined = page.getByTestId('scope-mine').locator('[data-testid="scope-request"][data-kind="REMOVE"]');
  await expect(declined).toHaveAttribute('data-decision', 'DECLINED');
  await expect(declined.getByTestId('scope-request-state')).toHaveText('Root declined: The checkout is what the whole design hangs on.');
  await expect(page.locator('[data-testid="scope-item"][data-key="placeholder-feature"]')).toHaveAttribute('data-status', 'AGREED');
});

test('sales fills the articles and publishes the draft — the customer sees the planned dates beside it', async ({ page }) => {
  await staffStep(page, 'DRAFT');
  await expect(page.getByTestId('draft-empty')).toBeVisible();
  // Nothing is published, and the articles are empty: the template fills them.
  await page.getByTestId('draft-apply-template').click();
  await expect(page.getByTestId('draft-apply-template')).toHaveCount(0);

  // The planned dates (Q12), proposed with the draft — 1 Azar to 1 Bahman 1405, through the Jalali day input.
  const start = page.getByTestId('draft-date-start');
  await start.locator('select[data-part="jy"]').selectOption('1405');
  await start.locator('select[data-part="jm"]').selectOption('9');
  await start.locator('select[data-part="jd"]').selectOption('1');
  await expect(start).toHaveAttribute('data-value', '2026-11-22');
  const end = page.getByTestId('draft-date-end');
  await end.locator('select[data-part="jy"]').selectOption('1405');
  await end.locator('select[data-part="jm"]').selectOption('11');
  await end.locator('select[data-part="jd"]').selectOption('1');
  await expect(end).toHaveAttribute('data-value', '2027-01-21');
  await page.getByTestId('draft-dates-save').click();
  await expect(page.getByTestId('draft-dates-saved')).toBeVisible();

  await page.getByTestId('draft-publish').click();
  await expect(page.getByTestId('draft-published')).toBeVisible();
  await expect(page.getByTestId('draft-version')).toContainText('Version v1');
  await expect(page.locator('.stepper-item[data-step="DRAFT"]')).toHaveAttribute('data-status', 'DONE');

  await customerStep(page, 'DRAFT');
  await expect(page.getByTestId('draft-version')).toContainText('Version v1 · 15 articles');
  const dates = page.getByTestId('draft-dates');
  await expect(dates).toContainText('Nov 22, 2026');
  await expect(dates).toContainText('Jan 21, 2027');
  // D-5: the template names the customer, not somebody else's client, and no placeholder is left.
  const first = page.getByTestId('feedback-target').first();
  await expect(first).toContainText('(the Client) and Root (the Provider)');
  await expect(first).toContainText('استودیو نهال');
  expect(await page.getByTestId('draft-panel').innerText()).not.toMatch(/\{\{/);
});

test('the customer leaves a note on an article and sees its fate once sales answers', async ({ page }) => {
  await customerStep(page, 'DRAFT');
  const article3 = page.locator('[data-testid="feedback-target"][data-key="article:3"]');
  // The article's heading names it; its text is what the note is about.
  await expect(page.getByTestId('draft-panel').getByText('3. Timeline & Milestones', { exact: true })).toBeVisible();
  await expect(article3).toContainText('Work proceeds in defined phases');
  await article3.getByRole('button', { name: 'Add feedback' }).click();
  await article3.getByPlaceholder('What did you notice?').fill(NOTE);
  await article3.getByRole('button', { name: 'Submit' }).click();
  const note = page.getByTestId('feedback-target').filter({ hasText: NOTE });
  await expect(note.getByTestId('feedback-status')).toHaveText('Open');
  await expect(note.getByTestId('draft-note-caption')).toContainText('Written on v1');
  // The step is not done while a note waits for Root.
  await expect(page.locator('.stepper-item[data-step="DRAFT"]')).not.toHaveAttribute('data-status', 'DONE');

  await staffStep(page, 'DRAFT');
  const theirs = page.getByTestId('feedback-target').filter({ hasText: NOTE });
  await theirs.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(theirs.getByText('The customer sees your answer at once.')).toBeVisible();
  await theirs.getByPlaceholder('Your answer').fill('It covers the phases, not the support period.');
  await theirs.locator('#answer-resolution').selectOption('ADDRESSED');
  await theirs.getByRole('button', { name: 'Send answer' }).click();
  await expect(theirs.getByTestId('feedback-status')).toHaveText('Addressed');
  await expect(page.locator('.stepper-item[data-step="DRAFT"]')).toHaveAttribute('data-status', 'DONE');

  await customerStep(page, 'DRAFT');
  const seen = page.getByTestId('feedback-target').filter({ hasText: NOTE });
  await expect(seen.getByTestId('feedback-status')).toHaveText('Addressed');
  await expect(seen).toContainText('It covers the phases, not the support period.');
});

test('a later version changes that article — the note says so, in the customer’s own language too', async ({ page, request }) => {
  // Sales rewrites article 3 and publishes v2 (the article editor is the Contract tab's; this is the change, not the subject).
  await apiSignIn(request, SALES);
  await gql(
    request,
    'mutation($c: ID!){ setArticle(contractId: $c, number: 3, titleFa: "زمان‌بندی و مراحل", titleEn: "Timeline & Milestones", bodyFa: "متن تازه", bodyEn: "A rewritten timeline clause") { id } }',
    { c: contractId },
  );

  await staffStep(page, 'DRAFT');
  await page.getByTestId('draft-publish').click();
  await expect(page.getByTestId('draft-published')).toBeVisible();

  await customerStep(page, 'DRAFT');
  await expect(page.getByTestId('draft-version')).toContainText('Version v2');
  const note = page.getByTestId('feedback-target').filter({ hasText: NOTE });
  await expect(note.getByTestId('draft-changed')).toHaveText('Changed in v2');
  await expect(note.getByTestId('draft-note-caption')).toContainText('Written on v1');
  // Its thread is unchanged, and the article now carries the new text.
  await expect(note.getByTestId('feedback-status')).toHaveText('Addressed');
  await expect(note).toContainText('A rewritten timeline clause');
  // The other articles' blank note boxes are anchored to v2; article 3 also offers a new one.
  await expect(page.locator('[data-testid="feedback-target"][data-key="article:3"]')).toContainText('A new note on v2');

  // The same page in Persian: right-to-left, every string translated.
  await customerStep(page, 'DRAFT', 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('draft-changed')).toHaveText('در v2 تغییر کرد');
  expect(await page.locator('main, .work, body').first().innerText()).not.toMatch(/\b(scope|draft|feedback)\.[A-Za-z_.]+/);
});
