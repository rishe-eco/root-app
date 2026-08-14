import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * persian-pass.md §1.1: there was exactly one key-parity test in the codebase
 * (changeAction.test.ts, for log.* only) and everything else was unguarded —
 * a key added to en.json and forgotten in fa.json shows English text to a
 * Persian reader and nothing fails. This is the general test, across every
 * namespace, plus the two that catch the subtler version: a value that is
 * merely copy-pasted, and one that is half-translated.
 */

const LOCALES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../i18n/locales');
const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
const fa = JSON.parse(readFileSync(join(LOCALES_DIR, 'fa.json'), 'utf8'));

type Leaves = Record<string, string>;

function flatten(obj: unknown, prefix = '', out: Leaves = {}): Leaves {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, out);
    }
  } else {
    out[prefix] = String(obj);
  }
  return out;
}

const enFlat = flatten(en);
const faFlat = flatten(fa);

test('every en.json key exists in fa.json', () => {
  const missing = Object.keys(enFlat).filter((k) => !(k in faFlat));
  assert.deepEqual(missing, [], `in en, missing from fa: ${missing.join(', ')}`);
});

test('every fa.json key exists in en.json', () => {
  const missing = Object.keys(faFlat).filter((k) => !(k in enFlat));
  assert.deepEqual(missing, [], `in fa, missing from en: ${missing.join(', ')}`);
});

/**
 * Identifiers and brand names that are Latin wherever they are printed
 * (persian-pass.md §1.1, §1.2) — legitimately identical or Latin-lettered in
 * a Persian string. i18next's {{var}} interpolation, and the "v" that
 * prefixes a version number outside the braces (e.g. "v{{to}}", rendering
 * "v3" — a Latin identifier per the numeral rule), are stripped the same way
 * since neither is translatable content.
 */
const SHARED_TERMS = ['Root', 'PDF', 'DOI'];

function strip(value: string): string {
  let s = value.replace(/v?\{\{[^}]+\}\}/g, '');
  for (const term of SHARED_TERMS) s = s.split(term).join('');
  return s;
}

test('no fa value is byte-identical to its en counterpart, past shared terms', () => {
  // Identical is fine when there is nothing left to translate (punctuation,
  // a shared identifier); it is a likely-untranslated placeholder otherwise.
  const offenders = Object.keys(enFlat).filter(
    (k) => enFlat[k] === faFlat[k] && /\p{L}/u.test(strip(enFlat[k])),
  );
  assert.deepEqual(offenders, [], `identical in both locales, looks untranslated: ${offenders.join(', ')}`);
});

test('no fa value contains Latin letters outside shared terms and placeholders', () => {
  const offenders = Object.keys(faFlat).filter((k) => /[A-Za-z]/.test(strip(faFlat[k])));
  assert.deepEqual(offenders, [], `Latin letters leaking into Persian: ${offenders.join(', ')}`);
});
