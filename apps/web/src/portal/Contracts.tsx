import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { MY_CONTRACTS, MY_REQUESTS, type Contract, type ContractStatus, type Request, type User } from '@/lib/queries';
import { ALL_STATUSES, formatAmount, formatCount, pick, relativeTime } from '@/lib/format';
import StatusBadge from '@/components/StatusBadge';
import Topbar from './Topbar';
import NewRequestModal from './NewRequestModal';
import RequestDrawer from './RequestDrawer';

/** A request's badge: pending, archived, or converted-but-not-yet-handed-over
 *  (`ACTIVE` — once a contract on it is published the API stops listing the
 *  request and the contract is the row). */
const requestBadge = (status: Request['status']) =>
  status === 'REQUESTED' ? 'REQUESTED' : status === 'ARCHIVED' ? 'ARCHIVED' : 'CONVERTED';

type Filter = ContractStatus | 'ALL';

export default function Contracts() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();

  const { data, loading, error, refetch } = useQuery<{ myContracts: Contract[] }>(MY_CONTRACTS);
  const [filter, setFilter] = useState<Filter>('ALL');

  // Journeys build plan J2. The open drawer lives in the URL (`?request=<id>`)
  // so a notification's link opens it directly and a reload keeps it; the
  // list is re-read whenever the window regains focus, the same "no
  // websocket" rule the drawer follows.
  const [params, setParams] = useSearchParams();
  const openRequestId = params.get('request');
  const [composing, setComposing] = useState(false);
  const { data: requestData, refetch: refetchRequests } = useQuery<{ myRequests: Request[] }>(MY_REQUESTS, {
    fetchPolicy: 'cache-and-network',
  });
  useEffect(() => {
    const refresh = () => void refetchRequests();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetchRequests]);
  const requests = requestData?.myRequests ?? [];
  const openRequest = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set('request', id);
        else next.delete('request');
        return next;
      },
      { replace: id === null },
    );

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
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setComposing(true)}>
            {t('requests.newRequest')}
          </button>
        </div>

        {/* Requests sit above the contracts — what you have asked for that is
            not a contract yet. Absent entirely when there are none. */}
        {requests.length > 0 ? (
          <section className="request-section" aria-labelledby="requests-heading">
            <div>
              <h2 className="t-h3" id="requests-heading">
                {t('requests.sectionTitle')}
              </h2>
              <p className="t-small muted">{t('requests.sectionLede')}</p>
            </div>
            <ul className="request-list">
              {requests.map((r) => {
                const badge = requestBadge(r.status);
                return (
                  <li key={r.id} className="request-item">
                    <button type="button" className="request-row" onClick={() => openRequest(r.id)}>
                      <span className="request-title" dir="auto">
                        {r.title}
                      </span>
                      <span className={`badge${badge === 'REQUESTED' ? '' : badge === 'ARCHIVED' ? ' badge-neutral' : ' badge-locked'}`}>
                        {t(`requests.badge.${badge}`)}
                      </span>
                      <span className="t-caption muted">{relativeTime(r.requestedAt, locale)}</span>
                    </button>
                    {r.status === 'ARCHIVED' && r.archivedReason ? (
                      <p className="t-small request-reason" dir="auto">
                        {t('requests.archivedBecause', { reason: r.archivedReason })}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

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

      {composing ? (
        <NewRequestModal
          onClose={() => setComposing(false)}
          onSubmitted={(request) => {
            setComposing(false);
            openRequest(request.id);
          }}
        />
      ) : null}
      {openRequestId ? <RequestDrawer requestId={openRequestId} meId={me.id} onClose={() => openRequest(null)} /> : null}
    </>
  );
}
