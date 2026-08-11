import type { Locale } from '@/i18n';
import type { ContractStatus } from './queries';

/** The badge modifier for each status, matching the design system's names. */
export const STATUS_CLASS: Record<ContractStatus, string> = {
  DRAFT: 'st-draft',
  WAITING_ON_CUSTOMER: 'st-woc',
  WAITING_ON_ROOT: 'st-wor',
  IN_PROGRESS: 'st-inprogress',
  FINAL_REVIEW: 'st-finalreview',
  DONE: 'st-done',
  DISCARDED: 'st-discarded',
};

export const ALL_STATUSES: ContractStatus[] = [
  'DRAFT',
  'WAITING_ON_CUSTOMER',
  'WAITING_ON_ROOT',
  'IN_PROGRESS',
  'FINAL_REVIEW',
  'DONE',
  'DISCARDED',
];

const intlTag = (locale: Locale) => (locale === 'fa' ? 'fa-IR' : 'en-US');

/** Picks the right side of a bilingual pair without a second query. */
export function pick<T extends Record<string, unknown>>(
  row: T,
  base: string,
  locale: Locale,
): string {
  const key = `${base}${locale === 'fa' ? 'Fa' : 'En'}`;
  return String(row[key] ?? '');
}

export function formatAmount(amount: string | null, locale: Locale): string | null {
  if (amount === null) return null;
  return new Intl.NumberFormat(intlTag(locale)).format(Number(amount));
}

/** A plain integer through the locale's own digits — a tile showing "12" on a Persian page is a small tell that nobody looked at it in Persian (V4 T6). */
export function formatCount(n: number, locale: Locale): string {
  return new Intl.NumberFormat(intlTag(locale)).format(n);
}

const DIVISIONS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.34524],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
];

/** "2 days ago" / «۲ روز پیش» — locale-aware, including the digits. */
export function relativeTime(iso: string, locale: Locale): string {
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'auto' });
  let delta = (new Date(iso).getTime() - Date.now()) / 1000;

  for (const [unit, span] of DIVISIONS) {
    if (Math.abs(delta) < span) return rtf.format(Math.round(delta), unit);
    delta /= span;
  }
  return rtf.format(Math.round(delta), 'year');
}

/** "Just now · 14:05" for freshly added log entries and comments. */
export function clockTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function fullDateTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlTag(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

export const initialOf = (name: string) => name.trim().charAt(0) || '·';

/**
 * RTL scripts the Library corpus can plausibly carry (R2.md §1.1). Not an
 * exhaustive list of RTL languages — an exhaustive list is a library, and
 * this is a lookup with a safe default. Anything unknown is LTR, which is
 * wrong quietly rather than catastrophically: Latin text in an RTL block is
 * unreadable, RTL text in an LTR block is merely poorly aligned.
 *
 * Do not reach for `dir="auto"` instead — it guesses from the first strong
 * character, so a Persian abstract beginning with a Latin acronym renders
 * left-to-right and every line lands wrong. `originalLang` already states
 * the entry's language; this is that fact, not a guess.
 */
const RTL_LANGS = new Set(['fa', 'ar', 'he', 'ur', 'ps', 'ckb', 'sd', 'yi', 'dv']);
export const dirFor = (lang: string): 'rtl' | 'ltr' =>
  RTL_LANGS.has(lang.split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';

export type CitableEntry = {
  authors: string;
  titleOriginal: string;
  venue?: string | null;
  year?: number | null;
  doi?: string | null;
  sourceUrl?: string | null;
};

/** A short, stable citation key: first author's family name plus the year —
 *  not the slug, which may be in a non-Latin script BibTeX keys don't allow. */
function citationKey(entry: CitableEntry): string {
  const firstAuthor = entry.authors.split(/[,;]/)[0]?.trim().split(/\s+/).pop() ?? 'entry';
  const key = `${firstAuthor}${entry.year ?? ''}`.replace(/[^\p{L}\p{N}]/gu, '');
  return key || 'entry';
}

/**
 * Generated on read, never stored (R2.md §6) — a stored citation is a second
 * copy of authors/title/venue/year/doi that would drift the moment a typo in
 * one of them is fixed, the same reasoning that made the contract PDF a
 * rendering rather than a record (F1b).
 *
 * Cites exactly what the entry holds, in its own script. A Persian author's
 * name has no Latin form here, and this does not invent one — a citation
 * that silently romanises a name is worse than one a human still has to
 * touch by hand.
 */
export function formatCitation(entry: CitableEntry, style: 'bibtex' | 'apa'): string {
  const year = entry.year ?? 'n.d.';
  const link = entry.doi ? `https://doi.org/${entry.doi}` : entry.sourceUrl ?? null;

  if (style === 'bibtex') {
    const fields = [
      `  author = {${entry.authors}}`,
      `  title = {${entry.titleOriginal}}`,
      entry.venue ? `  journal = {${entry.venue}}` : null,
      `  year = {${year}}`,
      entry.doi ? `  doi = {${entry.doi}}` : null,
      !entry.doi && entry.sourceUrl ? `  url = {${entry.sourceUrl}}` : null,
    ].filter((v): v is string => v !== null);
    return `@article{${citationKey(entry)},\n${fields.join(',\n')}\n}`;
  }

  const parts = [
    `${entry.authors} (${year}).`,
    `${entry.titleOriginal}.`,
    entry.venue ? `${entry.venue}.` : null,
    link,
  ].filter((v): v is string => Boolean(v));
  return parts.join(' ');
}
