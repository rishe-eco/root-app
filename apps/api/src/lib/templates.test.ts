import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARTICLES,
  CHECKLIST,
  PAGES,
  PLACEHOLDER_SCOPE,
  ROOT_PARTY,
  SCOPE,
  TEMPLATE_KINDS,
  TEMPLATE_TYPES,
  isTemplateSensitiveArticle,
  partiesFor,
  renderArticleBody,
  scopeKindForKey,
} from './templates.js';
import { KEY_PATTERN, SLUG_PATTERN, checkSlug, checkTemplateScope } from './templateScope.js';

/** Sources read as text, the way `changeAction.test.ts` does: nothing else
 *  can see the migration or the SDL from here. */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('scopeKindForKey: checklist rows are EXTRA, page keys are PAGE, the rest FEATURE', () => {
  assert.equal(scopeKindForKey('checklist.auth'), 'EXTRA');
  assert.equal(scopeKindForKey('checklist.publicPages'), 'EXTRA');
  assert.equal(scopeKindForKey('home'), 'PAGE');
  assert.equal(scopeKindForKey('about'), 'PAGE');
  assert.equal(scopeKindForKey('bilingual'), 'FEATURE');
  assert.equal(scopeKindForKey('sms-auth'), 'FEATURE');
  // A prefix is not the namespace: only `checklist.` itself is.
  assert.equal(scopeKindForKey('checklistish'), 'FEATURE');
});

test('every checklist key is EXTRA and every PAGES key is a PAGE — the migration rule, on the real lists', () => {
  for (const [key] of CHECKLIST) assert.equal(scopeKindForKey(key), 'EXTRA', key);
  for (const [key] of PAGES) assert.equal(scopeKindForKey(key), 'PAGE', key);
  // SCOPE shares three keys with PAGES (about, contracts, portal) — those
  // template rows are pages, and the rest are features.
  assert.deepEqual(
    SCOPE.map(([key]) => [key, scopeKindForKey(key)]),
    [
      ['bilingual', 'FEATURE'],
      ['landing', 'FEATURE'],
      ['about', 'PAGE'],
      ['portal', 'PAGE'],
      ['contracts', 'PAGE'],
      ['tracking', 'FEATURE'],
    ],
  );
});

test('the migration backfill states the same rule: its page list is PAGES, its namespace is checklist.', () => {
  const sql = read('../../prisma/migrations/20260929130000_t1_templates/migration.sql');
  const block = sql.slice(sql.indexOf('-- BACKFILL:BEGIN'), sql.indexOf('-- BACKFILL:END'));
  assert.ok(block.length > 0, 'the backfill markers are missing');

  const listed = /"key" IN \(([^)]*)\)/.exec(block);
  assert.ok(listed, 'the migration has no page list');
  const inSql = [...listed[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(inSql, PAGES.map(([key]) => key), 'migration page list and PAGES have drifted');

  assert.match(block, /"key" LIKE 'checklist\.%'/);
});

test('D-5: the template names no one — its only placeholders are {{client}} and {{provider}}, and no stranger’s name is left in it', () => {
  const bodies = ARTICLES.flatMap(([, , , bodyFa, bodyEn]) => [bodyFa, bodyEn]).filter((b): b is string => typeof b === 'string');
  assert.ok(bodies.length >= 4);
  for (const body of bodies) {
    for (const [, name] of body.matchAll(/\{\{(\w*)\}\}/g)) {
      assert.ok(name === 'client' || name === 'provider', `unknown placeholder {{${name}}}`);
    }
    assert.ok(!/Nahal|نهال/.test(body), `a body still names a customer: ${body.slice(0, 60)}`);
  }
  // Article 1 names both parties, so it uses both placeholders in both languages.
  const [, , , bodyFa, bodyEn] = ARTICLES[0];
  for (const body of [bodyFa!, bodyEn!]) assert.ok(body.includes('{{client}}') && body.includes('{{provider}}'));
  // J4 matches the money articles by number and title, so neither may have moved.
  assert.deepEqual(ARTICLES.map(([n, , titleEn]) => [n, titleEn]).slice(3, 5), [
    [4, 'Fees'],
    [5, 'Payment Schedule'],
  ]);
});

test('renderArticleBody: fills both placeholders, per language, and renders nothing it does not know', () => {
  const customer = { clientName: 'Acme Studio', name: 'Ann' };
  const en = partiesFor(customer, 'en');
  const fa = partiesFor(customer, 'fa');
  assert.deepEqual(en, { client: 'Acme Studio', provider: 'Root' });
  assert.deepEqual(fa, { client: 'Acme Studio', provider: 'ریشه' });
  assert.equal(ROOT_PARTY.fa, 'ریشه');
  assert.equal(
    renderArticleBody('Between {{client}} and {{provider}}; {{client}} again.', en),
    'Between Acme Studio and Root; Acme Studio again.',
  );
  assert.equal(renderArticleBody('میان {{client}} و {{provider}}', fa), 'میان Acme Studio و ریشه');
  // A typo'd placeholder stays visible rather than vanishing.
  assert.equal(renderArticleBody('{{clinet}} {{client}}', en), '{{clinet}} Acme Studio');
  assert.equal(renderArticleBody(undefined, en), null);
  assert.equal(renderArticleBody(null, en), null);
  assert.equal(renderArticleBody('', en), '');
  // A customer with no company name falls back to their own; a padded one is trimmed.
  assert.equal(partiesFor({ clientName: null, name: 'Ann' }, 'en').client, 'Ann');
  assert.equal(partiesFor({ clientName: '   ', name: 'Ann' }, 'en').client, 'Ann');
  assert.equal(partiesFor({ clientName: '  Acme  ', name: 'Ann' }, 'en').client, 'Acme');
  // No leftover placeholder in any rendered article.
  for (const [, , , bodyFa, bodyEn] of ARTICLES) {
    assert.ok(!/\{\{/.test(renderArticleBody(bodyFa, fa) ?? ''));
    assert.ok(!/\{\{/.test(renderArticleBody(bodyEn, en) ?? ''));
  }
});

test('isTemplateSensitiveArticle: Fees and Payment Schedule, by number and title together (PD-14, J4)', () => {
  const sensitive = ARTICLES.filter(([number, , titleEn]) => isTemplateSensitiveArticle(number, titleEn)).map(([number, , titleEn]) => [number, titleEn]);
  assert.deepEqual(sensitive, [
    [4, 'Fees'],
    [5, 'Payment Schedule'],
  ]);
  // A hand-numbered contract's unrelated article 4, and a renamed money article, are not the template's.
  assert.equal(isTemplateSensitiveArticle(4, 'Warranties'), false);
  assert.equal(isTemplateSensitiveArticle(9, 'Fees'), false);
});

test('the J4 migration flags exactly the template’s money articles — the same pair, by number and title', () => {
  const sql = read('../../prisma/migrations/20260930100000_j4_brief_plan_phases/migration.sql');
  const block = sql.slice(sql.indexOf('-- BACKFILL:BEGIN'), sql.indexOf('-- BACKFILL:END'));
  assert.ok(block.length > 0, 'the backfill markers are missing');
  const pairs = [...block.matchAll(/"number" = (\d+) AND "titleEn" = '([^']*)'/g)].map((m) => [Number(m[1]), m[2]]);
  const template = ARTICLES.filter(([number, , titleEn]) => isTemplateSensitiveArticle(number, titleEn)).map(([number, , titleEn]) => [number, titleEn]);
  assert.deepEqual(pairs, template, 'the migration and the template have drifted');
});

test('the SDL, the schema and the template kinds agree on ScopeKind', () => {
  const values = (source: string) => {
    const m = /enum ScopeKind \{([^}]*)\}/.exec(source);
    assert.ok(m, 'no ScopeKind enum');
    return m[1].split(/\s+/).filter(Boolean);
  };
  const inSchema = values(read('../../prisma/schema.prisma'));
  assert.deepEqual(values(read('../graphql/typeDefs.ts')), inSchema);
  // A template holds everything but the checklist's kind.
  assert.deepEqual([...TEMPLATE_KINDS], inSchema.filter((k) => k !== 'EXTRA'));
});

test('the seed: five types, Latin slugs, placeholder scope that says so in both languages', () => {
  assert.deepEqual(
    TEMPLATE_TYPES.map(([slug]) => slug),
    ['store', 'blog', 'brand', 'portfolio', 'other'],
  );
  for (const [slug] of TEMPLATE_TYPES) assert.equal(checkSlug(slug), null, slug);

  // The seed list is itself a valid scope list, or `setTemplateScope` would
  // refuse the round trip of the screen's own starting state.
  const asInput = PLACEHOLDER_SCOPE.map(([key, kind, labelFa, labelEn]) => ({ key, kind, labelFa, labelEn }));
  assert.equal(checkTemplateScope(asInput), null);
  for (const [, , labelFa, labelEn] of PLACEHOLDER_SCOPE) {
    assert.match(labelFa, /نمونه/);
    assert.match(labelEn, /placeholder/i);
  }
});

test('slug and key shape: lowercase Latin words joined by single hyphens, never a dot', () => {
  for (const ok of ['store', 'one-page-site', 'a1', 'x-2-y']) {
    assert.match(ok, SLUG_PATTERN);
    assert.match(ok, KEY_PATTERN);
  }
  for (const bad of ['', 'Store', 'a b', 'a_b', '-a', 'a-', 'a--b', 'checklist.auth', 'فروشگاه', 'a'.repeat(61)]) {
    assert.equal(checkSlug(bad), 'INVALID_SLUG', bad);
    assert.equal(
      checkTemplateScope([{ key: bad, kind: 'PAGE', labelFa: 'ا', labelEn: 'a' }]),
      'INVALID_KEY',
      bad,
    );
  }
});

test('checkTemplateScope: duplicates, kinds and labels each refuse with a code of their own', () => {
  const row = (key: string, over: Partial<{ kind: string; labelFa: string; labelEn: string }> = {}) => ({
    key,
    kind: 'PAGE',
    labelFa: 'الف',
    labelEn: 'A',
    ...over,
  });
  assert.equal(checkTemplateScope([]), null, 'an empty list is a valid list — it clears the type');
  assert.equal(checkTemplateScope([row('a'), row('b')]), null);
  assert.equal(checkTemplateScope([row('a'), row('b'), row('a')]), 'DUPLICATE_TEMPLATE_KEY');
  assert.equal(checkTemplateScope([row('a', { kind: 'EXTRA' })]), 'INVALID_TEMPLATE_KIND');
  assert.equal(checkTemplateScope([row('a', { kind: 'NOPE' })]), 'INVALID_TEMPLATE_KIND');
  assert.equal(checkTemplateScope([row('a', { labelFa: '  ' })]), 'LABEL_REQUIRED');
  assert.equal(checkTemplateScope([row('a', { labelEn: '' })]), 'LABEL_REQUIRED');
  // The malformed key is reported before the duplicate it also is.
  assert.equal(checkTemplateScope([row('A'), row('A')]), 'INVALID_KEY');
});
