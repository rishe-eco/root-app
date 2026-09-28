import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * P0-7 (defect D-8) — three assertions the brief asks for that no runtime
 * unit test can make, because each is a fact about *source text*, not about
 * any one function's behaviour: whether a flag was ever flipped off, whether
 * a middleware was mounted before another, whether some file anywhere in the
 * workspace ever passes a `domain` option to a cookie call. `changeAction.
 * test.ts` already reads source as data for exactly this reason; this file
 * borrows the same `repoRoot`/`read` pair rather than inventing a second one.
 */

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

test('Apollo’s csrfPrevention is never switched off — Apollo Server 4 defaults it on, and index.ts must not override that', () => {
  const src = read('apps/api/src/index.ts');
  assert.doesNotMatch(
    src,
    /csrfPrevention\s*:\s*false/,
    'csrfPrevention: false would remove /graphql’s own defence against the same same-site forgery this stage closes for /upload and /ask',
  );
});

test('originCheck is mounted after cookieParser and before /graphql (and, by the same app.use order, before filesRouter and askRouter)', () => {
  // Normalized to LF first: this repository is checked out with CRLF line
  // endings on Windows, and a literal "\n" in a search string would silently
  // never match — better to normalize once than to write every check as a
  // regex tolerant of \r?\n.
  const src = read('apps/api/src/index.ts').replace(/\r\n/g, '\n');
  const cookieParserAt = src.indexOf('app.use(cookieParser())');
  const originCheckAt = src.indexOf('app.use(originCheck)');
  const graphqlAt = src.indexOf("app.use(\n  '/graphql'");
  const filesRouterAt = src.indexOf('app.use(filesRouter)');
  const askRouterAt = src.indexOf('app.use(askRouter)');

  assert.ok(cookieParserAt !== -1, 'app.use(cookieParser()) not found — has index.ts been rewritten?');
  assert.ok(originCheckAt !== -1, 'app.use(originCheck) not found — is the middleware still mounted?');
  assert.ok(graphqlAt !== -1, "the /graphql app.use(...) block not found");
  assert.ok(filesRouterAt !== -1 && askRouterAt !== -1, 'filesRouter/askRouter mounts not found');

  assert.ok(cookieParserAt < originCheckAt, 'originCheck must be mounted after cookieParser() — it reads req.cookies');
  assert.ok(originCheckAt < filesRouterAt, 'originCheck must be mounted before filesRouter');
  assert.ok(originCheckAt < askRouterAt, 'originCheck must be mounted before askRouter');
  assert.ok(originCheckAt < graphqlAt, 'originCheck must be mounted before /graphql');
});

/** Every `.ts` file under `apps/api/src`, excluding `*.test.ts` (a test may
 *  legitimately construct a `domain`-bearing options object as a *fixture* to
 *  prove some other code refuses it — that is not the same claim as "this is
 *  a real cookie the server sets"). */
function nonTestTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...nonTestTsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

test('no non-test code path sets a cookie with a Domain attribute', () => {
  // A `Domain` attribute is exactly what would let a sibling subdomain (a
  // staging site, a mockup) read or overwrite the session cookie — the whole
  // threat P0-7 exists to close (see lib/originCheck.ts's module comment and
  // lib/sessionCookie.ts). Robust to formatting — this does not parse the
  // options object, it just refuses to let `domain:` appear anywhere near a
  // cookie call at all.
  const offenders: string[] = [];
  for (const file of nonTestTsFiles(join(ROOT, 'apps/api/src'))) {
    const src = readFileSync(file, 'utf8');
    if (/\.cookie\(|clearCookie\(/.test(src) && /domain\s*:/.test(src)) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});
