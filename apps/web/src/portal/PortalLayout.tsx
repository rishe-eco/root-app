import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { isStaff } from '@/lib/access';
import { ME, MY_TOOLS, type User } from '@/lib/queries';
import PortalIcon from '@/components/PortalIcon';

export default function PortalLayout() {
  const { t } = useTranslation();
  const locale = useLocale();
  const location = useLocation();
  const { data, loading } = useQuery<{ me: User | null }>(ME);
  // Journeys build plan S3: the Tools item exists only while a tool has been
  // granted. Skipped until we know someone is signed in — `myTools` needs a
  // session, and the sign-in redirect below is the answer for anyone without.
  const { data: toolsData } = useQuery<{ myTools: string[] }>(MY_TOOLS, { skip: !data?.me });
  const hasTools = (toolsData?.myTools.length ?? 0) > 0;

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

  // PD-10: an account with a forced password change reaches nothing else in
  // the portal until it clears — checked here rather than per-screen, so no
  // new route under /app has to remember to ask.
  if (me.passwordChangeRequired) {
    return <Navigate to={lp(locale, '/portal/set-password')} replace />;
  }

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

          {/* Journeys build plan J12: the Dashboard is the first rail item — Dashboard,
              Contracts, Invoices, Tools, Support (the plan's order; Q3 keeps Support).
              `end`, because /app is also the prefix of every other portal route and
              would otherwise light up on all of them. */}
          <NavLink
            end
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app')}
          >
            <PortalIcon name="dashboard" />
            <span className="side-label">{t('portal.navDashboard')}</span>
          </NavLink>

          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/contracts')}
          >
            <PortalIcon name="contracts" />
            <span className="side-label">{t('portal.navContracts')}</span>
          </NavLink>

          {/* Build plan L6: billing is live — a real link, no "soon" tag. J13
              renamed it Invoices and moved it to /app/invoices. */}
          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/invoices')}
          >
            <PortalIcon name="invoices" />
            <span className="side-label">{t('portal.navBilling')}</span>
          </NavLink>

          {/* Journeys build plan S3: L7's Services item, renamed Tools and shown
              only while a grant exists — for a customer with none there is
              nothing behind it. */}
          {hasTools ? (
            <NavLink
              className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
              to={lp(locale, '/app/tools')}
            >
              <PortalIcon name="tools" />
              <span className="side-label">{t('portal.navTools')}</span>
            </NavLink>
          ) : null}

          {/* Build plan L4: support is live — a real link, no "soon" tag. */}
          <NavLink
            className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
            to={lp(locale, '/app/support')}
          >
            <PortalIcon name="support" />
            <span className="side-label">{t('portal.navSupport')}</span>
          </NavLink>

          {isStaff(me) ? (
            <NavLink
              className={({ isActive }) => `side-link${isActive ? ' side-link-active' : ''}`}
              to={lp(locale, '/desk')}
            >
              <PortalIcon name="desk" />
              <span className="side-label">{t('portal.navDesk')}</span>
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
