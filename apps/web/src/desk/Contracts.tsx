import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ALL_CONTRACTS,
  PUBLISH_CONTRACT,
  SET_CONTRACT_STATUS,
  type Contract,
  type ContractStatus,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, fullDateTime, pick } from '@/lib/format';

export default function DeskContracts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const { data } = useQuery<{ allContracts: Contract[] }>(ALL_CONTRACTS, {
    skip: !can(me, 'contracts.manage'),
  });
  const [publish] = useMutation(PUBLISH_CONTRACT);
  const [setStatus] = useMutation(SET_CONTRACT_STATUS);

  if (!can(me, 'contracts.manage')) return <Navigate to={lp(locale, '/desk')} replace />;

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.navContracts')}</h2>

      <div className="table-wrap">
        <table className="ctable">
          <thead>
            <tr>
              <th>{t('desk.colRef')}</th>
              <th>{t('desk.colTitle')}</th>
              <th>{t('desk.colCustomer')}</th>
              <th>{t('desk.colStatus')}</th>
              <th>{t('desk.colUpdated')}</th>
              {/* D4: this used to show updatedAt under a "Published" heading.
                  Now it is the real publishedAt, and "—" is an honest answer
                  for a contract that has not been handed over yet. */}
              <th>{t('desk.colPublished')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(data?.allContracts ?? []).map((c) => (
              <tr key={c.id}>
                <td dir="ltr">{c.ref}</td>
                <td>{pick(c, 'title', locale)}</td>
                <td>{c.customer.clientName ?? c.customer.name}</td>
                <td>
                  {/* Permissive by design: any status to any status, with a
                      manual override always available. */}
                  <select
                    className="select"
                    value={c.status}
                    onChange={(e) =>
                      setStatus({
                        variables: {
                          contractId: c.id,
                          status: e.target.value as ContractStatus,
                        },
                      })
                    }
                  >
                    {ALL_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {t(`status.${s}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{fullDateTime(c.updatedAt, locale)}</td>
                <td>{c.publishedAt ? fullDateTime(c.publishedAt, locale) : '—'}</td>
                <td>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    onClick={() => publish({ variables: { contractId: c.id } })}
                  >
                    {t('desk.publish')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
