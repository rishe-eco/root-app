import { useParams, useNavigate, useLocation } from 'react-router-dom';
import i18n, { DEFAULT_LOCALE, dirOf, isLocale, type Locale } from '@/i18n';

/**
 * Applied during render, not in an effect. i18next is a singleton outside
 * React's tree, and a component that renders before the language catches up
 * shows the fallback language — so the switch has to land first.
 */
function applyLocale(locale: Locale) {
  if (i18n.language !== locale) void i18n.changeLanguage(locale);

  const html = document.documentElement;
  if (html.lang !== locale) html.lang = locale;
  const dir = dirOf(locale);
  if (html.dir !== dir) html.dir = dir;
  localStorage.setItem('root.locale', locale);
}

/**
 * The locale lives in the URL (`/fa/...`, `/en/...`). Everything else — the
 * i18next language, `<html lang>`, `<html dir>` — follows from it, so there is
 * exactly one place that decides direction.
 */
export function useLocale(): Locale {
  const { lang } = useParams();
  const locale = isLocale(lang) ? lang : DEFAULT_LOCALE;
  applyLocale(locale);
  return locale;
}

/**
 * Switching language swaps the URL prefix and keeps the visitor where they
 * are — the locale, the direction, the font and the address move together.
 */
export function useSwitchLocale() {
  const navigate = useNavigate();
  const { pathname, search, hash } = useLocation();

  return (next: Locale) => {
    const rest = pathname.replace(/^\/(fa|en)(?=\/|$)/, '') || '/';
    navigate(`/${next}${rest === '/' ? '' : rest}${search}${hash}`, { replace: true });
  };
}

/** Build a locale-prefixed path: `lp('fa', '/portal')` → `/fa/portal`. */
export const lp = (locale: Locale, path: string) =>
  `/${locale}${path === '/' ? '' : path}`;
