import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `ChangeAction` lives in five places and nothing connects them:
 *
 *   1. prisma/schema.prisma          the enum the database stores
 *   2. src/graphql/typeDefs.ts       the enum the client is promised
 *   3. web/src/lib/changelog.ts      action -> i18n key (V4: moved out of
 *                                    ContractDetail.tsx so the desk's
 *                                    activity feed can share it — V4.md T5)
 *   4. web/src/i18n/locales/en.json  the English sentence
 *   5. web/src/i18n/locales/fa.json  the Persian sentence
 *
 * Adding a value in the first two and forgetting the last three is not a
 * type error, is not a lint error, and does not crash — it renders the
 * literal text "log.undefined" in the customer's history. That has already
 * shipped once.
 *
 * So this reads all five as text. Parsing source in a test is usually a smell;
 * here it is the only thing that can see across the workspace boundary, and
 * the alternative is a generated file nobody would regenerate.
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

/** The values inside `enum ChangeAction { … }`, in either Prisma or SDL. */
function enumValues(source: string, label: string): string[] {
  const match = source.match(/enum\s+ChangeAction\s*\{([^}]*)\}/);
  assert.ok(match, `no "enum ChangeAction" block found in ${label}`);
  return match[1]
    .split('\n')
    .map((line) => line.replace(/(\/\/|#).*$/, '').trim()) // strip trailing comments
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));
}

/** The `ACTION: 'i18nKey'` map in lib/changelog.ts's actionLogKey. */
function actionKeyMap(): Map<string, string> {
  const src = read('apps/web/src/lib/changelog.ts');
  const start = src.indexOf('const key = {');
  const end = src.indexOf('}[e.action];', start);
  assert.ok(start !== -1 && end !== -1, 'could not find the action key map in lib/changelog.ts');

  const map = new Map<string, string>();
  for (const [, action, key] of src
    .slice(start, end)
    .matchAll(/([A-Z][A-Z0-9_]*)\s*:\s*'([^']+)'/g)) {
    map.set(action, key);
  }
  return map;
}

const logKeys = (locale: string): Set<string> =>
  new Set(Object.keys(JSON.parse(read(`apps/web/src/i18n/locales/${locale}.json`)).log ?? {}));

/**
 * Keys under `log.*` that are not action sentences. `relativeTime` renders
 * "just now" from this namespace, so it is expected to have no action.
 */
const NON_ACTION_LOG_KEYS = new Set(['justNow']);

const PRISMA = enumValues(read('apps/api/prisma/schema.prisma'), 'schema.prisma');

test('the Prisma enum is not empty (the parse actually found something)', () => {
  assert.ok(PRISMA.length > 10, `parsed only ${PRISMA.length} values — the regex has drifted`);
});

test('the GraphQL enum matches the Prisma enum exactly', () => {
  const sdl = enumValues(read('apps/api/src/graphql/typeDefs.ts'), 'typeDefs.ts');
  assert.deepEqual([...sdl].sort(), [...PRISMA].sort());
});

test('every action has a row in the ContractDetail key map', () => {
  const mapped = actionKeyMap();
  const missing = PRISMA.filter((a) => !mapped.has(a));
  assert.deepEqual(missing, [], `these render as "log.undefined": ${missing.join(', ')}`);
});

test('the key map has no rows for actions that no longer exist', () => {
  const stale = [...actionKeyMap().keys()].filter((a) => !PRISMA.includes(a));
  assert.deepEqual(stale, [], `removed from the enum but still mapped: ${stale.join(', ')}`);
});

for (const locale of ['en', 'fa']) {
  test(`every action resolves to a ${locale} sentence`, () => {
    const keys = logKeys(locale);
    const missing = [...actionKeyMap().entries()]
      .filter(([, key]) => !keys.has(key))
      .map(([action, key]) => `${action} -> log.${key}`);
    assert.deepEqual(missing, [], `untranslated in ${locale}: ${missing.join(', ')}`);
  });

  test(`the ${locale} log namespace has no orphan keys`, () => {
    const used = new Set(actionKeyMap().values());
    const orphans = [...logKeys(locale)].filter(
      (k) => !used.has(k) && !NON_ACTION_LOG_KEYS.has(k),
    );
    assert.deepEqual(orphans, [], `no action points at these: ${orphans.join(', ')}`);
  });
}

test('en and fa carry exactly the same log keys', () => {
  // A sentence present in one language and not the other is the same bug as
  // a missing one — it just only shows for half the customers.
  assert.deepEqual([...logKeys('en')].sort(), [...logKeys('fa')].sort());
});
