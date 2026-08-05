import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { Link, NavLink, Navigate, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { isStaff } from '@/lib/access';
import { ME, SIGN_OUT, type User } from '@/lib/queries';
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

  const sections = visibleSections(me);

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
          {/* TODO(label): "کارگاه" (workshop) is a placeholder Persian label
              for desk.title / portal.navDesk — pending the founder's word
              per docs/development/F2.md §6. The route /desk is not blocked
              on this. */}
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
        <div className="desk-content">
          <Outlet context={me} />
        </div>
      </div>
    </div>
  );
}
