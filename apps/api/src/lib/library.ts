/**
 * The Library's shared rules — one visibility test, one search-text builder,
 * one slug maker — imported everywhere the corresponding rule is needed,
 * never reimplemented (house rule 3).
 */

import type { Prisma } from '@prisma/client';

/**
 * The public reader's test, in one place (R1.md §4.1). R2 will import this;
 * nothing should ever inline `publishedAt: { not: null }` beside its own idea
 * of visibility.
 */
export const publiclyVisible = {
  publishedAt: { not: null },
  visibility: 'PUBLIC',
} as const satisfies Prisma.LibraryEntryWhereInput;

/**
 * Folds Persian/Arabic orthographic variants so text compares equal to
 * itself (R1.md §5.1): Arabic yeh/kaf vs. their Persian counterparts, hamza-
 * bearing alefs, ZWNJ, tatweel, harakat, and Arabic-Indic vs. Persian digits
 * all fold to one form. The character tables here are the same ones the
 * hand-written `library_fold()` Postgres function carries in the R1
 * migration — `library.test.ts` asserts the two agree.
 *
 * Implemented in JS rather than called via a raw query, on purpose: R1.md
 * §5.2 suggests folding the search term through the SQL function at query
 * time, but `searchText` is already fully folded when it is stored (below),
 * so folding the incoming term again needs the same rule, not a second
 * database round trip. One function used by both the write path
 * (buildSearchText) and the read path (resolvers/library.ts's search filter)
 * is the version that cannot drift from itself; the SQL function stays in
 * the migration for anyone querying the corpus directly, and as the
 * hand-verified reference this port is checked against.
 */
const STRIP_MARKS = /[ً-ْـ‌]/g;
const FOLD_FROM = 'ىيكأإآ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const FOLD_TO = 'ییکااا01234567890123456789';
const FOLD_MAP = new Map(Array.from(FOLD_FROM, (ch, i) => [ch, FOLD_TO[i]] as const));

export function foldPersian(text: string): string {
  let out = '';
  for (const ch of text.replace(STRIP_MARKS, '')) {
    out += FOLD_MAP.get(ch) ?? ch;
  }
  return out.toLowerCase();
}

type SearchableEntry = {
  titleOriginal: string;
  titleTranslated?: string | null;
  authors: string;
  venue?: string | null;
  abstractOriginal?: string | null;
  abstractTranslated?: string | null;
};

type SearchableConcept = { titleFa: string; titleEn: string };

/**
 * The one function that decides what a Library entry is findable by (T8).
 * Every write that changes a searchable field — including setEntryConcepts,
 * which changes concept titles' contribution — calls this and stores the
 * result on `searchText`. A stale haystack does not error; it just fails to
 * find things, which is why there is exactly one place this is built.
 */
export function buildSearchText(entry: SearchableEntry, concepts: SearchableConcept[]): string {
  const parts = [
    entry.titleOriginal,
    entry.titleTranslated,
    entry.authors,
    entry.venue,
    entry.abstractOriginal,
    entry.abstractTranslated,
    ...concepts.flatMap((c) => [c.titleFa, c.titleEn]),
  ].filter((v): v is string => Boolean(v && v.trim()));
  return foldPersian(parts.join(' '));
}

/**
 * A URL segment from a title (T4). Persian titles keep their Persian
 * characters rather than being transliterated to ASCII — «یادگیری-ماشین» in a
 * URL bar is not obviously worse than `yadgiri-mashin`, and unlike a
 * transliteration scheme, percent-encoding a real title needs no one to agree
 * on a romanization. This is the first non-ASCII route segment in the app;
 * every one before it has been ASCII by construction, not by rule.
 */
export function slugify(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(STRIP_MARKS, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'entry';
}

/**
 * The definitive slug: `override` (slugified) if given, else `title`
 * (slugified), then de-duplicated against `taken` by appending `-2`, `-3`,
 * and so on. `taken` is supplied rather than queried here so this stays a
 * pure function — the resolver reads the candidates from the database and
 * this decides what to do with them.
 */
export function makeSlug(title: string, taken: ReadonlySet<string>, override?: string | null): string {
  const base = override && override.trim() ? slugify(override) : slugify(title);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}
