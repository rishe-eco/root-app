import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRIEF_FIELDS,
  COMMITMENT_KEYS,
  EXTRA_COMMITMENT,
  MONEY_FIELDS,
  designPath,
  impliedRows,
  isCommitmentKey,
  isIncludedExtra,
  missingParams,
  normalizeAmount,
} from './brief.js';

/**
 * A hand-kept mirror of a few constants in `apps/api/src/lib/brief.ts` (the
 * same shape of trap `access.test.ts` guards for capabilities): nothing at
 * build time connects the two, so this reads the API's file as text and
 * fails when they drift.
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

const apiSource = readFileSync(join(repoRoot(), 'apps/api/src/lib/brief.ts'), 'utf8');

test('the commitment keys are the API’s, in its order', () => {
  const block = /export const COMMITMENTS[^{]*\{([\s\S]*?)\n\};/.exec(apiSource);
  assert.ok(block, 'the API’s COMMITMENTS table was not found');
  const keys = [...block[1].matchAll(/^  (\w+): \{ technical:/gm)].map((m) => m[1]);
  assert.deepEqual([...COMMITMENT_KEYS], keys);
});

test('the extras that imply a commitment are the API’s', () => {
  const block = /export const EXTRA_COMMITMENT[^{]*\{([\s\S]*?)\};/.exec(apiSource);
  assert.ok(block, 'the API’s EXTRA_COMMITMENT was not found');
  const pairs = Object.fromEntries([...block[1].matchAll(/'([\w.]+)': '(\w+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual({ ...EXTRA_COMMITMENT }, pairs);
});

test('the statuses that put an extra in scope are the API’s', () => {
  const m = /INCLUDED_EXTRA_STATUSES[^=]*=\s*new Set\(\[([^\]]*)\]/.exec(apiSource);
  assert.ok(m, 'the API’s INCLUDED_EXTRA_STATUSES was not found');
  const statuses = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  for (const s of statuses) assert.equal(isIncludedExtra(s), true, s);
  for (const s of ['DECLINED', 'PROPOSED', 'TRADED']) assert.equal(isIncludedExtra(s), false, s);
});

test('the feedback anchors are the API’s BRIEF_FIELDS — a card can never offer one the server refuses', () => {
  const m = /export const BRIEF_FIELDS[^=]*=\s*\[([\s\S]*?)\];/.exec(apiSource);
  assert.ok(m, 'the API’s BRIEF_FIELDS was not found');
  const literals = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  // …then `...COMMITMENT_KEYS`, which both sides spread.
  assert.deepEqual([...BRIEF_FIELDS], [...literals, ...COMMITMENT_KEYS]);
  for (const money of MONEY_FIELDS) assert.ok((BRIEF_FIELDS as readonly string[]).includes(money));
});

test('impliedRows: a chosen provider and an in-scope extra each imply a dated commitment', () => {
  assert.deepEqual(impliedRows({ domain: '', host: '', content: '' }, []), []);
  assert.deepEqual(impliedRows({ domain: 'CUSTOMER', host: '', content: 'ROOT' }, []).map((r) => r.key), ['domain', 'content']);
  const withExtras = impliedRows({ domain: '', host: 'ROOT', content: '' }, ['checklist.payment', 'checklist.analytics', 'checklist.legal']);
  assert.deepEqual(withExtras.map((r) => [r.key, r.fromBrief]), [['host', true], ['gateway', false], ['enamad', false]]);
});

test('the design path is what is shown; the tier is what is stored (PD-13)', () => {
  assert.equal(designPath('THEME_PICK'), 'PREMADE');
  assert.equal(designPath('CLAUDE_ASSISTED'), 'CUSTOM');
  assert.equal(designPath('SENIOR_DESIGNER'), 'CUSTOM');
});

test('normalizeAmount: Persian and Arabic-Indic digits become Latin, grouping goes, nothing else is repaired', () => {
  assert.equal(normalizeAmount('۱۵۰۰۰۰۰۰۰'), '150000000');
  assert.equal(normalizeAmount('١٥٠٠٠٠٠٠٠'), '150000000');
  assert.equal(normalizeAmount('150,000,000'), '150000000');
  assert.equal(normalizeAmount('۱۵۰٬۰۰۰٬۰۰۰'), '150000000');
  assert.equal(normalizeAmount(' 1 500 '), '1500');
  // A decimal or a letter stays, so the server refuses it instead of this guessing.
  assert.equal(normalizeAmount('1.5'), '1.5');
  assert.equal(normalizeAmount('12ab'), '12ab');
  assert.equal(normalizeAmount(''), '');
});

test('missingParams names the commitment or the phase a code is about', () => {
  const n = (v: number) => `#${v}`;
  assert.deepEqual(missingParams({ code: 'COMMITMENT_UNDATED', key: 'host' }, () => null, (k) => `title:${k}`, n), { what: 'title:host' });
  assert.deepEqual(missingParams({ code: 'PHASE_END_DATE', key: 'p1' }, (id) => (id === 'p1' ? 2 : null), () => '', n), { n: '#2' });
  assert.deepEqual(missingParams({ code: 'PHASE_END_DATE', key: 'gone' }, () => null, () => '', n), { n: '' });
  assert.deepEqual(missingParams({ code: 'BUDGET_CAP', key: null }, () => null, () => '', n), {});
  assert.equal(isCommitmentKey('domain'), true);
  assert.equal(isCommitmentKey('budgetCap'), false);
});
