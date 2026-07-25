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
