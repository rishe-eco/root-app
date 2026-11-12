import { test, expect, type Page } from '@playwright/test';
import {
  CUSTOMER,
  SALES,
  apiSignIn,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * CC1 — sales renames a contract from the Steps tab's draft step, and moves
 * it to another customer from the workspace header; once the customer has
 * approved, the move is refused with a sentence saying why.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';
/** A contract on a project of its own — the seeded one shares its project, and that is PROJECT_SHARED. */
let soloId = '';
const OTHER = 'Kaveh Other';

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await completeStepTwoViaApi(request, contractId);
  await apiSignIn(request, SALES);
  await gql(request, 'mutation{ inviteCustomer(phone: "09120000777", name: "Kaveh Other", clientName: "Kaveh Co") { userId } }');
  const { allCustomers } = await gql<{ allCustomers: Array<{ id: string; email: string | null }> }>(request, '{ allCustomers { id email } }');
  const nahal = allCustomers.find((c) => c.email === CUSTOMER.email)!;
  const created = await gql<{ createContract: { id: string } }>(
    request,
    'mutation($u: ID!){ createContract(input: { customerId: $u, ref: "RC-CC1-SOLO", titleFa: "قرارداد تنها", titleEn: "Solo contract" }) { id } }',
    { u: nahal.id },
  );
  soloId = created.createContract.id;
});

async function workspace(page: Page, lang: 'en' | 'fa' = 'en', id = contractId) {
  await signIn(page, SALES, lang);
  await page.goto(`/${lang}/desk/contracts/${id}/steps`);
  await expect(page.getByTestId('contract-customer')).toBeVisible();
}

test('the title is editable on the draft step itself, and the header follows', async ({ page }) => {
  await workspace(page);
  await page.locator('.stepper-item[data-step="DRAFT"] button').click();
  const panel = page.getByTestId('draft-panel');
  await panel.locator('#ct-en').fill('Nahal online shop, renamed');
  await panel.getByTestId('title-fee-save').click();
  await expect(page.locator('.workspace-head h2')).toHaveText('Nahal online shop, renamed');
});

test('sales moves a contract to another customer and back; the line names who it is for', async ({ page }) => {
  await workspace(page, 'en', soloId);
  await expect(page.getByTestId('contract-customer')).toContainText('استودیو نهال');

  await page.getByTestId('change-customer').click();
  const form = page.getByTestId('change-customer-form');
  await form.locator('select').selectOption({ label: `Kaveh Co · ${OTHER}` });
  page.once('dialog', (d) => d.accept());
  await form.getByRole('button', { name: 'Move to this customer' }).click();
  await expect(page.getByTestId('contract-customer')).toContainText('Kaveh Co');

  await page.getByTestId('change-customer').click();
  await page.getByTestId('change-customer-form').locator('select').selectOption({ label: 'استودیو نهال · نهال رضایی' });
  page.once('dialog', (d) => d.accept());
  await page.getByTestId('change-customer-form').getByRole('button', { name: 'Move to this customer' }).click();
  await expect(page.getByTestId('contract-customer')).toContainText('استودیو نهال');

  // The activity log records both moves. (The desk's Activity tab prints raw
  // action names for every action — a gap older than this change.)
  await page.goto(`/en/desk/contracts/${soloId}/activity`);
  await expect(page.getByText(/Customer Changed$/)).toHaveCount(2);
});

test('once the customer approves, the move is refused — and the refusal says why, in both languages', async ({ page, request }) => {
  // The rename above left the draft ahead of what the customer read: publish it,
  // or approving would be REVISION_STALE.
  await apiSignIn(request, SALES);
  await gql(request, 'mutation($c: ID!){ publishContractRevision(contractId: $c) { id } }', { c: contractId });

  await signIn(page, CUSTOMER);
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: 'renamed' }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+$/);
  await page.getByTestId('agreement-approve').click();
  await expect(page.getByTestId('agreement-panel')).toHaveAttribute('data-state', 'approved');

  for (const [lang, text] of [
    ['en', 'The customer has approved this contract'],
    ['fa', 'مشتری این قرارداد را تأیید کرده'],
  ] as const) {
    await workspace(page, lang);
    await page.getByTestId('change-customer').click();
    const form = page.getByTestId('change-customer-form');
    await form.locator('select').selectOption({ label: `Kaveh Co · ${OTHER}` });
    page.once('dialog', (d) => d.accept());
    await form.locator('button[type="submit"]').click();
    await expect(page.getByTestId('change-customer-error')).toContainText(text);
  }
});
