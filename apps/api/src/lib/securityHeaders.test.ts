import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
