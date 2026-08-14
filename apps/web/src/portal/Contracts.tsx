import { useMemo, useState } from 'react';
import { useNavigate, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { MY_CONTRACTS, type Contract, type ContractStatus, type User } from '@/lib/queries';
import { ALL_STATUSES, formatAmount, formatCount, pick, relativeTime } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import Topbar from './Topbar';

type Filter = ContractStatus | 'ALL';

export default function Contracts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();

  const { data, loading, error, refetch } = useQuery<{ myContracts: Contract[] }>(MY_CONTRACTS);
  const [filter, setFilter] = useState<Filter>('ALL');

  const contracts = useMemo(() => data?.myContracts ?? [], [data]);

  /* Filtering is client-side over the loaded rows — a customer has a handful
     of contracts, and it keeps the chips instant. */
  const counts = useMemo(() => {
    const map = new Map<Filter, number>([['ALL', contracts.length]]);
    for (const s of ALL_STATUSES) {
      map.set(s, contracts.filter((c) => c.status === s).length);
    }
    return map;
  }, [contracts]);

  const rows = filter === 'ALL' ? contracts : contracts.filter((c) => c.status === filter);

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{t('portal.navContracts')}</h1>} />

      <div className="content">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('contracts.pageTitle')}</h1>
            <p className="t-lead">{t('contracts.pageLede')}</p>
          </div>
        </div>

        <div className="chips">
          {(['ALL', ...ALL_STATUSES] as Filter[]).map((key) => (
            <button
              key={key}
              type="button"
              className={`chip${filter === key ? ' chip-active' : ''}`}
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
            >
              {t(`status.${key}`)}
              <span className="chip-count">{formatCount(counts.get(key) ?? 0, locale)}</span>
            </button>
          ))}
        </div>

        {error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading && contracts.length === 0 ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : (
          <div className="table-wrap">
            <table className="ctable">
              <thead>
                <tr>
                  <th>{t('contracts.colContract')}</th>
                  <th>{t('contracts.colStatus')}</th>
                  <th className="col-amount">{t('contracts.colAmount')}</th>
                  <th>{t('contracts.colUpdated')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="empty">
                        {contracts.length === 0
                          ? t('contracts.emptyAll')
                          : t('contracts.emptyMsg')}
                      </div>
                    </td>
                  </tr>
                ) : (
                  rows.map((c) => {
                    const href = lp(locale, `/app/contracts/${c.id}`);
                    /* Same rule as the detail screen: a row names the published
                       document — its frozen title and its frozen fee — not
                       Root's draft of them. The draft stands in only when there
                       is no sealed revision to read, which here means a
                       backfilled v1 awaiting `npm run backfill`. */
                    const doc = c.revision ?? c;
                    return (
                      <tr key={c.id} className="crow" onClick={() => navigate(href)}>
                        <td>
                          <div className="cname">{pick(doc, 'title', locale)}</div>
                          <div className="cclient">{c.customer.clientName ?? c.customer.name}</div>
                        </td>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="col-amount">
                          {/* Not num-latin (persian-pass.md §1.2): money is
                              already the locale's own digits. */}
                          {doc.amount ? (
                            <span>
                              {formatAmount(doc.amount, locale)} {t('contracts.toman')}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td>{relativeTime(c.updatedAt, locale)}</td>
                        <td>
                          <span className="cview">{t('contracts.view')} ›</span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
