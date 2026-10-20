import { test, expect, type Page } from '@playwright/test';
import {
  CONTRIBUTOR,
  CUSTOMER,
  DESIGNER,
  SALES,
  WIZARD_CONTRACT_REF,
  WIZARD_CONTRACT_TITLE,
  apiSignIn,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  resetTestDatabase,
  signIn,
} from './helpers';

/**
 * J12 — the customer's dashboard and a home screen per staff role (journeys build
 * plan §5 "J12"), driven in the browser in both languages.
 *
 * **The customer** opens `/app` after an invoice has been issued and a contract
 * draft published: the Dashboard is the first rail item, what waits on *them* is
 * listed before what waits on Root, each item is a link to the place that clears it
 * (the contract on the step it is about; the invoice itself), and the three
 * standing actions are there. In Persian the page is RTL, the sentences are the
 * customer's «تو» register, and an invoice number stays Latin. An account with no
 * contract and no request meets an empty state that says what is true about it.
 *
 * **A designer** signs in to *My work*: with the agreement signed the design step is
 * theirs and the customer's note on it needs an answer; the link opens the desk's
 * Steps tab on the design step. Sales' Overview keeps its Needs-Root queue — now read
 * from what Root owes, not from a status.
 *
 * The contract is taken through steps 1 and 2 (and, for the designer's story, the
 * customer's approval, signature and a note) over the API: those are
 * `17-requirements`, `18-scope-draft` and `20-agreement`'s stories.
 */

test.describe.configure({ mode: 'serial' });

let contractId = '';

test.beforeEach(async ({ request }) => {
  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await completeStepTwoViaApi(request, contractId);
});

/** Sales issues a one-off invoice on the contract — the first invoice, so `INV-000001`. */
async function issueInvoice(request: Parameters<typeof completeStepOneViaApi>[0]) {
  await apiSignIn(request, SALES);
  const { allContracts } = await gql<{ allContracts: Array<{ id: string; customer: { id: string } }> }>(request, '{ allContracts { id customer { id } } }');
  const contract = allContracts.find((c) => c.id === contractId)!;
  const { createInvoiceDraft } = await gql<{ createInvoiceDraft: { id: string } }>(
    request,
    'mutation($cu: ID!, $c: ID){ createInvoiceDraft(customerId: $cu, contractId: $c, source: CONTRACT, descriptionFa: "پیش‌پرداخت", descriptionEn: "Deposit", amount: "5000000", paymentTermDays: 7) { id } }',
    { cu: contract.customer.id, c: contractId },
  );
  await gql(request, 'mutation($e: ID!){ issueInvoice(entryId: $e) { id } }', { e: createInvoiceDraft.id });
  return createInvoiceDraft.id;
}

const TITLE: Record<'en' | 'fa', string> = { en: WIZARD_CONTRACT_TITLE, fa: 'فروشگاه آنلاین نهال' };

/** What no rendered sentence may contain: a locale key shown as itself. */
const NO_RAW_KEYS = /\b(attention|home|desk|portal)\.[A-Za-z_.]+/;

test('the customer’s dashboard, in English: first in the rail, the draft and the invoice waiting on them, each a link that opens its place', async ({ page, request }) => {
  const invoiceId = await issueInvoice(request);
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app');

  // The Dashboard is the first rail item, and the only one lit.
  const rail = page.locator('.side-nav .side-link');
  await expect(rail.first()).toHaveText('Dashboard');
  await expect(rail.first()).toHaveClass(/side-link-active/);
  await expect(page.locator('.side-nav .side-link-active')).toHaveCount(1);
  await expect(rail.last()).toHaveText('Support');
  await expect(page.getByTestId('dashboard')).toBeVisible();

  // What waits on them: the contract draft Root published, and the invoice Root issued.
  const draft = page.locator('[data-testid="home-item"][data-kind="DRAFT_TO_REVIEW"][data-waiting-on="CUSTOMER"]');
  await expect(draft).toHaveCount(1);
  await expect(draft).toContainText('Root published the contract draft (v1)');
  await expect(draft).toContainText(WIZARD_CONTRACT_REF);
  const invoice = page.locator('[data-testid="home-item"][data-kind="INVOICE_DUE"][data-waiting-on="CUSTOMER"]');
  await expect(invoice).toHaveCount(1);
  await expect(invoice).toContainText('Invoice INV-000001 is due on');
  expect(await page.getByTestId('dashboard').innerText()).not.toMatch(NO_RAW_KEYS);

  // The standing actions: a new request, the contract in progress, and no tool (none is granted).
  const actions = page.getByTestId('home-actions');
  await expect(actions.getByRole('button', { name: 'New request' })).toBeVisible();
  await expect(actions.getByRole('link', { name: `Open ${TITLE.en}` })).toHaveAttribute('href', `/en/app/contracts/${contractId}`);

  // The draft opens the contract on the agreement — the step is where Root is waiting for them.
  await draft.getByRole('link').click();
  await page.waitForURL(new RegExp(`/en/app/contracts/${contractId}\\?step=AGREEMENT$`));
  await expect(page.locator('.stepper-item[data-step="AGREEMENT"] [aria-current="step"]')).toHaveCount(1);

  // The invoice opens itself.
  await page.goto('/en/app');
  await page.locator('[data-testid="home-item"][data-kind="INVOICE_DUE"]').getByRole('link').click();
  await page.waitForURL(new RegExp(`/en/app/invoices/${invoiceId}$`));
  await expect(page.getByTestId('invoice-detail-number')).toHaveText('INV-000001');

  // The old landing is untouched: Contracts is still a rail item, and still lists the contract.
  await page.goto('/en/app/contracts');
  await expect(page.locator('.side-nav .side-link-active')).toHaveText('Contracts');
  await expect(page.locator('tr.crow', { hasText: WIZARD_CONTRACT_TITLE })).toBeVisible();
});

test('the customer’s dashboard, in Persian: right to left, «تو», the invoice number still Latin', async ({ page, request }) => {
  await issueInvoice(request);
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app');

  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const rail = page.locator('.side-nav .side-link');
  await expect(rail.first()).toHaveText('داشبورد');
  await expect(rail.first()).toHaveClass(/side-link-active/);
  await expect(page.getByRole('heading', { level: 1, name: 'داشبورد' }).first()).toBeVisible();

  const draft = page.locator('[data-testid="home-item"][data-kind="DRAFT_TO_REVIEW"]');
  await expect(draft).toHaveCount(1);
  await expect(draft).toContainText('ریشه پیش‌نویس قرارداد');
  await expect(draft).toContainText('بخوانش');
  const invoice = page.locator('[data-testid="home-item"][data-kind="INVOICE_DUE"]');
  await expect(invoice).toContainText('صورت‌حساب INV-000001');
  await expect(invoice).toContainText('سررسید');
  // Under the heading that says whose move it is, and nothing is a raw key.
  await expect(page.getByRole('heading', { name: 'منتظر تو' })).toBeVisible();
  expect(await page.getByTestId('dashboard').innerText()).not.toMatch(NO_RAW_KEYS);

  await expect(page.getByTestId('home-actions').getByRole('button', { name: 'درخواستِ تازه' })).toBeVisible();
  await expect(page.getByTestId('home-actions').getByRole('link', { name: `بازکردنِ «${TITLE.fa}»` })).toBeVisible();
});

test('an account with no contract and no request is told what is true: start with a request', async ({ page }) => {
  // A contributor is a staff account that is nobody's customer: the portal is open to it, and it owns nothing.
  await signIn(page, CONTRIBUTOR, 'en');
  await page.goto('/en/app');
  const empty = page.getByTestId('home-empty');
  await expect(empty).toContainText('You have no contracts or requests yet');
  await expect(empty).not.toContainText('Nothing here');
  await expect(page.getByTestId('home-actions').getByRole('button', { name: 'New request' })).toBeVisible();
  await expect(page.getByTestId('home-actions').getByRole('link')).toHaveCount(0);

  await page.goto('/fa/app');
  await expect(page.getByTestId('home-empty')).toContainText('هنوز قرارداد یا درخواستی نداری');
});

test('a designer lands on My work: the design step is theirs, the customer’s note needs an answer, and the link opens the step — in both languages', async ({ page, request }) => {
  await approveAndSignViaApi(request, contractId);
  await gql(
    request,
    'mutation($c: ID!, $b: String!){ submitFeedback(contractId: $c, step: DESIGN, target: { general: true }, body: $b) { item { id } } }',
    { c: contractId, b: 'Can the first round be calmer?' },
  );

  await signIn(page, DESIGNER, 'en');
  // `/desk` is the staff index; for any capability set it is My work.
  await expect(page).toHaveURL(/\/en\/desk\/work$/);
  const nav = page.locator('.desk-nav .desk-link');
  await expect(nav.first()).toHaveText('My work');
  await expect(nav.first()).toHaveClass(/desk-link-active/);
  // Overview is the whole book's view: a designer is not offered it.
  await expect(page.locator('.desk-nav').getByText('Overview', { exact: true })).toHaveCount(0);

  const work = page.getByTestId('my-work');
  const items = work.getByTestId('home-item');
  await expect(items.filter({ hasText: 'The design step is open and no round has been published yet.' })).toHaveCount(1);
  const note = items.filter({ hasText: '1 customer comment needs an answer.' });
  await expect(note).toHaveCount(1);
  await expect(note).toContainText(WIZARD_CONTRACT_REF);
  // A designer's list is design work: no invoice, no approval, no request.
  await expect(work.locator('[data-kind="INVOICE_OVERDUE"], [data-kind="INVOICE_ISSUABLE"], [data-kind="ANSWER_PENDING_APPROVAL"], [data-kind="REQUEST_MESSAGE"]')).toHaveCount(0);
  expect(await work.innerText()).not.toMatch(NO_RAW_KEYS);

  await note.getByRole('link').click();
  await page.waitForURL(new RegExp(`/en/desk/contracts/${contractId}/steps\\?step=DESIGN$`));
  await expect(page.locator('.stepper-item[data-step="DESIGN"] [aria-current="step"]')).toHaveCount(1);

  // The same page in Persian, in the desk's formal register.
  await signIn(page, DESIGNER, 'fa');
  await expect(page).toHaveURL(/\/fa\/desk\/work$/);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.locator('.desk-nav .desk-link').first()).toHaveText('کارهای من');
  const faWork = page.getByTestId('my-work');
  await expect(faWork.getByRole('heading', { name: 'کارهای من' })).toBeVisible();
  await expect(faWork.getByTestId('home-item').filter({ hasText: 'نظر مشتری پاسخ می‌خواهد' })).toHaveCount(1);
  await expect(faWork.getByTestId('home-item').filter({ hasText: 'مرحله‌ی طرح باز است' })).toHaveCount(1);
  expect(await faWork.innerText()).not.toMatch(NO_RAW_KEYS);
});

test('what the customer reads changes with the act that changes it: the note moves their dashboard from "Root is preparing" to "waiting for Root’s answer"', async ({ page, request }) => {
  await approveAndSignViaApi(request, contractId);
  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app');
  // Signed: the draft's lines are gone; Root is preparing the first round, which is on Root's list.
  await expect(page.locator('[data-testid="home-item"][data-kind="DRAFT_TO_REVIEW"]')).toHaveCount(0);
  const preparing = page.locator('[data-testid="home-item"][data-kind="STEP_WAITING"]');
  await expect(preparing).toContainText('Root is preparing the first design round for you.');
  await expect(preparing).toHaveAttribute('data-waiting-on', 'ROOT');
  await expect(page.getByRole('heading', { name: 'Waiting on Root' })).toBeVisible();

  await gql(
    request,
    'mutation($c: ID!, $b: String!){ submitFeedback(contractId: $c, step: DESIGN, target: { general: true }, body: $b) { item { id } } }',
    { c: contractId, b: 'Can the first round be calmer?' },
  );
  await page.reload();
  await expect(page.locator('[data-testid="home-item"][data-kind="FEEDBACK_UNRESOLVED"]')).toContainText('1 of your comments is still waiting for Root’s answer.');
});

test('sales’ Overview keeps its tiles and a Needs-Root queue that lists the contract Root owes something on', async ({ page, request }) => {
  await approveAndSignViaApi(request, contractId);
  await gql(
    request,
    'mutation($c: ID!, $b: String!){ submitFeedback(contractId: $c, step: DESIGN, target: { general: true }, body: $b) { item { id } } }',
    { c: contractId, b: 'Can the first round be calmer?' },
  );
  await signIn(page, SALES, 'en');
  await expect(page).toHaveURL(/\/en\/desk\/work$/);
  await expect(page.locator('.desk-nav .desk-link').first()).toHaveText('My work');
  await page.locator('.desk-nav').getByText('Overview', { exact: true }).click();
  await page.waitForURL(/\/en\/desk\/overview$/);
  await expect(page.locator('.tile-count').first()).toBeVisible();
  // The wizard contract owes the customer an answer: it is in the queue because of that, not because of its status.
  const row = page.getByTestId('needs-root-row').filter({ hasText: WIZARD_CONTRACT_REF });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('things owed');

  // The "Waiting on Root" tile follows attention, as the box does (change note 02): its number is the number of rows in the box.
  // Polled, not read once: the tiles render 0 until their query lands.
  const rootTile = page.locator('[data-status="WAITING_ON_ROOT"] .tile-count');
  const rows = await page.getByTestId('needs-root-row').count();
  expect(rows).toBeGreaterThan(0);
  await expect(rootTile).toHaveText(String(rows));

  // On /fa the same number is written in the locale's digits (formatCount), not the Latin ones.
  await page.goto('/fa/desk/overview');
  await expect(page.getByTestId('needs-root-row')).toHaveCount(rows);
  const persian = String(rows).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  await expect(page.locator('[data-status="WAITING_ON_ROOT"] .tile-count')).toHaveText(persian);
});
