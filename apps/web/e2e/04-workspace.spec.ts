import { test, expect, type Page } from '@playwright/test';
import { ADMIN, CUSTOMER, resetTestDatabase, signIn } from './helpers';

/**
 * V2's acceptance test, driven through the browser: Root takes a contract
 * from nothing to signed without touching the database or the GraphQL
 * sandbox, then issues an amendment the customer can approve and sign.
 *
 * The customer's approve/sign-amendment UI is V3's job (V2.md §2.4) — the
 * mutations are built here so this test can drive one to signature, via
 * `page.request` rather than a screen that does not exist yet.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function gql(page: Page, query: string, variables?: Record<string, unknown>) {
  const res = await page.request.post('/graphql', { data: { query, variables } });
  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data;
}

test.beforeAll(() => {
  resetTestDatabase();
});

test('a contract goes from nothing to signed, then an amendment to signature', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (dialog) => dialog.accept());

  // --- create ---------------------------------------------------------------
  await signIn(page, ADMIN);
  await page.goto('/en/desk/contracts');
  await page.getByRole('button', { name: 'New contract' }).click();
  await page.locator('#nc-customer').selectOption({ index: 1 });
  await page.locator('#nc-ref').fill('RC-2026-099');
  await page.locator('#nc-fa').fill('قرارداد آزمایشی دو');
  await page.locator('#nc-en').fill('Workspace test contract');
  await page.getByRole('button', { name: 'Create contract' }).click();

  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/contract$/);
  const contractId = page.url().match(/contracts\/([^/]+)\//)![1];

  // --- fill in articles via the template, publish the revision --------------
  await page.getByRole('button', { name: 'Apply standard template' }).click();
  await expect(page.locator('.editor-list .editor-card')).toHaveCount(15);

  await page.getByRole('button', { name: 'Publish revision' }).click();
  await expect(page.getByText('Nothing to publish')).toBeVisible();

  // --- design: one concept, one page, both with an uploaded image ----------
  await page.getByRole('link', { name: 'Design' }).click();
  await page.getByRole('button', { name: 'Add concept' }).click();
  await page.locator('input[placeholder="1d"]').fill('1a');
  await page
    .locator('form.workspace-row')
    .filter({ has: page.locator('input[placeholder="1d"]') })
    .getByRole('button', { name: 'Save' })
    .click();

  await expect(page.getByText('Editing design draft')).toBeVisible();

  // Concept image — the only file input on the page at this point.
  await page.locator('input[type="file"]').first().setInputFiles({
    name: 'concept.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.locator('.thumb img').first()).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Add page' }).click();
  await page.locator('select').filter({ hasText: 'Pick a page' }).selectOption('home');
  await page
    .locator('form.workspace-row')
    .filter({ has: page.locator('select') })
    .getByRole('button', { name: 'Save' })
    .click();

  // Page image — now the second file input (the concept's is still the first).
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: 'page.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(page.locator('.thumb img')).toHaveCount(2, { timeout: 15_000 });

  await page.getByRole('button', { name: 'Publish design' }).click();
  await expect(page.getByText('Showing the published design.')).toBeVisible();

  // --- hand over to the customer ---------------------------------------------
  await page.getByRole('link', { name: 'Contract', exact: true }).click();
  await page.getByRole('button', { name: 'Hand over to customer' }).click();
  await expect(page.getByRole('button', { name: 'Hand over to customer' })).toHaveCount(0);

  // --- the customer sees it, completes the design, approves and signs -------
  await signIn(page, CUSTOMER);
  await expect(page.getByText('Workspace test contract')).toBeVisible();
  await page.getByText('Workspace test contract').click();

  await expect(page.getByText('Design selection & approval')).toBeVisible();
  await page.locator('.concept').first().click();
  const approveButtons = page.locator('.pagerow-actions button');
  await expect(approveButtons).toHaveCount(1);
  await approveButtons.first().click();
  await expect(approveButtons.first()).toHaveText(/Approved/);

  await page.getByRole('button', { name: 'Approve contract' }).click();
  await expect(page.getByText('✓ Contract approved')).toBeVisible();

  await page.locator('#signname').fill('Nahal Rezaei');
  await page.getByRole('button', { name: 'Sign & finalize' }).click();
  await expect(page.getByText(/^Signed/)).toBeVisible();

  // --- back to the desk: issue and publish an amendment ----------------------
  await signIn(page, ADMIN);
  await page.goto(`/en/desk/contracts/${contractId}/contract`);
  await expect(page.getByRole('heading', { name: 'Amendments' })).toBeVisible();

  await page.getByRole('button', { name: 'Issue amendment' }).click();
  const amendForm = page.locator('form').filter({ has: page.locator('input[name="titleFa"]') });
  await amendForm.locator('input[name="titleFa"]').fill('الحاقیه یک');
  await amendForm.locator('input[name="titleEn"]').fill('Amendment One');
  await amendForm.locator('textarea[name="bodyFa"]').fill('متنِ الحاقیه.');
  await amendForm.locator('textarea[name="bodyEn"]').fill('The amendment text.');
  await amendForm.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText('A1')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Awaiting the customer')).toBeVisible();

  // --- the customer approves and signs the amendment -------------------------
  // No portal UI for this yet (V3) — drive the mutations directly, which is
  // the whole point of building them ahead of the screen (V2.md §2.4).
  await signIn(page, CUSTOMER);
  const withAmendment = await gql(
    page,
    `query($id: ID!){ contract(id: $id) { revision { amendments { id ordinal } } } }`,
    { id: contractId },
  );
  const amendmentId = withAmendment.contract.revision.amendments[0].id;

  await gql(page, `mutation($id: ID!){ approveAmendment(amendmentId: $id) { id } }`, {
    id: amendmentId,
  });
  const signed = await gql(
    page,
    `mutation($id: ID!, $n: String!){ signAmendment(amendmentId: $id, typedName: $n) { gate { signed } signature { typedName } } }`,
    { id: amendmentId, n: 'Nahal Rezaei' },
  );

  // The base signature is untouched — this is a separate instrument.
  expect(signed.signAmendment.gate.signed).toBe(true);
  expect(signed.signAmendment.signature.typedName).toBe('Nahal Rezaei');
});
