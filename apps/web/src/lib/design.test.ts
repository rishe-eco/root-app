import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECIMEN_LATIN,
  SPECIMEN_PERSIAN,
  chosenConcept,
  currentRevisionId,
  fontFamilyFor,
  isExhausted,
  paletteByKind,
  pathOfContract,
  readableOn,
  roundCounter,
  specimenLines,
  themesFor,
} from './design.js';
import type { DesignConcept, DesignPaletteItem, Theme } from './queries';

/** Journeys build plan J8 — the design panels' pure helpers. */

const PERSIAN_LETTER = /[؀-ۿ]/;

test('a type specimen always renders Persian text, first, right-to-left — and Latin beside it (the Latin-only font trap)', () => {
  const lines = specimenLines();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.lang), ['fa', 'en']);
  assert.equal(lines[0].dir, 'rtl');
  assert.ok(PERSIAN_LETTER.test(lines[0].text), 'the first line has Persian letters');
  assert.ok(PERSIAN_LETTER.test(SPECIMEN_PERSIAN) && !/[A-Za-z]/.test(SPECIMEN_PERSIAN), 'and only Persian ones');
  assert.ok(/[A-Za-z]/.test(SPECIMEN_LATIN) && !PERSIAN_LETTER.test(SPECIMEN_LATIN));
  // The Persian line exercises what a Latin font most often lacks: the joining forms and the Persian digits.
  assert.ok(/[۰-۹]/.test(SPECIMEN_PERSIAN));
  assert.ok(SPECIMEN_PERSIAN.includes('‌'), 'and a zero-width non-joiner');
});

test('a font stack ends in a generic family, never in Root’s own Persian face — a fallback would hide the very glyphs the specimen is for', () => {
  assert.equal(fontFamilyFor('Vazirmatn'), '"Vazirmatn", sans-serif');
  assert.equal(fontFamilyFor('IBM Plex Sans'), '"IBM Plex Sans", sans-serif');
  assert.ok(!fontFamilyFor('Anything').toLowerCase().includes('vazir'));
  // Whatever arrives, it cannot close the quotes.
  assert.equal(fontFamilyFor('A"; color: red; "'), '"A; color: red; ", sans-serif');
  assert.equal(fontFamilyFor('A\\B'), '"AB", sans-serif');
});

test('a swatch’s label colour is chosen for the swatch', () => {
  assert.equal(readableOn('#ffffff'), '#000000');
  assert.equal(readableOn('#000000'), '#ffffff');
  assert.equal(readableOn('#1f3a5c'), '#ffffff');
  assert.equal(readableOn('#f5d000'), '#000000');
  assert.equal(readableOn('not a colour'), '#000000');
});

const item = (kind: DesignPaletteItem['kind'], role: string): DesignPaletteItem => ({
  id: role,
  kind,
  role,
  value: 'v',
  labelFa: 'ف',
  labelEn: 'L',
  imageUrl: null,
});

test('the palette groups by kind and keeps its order', () => {
  const grouped = paletteByKind([item('COLOR', 'a'), item('FONT', 'h'), item('COLOR', 'b'), item('LOGO_USAGE', 'l')]);
  assert.deepEqual(grouped.COLOR.map((x) => x.role), ['a', 'b']);
  assert.deepEqual(grouped.FONT.map((x) => x.role), ['h']);
  assert.deepEqual(grouped.LOGO_USAGE.map((x) => x.role), ['l']);
  assert.deepEqual(paletteByKind([]), { COLOR: [], FONT: [], LOGO_USAGE: [] });
});

test('the path is the brief’s tier through designPath: the pre-made tier and the two custom ones', () => {
  const of = (designTier: 'THEME_PICK' | 'CLAUDE_ASSISTED' | 'SENIOR_DESIGNER') => pathOfContract({ brief: { designTier } as never });
  assert.equal(of('THEME_PICK'), 'PREMADE');
  assert.equal(of('CLAUDE_ASSISTED'), 'CUSTOM');
  assert.equal(of('SENIOR_DESIGNER'), 'CUSTOM');
  assert.equal(pathOfContract({ brief: null }), null);
  assert.equal(pathOfContract({}), null);
});

const theme = (id: string, over: Partial<Theme> = {}): Theme => ({
  id,
  name: id,
  vendor: null,
  demoUrl: null,
  previewUrl: null,
  rtlSupport: 'UNKNOWN',
  licenseCost: null,
  notesFa: null,
  notesEn: null,
  active: true,
  typeIds: ['store'],
  ...over,
});

test('the designer’s list is the catalogue filtered by the brief’s type, active themes only — the rule proposeThemes applies', () => {
  const all = [theme('a'), theme('b', { active: false }), theme('c', { typeIds: ['blog'] }), theme('d', { typeIds: ['store', 'blog'] })];
  assert.deepEqual(themesFor(all, 'store').map((t) => t.id), ['a', 'd']);
  assert.deepEqual(themesFor(all, 'blog').map((t) => t.id), ['c', 'd']);
  assert.deepEqual(themesFor(all, null), []);
  assert.deepEqual(themesFor([], 'store'), []);
});

test('rounds: used of allowed, and exhausted exactly when the next publish would be refused', () => {
  assert.deepEqual(roundCounter({ iterationsUsed: 2, allowance: 3 }), { used: 2, total: 3 });
  assert.deepEqual(roundCounter({ iterationsUsed: null, allowance: null }), { used: 0, total: null });
  assert.equal(isExhausted({ used: 2, total: 3 }), false);
  assert.equal(isExhausted({ used: 3, total: 3 }), true);
  assert.equal(isExhausted({ used: 5, total: 3 }), true);
  assert.equal(isExhausted({ used: 9, total: null }), false, 'no limit set: never exhausted');
});

test('the current revision is the newest published one, not the draft', () => {
  const rev = (id: string, version: number, published: boolean) => ({ id, version, publishedAt: published ? '2026-01-01' : null }) as never;
  assert.equal(currentRevisionId({ designRevisions: [rev('d3', 3, false), rev('r2', 2, true), rev('r1', 1, true)] }), 'r2');
  assert.equal(currentRevisionId({ designRevisions: [rev('d1', 1, false)] }), null);
  assert.equal(currentRevisionId({ designRevisions: [] }), null);
});

test('the chosen concept', () => {
  const c = (id: string, chosen: boolean) => ({ id, chosen }) as DesignConcept;
  assert.equal(chosenConcept([c('a', false), c('b', true)])?.id, 'b');
  assert.equal(chosenConcept([c('a', false)]), null);
});
