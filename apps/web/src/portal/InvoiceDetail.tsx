import { Link, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { dirOf } from '@/i18n';
import { INVOICE, type BillingEntry, type User } from '@/lib/queries';
import { calendarDate, formatAmount, formatCount, fullDateTime, pick } from '@/lib/format';
import { invoiceStanding, originLabel } from './Invoices';

/**
 * One invoice (journeys build plan J13), and the page a customer turns into
 * paper. It is built the way `ContractPrint` is built and wears the same
 * `print.css` — the `.printview` frame, the `.doc` sheet, `doc-*` for its parts
 * — so the app's chrome (`.side`, `.topbar`, `.printbar`) is hidden at print
 * time by rules that already exist, and the document is plain, near
 * monochrome, and mirrors for Persian without a second stylesheet. There is
 * deliberately no server-side render behind it, for `ContractPrint`'s reason.
 *
 * **What it says:** what it is for, **what it waited on** (the plan's own
 * conditions: the agreement signed, the invoice before it paid, a phase
 * accepted — read off the plan row it came from and its phase), the amount, the
 * days it was issued and is due, and when it was paid. **What it does not
 * have:** a pay button. Root is paid outside the portal, and the page says how
 * in words (`invoices.howToPay`) — the no-gateway boundary is a sentence here,
 * not a control. The invoice number is Latin in both languages (house rule 14),
 * the amount and dates in the locale's own digits.
 *
 * The API answers `NOT_FOUND` for a draft, someone else's invoice and a missing
 * id alike, so this screen has one "no such invoice" state and cannot tell them
 * apart either.
 */
export default function InvoiceDetail() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { id = '' } = useParams();

  const { data, loading, error } = useQuery<{ invoice: BillingEntry }>(INVOICE, { variables: { id } });

  const back = (
    <Link className="btn btn-ghost btn-sm" to={lp(locale, '/app/invoices')}>
      {t('invoices.backToList')}
    </Link>
  );

  if (loading && !data) return <div className="content">{t('portal.loading')}</div>;

  const entry = data?.invoice;
  if (error || !entry) {
    return (
      <div className="content">
        <div className="empty" data-testid="invoice-not-found">
          <p className="t-small">{t('invoices.notFound')}</p>
          {back}
        </div>
      </div>
    );
  }

  const standing = invoiceStanding(entry);
  const origin = originLabel(entry, locale);
  const client = me.clientName ?? me.name;
  const plan = entry.plannedInvoice;

  /*
   * What it waited on, from the plan row: the first row waited on the
   * signature, every later one on the payment before it, and a row tied to a
   * phase also on that phase's acceptance. An invoice that did not come from a
   * plan waited on nothing — it says so rather than leaving the section blank.
   */
  const waitedOn: string[] = [];
  if (plan) {
    waitedOn.push(plan.ordinal === 1 ? t('invoices.waitedOn.signed') : t('invoices.waitedOn.previous'));
    if (entry.phase) waitedOn.push(t('invoices.waitedOn.phase', { n: formatCount(entry.phase.number, locale) }));
  } else {
    waitedOn.push(t('invoices.waitedOn.direct'));
  }

  const fact = (label: string, value: string, opts: { latin?: boolean; testid?: string } = {}) => (
    <div className="doc-fact">
      <dt>{label}</dt>
      <dd className={opts.latin ? 'num-latin' : undefined} data-testid={opts.testid}>
        {value}
      </dd>
    </div>
  );

  return (
    <div className="printview" data-testid="invoice-detail">
      {/* Screen only — a toolbar has no business on the paper. */}
      <div className="printbar">
        {back}
        <button className="btn btn-primary btn-sm" type="button" onClick={() => window.print()}>
          {t('print.cta')}
        </button>
        <span className="t-caption printbar-hint">{t('print.hint')}</span>
      </div>

      <article className="doc" lang={locale} dir={dirOf(locale)}>
        <header className="doc-head">
          <div className="doc-brand">
            <span className="dot" />
            {t('brand.main')} <span className="doc-brand-sub">{t('brand.sub')}</span>
          </div>
          <div className="doc-kind">{t('invoices.kind')}</div>
        </header>

        <h1 className="doc-title">{pick(entry, 'description', locale)}</h1>

        <dl className="doc-facts">
          {fact(t('invoices.factNumber'), entry.invoiceNumber ?? '', { latin: true, testid: 'invoice-detail-number' })}
          {origin ? fact(t('invoices.factFor'), origin) : null}
          {/* Not num-latin (persian-pass.md §1.2): money is already run through
              formatAmount into the locale's own digits. */}
          {fact(t('invoices.factAmount'), t('print.toman', { amount: formatAmount(entry.amount, locale) }), {
            testid: 'invoice-detail-amount',
          })}
          {entry.issuedAt ? fact(t('invoices.factIssued'), fullDateTime(entry.issuedAt, locale)) : null}
          {entry.dueAt ? fact(t('invoices.factDue'), calendarDate(entry.dueAt, locale), { testid: 'invoice-detail-due' }) : null}
          {entry.paymentTermDays !== null
            ? fact(t('invoices.factTerm'), t('invoices.term', { n: formatCount(entry.paymentTermDays, locale) }))
            : null}
          {fact(
            t('invoices.factPaid'),
            entry.paidAt ? fullDateTime(entry.paidAt, locale) : standing === 'overdue' ? t('invoices.status.overdue') : t('invoices.unpaid'),
            { testid: 'invoice-detail-paid' },
          )}
        </dl>

        <section className="doc-sec doc-parties">
          <div className="doc-party">
            <span className="doc-party-role">{t('invoices.issuedBy')}</span>
            <span className="doc-party-name">{t('brand.main')}</span>
          </div>
          <div className="doc-party">
            <span className="doc-party-role">{t('invoices.billedTo')}</span>
            <span className="doc-party-name">{client}</span>
          </div>
        </section>

        <section className="doc-sec">
          <h2 className="doc-h">{t('invoices.waitedOnTitle')}</h2>
          <ul className="doc-list" data-testid="invoice-waited-on">
            {waitedOn.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="doc-sec">
          <h2 className="doc-h">{t('invoices.howToPayTitle')}</h2>
          <p className="doc-art-body" data-testid="invoice-how-to-pay">
            {t('invoices.howToPay')}
          </p>
        </section>

        <p className="doc-art-meta">{t('invoices.numberingNote')}</p>
      </article>
    </div>
  );
}
