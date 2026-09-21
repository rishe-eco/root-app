import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  ALL_BILLING_ENTRIES,
  BILLING_REPORT,
  ALL_SUBSCRIPTIONS,
  ALL_CUSTOMERS,
  CREATE_BILLING_ENTRY,
  MARK_BILLING_ENTRY_PAID,
  UNMARK_BILLING_ENTRY_PAID,
  CREATE_SUBSCRIPTION,
  END_SUBSCRIPTION,
  type BillingEntry,
  type BillingReport,
  type BillingSource,
  type Subscription,
  type SubscriptionPeriod,
  type User,
} from '@/lib/queries';
import { formatAmount, fullDateTime, pick } from '@/lib/format';

/**
 * The desk's own billing surface (build plan L6; spec §8) — the report
 * across customers, the ledger, and subscription authoring. `contracts.manage`
 * only, same reasoning as every other registry-adjacent section.
 */

const SOURCES: BillingSource[] = ['CONTRACT', 'SERVICE', 'TICKET'];
const PERIODS: SubscriptionPeriod[] = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

function originLabel(entry: BillingEntry, locale: 'fa' | 'en'): string | null {
  if (entry.subscription) return pick(entry.subscription, 'label', locale);
  if (entry.ticket) return entry.ticket.subject;
  if (entry.phase?.milestoneLabel) return entry.phase.milestoneLabel;
  if (entry.contract) return entry.contract.ref;
  return null;
}

function EntryRow({ entry }: { entry: BillingEntry }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [markPaid] = useMutation(MARK_BILLING_ENTRY_PAID);
  const [unmarkPaid] = useMutation(UNMARK_BILLING_ENTRY_PAID);
  const origin = originLabel(entry, locale);

  return (
    <div className="card editor-card">
      <div className="workspace-row">
        <span className="badge">{t(`billing.source.${entry.source}`)}</span>
        <span className="t-small" style={{ flex: 1 }}>
          {pick(entry, 'description', locale)}
          {origin ? ` — ${origin}` : ''}
        </span>
        <span className="t-caption">{entry.customer.clientName ?? entry.customer.name}</span>
        <span className="t-small">{t('billing.toman', { amount: formatAmount(entry.amount, locale) })}</span>
        <span className="t-caption muted">{fullDateTime(entry.issuedAt, locale)}</span>
        {entry.paidAt ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => unmarkPaid({ variables: { entryId: entry.id } })}>
            {t('billing.markUnpaid')}
          </button>
        ) : (
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => markPaid({ variables: { entryId: entry.id } })}>
            {t('billing.markPaid')}
          </button>
        )}
      </div>
    </div>
  );
}

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [end, { loading }] = useMutation(END_SUBSCRIPTION);
  const [ending, setEnding] = useState(false);
  const [activeUntil, setActiveUntil] = useState('');

  async function onEnd(e: FormEvent) {
    e.preventDefault();
    if (!activeUntil) return;
    await end({ variables: { subscriptionId: sub.id, activeUntil: new Date(activeUntil).toISOString() } });
    setEnding(false);
  }

  return (
    <div className="card editor-card">
      <div className="workspace-row">
        <span className="t-small" style={{ flex: 1 }}>
          {pick(sub, 'label', locale)}
        </span>
        <span className="t-caption">{sub.customer.clientName ?? sub.customer.name}</span>
        <span className="t-small">
          {t('billing.toman', { amount: formatAmount(sub.amount, locale) })} · {t(`billing.period.${sub.period}`)}
        </span>
        {sub.activeUntil ? (
          <span className="badge">{t('billing.subscriptionEndedOn', { date: fullDateTime(sub.activeUntil, locale) })}</span>
        ) : ending ? null : (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEnding(true)}>
            {t('billing.endSubscription')}
          </button>
        )}
      </div>
      {ending && !sub.activeUntil ? (
        <form className="workspace-row" onSubmit={onEnd}>
          <input className="input num-latin" type="date" required value={activeUntil} onChange={(e) => setActiveUntil(e.target.value)} />
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
            {t('billing.endSubscription')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEnding(false)}>
            {t('feedback.cancel')}
          </button>
        </form>
      ) : null}
    </div>
  );
}

export default function Billing() {
  const { t } = useTranslation();
  const locale = useLocale();

  const [customerId, setCustomerId] = useState<string>('');
  const [addingEntry, setAddingEntry] = useState(false);
  const [addingSub, setAddingSub] = useState(false);

  const { data: customersData } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS);
  const { data, loading, error, refetch } = useQuery<{ allBillingEntries: BillingEntry[] }>(ALL_BILLING_ENTRIES, {
    variables: { customerId: customerId || null },
  });
  const { data: reportData } = useQuery<{ billingReport: BillingReport }>(BILLING_REPORT, {
    variables: { customerId: customerId || null },
  });
  const { data: subsData } = useQuery<{ allSubscriptions: Subscription[] }>(ALL_SUBSCRIPTIONS, {
    variables: { customerId: customerId || null },
  });

  const [createEntry, { loading: creatingEntry }] = useMutation(CREATE_BILLING_ENTRY, {
    onCompleted: () => refetch(),
  });
  const [createSub, { loading: creatingSub }] = useMutation(CREATE_SUBSCRIPTION);

  const [entryCustomerId, setEntryCustomerId] = useState('');
  const [source, setSource] = useState<BillingSource>('CONTRACT');
  const [descriptionFa, setDescriptionFa] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [amount, setAmount] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);

  const [subCustomerId, setSubCustomerId] = useState('');
  const [subLabelFa, setSubLabelFa] = useState('');
  const [subLabelEn, setSubLabelEn] = useState('');
  const [subAmount, setSubAmount] = useState('');
  const [subPeriod, setSubPeriod] = useState<SubscriptionPeriod>('MONTHLY');
  const [subActiveFrom, setSubActiveFrom] = useState('');
  const [subError, setSubError] = useState<string | null>(null);

  const customers = customersData?.allCustomers ?? [];
  const entries = data?.allBillingEntries ?? [];
  const report = reportData?.billingReport ?? null;
  const subscriptions = subsData?.allSubscriptions ?? [];

  async function onAddEntry(e: FormEvent) {
    e.preventDefault();
    setEntryError(null);
    if (!entryCustomerId || !descriptionFa.trim() || !descriptionEn.trim() || !amount.trim()) return;
    try {
      await createEntry({
        variables: {
          customerId: entryCustomerId,
          source,
          descriptionFa: descriptionFa.trim(),
          descriptionEn: descriptionEn.trim(),
          amount: amount.trim(),
        },
      });
      setDescriptionFa('');
      setDescriptionEn('');
      setAmount('');
      setAddingEntry(false);
    } catch (err) {
      setEntryError((err as Error).message);
    }
  }

  async function onAddSub(e: FormEvent) {
    e.preventDefault();
    setSubError(null);
    if (!subCustomerId || !subLabelFa.trim() || !subLabelEn.trim() || !subAmount.trim() || !subActiveFrom) return;
    try {
      await createSub({
        variables: {
          customerId: subCustomerId,
          labelFa: subLabelFa.trim(),
          labelEn: subLabelEn.trim(),
          amount: subAmount.trim(),
          period: subPeriod,
          activeFrom: new Date(subActiveFrom).toISOString(),
        },
      });
      setSubLabelFa('');
      setSubLabelEn('');
      setSubAmount('');
      setSubActiveFrom('');
      setAddingSub(false);
    } catch (err) {
      setSubError((err as Error).message);
    }
  }

  return (
    <div className="desk-section">
      <div className="content-head">
        <div>
          <h2 className="t-h2">{t('desk.billing.title')}</h2>
          <p className="t-lead">{t('desk.billing.lede')}</p>
        </div>
        <div className="field">
          <label className="label">{t('desk.billing.customerFilter')}</label>
          <select className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{t('desk.billing.allCustomers')}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.clientName ?? c.name}
              </option>
            ))}
          </select>
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

      <div className="workspace-row">
        <h3 className="t-h3">{t('desk.billing.subscriptionsTitle')}</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingSub((v) => !v)}>
          {t('desk.billing.addSubscription')}
        </button>
      </div>

      {addingSub ? (
        <form className="card editor-card auth-form" onSubmit={onAddSub}>
          <div className="field">
            <label className="label">{t('desk.billing.customerLabel')}</label>
            <select className="input" required value={subCustomerId} onChange={(e) => setSubCustomerId(e.target.value)}>
              <option value="" disabled>
                {t('desk.billing.selectCustomer')}
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.clientName ?? c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={subLabelFa} onChange={(e) => setSubLabelFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={subLabelEn} onChange={(e) => setSubLabelEn(e.target.value)} />
            </div>
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('billing.amountLabel')}</label>
              <input className="input num-latin" required inputMode="numeric" value={subAmount} onChange={(e) => setSubAmount(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('billing.periodLabel')}</label>
              <select className="input" value={subPeriod} onChange={(e) => setSubPeriod(e.target.value as SubscriptionPeriod)}>
                {PERIODS.map((p) => (
                  <option key={p} value={p}>
                    {t(`billing.period.${p}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="label">{t('billing.activeFromLabel')}</label>
            <input className="input num-latin" type="date" required value={subActiveFrom} onChange={(e) => setSubActiveFrom(e.target.value)} />
          </div>
          {subError ? <p className="error">{subError}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={creatingSub}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      {subscriptions.length > 0 ? (
        <div className="editor-list">
          {subscriptions.map((s) => (
            <SubscriptionRow key={s.id} sub={s} />
          ))}
        </div>
      ) : (
        <p className="t-small muted">{t('desk.billing.subscriptionsEmpty')}</p>
      )}

      <div className="workspace-row">
        <h3 className="t-h3">{t('desk.billing.entriesTitle')}</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingEntry((v) => !v)}>
          {t('desk.billing.addEntry')}
        </button>
      </div>

      {addingEntry ? (
        <form className="card editor-card auth-form" onSubmit={onAddEntry}>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('desk.billing.customerLabel')}</label>
              <select className="input" required value={entryCustomerId} onChange={(e) => setEntryCustomerId(e.target.value)}>
                <option value="" disabled>
                  {t('desk.billing.selectCustomer')}
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.clientName ?? c.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">{t('billing.sourceLabel')}</label>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value as BillingSource)}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {t(`billing.source.${s}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={descriptionFa} onChange={(e) => setDescriptionFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={descriptionEn} onChange={(e) => setDescriptionEn(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label">{t('billing.amountLabel')}</label>
            <input className="input num-latin" required inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          {entryError ? <p className="error">{entryError}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={creatingEntry}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
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
        <div className="empty">{t('desk.billing.entriesEmpty')}</div>
      ) : (
        <div className="editor-list">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  );
}
