import { NavLink, Outlet, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { CONTRACT_WORKSPACE, type Contract } from '@/lib/queries';
import { pick } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';

export type WorkspaceContext = { contract: Contract };

const TABS = ['contract', 'design', 'scope', 'activity'] as const;

/**
 * The shell every tab renders inside. One query (`CONTRACT_WORKSPACE`) owns
 * the data; every mutation a tab fires returns the same shape, so Apollo's
 * normalized cache keeps this in sync without any tab calling `refetch`.
 */
export default function ContractWorkspace() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { id = '' } = useParams();
  const { data, loading, error } = useQuery<{ contract: Contract | null }>(CONTRACT_WORKSPACE, {
    variables: { id },
  });

  if (loading && !data) {
    return <div className="desk-section">{t('portal.loading')}</div>;
  }
  if (error || !data?.contract) {
    return <div className="desk-section">{t('portal.errorTitle')}</div>;
  }

  const contract = data.contract;

  return (
    <div className="desk-section">
      <div className="workspace-head">
        <div>
          <p className="t-caption num-latin">{contract.ref}</p>
          <h2 className="t-h2">{pick(contract, 'title', locale)}</h2>
        </div>
        <StatusBadge status={contract.status} />
      </div>

      <nav className="workspace-tabs">
        {TABS.map((tab) => (
          <NavLink
            key={tab}
            end
            className={({ isActive }) => `workspace-tab${isActive ? ' workspace-tab-active' : ''}`}
            to={lp(locale, `/desk/contracts/${id}/${tab}`)}
          >
            {t(`workspace.tab${tab[0].toUpperCase()}${tab.slice(1)}`)}
          </NavLink>
        ))}
      </nav>

      <div className="workspace-panel">
        <Outlet context={{ contract } satisfies WorkspaceContext} />
      </div>
    </div>
  );
}
