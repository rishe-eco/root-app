import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { UPLOAD_ERROR_CODES, uploadErrorKey } from './upload.js';

/** Journeys build plan J9b (J9a's owed item) — every code the upload route can answer has a sentence. */

const locale = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../i18n/locales/${name}.json`, import.meta.url)), 'utf8')) as Record<string, unknown>;
const dig = (obj: Record<string, unknown>, key: string): unknown => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);

test('every BUNDLE_* code, CONTRACT_REQUIRED, NOT_ASSIGNED and NO_FILE has its own key', () => {
  for (const code of [
    'BUNDLE_TOO_LARGE',
    'BUNDLE_TOO_MANY_FILES',
    'BUNDLE_PATH_UNSAFE',
    'BUNDLE_TYPE_REFUSED',
    'BUNDLE_NO_INDEX',
    'BUNDLE_UNREADABLE',
    'BUNDLE_ENCRYPTED_ENTRY',
    'CONTRACT_REQUIRED',
    'NOT_ASSIGNED',
    'NO_FILE',
  ]) {
    assert.ok(UPLOAD_ERROR_CODES.includes(code), code);
    assert.notEqual(uploadErrorKey(code), 'upload.errGeneric', code);
  }
  assert.equal(uploadErrorKey('SOMETHING_NEW'), 'upload.errGeneric');
  assert.equal(uploadErrorKey(undefined), 'upload.errGeneric');
});

test('every key the upload errors name exists in both languages, as a sentence', () => {
  const keys = new Set(UPLOAD_ERROR_CODES.map(uploadErrorKey).concat('upload.errGeneric'));
  for (const name of ['fa', 'en']) {
    const messages = locale(name);
    for (const key of keys) {
      const value = dig(messages, key);
      assert.equal(typeof value, 'string', `${name}: ${key}`);
      assert.ok((value as string).length > 0, `${name}: ${key}`);
    }
  }
});

test('the API’s own BUNDLE_* codes are all mapped — read from lib/mockupBundle.ts, so a new refusal fails here until it is worded', () => {
  const source = readFileSync(fileURLToPath(new URL('../../../api/src/lib/mockupBundle.ts', import.meta.url)), 'utf8');
  const codes = [...new Set([...source.matchAll(/'(BUNDLE_[A-Z_]+)'/g)].map((m) => m[1]))];
  assert.ok(codes.length >= 7, 'the scan found the codes');
  for (const code of codes) assert.notEqual(uploadErrorKey(code), 'upload.errGeneric', code);
});
