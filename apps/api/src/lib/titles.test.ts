import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillPairs, hasOneTitle, inLocale, requireOneTitle } from './titles.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { extensions?: { code?: string } }).extensions?.code;
  }
  return undefined;
};

test('requireOneTitle: one language is enough, both blank is refused, the pair comes back trimmed', () => {
  assert.deepEqual(requireOneTitle('  عنوان ', ''), { fa: 'عنوان', en: '' });
  assert.deepEqual(requireOneTitle('', ' Title '), { fa: '', en: 'Title' });
  assert.deepEqual(requireOneTitle('الف', 'A'), { fa: 'الف', en: 'A' });
  assert.equal(code(() => requireOneTitle('', '')), 'TITLE_REQUIRED');
  assert.equal(code(() => requireOneTitle('  ', '\n')), 'TITLE_REQUIRED');
  assert.equal(code(() => requireOneTitle(undefined, null)), 'TITLE_REQUIRED');
});

test('requireOneTitle: keeps the code a mutation already refused with', () => {
  assert.equal(code(() => requireOneTitle('', '', 'LABEL_REQUIRED')), 'LABEL_REQUIRED');
});

test('hasOneTitle', () => {
  assert.equal(hasOneTitle('', ''), false);
  assert.equal(hasOneTitle(' ', 'x'), true);
});

test('inLocale: the reader’s language, else the other one, plainly', () => {
  const both = { titleFa: 'فا', titleEn: 'En' };
  assert.equal(inLocale(both, 'title', 'fa'), 'فا');
  assert.equal(inLocale(both, 'title', 'en'), 'En');
  const faOnly = { titleFa: 'فا', titleEn: '' };
  assert.equal(inLocale(faOnly, 'title', 'en'), 'فا');
  const enOnly = { labelFa: ' ', labelEn: 'En' };
  assert.equal(inLocale(enOnly, 'label', 'fa'), 'En');
  assert.equal(inLocale({ titleFa: '', titleEn: '' }, 'title', 'en'), '');
});

test('fillPairs: a blank side of any xFa/xEn pair is filled from the other; other keys are untouched', () => {
  const out = fillPairs({ projectTitleFa: 'پروژه', projectTitleEn: '', customerName: 'x', step: 'DRAFT' });
  assert.deepEqual(out, { projectTitleFa: 'پروژه', projectTitleEn: 'پروژه', customerName: 'x', step: 'DRAFT' });
  const other = fillPairs({ projectTitleFa: '', projectTitleEn: 'Shop' });
  assert.equal(other.projectTitleFa, 'Shop');
});
