import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  MY_BILLING_ENTRIES,
  MY_BILLING_REPORT,
  MY_SUBSCRIPTIONS,
  type BillingEntry,
  type BillingReport,
  type Subscription,
  type User,
} from '@/lib/queries';
import { formatAmount, fullDateTime, pick } from '@/lib/format';
import Topbar from './Topbar';

/**
 * The portal's `billing` rail item, going live (build plan L6; spec §8).
 * `myBillingEntries`/`myBillingReport` both lazily catch up the caller's own
 * subscriptions before returning (lib/billing.ts) — opening this screen is
 * itself "billing being opened," the trigger the scheduler decision (L6.md
 * §0) turns on.
 */

function originLabel(entry: BillingEntry, locale: string): string | null {
  if (entry.subscription) return pick(entry.subscription, 'label', locale as 'fa' | 'en');
  if (entry.ticket) return entry.ticket.subject;
  if (entry.phase?.milestoneLabel) return entry.phase.milestoneLabel;
  if (entry.contract) return entry.contract.ref;
  return null;
}

export default function Billing() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const { data, loading, error, refetch } = useQuery<{ myBillingEntries: BillingEntry[] }>(MY_BILLING_ENTRIES);
  const { data: reportData } = useQuery<{ myBillingReport: BillingReport }>(MY_BILLING_REPORT);
  const { data: subsData } = useQuery<{ mySubscriptions: Subscription[] }>(MY_SUBSCRIPTIONS);

  const entries = data?.myBillingEntries ?? [];
  const report = reportData?.myBillingReport ?? null;
  const subscriptions = subsData?.mySubscriptions ?? [];

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{t('portal.navBilling')}</h1>} />
      <div className="content">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('billing.pageTitle')}</h1>
            <p className="t-lead">{t('billing.pageLede')}</p>
          </div>
        </div>

        {report ? (
          <div className="tile-row">
            <div className="tile">
              <span className="tile-count">{formatAmount(report.totalIssued, locale)}</span>
              <span className="tile-label">{t('billing.totalIssued')}</span>
            </div>
            <div className="tile">
              <span className="tile-count">{formatAmount(report.totalPaid, locale)}</span>
              <span className="tile-label">{t('billing.totalPaid')}</span>
            </div>
            <div className="tile">
              <span className="tile-count">{formatAmount(report.totalOutstanding, locale)}</span>
              <span className="tile-label">{t('billing.totalOutstanding')}</span>
            </div>
          </div>
        ) : null}

        {subscriptions.length > 0 ? (
          <>
            <h2 className="t-h3">{t('billing.subscriptionsTitle')}</h2>
            <div className="editor-list">
              {subscriptions.map((s) => (
                <div className="card editor-card" key={s.id}>
                  <div className="workspace-row">
                    <span className="t-small" style={{ flex: 1 }}>
                      {pick(s, 'label', locale)}
                    </span>
                    <span className="t-small">
                      {t('billing.toman', { amount: formatAmount(s.amount, locale) })} · {t(`billing.period.${s.period}`)}
                    </span>
                    {s.activeUntil ? <span className="badge">{t('billing.subscriptionEnded')}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <h2 className="t-h3">{t('billing.entriesTitle')}</h2>
        {error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading && entries.length === 0 ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : entries.length === 0 ? (
          <div className="empty">{t('billing.empty')}</div>
        ) : (
          <div className="editor-list">
            {entries.map((entry) => {
              const origin = originLabel(entry, locale);
              return (
                <div className="card editor-card" key={entry.id}>
                  <div className="workspace-row">
                    <span className="badge">{t(`billing.source.${entry.source}`)}</span>
                    <span className="t-small" style={{ flex: 1 }}>
                      {pick(entry, 'description', locale)}
                      {origin ? ` — ${origin}` : ''}
                    </span>
                    <span className="t-small">{t('billing.toman', { amount: formatAmount(entry.amount, locale) })}</span>
                    <span className={`badge ${entry.paidAt ? 'ticket-status-resolved' : 'ticket-status-open'}`}>
                      {entry.paidAt ? t('billing.paid') : t('billing.outstanding')}
                    </span>
                  </div>
                  <p className="t-caption muted">
                    {entry.periodStart && entry.periodEnd
                      ? t('billing.period.range', {
                          start: fullDateTime(entry.periodStart, locale),
                          end: fullDateTime(entry.periodEnd, locale),
                        })
                      : fullDateTime(entry.issuedAt, locale)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
