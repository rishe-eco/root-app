import { Navigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import type { User } from '@/lib/queries';

/**
 * A stub (build plan D6 / L1). `DESK_SECTIONS` gates this on `builds.author`
 * so a `DEVELOPER` account has *some* working surface rather than none — see
 * `desk/sections.ts`'s comment on why that row exists at all. The real
 * screen — the open feedback queue and the build-authoring form — is L3b's,
 * once `Build` and its change list exist to show.
 */
export default function Builds() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  if (!can(me, 'builds.author')) {
    return <Navigate to={lp(locale, '/desk')} replace />;
  }

  return (
    <div className="card">
      <h2 className="t-h3">{t('desk.builds.title')}</h2>
      <p className="t-small">{t('desk.builds.stub')}</p>
    </div>
  );
}
