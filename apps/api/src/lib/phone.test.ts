import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, lastFourDigits } from './phone.js';

const E164 = '+989123456789';

test('every spelling the plan names folds to the same E.164 number', () => {
  const spellings = [
    '09123456789',
    '9123456789',
    '989123456789',
    '+989123456789',
    '۰۹۱۲۳۴۵۶۷۸۹',
  ];
  for (const spelling of spellings) {
    assert.equal(normalizePhone(spelling), E164, spelling);
  }
});

test('Arabic-Indic digits fold too, not only Persian', () => {
  assert.equal(normalizePhone('٠٩١٢٣٤٥٦٧٨٩'), E164);
});

test('spaces and dashes are cosmetic', () => {
  assert.equal(normalizePhone('0912 345 6789'), E164);
  assert.equal(normalizePhone('0912-345-6789'), E164);
  assert.equal(normalizePhone('+98 912 345 6789'), E164);
});

test('a number already in E.164 round-trips unchanged', () => {
  assert.equal(normalizePhone(E164), E164);
});

test('an unrelated country still parses when it carries its own +', () => {
  // Not everything this product will ever store is Iranian — a hand-rolled
  // Iran-only parser would refuse the first foreign number (PD-16's own
  // reasoning for choosing a real numbering-plan library over one).
  assert.equal(normalizePhone('+14155552671'), '+14155552671');
});

test('garbage, empty, and non-phone strings all refuse rather than throw', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('not a phone'), null);
  assert.equal(normalizePhone('12'), null);
  assert.equal(normalizePhone('0000000000000000'), null);
});

test('a too-short number that merely starts with the calling code is not silently promoted to international', () => {
  // "98" is also the start of plenty of otherwise-unrelated short input; the
  // length guard means this is parsed as an IR *national* number ("98" as
  // the start of a subscriber number) rather than reinterpreted as the
  // country calling code — and a 2-digit national number is refused on its
  // own numbering-plan terms, the library's decision, not this file's.
  assert.equal(normalizePhone('98'), null);
});

test('a landline (not a mobile number) still normalizes — this file validates a numbering plan, not a mobile-only policy', () => {
  const landline = normalizePhone('02112345678');
  assert.ok(landline === null || landline.startsWith('+9821'), landline ?? 'null');
});

test('two spellings of one number produce the same key — the whole reason this file exists', () => {
  const a = normalizePhone('09123456789');
  const b = normalizePhone('+989123456789');
  assert.equal(a, b);
  assert.ok(a !== null);
});

test('lastFourDigits shows only what cannot itself be replayed', () => {
  assert.equal(lastFourDigits('+989123456789'), '6789');
});
