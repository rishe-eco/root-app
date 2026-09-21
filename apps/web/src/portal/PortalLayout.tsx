import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { isStaff } from '@/lib/access';
import { ME, type User } from '@/lib/queries';

export default function PortalLayout() {
  const { t } = useTranslation();
  const locale = useLocale();
  const location = useLocation();
  const { data, loading } = useQuery<{ me: User | null }>(ME);

  if (loading) {
    return (
      <div className="root-ui portal">
        <div className="work">
          <div className="content">
            <p className="t-small">{t('portal.loading')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!data?.me) {
    // Remember where they were headed so sign-in can put them back.
    return (
      <Navigate
        to={lp(locale, '/portal')}
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  const me = data.me;

  return (
    <div className="root-ui portal">
      <aside className="side">
        <Link className="side-brand" to={lp(locale, '/')}>
          <span className="dot" />
          {t('brand.main')}
          <span className="sub">{t('brand.sub')}</span>
        </Link>

        <nav className="side-nav">
          <p className="side-cap">{t('portal.workspace')}</p>

          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/contracts')}
          >
            <span className="side-glyph" />
            <span>{t('portal.navContracts')}</span>
          </NavLink>

          {/* Build plan L4: support is live — a real link, no "soon" tag. */}
          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/support')}
          >
            <span className="side-glyph" />
            <span>{t('portal.navSupport')}</span>
          </NavLink>

          {/* Build plan L6: billing is live — a real link, no "soon" tag. */}
          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/billing')}
          >
            <span className="side-glyph" />
            <span>{t('portal.navBilling')}</span>
          </NavLink>

          {/* Build plan L7: services is live — a real link, no "soon" tag. Last of the four, and every rail item is now real. */}
          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/services')}
          >
            <span className="side-glyph" />
            <span>{t('portal.navServices')}</span>
          </NavLink>

          {isStaff(me) ? (
            <NavLink
              className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
              to={lp(locale, '/desk')}
            >
              <span className="side-glyph" />
              <span>{t('portal.navDesk')}</span>
            </NavLink>
          ) : null}
        </nav>
      </aside>

      <div className="work">
        <Outlet context={me} />
      </div>
    </div>
  );
}
