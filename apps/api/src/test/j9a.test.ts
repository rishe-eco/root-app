import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Prisma, User } from '@prisma/client';
import * as yazl from 'yazl';

import { prisma, resetDatabase, seedFixture, type Fixture } from './db.js';
import { exec, ok, stop } from './graphql.js';
import { startFullApp, cookieFor } from './http.js';
import { storage } from '../lib/storage.js';
import { env } from '../lib/env.js';
import { __clearBundleCacheForTests } from '../lib/mockupServe.js';
import { GRANT_TTL_MS } from '../lib/mockupGrant.js';
import { DemoFrame } from '../graphql/resolvers/fields.js';

/**
 * J9a — the mockup host: kinds, the streamed bundle upload, view grants, and the
 * fenced router (journeys build plan §5 "J9", infrastructure half).
 *
 * Every mockup demo and build here is created **by direct insert**: the
 * mutations that make them (`createMockupDemo`, `declareMockupBuild`,
 * `publishBuild`'s mockup branch) are J9b's. What this file proves is the part
 * that has to be right before any of them exists — that uploaded code cannot
 * reach the portal, that a grant opens exactly what it should for exactly as
 * long as it should, that a bundle cannot be streamed into memory or accepted
 * unchecked, and that the schema refuses the shapes it says it does.
 */

let f: Fixture;
let app: { base: string; port: number; close: () => Promise<void> };

const staff: Record<string, User> = {};

before(async () => {
  await resetDatabase();
  app = await startFullApp();
});

beforeEach(async () => {
  await resetDatabase();
  __clearBundleCacheForTests();
  f = await seedFixture();
  for (const role of ['SALES', 'DESIGNER', 'DEVELOPER'] as const) {
    staff[role] = await prisma.user.create({
      data: { email: `${role.toLowerCase()}@test.local`, name: role, roles: [role], state: 'ACTIVE' },
    });
  }
  // A designer assigned to nothing: holds `design.author`, is not this contract's designer.
  staff.DESIGNER_OTHER = await prisma.user.create({
    data: { email: 'designer2@test.local', name: 'Designer 2', roles: ['DESIGNER'], state: 'ACTIVE' },
  });
  await prisma.contract.update({
    where: { id: f.contract.id },
    data: { designerId: staff.DESIGNER.id, developerId: staff.DEVELOPER.id },
  });
});

after(async () => {
  await app.close();
  await stop();
  await prisma.$disconnect();
});

// =================================================================================================
// Fixtures and helpers
// =================================================================================================

/** A zip built in-process, as `mockupBundle.test.ts` does — no binary fixtures are committed. */
function zipOf(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, content] of Object.entries(entries)) zip.addBuffer(Buffer.from(content), name);
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.end();
  });
}

/** Rewrites a same-length placeholder entry name in both zip headers — how a hostile zip is made, since yazl will not write one. */
function renameEntry(zip: Buffer, placeholder: string, actual: string): Buffer {
  assert.equal(placeholder.length, actual.length);
  const patched = Buffer.from(zip);
  const from = Buffer.from(placeholder);
  const to = Buffer.from(actual);
  for (let at = patched.indexOf(from); at >= 0; at = patched.indexOf(from, at + from.length)) to.copy(patched, at);
  return patched;
}

const HOME = `<!doctype html><html><head><title>Home</title></head><body><a href="/about.html">About</a></body></html>`;
const ABOUT = `<!doctype html><html><head><title>About</title></head><body>about page</body></html>`;

const BASIC_SITE: Record<string, string> = {
  'index.html': HOME,
  'about.html': ABOUT,
  'css/app.css': 'body { color: red; }',
  'js/app.js': 'console.log("hi");',
};

/** A MOCKUP demo with one published (or not) build serving `files`. Direct inserts: J9b owns the mutations. */
async function seedMockup(
  files: Record<string, string | Buffer> = BASIC_SITE,
  opts: { published?: boolean; number?: number; demoId?: string; rawZip?: Buffer } = {},
) {
  const zip = opts.rawZip ?? (await zipOf(files));
  const key = await storage.put('PRIVATE', zip, '.zip');
  const file = await prisma.storedFile.create({
    data: {
      key,
      class: 'MOCKUP_BUNDLE',
      visibility: 'PRIVATE',
      mime: 'application/zip',
      bytes: zip.length,
      originalName: 'mockup.zip',
      contractId: f.contract.id,
      uploadedById: staff.DESIGNER.id,
    },
  });
  const demo =
    opts.demoId !== undefined
      ? await prisma.demo.findUniqueOrThrow({ where: { id: opts.demoId } })
      : await prisma.demo.create({
          data: { kind: 'MOCKUP', projectId: f.contract.projectId, contractId: f.contract.id },
        });
  const build = await prisma.build.create({
    data: {
      kind: 'MOCKUP',
      projectId: f.contract.projectId,
      demoId: demo.id,
      bundleFileId: file.id,
      number: opts.number ?? 1,
      declaredById: staff.DESIGNER.id,
      publishedAt: opts.published === false ? null : new Date(),
    },
  });
  return { demo, build, file, key };
}

const VIEW_URL = 'query($d: ID!){ mockupViewUrl(demoId: $d) }';

/** The URL `mockupViewUrl` hands `user`, and the grant id inside it. */
async function viewOf(user: User, demoId: string) {
  const url = ok(await exec(VIEW_URL, { as: user, variables: { d: demoId } })).mockupViewUrl as string;
  const id = new URL(url).hostname.split('.')[0];
  return { url, id };
}

/** `Host` for a grant: what the browser sends, and what Nginx passes on. */
const hostFor = (grantId: string) => `${grantId}.${env.MOCKUP_BASE_DOMAIN}:${env.PORT}`;

type Raw = { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string };

/** A request with a `Host` of the test's choosing — `fetch` will not reliably send one. */
function raw(
  path: string,
  opts: { host?: string; method?: string; headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: app.port, path, method: opts.method ?? 'GET', headers: { ...(opts.host ? { host: opts.host } : {}), ...opts.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const APP_ORIGIN = new URL(env.APP_ORIGIN).origin;

/** The headers every mockup response carries — 404s and redirects included. */
function assertMockupHeaders(res: Raw, label: string) {
  assert.equal(
    res.headers['content-security-policy'],
    `frame-ancestors ${APP_ORIGIN}; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'none'`,
    `${label}: CSP`,
  );
  assert.equal(res.headers['referrer-policy'], 'no-referrer', `${label}: Referrer-Policy`);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.equal(res.headers['set-cookie'], undefined, `${label}: Set-Cookie`);
}

const REPORTER_SNIPPET = (() => {
  let dir = fileURLToPath(new URL('.', import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'snippets', 'demo-reporter', 'root-demo-reporter.js');
    if (existsSync(candidate)) return readFileSync(candidate);
    dir = join(dir, '..');
  }
  throw new Error('the reporter snippet was not found');
})();

const TAG = `<script src="/__root/reporter.js" data-enabled="true" data-root-origin="${APP_ORIGIN}"></script>`;

// =================================================================================================
// Host isolation — the fence
// =================================================================================================

test('a request with a mockup Host reaches none of the portal: /graphql, /upload, /files, /ask, /health, /, the e2e route — all 404, all with the mockup headers', async () => {
  const { demo } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const host = hostFor(id);
  const session = { cookie: cookieFor(f.admin) };

  const gql = JSON.stringify({ query: '{ me { id } }' });
  const probes: Array<[string, string, Parameters<typeof raw>[1]]> = [
    ['POST /graphql', '/graphql', { method: 'POST', headers: { ...session, 'content-type': 'application/json' }, body: gql }],
    ['GET /graphql', '/graphql?query=%7Bme%7Bid%7D%7D', { headers: { ...session, 'apollo-require-preflight': 'true' } }],
    ['POST /upload', '/upload?class=DESIGN_IMAGE&contractId=x', { method: 'POST', headers: session, body: '' }],
    ['GET /files/:id', '/files/anything', { headers: session }],
    ['POST /ask', '/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"question":"hi"}' }],
    ['GET /health', '/health', {}],
    ['GET /', '/', { headers: session }],
    ['GET /assets/x.js', '/assets/index.js', {}],
    ['GET /__e2e/sms-outbox', '/__e2e/sms-outbox?phone=%2B989121234567', {}],
    ['POST /__e2e/rate-limits/reset', '/__e2e/rate-limits/reset', { method: 'POST' }],
  ];
  for (const [label, path, opts] of probes) {
    // The mockup host of a real grant — and of a grant that does not exist, and
    // of the bare base domain: the fence must not depend on the grant being valid.
    for (const h of [host, hostFor('0'.repeat(32)), env.MOCKUP_BASE_DOMAIN, `garbage.${env.MOCKUP_BASE_DOMAIN}`]) {
      const res = await raw(path, { ...opts, host: h });
      // Only the mockup router's own paths can answer on this host; none of these are.
      // (`GET /` on a live grant is the bundle's index page — asserted below, not here.)
      if (label === 'GET /' && h === host) {
        assert.equal(res.status, 200);
        continue;
      }
      assert.equal(res.status, 404, `${label} on ${h}`);
      assert.equal(res.text, 'Not found', `${label} on ${h}: the body is the router's, not the portal's JSON`);
      assertMockupHeaders(res, `${label} on ${h}`);
    }
  }
});

test('the same paths on the portal host are reachable — so the 404s above are the fence, not routes that were never mounted', async () => {
  const portal = `localhost:${app.port}`;
  assert.equal((await raw('/health', { host: portal })).status, 200);
  const gql = await raw('/graphql', {
    host: portal,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  });
  assert.equal(gql.status, 200);
  assert.match(gql.text, /"__typename":"Query"/);
  assert.equal((await raw('/files/nope', { host: portal })).status, 404); // the files route's own JSON 404
  const upload = await raw('/upload?class=DESIGN_IMAGE', { host: portal, method: 'POST', body: '' });
  assert.equal(upload.status, 401);
  assert.equal(upload.headers['content-security-policy'], undefined);
});

test('X-Forwarded-Host cannot walk a request out of the fence: the host is read from Host, not req.hostname', async () => {
  // With `trust proxy` on, req.hostname would take this header; Nginx passes a
  // client's straight through. A script on a mockup origin could send it to itself.
  const { id } = await viewOf(f.customer, (await seedMockup()).demo.id);
  const res = await raw('/graphql', {
    host: hostFor(id),
    method: 'POST',
    headers: { 'x-forwarded-host': 'localhost:3000', 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ __typename }' }),
  });
  assert.equal(res.status, 404);
  assertMockupHeaders(res, 'x-forwarded-host');
  // …and the reverse: the header names a mockup, the Host is the portal — the portal answers.
  const portal = await raw('/health', { host: `localhost:${app.port}`, headers: { 'x-forwarded-host': hostFor(id) } });
  assert.equal(portal.status, 200);
});

test('a mockup path on the portal host is never a bundle', async () => {
  const { demo } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const portal = `localhost:${app.port}`;
  for (const path of ['/', '/index.html', '/about.html', '/css/app.css', '/__root/reporter.js']) {
    const res = await raw(path, { host: portal });
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(res.text, /About|about page|console\.log|__root\/reporter/, path);
    assert.equal(res.headers['content-security-policy'], undefined, path);
  }
  // A grant id in the *path* of the portal host opens nothing either.
  assert.equal((await raw(`/${id}/index.html`, { host: portal })).status, 404);
  // Nor does a look-alike domain: a host is a mockup host only under the configured base.
  const other = await raw('/', { host: `${id}.mockup.evil.example` });
  assert.equal(other.status, 404);
  assert.equal(other.headers['content-security-policy'], undefined);
});

test('the fence is the first thing index.ts mounts — ahead of cookieParser, cors, originCheck and every router', () => {
  const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
  const mounts = [...source.matchAll(/^app\.use\(([^\n]*)/gm)].map((m) => m[1]);
  assert.ok(mounts.length >= 6, 'index.ts wiring changed shape — re-read it');
  assert.equal(mounts[0], 'mockupFence);', `the first app.use is ${mounts[0]}`);
  const fenceAt = source.indexOf('app.use(mockupFence)');
  for (const later of ['cookieParser()', 'cors(', 'originCheck', 'filesRouter', 'askRouter', 'smsOutboxRouter', "'/graphql'", "app.get('/health'"]) {
    const at = source.indexOf(later, source.indexOf('const app = express()'));
    assert.ok(at > fenceAt, `${later} is mounted before the fence`);
  }
});

// =================================================================================================
// The router: what a grant opens, and when it stops
// =================================================================================================

test('a valid grant serves the bundle at the host root, with the mockup headers, and root-relative links resolve (/about.html from /)', async () => {
  const { demo } = await seedMockup();
  const { id, url } = await viewOf(f.customer, demo.id);
  assert.equal(url, `http://${id}.${env.MOCKUP_BASE_DOMAIN}:${env.PORT}/`, 'dev/e2e form: http and the API port');
  assert.match(id, /^[0-9a-f]{32}$/);

  const home = await raw('/', { host: hostFor(id) });
  assert.equal(home.status, 200);
  assert.equal(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.match(home.text, /href="\/about\.html"/);
  assertMockupHeaders(home, '/');

  const about = await raw('/about.html', { host: hostFor(id) });
  assert.equal(about.status, 200);
  assert.match(about.text, /about page/);
  assertMockupHeaders(about, '/about.html');

  const css = await raw('/css/app.css', { host: hostFor(id) });
  assert.equal(css.status, 200);
  assert.equal(css.text, 'body { color: red; }');
});

test('the single-top-folder bundle is served from its folder as the root', async () => {
  const { demo } = await seedMockup({ 'site/index.html': HOME, 'site/about.html': ABOUT, 'site/img/logo.png': 'PNG' });
  const { id } = await viewOf(f.customer, demo.id);
  assert.equal((await raw('/', { host: hostFor(id) })).status, 200);
  assert.match((await raw('/about.html', { host: hostFor(id) })).text, /about page/);
  assert.equal((await raw('/img/logo.png', { host: hostFor(id) })).status, 200);
  // The folder name is not part of the URL space.
  assert.equal((await raw('/site/about.html', { host: hostFor(id) })).status, 404);
});

test('content types come from the extension; a directory path serves its index; /dir redirects to /dir/', async () => {
  const files: Record<string, string> = {
    'index.html': HOME,
    'docs/index.html': '<html><head></head><body>docs</body></html>',
    'a.css': 'x', 'a.js': 'x', 'a.mjs': 'x', 'a.json': '{}', 'a.png': 'x', 'a.jpg': 'x', 'a.jpeg': 'x', 'a.webp': 'x', 'a.gif': 'x',
    'a.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>', 'a.ico': 'x', 'a.woff': 'x', 'a.woff2': 'x', 'a.ttf': 'x', 'a.otf': 'x',
    'a.mp4': 'x', 'a.webm': 'x', 'a.txt': 'x',
  };
  const { demo } = await seedMockup(files);
  const { id } = await viewOf(f.customer, demo.id);
  const host = hostFor(id);
  const expected: Record<string, string> = {
    '/a.css': 'text/css; charset=utf-8',
    '/a.js': 'text/javascript; charset=utf-8',
    '/a.mjs': 'text/javascript; charset=utf-8',
    '/a.json': 'application/json; charset=utf-8',
    '/a.png': 'image/png',
    '/a.jpg': 'image/jpeg',
    '/a.jpeg': 'image/jpeg',
    '/a.webp': 'image/webp',
    '/a.gif': 'image/gif',
    '/a.svg': 'image/svg+xml',
    '/a.ico': 'image/x-icon',
    '/a.woff': 'font/woff',
    '/a.woff2': 'font/woff2',
    '/a.ttf': 'font/ttf',
    '/a.otf': 'font/otf',
    '/a.mp4': 'video/mp4',
    '/a.webm': 'video/webm',
    '/a.txt': 'text/plain; charset=utf-8',
    '/docs/': 'text/html; charset=utf-8',
  };
  for (const [path, type] of Object.entries(expected)) {
    const res = await raw(path, { host });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], type, path);
    assert.equal(res.headers['content-length'] === undefined, false, `${path}: a length`);
    assertMockupHeaders(res, path);
  }
  const redirect = await raw('/docs', { host });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/docs/');
  assertMockupHeaders(redirect, '/docs');
  // Never an open redirect: the Location is built from the bundle's own key.
  const sneaky = await raw('//docs', { host });
  assert.equal(sneaky.headers.location, '/docs/');
  // A path that is in no bundle is a 404 — and traversal is refused, not resolved.
  for (const path of ['/nope.html', '/../index.html', '/%2e%2e/index.html', '/css/%00', '/a%5Cb']) {
    const res = await raw(path, { host });
    assert.equal(res.status, 404, path);
    assertMockupHeaders(res, path);
  }
});

test('HTML gets the reporter tag — before </head>, else before </body>, else at the end — and CSS, JS and JSON do not', async () => {
  const { demo } = await seedMockup({
    'index.html': '<html><head><title>t</title></head><body>x</body></html>',
    'nohead.html': '<html><body>y</body></html>',
    'fragment.html': '<p>z',
    'a.css': 'body{}',
    'a.js': 'var x = "</head>";',
    'a.json': '{"a":"</head>"}',
    'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>x</title></svg>',
  });
  const { id } = await viewOf(f.customer, demo.id);
  const host = hostFor(id);
  const body = async (p: string) => (await raw(p, { host })).text;

  assert.equal(await body('/'), `<html><head><title>t</title>${TAG}</head><body>x</body></html>`);
  assert.equal(await body('/nohead.html'), `<html><body>y${TAG}</body></html>`);
  assert.equal(await body('/fragment.html'), `<p>z${TAG}`);
  assert.equal(await body('/a.css'), 'body{}');
  assert.equal(await body('/a.js'), 'var x = "</head>";');
  assert.equal(await body('/a.json'), '{"a":"</head>"}');
  assert.equal((await body('/logo.svg')).includes('reporter'), false);

  // Content-Length matches the injected body, not the stored one.
  const home = await raw('/', { host });
  assert.equal(Number(home.headers['content-length']), home.body.length);
});

test('the reporter script is the repository\'s own snippet, served on the mockup origin with the mockup headers', async () => {
  const { demo } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const res = await raw('/__root/reporter.js', { host: hostFor(id) });
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /^text\/javascript/);
  assert.deepEqual(res.body, REPORTER_SNIPPET);
  assertMockupHeaders(res, 'reporter');
  // Behind the grant check like everything else: no live grant, no snippet.
  assert.equal((await raw('/__root/reporter.js', { host: hostFor('1'.repeat(32)) })).status, 404);
});

test('no Set-Cookie on any mockup response, including when a valid session cookie is sent', async () => {
  const { demo } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const cookie = cookieFor(f.customer);
  for (const path of ['/', '/about.html', '/css/app.css', '/nope', '/__root/reporter.js', '/graphql', '/docs']) {
    for (const h of [hostFor(id), hostFor('f'.repeat(32))]) {
      const res = await raw(path, { host: h, headers: { cookie } });
      assert.equal(res.headers['set-cookie'], undefined, `${path} on ${h}`);
      assertMockupHeaders(res, `${path} on ${h}`);
    }
  }
  // A method that is not GET/HEAD is a plain 404 with no CORS answer at all.
  const preflight = await raw('/', { host: hostFor(id), method: 'OPTIONS', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'GET' } });
  assert.equal(preflight.status, 404);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal((await raw('/', { host: hostFor(id), method: 'POST', body: 'x' })).status, 404);
  // HEAD is served like GET, without a body.
  const head = await raw('/about.html', { host: hostFor(id), method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
});

test('an unknown, expired, unpublished-build, lost-access or disabled-viewer grant is a plain 404 — every one the same answer', async () => {
  const { demo, build } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const live = () => raw('/', { host: hostFor(id) });
  assert.equal((await live()).status, 200);

  // unknown
  assert.equal((await raw('/', { host: hostFor('a'.repeat(32)) })).status, 404);

  // The build is un-published (or was never): a grant to it opens nothing.
  await prisma.build.update({ where: { id: build.id }, data: { publishedAt: null } });
  const unpublished = await live();
  assert.equal(unpublished.status, 404);
  assertMockupHeaders(unpublished, 'unpublished');
  await prisma.build.update({ where: { id: build.id }, data: { publishedAt: new Date() } });
  assert.equal((await live()).status, 200);

  // The customer loses sight of the contract (it goes back to a draft).
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });
  assert.equal((await live()).status, 404);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: new Date('2026-07-01T09:00:00Z') } });
  assert.equal((await live()).status, 200);

  // The account is disabled.
  await prisma.user.update({ where: { id: f.customer.id }, data: { state: 'DISABLED' } });
  assert.equal((await live()).status, 404);
  await prisma.user.update({ where: { id: f.customer.id }, data: { state: 'ACTIVE' } });
  assert.equal((await live()).status, 200);

  // Expired.
  await prisma.mockupViewGrant.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await live();
  assert.equal(expired.status, 404);
  assertMockupHeaders(expired, 'expired');
  assert.equal((await raw('/__root/reporter.js', { host: hostFor(id) })).status, 404);
});

test('a staff viewer\'s grant stops when they lose the contract: a designer on a discarded contract sees nothing', async () => {
  const { demo } = await seedMockup();
  const { id } = await viewOf(staff.DESIGNER, demo.id);
  assert.equal((await raw('/', { host: hostFor(id) })).status, 200);
  await prisma.contract.update({ where: { id: f.contract.id }, data: { status: 'DISCARDED' } });
  assert.equal((await raw('/', { host: hostFor(id) })).status, 404);
});

test('a grant to a SITE-kind build or demo is never served, however it got there', async () => {
  const { demo, build } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  const phase = await prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: 'P1' },
  });
  // A build that claims to be a SITE build is refused by the CHECK before it could be served…
  await assert.rejects(
    prisma.build.update({ where: { id: build.id }, data: { kind: 'SITE' } }),
    /Build_site_has_phase/,
  );
  // …and with a phase it is a legitimate SITE build, which a grant does not open.
  await prisma.build.update({ where: { id: build.id }, data: { kind: 'SITE', phaseId: phase.id } });
  assert.equal((await raw('/', { host: hostFor(id) })).status, 404);
});

test('an unreadable bundle (the row survived, the bytes did not) is a 404, not a 500', async () => {
  const { demo, key } = await seedMockup();
  const { id } = await viewOf(f.customer, demo.id);
  await storage.remove(key);
  const res = await raw('/', { host: hostFor(id) });
  assert.equal(res.status, 404);
  assertMockupHeaders(res, 'missing bytes');
});

// =================================================================================================
// mockupViewUrl and the grants
// =================================================================================================

test('mockupViewUrl mints a 12-hour grant, and a second call by the same viewer reuses it', async () => {
  const { demo, build } = await seedMockup();
  const before = Date.now();
  const first = await viewOf(f.customer, demo.id);
  const rows = await prisma.mockupViewGrant.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);
  assert.equal(rows[0].buildId, build.id);
  assert.equal(rows[0].viewerId, f.customer.id);
  const ttl = rows[0].expiresAt.getTime() - before;
  assert.ok(ttl > GRANT_TTL_MS - 60_000 && ttl <= GRANT_TTL_MS + 60_000, `ttl ${ttl}`);

  const second = await viewOf(f.customer, demo.id);
  assert.equal(second.id, first.id);
  assert.equal(await prisma.mockupViewGrant.count(), 1);
});

test('grants are per viewer: staff who can see the contract get their own, and never the customer\'s', async () => {
  const { demo } = await seedMockup();
  const customer = await viewOf(f.customer, demo.id);
  const designer = await viewOf(staff.DESIGNER, demo.id);
  const admin = await viewOf(f.admin, demo.id);
  assert.equal(new Set([customer.id, designer.id, admin.id]).size, 3);
  assert.equal(await prisma.mockupViewGrant.count(), 3);
});

test('a grant with little left is not reused; expired grants of the same viewer — and only theirs — are deleted when minting', async () => {
  const { demo, build } = await seedMockup();
  const { id: nearly } = await viewOf(f.customer, demo.id);
  await prisma.mockupViewGrant.update({ where: { id: nearly }, data: { expiresAt: new Date(Date.now() + 5 * 60_000) } });
  const stale = await prisma.mockupViewGrant.create({
    data: { id: 'b'.repeat(32), buildId: build.id, viewerId: f.customer.id, expiresAt: new Date(Date.now() - 60_000) },
  });
  const othersStale = await prisma.mockupViewGrant.create({
    data: { id: 'c'.repeat(32), buildId: build.id, viewerId: staff.DESIGNER.id, expiresAt: new Date(Date.now() - 60_000) },
  });

  const { id: minted } = await viewOf(f.customer, demo.id);
  assert.notEqual(minted, nearly, 'five minutes left is under the reuse floor');
  const ids = (await prisma.mockupViewGrant.findMany()).map((g) => g.id);
  assert.ok(ids.includes(minted));
  assert.ok(ids.includes(nearly), 'an unexpired grant is not deleted');
  assert.ok(!ids.includes(stale.id), 'the viewer\'s own expired grant is gone');
  assert.ok(ids.includes(othersStale.id), 'another viewer\'s expired grant is left alone');
});

test('mockupViewUrl serves the highest-numbered published iteration, not a draft one', async () => {
  const one = await seedMockup({ 'index.html': '<html><head></head><body>iteration one</body></html>' }, { number: 1 });
  const two = await seedMockup({ 'index.html': '<html><head></head><body>iteration two</body></html>' }, { number: 2, demoId: one.demo.id });
  await seedMockup({ 'index.html': '<html><head></head><body>iteration three (draft)</body></html>' }, { number: 3, demoId: one.demo.id, published: false });
  const { id } = await viewOf(f.customer, one.demo.id);
  assert.match((await raw('/', { host: hostFor(id) })).text, /iteration two/);
  assert.equal((await prisma.mockupViewGrant.findUniqueOrThrow({ where: { id } })).buildId, two.build.id);
});

test('mockupViewUrl refusals: NOT_FOUND for a stranger, an unknown id, a SITE demo, and no session; NO_PUBLISHED_MOCKUP before the first publish', async () => {
  const { demo } = await seedMockup({ 'index.html': HOME }, { published: false });
  assert.equal((await exec(VIEW_URL, { as: f.customer, variables: { d: demo.id } })).code, 'NO_PUBLISHED_MOCKUP');
  assert.equal((await exec(VIEW_URL, { as: f.stranger, variables: { d: demo.id } })).code, 'NOT_FOUND');
  assert.equal((await exec(VIEW_URL, { as: f.customer, variables: { d: 'nope' } })).code, 'NOT_FOUND');
  assert.equal((await exec(VIEW_URL, { as: null, variables: { d: demo.id } })).code, 'UNAUTHENTICATED');

  const phase = await prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: 'P1' },
  });
  const site = await prisma.demo.create({
    data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://s.example.com', publishedAt: new Date() },
  });
  assert.equal((await exec(VIEW_URL, { as: f.customer, variables: { d: site.id } })).code, 'NOT_FOUND');
  assert.equal(await prisma.mockupViewGrant.count(), 0, 'nothing was minted by any refusal');

  // The customer of an unpublished contract has no view of it at all.
  await prisma.build.updateMany({ data: { publishedAt: new Date() } });
  await prisma.contract.update({ where: { id: f.contract.id }, data: { publishedAt: null } });
  assert.equal((await exec(VIEW_URL, { as: f.customer, variables: { d: demo.id } })).code, 'NOT_FOUND');
  // Staff who can read drafts still can.
  assert.ok(ok(await exec(VIEW_URL, { as: staff.DESIGNER, variables: { d: demo.id } })).mockupViewUrl);
});

// =================================================================================================
// The streamed upload
// =================================================================================================

const BOUNDARY = 'j9a-boundary-7d2f';

function multipartHead(filename = 'mockup.zip') {
  return Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`);
}
const multipartTail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);

/** POST /upload?class=MOCKUP_BUNDLE as `user`, the body being `file` (a Buffer) or a generator of chunks. */
async function uploadBundle(
  file: Buffer,
  opts: { as?: User | null; contractId?: string | null; filename?: string } = {},
) {
  const body = Buffer.concat([multipartHead(opts.filename), file, multipartTail]);
  const query = new URLSearchParams({ class: 'MOCKUP_BUNDLE' });
  const contractId = opts.contractId === undefined ? f.contract.id : opts.contractId;
  if (contractId) query.set('contractId', contractId);
  const as = opts.as === undefined ? staff.DESIGNER : opts.as;
  const res = await raw(`/upload?${query}`, {
    host: `localhost:${app.port}`,
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
      'content-length': String(body.length),
      ...(as ? { cookie: cookieFor(as) } : {}),
    },
    body,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json };
}

const tmpFiles = async () => {
  try {
    return (await readdir(join(env.STORAGE_DIR, 'tmp'))).filter((n) => n.endsWith('.part'));
  } catch {
    return [];
  }
};

test('a designer uploads a bundle: 201, a private contract-owned StoredFile of class MOCKUP_BUNDLE, the zip on disk, no temp file left', async () => {
  const zip = await zipOf(BASIC_SITE);
  const res = await uploadBundle(zip, { filename: 'ماکاپ ۱.zip' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const row = await prisma.storedFile.findUniqueOrThrow({ where: { id: res.body!.id as string } });
  assert.equal(row.class, 'MOCKUP_BUNDLE');
  assert.equal(row.visibility, 'PRIVATE');
  assert.equal(row.mime, 'application/zip');
  assert.equal(row.bytes, zip.length);
  assert.equal(row.contractId, f.contract.id);
  assert.equal(row.projectId, null);
  assert.equal(row.uploadedById, staff.DESIGNER.id);
  assert.equal(row.originalName, 'ماکاپ ۱.zip');
  assert.ok(row.key.startsWith('private/') && row.key.endsWith('.zip'));
  assert.deepEqual(await readFile(storage.path(row.key)), zip);
  assert.deepEqual(await tmpFiles(), []);
});

test('an uploaded bundle can be served once a build points at it — the path from upload to view is one piece', async () => {
  const zip = await zipOf(BASIC_SITE);
  const res = await uploadBundle(zip);
  assert.equal(res.status, 201);
  const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: res.body!.id as string } });
  const demo = await prisma.demo.create({ data: { kind: 'MOCKUP', projectId: f.contract.projectId, contractId: f.contract.id } });
  await prisma.build.create({
    data: { kind: 'MOCKUP', projectId: f.contract.projectId, demoId: demo.id, bundleFileId: file.id, number: 1, declaredById: staff.DESIGNER.id, publishedAt: new Date() },
  });
  const { id } = await viewOf(f.customer, demo.id);
  assert.match((await raw('/about.html', { host: hostFor(id) })).text, /about page/);
});

test('who may upload: the contract\'s designer (and assignments.override); not the customer, sales, another contract\'s designer, or anonymous', async () => {
  const zip = await zipOf(BASIC_SITE);
  const cases: Array<[string, User | null, number, string]> = [
    ['the contract\'s designer', staff.DESIGNER, 201, ''],
    ['an admin (assignments.override)', f.admin, 201, ''],
    ['another contract\'s designer', staff.DESIGNER_OTHER, 403, 'NOT_ASSIGNED'],
    ['a developer (no design.author)', staff.DEVELOPER, 403, 'FORBIDDEN'],
    ['sales (no design.author)', staff.SALES, 403, 'FORBIDDEN'],
    ['the customer', f.customer, 403, 'FORBIDDEN'],
    ['anonymous', null, 401, 'UNAUTHENTICATED'],
  ];
  for (const [label, user, status, code] of cases) {
    const res = await uploadBundle(zip, { as: user });
    assert.equal(res.status, status, label);
    if (code) assert.equal(res.body!.error, code, label);
  }
  assert.equal(await prisma.storedFile.count(), 2, 'only the two permitted uploads were stored');
  assert.deepEqual(await tmpFiles(), []);
});

test('an upload to a contract the designer cannot see is NOT_FOUND, and one that names no contract is CONTRACT_REQUIRED', async () => {
  const zip = await zipOf(BASIC_SITE);
  const project = await prisma.project.create({ data: { customerId: f.stranger.id, titleFa: 'ا', titleEn: 'other' } });
  const other = await prisma.contract.create({
    data: { ref: 'RC-OTHER', titleFa: 'ا', titleEn: 'Other', customerId: f.stranger.id, projectId: project.id, status: 'DISCARDED' },
  });
  assert.equal((await uploadBundle(zip, { contractId: other.id })).body!.error, 'NOT_FOUND');
  assert.equal((await uploadBundle(zip, { contractId: null })).body!.error, 'CONTRACT_REQUIRED');
  assert.equal((await uploadBundle(zip, { contractId: 'nope' })).body!.error, 'NOT_FOUND');
});

test('a MOCKUP_BUNDLE is not the customer\'s to download through /files: staff read it, the customer gets a 404', async () => {
  const res = await uploadBundle(await zipOf(BASIC_SITE));
  const id = res.body!.id as string;
  const portal = `localhost:${app.port}`;
  assert.equal((await raw(`/files/${id}`, { host: portal, headers: { cookie: cookieFor(staff.DESIGNER) } })).status, 200);
  assert.equal((await raw(`/files/${id}`, { host: portal, headers: { cookie: cookieFor(f.customer) } })).status, 404);
  assert.equal((await raw(`/files/${id}`, { host: portal })).status, 401);
});

// -- the bundle refusals, each over real HTTP with a real small zip ---------------------------------

const storedZips = async () =>
  (await readdir(join(env.STORAGE_DIR, 'private'), { recursive: true }).catch(() => [] as string[])).map(String).filter((n) => n.endsWith('.zip')).sort();

async function assertRefused(zip: Buffer, status: number, code: string) {
  const before = await storedZips(); // other tests leave their bundles in storage
  const res = await uploadBundle(zip);
  assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body!.error, code);
  assert.equal(await prisma.storedFile.count(), 0, `${code}: nothing was stored`);
  assert.deepEqual(await tmpFiles(), [], `${code}: no temp file left`);
  assert.deepEqual(await storedZips(), before, `${code}: no bytes in storage`);
}

test('BUNDLE_PATH_UNSAFE: a zip-slip entry', async () => {
  // 'aa/bb/index.html' and '../../index.html' are both 16 bytes, so no other offset in either header moves.
  const zip = renameEntry(await zipOf({ 'aa/bb/index.html': HOME }), 'aa/bb/index.html', '../../index.html');
  await assertRefused(zip, 400, 'BUNDLE_PATH_UNSAFE');
});

test('BUNDLE_TYPE_REFUSED: an executable among the entries', async () => {
  await assertRefused(await zipOf({ 'index.html': HOME, 'tool.exe': 'MZ' }), 415, 'BUNDLE_TYPE_REFUSED');
});

test('BUNDLE_NO_INDEX: no index.html at the root or in a single top folder', async () => {
  await assertRefused(await zipOf({ 'home.html': HOME }), 400, 'BUNDLE_NO_INDEX');
  await assertRefused(await zipOf({ 'a/index.html': HOME, 'b/x.html': ABOUT }), 400, 'BUNDLE_NO_INDEX');
});

test('BUNDLE_TOO_MANY_FILES: more than 2,000 entries', async () => {
  const entries: Record<string, string> = { 'index.html': HOME };
  for (let i = 0; i < 2001; i += 1) entries[`f/${i}.txt`] = 'x';
  await assertRefused(await zipOf(entries), 413, 'BUNDLE_TOO_MANY_FILES');
});

test('BUNDLE_TOO_LARGE: a compression bomb (a 6 MB entry of zeros)', async () => {
  await assertRefused(await zipOf({ 'index.html': HOME, 'pad.txt': Buffer.alloc(6 * 1024 * 1024) }), 413, 'BUNDLE_TOO_LARGE');
});

test('not a zip: UNSUPPORTED_TYPE from the first bytes, whatever the filename says — and an empty file is EMPTY_FILE', async () => {
  await assertRefused(Buffer.from('<html>this is not a zip</html>'), 415, 'UNSUPPORTED_TYPE');
  await assertRefused(Buffer.from('PK\x03'), 415, 'UNSUPPORTED_TYPE');
  await assertRefused(Buffer.alloc(0), 400, 'EMPTY_FILE');
  // Starts like a zip, is not one: the central directory check catches it.
  await assertRefused(Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 7)]), 400, 'BUNDLE_UNREADABLE');
});

test('a multipart body with no file field is NO_FILE, and a non-multipart one is NOT_MULTIPART — before anything is written', async () => {
  const query = `class=MOCKUP_BUNDLE&contractId=${f.contract.id}`;
  const headers = { cookie: cookieFor(staff.DESIGNER) };
  const noFile = Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="other"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`);
  const a = await raw(`/upload?${query}`, {
    host: `localhost:${app.port}`, method: 'POST', body: noFile,
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(noFile.length) },
  });
  assert.equal(a.status, 400);
  assert.equal(JSON.parse(a.text).error, 'NO_FILE');
  const b = await raw(`/upload?${query}`, {
    host: `localhost:${app.port}`, method: 'POST', body: '{}',
    headers: { ...headers, 'content-type': 'application/json', 'content-length': '2' },
  });
  assert.equal(b.status, 415);
  assert.equal(JSON.parse(b.text).error, 'NOT_MULTIPART');
  assert.deepEqual(await tmpFiles(), []);
  assert.equal(await prisma.storedFile.count(), 0);
});

// -- the cap, and that it is enforced without buffering ---------------------------------------------

const CAP = 50 * 1024 * 1024;

test('a client that declares an oversize body is refused before it is read: FILE_TOO_LARGE', async () => {
  const res = await new Promise<{ status: number; error: string }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1', port: app.port, path: `/upload?class=MOCKUP_BUNDLE&contractId=${f.contract.id}`, method: 'POST',
        headers: { host: `localhost:${app.port}`, cookie: cookieFor(staff.DESIGNER), 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(CAP * 2) },
      },
      (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => {
          resolve({ status: r.statusCode ?? 0, error: JSON.parse(Buffer.concat(chunks).toString()).error });
          req.destroy(); // the body it promised is never coming
        });
      },
    );
    req.on('error', reject);
    req.write(multipartHead()); // a few bytes, then wait for the answer — the rest is never sent
  });
  assert.deepEqual(res, { status: 413, error: 'FILE_TOO_LARGE' });
  assert.deepEqual(await tmpFiles(), []);
});

test('a chunked upload past the cap is refused FILE_TOO_LARGE at the cap — the temp file removed, nothing stored, and the process never holds the body', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const total = CAP + 10 * 1024 * 1024; // 60 MB offered against a 50 MB cap
  const measure = () => {
    const m = process.memoryUsage();
    return m.heapUsed + m.arrayBuffers;
  };
  const baseline = measure();
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, measure());
  }, 5);

  let sent = 0;
  const result = await new Promise<{ status: number | null; error: string | null; sent: number }>((resolve) => {
    let settled = false;
    const finish = (status: number | null, error: string | null) => {
      if (!settled) {
        settled = true;
        resolve({ status, error, sent });
      }
    };
    const req = httpRequest(
      {
        host: '127.0.0.1', port: app.port, path: `/upload?class=MOCKUP_BUNDLE&contractId=${f.contract.id}`, method: 'POST',
        // No content-length: the declared-size courtesy check cannot help, only the running count can.
        headers: { host: `localhost:${app.port}`, cookie: cookieFor(staff.DESIGNER), 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'transfer-encoding': 'chunked' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => finish(res.statusCode ?? 0, JSON.parse(Buffer.concat(chunks).toString()).error));
        res.on('error', () => finish(res.statusCode ?? 0, null));
      },
    );
    // After the answer, writes into a closing socket may fail — that is the
    // server closing the connection as it said it would, not a test failure.
    req.on('error', (err) => {
      // Give a response that is already on its way a moment to be read first.
      setTimeout(() => finish(null, (err as NodeJS.ErrnoException).code ?? 'ERROR'), 250);
    });
    void (async () => {
      req.write(multipartHead());
      while (sent < total && !req.destroyed && !settled) {
        if (!req.write(chunk)) await new Promise((r) => req.once('drain', r));
        sent += chunk.length;
      }
      if (!settled) req.end();
    })();
  });
  clearInterval(sampler);

  assert.equal(result.status, 413);
  assert.equal(result.error, 'FILE_TOO_LARGE');
  assert.ok(result.sent >= CAP, `the server read ${result.sent} bytes — it should have read past the cap before refusing`);
  // Streaming: the bytes went to disk, not into the heap. A buffered read of
  // this body would hold ≥ 50 MB (and its parsed copy); allow well under that.
  const growth = peak - baseline;
  assert.ok(growth < 32 * 1024 * 1024, `heap + array buffers grew by ${(growth / 1048576).toFixed(1)} MB while ${(result.sent / 1048576).toFixed(0)} MB streamed through`);
  assert.deepEqual(await tmpFiles(), [], 'the partial temp file is removed');
  assert.equal(await prisma.storedFile.count(), 0);
});

test('the other classes keep the buffered path: a 3 MB design image is still refused by the 2 MB class limit, and a small one still stored', async () => {
  const boundaryBody = (file: Buffer) => Buffer.concat([multipartHead('a.png'), file, multipartTail]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const post = (file: Buffer) => {
    const body = boundaryBody(file);
    return raw(`/upload?class=DESIGN_IMAGE&contractId=${f.contract.id}`, {
      host: `localhost:${app.port}`, method: 'POST', body,
      headers: { cookie: cookieFor(staff.DESIGNER), 'content-type': `multipart/form-data; boundary=${BOUNDARY}`, 'content-length': String(body.length) },
    });
  };
  assert.equal((await post(PNG)).status, 201);
  assert.equal((await post(Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))).status, 413);
  // …and no design image ever touches STORAGE_DIR/tmp.
  assert.deepEqual(await tmpFiles(), []);
});

// =================================================================================================
// The schema: the CHECKs by direct insert, numbering per kind, the restrict, the backfill as shipped
// =================================================================================================

async function bundleFile(): Promise<string> {
  const key = await storage.put('PRIVATE', await zipOf({ 'index.html': HOME }), '.zip');
  return (
    await prisma.storedFile.create({
      data: { key, class: 'MOCKUP_BUNDLE', visibility: 'PRIVATE', mime: 'application/zip', bytes: 10, originalName: 'm.zip', contractId: f.contract.id, uploadedById: staff.DESIGNER.id },
    })
  ).id;
}

async function aPhase() {
  return prisma.phase.create({
    data: { projectId: f.contract.projectId, contractId: f.contract.id, number: 1, titleFa: 'ف', titleEn: 'P1' },
  });
}

test('Demo_site_has_phase_and_url: a SITE demo needs both a phase and a staging URL; a MOCKUP demo needs neither', async () => {
  const phase = await aPhase();
  const projectId = f.contract.projectId;
  await assert.rejects(prisma.demo.create({ data: { projectId, kind: 'SITE', stagingUrl: 'https://s.example.com' } }), /Demo_site_has_phase_and_url/);
  await assert.rejects(prisma.demo.create({ data: { projectId, kind: 'SITE', phaseId: phase.id } }), /Demo_site_has_phase_and_url/);
  await assert.rejects(prisma.demo.create({ data: { projectId } }), /Demo_site_has_phase_and_url/, 'the default kind is SITE');
  await prisma.demo.create({ data: { projectId, kind: 'SITE', phaseId: phase.id, stagingUrl: 'https://s.example.com' } });
  await prisma.demo.create({ data: { projectId, kind: 'MOCKUP', contractId: f.contract.id } });
  // Update paths too: a SITE demo cannot lose either half after the fact.
  const site = await prisma.demo.findFirstOrThrow({ where: { kind: 'SITE' } });
  await assert.rejects(prisma.demo.update({ where: { id: site.id }, data: { stagingUrl: null } }), /Demo_site_has_phase_and_url/);
  await assert.rejects(prisma.demo.update({ where: { id: site.id }, data: { phaseId: null } }), /Demo_site_has_phase_and_url/);
});

test('Build_site_has_phase and Build_mockup_has_bundle', async () => {
  const phase = await aPhase();
  const projectId = f.contract.projectId;
  const declaredById = staff.DEVELOPER.id;
  const demo = await prisma.demo.create({ data: { projectId, kind: 'MOCKUP', contractId: f.contract.id } });
  const file = await bundleFile();

  await assert.rejects(prisma.build.create({ data: { projectId, kind: 'SITE', number: 1, declaredById } }), /Build_site_has_phase/);
  await assert.rejects(prisma.build.create({ data: { projectId, number: 1, declaredById } }), /Build_site_has_phase/, 'the default kind is SITE');
  await assert.rejects(prisma.build.create({ data: { projectId, kind: 'MOCKUP', demoId: demo.id, number: 1, declaredById } }), /Build_mockup_has_bundle/);

  await prisma.build.create({ data: { projectId, kind: 'SITE', phaseId: phase.id, number: 1, declaredById } });
  const mockup = await prisma.build.create({ data: { projectId, kind: 'MOCKUP', demoId: demo.id, bundleFileId: file, number: 1, declaredById } });
  await assert.rejects(prisma.build.update({ where: { id: mockup.id }, data: { bundleFileId: null } }), /Build_mockup_has_bundle/);
});

test('numbering is per (project, kind): mockup 1 and version 1 coexist; a repeat of either is refused', async () => {
  const phase = await aPhase();
  const projectId = f.contract.projectId;
  const declaredById = staff.DEVELOPER.id;
  const demo = await prisma.demo.create({ data: { projectId, kind: 'MOCKUP', contractId: f.contract.id } });
  const site = (number: number) => prisma.build.create({ data: { projectId, kind: 'SITE', phaseId: phase.id, number, declaredById } });
  const mockup = async (number: number) => prisma.build.create({ data: { projectId, kind: 'MOCKUP', demoId: demo.id, bundleFileId: await bundleFile(), number, declaredById } });

  await site(1);
  await mockup(1);
  await site(2);
  await mockup(2);
  await assert.rejects(site(1), (e: unknown) => (e as { code?: string }).code === 'P2002');
  await assert.rejects(mockup(1), (e: unknown) => (e as { code?: string }).code === 'P2002');
  // Another project starts at 1 again.
  const other = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'other' } });
  const otherPhase = await prisma.phase.create({ data: { projectId: other.id, contractId: f.contract.id, number: 9, titleFa: 'ف', titleEn: 'P' } });
  await prisma.build.create({ data: { projectId: other.id, kind: 'SITE', phaseId: otherPhase.id, number: 1, declaredById } });
});

test('a SITE build\'s number does not count the mockup iterations: declareBuild after mockup 5 is version 1', async () => {
  const phase = await aPhase();
  const projectId = f.contract.projectId;
  const demo = await prisma.demo.create({ data: { projectId, kind: 'MOCKUP', contractId: f.contract.id } });
  await prisma.build.create({ data: { projectId, kind: 'MOCKUP', demoId: demo.id, bundleFileId: await bundleFile(), number: 5, declaredById: staff.DESIGNER.id } });
  const declared = ok(
    await exec('mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id number } }', {
      as: staff.DEVELOPER,
      variables: { p: phase.id, c: [{ note: 'first version', noteLang: 'en' }] },
    }),
  ).declareBuild as { id: string; number: number };
  assert.equal(declared.number, 1);
  const row = await prisma.build.findUniqueOrThrow({ where: { id: declared.id } });
  assert.equal(row.kind, 'SITE');
  assert.equal(row.phaseId, phase.id);
});

test('MockupViewGrant_id_shape: only 32 lowercase hex characters can be a grant id', async () => {
  const { build } = await seedMockup();
  const data = { buildId: build.id, viewerId: f.customer.id, expiresAt: new Date(Date.now() + 60_000) };
  for (const bad of ['abc', 'A'.repeat(32), 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}.`]) {
    await assert.rejects(prisma.mockupViewGrant.create({ data: { ...data, id: bad } }), /MockupViewGrant_id_shape/, bad);
  }
  await prisma.mockupViewGrant.create({ data: { ...data, id: '0123456789abcdef0123456789abcdef' } });
});

test('a bundle cannot be deleted from under a build (Restrict), and a grant goes with its build (Cascade)', async () => {
  const { demo, build, file } = await seedMockup();
  await viewOf(f.customer, demo.id);
  assert.equal(await prisma.mockupViewGrant.count(), 1);
  await assert.rejects(prisma.storedFile.delete({ where: { id: file.id } }), /Build_bundleFileId_fkey|foreign key/i);
  await prisma.build.delete({ where: { id: build.id } });
  assert.equal(await prisma.mockupViewGrant.count(), 0);
  await prisma.storedFile.delete({ where: { id: file.id } });
});

test('MOCKUP_BUNDLE is a private, contract-owned file: the owner CHECK needed no widening, and a private bundle with no owner is still refused', async () => {
  await bundleFile(); // contract-owned: accepted
  await assert.rejects(
    prisma.storedFile.create({
      data: { key: 'private/x/orphan.zip', class: 'MOCKUP_BUNDLE', visibility: 'PRIVATE', mime: 'application/zip', bytes: 1, originalName: 'o.zip', uploadedById: staff.DESIGNER.id },
    }),
    /StoredFile_private_has_owner/,
  );
});

// -- the backfill, as shipped ----------------------------------------------------------------------

const MIGRATION = fileURLToPath(new URL('../../prisma/migrations/20261001110000_j9_mockups/migration.sql', import.meta.url));

function between(begin: string, end: string): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const block = sql.slice(sql.indexOf(begin), sql.indexOf(end));
  assert.ok(block.length > 0, `${begin} … ${end} markers are missing`);
  return block
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
}

/** Un-does the migration's tail (NOT NULL on the three backfilled columns) inside a transaction that is always rolled back. */
async function overUnmigratedRows<T>(body: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const rolledBack = new Error('roll back the un-migrated fixture');
  let result!: T;
  await prisma
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "Demo" ALTER COLUMN "projectId" DROP NOT NULL, ALTER COLUMN "kind" DROP NOT NULL');
      await tx.$executeRawUnsafe('ALTER TABLE "Build" ALTER COLUMN "kind" DROP NOT NULL');
      result = await body(tx);
      throw rolledBack;
    })
    .catch((err) => {
      if (err !== rolledBack) throw err;
    });
  return result;
}

test('the backfill: every pre-existing demo and build becomes a SITE one, and a demo takes its phase\'s project', async () => {
  const phase = await aPhase();
  const other = await prisma.project.create({ data: { customerId: f.customer.id, titleFa: 'ا', titleEn: 'other' } });
  const otherPhase = await prisma.phase.create({ data: { projectId: other.id, contractId: f.contract.id, number: 7, titleFa: 'ف', titleEn: 'P' } });
  const file = await bundleFile();

  const rows = await overUnmigratedRows(async (tx) => {
    // Rows as they were before this migration: no kind, no project on a demo.
    await tx.$executeRawUnsafe(
      `INSERT INTO "Demo" ("id","phaseId","stagingUrl","projectId","kind","updatedAt") VALUES
         ('bf-demo-1','${phase.id}','https://a.example.com',NULL,NULL,now()),
         ('bf-demo-2','${otherPhase.id}','https://b.example.com',NULL,NULL,now())`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "Build" ("id","phaseId","projectId","number","declaredById","kind") VALUES
         ('bf-build-1','${phase.id}','${f.contract.projectId}',1,'${staff.DEVELOPER.id}',NULL)`,
    );
    // A row that already has a kind — a MOCKUP build, which nothing before J9 could have made — must not be touched.
    await tx.$executeRawUnsafe(
      `INSERT INTO "Build" ("id","projectId","number","declaredById","kind","bundleFileId") VALUES
         ('bf-build-2','${f.contract.projectId}',1,'${staff.DESIGNER.id}','MOCKUP','${file}')`,
    );
    const statements = between('-- BACKFILL:BEGIN', '-- BACKFILL:END')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    assert.equal(statements.length, 3, 'two demo updates and a build update');
    for (const s of statements) await tx.$executeRawUnsafe(s);
    return {
      demos: await tx.$queryRawUnsafe<Array<{ id: string; kind: string; projectId: string }>>(`SELECT "id","kind","projectId" FROM "Demo" WHERE "id" LIKE 'bf-demo-%' ORDER BY "id"`),
      builds: await tx.$queryRawUnsafe<Array<{ id: string; kind: string }>>(`SELECT "id","kind" FROM "Build" WHERE "id" LIKE 'bf-build-%' ORDER BY "id"`),
    };
  });
  assert.deepEqual(rows.demos, [
    { id: 'bf-demo-1', kind: 'SITE', projectId: f.contract.projectId },
    { id: 'bf-demo-2', kind: 'SITE', projectId: other.id },
  ]);
  assert.deepEqual(rows.builds, [
    { id: 'bf-build-1', kind: 'SITE' },
    { id: 'bf-build-2', kind: 'MOCKUP' },
  ]);
});

test('the migration\'s guard refuses to make Demo.projectId required while a demo has none', async () => {
  const guard = between('-- VERIFY:BEGIN', '-- VERIFY:END');
  await assert.rejects(
    () =>
      overUnmigratedRows(async (tx) => {
        // No phase to take a project from — the row the backfill cannot fix.
        await tx.$executeRawUnsafe(`INSERT INTO "Demo" ("id","kind","projectId","updatedAt") VALUES ('bf-orphan','MOCKUP',NULL,now())`);
        await tx.$executeRawUnsafe(guard);
      }),
    /J9: 1 demo\(s\) have no phase to take a project from/,
  );
  await overUnmigratedRows(async (tx) => {
    await tx.$executeRawUnsafe(guard);
  });
});

// =================================================================================================
// Every existing SITE path behaves as before
// =================================================================================================

async function siteFixture() {
  const phase = await aPhase();
  const demo = await prisma.demo.create({
    data: { projectId: f.contract.projectId, phaseId: phase.id, stagingUrl: 'https://staging.example.com', publishedAt: new Date() },
  });
  return { phase, demo };
}

test('the developer\'s demo surface answers NOT_FOUND for a MOCKUP demo, and works unchanged for a SITE one', async () => {
  const { demo: mockup } = await seedMockup();
  const { demo: site } = await siteFixture();
  const calls: Array<[string, string]> = [
    ['updateDemo', 'mutation($d: ID!){ updateDemo(demoId: $d, buildRef: "x") { id } }'],
    ['deleteDemo', 'mutation($d: ID!){ deleteDemo(demoId: $d) { id } }'],
    ['declareDemoPage', 'mutation($d: ID!){ declareDemoPage(demoId: $d, key: "k", labelFa: "ا", labelEn: "K", canonicalPath: "/k") { id } }'],
    ['generateDemoFrame', 'mutation($d: ID!){ generateDemoFrame(demoId: $d) { id } }'],
    ['updateDemoFrameSummary', 'mutation($d: ID!){ updateDemoFrameSummary(demoId: $d, summaryEn: "s") { id } }'],
    ['addDemoFrameLine', 'mutation($d: ID!){ addDemoFrameLine(demoId: $d, kind: NEW, textFa: "ا", textEn: "n") { id } }'],
    ['publishDemo', 'mutation($d: ID!){ publishDemo(demoId: $d) { id } }'],
  ];
  for (const [name, query] of calls) {
    const refused = await exec(query, { as: f.admin, variables: { d: mockup.id } });
    assert.equal(refused.code, 'NOT_FOUND', `${name} on a MOCKUP demo`);
  }
  assert.equal(await prisma.demoPage.count(), 0);
  assert.equal(await prisma.demoFrame.count(), 0);
  assert.equal((await prisma.demo.findUniqueOrThrow({ where: { id: mockup.id } })).publishedAt, null, 'not published by a refused call');

  // The same calls on a SITE demo are the L2/L3 behaviour.
  ok(await exec(calls[0][1], { as: staff.DEVELOPER, variables: { d: site.id } }));
  ok(await exec(calls[2][1], { as: staff.DEVELOPER, variables: { d: site.id } }));
  ok(await exec(calls[3][1], { as: staff.DEVELOPER, variables: { d: site.id } }));
});

test('createDemo names the demo\'s project and kind; the demo\'s pages and frame still work', async () => {
  const phase = await aPhase();
  ok(await exec('mutation($p: ID!){ createDemo(phaseId: $p, stagingUrl: "https://n.example.com") { id } }', { as: staff.DEVELOPER, variables: { p: phase.id } }));
  const demo = await prisma.demo.findFirstOrThrow();
  assert.equal(demo.kind, 'SITE');
  assert.equal(demo.projectId, f.contract.projectId);
  assert.equal(demo.phaseId, phase.id);
  assert.equal(demo.contractId, null);
  assert.equal(demo.stagingUrl, 'https://n.example.com');
});

test('projectBuilds lists SITE builds only; publishBuild on a MOCKUP build is NOT_FOUND on the developer\'s surface', async () => {
  const { phase } = await siteFixture();
  const { build: mockupBuild } = await seedMockup();
  const declared = ok(
    await exec('mutation($p: ID!, $c: [BuildChangeInput!]!){ declareBuild(phaseId: $p, changes: $c) { id number } }', {
      as: staff.DEVELOPER,
      variables: { p: phase.id, c: [{ note: 'v1', noteLang: 'en' }] },
    }),
  ).declareBuild as { id: string };
  const listed = ok(await exec('query($p: ID!){ projectBuilds(projectId: $p) { id number } }', { as: staff.DEVELOPER, variables: { p: f.contract.projectId } })).projectBuilds as Array<{ id: string }>;
  assert.deepEqual(listed.map((b) => b.id), [declared.id]);

  assert.equal((await exec('mutation($b: ID!){ publishBuild(buildId: $b) { id } }', { as: staff.DEVELOPER, variables: { b: mockupBuild.id } })).code, 'NOT_FOUND');
  assert.equal((await prisma.build.findUniqueOrThrow({ where: { id: mockupBuild.id } })).publishedAt !== null, true, 'the seeded publish is untouched');
  ok(await exec('mutation($b: ID!){ publishBuild(buildId: $b) { id } }', { as: staff.DEVELOPER, variables: { b: declared.id } }));
});

test('reportDemoPath on a MOCKUP demo folds .html (a mapped /about matches a reported /about.html); on a SITE demo it does not', async () => {
  const { demo: mockup } = await seedMockup();
  const about = await prisma.demoPage.create({ data: { demoId: mockup.id, key: 'about', labelFa: 'ا', labelEn: 'About', canonicalPath: '/about' } });
  const report = async (demoId: string, path: string, as: User) =>
    ok(await exec('mutation($d: ID!, $p: String!){ reportDemoPath(demoId: $d, path: $p) { matched normalizedPath page { id } } }', { as, variables: { d: demoId, p: path } }))
      .reportDemoPath as { matched: boolean; normalizedPath: string; page: { id: string } | null };

  for (const path of ['/about.html', '/about', '/about/', '/about/index.html']) {
    const r = await report(mockup.id, path, f.customer);
    assert.equal(r.matched, true, path);
    assert.equal(r.page!.id, about.id);
  }

  const { demo: site } = await siteFixture();
  await prisma.demoPage.create({ data: { demoId: site.id, key: 'about', labelFa: 'ا', labelEn: 'About', canonicalPath: '/about' } });
  const r = await report(site.id, '/about.html', f.customer);
  assert.equal(r.matched, false, 'a SITE demo\'s own server decides what /about.html is; the mapping does not');
  assert.equal(r.normalizedPath, '/about.html');
});

test('a stranger cannot report on, or view, a MOCKUP demo — reportDemoPath is NOT_FOUND, exactly as for a SITE demo', async () => {
  const { demo } = await seedMockup();
  const res = await exec('mutation($d: ID!){ reportDemoPath(demoId: $d, path: "/") { matched } }', { as: f.stranger, variables: { d: demo.id } });
  assert.equal(res.code, 'NOT_FOUND');
});

test('DemoFrame.unpromptedChanges of a MOCKUP demo lists that demo\'s iterations only — never every phase-less build of every project', async () => {
  const one = await seedMockup();
  const frame = await prisma.demoFrame.create({ data: { demoId: one.demo.id, authoredById: staff.DESIGNER.id } });
  await prisma.buildChangeEntry.create({ data: { buildId: one.build.id, note: 'restyled the header', noteLang: 'en' } });
  // Another project's mockup with its own unprompted change.
  const project = await prisma.project.create({ data: { customerId: f.stranger.id, titleFa: 'ا', titleEn: 'other' } });
  const otherDemo = await prisma.demo.create({ data: { kind: 'MOCKUP', projectId: project.id } });
  const otherBuild = await prisma.build.create({
    data: { kind: 'MOCKUP', projectId: project.id, demoId: otherDemo.id, bundleFileId: await bundleFile(), number: 1, declaredById: staff.DESIGNER.id },
  });
  await prisma.buildChangeEntry.create({ data: { buildId: otherBuild.id, note: 'someone else\'s secret change', noteLang: 'en' } });

  // A MOCKUP demo is reached through no `Contract → phases → demos` path yet (J9b
  // adds one), so the field resolver is called directly.
  const ctx = { user: f.admin, auth: { kind: 'session' } } as never;
  const changes = (await DemoFrame.unpromptedChanges({ demoId: one.demo.id }, {}, ctx)) as Array<{ note: string | null }>;
  assert.deepEqual(changes.map((c) => c.note), ['restyled the header']);
  assert.ok(frame.id);
});

test('the mockup base domain is configured, and the URL a viewer is handed uses it', async () => {
  assert.equal(env.MOCKUP_BASE_DOMAIN, 'mockup.localhost');
  const { demo } = await seedMockup();
  const { url } = await viewOf(f.customer, demo.id);
  assert.match(url, new RegExp(`^http://[0-9a-f]{32}\\.mockup\\.localhost:${env.PORT}/$`));
});
