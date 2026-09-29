import { Navigate, NavLink, Outlet, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import type { User } from '@/lib/queries';
import { DESK_SECTIONS, canSeeSection } from '../sections';

/**
 * Template types and scope templates (journeys build plan T1) — one room, two
 * halves, two capabilities.
 *
 * A designer keeps the **types** (`templates.types`); sales keeps what each
 * type **contains** (`templates.scope`, the plan's Q-S11). Either capability
 * opens the room, and each tab then edits only what its own capability lets
 * through — the same two checks the API makes, read off `me.capabilities` and
 * never off a role (house rule 1), so the worst a wrong answer here costs is a
 * button that comes back FORBIDDEN. The other half is not hidden: a designer
 * reads the scope lists their types will start contracts with, and sales reads
 * the types their lists hang from, because each half is meaningless without
 * the other in view.
 *
 * The tab is the route (`/desk/templates/types`, `…/scope`), so it survives a
 * reload and a language switch and can be linked to.
 */

export type TemplatesContext = { me: User };

const TABS = ['types', 'scope'] as const;

export default function Templates() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  // The nav row and this guard read the one table, so a list-valued row means
  // the same thing to both (sections.ts).
  const section = DESK_SECTIONS.find((s) => s.key === 'templates')!;
  if (!canSeeSection(me, section)) return <Navigate to={lp(locale, '/desk')} replace />;

  return (
    <div className="desk-section">
      <div className="content-head">
        <div>
          <h2 className="t-h2">{t('desk.templates.title')}</h2>
          <p className="t-lead">{t('desk.templates.lede')}</p>
        </div>
      </div>

      <nav className="workspace-tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab}
            end
            className={({ isActive }) => `workspace-tab${isActive ? ' workspace-tab-active' : ''}`}
            to={lp(locale, `/desk/templates/${tab}`)}
          >
            {t(`desk.templates.tab.${tab}`)}
          </NavLink>
        ))}
      </nav>

      <div className="workspace-panel">
        <Outlet context={{ me } satisfies TemplatesContext} />
      </div>
    </div>
  );
}

/**
 * Lands on the tab the visitor can act in: someone who holds only
 * `templates.scope` opens on Scope rather than on a Types tab they can only
 * read. Both held (an admin) opens on Types, the first tab.
 */
export function TemplatesIndex() {
  const locale = useLocale();
  const { me } = useOutletContext<TemplatesContext>();
  const tab = can(me, 'templates.scope') && !can(me, 'templates.types') ? 'scope' : 'types';
  return <Navigate to={lp(locale, `/desk/templates/${tab}`)} replace />;
}
