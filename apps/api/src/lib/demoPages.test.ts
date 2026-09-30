import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_MAPPING_PATH_LENGTH,
  UNMAPPED_PATH,
  bundlePagePaths,
  isMapped,
  mappedPages,
  matchDemoPath,
  mockupMappingPath,
  normalizePath,
} from './demoPages.js';

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
// { stripHtml: true } — build plan J9, MOCKUP demos only. Every case above
// this point is unaffected by the option's existence: the option is opt-in
// and every call above passes no third argument at all, which is exactly
// what "without changing a single existing call site's behaviour" requires
// — the two tests directly below assert that in the negative, explicitly.
// ---------------------------------------------------------------------------

test('without the option, ".html" and "/index.html" normalize exactly as before', () => {
  assert.equal(normalizePath('/about.html'), '/about.html');
  assert.equal(normalizePath('/index.html'), '/index.html');
  assert.equal(normalizePath('/products/index.html'), '/products/index.html');
});

test('with the option, a trailing "/index.html" folds to the directory', () => {
  assert.equal(normalizePath('/index.html', undefined, { stripHtml: true }), '/');
  assert.equal(normalizePath('/products/index.html', undefined, { stripHtml: true }), '/products');
});

test('with the option, a trailing ".html" folds to the extensionless path', () => {
  assert.equal(normalizePath('/about.html', undefined, { stripHtml: true }), '/about');
  assert.equal(
    normalizePath('/fa/products/list.html', undefined, { stripHtml: true }),
    '/products/list',
  );
});

test('with the option, a path with no ".html" at all is untouched', () => {
  assert.equal(normalizePath('/products', undefined, { stripHtml: true }), '/products');
  assert.equal(normalizePath('/', undefined, { stripHtml: true }), '/');
});

test('with the option, only a trailing ".html" is folded — one elsewhere in the path is left alone', () => {
  assert.equal(
    normalizePath('/archive/2024.html/amendment', undefined, { stripHtml: true }),
    '/archive/2024.html/amendment',
  );
});

test('the option composes with matchDemoPath, e.g. a declared "/about" matches a reported "/about.html"', () => {
  const mockupPages = [{ id: 'p1', canonicalPath: '/about' }];
  // The pieces `matchDemoPath` combines when handed the option (J9a: it now
  // takes one, and `reportDemoPath` passes it for MOCKUP demos only) agree once
  // both sides are normalized with it.
  assert.equal(
    normalizePath('/about.html', undefined, { stripHtml: true }),
    normalizePath(mockupPages[0].canonicalPath, undefined, { stripHtml: true }),
  );
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

test('matchDemoPath with { stripHtml } folds .html on both sides — a mapped "/about" or "/about.html" matches a reported "/about.html", "/about" or "/about/index.html"', () => {
  for (const declared of ['/about', '/about.html', '/about/index.html']) {
    for (const reported of ['/about.html', '/about', '/about/', '/about/index.html', '/fa/about.html']) {
      assert.deepEqual(
        matchDemoPath(reported, [{ id: 'p', canonicalPath: declared }], { stripHtml: true }),
        { kind: 'MATCHED', pageId: 'p', normalizedPath: '/about' },
        `${declared} vs ${reported}`,
      );
    }
  }
});

test('matchDemoPath without the option is untouched by it: "/about.html" and "/about" stay two pages (a SITE demo\'s own server decides)', () => {
  const pages = [{ id: 'p', canonicalPath: '/about' }];
  assert.equal(matchDemoPath('/about.html', pages).kind, 'UNMATCHED');
  assert.equal(matchDemoPath('/about', pages).kind, 'MATCHED');
  assert.equal(matchDemoPath('/about.html', pages, { stripHtml: false }).kind, 'UNMATCHED');
});

// ---------------------------------------------------------------------------
// A mockup's page mapping (journeys build plan J9b)
// ---------------------------------------------------------------------------

test('mockupMappingPath: every spelling of a page folds to one stored path', () => {
  for (const typed of ['about.html', '/about.html', '/about/', '/about', ' /About.HTML ', '/fa/about.html', '/about?x=1#y']) {
    assert.equal(mockupMappingPath(typed), '/about', typed);
  }
  assert.equal(mockupMappingPath('index.html'), '/');
  assert.equal(mockupMappingPath('/'), '/');
  assert.equal(mockupMappingPath('/shop/index.html'), '/shop');
  assert.equal(mockupMappingPath('/shop/cart.html'), '/shop/cart');
});

test('mockupMappingPath: blank unmaps; a path no bundle could hold is null', () => {
  assert.equal(mockupMappingPath(''), UNMAPPED_PATH);
  assert.equal(mockupMappingPath('   '), UNMAPPED_PATH);
  assert.equal(mockupMappingPath('/a\u0000b'), null);
  assert.equal(mockupMappingPath('/a\\b'), null);
  assert.equal(mockupMappingPath('/' + 'x'.repeat(MAX_MAPPING_PATH_LENGTH)), null);
  assert.equal(mockupMappingPath('/' + 'x'.repeat(MAX_MAPPING_PATH_LENGTH - 1)), '/' + 'x'.repeat(MAX_MAPPING_PATH_LENGTH - 1));
});

test('an unmapped page is not a page a report can match — left in, its empty path would claim the home page', () => {
  const pages = [
    { id: 'home', canonicalPath: '/' },
    { id: 'todo', canonicalPath: UNMAPPED_PATH },
  ];
  // The trap this guards: '' normalizes to '/', the same as the home page.
  assert.equal(normalizePath(UNMAPPED_PATH), '/');
  assert.deepEqual(pages.filter(isMapped).map((p) => p.id), ['home']);
  assert.deepEqual(mappedPages(pages).map((p) => p.id), ['home']);
  const onlyUnmapped = [{ id: 'todo', canonicalPath: UNMAPPED_PATH }];
  assert.equal(matchDemoPath('/', mappedPages(onlyUnmapped), { stripHtml: true }).kind, 'UNMATCHED');
});

test('bundlePagePaths: each HTML entry folds the way a mapping does; assets are not pages', () => {
  const paths = bundlePagePaths(['index.html', 'about.html', 'shop/index.html', 'shop/cart.html', 'css/app.css', 'img/logo.png', 'js/app.js']);
  assert.deepEqual([...paths].sort(), ['/', '/about', '/shop', '/shop/cart']);
});

test('bundlePagePaths: about.html and about/index.html are one page; case folds; a mapping finds what it was typed against', () => {
  assert.deepEqual([...bundlePagePaths(['about.html', 'about/index.html'])], ['/about']);
  assert.deepEqual([...bundlePagePaths(['About.HTML'])], ['/about']);
  const paths = bundlePagePaths(['index.html', 'about.html']);
  for (const typed of ['about.html', '/about/', '/']) assert.ok(paths.has(mockupMappingPath(typed)!), typed);
  assert.ok(!paths.has(mockupMappingPath('/contact')!));
});
