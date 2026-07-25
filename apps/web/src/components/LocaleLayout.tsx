import { Navigate, Outlet, useLocation, useParams } from 'react-router-dom';
import { guessLocale, isLocale } from '@/i18n';
import { useLocale } from '@/lib/locale';

/**
 * Owns the locale for everything beneath it: sets `<html lang>` and
 * `<html dir>`, and bounces unknown prefixes (`/de/about`) to a real one.
 */
export default function LocaleLayout() {
  const { lang } = useParams();
  const { pathname, search, hash } = useLocation();
  const known = isLocale(lang);

  const locale = useLocale();

  if (!known) {
    return <Navigate to={`/${guessLocale()}${pathname}${search}${hash}`} replace />;
  }

  /* Keyed on the locale so switching language remounts the subtree. Without
     it, a component that missed i18next's languageChanged event keeps
     rendering the previous language's copy. */
  return <Outlet key={locale} />;
}
