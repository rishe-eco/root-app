import { test, expect, type Page } from '@playwright/test';
import { SALES, WIZARD_CONTRACT_REF, apiSignIn, expectSaved, fillTitle, gql, insertDraftNewRoadContract, resetTestDatabase, signIn } from './helpers';

/**
 * DX3a — handover items (desk UX review 6–8, 20, 29): "Who provides what, by
 * when" on Requirements and the Dependencies tab are the same rows; the default
 * list is kept on the desk; "Feature for an existing site" fills in what it
 * implies. Driven as sales drives it, in both languages and at 360 px and 180 px.
 *
 * One story, in order, on the seeded new-road contract: its first brief makes the
 * list, Requirements edits it (Root · Customer · Not needed and a date, a one-off
 * item), the Dependencies tab shows and edits the same rows, the Templates tab
 * adds a default item that a *new* contract then has, and the preset runs on that
 * new contract.
 */

test.describe.configure({ mode: 'serial' });

const WIDTHS = [360, 180] as const;
const NEW_TITLE = 'Handover demo';

test.beforeAll(async ({ request }) => {
  test.setTimeout(120_000);
  resetTestDatabase();
  insertDraftNewRoadContract();
  // The seeded contract gets a minimal brief over the API, so the list exists and every row is undecided and undated.
  await apiSignIn(request, SALES);
  const { allContracts } = await gql<{ allContracts: Array<{ id: string; ref: string }> }>(request, '{ allContracts { id ref } }');
  const contract = allContracts.find((c) => c.ref === WIZARD_CONTRACT_REF)!;
  const { templateTypes } = await gql<{ templateTypes: Array<{ id: string; slug: string }> }>(request, '{ templateTypes(activeOnly: true) { id slug } }');
  await gql(request, 'mutation($c: ID!, $i: BriefInput!){ setBrief(contractId: $c, input: $i) { id } }', {
    c: contract.id,
    i: { kind: 'NEW_SITE', templateTypeId: templateTypes.find((t) => t.slug === 'store')!.id, designTier: 'THEME_PICK' },
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

async function pickDay(page: Page, testId: string, [year, month, day]: [number, number, number], gregorian: string) {
  const box = page.getByTestId(testId);
  await box.locator('input[data-part="text"]').fill(`${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`);
  await expect(box).toHaveAttribute('data-value', gregorian);
}

async function openPanel(page: Page, id: string) {
  const panel = page.getByTestId(`acc-${id}`);
  if ((await panel.getAttribute('data-open')) !== 'true') await panel.getByRole('button').first().click();
  await expect(panel).toHaveAttribute('data-open', 'true');
}

/** A contract's Requirements step on the desk, by the text its list row shows. */
async function openRequirements(page: Page, rowText: string, lang: 'en' | 'fa' = 'en') {
  await signIn(page, SALES, lang);
  await page.goto(`/${lang}/desk/contracts`);
  await page.locator('tr.crow', { hasText: rowText }).locator('td').first().click();
  await page.waitForURL(new RegExp(`/${lang}/desk/contracts/[^/]+/steps$`));
  await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
  await expect(page.getByTestId('requirements-panel')).toBeVisible();
}

const who = (page: Page, key: string) => page.getByTestId(`handover-side-${key}`);
const pill = (page: Page, key: string, value: 'ROOT' | 'CUSTOMER' | 'NOT_NEEDED') => who(page, key).locator(`button[data-value="${value}"]`);

test('Requirements: Root · Customer · Not needed and a date for each item, a second press clears, and it saves — at 360 and 180 px', async ({ page }) => {
  await openRequirements(page, WIZARD_CONTRACT_REF);
  await openPanel(page, 'handover');

  // The brief made one row for each item on the default list, undecided and undated (DX6: a gap until each is decided).
  await expect(page.getByTestId('handover-row')).toHaveCount(3);
  for (const key of ['domain', 'host', 'content']) await expect(who(page, key)).toHaveAttribute('data-value', '');
  await expect(page.locator('[data-code="COMMITMENT_UNDATED"]')).toHaveCount(0);

  // A second press clears.
  await pill(page, 'domain', 'ROOT').click();
  await expect(who(page, 'domain')).toHaveAttribute('data-value', 'ROOT');
  await pill(page, 'domain', 'ROOT').click();
  await expect(who(page, 'domain')).toHaveAttribute('data-value', '');

  // The customer brings the domain, by a date; the host is not needed (and takes no date); Root writes the content.
  await pill(page, 'domain', 'CUSTOMER').click();
  await pickDay(page, 'handover-due-domain', [1405, 8, 5], '2026-10-27');
  await pill(page, 'host', 'NOT_NEEDED').click();
  await expect(who(page, 'host')).toHaveAttribute('data-value', 'NOT_NEEDED');
  await expect(page.getByTestId('handover-due-host').locator('input[data-part="text"]')).toBeDisabled();
  await pill(page, 'content', 'ROOT').click();
  // DX4 (review 27): the list saves as it is edited — a pill at once, a date when its field is left — with no Save button.
  await expect(page.getByTestId('handover-save')).toHaveCount(0);
  // Someone provides it and nobody has said by when: the step lists it and counts it on the panel.
  await expectSaved(page, 'handover-autosave');
  await expect(page.getByTestId('brief-missing').locator('[data-code="COMMITMENT_UNDATED"]')).toContainText('Website content');
  await pickDay(page, 'handover-due-content', [1405, 8, 10], '2026-11-01');
  await page.getByTestId('handover-due-content').locator('input[data-part="text"]').blur();
  await expectSaved(page, 'handover-autosave');
  await expect(page.locator('[data-code="COMMITMENT_UNDATED"]')).toHaveCount(0);

  // The readout under the editor says the same, and a reload keeps it.
  await expect(page.locator('[data-field="domain"]').getByTestId('handover-who')).toHaveText('Customer');
  await expect(page.locator('[data-field="host"]').getByTestId('handover-who')).toHaveText('Not needed');
  await page.reload();
  await openPanel(page, 'handover');
  await expect(who(page, 'domain')).toHaveAttribute('data-value', 'CUSTOMER');
  await expect(who(page, 'host')).toHaveAttribute('data-value', 'NOT_NEEDED');
  await expect(page.getByTestId('handover-due-domain')).toHaveAttribute('data-value', '2026-10-27');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '[data-testid="acc-handover"]');
  }
});

test('a one-off item added on Requirements is the same row on the Dependencies tab, and an edit there shows back on Requirements', async ({ page }) => {
  await openRequirements(page, WIZARD_CONTRACT_REF);
  await openPanel(page, 'handover');

  await page.getByTestId('handover-add-open').click();
  // DX4: one title field. Adding is an act, so the row is made at once and is then edited like the others.
  await fillTitle(page.getByTestId('handover-add'), 'handover-new', 'handover-new-title', 'فایل‌های لوگو', 'Logo files');
  await page.getByTestId('handover-add-submit').click();
  await expect(page.getByTestId('handover-row')).toHaveCount(4);
  const newKey = (await page.getByTestId('handover-row').filter({ hasText: /Logo files|فایل‌های لوگو/ }).getAttribute('data-key'))!;
  await who(page, newKey).locator('button[data-value="CUSTOMER"]').click();
  await expectSaved(page, 'handover-autosave');
  await expect(who(page, newKey)).toHaveAttribute('data-value', 'CUSTOMER');
  // A one-off can be removed from here; the default list's items cannot (they are marked not needed instead).
  await expect(page.locator('[data-testid^="handover-remove-"]')).toHaveCount(1);

  // The Dependencies tab: the same rows — flagged as in the requirements, the undecided and undated shown as such.
  await page.locator('.workspace-tab', { hasText: 'Dependencies' }).click();
  await expect(page.getByTestId('dependency-row')).toHaveCount(4);
  await expect(page.getByTestId('dependency-in-brief')).toHaveCount(4);
  await expect(page.locator('[data-testid="dependency-row"]', { hasText: 'Logo files' }).getByTestId('dependency-due')).toHaveText('No date yet');
  await expect(page.locator('[data-testid="dependency-row"][data-key="host"]').getByTestId('dependency-not-needed')).toBeVisible();
  // Dated first, the undated last.
  const dues = await page.getByTestId('dependency-due').allTextContents();
  expect(dues.slice(-1)[0]).toBe('No date yet');

  // Edit the domain from here: Root provides it.
  const domain = page.locator('[data-testid="dependency-row"][data-key="domain"]');
  await domain.getByRole('button', { name: 'Edit' }).click();
  await domain.locator('select').selectOption('ROOT'); // DX4: a select saves as it changes
  await expectSaved(domain, 'dependency-autosave');
  await expect(domain.locator('.badge').first()).toHaveText('Root');

  // …and it is Root on Requirements.
  await page.locator('.workspace-tab', { hasText: 'Steps' }).click();
  await page.locator('.stepper-item[data-step="REQUIREMENTS"] button').click();
  await openPanel(page, 'handover');
  await expect(who(page, 'domain')).toHaveAttribute('data-value', 'ROOT');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '[data-testid="acc-handover"]');
  }
});

test('the same panel in Persian, right to left, at 360 and 180 px', async ({ page }) => {
  await openRequirements(page, WIZARD_CONTRACT_REF, 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await openPanel(page, 'handover');
  await expect(page.getByTestId('handover-row')).toHaveCount(4);
  await expect(who(page, 'host').locator('button[data-value="NOT_NEEDED"]')).toHaveText('لازم نیست');
  await expect(who(page, 'domain').locator('button[data-value="ROOT"]')).toHaveText('ریشه');
  await expect(page.locator('[data-field="domain"]').getByTestId('handover-who')).toHaveText('ریشه');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '[data-testid="acc-handover"]');
  }
});

test('the Templates tab adds a default item, and a new contract has it — then "feature for an existing site" fills in what it implies', async ({ page, request }) => {
  test.setTimeout(120_000);
  await signIn(page, SALES);
  await page.goto('/en/desk/templates/handover');
  await expect(page.getByTestId('handover-type')).toHaveCount(3);
  await page.locator('#ht-fa').fill('خط پیامک');
  await page.locator('#ht-en').fill('SMS line');
  await page.locator('#ht-key').fill('sms-line');
  await page.getByTestId('handover-type-add').click();
  await expect(page.locator('[data-testid="handover-type"][data-key="sms-line"]')).toBeVisible();
  // A key that is taken is refused in words.
  await page.locator('#ht-fa').fill('تکرار');
  await page.locator('#ht-en').fill('Again');
  await page.locator('#ht-key').fill('sms-line');
  await page.getByTestId('handover-type-add').click();
  await expect(page.locator('p.error')).toContainText('already exists');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await expectFits(page, '.workspace-panel');
  }
  await page.setViewportSize({ width: 1280, height: 900 });

  // A new contract (the generated reference, DX3b) for the seeded customer.
  await apiSignIn(request, SALES);
  const { allContracts } = await gql<{ allContracts: Array<{ ref: string; customer: { id: string } }> }>(request, '{ allContracts { ref customer { id } } }');
  const customerId = allContracts.find((c) => c.ref === WIZARD_CONTRACT_REF)!.customer.id;
  await gql(request, 'mutation($i: CreateContractInput!){ createContract(input: $i) { id } }', {
    i: { customerId, titleFa: 'نمونه‌ی تحویل', titleEn: NEW_TITLE },
  });

  await openRequirements(page, NEW_TITLE);
  // No brief yet, so no list yet; the first save makes it — domain, host, content and the new item.
  // DX4: the brief saves as it is edited, so picking the type makes it (and the list) ...
  await page.locator('#brief-type').selectOption({ label: 'Store' });
  await expectSaved(page, 'brief-autosave');
  // ... and the preset runs on the save that changes the kind to a feature for an existing site.
  await page.locator('#brief-kind').selectOption('FEATURE_FOR_EXISTING');
  await expect(page.getByTestId('brief-preset-applied')).toBeVisible();
  await page.locator('#brief-site').fill('https://old.example.com');
  await page.locator('#brief-site').blur();
  await expectSaved(page, 'brief-autosave');
  await expect(page.locator('#brief-tier')).toHaveValue('NONE');

  await openPanel(page, 'handover');
  await expect(page.getByTestId('handover-row')).toHaveCount(4);
  await expect(page.locator('[data-testid="handover-row"][data-key="sms-line"]')).toBeVisible();
  await expect(who(page, 'domain')).toHaveAttribute('data-value', 'NOT_NEEDED');
  await expect(who(page, 'host')).toHaveAttribute('data-value', 'NOT_NEEDED');
  await expect(who(page, 'content')).toHaveAttribute('data-value', '');

  // Every field stays editable: the design can go back, the domain can be needed after all. A second save is not the preset again.
  await page.locator('#brief-tier').selectOption('THEME_PICK');
  await expectSaved(page, 'brief-autosave');
  await expect(page.locator('#brief-tier')).toHaveValue('THEME_PICK');
  await expect(page.getByTestId('brief-preset-applied')).toHaveCount(0);
  await expect(who(page, 'host')).toHaveAttribute('data-value', 'NOT_NEEDED');
});
