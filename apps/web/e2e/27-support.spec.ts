import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, CUSTOMER, apiSignIn, gql, resetTestDatabase, signIn } from './helpers';

/**
 * TK1's acceptance test (journeys change note 01): the customer's Support page
 * shows a new ticket, a staff answer and a status change without a reload.
 *
 * Each test proves "no reload" rather than assuming it: a marker is set on
 * `window` before the action and checked after the assertion, because a page
 * that reloaded would pass every visible assertion and prove nothing. Staff act
 * through the API after the customer's page has loaded (never a second
 * browser). Focus is dispatched as an event: headless Chrome has no reliable
 * window focus.
 *
 * Serial and on one database: the tests share the customer's session.
 */

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  resetTestDatabase();
});

const MARKER = '__tk1NoReload';

async function mark(page: Page) {
  await page.evaluate((m) => ((window as unknown as Record<string, unknown>)[m] = true), MARKER);
}
async function expectNotReloaded(page: Page) {
  expect(await page.evaluate((m) => (window as unknown as Record<string, unknown>)[m] === true, MARKER)).toBe(true);
}
async function focus(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function submitTicket(page: Page, subject: string, body: string) {
  await page.locator('.content-head button.btn-primary').click();
  const form = page.locator('form.auth-form');
  await form.locator('input.input').fill(subject);
  await form.locator('textarea').fill(body);
  await form.locator('button[type="submit"]').click();
}

function card(page: Page, subject: string) {
  return page.locator('.card.editor-card').filter({ hasText: subject });
}

async function ticketId(staff: APIRequestContext, subject: string): Promise<string> {
  const { allTickets } = await gql<{ allTickets: Array<{ id: string; subject: string }> }>(
    staff,
    '{ allTickets { id subject } }',
  );
  const found = allTickets.find((x) => x.subject === subject);
  if (!found) throw new Error(`no ticket "${subject}"`);
  return found.id;
}

const ANSWER = 'mutation($t: ID!, $b: String!){ addTicketMessage(ticketId: $t, body: $b) { id } }';

const SUBJECT = 'The contact form sends nothing';

test('TK-1: a new ticket is in the list as soon as it is submitted, without a reload', async ({ page }) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/support');
  await expect(page.getByRole('heading', { level: 1, name: 'Support' })).toBeVisible();
  await mark(page);

  await submitTicket(page, SUBJECT, 'I fill it in and press send and nothing arrives.');

  await expect(card(page, SUBJECT)).toBeVisible();
  await expect(card(page, SUBJECT).locator('.badge.ticket-status-open')).toHaveText('Open');
  await expectNotReloaded(page);
});

test('TK-2 and TK-3: a staff answer shows when the card opens, and a second answer and a status change show on focus', async ({
  page,
  request,
}) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/support');
  await expect(card(page, SUBJECT)).toBeVisible();
  await mark(page);

  // Staff answer after the page has loaded.
  await apiSignIn(request, ADMIN);
  const id = await ticketId(request, SUBJECT);
  await gql(request, ANSWER, { t: id, b: 'We are looking at it now.' });

  // TK-2: opening the card brings the answer.
  await card(page, SUBJECT).locator('button.workspace-row').click();
  await expect(card(page, SUBJECT)).toContainText('We are looking at it now.');

  // TK-3: a second answer and a status change, then the window regains focus.
  // The card stays open, and a half-typed reply survives the refetch.
  await card(page, SUBJECT).locator('textarea').fill('half a reply');
  await gql(request, ANSWER, { t: id, b: 'Fixed on the staging site.' });
  await gql(request, 'mutation($t: ID!){ setTicketStatus(ticketId: $t, status: RESOLVED) { id } }', { t: id });
  await focus(page);

  await expect(card(page, SUBJECT)).toContainText('Fixed on the staging site.');
  await expect(card(page, SUBJECT).locator('.badge.ticket-status-resolved')).toHaveText('Resolved');
  await expect(card(page, SUBJECT).locator('textarea')).toHaveValue('half a reply');
  await expectNotReloaded(page);
});

test('closing a card refetches too', async ({ page, request }) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/support');
  const row = card(page, SUBJECT).locator('button.workspace-row');
  await expect(row).toBeVisible();
  await row.click(); // open
  await mark(page);

  await apiSignIn(request, ADMIN);
  await gql(request, ANSWER, { t: await ticketId(request, SUBJECT), b: 'One more thing, while you were reading.' });
  await row.click(); // close: the refetch lands the answer in the cache
  await row.click(); // open again, without waiting on the network
  await expect(card(page, SUBJECT)).toContainText('One more thing, while you were reading.');
  await expectNotReloaded(page);
});

test('TK-4: the customer’s own reply shows at once', async ({ page }) => {
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/support');
  await card(page, SUBJECT).locator('button.workspace-row').click();
  await mark(page);

  await card(page, SUBJECT).locator('textarea').fill('Thank you, it works now.');
  await card(page, SUBJECT).locator('button[type="submit"]').click();

  await expect(card(page, SUBJECT).locator('.comment-text').filter({ hasText: 'Thank you, it works now.' })).toBeVisible();
  await expect(card(page, SUBJECT).locator('textarea')).toHaveValue('');
  await expectNotReloaded(page);
});

test('TK-5: the same in Persian', async ({ page, request }) => {
  const FA_SUBJECT = 'فرمِ تماس کار نمی‌کند';
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/support');
  await expect(page.getByRole('heading', { level: 1, name: 'پشتیبانی' })).toBeVisible();
  await mark(page);

  await submitTicket(page, FA_SUBJECT, 'پس از فشردنِ ارسال هیچ پیامی نمی‌رسد.');
  await expect(card(page, FA_SUBJECT)).toBeVisible();

  await apiSignIn(request, ADMIN);
  const id = await ticketId(request, FA_SUBJECT);
  await gql(request, ANSWER, { t: id, b: 'بررسی می‌کنیم.' });
  await card(page, FA_SUBJECT).locator('button.workspace-row').click();
  await expect(card(page, FA_SUBJECT)).toContainText('بررسی می‌کنیم.');

  await gql(request, 'mutation($t: ID!){ setTicketStatus(ticketId: $t, status: RESOLVED) { id } }', { t: id });
  await focus(page);
  await expect(card(page, FA_SUBJECT).locator('.badge.ticket-status-resolved')).toHaveText('حل‌شده');
  await expectNotReloaded(page);
});
