/**
 * What the mockup router needs that is not routing: turning a request path into
 * a key in the bundle, the content type an entry is sent as, the one injected
 * `<script>` tag, the response headers, and reading a single entry out of the
 * stored zip (build plan J9, PD-9). Kept out of `routes/mockups.ts` so each
 * rule is a pure function with a unit test, and so the router reads as a
 * sequence of decisions.
 *
 * **Why entries are served from the zip and not from an extracted copy.**
 * PD-9 chose it and this file is where the choice costs something, so the
 * reasons are recorded: extraction turns an upload into a directory tree, and
 * a directory tree is where zip-slip, symlinks, permissions and clean-up on
 * every superseded iteration live. Serving from the zip has none of them — a
 * request path is only ever a *key into a map of names*, never joined onto a
 * filesystem path, so there is nothing for a `..` to traverse. The cost is a
 * `yauzl` open per request (a central-directory read, ≤ 2,000 entries, cached
 * as a name map so a miss never opens the file at all) and no `Range` support;
 * a mockup is a few dozen small files, and the trade is a good one.
 */

import * as yauzl from 'yauzl';
import { pipeline, Transform, type Readable } from 'node:stream';

import { validateBundle, type ValidatedBundle } from './mockupBundle.js';

// ---- the request path → a key in the bundle ------------------------------------------------------

export type EntryRequest = {
  /** The bundle-relative key to look up — `index.html` for `/` and for any directory-style path. */
  key: string;
  /** The path ended in a slash (or was the root): a directory request. */
  directory: boolean;
};

/**
 * A raw request path (`req.path` — still percent-encoded, no query) as a bundle
 * key, or `null` if it cannot be one.
 *
 * Decoded exactly **once**, so `%252e%252e` is the literal name `%2e%2e` and
 * not a traversal. `..` as a segment is refused outright rather than resolved
 * — no name in a validated bundle contains one (yauzl's `strictFileNames` and
 * `validateBundle` see to that), so a request naming one can only be a probe.
 * Backslashes and NULs are refused for the same reason. `.` and empty segments
 * (`//`) collapse. Nothing here touches a filesystem; the result is only ever a
 * `Map` key.
 */
export function entryRequestFor(rawPath: string): EntryRequest | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;

  const segments = decoded.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.includes('..')) return null;

  const directory = decoded.endsWith('/') || segments.length === 0;
  const key = directory ? [...segments, 'index.html'].join('/') : segments.join('/');
  return { key, directory };
}

// ---- content types ---------------------------------------------------------------------------------

/** Keyed by the extension allowlist in `mockupBundle.ts`; anything else (which
 *  a validated bundle cannot contain) is an opaque download, never a guess. */
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  txt: 'text/plain; charset=utf-8',
};

export function contentTypeFor(key: string): string {
  const base = key.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[extension] ?? 'application/octet-stream';
}

export const isHtml = (key: string) => contentTypeFor(key).startsWith('text/html');

// ---- the injected reporter tag ---------------------------------------------------------------------

/** The one `<script>` tag a mockup's HTML gains (build plan J9). `appOrigin` is
 *  `new URL(APP_ORIGIN).origin`: scheme, host and port, no path — what
 *  `postMessage` takes as a target origin, and free of characters that need
 *  attribute-escaping. */
export function reporterTag(appOrigin: string): string {
  return `<script src="/__root/reporter.js" data-enabled="true" data-root-origin="${appOrigin}"></script>`;
}

/**
 * Puts `tag` into an HTML document: before the first `</head>`, else before the
 * last `</body>`, else at the end (build plan J9).
 *
 * Works on **bytes, through a Latin-1 view**: every byte maps to exactly one
 * character, so an index found in the string is the same index in the buffer,
 * whatever ASCII-compatible encoding the document is in (UTF-8, Windows-1256 —
 * both keep `<`, `/` and letters where ASCII has them). Nothing is decoded and
 * re-encoded, so Persian text is never at risk. A UTF-16 document — no browser
 * sniffs one from a `<meta>` — would not match and would get the fallback, the
 * tag appended; acceptable, and not a case a mockup exported as HTML has.
 *
 * The first `</head>` and the *last* `</body>`: a `</head>` inside an inline
 * script string would have to come before the real one, and a `</body>` inside
 * one, before the real closing tag.
 */
export function injectReporter(html: Buffer, tag: string): Buffer {
  const text = html.toString('latin1');
  const insert = Buffer.from(tag, 'latin1');

  let at = text.search(/<\/head\s*>/i);
  if (at < 0) {
    const closers = [...text.matchAll(/<\/body\s*>/gi)];
    at = closers.length > 0 ? closers[closers.length - 1].index! : -1;
  }
  if (at < 0) return Buffer.concat([html, insert]);
  return Buffer.concat([html.subarray(0, at), insert, html.subarray(at)]);
}

// ---- headers -----------------------------------------------------------------------------------------

/**
 * The headers **every** mockup response carries — including its 404s, which is
 * why the router sets them before it looks anything up (build plan J9).
 *
 * `Content-Security-Policy` is the plan's exact string: only the portal may
 * frame a view (`frame-ancestors`), the mockup's own subresources and any
 * `https:` CDN are allowed (a generated mockup pulls fonts and scripts from
 * everywhere), `unsafe-inline`/`unsafe-eval` because the code is somebody
 * else's, `connect-src 'self'` so a script can talk to nothing but this
 * origin — which answers `GET` only and holds nothing — and `form-action
 * 'none'` so a form cannot post anywhere.
 *
 * `Referrer-Policy: no-referrer` because the grant id **is** the credential,
 * and a mockup that pulls a CDN script would otherwise hand the CDN the URL it
 * was loaded from. **No `Set-Cookie`, ever:** nothing in the mockup router sets
 * one, and this origin is fenced off from the code that does.
 */
export function mockupHeaders(appOrigin: string): Record<string, string> {
  return {
    'Content-Security-Policy': `frame-ancestors ${appOrigin}; default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src 'self'; form-action 'none'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // The grant id is in the host and the answer depends on the grant's expiry
    // and on the viewer's access at this moment, so nothing about a response
    // may be reused from a cache — shared or private — without asking again.
    'Cache-Control': 'private, no-store',
  };
}

// ---- reading an entry --------------------------------------------------------------------------------

/**
 * The validated name map of a stored zip, cached by its storage key. A stored
 * file is immutable (a new upload is a new row and a new key), so the cache
 * never needs invalidating; it is bounded so a long-lived process cannot grow
 * one entry per bundle ever viewed. Insertion order is eviction order.
 */
const BUNDLE_CACHE_LIMIT = 32;
const bundleCache = new Map<string, Promise<ValidatedBundle>>();

export function bundleFor(storageKey: string, zipPath: string): Promise<ValidatedBundle> {
  let cached = bundleCache.get(storageKey);
  if (!cached) {
    cached = validateBundle(zipPath);
    bundleCache.set(storageKey, cached);
    // A rejection must not be remembered: a bundle that failed to read (a
    // restore in progress, a transient I/O error) should be tried again.
    cached.catch(() => bundleCache.delete(storageKey));
    if (bundleCache.size > BUNDLE_CACHE_LIMIT) {
      const oldest = bundleCache.keys().next().value;
      if (oldest !== undefined) bundleCache.delete(oldest);
    }
  }
  return cached;
}

export function __clearBundleCacheForTests(): void {
  bundleCache.clear();
}

export type OpenedEntry = {
  /** Decompressed bytes, at most `size` of them — see `capped`. */
  stream: Readable;
  /** The size the central directory declares, and the stream's hard ceiling. */
  size: number;
};

/**
 * Opens one named entry of a zip for reading, or `null` if the archive has no
 * such entry.
 *
 * **The per-entry byte cap `mockupBundle.ts`'s header asks of the serving
 * side.** The sizes in a central directory are the entry's own claim about
 * itself, and a hostile local header can disagree with them. `yauzl` checks the
 * decompressed length against the declared one and errors the stream (its
 * `validateEntrySizes`, on by default); this wraps the stream in a counter that
 * stops at the declared size **independently of that option**, so the guarantee
 * does not hang on a library default — and so the `Content-Length` the router
 * sends is a number the stream can never exceed.
 */
export async function openEntry(zipPath: string, entryName: string): Promise<OpenedEntry | null> {
  // `autoClose: false`: breaking out of `eachEntry()` below would otherwise
  // close the archive before the entry found can be opened.
  const zipfile = await yauzl.openPromise(zipPath, { lazyEntries: true, strictFileNames: true, autoClose: false });
  let found: yauzl.Entry | null = null;
  try {
    for await (const entry of zipfile.eachEntry()) {
      if (entry.fileName === entryName) {
        found = entry;
        break;
      }
    }
    if (!found) {
      zipfile.close();
      return null;
    }
    const raw = await zipfile.openReadStreamPromise(found);
    // Closes the fd once the stream just opened has ended; a zipfile with no
    // open streams closes immediately.
    zipfile.close();
    // `pipeline`, not `.pipe()`: an error `yauzl` raises on `raw` must reach
    // the stream the router is reading, and `.pipe()` would swallow it.
    const guarded = pipeline(raw, capped(found.uncompressedSize), () => undefined);
    return { stream: guarded, size: found.uncompressedSize };
  } catch (err) {
    zipfile.close();
    throw err;
  }
}

/** A pass-through that errors rather than emit more than `limit` bytes. */
function capped(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) {
        callback(new Error(`entry is larger than the ${limit} bytes its header declares`));
        return;
      }
      callback(null, chunk);
    },
  });
}
