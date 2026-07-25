import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fa from './locales/fa.json';

/** Persian is the product's first language, not a translation of English. */
export const LOCALES = ['fa', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'fa';

export const isLocale = (v: string | undefined): v is Locale =>
  !!v && (LOCALES as readonly string[]).includes(v);

export const dirOf = (locale: Locale) => (locale === 'fa' ? 'rtl' : 'ltr');

/** The visitor's best-guess language, used only when the URL has no prefix. */
export function guessLocale(): Locale {
  const stored = localStorage.getItem('root.locale');
  if (isLocale(stored ?? undefined)) return stored as Locale;
  const preferred = navigator.languages ?? [navigator.language];
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'fa') return 'fa';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LOCALE;
}

/**
 * The URL prefix is the authority on locale, so read it before the first
 * render rather than correcting the language in an effect afterwards — that
 * ordering is what makes the very first paint already correct.
 */
export function localeFromPath(pathname: string): Locale {
  const first = pathname.split('/')[1];
  return isLocale(first) ? first : guessLocale();
}

i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, fa: { translation: fa } },
  lng: localeFromPath(window.location.pathname),
  fallbackLng: DEFAULT_LOCALE,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
