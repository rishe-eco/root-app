import test from 'node:test';
import assert from 'node:assert/strict';
import { articleStateSince } from './draftNotes.js';
import type { ArticleSnapshot, ContractSnapshot } from './revision.js';

/**
 * Journeys build plan J6 — the plan's trap as a table: a note is anchored to
 * `(revision, article number)`, numbers shift when an article is inserted, and
 * "the same article now" is found by title and number and never guessed.
 */

const article = (number: number, title: string, body = `Body of ${title}`): ArticleSnapshot => ({
  number,
  titleFa: `فا ${title}`,
  titleEn: title,
  bodyFa: `متن ${title}`,
  bodyEn: body,
});

const snapshot = (...articles: ArticleSnapshot[]): ContractSnapshot => ({
  format: 1,
  ref: 'RC-TEST',
  titleFa: 'ت',
  titleEn: 'T',
  amount: null,
  articles,
  scopeItems: [],
});

const v1 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Timeline'), article(4, 'Fees'));

test('the same article at the same number, untouched: not changed, not gone', () => {
  assert.deepEqual(articleStateSince(v1, 3, v1), { gone: false, changed: false, currentNumber: 3 });
  // A rebuilt-but-equal snapshot too — "unchanged" is `diffSnapshots`' own answer, not identity.
  assert.deepEqual(articleStateSince(v1, 3, structuredClone(v1)), { gone: false, changed: false, currentNumber: 3 });
});

test('the article’s text edited: changed, still article 3', () => {
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Timeline', 'A different timeline'), article(4, 'Fees'));
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: false, changed: true, currentNumber: 3 });
  // ...and its neighbours are unaffected.
  assert.deepEqual(articleStateSince(v1, 2, v2), { gone: false, changed: false, currentNumber: 2 });
});

test('an article inserted before it: the note’s article is now number 4 — moved, and NOT changed', () => {
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Definitions'), article(4, 'Timeline'), article(5, 'Fees'));
  // Read by number this would be article 3 — a different article, "Definitions". By title it is 4.
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: false, changed: false, currentNumber: 4 });
  assert.deepEqual(articleStateSince(v1, 4, v2), { gone: false, changed: false, currentNumber: 5 });
});

test('moved and edited: both are said', () => {
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Definitions'), article(4, 'Timeline', 'Rewritten'), article(5, 'Fees'));
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: false, changed: true, currentNumber: 4 });
});

test('an article that was removed is gone — never re-pointed at whatever took its number', () => {
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Fees'));
  // Article 4 "Fees" moved to 3, so its note follows; article 3 "Timeline" left, and article 3 is now something else.
  assert.deepEqual(articleStateSince(v1, 4, v2), { gone: false, changed: false, currentNumber: 3 });
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: true, changed: false, currentNumber: null });
});

test('an article renamed in both languages keeps its number and is gone: a different article until someone says otherwise', () => {
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Schedule'), article(4, 'Fees'));
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: true, changed: false, currentNumber: null });
});

test('a title fixed in one language only is still the same article — and that is a change', () => {
  const fixed: ArticleSnapshot = { ...article(3, 'Timeline'), titleFa: 'زمان‌بندی' };
  const v2 = snapshot(article(1, 'Parties'), article(2, 'Scope'), fixed, article(4, 'Fees'));
  assert.deepEqual(articleStateSince(v1, 3, v2), { gone: false, changed: true, currentNumber: 3 });
});

test('two candidates by title: the one at the note’s number wins; otherwise nothing is guessed', () => {
  const twin = snapshot(article(1, 'Parties'), article(2, 'Scope'), article(3, 'Timeline'), article(4, 'Timeline'));
  assert.deepEqual(articleStateSince(v1, 3, twin), { gone: false, changed: false, currentNumber: 3 });
  const away = snapshot(article(1, 'Parties'), article(5, 'Timeline'), article(6, 'Timeline'));
  assert.deepEqual(articleStateSince(v1, 3, away), { gone: true, changed: false, currentNumber: null });
});

test('an unreadable side names nothing: an unsealed revision, no current revision, or a number the revision never had', () => {
  assert.equal(articleStateSince(null, 3, v1).gone, true);
  assert.equal(articleStateSince(v1, 3, null).gone, true);
  assert.equal(articleStateSince(v1, 9, v1).gone, true);
});
