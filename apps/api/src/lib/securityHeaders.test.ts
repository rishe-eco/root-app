import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POLICY } from './files.js';

/**
 * No test can see an Nginx header — Nginx is never in the loop for `npm test`,
 * `test:integration` or e2e (the last runs against `vite preview`). That is
 * exactly how D-1 stayed invisible: the portal's CSP had no `frame-src`, so
 * `default-src 'self'` governed frames too, and the browser silently refused
 * L2's live-demo `<iframe>` (`DemoViewport.tsx`, at `demo.stagingUrl`) the
 * first time it ran behind real Nginx. Nothing here runs Nginx either — it
 * reads `deploy/nginx/security-headers.conf` and `deploy/nginx/root.conf` as
 * text, the same trick `changeAction.test.ts` uses on files a type system
 * cannot connect. It cannot prove the header works; it can only pin down what
 * would otherwise drift back to today's silent gap.
 */

/** Walk up to the workspace root, so this works from source or from dist. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'root-app') return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('Could not find the workspace root from ' + import.meta.url);
}

const ROOT = repoRoot();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const SECURITY_HEADERS_CONF = 'deploy/nginx/security-headers.conf';
const ROOT_CONF = 'deploy/nginx/root.conf';

/** The quoted value nginx will actually send for a given `add_header <name>`. */
function headerValue(source: string, name: string): string {
  const re = new RegExp(`add_header\\s+${name}\\s+"([^"]*)"`);
  const match = source.match(re);
  assert.ok(match, `no "add_header ${name}" line found`);
  return match[1];
}

/** `directive-name source source …` pairs, split on the `;` CSP itself uses. */
function cspDirectives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    map.set(tokens[0], tokens.slice(1));
  }
  return map;
}

const conf = read(SECURITY_HEADERS_CONF);
const csp = headerValue(conf, 'Content-Security-Policy');
const directives = cspDirectives(csp);

test('the CSP still has a directive for every name this parse depends on', () => {
  // If the regex above ever stops finding a directive, every test below would
  // pass vacuously (an empty source list satisfies "contains no X"). Pin the
  // shape first, so a parsing regression fails loudly instead of quietly.
  for (const name of ['default-src', 'frame-ancestors', 'frame-src', 'object-src']) {
    assert.ok(directives.has(name), `missing "${name}" — has the CSP been reshaped?`);
  }
});

test('default-src is unchanged: \'self\' and nothing else', () => {
  assert.deepEqual(directives.get('default-src'), [`'self'`]);
});

test('frame-src names both PD-8 hosts and nothing broader', () => {
  const sources = directives.get('frame-src') ?? [];
  assert.ok(
    sources.includes('https://*.staging.m-root.com'),
    'frame-src must allow the staging wildcard (PD-8)',
  );
  assert.ok(
    sources.includes('https://*.mockup.m-root.com'),
    'frame-src must allow the mockup wildcard (PD-9)',
  );

  // The whole point of naming two exact hosts is that nothing else can be
  // framed. A source this broad would readmit the D-1 hole in a different
  // shape — permissive enough that the two named hosts stop mattering.
  const tooBroad = new Set(['*', 'https:', 'http:', 'data:']);
  const broad = sources.filter((s) => tooBroad.has(s));
  assert.deepEqual(broad, [], `frame-src carries an overly broad source: ${broad.join(', ')}`);
});

test('frame-ancestors still protects the portal from being framed', () => {
  // frame-src and frame-ancestors point opposite directions — one says what
  // the portal may embed, the other who may embed the portal — and adding
  // the first must never loosen the second. 'none' is what stops someone
  // clickjacking a signed-in customer onto the contract e-sign button.
  assert.deepEqual(directives.get('frame-ancestors'), [`'none'`]);
});

test('X-Frame-Options still repeats frame-ancestors for pre-CSP browsers', () => {
  assert.equal(headerValue(conf, 'X-Frame-Options'), 'DENY');
});

// ---------------------------------------------------------------------------

const rootConf = read(ROOT_CONF);

/** The two file locations whose own header comment says they deliberately
 *  carry a stricter, unrelated CSP instead of the shared snippet. */
const SANDBOXED_LOCATIONS = ['/public-files/', '/files/'];

/** Every top-level `location …{ … }` block in `root.conf`, as `{ path, body }`.
 *  A brace counter, not a regex across the whole file, because a location
 *  block can itself contain a `{` inside a regex path (none do today, but the
 *  parse should not assume that). */
function locationBlocks(source: string): { path: string; body: string }[] {
  const blocks: { path: string; body: string }[] = [];
  // The selector is everything between "location" and the opening brace —
  // not just one token, because a regex selector like `~* \.(woff2?|ttf|eot)$`
  // contains whitespace of its own (the modifier and the pattern).
  const re = /location\s+([^{]+?)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    blocks.push({ path: m[1], body: source.slice(bodyStart, i - 1) });
  }
  return blocks;
}

const blocks = locationBlocks(rootConf);

test('the parse actually found the location blocks (the regex has not drifted)', () => {
  assert.ok(blocks.length >= 7, `parsed only ${blocks.length} location blocks`);
});

test('every location that sets its own add_header either includes the shared snippet or is sandboxed', () => {
  // This is the trap: nginx's add_header is replace-not-merge, so a new
  // location that adds even one header of its own silently drops the whole
  // security-headers.conf set unless it re-includes it. The two file
  // locations are the deliberate exception — their own comments explain why
  // they carry a stricter policy instead.
  const offenders = blocks
    .filter((b) => /add_header/.test(b.body))
    .filter((b) => !SANDBOXED_LOCATIONS.includes(b.path))
    .filter((b) => !/include\s+\/etc\/nginx\/snippets\/root-security-headers\.conf;/.test(b.body))
    .map((b) => b.path);
  assert.deepEqual(offenders, [], `location(s) with add_header but no shared-header include: ${offenders.join(', ')}`);
});

test('the two sandboxed file locations are exactly the ones this test expects', () => {
  // If someone renames or removes one of these paths, the test above would
  // start silently accepting whatever replaced it. Pin the set by name.
  const sandboxedPresent = SANDBOXED_LOCATIONS.filter((p) => blocks.some((b) => b.path === p));
  assert.deepEqual(sandboxedPresent.sort(), [...SANDBOXED_LOCATIONS].sort());
});

// ---------------------------------------------------------------------------
// Journeys build plan J9 — the mockup host's two Nginx facts. Neither can be
// seen by any other test: a mockup is uploaded code on a sibling subdomain of
// the portal's registrable domain, and the second fence (after the API's own,
// which `j9a.test.ts` proves) is a server block that must stay a bare proxy.
// ---------------------------------------------------------------------------

const MOCKUP_CONF = 'deploy/nginx/mockup.conf';

/** `26m`, `1k`, `2g`, `500` → bytes, the way Nginx reads `client_max_body_size`. */
function nginxBytes(size: string): number {
  const m = /^(\d+)([kKmMgG]?)$/.exec(size.trim());
  assert.ok(m, `unparseable size "${size}"`);
  const unit = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g'];
  return Number(m[1]) * unit;
}

const bodyLimit = (block: string): number => {
  const m = /client_max_body_size\s+([^;\s]+);/.exec(block);
  assert.ok(m, 'no client_max_body_size in that block');
  return nginxBytes(m[1]);
};

test('/upload lets a whole mockup bundle through Nginx: its body limit is at or above the bundle cap plus the multipart envelope', () => {
  // Trap 2 of J9. Nginx's 26m would answer a 30 MB bundle with a bare 413 no
  // code of ours could describe; the per-class limit in lib/files.ts is the
  // real check, and Nginx only has to not get in its way.
  const upload = blocks.find((b) => b.path === '= /upload');
  assert.ok(upload, 'no `location = /upload` block');
  const envelope = 1024 * 1024; // generous room for boundaries and part headers
  assert.ok(
    bodyLimit(upload.body) >= POLICY.MOCKUP_BUNDLE.maxBytes + envelope,
    `/upload allows ${bodyLimit(upload.body)} bytes; a ${POLICY.MOCKUP_BUNDLE.maxBytes}-byte bundle plus envelope needs more`,
  );
  // …and only there: the server-level default stays small.
  const serverLevel = rootConf.slice(0, rootConf.indexOf('location'));
  assert.ok(bodyLimit(serverLevel) <= 2 * 1024 * 1024, 'the server-level client_max_body_size was raised');
});

// Comments stripped first: this file explains itself at length, and the word
// "location" in a comment would otherwise open a phantom block for the parser.
const mockupConf = read(MOCKUP_CONF).replace(/#.*$/gm, '');
const mockupBlocks = locationBlocks(mockupConf);

test('the mockup server block answers for the mockup wildcard, and the portal block does not', () => {
  assert.match(mockupConf, /server_name\s+\*\.mockup\.m-root\.com;/);
  assert.doesNotMatch(rootConf, /server_name[^;]*mockup/);
});

test('the mockup server block has exactly one location, `/`, and it proxies only to the API on loopback', () => {
  // No portal locations (J9 trap 1): /graphql, /upload, /files/, /ask, the
  // static root. A second location here is a route a mockup's script could reach.
  assert.deepEqual(mockupBlocks.map((b) => b.path), ['/']);
  const body = mockupBlocks[0].body;
  assert.match(body, /proxy_pass\s+http:\/\/127\.0\.0\.1:4000;/);
  assert.match(body, /proxy_set_header\s+Host\s+\$host;/, "the API's fence reads Host — it must be passed");
});

test('the mockup server block serves nothing from disk and adds no headers of its own', () => {
  // The API sends this origin's headers; a static root or alias here would
  // serve uploaded bytes without the API's fence, and an add_header (or the
  // shared snippet) would double the Content-Security-Policy.
  assert.doesNotMatch(mockupConf, /^\s*(root|alias|try_files|autoindex)\b/m);
  assert.doesNotMatch(mockupConf, /^\s*add_header\b/m);
  assert.doesNotMatch(mockupConf, /^\s*include\s+\/etc\/nginx\/snippets\/root-security-headers\.conf/m);
});

test('the mockup server block strips cookies both ways and never forwards a client-chosen host', () => {
  const body = mockupBlocks[0].body;
  assert.match(body, /proxy_set_header\s+Cookie\s+"";/);
  assert.match(body, /proxy_hide_header\s+Set-Cookie;/);
  assert.match(body, /proxy_set_header\s+X-Forwarded-Host\s+"";/);
});

test('the mockup server block takes no request bodies to speak of', () => {
  assert.ok(bodyLimit(mockupConf) <= 16 * 1024, 'a mockup view is read-only; its body limit should be tiny');
});

test("the portal's CSP still names the mockup wildcard in frame-src (the mockup host is what it frames)", () => {
  assert.ok((directives.get('frame-src') ?? []).includes('https://*.mockup.m-root.com'));
});
