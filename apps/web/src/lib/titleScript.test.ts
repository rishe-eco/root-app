import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectScript, hasOneTitle, splitByScript } from './titleScript.js';
import { pick } from './format.js';

test('detectScript: any Persian or Arabic letter makes the text Persian, otherwise English', () => {
  assert.equal(detectScript('قرارداد سایت', 'en'), 'fa');
  assert.equal(detectScript('Website contract', 'fa'), 'en');
  assert.equal(detectScript('كتاب', 'en'), 'fa', 'Arabic letters count');
});

test('detectScript: mixed text is Persian when it holds a Persian letter, wherever it sits', () => {
  assert.equal(detectScript('Phase ۱ فاز', 'en'), 'fa');
  assert.equal(detectScript('سایت WordPress', 'en'), 'fa');
  assert.equal(detectScript('Phase فاز 2', 'en'), 'fa');
});

test('detectScript: no letters says nothing about the language, so the panel’s language decides', () => {
  assert.equal(detectScript('2026', 'fa'), 'fa');
  assert.equal(detectScript('2026', 'en'), 'en');
  assert.equal(detectScript('۱۴۰۵', 'en'), 'en', 'Persian digits are digits, not letters');
  assert.equal(detectScript('', 'fa'), 'fa');
  assert.equal(detectScript('- / 12', 'en'), 'en');
});

test('splitByScript: the text goes in its language’s column, the other is empty', () => {
  assert.deepEqual(splitByScript('عنوان', 'en'), { fa: 'عنوان', en: '' });
  assert.deepEqual(splitByScript('Title', 'fa'), { fa: '', en: 'Title' });
  assert.deepEqual(splitByScript('42', 'fa'), { fa: '42', en: '' });
});

test('hasOneTitle', () => {
  assert.equal(hasOneTitle('', '  '), false);
  assert.equal(hasOneTitle('', 'x'), true);
});

test('pick (DX4): the reader’s language, else the other one, plainly', () => {
  const faOnly = { titleFa: 'فاز اول', titleEn: '' };
  assert.equal(pick(faOnly, 'title', 'fa'), 'فاز اول');
  assert.equal(pick(faOnly, 'title', 'en'), 'فاز اول', 'falls back to the Persian title');
  const enOnly = { labelFa: '  ', labelEn: 'Home page' };
  assert.equal(pick(enOnly, 'label', 'fa'), 'Home page');
  assert.equal(pick({ titleFa: 'a', titleEn: 'b' }, 'title', 'en'), 'b');
  assert.equal(pick({ titleFa: '', titleEn: '' }, 'title', 'en'), '');
  assert.equal(pick({}, 'title', 'fa'), '');
});
