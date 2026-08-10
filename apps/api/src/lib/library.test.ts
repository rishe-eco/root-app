import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STRIP_MARKS_SOURCE, buildSearchText, foldPersian, makeSlug, slugify } from './library.js';

/** Walk up to the workspace root — same helper as changeAction.test.ts. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg) && JSON.parse(readFileSync(pkg, 'utf8')).name === 'root-app') return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('Could not find the workspace root from ' + import.meta.url);
}

const ROOT = repoRoot();

function findR1Migration(): string {
  const dir = join(ROOT, 'apps/api/prisma/migrations');
  const match = readdirSync(dir).find((name) => name.endsWith('_r1_library'));
  assert.ok(match, 'no migration directory ending in "_r1_library" was found');
  return readFileSync(join(dir, match!, 'migration.sql'), 'utf8');
}

test("library_fold's character table is balanced (§5.2)", () => {
  // translate() maps position to position and silently *deletes* any
  // character in the first string with no partner in the second — a miscount
  // does not error, it quietly removes letters from the corpus. This is the
  // test that would catch that.
  const sql = findR1Migration();
  const body = sql.match(/library_fold\(t text\) RETURNS text AS \$\$(.*?)\$\$ LANGUAGE/s);
  assert.ok(body, 'could not find the library_fold() function body in the R1 migration');
  // The last two single-quoted string literals in the body are translate()'s
  // from/to arguments — the ones before them are regexp_replace()'s pattern,
  // replacement and flag.
  const literals = [...body![1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.ok(literals.length >= 2, `expected at least 2 string literals, found ${literals.length}`);
  const [from, to] = literals.slice(-2);

  const fromChars = Array.from(from);
  const toChars = Array.from(to);
  assert.equal(fromChars.length, toChars.length, `${fromChars.length} source characters vs ${toChars.length} replacements`);
  assert.equal(fromChars.length, 26, 'expected exactly the 26-character table documented in R1.md §5.2');

  // The JS port (foldPersian) is a second implementation of this same table,
  // kept only because a SQL migration cannot be imported into a unit test —
  // it must be the *same* table, verbatim, or the write path and the read
  // path fold text two different ways.
  for (const [i, ch] of fromChars.entries()) {
    assert.equal(foldPersian(ch), toChars[i].toLowerCase(), `mismatch at index ${i}: '${ch}'`);
  }
});

test("library_fold's strip pattern matches the JS port's, verbatim (§5.2)", () => {
  // The table check above covers the characters that are *replaced*. The
  // characters that are *removed* — ZWNJ, tatweel, harakat — live in
  // regexp_replace's pattern, and an edit to one side only is just as silent:
  // stop stripping ZWNJ in one place and «می‌رود» no longer matches «میرود»
  // on whichever path was not updated.
  const sql = findR1Migration();
  const body = sql.match(/library_fold\(t text\) RETURNS text AS \$\$(.*?)\$\$ LANGUAGE/s);
  assert.ok(body, 'could not find the library_fold() function body in the R1 migration');
  const literals = [...body![1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  // regexp_replace(coalesce(t, ''), <pattern>, <replacement>, <flags>) — the
  // first literal is coalesce's empty string, so the pattern is the second.
  const pattern = literals[1];
  assert.equal(pattern, STRIP_MARKS_SOURCE, 'the SQL strip pattern and the JS one have diverged');

  // And behaviourally, so the assertion above cannot pass on two identical
  // strings that both stopped working.
  for (const ch of ['‌', 'ـ', 'ً', 'ْ']) {
    assert.equal(foldPersian(`ا${ch}ب`), 'اب', `'${ch.codePointAt(0)!.toString(16)}' was not stripped`);
  }
});

test('buildSearchText includes titles, authors, venue, abstracts and concept titles, folded', () => {
  const text = buildSearchText(
    {
      titleOriginal: 'يادگيري ماشين', // written with the Arabic yeh (ي), not the Persian one (ی)
      titleTranslated: 'Machine Learning',
      authors: 'کیانی',
      venue: 'مجله‌ی علمی',
      abstractOriginal: 'چکیده‌ی اصلی',
      abstractTranslated: 'the abstract',
    },
    [
      { titleFa: 'روان‌شناسی', titleEn: 'Psychology' },
      { titleFa: 'آموزش', titleEn: 'Education' },
    ],
  );

  for (const part of ['Machine Learning', 'کیانی', 'مجله', 'چکیده', 'the abstract', 'روان', 'Psychology', 'آموزش', 'Education']) {
    assert.ok(text.includes(foldPersian(part)), `missing folded "${part}" in: ${text}`);
  }
  // Folded, not raw: an Arabic yeh in the source must not survive verbatim
  // once a Persian yeh would also have to match it (§5.1).
  assert.equal(text, foldPersian(text), 'buildSearchText must return already-folded text');
});

test('buildSearchText omits blank/absent optional fields rather than a stray separator', () => {
  const text = buildSearchText(
    { titleOriginal: 'Title', authors: 'Author', titleTranslated: null, venue: '', abstractOriginal: null, abstractTranslated: null },
    [],
  );
  assert.equal(text, foldPersian('Title Author'));
});

test('slugify: a Persian title keeps its own script, kebab-cased', () => {
  assert.equal(slugify('یادگیری ماشین'), 'یادگیری-ماشین');
  assert.equal(slugify('  Machine Learning: A Primer!  '), 'machine-learning-a-primer');
  assert.equal(slugify(''), 'entry');
});

test('makeSlug: duplicate collision appends -2, -3, …', () => {
  assert.equal(makeSlug('Machine Learning', new Set()), 'machine-learning');
  assert.equal(makeSlug('Machine Learning', new Set(['machine-learning'])), 'machine-learning-2');
  assert.equal(
    makeSlug('Machine Learning', new Set(['machine-learning', 'machine-learning-2'])),
    'machine-learning-3',
  );
});

test('makeSlug: an override replaces the title-derived base, and is itself deduplicated', () => {
  assert.equal(makeSlug('Machine Learning', new Set(), 'ml-primer'), 'ml-primer');
  assert.equal(makeSlug('Machine Learning', new Set(['ml-primer']), 'ml-primer'), 'ml-primer-2');
  // An empty override is not a real override.
  assert.equal(makeSlug('Machine Learning', new Set(), '   '), 'machine-learning');
});
