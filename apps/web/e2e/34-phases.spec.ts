import { test, expect, type Page } from '@playwright/test';
import {
  SALES,
  WIZARD_CONTRACT_REF,
  apiSignIn,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  insertDraftNewRoadContract,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * DX2b — what a phase is (desk UX review 10–12): a phase with "Has a demo" off has
 * no Demo step and, once the agreement is signed, offers Mark phase done; a payment
 * row can fall due on a date. Driven as sales drives it, in both languages and at
 * 360 px and 180 px.
 *
 * One story, in order, on the seeded new-road contract: before signing, the switch
 * and the plan's "on a date" trigger; after signing, Mark phase done.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';
let kickoffId = '';
const WIDTHS = [360, 180] as const;

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  resetTestDatabase();
  insertDraftNewRoadContract();
  contractId = await completeStepOneViaApi(request);
  await apiSignIn(request, SALES);
  // A second phase, which will have no demo; the plan splits the 150,000,000 across both.
  const made = await gql<{ createPhase: { phases: Array<{ id: string; number: number }> } }>(
    request,
    'mutation($c: ID!){ createPhase(contractId: $c, number: 2, titleFa: "آغاز کار", titleEn: "Kick-off", plannedEndAt: "2026-11-12", hasDemo: false) { phases { id number } } }',
    { c: contractId },
  );
  const phases = made.createPhase.phases;
  kickoffId = phases.find((p) => p.number === 2)!.id;
  await gql(request, 'mutation($c: ID!, $r: [PlannedInvoiceInput!]!){ setPaymentPlan(contractId: $c, split: INSTALLMENTS, invoices: $r) { id } }', {
    c: contractId,
    r: [
      { labelFa: 'الف', labelEn: 'First', amount: '75000000', phaseId: phases.find((p) => p.number === 1)!.id, paymentTermDays: 7 },
      { labelFa: 'ب', labelEn: 'Second', amount: '75000000', phaseId: kickoffId, paymentTermDays: 7 },
    ],
  });
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
      if (r.left < -1 || r.right > w + 1) stuck.push(`${el.tagName.toLowerCase()} ${el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 24) ?? ''} [${Math.round(r.left)}..${Math.round(r.right)}] of ${w}`);
    });
    const rect = root?.getBoundingClientRect();
    return { stuck, out: !root || !rect || rect.left < -1 || rect.right > w + 1 || root.scrollWidth > root.clientWidth + 1 };
  }, scope);
  const width = page.viewportSize()?.width;
  expect(result.stuck, `controls outside the column at ${width}px`).toEqual([]);
  expect(result.out, `the column overflows at ${width}px`).toBe(false);
}

async function openPhases(page: Page, lang: 'en' | 'fa' = 'en') {
  await signIn(page, SALES, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: WIZARD_CONTRACT_REF }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
  await page.locator('.stepper-item[data-step="PHASES"] button').click();
  await expect(page.getByTestId('phases-panel')).toBeVisible();
}

test('a phase with "Has a demo" off has no Demo step, and a payment row can be due on a date — in both languages, at 360 and 180 px', async ({ page }) => {
  await openPhases(page);
  // The kick-off phase carries no demo (set over the API above): its switch is off, the other phase's on.
  await expect(page.getByTestId('phase-hasdemo-2')).not.toBeChecked();
  await expect(page.getByTestId('phase-hasdemo-1')).toBeChecked();
  await expect(page.getByTestId('no-demo-badge')).toHaveCount(1);
  // One Demo step, for the phase that has one.
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveCount(1);

  // The switch is edited on the phase row: turning it on gives phase 2 a Demo step, off again takes it away.
  const row = page.locator('[data-testid="brief-phase"][data-number="2"]');
  await page.getByTestId('phase-hasdemo-2').check();
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveCount(2);
  await page.getByTestId('phase-hasdemo-2').uncheck();
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveCount(1);

  // The plan's trigger: the second row moves from "when a phase is done" to "on a date".
  await page.getByTestId('acc-plan').getByRole('button').first().click();
  const second = page.getByTestId('plan-row').nth(1);
  await expect(second.getByTestId('plan-trigger')).toHaveValue('PHASE');
  await second.getByTestId('plan-trigger').selectOption('DATE');
  await expect(second.getByTestId('plan-due-1')).toBeVisible();
  await page.getByTestId('plan-save').click();
  await expect(page.getByTestId('plan-saved')).toBeVisible();
  await expect(page.getByTestId('plan-readout')).toContainText('Due on');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // Persian.
  await page.goto(page.url().replace('/en/', '/fa/'));
  await page.locator('.stepper-item[data-step="PHASES"] button').click();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('no-demo-badge')).toContainText('بدون دمو');
  await expect(page.getByTestId('plan-readout')).toContainText('سررسید در');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});

test('after signing, a no-demo phase offers Mark phase done, and it is done — in both languages, at 360 and 180 px', async ({ page, request }) => {
  test.setTimeout(120_000);
  await completeStepTwoViaApi(request, contractId);
  await approveAndSignViaApi(request, contractId);

  await openPhases(page);
  // The step is locked now (the switch and the plan are frozen), and the done control is still here.
  await expect(page.getByTestId('phases-editors')).toHaveCount(0);
  const controls = page.getByTestId('phase-done-controls');
  await expect(controls).toBeVisible();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  page.once('dialog', (d) => void d.accept());
  await page.getByTestId('phase-done-2').click();
  await expect(page.locator('[data-testid="phase-done-row"][data-number="2"]')).toHaveAttribute('data-done', 'true');
  await expect(controls).toContainText('Done');

  // Persian, same screen.
  await page.goto(page.url().replace('/en/', '/fa/'));
  await page.locator('.stepper-item[data-step="PHASES"] button').click();
  await expect(page.getByTestId('phase-done-controls')).toContainText('انجام‌شده');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
});
