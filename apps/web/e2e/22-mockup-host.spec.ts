import { test, expect } from '@playwright/test';
import {
  CUSTOMER,
  E2E_MOCKUP_DEMO_ID,
  apiSignIn,
  expireMockupGrants,
  gql,
  insertPublishedMockup,
  resetTestDatabase,
  signIn,
  storeZip,
  uploadMockupBundle,
} from './helpers';

/**
 * J9a — the mockup host, in a real browser (journeys build plan §5 "J9").
 *
 * The API serves an uploaded mockup on a subdomain of its own per viewer:
 * `http://<grant-id>.mockup.localhost:<api port>/`. Real browsers resolve
 * `*.localhost` to loopback with no DNS and no hosts file, so this drives a real
 * subdomain — the thing the integration suite (which fakes a `Host` header) can
 * only approximate: that a root-relative link resolves at the host's root, that
 * the injected reporter tag is a script the browser actually fetches, that the
 * portal's session cookie does not follow the customer to the mockup's origin,
 * and that nothing of the portal answers there.
 *
 * The bundle goes up through the real `POST /upload` (the streamed path); the
 * demo and build rows that point at it are inserted directly — `createMockupDemo`
 * and `declareMockupBuild` are J9b's.
 */

test.describe.configure({ mode: 'serial' });

const HOME = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mockup home</title><link rel="stylesheet" href="/css/app.css"></head>
<body><h1>Nahal — home</h1><a id="to-about" href="/about.html">About us</a></body></html>`;
const ABOUT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mockup about</title></head>
<body><h1>About the studio</h1><a id="back" href="/">Home</a></body></html>`;

let mockupUrl = '';

test.beforeAll(async ({ request }) => {
  resetTestDatabase();
  const fileId = await uploadMockupBundle(
    request,
    storeZip({
      'nahal/index.html': HOME,
      'nahal/about.html': ABOUT,
      'nahal/css/app.css': 'h1 { color: rgb(200, 0, 0); }',
    }),
  );
  insertPublishedMockup(fileId);

  // The customer asks for their view over the API, as the portal will.
  await apiSignIn(request, CUSTOMER);
  const { mockupViewUrl } = await gql<{ mockupViewUrl: string }>(request, 'query($d: ID!){ mockupViewUrl(demoId: $d) }', {
    d: E2E_MOCKUP_DEMO_ID,
  });
  mockupUrl = mockupViewUrl;
});

test('the view is a real subdomain of mockup.localhost, on the API\'s own port', () => {
  const url = new URL(mockupUrl);
  expect(url.protocol).toBe('http:');
  expect(url.hostname).toMatch(/^[0-9a-f]{32}\.mockup\.localhost$/);
  expect(url.port).toBe(process.env.E2E_API_PORT || '4101');
  expect(url.pathname).toBe('/');
});

test('the customer opens it; a root-relative link navigates; the stylesheet applies; the reporter tag is on the page', async ({ page }) => {
  const navigation = await page.goto(mockupUrl);
  expect(navigation!.status()).toBe(200);

  await expect(page.getByRole('heading', { name: 'Nahal — home' })).toBeVisible();
  // The single top folder (`nahal/`) is the root: the bundle's own CSS, linked
  // root-relative, loaded.
  await expect(page.locator('h1')).toHaveCSS('color', 'rgb(200, 0, 0)');

  // The injected tag is in the document, before </head>, and the browser fetched the script.
  const tag = page.locator('head script[src="/__root/reporter.js"]');
  await expect(tag).toHaveCount(1);
  await expect(tag).toHaveAttribute('data-enabled', 'true');
  await expect(tag).toHaveAttribute('data-root-origin', /^http:\/\/localhost:\d+$/);
  const fetched = await page.evaluate(() =>
    performance.getEntriesByType('resource').some((r) => r.name.endsWith('/__root/reporter.js')),
  );
  expect(fetched).toBe(true);

  // A root-relative link resolves at the host's root.
  await page.locator('#to-about').click();
  await page.waitForURL((u) => u.pathname === '/about.html');
  await expect(page.getByRole('heading', { name: 'About the studio' })).toBeVisible();
  await expect(page.locator('head script[src="/__root/reporter.js"]')).toHaveCount(1);
  await page.locator('#back').click();
  await page.waitForURL((u) => u.pathname === '/');
  await expect(page.getByRole('heading', { name: 'Nahal — home' })).toBeVisible();
});

test('the response carries the mockup headers and no cookie, and the browser holds none for this origin', async ({ page, context }) => {
  const response = await page.goto(mockupUrl);
  const headers = response!.headers();
  expect(headers['content-security-policy']).toMatch(/^frame-ancestors http:\/\/localhost:\d+; default-src 'self' https: data: blob:/);
  expect(headers['content-security-policy']).toContain("connect-src 'self'; form-action 'none'");
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['set-cookie']).toBeUndefined();
  expect(await context.cookies(mockupUrl)).toEqual([]);
});

test('a portal session in the same browser does not follow the customer to the mockup origin', async ({ page }) => {
  await signIn(page, CUSTOMER);
  const seen: Array<string | undefined> = [];
  page.on('request', (req) => {
    if (req.url().startsWith(mockupUrl.replace(/\/$/, ''))) seen.push(req.headers()['cookie']);
  });
  await page.goto(mockupUrl);
  await expect(page.getByRole('heading', { name: 'Nahal — home' })).toBeVisible();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((c) => c === undefined)).toBe(true);
});

test('nothing of the portal answers on the mockup origin: script on the page reaches /graphql, /upload and /files and gets 404', async ({ page }) => {
  await page.goto(mockupUrl);
  const statuses = await page.evaluate(async () => {
    const out: Record<string, number> = {};
    out.graphql = (
      await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ me { id } }' }) })
    ).status;
    out.upload = (await fetch('/upload?class=DESIGN_IMAGE', { method: 'POST', body: new FormData() })).status;
    out.files = (await fetch('/files/anything')).status;
    out.health = (await fetch('/health')).status;
    out.spa = (await fetch('/en/portal')).status;
    return out;
  });
  expect(statuses).toEqual({ graphql: 404, upload: 404, files: 404, health: 404, spa: 404 });
});

test('a mockup path on the portal origin is never a bundle', async ({ page }) => {
  // The web app's own origin (vite preview): no such file, so its SPA fallback
  // answers — the point is that it is not the mockup's page.
  await page.goto('/about.html');
  await expect(page.getByRole('heading', { name: 'About the studio' })).toHaveCount(0);
  await page.goto('/__root/reporter.js');
  expect(await page.content()).not.toContain('root-demo-reporter');
});

test('an expired grant is a plain 404 in the browser', async ({ page }) => {
  expireMockupGrants();
  const response = await page.goto(mockupUrl);
  expect(response!.status()).toBe(404);
  await expect(page.locator('body')).toHaveText('Not found');
});
