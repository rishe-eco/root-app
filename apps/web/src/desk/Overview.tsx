import { useQuery } from '@apollo/client';
import { Link, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ACTIVITY,
  ALL_CONTRACT_STATUS_COUNTS,
  NEEDS_ROOT_QUEUE,
  type ActivityItem,
  type ContractRef,
  type StatusCount,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, formatCount, pick, relativeTime } from '@/lib/format';
import { logText } from '@/lib/changelog';
import StatusBadge from '@/components/StatusBadge';

/**
 * V4's screen: what the desk answers without clicking into anything. Three
 * independent panels, each its own query — a reviewer without
 * `contracts.manage` sees this route (F3's nav is capability: null for it)
 * but not this data, the same `skip` pattern DeskContracts already uses
 * rather than a page full of FORBIDDEN errors.
 *
 * T4: an empty Overview on a system with few contracts is accurate. Nothing
 * here is seeded to look busier than it is.
 */
export default function Overview() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const allowed = can(me, 'contracts.manage');

  const { data: countsData } = useQuery<{ allContractStatusCounts: StatusCount[] }>(
    ALL_CONTRACT_STATUS_COUNTS,
    { skip: !allowed },
  );
  const { data: queueData } = useQuery<{ needsRootQueue: ContractRef[] }>(NEEDS_ROOT_QUEUE, {
    skip: !allowed,
  });
  const { data: activityData } = useQuery<{ activity: ActivityItem[] }>(ACTIVITY, {
    variables: { reviewOnly: true },
    skip: !allowed,
  });

  const counts = new Map(
    (countsData?.allContractStatusCounts ?? []).map((c) => [c.status, c.count] as const),
  );
  const queue = queueData?.needsRootQueue ?? [];
  const activity = activityData?.activity ?? [];

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.navOverview')}</h2>

      <div className="tile-row">
        {ALL_STATUSES.map((s) => (
          <div className="tile" key={s}>
            {/* Not num-latin: T6 wants the count in the locale's own digits
                (formatCount already runs it through Intl.NumberFormat), and
                num-latin would force the Latin figure font onto them. */}
            <span className="tile-count">{formatCount(counts.get(s) ?? 0, locale)}</span>
            <span className="tile-label">{t(`status.${s}`)}</span>
          </div>
        ))}
      </div>

      <div className="overview-grid">
        <section className="rail-card">
          <p className="rail-cap">{t('desk.needsRootTitle')}</p>
          {queue.length === 0 ? (
            <p className="t-small desk-muted">{t('desk.needsRootEmpty')}</p>
          ) : (
            <div className="queue-list">
              {queue.map((c) => (
                <Link key={c.id} className="queue-row" to={lp(locale, `/desk/contracts/${c.id}`)}>
                  <div className="queue-row-main">
                    <span className="t-small queue-row-title">{pick(c, 'title', locale)}</span>
                    <span className="t-caption desk-muted">
                      {c.customerName} · <span className="num-latin">{c.ref}</span>
                    </span>
                  </div>
                  <span className="t-caption desk-muted">{relativeTime(c.statusChangedAt, locale)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="rail-card">
          <p className="rail-cap">{t('desk.reviewQueueTitle')}</p>
          {activity.length === 0 ? (
            <p className="t-small desk-muted">{t('desk.reviewQueueEmpty')}</p>
          ) : (
            <div className="queue-list">
              {activity.map((item) => (
                <Link
                  key={item.id}
                  className="queue-row"
                  to={lp(locale, `/desk/contracts/${item.contract.id}`)}
                >
                  <div className="queue-row-main">
                    <span className="t-small">
                      {item.actor.name} — {logText(item, t)}
                    </span>
                    <span className="t-caption desk-muted">{pick(item.contract, 'title', locale)}</span>
                  </div>
                  <div className="queue-row-end">
                    {/* No read/unread flag (V4.md §3) — the contract's
                        current status is the dismissal signal instead: an
                        entry whose contract has since moved on has visibly
                        been handled. */}
                    <StatusBadge status={item.contract.status} />
                    <span className="t-caption desk-muted">{relativeTime(item.createdAt, locale)}</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
