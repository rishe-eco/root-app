import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirFor, formatCitation } from './format.js';

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
