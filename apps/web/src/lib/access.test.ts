import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from './access.js';

/**
 * S1's own trap: "a stale mirror hides a nav row silently." `access.ts`
 * hand-keeps a `CAPABILITIES` array that mirrors the API's
 * `apps/api/src/lib/capabilities.ts` — nothing at build time connects them,
 * so a capability added, renamed or removed on one side and forgotten on the
 * other is not a type error and does not crash. It just quietly shows or
 * hides a nav row for the wrong set of people.
 *
 * So this reads the API's file as text and compares the two lists — the same
 * workspace-root trick `apps/api/src/lib/changeAction.test.ts` uses for
 * `ChangeAction`, applied here to `Capability`.
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

/** The quoted strings inside `export const CAPABILITIES = [ … ] as const;`. */
function capabilityNames(source: string, label: string): string[] {
  const match = source.match(/export const CAPABILITIES = \[([\s\S]*?)\] as const;/);
  assert.ok(match, `no "export const CAPABILITIES = [...] as const;" block found in ${label}`);
  return [...match[1].matchAll(/'([a-zA-Z]+(?:\.[a-zA-Z]+)*)'/g)].map((m) => m[1]);
}

const API_CAPABILITIES = capabilityNames(read('apps/api/src/lib/capabilities.ts'), 'apps/api/src/lib/capabilities.ts');

test('the API capabilities array is not empty (the parse actually found something)', () => {
  assert.ok(API_CAPABILITIES.length > 10, `parsed only ${API_CAPABILITIES.length} values — the regex has drifted`);
});

test('the web Capability union has exactly the API capabilities, no more, no fewer', () => {
  assert.deepEqual([...CAPABILITIES].sort(), [...API_CAPABILITIES].sort());
});

test('contracts.manage is gone from both sides, not aliased', () => {
  assert.ok(!API_CAPABILITIES.includes('contracts.manage'));
  assert.ok(!(CAPABILITIES as readonly string[]).includes('contracts.manage'));
});
