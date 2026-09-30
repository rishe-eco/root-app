import { test, expect, type Page } from '@playwright/test';
import { CUSTOMER, DESIGNER, SALES, completeStepOneViaApi, resetTestDatabase, signIn } from './helpers';

/**
 * J2's acceptance test (journeys build plan §5 "J2"): a customer submits a
 * request from the contracts list; sales replies in the thread; the customer
 * sees the reply; sales converts the request into a contract — and the thread
 * stays, read-only, on the contract. Then the other ending, in Persian (the
 * product is the Persian side): sales archives a request with a reason, and
 * the customer is shown it, in their language, by SMS as well.
 *
 * Serial and on one database: each test starts where the last one left it.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const API = `http://localhost:${process.env.E2E_API_PORT || 4101}`;

/** The latest SMS the dev transport "sent" to a phone (routes/smsOutbox.ts). */
async function latestSms(phone: string): Promise<string | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${API}/__e2e/sms-outbox?phone=${encodeURIComponent(phone)}`);
    if (res.ok) {
      const body = (await res.json()) as { text: string | null };
      if (body.text) return body.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

const TITLE = 'A shop for my studio';
const BODY = 'I sell prints and want to sell them online, in Persian and English.';

test('a customer submits a request and it sits above their contracts as a pending row', async ({ page }) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');

  await page.getByRole('button', { name: 'New request' }).click();
  await page.locator('#nr-title').fill(TITLE);
  await page.locator('#nr-body').fill(BODY);
  await page.getByRole('button', { name: 'Send request' }).click();

  // The drawer opens on the new request, showing what was said.
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(drawer.getByTestId('request-thread')).toContainText(BODY);
  await expect(page).toHaveURL(/\?request=/);

  // The customer can speak in the thread while it is pending.
  await drawer.getByRole('textbox').fill('One more thing: I have a logo already.');
  await drawer.getByRole('button', { name: 'Send message' }).click();
  await expect(drawer.getByTestId('request-thread')).toContainText('I have a logo already.');
  await drawer.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A pending row, above the contracts table.
  const row = page.locator('.request-row', { hasText: TITLE });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Pending');
  const rowBox = await row.boundingBox();
  const tableBox = await page.locator('.ctable').boundingBox();
  expect(rowBox!.y).toBeLessThan(tableBox!.y);
});

test('sales sees it in the Requests inbox, replies, and the customer reads the reply', async ({ browser, page }) => {
  await signIn(page, SALES, 'en');
  await expect(page.locator('.desk-nav').getByText('Requests', { exact: true })).toBeVisible();
  await page.locator('.desk-nav').getByText('Requests', { exact: true }).click();

  // Pending is the default view: it is the queue.
  const row = page.locator('tr.crow', { hasText: TITLE });
  await expect(row).toBeVisible();
  // The desk names a customer by company where there is one (the seeded Nahal's).
  await expect(row).toContainText('استودیو نهال');
  await row.locator('td').first().click();
  await expect(page).toHaveURL(/\/en\/desk\/requests\/[^/]+$/);

  const thread = page.getByTestId('request-thread');
  await expect(thread).toContainText(BODY);
  await expect(thread).toContainText('I have a logo already.');
  await page.getByRole('textbox').fill('Lovely — can we call tomorrow at ten?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(thread).toContainText('can we call tomorrow at ten?');

  // The customer, in another browser context, opens the row and sees the reply.
  const context = await browser.newContext();
  const customerPage = await context.newPage();
  await signIn(customerPage, CUSTOMER, 'en');
  await customerPage.goto('/en/app/contracts');
  await customerPage.locator('.request-row', { hasText: TITLE }).click();
  const drawer = customerPage.getByRole('dialog');
  await expect(drawer.getByTestId('request-thread')).toContainText('can we call tomorrow at ten?');
  await context.close();
});

test('design and development never see requests: no nav row, and the direct link goes home', async ({ page }) => {
  await signIn(page, DESIGNER, 'en');
  await expect(page.locator('.desk-nav').getByText('Requests', { exact: true })).toHaveCount(0);
  await page.goto('/en/desk/requests');
  await expect(page).not.toHaveURL(/\/desk\/requests/);
  await expect(page.getByText(TITLE)).toHaveCount(0);
});

test('sales converts the request: the contract form opens prefilled, and the thread stays, read-only', async ({ page }) => {
  await signIn(page, SALES, 'en');
  await page.goto('/en/desk/requests');
  await page.locator('tr.crow', { hasText: TITLE }).locator('td').first().click();
  await page.getByRole('link', { name: 'Convert to contract' }).click();

  // The existing create-contract form, prefilled: the request's customer
  // (fixed) and its title in the language it was written in. The other
  // language's title is sales's to write.
  await expect(page).toHaveURL(/\/en\/desk\/contracts\?request=/);
  await expect(page.getByTestId('converting-request')).toContainText(TITLE);
  await expect(page.locator('#nc-customer')).toBeDisabled();
  await expect(page.locator('#nc-en')).toHaveValue(TITLE);
  await expect(page.locator('#nc-fa')).toHaveValue('');
  await page.locator('#nc-fa').fill('فروشگاه برای استودیوی من');
  await page.locator('#nc-ref').fill('RC-2026-J2A');
  await page.getByRole('button', { name: 'Create contract' }).click();

  // The converted contract is a new-road one since J7, which lands on its steps.
  await page.waitForURL(/\/en\/desk\/contracts\/[^/]+\/(contract|steps)$/);
  // "Linked from the contract": the header points back at the request.
  const link = page.getByRole('link', { name: 'View the original request' });
  await expect(link).toBeVisible();
  await link.click();

  // The request page now reads as converted, and the thread takes no messages.
  await expect(page.getByText('This request became a contract.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the contract' })).toBeVisible();
  await expect(page.getByTestId('request-thread')).toContainText('can we call tomorrow at ten?');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
  await expect(page.getByText('the conversation is read-only')).toBeVisible();
});

test('the customer sees the converted request until sales hands the contract over, then the contract carries the thread', async ({
  page,
  request,
}) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');
  // Converted, but not yet published: still a row, now "being drawn up", and read-only.
  const row = page.locator('.request-row', { hasText: TITLE });
  await expect(row).toContainText('Being drawn up');
  await row.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('the conversation is read-only')).toBeVisible();
  await expect(drawer.getByRole('textbox')).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Close' }).click();

  // Sales completes step 1 (the converted contract is a new-road one since J7,
  // and handing it over needs a brief — `BRIEF_MISSING` otherwise; the brief
  // itself is `17-requirements`' subject, so it goes in over the API) …
  await completeStepOneViaApi(request, 'RC-2026-J2A');

  // … and publishes the contract.
  await signIn(page, SALES, 'en');
  await page.goto('/en/desk/contracts');
  await page.locator('tr.crow', { hasText: 'RC-2026-J2A' }).getByRole('button', { name: 'Publish' }).click();
  await expect(page.locator('tr.crow', { hasText: 'RC-2026-J2A' }).locator('td').nth(5)).not.toHaveText('—');

  // The request row is gone; the contract is the row, and its page carries
  // the original request and its thread, read-only.
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');
  await expect(page.locator('.request-row', { hasText: TITLE })).toHaveCount(0);
  // (Titled as the form was prefilled: sales kept the customer's own English title.)
  await page.locator('tr.crow', { hasText: TITLE }).click();
  const origin = page.locator('#origin-request');
  await expect(origin).toBeVisible();
  await expect(origin).toContainText(TITLE);
  await expect(origin).toContainText('can we call tomorrow at ten?');
  await expect(origin.getByRole('textbox')).toHaveCount(0);
});

/** ---- the other ending, in Persian -------------------------------------------------- */

async function submitPersian(page: Page, title: string, body: string) {
  await page.goto('/fa/app/contracts');
  await page.getByRole('button', { name: 'درخواستِ تازه' }).click();
  await page.locator('#nr-title').fill(title);
  await page.locator('#nr-body').fill(body);
  await page.getByRole('button', { name: 'ارسالِ درخواست' }).click();
  await expect(page.getByRole('dialog').getByTestId('request-thread')).toContainText(body);
}

test('in Persian: a request is archived with a reason, and the customer is shown the reason on the page and by SMS', async ({
  page,
}) => {
  const title = 'طراحی لوگو';
  const body = 'برای برندم یک لوگوی تازه می‌خواهم.';
  await signIn(page, CUSTOMER, 'fa');
  await submitPersian(page, title, body);
  await page.getByRole('dialog').getByRole('button', { name: 'بستن' }).click();
  await expect(page.locator('.request-row', { hasText: title })).toContainText('در انتظارِ بررسی');

  // Sales, in Persian: the nav row, the inbox, and an archive that refuses to be empty.
  await signIn(page, SALES, 'fa');
  await expect(page.locator('.desk-nav').getByText('درخواست‌ها', { exact: true })).toBeVisible();
  await page.goto('/fa/desk/requests');
  await page.locator('tr.crow', { hasText: title }).locator('td').first().click();
  await expect(page.getByTestId('request-thread')).toContainText(body);

  await page.getByRole('button', { name: 'بایگانی', exact: true }).click();
  const reasonBox = page.locator('#archive-reason');
  await reasonBox.fill('   ');
  await expect(page.getByRole('button', { name: 'بایگانیِ درخواست' })).toBeDisabled();
  await reasonBox.fill('طراحی لوگو خارج از حوزهٔ کار ماست.');
  await page.getByRole('button', { name: 'بایگانیِ درخواست' }).click();
  await expect(page.getByText('بایگانی‌شده: طراحی لوگو خارج از حوزهٔ کار ماست.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0); // a closed thread takes no messages

  // The customer sees the badge and the reason in the list…
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  const row = page.locator('.request-item', { hasText: title });
  await expect(row).toContainText('بایگانی‌شده');
  await expect(row).toContainText('دلیل: طراحی لوگو خارج از حوزهٔ کار ماست.');

  // …and was told by SMS, in Persian, pointing at the page rather than carrying the reason.
  const sms = await latestSms(CUSTOMER.phone);
  expect(sms).toContain('درخواست شما در ریشه بایگانی شد');
  expect(sms).toContain('/fa/app/contracts?request=');
});
