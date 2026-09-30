import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FONT_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_LOGO_NOTE_LENGTH,
  checkLabels,
  checkPaletteItem,
  checkPaletteValue,
  checkRole,
  normalizeColor,
} from './palette.js';

/** Journeys build plan J8 — the palette's validation rules, listed in
 *  `lib/palette.ts`'s header and held here. */

test('a colour is a hex: three or six digits, either case, stored as lowercase six', () => {
  const good: Array<[string, string]> = [
    ['#0a7', '#00aa77'],
    ['#00AA77', '#00aa77'],
    ['  #1F3A5C ', '#1f3a5c'],
    ['#fff', '#ffffff'],
  ];
  for (const [input, want] of good) assert.equal(normalizeColor(input), want, input);
  for (const bad of ['', 'red', '#ggg', '#12', '#1234', '#12345', '#1234567', '1f3a5c', 'rgb(1,2,3)', '#1f3a5c;', '#1f3a5c80', 'url(x)', '#1f3a5g']) {
    assert.equal(normalizeColor(bad), null, bad);
  }
});

test('checkPaletteValue: each kind has its own rule and refuses with its own code', () => {
  assert.deepEqual(checkPaletteValue('COLOR', '#ABC'), { value: '#aabbcc' });
  assert.deepEqual(checkPaletteValue('COLOR', 'blue'), { problem: 'INVALID_COLOR' });

  assert.deepEqual(checkPaletteValue('FONT', ' Vazirmatn '), { value: 'Vazirmatn' });
  assert.deepEqual(checkPaletteValue('FONT', 'IBM Plex Sans Arabic'), { value: 'IBM Plex Sans Arabic' });
  assert.deepEqual(checkPaletteValue('FONT', 'ایرانسنس'), { value: 'ایرانسنس' }, 'a Persian family name is a name');
  assert.deepEqual(checkPaletteValue('FONT', 'Noto Sans-2.0_x'), { value: 'Noto Sans-2.0_x' });

  assert.deepEqual(checkPaletteValue('LOGO_USAGE', 'Only on white; keep clear space equal to the mark’s height.'), {
    value: 'Only on white; keep clear space equal to the mark’s height.',
  });
});

test('a font is a name, not CSS: quotes, commas, braces, semicolons and slashes are refused', () => {
  for (const bad of ['', '   ', 'Arial, sans-serif', 'A"B', "A'B", 'A;B', 'A{B}', 'A(B)', 'A/B', 'A\\B', '<b>x</b>', 'A\nB', '-Arial', '.x', 'x'.repeat(MAX_FONT_LENGTH + 1)]) {
    assert.deepEqual(checkPaletteValue('FONT', bad), { problem: 'INVALID_FONT' }, JSON.stringify(bad));
  }
  assert.deepEqual(checkPaletteValue('FONT', 'x'.repeat(MAX_FONT_LENGTH)), { value: 'x'.repeat(MAX_FONT_LENGTH) });
});

test('a logo note is one sentence: not empty, bounded, no control characters', () => {
  assert.deepEqual(checkPaletteValue('LOGO_USAGE', '   '), { problem: 'INVALID_LOGO_NOTE' });
  assert.deepEqual(checkPaletteValue('LOGO_USAGE', 'two\nlines'), { problem: 'INVALID_LOGO_NOTE' });
  assert.deepEqual(checkPaletteValue('LOGO_USAGE', 'x'.repeat(MAX_LOGO_NOTE_LENGTH + 1)), { problem: 'INVALID_LOGO_NOTE' });
  assert.ok('value' in checkPaletteValue('LOGO_USAGE', 'x'.repeat(MAX_LOGO_NOTE_LENGTH)));
});

test('a role is a Latin identifier: lowercase, digits, hyphens, starting with a letter', () => {
  for (const good of ['primary', 'accent-2', 'heading', 'logo-on-dark', 'a']) assert.equal(checkRole(good), true, good);
  for (const bad of ['', 'Primary', '2nd', '-x', 'a b', 'رنگ', 'a_b', 'x'.repeat(33)]) assert.equal(checkRole(bad), false, bad);
});

test('both labels are required and bounded', () => {
  assert.deepEqual(checkLabels(' رنگ اصلی ', ' Primary '), { labelFa: 'رنگ اصلی', labelEn: 'Primary' });
  assert.deepEqual(checkLabels('', 'Primary'), { problem: 'LABEL_REQUIRED' });
  assert.deepEqual(checkLabels('رنگ', '  '), { problem: 'LABEL_REQUIRED' });
  assert.deepEqual(checkLabels('x'.repeat(MAX_LABEL_LENGTH + 1), 'y'), { problem: 'LABEL_TOO_LONG' });
});

test('checkPaletteItem: the whole item, refusing at the first thing wrong and normalizing what it keeps', () => {
  const item = { kind: 'COLOR' as const, role: 'primary', value: '#ABC', labelFa: 'اصلی', labelEn: 'Primary' };
  assert.deepEqual(checkPaletteItem(item), { ...item, value: '#aabbcc' });
  assert.deepEqual(checkPaletteItem({ ...item, role: 'Primary' }), { problem: 'INVALID_ROLE' });
  assert.deepEqual(checkPaletteItem({ ...item, value: 'nope' }), { problem: 'INVALID_COLOR' });
  assert.deepEqual(checkPaletteItem({ ...item, labelEn: '' }), { problem: 'LABEL_REQUIRED' });
});
