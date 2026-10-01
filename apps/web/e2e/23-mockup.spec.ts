import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import {
  CUSTOMER,
  DESIGNER,
  SALES,
  apiSignIn,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  resetTestDatabase,
  signIn,
  storeZip,
} from './helpers';

/**
 * J9b — step 5, the mockup, end to end in a real browser (journeys build plan §5
 * "J9"; the acceptance sentence): **a custom-path contract runs from design
 * approval through two mockup iterations to mockup approval, with every note
 * resolved and the second iteration's fates visible — and the mockup's own
 * root-relative links working.**
 *
 * The story, in order, because each test is the next one's precondition: the
 * designer starts the mockup, uploads a zip with progress, maps the pages and
 * publishes iteration 1; the customer (Persian) browses it in the portal's
 * viewport on its own `*.mockup.localhost` subdomain, follows a root-relative link
 * inside the frame, and comments on a page the bundle does not have yet; the
 * designer declares iteration 2 — the note needs a fate first — maps the new page
 * and publishes (the allowance is then spent); the customer reads the fate,
 * browses the new page, and approves; the step locks.
 *
 * Steps 1–4 are taken over the API (`17`, `18`, `20` and `21` are those stories).
 */

test.describe.configure({ mode: 'serial' });

const TITLE_FA = 'فروشگاه آنلاین نهال';
const HOME_FA = 'صفحه — نمونه، جایگزین کنید';
const ABOUT_FA = 'درباره‌ی ما';

let contractId = '';

const HEAD = '<meta charset="utf-8"><link rel="stylesheet" href="/css/app.css">';
const V1 = {
  'site/index.html': `<!doctype html><html><head>${HEAD}<title>Home</title></head><body><h1>HOME-V1</h1><a id="to-contact" href="/contact.html">Contact</a></body></html>`,
  'site/contact.html': `<!doctype html><html><head>${HEAD}<title>Contact</title></head><body><h1>CONTACT-V1</h1></body></html>`,
  'site/css/app.css': 'h1 { color: rgb(30, 60, 90); }',
  // What Finder adds beside a folder; it must not stop the zip.
  '__MACOSX/site/._index.html': 'fork',
};
const V2 = {
  ...V1,
  'site/index.html': `<!doctype html><html><head>${HEAD}<title>Home</title></head><body><h1>HOME-V2</h1><a id="to-about" href="/about.html">About</a></body></html>`,
  'site/about.html': `<!doctype html><html><head>${HEAD}<title>About</title></head><body><h1>ABOUT-V2</h1></body></html>`,
};

/** The design, over the API: two wireframe pages, a palette, every page approved, the design approved. */
async function approveDesignViaApi(request: APIRequestContext, id: string) {
  await apiSignIn(request, DESIGNER);
  await gql(request, 'mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }', { c: id });
  const draft = await gql<{ contract: { designDraft: { concepts: Array<{ id: string; key: string }> } } }>(
    request,
    'query($c: ID!){ contract(id: $c) { designDraft { concepts { id key } } } }',
    { c: id },
  );
  const concept = draft.contract.designDraft.concepts.find((c) => c.key === 'wireframes')!;
  for (const key of ['placeholder-page', 'about']) {
    await gql(request, 'mutation($k: ID!, $key: String!){ addPageDesign(conceptId: $k, key: $key, labelFa: "ف", labelEn: "L") { id } }', { k: concept.id, key });
  }
  for (const [kind, role, value] of [['COLOR', 'primary', '#1f3a5c'], ['FONT', 'heading', 'Vazirmatn']]) {
    await gql(
      request,
      'mutation($c: ID!, $kind: PaletteKind!, $role: String!, $v: String!){ addPaletteItem(contractId: $c, kind: $kind, role: $role, value: $v, labelFa: "برچسب", labelEn: "Label") { id } }',
      { c: id, kind, role, v: value },
    );
  }
  await gql(request, 'mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', { c: id });
  await apiSignIn(request, CUSTOMER);
  const pages = await gql<{ contract: { concepts: Array<{ pages: Array<{ id: string }> }> } }>(request, 'query($c: ID!){ contract(id: $c) { concepts { pages { id } } } }', { c: id });
  for (const p of pages.contract.concepts[0].pages) {
    await gql(request, 'mutation($p: ID!){ setPageApproval(pageDesignId: $p, approved: true) { id } }', { p: p.id });
  }
  await gql(request, 'mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { c: id });
}

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request, undefined, { designTier: 'SENIOR_DESIGNER' });
  // A second agreed page, so the mockup has one the first iteration will not show.
  await apiSignIn(request, SALES);
  await gql(request, 'mutation($c: ID!){ addScopeItem(contractId: $c, key: "about", labelFa: "درباره‌ی ما", labelEn: "About us", kind: PAGE) { id } }', { c: contractId });
  await completeStepTwoViaApi(request, contractId);
  await approveAndSignViaApi(request, contractId);
  await approveDesignViaApi(request, contractId);
});

async function designerMockup(page: Page) {
  await signIn(page, DESIGNER, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await page.locator('.stepper-item[data-step="MOCKUP"] button').click();
  await expect(page.getByTestId('mockup-panel')).toBeVisible();
}

async function customerMockup(page: Page, lang: 'fa' | 'en' = 'fa') {
  await signIn(page, CUSTOMER, lang);
  await page.goto(`/${lang}/app/contracts`);
  await page.locator('tr.crow', { hasText: lang === 'fa' ? TITLE_FA : 'Nahal online shop' }).click();
  await page.waitForURL(new RegExp(`/${lang}/app/contracts/[^/]+$`));
  await page.locator('.stepper-item[data-step="MOCKUP"] button').click();
  await expect(page.getByTestId('mockup-panel')).toBeVisible();
}

const mapRow = (page: Page, key: string) => page.locator(`[data-testid="mockup-map-row"][data-key="${key}"]`);
const pageTarget = (page: Page, label: string) => page.locator('[data-testid="feedback-target"][data-key^="page:"]', { hasText: label });

test('the designer starts the mockup, uploads a Finder zip with progress, maps the pages and publishes iteration 1', async ({ page }) => {
  test.setTimeout(180_000);
  await designerMockup(page);
  await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.getByTestId('mockup-iteration')).toContainText('No mockup published yet');

  await page.getByTestId('mockup-start-action').click();
  await expect(page.getByTestId('mockup-author')).toBeVisible();
  // A page per agreed page of the scope, unmapped.
  await expect(page.getByTestId('mockup-map-row')).toHaveCount(2);
  await expect(mapRow(page, 'placeholder-page')).toContainText('Not mapped');

  // The upload: the streamed route, with a progress bar; a __MACOSX folder does not stop it.
  await page.getByTestId('mockup-bundle-input').setInputFiles({ name: 'mockup.zip', mimeType: 'application/zip', buffer: storeZip(V1) });
  await expect(page.getByTestId('mockup-declare-form')).toBeVisible();
  await page.getByTestId('mockup-declare').click();
  await expect(page.getByTestId('mockup-draft')).toHaveCount(1);

  // The mapping, offered from what the bundle has: the home page is in it, the about page is not.
  await mapRow(page, 'placeholder-page').locator('input').fill('index.html');
  await mapRow(page, 'placeholder-page').getByRole('button', { name: 'Save' }).click();
  await expect(mapRow(page, 'placeholder-page').getByTestId('mockup-map-state')).toHaveAttribute('data-in-bundle', 'true');
  await mapRow(page, 'about').locator('input').fill('about.html');
  await mapRow(page, 'about').getByRole('button', { name: 'Save' }).click();
  await expect(mapRow(page, 'about').getByTestId('mockup-map-state')).toHaveAttribute('data-in-bundle', 'false');
  // A path two pages cannot share is refused in words.
  await mapRow(page, 'about').locator('input').fill('/');
  await mapRow(page, 'about').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('mockup-mapping').getByRole('alert')).toContainText('Another page is already mapped to that path');
  await mapRow(page, 'about').locator('input').fill('about.html');

  await page.getByTestId('mockup-publish').click();
  await expect(page.getByTestId('mockup-iteration')).toContainText('Mockup 1 of 2');
  await expect(page.getByTestId('mockup-draft')).toHaveCount(0);
});

test('the customer (Persian) browses it in the portal’s viewport on its own subdomain, follows a root-relative link, and comments on the page that is not there yet', async ({ page }) => {
  test.setTimeout(180_000);
  await customerMockup(page, 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('mockup-iteration')).toContainText('ماکتِ ۱ از ۲');
  await expect(page.getByTestId('mockup-fixed')).toContainText('این یک ماکت است: داده‌ی واقعی ندارد و هیچ چیز ذخیره نمی‌شود.');

  // A real subdomain of mockup.localhost, on the API's own port.
  const iframe = page.locator('[data-testid="mockup-viewport"] iframe');
  await expect(iframe).toBeVisible();
  const src = await iframe.getAttribute('src');
  expect(new URL(src!).hostname).toMatch(/^[0-9a-f]{32}\.mockup\.localhost$/);
  const frame = page.frameLocator('[data-testid="mockup-viewport"] iframe');
  await expect(frame.getByRole('heading', { name: 'HOME-V1' })).toBeVisible();
  await expect(frame.locator('h1')).toHaveCSS('color', 'rgb(30, 60, 90)'); // the bundle's own root-relative stylesheet
  // The viewport heard the reporter (origin exactly the grant's own) and matched the home page.
  await expect(page.locator('.demo-current-page')).toContainText(HOME_FA);

  // A root-relative link inside the frame navigates.
  await frame.locator('#to-contact').click();
  await expect(frame.getByRole('heading', { name: 'CONTACT-V1' })).toBeVisible();

  // The frame lists the missing page and the pages the bundle shows, in Persian.
  await expect(page.getByText('هنوز در این ماکت نیست')).toBeVisible();
  await expect(page.getByText('صفحه‌های این ماکت')).toBeVisible();

  // A note on the page iteration 1 does not have; the customer cannot approve while it is open.
  const about = pageTarget(page, ABOUT_FA);
  await about.getByRole('button', { name: 'ثبتِ بازخورد' }).click();
  await about.locator('textarea').fill('عکس تیم کجاست؟ صفحه‌ی درباره‌ی ما را نمی‌بینم.');
  await about.getByRole('button', { name: 'ارسال' }).click();
  await expect(about.getByTestId('feedback-thread')).toHaveAttribute('data-status', 'OPEN');
  await page.getByTestId('approve-mockup').click();
  await expect(page.getByTestId('approve-error')).toContainText('هنوز به بعضی از نکته‌هایت پاسخ داده نشده');
  await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).not.toHaveAttribute('data-status', 'DONE');
});

test('the designer declares iteration 2 — the note needs a fate first — and publishes; the allowance is then spent', async ({ page }) => {
  test.setTimeout(180_000);
  await designerMockup(page);
  await expect(page.getByTestId('mockup-iteration')).toContainText('Mockup 1 of 2');

  await page.getByTestId('mockup-bundle-input').setInputFiles({ name: 'mockup-2.zip', mimeType: 'application/zip', buffer: storeZip(V2) });
  await expect(page.getByTestId('mockup-declare-form')).toBeVisible();
  const fate = page.getByTestId('mockup-fate');
  await expect(fate).toHaveCount(1);
  await expect(fate).toContainText('عکس تیم کجاست؟');
  // Carried forward by default: declaring without a real fate leaves the note open.
  await fate.locator('select').selectOption('ADDRESSED');
  await fate.locator('input').fill('The about page is in this iteration.');
  await page.getByTestId('mockup-declare').click();
  await expect(page.getByTestId('mockup-draft')).toHaveCount(1);
  // The ledger names what became of the note.
  await expect(page.getByTestId('mockup-ledger')).toContainText('Addressed');
  await expect(page.getByTestId('mockup-ledger')).toContainText('The about page is in this iteration.');

  // The about page was mapped last time; this bundle has it.
  await expect(mapRow(page, 'about').getByTestId('mockup-map-state')).toHaveAttribute('data-in-bundle', 'true');
  await page.getByTestId('mockup-publish').click();
  await expect(page.getByTestId('mockup-iteration')).toContainText('Mockup 2 of 2');
  await expect(page.getByTestId('mockup-allowance')).toContainText('2 of 2 rounds used');
  await expect(page.getByTestId('allowance-exhausted')).toBeVisible();
});

test('the customer reads the fate, browses the new page, approves — and the step locks, for them and for the designer', async ({ page }) => {
  test.setTimeout(180_000);
  await customerMockup(page, 'fa');
  await expect(page.getByTestId('mockup-iteration')).toContainText('ماکتِ ۲ از ۲');

  // The second iteration's fates: the note is addressed, with the designer's words, and its page is now under "pages in this mockup".
  const about = pageTarget(page, ABOUT_FA);
  await expect(about.getByTestId('feedback-thread')).toHaveAttribute('data-status', 'ADDRESSED');
  await expect(about.getByTestId('feedback-thread')).toContainText('The about page is in this iteration.');
  const lineGroup = page.locator('[data-testid="feedback-target"][data-key^="line:"]', { hasText: ABOUT_FA });
  await expect(lineGroup).toHaveCount(1);

  const frame = page.frameLocator('[data-testid="mockup-viewport"] iframe');
  await expect(frame.getByRole('heading', { name: 'HOME-V2' })).toBeVisible();
  await frame.locator('#to-about').click();
  await expect(frame.getByRole('heading', { name: 'ABOUT-V2' })).toBeVisible();
  // …and the portal knows which page the customer is on: the mapped one, by its Persian label.
  await expect(page.locator('.demo-current-page')).toContainText(ABOUT_FA);

  await page.getByTestId('approve-mockup').click();
  await expect(page.getByTestId('mockup-approved')).toBeVisible();
  await expect(page.locator('.stepper-item[data-step="MOCKUP"]')).toHaveAttribute('data-status', 'DONE');
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveAttribute('data-status', 'CURRENT');
  await expect(page.getByTestId('approve-mockup')).toHaveCount(0);

  // The same step in English, read-only.
  await customerMockup(page, 'en');
  await expect(page.getByTestId('mockup-iteration')).toContainText('Mockup 2 of 2');
  await expect(page.getByTestId('mockup-approved')).toContainText('The mockup is approved and locked.');

  // The designer finds it locked: no author controls, and the lock note on the step.
  await designerMockup(page);
  await expect(page.getByTestId('mockup-author')).toHaveCount(0);
  await expect(page.locator('.step-panel-head ~ .locknote')).toContainText('Locked on');
  await expect(page.getByTestId('mockup-approved')).toBeVisible();
});

test('sales reads the mockup without authoring controls and can see the allowance', async ({ page }) => {
  await signIn(page, SALES, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/steps`);
  await page.locator('.stepper-item[data-step="MOCKUP"] button').click();
  await expect(page.getByTestId('mockup-read-only')).toBeVisible();
  await expect(page.getByTestId('mockup-author')).toHaveCount(0);
  await expect(page.getByTestId('mockup-allowance')).toContainText('2 of 2 rounds used');
});
