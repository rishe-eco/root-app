import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirFor, formatCitation, moneyReadout, translationLangFor } from './format.js';

test('translationLangFor: a Persian original is translated outward, not into Persian again', () => {
  // The regression this exists for: the reader hardcoded the translation
  // column to lang="fa" dir="rtl", which is right for the common case (an
  // English paper brought into Persian) and sets ROOT_RESEARCH's *English*
  // translation in Vazirmatn, right-to-left. The only entry the e2e covers
  // has originalLang "en", which is exactly the case the hardcode got right.
  assert.equal(translationLangFor('fa'), 'en');
  assert.equal(translationLangFor('fa-IR'), 'en');
  assert.equal(translationLangFor('FA'), 'en');
});

test('translationLangFor: anything else is translated into Persian', () => {
  assert.equal(translationLangFor('en'), 'fa');
  assert.equal(translationLangFor('de'), 'fa');
  assert.equal(translationLangFor('en-US'), 'fa');
});

test('translationLangFor: the result is never the language it came from', () => {
  for (const lang of ['fa', 'en', 'de', 'ar', 'fa-IR', 'en-GB']) {
    assert.notEqual(translationLangFor(lang), lang.split('-')[0].toLowerCase());
  }
});

test('dirFor: fa/ar/he are rtl, en/de are ltr, an unknown tag defaults to ltr', () => {
  assert.equal(dirFor('fa'), 'rtl');
  assert.equal(dirFor('ar'), 'rtl');
  assert.equal(dirFor('he'), 'rtl');
  assert.equal(dirFor('en'), 'ltr');
  assert.equal(dirFor('de'), 'ltr');
  assert.equal(dirFor('xx'), 'ltr');
});

test('dirFor: a region subtag does not change the answer', () => {
  assert.equal(dirFor('fa-IR'), 'rtl');
  assert.equal(dirFor('en-US'), 'ltr');
  assert.equal(dirFor('AR'), 'rtl');
});

test('formatCitation (bibtex): a Persian-authored entry with no DOI cites what it has, in its own script', () => {
  const bibtex = formatCitation(
    {
      authors: 'کیانی، ر.',
      titleOriginal: 'یادگیری ماشین',
      venue: 'مجله علمی',
      year: 2019,
      doi: null,
      sourceUrl: 'https://example.com/paper',
    },
    'bibtex',
  );
  assert.match(bibtex, /^@article\{/);
  assert.ok(bibtex.includes('author = {کیانی، ر.}'));
  assert.ok(bibtex.includes('title = {یادگیری ماشین}'));
  assert.ok(bibtex.includes('year = {2019}'));
  // No DOI: falls back to the source URL, and does not print an empty doi field.
  assert.ok(bibtex.includes('url = {https://example.com/paper}'));
  assert.ok(!bibtex.includes('doi ='));
});

test('formatCitation (apa): a full English entry with a DOI links through doi.org, not sourceUrl', () => {
  const apa = formatCitation(
    {
      authors: 'A. Author, B. Other',
      titleOriginal: 'A Paper Worth Reading',
      venue: 'Journal of Examples',
      year: 2021,
      doi: '10.1234/example',
      sourceUrl: 'https://example.com/ignored',
    },
    'apa',
  );
  assert.equal(
    apa,
    'A. Author, B. Other (2021). A Paper Worth Reading. Journal of Examples. https://doi.org/10.1234/example',
  );
});

test('formatCitation: a missing year reads "n.d.", not a blank', () => {
  const apa = formatCitation(
    { authors: 'A. Author', titleOriginal: 'Untitled', venue: null, year: null, doi: null, sourceUrl: null },
    'apa',
  );
  assert.equal(apa, 'A. Author (n.d.). Untitled.');
});

test('moneyReadout groups thousands in the panel’s own digits, keeps every digit of a big sum, and reads nothing from nothing', () => {
  assert.equal(moneyReadout('150000000', 'en'), '150,000,000');
  assert.equal(moneyReadout('150000000', 'fa'), '۱۵۰٬۰۰۰٬۰۰۰');
  assert.equal(moneyReadout('۱۵۰۰۰۰۰۰۰', 'en'), '150,000,000', 'Persian digits typed are read');
  assert.equal(moneyReadout('1 234,5', 'en'), '12,345', 'separators typed are ignored');
  assert.equal(moneyReadout('9007199254740993', 'en'), '9,007,199,254,740,993', 'no Number rounding');
  assert.equal(moneyReadout('', 'fa'), null);
  assert.equal(moneyReadout(null, 'en'), null);
  assert.equal(moneyReadout('abc', 'en'), null);
  assert.equal(moneyReadout('0', 'en'), '0');
});
