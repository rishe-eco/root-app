/**
 * The mockup host (journeys build plan J9, PD-9): the only thing that answers
 * on `*.mockup.m-root.com`. A designer's uploaded zip is served from storage,
 * entry by entry, on a subdomain of its own per viewer — `<grant-id>.<base>` —
 * so that its root-relative links (`/css/app.css`, `/products.html`) resolve at
 * the host's root the way they did on the designer's machine.
 *
 * **This is code Root did not write, running on a sibling subdomain of the
 * portal's registrable domain.** Everything below exists to keep the two apart:
 *
 *   1. **The fence.** `mockupFence` is mounted first in `index.ts`, ahead of
 *      `cookieParser`, `cors`, the origin check, `filesRouter`, `askRouter`,
 *      `/graphql`, `/health` and the e2e routes. A request whose `Host` is the
 *      mockup base domain or anything under it is answered *here* — by this
 *      router or by its 404 — and **never** handed to `next()`. Nothing else in
 *      the app can be reached on that host, by construction and not by each
 *      route remembering to check.
 *   2. **The host is read from `Host`, not `req.hostname`.** With `trust proxy`
 *      on, Express derives `req.hostname` from `X-Forwarded-Host` when present,
 *      and Nginx passes a client-supplied one through untouched. A script on a
 *      mockup origin could send `X-Forwarded-Host: app.example.com` to itself
 *      (a same-origin request needs no preflight) and walk out of the fence.
 *      `Host` is what Nginx sets (`proxy_set_header Host $host`) and what the
 *      browser cannot forge from page script.
 *   3. **No cookie, either way.** The session cookie is host-only on the portal
 *      origin, so a browser never sends it here; and this router never reads
 *      one (it does not call `buildContext`) or sets one. Who may see a mockup
 *      is decided by the grant in the host, checked against the database on
 *      every request.
 *   4. **Nginx is the second fence, not the only one** (`deploy/nginx/`).
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { storage } from '../lib/storage.js';
import { contractVisibleTo } from '../lib/visibility.js';
import { grantIdFromHost, isMockupHost } from '../lib/mockupHost.js';
import {
  bundleFor,
  contentTypeFor,
  entryRequestFor,
  injectReporter,
  isHtml,
  mockupHeaders,
  openEntry,
  reporterTag,
} from '../lib/mockupServe.js';

/** `new URL(APP_ORIGIN).origin` once: scheme, host and port, no trailing slash
 *  — the form both `frame-ancestors` and `postMessage`'s target origin want. */
const APP_ORIGIN = new URL(env.APP_ORIGIN).origin;
const HEADERS = mockupHeaders(APP_ORIGIN);
const REPORTER_TAG = reporterTag(APP_ORIGIN);

/** An HTML entry is read whole to be injected into; nothing a designer exports
 *  as a page comes near this, and a hostile one does not get to make the
 *  process hold it. */
const MAX_HTML_BYTES = 8 * 1024 * 1024;

const REPORTER_PATH = '/__root/reporter.js';

const notFound = (res: Response) => {
  res.status(404).type('text/plain').send('Not found');
};

/**
 * The fence. Mount it **first**. For a request on the mockup host it answers
 * and does not call `next`; for any other host it calls `next` and touches
 * nothing.
 */
export function mockupFence(req: Request, res: Response, next: NextFunction): void {
  // The raw `Host` header — see the module comment on why not `req.hostname`.
  const host = req.headers.host ?? '';
  if (!isMockupHost(host, env.MOCKUP_BASE_DOMAIN)) {
    next();
    return;
  }

  // Set first, so that every response from here on — a bundle file, a 404, a
  // 500 — carries them.
  res.set(HEADERS);

  serve(req, res, host).catch((err) => {
    console.error('[mockups] unhandled', err);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(500).type('text/plain').send('Something went wrong.');
  });
}

async function serve(req: Request, res: Response, host: string): Promise<void> {
  // A mockup is read-only: anything that could write, negotiate (OPTIONS — no
  // CORS answer is the point) or probe is a plain 404.
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  // The bare base domain, a label that is not 32 hex, two labels: on the
  // mockup host, and nothing to serve.
  const grantId = grantIdFromHost(host, env.MOCKUP_BASE_DOMAIN);
  if (!grantId) return notFound(res);

  const build = await servableBuild(grantId);
  if (!build) return notFound(res);

  // After the grant check, not before it: a host that is not a live grant gets
  // the same answer for every path, so this route is not a way to ask whether
  // a grant id exists.
  if (req.path === REPORTER_PATH) {
    const script = await reporterScript();
    if (!script) return notFound(res);
    res.status(200).type('text/javascript').send(script);
    return;
  }

  const request = entryRequestFor(req.path);
  if (!request) return notFound(res);

  const bundle = await bundleFor(build.bundleKey, storage.path(build.bundleKey)).catch((err) => {
    // The row survived and the bytes did not — a restore that missed STORAGE_DIR
    // — or the archive is unreadable. Say so in the log; the viewer gets a 404.
    console.error(`[mockups] bundle ${build.bundleKey} unreadable:`, err);
    return null;
  });
  if (!bundle) return notFound(res);

  const entryName = bundle.entries.get(request.key);
  if (entryName === undefined) {
    // `/docs` for a bundle that has `docs/index.html`: what every static server
    // does — a redirect to the directory, so the page's *relative* links
    // resolve against `/docs/` and not against `/`. Built from the normalized
    // key, never the raw path, so it cannot become a protocol-relative
    // `//host/…` redirect off this origin.
    if (!request.directory && bundle.entries.has(`${request.key}/index.html`)) {
      const location = '/' + request.key.split('/').map(encodeURIComponent).join('/') + '/';
      res.redirect(302, location);
      return;
    }
    return notFound(res);
  }

  const entry = await openEntry(storage.path(build.bundleKey), entryName);
  if (!entry) return notFound(res);

  res.status(200);
  res.setHeader('Content-Type', contentTypeFor(request.key));

  if (isHtml(request.key)) {
    if (entry.size > MAX_HTML_BYTES) {
      entry.stream.destroy();
      res.status(413).type('text/plain').send('That page is too large to show.');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of entry.stream) chunks.push(chunk as Buffer);
    const body = injectReporter(Buffer.concat(chunks), REPORTER_TAG);
    res.setHeader('Content-Length', String(body.length));
    res.end(body);
    return;
  }

  res.setHeader('Content-Length', String(entry.size));
  await pipeline(entry.stream, res);
}

type ServableBuild = { bundleKey: string };

/**
 * The build a grant opens **right now**, or `null` for every reason it should
 * not: no such grant, an expired one, a viewer whose account is disabled or who
 * can no longer see the contract (S1's `contractVisibleTo` — the same rule
 * every other reader of a contract's files uses, so a customer whose contract
 * is pulled back to draft loses their open mockup on the next asset request),
 * a build that is not a published mockup, or one with no bundle. Every reason
 * is the same 404; the caller cannot tell them apart.
 *
 * Read from the database on every request. That is the price of a grant being
 * revocable and of "the viewer can still see the contract" meaning what it
 * says, and it is one indexed row and one small join per asset — a mockup is a
 * few dozen files, not a busy site.
 */
async function servableBuild(grantId: string): Promise<ServableBuild | null> {
  const grant = await prisma.mockupViewGrant.findUnique({
    where: { id: grantId },
    include: {
      // Only what the checks below read — not the password hash.
      viewer: { select: { id: true, roles: true, state: true } },
      build: {
        include: {
          bundleFile: { select: { key: true } },
          demo: {
            include: {
              contract: {
                select: { customerId: true, publishedAt: true, status: true, deliveredAt: true, project: { select: { status: true } } },
              },
            },
          },
        },
      },
    },
  });
  if (!grant || grant.expiresAt.getTime() <= Date.now()) return null;

  const { viewer, build } = grant;
  if (viewer.state === 'DISABLED') return null;
  if (build.kind !== 'MOCKUP' || build.publishedAt === null || !build.bundleFile) return null;
  if (!build.demo || build.demo.kind !== 'MOCKUP' || !build.demo.contract) return null;
  if (!contractVisibleTo(viewer, build.demo.contract)) return null;

  return { bundleKey: build.bundleFile.key };
}

// ---- the reporter snippet --------------------------------------------------------------------------

let reporter: Promise<Buffer | null> | null = null;

/**
 * `snippets/demo-reporter/root-demo-reporter.js` — the repository's own file,
 * the same one a staging site includes, served at `/__root/reporter.js` on
 * every mockup origin so the injected tag has something to load. Found by
 * walking up from this module rather than by a fixed `../` count, because the
 * same source runs from `src/routes/` under `tsx` and from `dist/src/routes/`
 * in the container image (whose Dockerfile copies `snippets/` beside `apps/`).
 */
function reporterScript(): Promise<Buffer | null> {
  reporter ??= (async () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i += 1) {
      const candidate = join(dir, 'snippets', 'demo-reporter', 'root-demo-reporter.js');
      if (existsSync(candidate)) return readFile(candidate);
      dir = resolve(dir, '..');
    }
    console.error('[mockups] snippets/demo-reporter/root-demo-reporter.js not found — mockups will not report pages');
    return null;
  })();
  return reporter;
}
