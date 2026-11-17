import type { Locale } from '@/i18n';

/**
 * DX4 (desk UX review 26): the one title field decides which column a text
 * belongs in from its script. Any Persian or Arabic letter means the text is
 * Persian; otherwise it is English. A text with no letters at all (digits,
 * punctuation, nothing) says nothing about its language, so it is stored in
 * the panel's own language, `fallback`. Mixed text with a single Persian
 * letter is Persian: a Persian title that quotes a Latin product name is
 * still a Persian title.
 */

// Arabic letters only: the Arabic block also holds digits and punctuation, which are not letters.
const ARABIC_LETTER = /[\u0621-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF\u06FA-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/;

/** Which language a text is written in; `fallback` when it has no letters. */
export function detectScript(text: string, fallback: Locale): Locale {
  if (ARABIC_LETTER.test(text)) return 'fa';
  if (LATIN_LETTER.test(text)) return 'en';
  return fallback;
}

/** The two columns a typed text goes into: its language's holds it, the other is empty. */
export function splitByScript(text: string, fallback: Locale): { fa: string; en: string } {
  return detectScript(text, fallback) === 'fa' ? { fa: text, en: '' } : { fa: '', en: text };
}

/** At least one of the pair says something. The API's `requireOneTitle` is the enforcing copy. */
export const hasOneTitle = (fa: string, en: string): boolean => fa.trim() !== '' || en.trim() !== '';
