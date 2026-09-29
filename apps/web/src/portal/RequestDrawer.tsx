import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { REQUEST, type Request } from '@/lib/queries';
import RequestThread from '@/components/RequestThread';

/**
 * The customer's chat about one request (journeys build plan J2) — a drawer
 * over the contracts list, opened by a row or by a notification's link
 * (`?request=<id>`).
 *
 * **No websocket** (the plan's line): the conversation is fresh when the
 * drawer opens (`cache-and-network` refetches on mount, showing the cached
 * copy meanwhile) and again whenever the window regains focus — which is when
 * someone who left for their email, to read that Root has replied, comes
 * back. The cost is that a reply written while this tab stays in front
 * arrives at the next focus or reopen; for a conversation measured in hours,
 * that is the right trade.
 */
export default function RequestDrawer({
  requestId,
  meId,
  onClose,
}: {
  requestId: string;
  meId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  const { data, loading, error, refetch } = useQuery<{ request: Request | null }>(REQUEST, {
    variables: { projectId: requestId },
    fetchPolicy: 'cache-and-network',
  });

  useEffect(() => {
    const refresh = () => void refetch();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refetch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const request = data?.request ?? null;

  return (
    <div className="overlay overlay-drawer">
      <div className="overlay-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="request-drawer-title">
        <div className="drawer-head">
          <div>
            <p className="t-eyebrow">{t('requests.sectionTitle')}</p>
            <h2 className="t-h3" id="request-drawer-title" dir="auto">
              {request?.title ?? ''}
            </h2>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            {t('requests.close')}
          </button>
        </div>

        {request ? (
          <>
            {request.status === 'ARCHIVED' && request.archivedReason ? (
              <p className="t-small request-reason" dir="auto">
                {t('requests.archivedBecause', { reason: request.archivedReason })}
              </p>
            ) : null}
            {request.status === 'ACTIVE' && request.contractId ? (
              <Link className="btn btn-secondary btn-sm" to={lp(locale, `/app/contracts/${request.contractId}`)}>
                {t('requests.viewContract')}
              </Link>
            ) : null}
            <RequestThread request={request} meId={meId} canPost />
          </>
        ) : error && !loading ? (
          <div className="empty">
            <p className="t-small">{t('requests.error.NOT_FOUND')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => void refetch()}>
              {t('requests.retry')}
            </button>
          </div>
        ) : (
          <div className="empty">{t('requests.loading')}</div>
        )}
      </aside>
    </div>
  );
}
