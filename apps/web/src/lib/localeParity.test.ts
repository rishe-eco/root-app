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

/**
 * persian-pass.md §1.5, held mechanically. The pass read every Persian string
 * for ZWNJ by hand and normalized four words spelled two ways; this catches
 * the fifth, and every one after it — one sequence of letters, one spelling,
 * across the whole file.
 *
 * **It cannot be a blanket rule**, which is why it has an allowlist rather
 * than being a plain assertion. Persian genuinely spells the same letters two
 * ways depending on grammatical role: a compound verb takes a space
 * («هنوز چیزی منتشر نشده» — *nothing has been published*), the participial
 * adjective built from it fuses with a ZWNJ («تغییرات منتشرنشده» —
 * *unpublished changes*). Both are correct, and a test that flattened them
 * would be pressure to make the Persian wrong.
 *
 * So each pair below is a **read and accepted** verdict, not a suppression.
 * Adding to it means having checked the two call sites and concluded they
 * play different grammatical roles — if they play the *same* role, it is the
 * defect this test exists to find, and the fix is to pick one spelling.
 */
const ROLE_PAIRS: Record<string, string> = {
  // verb «انجام شده» / adjective «انجام‌شده»
  'انجامشده': 'compound verb vs. participial adjective (status.DONE)',
  // verb «تغییر کرده» / adjective «تغییرکرده»
  'تغییرکرده': 'compound verb vs. participial adjective (workspace.changeChanged)',
  // verb «منتشر نشده» / adjective «منتشرنشده»
  'منتشرنشده': 'compound verb vs. participial adjective (workspace.dirty)',
};

const PERSIAN_RUN = /[؀-ۿ‌]+/g;

test('one sequence of Persian letters, one spelling — past the documented role pairs', () => {
  const spellings = new Map<string, Set<string>>();
  const add = (surface: string) => {
    const key = surface.replace(/[‌\s]/g, '');
    if (!key) return;
    (spellings.get(key) ?? spellings.set(key, new Set()).get(key)!).add(surface);
  };

  for (const value of Object.values(faFlat)) {
    const tokens = value.match(PERSIAN_RUN) ?? [];
    tokens.forEach((token, i) => {
      add(token);
      // Bigrams too: «امضا شده» and «امضاشده» are the same letters, and only
      // comparing whole tokens would never put them beside each other.
      if (i + 1 < tokens.length) add(`${token} ${tokens[i + 1]}`);
    });
  }

  const offenders = [...spellings.entries()]
    .filter(([key, forms]) => forms.size > 1 && !(key in ROLE_PAIRS))
    .map(([key, forms]) => `${key}: ${[...forms].join(' / ')}`);

  assert.deepEqual(offenders, [], `the same word spelled more than one way:\n  ${offenders.join('\n  ')}`);
});
