import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchDemoPath, normalizePath } from './demoPages.js';

// ---------------------------------------------------------------------------
// L2.1's own five shapes for "the products page," plus the percent-encoded
// Persian slug — the exact cases the plan names as ambiguous, made explicit.
// ---------------------------------------------------------------------------

test('a bare path normalizes to itself', () => {
  assert.equal(normalizePath('/products'), '/products');
});

test('a trailing slash folds to the same page', () => {
  assert.equal(normalizePath('/products/'), normalizePath('/products'));
});

test('a query string is dropped, not part of the page identity', () => {
  assert.equal(normalizePath('/products?sort=price'), '/products');
});

test('a hash fragment is dropped', () => {
  assert.equal(normalizePath('/products#reviews'), '/products');
});

test('a recognized locale prefix folds to the same page as the unprefixed path', () => {
  assert.equal(normalizePath('/fa/products'), '/products');
  assert.equal(normalizePath('/en/products'), '/products');
});

test('an unrecognized leading segment is not stripped as a locale', () => {
  // "shop" is not a locale — this must stay a distinct page from "/products",
  // or every two-segment path beginning with something locale-shaped would
  // silently collapse.
  assert.notEqual(normalizePath('/shop/products'), normalizePath('/products'));
});

test('a pagination segment is left alone — genuinely undetermined, not collapsed', () => {
  assert.notEqual(normalizePath('/products/page/2'), normalizePath('/products'));
  // and it normalizes stably on repeat, which is what a declared DemoPage for
  // it would be compared against
  assert.equal(normalizePath('/products/page/2'), normalizePath('/products/page/2/'));
});

test('a percent-encoded Persian slug matches the same slug typed directly', () => {
  const typed = '/محصولات';
  const encoded = '/' + encodeURIComponent('محصولات');
  assert.equal(normalizePath(encoded), normalizePath(typed));
});

test('Arabic and Persian orthographic variants in a slug fold together', () => {
  // "کتابی" (book-ish), once spelled with Arabic kaf ك (U+0643) and yeh ي
  // (U+064A), once with their Persian counterparts ک (U+06A9) and ی
  // (U+06CC) — a real CMS or a customer's own keyboard can produce either,
  // and foldPersian (R1's fold, reused rather than reimplemented) is what
  // makes them compare equal.
  const arabicSpelling = '/كتابي';
  const persianSpelling = '/کتابی';
  assert.equal(normalizePath(arabicSpelling), normalizePath(persianSpelling));
});

test('a full URL (not just a path) normalizes the same as its path', () => {
  assert.equal(normalizePath('https://nahal.example.com/products?x=1'), '/products');
});

test('the root path normalizes to "/"', () => {
  assert.equal(normalizePath('/'), '/');
  assert.equal(normalizePath(''), '/');
  assert.equal(normalizePath('/fa'), '/');
  assert.equal(normalizePath('/fa/'), '/');
});

test('repeated slashes collapse', () => {
  assert.equal(normalizePath('//products//page//'), '/products/page');
});

test('malformed percent-encoding does not throw', () => {
  assert.doesNotThrow(() => normalizePath('/100%'));
});

test('normalizePath never throws on garbage input', () => {
  for (const input of ['', ' ', '::not a url::', '/\uD800', 'javascript:alert(1)']) {
    assert.doesNotThrow(() => normalizePath(input));
  }
});

test('a custom locale list is honoured instead of the default', () => {
  assert.equal(normalizePath('/de/products', ['de']), '/products');
  // "fa" is no longer treated as a locale under a custom list
  assert.equal(normalizePath('/fa/products', ['de']), '/fa/products');
});

// ---------------------------------------------------------------------------
// matchDemoPath — the resolver's one dependency
// ---------------------------------------------------------------------------

const pages = [
  { id: 'p1', canonicalPath: '/' },
  { id: 'p2', canonicalPath: '/products' },
  { id: 'p3', canonicalPath: '/about' },
];

test('matchDemoPath finds a declared page regardless of the raw shape reported', () => {
  const result = matchDemoPath('/fa/products?sort=price', pages);
  assert.deepEqual(result, { kind: 'MATCHED', pageId: 'p2', normalizedPath: '/products' });
});

test('matchDemoPath reports UNMATCHED for a path nothing declares', () => {
  const result = matchDemoPath('/checkout', pages);
  assert.equal(result.kind, 'UNMATCHED');
  assert.equal(result.normalizedPath, '/checkout');
});

test('matchDemoPath matches the root page declared as "/"', () => {
  assert.deepEqual(matchDemoPath('/', pages), { kind: 'MATCHED', pageId: 'p1', normalizedPath: '/' });
  assert.deepEqual(matchDemoPath('/fa/', pages), { kind: 'MATCHED', pageId: 'p1', normalizedPath: '/' });
});

test('matchDemoPath treats an undeclared pagination path as unmatched, not a fuzzy hit on the base page', () => {
  const result = matchDemoPath('/products/page/2', pages);
  assert.equal(result.kind, 'UNMATCHED');
});

test('matchDemoPath with no declared pages always reports unmatched', () => {
  assert.equal(matchDemoPath('/anything', []).kind, 'UNMATCHED');
});
