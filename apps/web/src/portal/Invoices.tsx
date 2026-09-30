import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import {
  MY_INVOICES,
  MY_BILLING_REPORT,
  MY_SUBSCRIPTIONS,
  type BillingEntry,
  type BillingReport,
  type Subscription,
  type User,
} from '@/lib/queries';
import { calendarDate, formatAmount, pick } from '@/lib/format';
import Topbar from './Topbar';

/**
 * The portal's invoices (build plan L6, grown by journeys build plan J13 from
 * «Billing» into «Invoices»; `/app/billing` redirects here). `myInvoices` is
 * **issued invoices only** — a draft is not filtered out of this list, it is
 * never selected by the API — and `myInvoices`/`myBillingReport` both lazily
 * catch up the caller's own subscriptions first (lib/billing.ts), so opening
 * this screen is itself "billing being opened", the trigger the scheduler
 * decision (L6.md §0) turns on.
 *
 * Each row opens the single invoice (`InvoiceDetail`), the printable one.
 * There is no pay button: Root is paid outside the portal, and the invoice says
 * how in words (the no-gateway boundary).
 */

export function originLabel(entry: BillingEntry, locale: 'fa' | 'en'): string | null {
  if (entry.subscription) return pick(entry.subscription, 'label', locale);
  if (entry.ticket) return entry.ticket.subject;
  if (entry.phase?.milestoneLabel) return entry.phase.milestoneLabel;
  if (entry.contract) return entry.contract.ref;
  return null;
}

/** Paid, overdue or still to pay — the customer's three, from the API's own
 *  derived `overdue` (never re-derived from the clock here). */
export function invoiceStanding(entry: Pick<BillingEntry, 'paidAt' | 'overdue'>): 'paid' | 'overdue' | 'due' {
  return entry.paidAt ? 'paid' : entry.overdue ? 'overdue' : 'due';
}

export default function Invoices() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const { data, loading, error, refetch } = useQuery<{ myInvoices: BillingEntry[] }>(MY_INVOICES);
  const { data: reportData } = useQuery<{ myBillingReport: BillingReport }>(MY_BILLING_REPORT);
  const { data: subsData } = useQuery<{ mySubscriptions: Subscription[] }>(MY_SUBSCRIPTIONS);

  const entries = data?.myInvoices ?? [];
  const report = reportData?.myBillingReport ?? null;
  const subscriptions = subsData?.mySubscriptions ?? [];

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{t('portal.navBilling')}</h1>} />
      <div className="content">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('invoices.title')}</h1>
            <p className="t-lead">{t('invoices.lede')}</p>
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
          <div className="empty" data-testid="invoices-empty">
            {t('invoices.empty')}
          </div>
        ) : (
          <div className="editor-list" data-testid="invoice-list">
            {entries.map((entry) => {
              const origin = originLabel(entry, locale);
              const standing = invoiceStanding(entry);
              return (
                <div className="card editor-card" key={entry.id} data-testid="invoice-row">
                  <div className="workspace-row">
                    <span className="badge num-latin" data-testid="invoice-number">
                      {entry.invoiceNumber}
                    </span>
                    <span className="t-small" style={{ flex: 1 }}>
                      {pick(entry, 'description', locale)}
                      {origin ? ` — ${origin}` : ''}
                    </span>
                    <span className="t-small">{t('billing.toman', { amount: formatAmount(entry.amount, locale) })}</span>
                    <span
                      className={`badge ${standing === 'paid' ? 'ticket-status-resolved' : standing === 'overdue' ? 'dependency-overdue-badge' : 'ticket-status-open'}`}
                      data-testid="invoice-status"
                      data-standing={standing}
                    >
                      {t(`invoices.status.${standing}`)}
                    </span>
                    <Link className="btn btn-secondary btn-sm" to={lp(locale, `/app/invoices/${entry.id}`)}>
                      {t('invoices.open')}
                    </Link>
                  </div>
                  <p className="t-caption muted">
                    {entry.periodStart && entry.periodEnd
                      ? t('billing.period.range', {
                          start: calendarDate(entry.periodStart, locale),
                          end: calendarDate(entry.periodEnd, locale),
                        })
                      : null}
                    {entry.periodStart && entry.periodEnd && entry.dueAt ? ' · ' : null}
                    {entry.dueAt ? t('invoices.dueOn', { date: calendarDate(entry.dueAt, locale) }) : null}
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
