import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { isStaff } from '@/lib/access';
import { ME, type User } from '@/lib/queries';

/** Later phases. Present in the rail so the shape of the product is honest. */
const SOON = ['services', 'billing', 'support'] as const;

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

          {SOON.map((key) => (
            <NavLink
              key={key}
              className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
              to={lp(locale, `/app/${key}`)}
            >
              <span className="side-glyph" />
              <span>{t(`portal.nav${key[0].toUpperCase()}${key.slice(1)}`)}</span>
              <span className="side-soon-tag">{t('portal.soon')}</span>
            </NavLink>
          ))}

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
