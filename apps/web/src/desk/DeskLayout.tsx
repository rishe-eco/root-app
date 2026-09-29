import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { isStaff } from '@/lib/access';
import { ME, SIGN_OUT, SMS_CONFIGURED, type User } from '@/lib/queries';
import { initialOf } from '@/lib/format';
import LangSwitch from '@/components/LangSwitch';
import { DESK_SECTIONS, visibleSections } from './sections';

/**
 * The shell every desk section renders inside: who may be here at all
 * (`isStaff`), and the nav built off the same `DESK_SECTIONS` table the index
 * redirect and each route's own guard read. Its own grid, not the portal's
 * `.side`/`.work`/`.topbar` — those two screens are allowed to diverge.
 */
export default function DeskLayout() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const client = useApolloClient();
  const { data, loading } = useQuery<{ me: User | null }>(ME);
  const [signOut] = useMutation(SIGN_OUT);

  // PD-18's own gate on the query itself (staff.manage — ADMIN only), so no
  // non-admin ever even asks and no FORBIDDEN ever reaches the console.
  // `me?.capabilities` is cast past `lib/access.ts`'s `Capability` union
  // (not this stage's file to widen — S1's own web lane owns that type)
  // rather than calling `can()`, which the stale union would refuse to
  // compile against for a capability it does not yet list.
  const isAdmin = Boolean((data?.me?.capabilities as string[] | undefined)?.includes('staff.manage'));
  const { data: smsData } = useQuery<{ smsConfigured: boolean }>(SMS_CONFIGURED, { skip: !isAdmin });

  if (loading) {
    return (
      <div className="root-ui desk-shell">
        <p className="t-small">{t('portal.loading')}</p>
      </div>
    );
  }

  const me = data?.me ?? null;
  if (!isStaff(me)) {
    return <Navigate to={lp(locale, '/portal')} replace />;
  }
  // PD-10: forced to the one screen that can clear this, before any desk
  // section renders — the same gate PortalLayout applies on its own side.
  if (me!.passwordChangeRequired) {
    return <Navigate to={lp(locale, '/portal/set-password')} replace />;
  }

  const sections = visibleSections(me);
  const showSmsBanner = isAdmin && smsData?.smsConfigured === false;

  async function onSignOut() {
    await signOut().catch(() => undefined);
    await client.clearStore();
    navigate(lp(locale, '/portal'), { replace: true });
  }

  return (
    <div className="root-ui desk-shell">
      <aside className="desk-side">
        <Link className="desk-brand" to={lp(locale, '/')}>
          <span className="dot" />
          {t('brand.main')}
        </Link>

        <nav className="desk-nav">
          {DESK_SECTIONS.filter((s) => sections.includes(s)).map((s) => (
            <NavLink
              key={s.key}
              className={({ isActive }) => `desk-link${isActive ? ' desk-link-active' : ''}`}
              to={lp(locale, `/desk/${s.key}`)}
            >
              {t(`desk.nav${s.key[0].toUpperCase()}${s.key.slice(1)}`)}
            </NavLink>
          ))}
        </nav>

        <Link className="desk-link desk-back" to={lp(locale, '/app/contracts')}>
          {t('desk.backToPortal')}
        </Link>
      </aside>

      <div className="desk-main">
        <header className="desk-topbar">
          {/* «اتاقِ کار» — the workroom (founder direction, 2026-08-09,
              settling the F2 placeholder). It pairs with the portal's
              «میز کار» rather than competing: the portal is the desk, this
              is the room it stands in. */}
          <h1 className="t-h3">{t('desk.title')}</h1>
          <div className="desk-topbar-right">
            <LangSwitch />
            <div className="desk-user">
              <span className="t-small">{me!.name}</span>
              <span className="desk-avatar" aria-hidden="true">
                {initialOf(me!.name)}
              </span>
            </div>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onSignOut}>
              {t('portal.signOut')}
            </button>
          </div>
        </header>
        {showSmsBanner ? (
          <p className="auth-notice" role="status">
            {t('desk.smsNotConfigured')}
          </p>
        ) : null}
        <div className="desk-content">
          <Outlet context={me} />
        </div>
      </div>
    </div>
  );
}
