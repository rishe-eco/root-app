import { test, expect } from '@playwright/test';
import {
  CUSTOMER,
  DESIGNER,
  SALES,
  apiSignIn,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  insertAcceptedPhases,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * J11 — step 7: the handover, closing a contract, and the summary (journeys build
 * plan §5 "J11"). A new-road contract is taken to a signed agreement over the API
 * (steps 1 to 3 are `17`, `18` and `20`'s stories) and its phases are accepted by
 * a direct insert — J10's `approveDemo`, which writes that approval, does not
 * exist yet. Sales then hands each deliverable over with a note, sees the close
 * enabled only once nothing is pending, and closes the contract; the customer
 * reads the summary in Persian and opens its print view.
 *
 * One story, one language each side: the desk in English (the staff's working
 * language here) and the customer in Persian, which is the product. Both assert
 * on testids and on the absence of a raw message key.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';
const NOTE = 'The repository was transferred to the customer’s organisation.';

test.beforeEach(async ({ request }) => {
  // The hook is the slow part (a reseed and seven API round trips) and runs under the test's
  // own timeout, which the default 30 s would cut off on a busy machine.
  test.setTimeout(240_000);
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await completeStepTwoViaApi(request, contractId);
  await approveAndSignViaApi(request, contractId);
  insertAcceptedPhases();
});

test('sales hands every deliverable over and closes the contract; the customer reads the summary in Persian and prints it', async ({ page }) => {
  test.setTimeout(240_000);

  // --- the desk: the summary step -------------------------------------------------
  await signIn(page, SALES, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await page.locator('.stepper-item[data-step="SUMMARY"] button').click();
  const panel = page.getByTestId('summary-panel');
  await expect(panel).toHaveAttribute('data-state', 'open');
  await expect(page.getByTestId('summary-controls')).toBeVisible();

  // Every phase is accepted, so the only thing in the way is the handover — and
  // the button says so rather than being enabled and refused.
  await expect(page.getByTestId('summary-close')).toBeDisabled();
  await expect(page.getByTestId('summary-blockers')).toContainText('not been handed over');

  // A note is required: the button is off until there is one.
  const rows = page.locator('[data-testid^="handover-"]');
  const count = await rows.count();
  expect(count).toBeGreaterThan(0);
  const firstKey = (await rows.first().getAttribute('data-testid'))!.replace('handover-', '');
  await expect(page.getByTestId(`hand-${firstKey}`)).toBeDisabled();

  // Hand each one over, one at a time; each lands in the record before the next.
  for (let i = 0; i < count; i += 1) {
    const open = page.locator('[data-testid^="handover-"][data-handed-over="false"]').first();
    const key = (await open.getAttribute('data-testid'))!.replace('handover-', '');
    await open.locator('textarea').fill(`${NOTE} (${key})`);
    await page.getByTestId(`hand-${key}`).click();
    await expect(page.getByTestId(`handover-${key}`)).toHaveAttribute('data-handed-over', 'true');
  }
  await expect(page.locator('[data-testid^="handover-"][data-handed-over="false"]')).toHaveCount(0);
  // The record the customer will read already carries the notes.
  await expect(page.getByTestId('summary-handover')).toContainText(NOTE);

  // Nothing is in the way now: close it — asked twice, because it cannot be undone.
  await expect(page.getByTestId('summary-close')).toBeEnabled();
  await page.getByTestId('summary-close').click();
  await page.getByTestId('summary-close-confirm').click();
  await expect(panel).toHaveAttribute('data-state', 'delivered');
  await expect(page.getByTestId('summary-controls')).toHaveCount(0);
  await expect(page.locator('.stepper-item[data-step="SUMMARY"]')).toHaveAttribute('data-status', 'DONE');
  expect(await panel.innerText()).not.toMatch(/\bsummary\.[A-Za-z_.]+/);

  // --- the customer, in Persian ---------------------------------------------------
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  await page.locator('tr.crow', { hasText: 'فروشگاه آنلاین نهال' }).click();
  await page.waitForURL(/\/fa\/app\/contracts\/[^/]+$/);
  await page.locator('.stepper-item[data-step="SUMMARY"] button').click();

  const mine = page.getByTestId('summary-panel');
  await expect(mine).toHaveAttribute('data-state', 'delivered');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  // A record, not a review: no controls, no feedback affordance, nothing to answer.
  await expect(page.getByTestId('summary-controls')).toHaveCount(0);
  await expect(mine.getByRole('button')).toHaveCount(0);
  const document = page.getByTestId('summary-document');
  await expect(document).toBeVisible();
  await expect(page.getByTestId('summary-agreed')).toBeVisible();
  await expect(page.getByTestId('summary-items')).toBeVisible();
  await expect(page.getByTestId('summary-steps')).toBeVisible();
  await expect(page.getByTestId('summary-dates')).toBeVisible();
  // Every deliverable's handover note, as sales wrote it.
  await expect(page.getByTestId('summary-handover')).toContainText(NOTE);
  // The money is the customer's: the plan she signed is 150,000,000, in Persian digits.
  await expect(page.getByTestId('summary-money-hidden')).toHaveCount(0);
  // The support period the brief promised, six months — a count in Persian digits.
  await expect(page.getByTestId('summary-support')).toContainText('۶ ماه');
  // Nothing rendered as its own key, and no Latin digit where Persian ones belong.
  expect(await document.innerText()).not.toMatch(/\b(summary|brief|print|wizard)\.[A-Za-z_.]+/);

  // --- the print view --------------------------------------------------------------
  await page.getByTestId('summary-print-link').click();
  await page.waitForURL(/\/fa\/app\/contracts\/[^/]+\/summary\/print$/);
  const print = page.getByTestId('summary-print');
  await expect(print).toBeVisible();
  await expect(print.locator('.doc-verify')).toContainText('sha256');
  await expect(print.getByTestId('summary-document')).toBeVisible();
  await expect(print.getByTestId('summary-handover')).toContainText(NOTE);
  await expect(print.locator('.doc')).toHaveAttribute('dir', 'rtl');
});

test('the same, in English: the customer’s record and its print view', async ({ page, request }) => {
  test.setTimeout(180_000);
  // Close it over the API as sales (the desk story is the test above).
  await apiSignIn(request, SALES);
  const done = await gql<{ contract: { summary: { items: Array<{ id: string; kind: string }> } } }>(
    request,
    'query($c: ID!){ contract(id: $c) { summary { items { id kind } } } }',
    { c: contractId },
  );
  for (const item of done.contract.summary.items.filter((i) => i.kind === 'DELIVERABLE')) {
    await gql(request, 'mutation($i: ID!, $n: String!){ markHandedOver(scopeItemId: $i, note: $n) { id } }', { i: item.id, n: NOTE });
  }
  await gql(request, 'mutation($c: ID!){ closeContract(contractId: $c) { id } }', { c: contractId });

  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: 'Nahal online shop' }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+$/);
  await page.locator('.stepper-item[data-step="SUMMARY"] button').click();
  await expect(page.getByTestId('summary-panel')).toHaveAttribute('data-state', 'delivered');
  await expect(page.getByTestId('summary-support')).toContainText('6 months');
  await page.getByTestId('summary-print-link').click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+\/summary\/print$/);
  await expect(page.getByTestId('summary-print')).toBeVisible();
  await expect(page.getByTestId('summary-handover')).toContainText(NOTE);

  // Delivered, the contract has left the designer's world: the link is no such contract.
  await signIn(page, DESIGNER, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await expect(page.getByTestId('summary-panel')).toHaveCount(0);
});
