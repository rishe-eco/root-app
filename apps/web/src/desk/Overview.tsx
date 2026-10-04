import { useQuery } from '@apollo/client';
import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ACTIVITY,
  ALL_CONTRACT_STATUS_COUNTS,
  NEEDS_ROOT_QUEUE,
  OVERDUE_DEPENDENCIES,
  type ActivityItem,
  type NeedsRootEntry,
  type StatusCount,
  type DependencyWithProject,
  type User,
} from '@/lib/queries';
import { ALL_STATUSES, formatCount, pick, relativeTime } from '@/lib/format';
import { logText } from '@/lib/changelog';
import StatusBadge from '@/components/StatusBadge';

/**
 * V4's screen: what the desk answers without clicking into anything. Four
 * panels, all four gated on `contracts.readAll` (journeys build plan S1) —
 * `allContractStatusCounts`, `needsRootQueue`, `activity` and
 * `overdueDependencies` are the sales/whole-book view of the desk, and design
 * and development hold only `contracts.readActive`.
 *
 * **J12 moved the desk's home to My work** (`DeskHome`, `MyWork.tsx`) and gave
 * this section the one capability that reads the whole book, so nobody else
 * lands here: the nav row is `contracts.readAll`, and a typed URL from anyone
 * without it is sent to My work rather than shown four empty panels. The tiles
 * still count `Contract.status` — what sales *set* — while the **Needs-Root
 * queue is read from the attention module**: a contract is in it because Root
 * owes something on it, not because its status says so.
 */
export default function Overview() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const allowed = can(me, 'contracts.readAll');

  const { data: countsData } = useQuery<{ allContractStatusCounts: StatusCount[] }>(
    ALL_CONTRACT_STATUS_COUNTS,
    { skip: !allowed },
  );
  const { data: queueData } = useQuery<{ needsRootQueue: NeedsRootEntry[] }>(NEEDS_ROOT_QUEUE, {
    skip: !allowed,
  });
  const { data: activityData } = useQuery<{ activity: ActivityItem[] }>(ACTIVITY, {
    variables: { reviewOnly: true },
    skip: !allowed,
  });
  // Build plan L5: "overdue surfaces on both dashboards" — this is the
  // staff half, both sides at once, so Root's own slippage is exactly as
  // visible here as a customer's (spec §7's symmetry).
  const { data: dependenciesData } = useQuery<{ overdueDependencies: DependencyWithProject[] }>(
    OVERDUE_DEPENDENCIES,
    { skip: !allowed },
  );

  const counts = new Map(
    (countsData?.allContractStatusCounts ?? []).map((c) => [c.status, c.count] as const),
  );
  const queue = queueData?.needsRootQueue ?? [];
  const activity = activityData?.activity ?? [];
  const overdueDependencies = dependenciesData?.overdueDependencies ?? [];

  // The whole book's view is `contracts.readAll`'s. Anyone else who types the URL is sent
  // to their own home (J12; until then this branch listed the two surfaces a designer or
  // developer had, because Overview was where everyone landed).
  if (!allowed) return <Navigate to={lp(locale, '/desk/work')} replace />;

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
              {/* Re-pointed by J12: a row is a contract Root owes something on, read from the
                  attention module — `since` is the oldest thing owed, `count` how many are —
                  and not a contract whose status says "waiting on Root". */}
              {queue.map(({ contract: c, since, count }) => (
                <Link key={c.id} className="queue-row" to={lp(locale, `/desk/contracts/${c.id}`)} data-testid="needs-root-row">
                  <div className="queue-row-main">
                    <span className="t-small queue-row-title">{pick(c, 'title', locale)}</span>
                    <span className="t-caption desk-muted">
                      {c.customerName} · <span className="num-latin">{c.ref}</span>
                    </span>
                  </div>
                  <div className="queue-row-end">
                    <span className="badge">{t('desk.needsRootOwed', { count, n: formatCount(count, locale) })}</span>
                    <span className="t-caption desk-muted">{relativeTime(since, locale)}</span>
                  </div>
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

        {/* Build plan L5, spec §7: the full dependency board, both sides —
            Root's own overdue commitments surface here exactly like a
            customer's, never a panel that can only nag one side. */}
        <section className="rail-card">
          <p className="rail-cap">{t('desk.overdueDependenciesTitle')}</p>
          {overdueDependencies.length === 0 ? (
            <p className="t-small desk-muted">{t('desk.overdueDependenciesEmpty')}</p>
          ) : (
            <div className="queue-list">
              {/* Not a Link: a Dependency names its Project, not a Contract,
                  and this dashboard has no contract id to route to — see
                  docs/development/L5.md on why a project can outlive the
                  one contract this codebase still assumes it has. */}
              {overdueDependencies.map((dep) => (
                <div key={dep.id} className="queue-row">
                  <div className="queue-row-main">
                    <span className="t-small">
                      <span className="badge">{t(`workspace.dependencySide.${dep.side}`)}</span> {pick(dep, 'title', locale)}
                    </span>
                    <span className="t-caption desk-muted">
                      {dep.project.customer.clientName ?? dep.project.customer.name} · {pick(dep.project, 'title', locale)}
                    </span>
                  </div>
                  <span className="t-caption desk-muted">{relativeTime(dep.dueAt, locale)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
