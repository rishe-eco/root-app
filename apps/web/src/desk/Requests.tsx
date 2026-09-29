import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { ALL_REQUESTS, ARCHIVE_REQUEST, REQUEST, type ProjectStatus, type Request, type User } from '@/lib/queries';
import { fullDateTime } from '@/lib/format';
import RequestThread, { requestErrorMessage } from '@/components/RequestThread';

/**
 * The sales inbox for requests (journeys build plan J2) — `contracts.readAll`,
 * the same capability the API checks for `allRequests`. Two screens: the list
 * (pending first, because that is the queue) and one request's page, with its
 * thread and the two acts sales has on it: **archive** (the reason is required
 * and the customer is shown it) or **convert** — which is not a mutation here
 * but a hand-off to the existing new-contract form, prefilled, so a contract
 * is only ever created in one place (`createContract`, with this project's id).
 *
 * Refetched on window focus, like the customer's drawer: no websocket.
 */

type Filter = ProjectStatus | 'ALL';
const FILTERS: Filter[] = ['REQUESTED', 'ARCHIVED', 'ACTIVE', 'ALL'];

/** Refetch when the window regains focus — a reply written in another tab or by the other side shows up. */
function useRefetchOnFocus(refetch: () => unknown) {
  useEffect(() => {
    const refresh = () => void refetch();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetch]);
}

function StatusChip({ status }: { status: ProjectStatus }) {
  const { t } = useTranslation();
  const key = status === 'REQUESTED' ? 'REQUESTED' : status === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE';
  return (
    <span className={`badge${status === 'ARCHIVED' ? ' badge-neutral' : status === 'ACTIVE' ? ' badge-locked' : ''}`}>
      {t(`requests.desk.filter.${key}`)}
    </span>
  );
}

export default function DeskRequests() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const me = useOutletContext<User>();
  const canRead = can(me, 'contracts.readAll');
  const [filter, setFilter] = useState<Filter>('REQUESTED');

  const { data, loading, refetch } = useQuery<{ allRequests: Request[] }>(ALL_REQUESTS, {
    variables: { status: filter === 'ALL' ? null : filter },
    fetchPolicy: 'cache-and-network',
    skip: !canRead,
  });
  useRefetchOnFocus(refetch);

  if (!canRead) return <Navigate to={lp(locale, '/desk')} replace />;
  const rows = data?.allRequests ?? [];

  return (
    <div className="desk-section">
      <div>
        <h2 className="t-h2">{t('requests.desk.title')}</h2>
        <p className="t-small desk-muted">{t('requests.desk.lede')}</p>
      </div>

      <div className="chips">
        {FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            className={`chip${filter === key ? ' chip-active' : ''}`}
            onClick={() => setFilter(key)}
            aria-pressed={filter === key}
          >
            {t(`requests.desk.filter.${key}`)}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <table className="ctable">
          <thead>
            <tr>
              <th>{t('requests.desk.colTitle')}</th>
              <th>{t('requests.desk.colCustomer')}</th>
              <th>{t('requests.desk.colRequested')}</th>
              <th>{t('requests.desk.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4}>
                  <div className="empty">{loading ? t('requests.loading') : t('requests.desk.empty')}</div>
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="crow" onClick={() => navigate(lp(locale, `/desk/requests/${r.id}`))}>
                  <td dir="auto">{r.title}</td>
                  <td>{r.customer.clientName ?? r.customer.name}</td>
                  <td>{fullDateTime(r.requestedAt, locale)}</td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One request: its thread, and archive / convert. */
export function DeskRequestDetail() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id = '' } = useParams();
  const canRead = can(me, 'contracts.readAll');
  const canAuthor = can(me, 'contracts.author');

  const { data, loading, error, refetch } = useQuery<{ request: Request | null }>(REQUEST, {
    variables: { projectId: id },
    fetchPolicy: 'cache-and-network',
    skip: !canRead,
  });
  useRefetchOnFocus(refetch);
  const [archive, { loading: archiving }] = useMutation(ARCHIVE_REQUEST);

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [archiveError, setArchiveError] = useState<string | null>(null);

  if (!canRead) return <Navigate to={lp(locale, '/desk')} replace />;

  const request = data?.request ?? null;

  async function onArchive(e: FormEvent) {
    e.preventDefault();
    setArchiveError(null);
    try {
      await archive({ variables: { projectId: id, reason: reason.trim() }, refetchQueries: ['AllRequests'] });
      setArchiveOpen(false);
      setReason('');
    } catch (err) {
      setArchiveError(requestErrorMessage(err, t));
    }
  }

  return (
    <div className="desk-section">
      <div>
        <Link className="t-small" to={lp(locale, '/desk/requests')}>
          ‹ {t('requests.desk.back')}
        </Link>
      </div>

      {!request ? (
        <div className="empty">
          {error && !loading ? t('requests.error.NOT_FOUND') : t('requests.loading')}
        </div>
      ) : (
        <>
          <div className="workspace-row">
            <div>
              <h2 className="t-h2" dir="auto">
                {request.title}
              </h2>
              <p className="t-small desk-muted">
                {t('requests.desk.from', {
                  customer: request.customer.clientName ?? request.customer.name,
                  when: fullDateTime(request.requestedAt, locale),
                })}{' '}
                · {t(`requests.lang.${request.lang}`)}
              </p>
            </div>
            <StatusChip status={request.status} />
          </div>

          {request.status === 'ARCHIVED' && request.archivedReason ? (
            <p className="t-small request-reason" dir="auto">
              {t('requests.desk.archivedNote', { reason: request.archivedReason })}
            </p>
          ) : null}

          {request.status === 'ACTIVE' ? (
            <p className="t-small">
              {t('requests.desk.converted')}{' '}
              {request.contractId ? (
                <Link to={lp(locale, `/desk/contracts/${request.contractId}`)}>{t('requests.desk.openContract')}</Link>
              ) : null}
            </p>
          ) : null}

          {request.status === 'REQUESTED' && canAuthor ? (
            <div className="workspace-row">
              <Link className="btn btn-primary btn-sm" to={lp(locale, `/desk/contracts?request=${request.id}`)}>
                {t('requests.desk.convert')}
              </Link>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => setArchiveOpen((v) => !v)}>
                {t('requests.desk.archive')}
              </button>
            </div>
          ) : null}

          {archiveOpen && request.status === 'REQUESTED' ? (
            <form className="card editor-card auth-form" onSubmit={onArchive}>
              <p className="t-eyebrow">{t('requests.desk.archiveTitle')}</p>
              <div className="field">
                <label className="label" htmlFor="archive-reason">
                  {t('requests.desk.archiveReasonLabel')}
                </label>
                <textarea
                  id="archive-reason"
                  className="textarea"
                  rows={3}
                  required
                  dir="auto"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              {archiveError ? <p className="error">{archiveError}</p> : null}
              <div>
                <button className="btn btn-primary btn-sm" type="submit" disabled={archiving || !reason.trim()}>
                  {t('requests.desk.archiveConfirm')}
                </button>
              </div>
            </form>
          ) : null}

          <section className="card editor-card">
            <RequestThread request={request} meId={me.id} canPost={canAuthor} />
          </section>
        </>
      )}
    </div>
  );
}
