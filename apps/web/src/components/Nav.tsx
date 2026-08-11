import { Link, NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import LangSwitch from './LangSwitch';
import Lock from './Lock';

type Slot = { key: 'about' | 'studio' | 'library' | 'journey'; to?: string };

/**
 * Four nav slots: two real, two locked. `cast` graduated to `library` in R2
 * — the Library has a real address now, with Root Cast still Reserved
 * underneath it at /library/cast. `studio` and `journey` are still locked
 * (R2.md §3): a locked slot shows that a section exists there — the label
 * rendered blurred with the padlock on top — without pretending it is ready.
 * `.sr-only` carries the meaning for screen readers.
 */
const SLOTS: Slot[] = [
  { key: 'about', to: '/about' },
  { key: 'studio' },
  { key: 'library', to: '/library' },
  { key: 'journey' },
];

export default function Nav() {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <nav className="nav">
      <Link className="nav-brand nav-brand-link" to={lp(locale, '/')}>
        <span className="dot" />
        {t('brand.main')}
        <span className="sub">{t('brand.sub')}</span>
      </Link>

      {SLOTS.map((slot) =>
        slot.to ? (
          <NavLink key={slot.key} className="nav-link" to={lp(locale, slot.to)}>
            <span className="nav-label">{t(`nav.${slot.key}`)}</span>
          </NavLink>
        ) : (
          <span key={slot.key} className="nav-link nav-link-locked">
            <span className="nav-label">{t(`nav.${slot.key}`)}</span>
            <Lock />
            <span className="sr-only">
              {t(`nav.${slot.key}`)} — {t('nav.locked')}
            </span>
          </span>
        ),
      )}

      <Link className="nav-link" to={lp(locale, '/portal')}>
        <span className="nav-label t-small">{t('nav.portal')}</span>
      </Link>

      <LangSwitch />
    </nav>
  );
}
