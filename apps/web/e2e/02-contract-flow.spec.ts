import { test, expect } from '@playwright/test';
import {
  ADMIN,
  CUSTOMER,
  CONTRACT_TITLE,
  PNG,
  renameContractDraft,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * The gate, driven the way a customer drives it.
 *
 * The integration tests already prove the server refuses out-of-order calls.
 * What only a browser can show is whether the *interface* leads someone
 * through it: that the sign button is genuinely unavailable until it should
 * be, and that each step visibly unlocks the next. A server that refuses
 * correctly behind a UI that offers the button anyway is still a broken
 * product.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  // The flow ends in a signature, and a signature is terminal.
  resetTestDatabase();
});

/**
 * Opens the first row of the contracts list.
 *
 * Deliberately a click on the row itself: `Contracts.tsx` renders
 * `<tr className="crow" onClick={…}>`, and the "View ›" beside it is a plain
 * span. There is no link and no button to target, which is the subject of the
 * last test in this file.
 */
async function openFirstContract(page: import('@playwright/test').Page) {
  await page.locator('.crow').first().click();
  await page.waitForURL(/\/app\/contracts\/.+/);
}

test('a customer signs a contract, one gate at a time', async ({ page }) => {
  await signIn(page, CUSTOMER);

  await expect(page.getByText(CONTRACT_TITLE)).toBeVisible();
  await openFirstContract(page);
  await expect(page.getByText('Design selection & approval')).toBeVisible();

  // --- locked at the start -------------------------------------------------
  await expect(page.getByRole('button', { name: 'Approve contract' })).toHaveCount(0);
  await expect(page.getByText('Complete and approve the design first.')).toBeVisible();
  await expect(page.locator('#signname')).toHaveCount(0);
  await expect(page.getByText('Signing unlocks after the contract is approved.')).toBeVisible();

  // --- choose a concept ----------------------------------------------------
  await page.locator('.concept').first().click();
  await expect(page.getByText('Page designs')).toBeVisible();
  await expect(page.locator('.concept-chosen')).toHaveCount(1);

  // --- approve the pages one at a time -------------------------------------
  const approveButtons = page.locator('.pagerow-actions button');
  const pageCount = await approveButtons.count();
  expect(pageCount).toBeGreaterThan(1);

  for (let i = 0; i < pageCount; i += 1) {
    // Still locked while any page is outstanding.
    await expect(page.getByRole('button', { name: 'Approve contract' })).toHaveCount(0);
    await approveButtons.nth(i).click();
    await expect(approveButtons.nth(i)).toHaveText(/Approved/);
  }

  // --- which unlocks approval, and only now --------------------------------
  const approveContract = page.getByRole('button', { name: 'Approve contract' });
  await expect(approveContract).toBeVisible();
  await expect(page.locator('#signname')).toHaveCount(0); // still not signable

  await approveContract.click();
  await expect(page.getByText('✓ Contract approved')).toBeVisible();

  // --- which unlocks the signature -----------------------------------------
  const nameField = page.locator('#signname');
  await expect(nameField).toBeVisible();

  const signButton = page.getByRole('button', { name: 'Sign & finalize' });
  await expect(signButton).toBeDisabled(); // a name is required, not optional

  await nameField.fill('نهال رضایی');
  await expect(signButton).toBeEnabled();
  await signButton.click();

  await expect(page.getByText(/^Signed/)).toBeVisible();
});

test('choosing a different concept resets the approvals', async ({ page }) => {
  resetTestDatabase();
  await signIn(page, CUSTOMER);
  await openFirstContract(page);

  const concepts = page.locator('.concept');
  await concepts.first().click();

  const approveButtons = page.locator('.pagerow-actions button');
  await approveButtons.first().click();
  await expect(approveButtons.first()).toHaveText(/Approved/);

  // Abandon it for another. Approving pages of a design you then walked away
  // from would be meaningless, so they must not survive.
  await concepts.nth(1).click();
  await expect(page.locator('.pagerow-actions button').first()).toHaveText(/^Approve$/);
});

test('commenting is never gated', async ({ page }) => {
  resetTestDatabase();
  await signIn(page, CUSTOMER);
  await openFirstContract(page);

  // Nothing chosen, nothing approved — the comment box must still work.
  await page.locator('textarea').fill('A question about article 2.');
  await page.getByRole('button', { name: 'Post comment' }).click();
  await expect(page.getByText('A question about article 2.')).toBeVisible();
});

test('a keyboard user can open a contract', async ({ page }) => {
  test.fail(
    true,
    'Known gap: Contracts.tsx renders <tr className="crow" onClick={…}> with no role, ' +
      'no tabindex and no key handler, so the list is unreachable without a mouse. ' +
      'Delete this annotation when the row becomes a link or a button.',
  );

  // Marked expected-to-fail rather than deleted: this asserts the behaviour
  // that *should* hold, so the day someone fixes the component Playwright
  // reports an unexpected pass and this annotation has to go. A test that
  // asserted the broken behaviour instead would quietly cement it.
  await signIn(page, CUSTOMER);
  await page.locator('.crow').first().press('Enter');
  await expect(page).toHaveURL(/\/app\/contracts\/.+/);
});

test('the history reads as sentences, not enum names', async ({ page }) => {
  // The failure this catches is `log.undefined`, which shipped once: a new
  // ChangeAction with no translation renders its i18n key instead of a
  // sentence. changeAction.test.ts pins the five files against each other;
  // this checks what a human actually sees.
  await signIn(page, CUSTOMER);
  await openFirstContract(page);

  const history = page.locator('.lwhat');
  await expect(history.first()).toBeVisible();
  const entries = await history.allInnerTexts();
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry).not.toMatch(/^log\./);
    expect(entry).not.toContain('undefined');
    expect(entry.trim()).not.toBe('');
  }
});

test('the printable contract shows the published revision and its hash', async ({ page }) => {
  // What only a browser can show here is that the document renders from the
  // *revision*. The integration tests prove `contract.revision` returns the
  // frozen snapshot; this proves the page a customer prints reads from it,
  // and that the verification strip is actually on the sheet rather than
  // merely in the markup.
  await signIn(page, CUSTOMER);
  await openFirstContract(page);

  await page.getByRole('link', { name: 'Download PDF' }).click();
  await page.waitForURL(/\/app\/contracts\/.+\/print/);

  await expect(page.locator('.doc-title')).toHaveText(CONTRACT_TITLE);

  // A full sha256, not a placeholder and not an empty span.
  const strip = page.locator('.doc-verify');
  await expect(strip).toBeVisible();
  await expect(strip).toContainText('RC-2026-014');
  await expect(strip.locator('.doc-verify-hash')).toHaveText(/^sha256 [0-9a-f]{64}$/);

  // The strip rides in a tfoot, which is what makes it repeat per printed
  // page. If someone "simplifies" it back to a plain footer, printing puts it
  // across the signature — so the structure is the thing worth asserting.
  await expect(page.locator('.doc-sheet > tfoot .doc-verify')).toHaveCount(1);

  // Articles come from the snapshot, and every one of them is expanded —
  // a document with collapsed sections is not a document.
  const articles = page.locator('.doc-art');
  expect(await articles.count()).toBeGreaterThan(0);
  await expect(articles.first().locator('.doc-art-body')).toBeVisible();
});

test('renaming the draft after publishing does not change what the customer reads', async ({
  page,
}) => {
  /*
   * The screen used to disagree with itself. Its heading came from
   * `contract.titleFa/titleEn` — Root's working draft — while the articles
   * underneath came from the frozen snapshot of the published revision. Nobody
   * noticed because nobody had renamed a contract after publishing it.
   *
   * So: publish, rename the draft, and check that the customer still reads one
   * document rather than a draft title over published text. The print view was
   * already correct and has its own test above; this is the detail screen and
   * the list, which were not.
   */
  resetTestDatabase();
  renameContractDraft('DRAFT RENAME — NOT PUBLISHED');

  await signIn(page, CUSTOMER);

  // The list names the published document.
  await expect(page.getByText(CONTRACT_TITLE)).toBeVisible();
  await expect(page.getByText('DRAFT RENAME — NOT PUBLISHED')).toHaveCount(0);

  await openFirstContract(page);

  // And so does the heading, directly above articles from that same snapshot.
  await expect(page.locator('.detail-head h1')).toHaveText(CONTRACT_TITLE);
  await expect(page.getByText('DRAFT RENAME — NOT PUBLISHED')).toHaveCount(0);

  // The crumb trail is the same title, for the same reason.
  await expect(page.locator('.crumb-now')).toHaveText(CONTRACT_TITLE);
});

test('a revised design page shows a banner naming it, and approving it clears the banner (V3, D1)', async ({
  page,
}) => {
  // This is the one that would have caught D1: the client used to disable
  // page approval whenever the contract was approved, which is exactly the
  // state a design revision on an approved contract produces.
  test.setTimeout(60_000);
  resetTestDatabase();

  // The customer completes v1 first, so a v2 has something to carry forward
  // from — a one-page change should ask for one re-approval, not four.
  await signIn(page, CUSTOMER);
  await openFirstContract(page);
  const contractId = page.url().split('/contracts/')[1].split(/[/?]/)[0];

  await page.locator('.concept').first().click();
  await expect(page.locator('.concept-chosen')).toHaveCount(1);

  const approveButtons = page.locator('.pagerow-actions button');
  const pageCount = await approveButtons.count();
  expect(pageCount).toBeGreaterThan(1);
  for (let i = 0; i < pageCount; i += 1) {
    await approveButtons.nth(i).click();
    await expect(approveButtons.nth(i)).toHaveText(/Approved/);
  }
  await expect(page.getByText('✓ Design approved & complete')).toBeVisible();

  // Root revises the Landing page's image and publishes a v2 design revision.
  await signIn(page, ADMIN);
  await page.goto(`/en/desk/contracts/${contractId}/design`);
  await page.getByRole('button', { name: 'Add concept' }).click();
  await page.locator('input[placeholder="1d"]').fill('1x');
  await page
    .locator('form.workspace-row')
    .filter({ has: page.locator('input[placeholder="1d"]') })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(page.getByText('Editing design draft')).toBeVisible();

  const conceptCard = page.locator('.editor-card').filter({ has: page.locator('.t-eyebrow', { hasText: '1a' }) });
  const landingRow = conceptCard.locator('.editor-card').filter({ has: page.locator('input[value="Landing"]') });
  await landingRow.locator('input[type="file"]').setInputFiles({
    name: 'landing.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(landingRow.locator('.thumb img')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Publish design' }).click();
  await expect(page.getByText('Showing the published design.')).toBeVisible();

  // Back to the customer: the banner names it, with one action, and taking
  // it works.
  await signIn(page, CUSTOMER);
  await openFirstContract(page);
  await expect(page.getByText('The design changed — 1 page needs your approval.')).toBeVisible();

  await page.getByRole('link', { name: 'Review the design' }).click();
  const outstanding = page.locator('.pagerow-actions button', { hasText: /^Approve$/ });
  await expect(outstanding).toHaveCount(1);
  await outstanding.click();

  await expect(page.locator('.pending-banner')).toHaveCount(0);
});
