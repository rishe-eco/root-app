import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import {
  CUSTOMER,
  DESIGNER,
  DEVELOPER,
  SALES,
  apiSignIn,
  approveAndSignViaApi,
  completeStepOneViaApi,
  completeStepTwoViaApi,
  gql,
  resetTestDatabase,
  seedThemesViaApi,
  signIn,
} from './helpers';

/**
 * J10 — step 6, the demo, end to end in a real browser (journeys build plan §5
 * "J10"): **the first time the reporter snippet runs in a page in this repository**
 * (lifecycle plan §0.3.2 — owed since L2).
 *
 * A small static server plays the staging site on `http://nahal.staging.localhost:<port>`
 * (a real browser resolves `*.localhost` to loopback with no DNS) and serves a page
 * that loads **the repository's own `snippets/demo-reporter/root-demo-reporter.js`**,
 * with the `frame-ancestors` guard a real staging site sends. The story, in order,
 * because each test is the next one's precondition:
 *
 * 1. the developer opens a demo whose staging address is **dead** — the viewport hears
 *    nothing, readiness is not recorded, and the demo cannot be published; a wrong
 *    host is refused by the host rule;
 * 2. the developer corrects the address — the viewport loads the real site, the
 *    snippet reports from the site's own origin, **readiness is recorded with who**;
 * 3. the developer writes the frame (including a *how to test* line, whose help says
 *    staging-only credentials), publishes the demo, submits version 1 (the page map
 *    confirmed, then published);
 * 4. the customer, in Persian, sees the live site inside the portal, comments on a
 *    page; the developer answers; the customer **approves the phase** and it locks —
 *    for the developer too.
 *
 * Steps 1–4 of the contract (the brief, the draft, the agreement, a pre-made design) are taken over
 * the API (`17`, `18`, `20` and `21` are those stories) — so the build timeline, which the customer
 * reads from the design's approval on, is on the page too.
 */

test.describe.configure({ mode: 'serial' });

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 4173);
const APP_ORIGIN = `http://localhost:${WEB_PORT}`;
const SNIPPET = readFileSync(fileURLToPath(new URL('../../../snippets/demo-reporter/root-demo-reporter.js', import.meta.url)), 'utf8');
const TITLE_EN = 'Nahal online shop';
const TITLE_FA = 'فروشگاه آنلاین نهال';

let contractId = '';
let phaseId = '';
let demoId = '';
let staging: Server;
let stagingOrigin = '';

const html = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}` +
  // The three guards of the snippet's README: an explicit flag, a concrete parent origin, framed only.
  `<script src="/__root/reporter.js" data-enabled="true" data-root-origin="${APP_ORIGIN}"></script></body></html>`;

/** A pre-made design, proposed, chosen and approved over the API (`21-design` drives the screens). */
async function approvePremadeDesignViaApi(request: APIRequestContext, id: string) {
  const themes = await seedThemesViaApi(request, ['Astra', 'Boreal']);
  await apiSignIn(request, DESIGNER);
  await gql(request, 'mutation($c: ID!){ startDesignDraft(contractId: $c) { id } }', { c: id });
  await gql(request, 'mutation($c: ID!, $t: [ID!]!){ proposeThemes(contractId: $c, themeIds: $t) { id } }', { c: id, t: themes.map((t) => t.id) });
  await gql(request, 'mutation($c: ID!){ publishDesignRevision(contractId: $c) { id } }', { c: id });
  await apiSignIn(request, CUSTOMER);
  const round = await gql<{ contract: { concepts: Array<{ id: string }> } }>(request, 'query($c: ID!){ contract(id: $c) { concepts { id } } }', { c: id });
  await gql(request, 'mutation($c: ID!, $k: ID!){ chooseConcept(contractId: $c, conceptId: $k) { id } }', { c: id, k: round.contract.concepts[0].id });
  await gql(request, 'mutation($c: ID!){ approveDesign(contractId: $c) { id } }', { c: id });
}

test.beforeAll(async ({ request }) => {
  test.setTimeout(240_000);
  staging = createServer((req, res) => {
    // What a real staging site sends: framed by the portal and nobody else.
    res.setHeader('Content-Security-Policy', `frame-ancestors ${APP_ORIGIN}`);
    if (req.url === '/__root/reporter.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      res.end(SNIPPET);
    } else if (req.url?.startsWith('/about')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html('About', '<h1>NAHAL-STAGING-ABOUT</h1><a id="to-home" href="/">Home</a>'));
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html('Home', '<h1>NAHAL-STAGING-HOME</h1><a id="to-about" href="/about">About</a>'));
    }
  });
  await new Promise<void>((resolve) => staging.listen(0, resolve));
  stagingOrigin = `http://nahal.staging.localhost:${(staging.address() as AddressInfo).port}`;

  resetTestDatabase();
  contractId = await completeStepOneViaApi(request);
  await completeStepTwoViaApi(request, contractId);
  await approveAndSignViaApi(request, contractId);
  await approvePremadeDesignViaApi(request, contractId);

  // The demo is created over the API with an address nothing listens on: the first test is about what a
  // dead staging site does. (Port 1 refuses a connection at once.) Its two pages are declared too.
  await apiSignIn(request, DEVELOPER);
  const phase = await gql<{ contract: { phases: Array<{ id: string }> } }>(request, 'query($c: ID!){ contract(id: $c) { phases { id } } }', { c: contractId });
  phaseId = phase.contract.phases[0].id;
  await gql(request, 'mutation($p: ID!, $u: String!){ createDemo(phaseId: $p, stagingUrl: $u) { id } }', { p: phaseId, u: 'http://nahal.staging.localhost:1/' });
  const demo = await gql<{ contract: { phases: Array<{ demos: Array<{ id: string }> }> } }>(
    request,
    'query($c: ID!){ contract(id: $c) { phases { demos { id } } } }',
    { c: contractId },
  );
  demoId = demo.contract.phases[0].demos[0].id;
  for (const [key, fa, en, path] of [['home', 'خانه', 'Home page', '/'], ['about', 'درباره', 'About page', '/about']]) {
    await gql(request, 'mutation($d: ID!, $k: String!, $fa: String!, $en: String!, $p: String!){ declareDemoPage(demoId: $d, key: $k, labelFa: $fa, labelEn: $en, canonicalPath: $p) { id } }', {
      d: demoId,
      k: key,
      fa,
      en,
      p: path,
    });
  }
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => staging?.close(() => resolve()));
});

async function developerPhases(page: Page) {
  await signIn(page, DEVELOPER, 'en');
  await page.goto(`/en/desk/contracts/${contractId}/phases`);
  await expect(page.getByTestId('demo-readiness')).toBeVisible();
}

async function customerDemoStep(page: Page) {
  await signIn(page, CUSTOMER, 'fa');
  await page.goto('/fa/app/contracts');
  await page.locator('tr.crow', { hasText: TITLE_FA }).click();
  await page.waitForURL(/\/fa\/app\/contracts\/[^/]+$/);
  await page.locator('.stepper-item[data-step="DEMO"] button').click();
  await expect(page.getByTestId('demo-panel')).toBeVisible();
}

test('a staging site nothing listens on is not "ready": the demo cannot be published, and a wrong host is refused', async ({ page }) => {
  test.setTimeout(120_000);
  await developerPhases(page);
  await expect(page.getByTestId('demo-readiness')).toHaveAttribute('data-ready', 'false');
  await expect(page.getByTestId('demo-not-ready')).toContainText('Not heard from yet');
  // The frame exists, so the only thing in the way of publishing is the readiness check — and the button says so.
  await page.getByRole('button', { name: 'Generate frame' }).click();
  await expect(page.getByTestId('publish-demo')).toBeDisabled();
  await expect(page.getByTestId('publish-not-ready')).toContainText('cannot be published until the staging site has reported in');

  // The host rule: exactly one label under the staging domain.
  const urlField = page.locator('.demo-card input[dir="ltr"]').first();
  await urlField.fill('https://staging.localhost.evil.com/');
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();
  await expect(page.locator('.demo-card .error').first()).toContainText('exactly one label under the staging domain');
  await expect(page.getByTestId('demo-readiness')).toHaveAttribute('data-ready', 'false');
});

test('the developer corrects the address: the real snippet reports from the site’s own origin and readiness is recorded with who', async ({ page }) => {
  test.setTimeout(120_000);
  await developerPhases(page);
  const urlField = page.locator('.demo-card input[dir="ltr"]').first();
  await urlField.fill(`${stagingOrigin}/`);
  await page.getByRole('button', { name: 'Save', exact: true }).first().click();

  // The snippet in the framed page posted its path to the portal; the viewport checked the origin and the
  // portal recorded it. A staff browser heard the staging site — that is all the claim says.
  await expect(page.getByTestId('demo-readiness')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('demo-ready')).toContainText('recorded by');
  // …and the viewport matched the reported path to the declared page: the snippet's report is the same one
  // that tells the portal which page the reviewer is on.
  await expect(page.locator('.demo-current-page').first()).toContainText('Currently viewing: Home page');
  const frame = page.frameLocator('.demo-viewport iframe').first();
  await expect(frame.locator('h1')).toHaveText('NAHAL-STAGING-HOME');
  await expect(page.getByTestId('publish-not-ready')).toHaveCount(0);
  await expect(page.getByTestId('publish-demo')).toBeEnabled();

  // Navigating inside the framed site is a new report: the second page is matched too.
  // (A script click: the viewport scales the frame with a CSS transform, which Playwright's hit-test refuses.)
  await frame.locator('#to-about').evaluate((el) => (el as HTMLElement).click());
  await expect(frame.locator('h1')).toHaveText('NAHAL-STAGING-ABOUT');
  await expect(page.locator('.demo-current-page').first()).toContainText('Currently viewing: About page');
});

test('the frame with a how-to-test line, the demo published, and version 1 submitted — page map confirmed, then published', async ({ page }) => {
  test.setTimeout(120_000);
  await developerPhases(page);
  await expect(page.getByTestId('demo-readiness')).toHaveAttribute('data-ready', 'true');

  // The how-to-test line says out loud what may go in it (trap 2): staging-only credentials.
  await page.getByRole('button', { name: 'Add a line by hand' }).click();
  await page.locator('.demo-frame-authoring select').selectOption('HOW_TO_TEST');
  await expect(page.getByTestId('how-to-test-help')).toContainText('Never type a production credential');
  const form = page.locator('.demo-frame-authoring form').last();
  await form.locator('input[dir="rtl"]').fill('ورود آزمایشی: demo@staging.test');
  await form.locator('input[dir="ltr"]').fill('Staging login: demo@staging.test (staging only)');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-testid="feedback-target"]', { hasText: 'Staging login' })).toBeVisible();

  await page.getByTestId('publish-demo').click();
  await expect(page.getByTestId('publish-demo')).toHaveText('Published');

  // Version 1: the page map is confirmed with the build (without it nothing can be published).
  await expect(page.getByTestId('page-map')).toContainText('/about');
  const submission = page.getByTestId('iteration-form');
  await submission.getByPlaceholder('v1.4.0').fill('v1.0.0');
  await page.getByTestId('declare-build').click();
  const build = page.locator('[data-testid="demo-build"][data-build="1"]');
  await expect(build).toHaveAttribute('data-published', 'false');
  await expect(build.getByTestId('map-unconfirmed')).toBeVisible();
  await expect(build.getByTestId('publish-build')).toBeDisabled();
  await build.getByTestId('confirm-map').click();
  await expect(build.getByTestId('map-confirmed')).toBeVisible();
  await build.getByTestId('publish-build').click();
  await expect(build).toHaveAttribute('data-published', 'true');
  await expect(page.getByTestId('demo-counter')).toContainText('Version 1 of 2');
});

test('the customer, in Persian, browses the live site inside the portal, comments, and approves the phase — which locks it, for the developer too', async ({ page, request }) => {
  test.setTimeout(180_000);
  await customerDemoStep(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('demo-iteration')).toContainText('نسخه‌ی ۱ از ۲');
  // The staging site, framed in the portal — the frame-ancestors the site sent names exactly this origin.
  await expect(page.frameLocator('.demo-viewport iframe').first().locator('h1')).toHaveText('NAHAL-STAGING-HOME');
  // The developer's access note is the customer's to read — and to comment on.
  const target = page.locator('[data-testid="feedback-target"]', { hasText: 'ورود آزمایشی' });
  await expect(target).toBeVisible();
  // A customer's viewport records no readiness and is told nothing about who verified.
  await expect(page.getByTestId('demo-readiness')).toHaveCount(0);

  const about = page.locator('[data-testid="feedback-target"][data-key^="page:"]', { hasText: 'درباره' });
  await about.getByRole('button').first().click();
  await about.locator('textarea').fill('عکس تیم را اضافه کنید');
  await about.getByRole('button', { name: 'ارسال', exact: true }).click();
  await expect(about.getByTestId('feedback-status')).toHaveText('باز');
  // Approval is refused while a note is open — in her own language.
  await page.getByTestId('approve-step').click();
  await expect(page.getByTestId('approve-error')).toContainText('هنوز پاسخ نگرفته');

  // The developer answers (the answer is direct in the demo step) over the API.
  await apiSignIn(request, DEVELOPER);
  const items = await gql<{ contract: { feedbackItems: Array<{ id: string }> } }>(
    request,
    'query($c: ID!, $p: ID){ contract(id: $c) { feedbackItems(step: DEMO, phaseId: $p) { id } } }',
    { c: contractId, p: phaseId },
  );
  expect(items.contract.feedbackItems.length).toBe(1);
  await gql(request, 'mutation($i: ID!){ answerFeedback(itemId: $i, body: "عکس در نسخه‌ی بعد اضافه می‌شود", resolution: ADDRESSED) { id } }', { i: items.contract.feedbackItems[0].id });

  await page.reload();
  await page.locator('.stepper-item[data-step="DEMO"] button').click();
  await expect(about.getByTestId('feedback-status')).toHaveText('رسیدگی‌شده');
  await page.getByTestId('approve-step').click();
  await expect(page.getByTestId('feedback-approve')).toContainText('این مرحله تأییدشده است');
  await expect(page.locator('.stepper-item[data-step="DEMO"]')).toHaveAttribute('data-status', 'DONE');
  await expect(about.getByTestId('feedback-status')).toHaveText('پذیرفته‌شده');
  // No raw key anywhere on the panel.
  const text = await page.getByTestId('step-panel').innerText();
  expect(text).not.toMatch(/\b(demoStep|feedback)\.[A-Za-z_.]+/);

  // The developer's side is locked: no more versions or lines, the desk says why.
  await developerPhases(page);
  await expect(page.getByTestId('submission-locked')).toBeVisible();
  await expect(page.getByTestId('iteration-form')).toHaveCount(0);
});

test('the build timeline and the phase’s acceptance are what sales reads next: the phase is approved, its invoice issuable', async ({ page, request }) => {
  test.setTimeout(120_000);
  await apiSignIn(request, SALES);
  const plan = await gql<{ contract: { paymentPlan: { invoices: Array<{ state: string; blockedBy: string | null }> } } }>(
    request,
    'query($c: ID!){ contract(id: $c) { paymentPlan { invoices { state blockedBy } } } }',
    { c: contractId },
  );
  // The plan's one invoice is tied to this phase: the approval just written is what made it issuable (J13's flip).
  expect(plan.contract.paymentPlan.invoices[0].state).toBe('ISSUABLE');

  await signIn(page, CUSTOMER, 'en');
  await page.goto('/en/app/contracts');
  await page.locator('tr.crow', { hasText: TITLE_EN }).click();
  await page.waitForURL(/\/en\/app\/contracts\/[^/]+$/);
  // The timeline reads off published rows only: the phase, its version and its approval.
  const timeline = page.getByTestId('build-timeline');
  await expect(timeline).toBeVisible();
  await expect(timeline).toContainText('Version 1');
  await expect(timeline).toContainText('Approved');
  await expect(timeline).toContainText('Demo opened');
});
