import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
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

/**
 * The bar, and below 769px the bar plus a disclosure (wp-design-review.md
 * Phase D). At 390px the four slots and Portal wrapped the bar onto a second
 * row; now the bar is the brand, the language switch and a Menu button, and the
 * links open in a column beneath it.
 *
 * Above the breakpoint `.nav-menu` is `display: contents` (public.css), so its
 * children are the bar's own flex items and the desktop layout is exactly what
 * it was. Below it the menu is hidden unless open.
 *
 * A disclosure, not a modal: no focus trap, no scrim. It closes on a route
 * change, on selecting a link (including one to the page you are already on,
 * which changes no route), and on Escape — which returns focus to the button,
 * since the focused link has just been hidden.
 */
export default function Nav() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <nav
      className="nav"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <Link className="nav-brand nav-brand-link" to={lp(locale, '/')}>
        <span className="dot" />
        {t('brand.main')}
        <span className="sub">{t('brand.sub')}</span>
      </Link>

      <div
        id="site-menu"
        className={`nav-menu${open ? ' nav-menu-open' : ''}`}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) setOpen(false);
        }}
      >
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

        {/* A NavLink, so it reads as current on /portal and everything under it. */}
        <NavLink className="nav-link" to={lp(locale, '/portal')}>
          <span className="nav-label t-small">{t('nav.portal')}</span>
        </NavLink>
      </div>

      <LangSwitch />

      <button
        ref={toggleRef}
        type="button"
        className="btn btn-ghost menu-toggle"
        aria-expanded={open}
        aria-controls="site-menu"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('nav.close') : t('nav.menu')}
      </button>
    </nav>
  );
}
