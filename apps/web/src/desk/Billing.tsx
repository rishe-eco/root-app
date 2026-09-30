import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  ALL_BILLING_ENTRIES,
  BILLING_REPORT,
  ALL_SUBSCRIPTIONS,
  ALL_CUSTOMERS,
  CREATE_INVOICE_DRAFT,
  ISSUE_INVOICE,
  DELETE_INVOICE_DRAFT,
  CONTRACTS_WITH_PAYMENT_PLAN,
  ISSUE_PLANNED_INVOICE,
  MARK_BILLING_ENTRY_PAID,
  UNMARK_BILLING_ENTRY_PAID,
  CREATE_SUBSCRIPTION,
  END_SUBSCRIPTION,
  type BillingEntry,
  type BillingReport,
  type BillingSource,
  type PlanContract,
  type Subscription,
  type SubscriptionPeriod,
  type User,
} from '@/lib/queries';
import { calendarDate, formatAmount, formatCount, fullDateTime, pick } from '@/lib/format';

/**
 * The desk's own billing surface (build plan L6; spec §8) — the report
 * across customers, the ledger, and subscription authoring. `billing.manage`
 * (journeys build plan S1 — before it, `contracts.manage`), the money
 * capability every one of these resolvers now checks; design and development
 * hold neither it nor `money.read` and must not reach this screen at all.
 *
 * **Journeys build plan J13 adds invoices' lifecycle.** Every entry authored
 * here is a *draft* — the customer sees nothing — until *Issue* numbers and
 * dates it; and each contract's payment plan is listed with an *Issue next*
 * that is enabled exactly when the API's own `canIssuePlanned` says the next
 * row may be issued (`PlannedInvoice.state`), with what it is waiting on beside
 * it when it may not. The button reads the state; it does not re-derive it.
 */

const SOURCES: BillingSource[] = ['CONTRACT', 'SERVICE', 'TICKET'];
const PERIODS: SubscriptionPeriod[] = ['MONTHLY', 'QUARTERLY', 'YEARLY'];

/** What every invoice mutation here refreshes: the ledger, the report, and the
 *  plans — a mark-paid can make the next planned invoice issuable, which only
 *  the plan query knows. */
const REFRESH = ['AllBillingEntries', 'BillingReport', 'ContractsWithPaymentPlan'];

/** A refusal in the desk's own words, by code (`desk.billing.error`); the
 *  server's message is the fallback for one nobody has written yet. */
function refusalText(t: (key: string, options?: Record<string, unknown>) => string, err: unknown): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions?.code;
  return code ? t(`desk.billing.error.${code}`, { defaultValue: (err as Error).message }) : (err as Error).message;
}

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
  const [markPaid] = useMutation(MARK_BILLING_ENTRY_PAID, { refetchQueries: REFRESH });
  const [unmarkPaid] = useMutation(UNMARK_BILLING_ENTRY_PAID, { refetchQueries: REFRESH });
  const [issue, { loading: issuing }] = useMutation(ISSUE_INVOICE, { refetchQueries: REFRESH });
  const [deleteDraft] = useMutation(DELETE_INVOICE_DRAFT, { refetchQueries: REFRESH });
  const [error, setError] = useState<string | null>(null);
  const origin = originLabel(entry, locale);
  const draft = entry.issuedAt === null;

  /** Runs one mutation and shows its refusal, if any, on the row it belongs to. */
  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="ledger-row" data-draft={draft ? 'true' : 'false'}>
      <div className="workspace-row">
        <span className="badge">{t(`billing.source.${entry.source}`)}</span>
        {draft ? (
          <span className="badge badge-neutral" data-testid="ledger-draft-badge">
            {t('desk.billing.draft')}
          </span>
        ) : (
          <span className="badge num-latin" data-testid="ledger-number">
            {entry.invoiceNumber}
          </span>
        )}
        <span className="t-small" style={{ flex: 1 }}>
          {pick(entry, 'description', locale)}
          {origin ? ` — ${origin}` : ''}
        </span>
        <span className="t-caption">{entry.customer.clientName ?? entry.customer.name}</span>
        <span className="t-small">{t('billing.toman', { amount: formatAmount(entry.amount, locale) })}</span>
        {entry.issuedAt ? <span className="t-caption muted">{fullDateTime(entry.issuedAt, locale)}</span> : null}
        {entry.dueAt ? (
          <span className="t-caption muted">{t('desk.billing.dueOn', { date: calendarDate(entry.dueAt, locale) })}</span>
        ) : null}
        {entry.overdue ? <span className="badge dependency-overdue-badge">{t('desk.billing.overdue')}</span> : null}
        {draft ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={issuing}
              data-testid="ledger-issue"
              onClick={() => run(() => issue({ variables: { entryId: entry.id } }))}
            >
              {t('desk.billing.issue')}
            </button>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                if (window.confirm(t('desk.billing.confirmDeleteDraft'))) {
                  void run(() => deleteDraft({ variables: { entryId: entry.id } }));
                }
              }}
            >
              {t('desk.billing.deleteDraft')}
            </button>
          </>
        ) : entry.paidAt ? (
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => run(() => unmarkPaid({ variables: { entryId: entry.id } }))}
          >
            {t('billing.markUnpaid')}
          </button>
        ) : (
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            data-testid="ledger-mark-paid"
            onClick={() => run(() => markPaid({ variables: { entryId: entry.id } }))}
          >
            {t('billing.markPaid')}
          </button>
        )}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/**
 * One contract's payment plan, row by row (journeys build plan J13). The
 * rows are issued in order, so "next" is the first row that has no invoice; its
 * **Issue next** is enabled iff the API says that row is `ISSUABLE` — the same
 * `canIssuePlanned` the mutation will refuse on — and otherwise the row's
 * `blockedBy` is written beside the disabled button, so a sales person is
 * never left guessing why. Paying an issued row is here too, since that is
 * what unlocks the next.
 */
function PlanCard({ contract }: { contract: PlanContract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [issue, { loading }] = useMutation(ISSUE_PLANNED_INVOICE, { refetchQueries: ['AllBillingEntries', 'BillingReport'] });
  const [markPaid] = useMutation(MARK_BILLING_ENTRY_PAID, { refetchQueries: REFRESH });
  const [unmarkPaid] = useMutation(UNMARK_BILLING_ENTRY_PAID, { refetchQueries: REFRESH });
  const [error, setError] = useState<string | null>(null);

  const rows = contract.paymentPlan?.invoices ?? [];
  const next = rows.find((r) => r.state === 'ISSUABLE' || r.state === 'NOT_YET_ISSUABLE') ?? null;

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="card editor-card" data-testid="plan-card" data-contract={contract.ref}>
      <div className="workspace-row">
        <span className="badge num-latin">{contract.ref}</span>
        <span className="t-small" style={{ flex: 1 }}>
          {pick(contract, 'title', locale)}
        </span>
        <span className="t-caption">{contract.customer.clientName ?? contract.customer.name}</span>
        <span className="t-small">{t('billing.toman', { amount: formatAmount(contract.paymentPlan?.total ?? '0', locale) })}</span>
      </div>

      <div className="editor-list">
        {rows.map((row) => (
          <div className="workspace-row" key={row.id} data-testid="plan-row" data-state={row.state}>
            <span className="t-caption num-latin">{row.ordinal}</span>
            <span className="t-small" style={{ flex: 1 }}>
              {pick(row, 'label', locale)}
              {row.phaseId ? ` · ${t('desk.billing.phaseTied')}` : ''}
            </span>
            <span className="t-small">{t('billing.toman', { amount: formatAmount(row.amount, locale) })}</span>
            <span className={`badge ${row.state === 'OVERDUE' ? 'dependency-overdue-badge' : ''}`}>{t(`desk.billing.planState.${row.state}`)}</span>
            {row.invoice ? (
              <>
                <span className="badge num-latin">{row.invoice.invoiceNumber}</span>
                {row.invoice.dueAt ? (
                  <span className="t-caption muted">{t('desk.billing.dueOn', { date: calendarDate(row.invoice.dueAt, locale) })}</span>
                ) : null}
                {row.invoice.paidAt ? (
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    onClick={() => run(() => unmarkPaid({ variables: { entryId: row.invoice!.id } }))}
                  >
                    {t('billing.markUnpaid')}
                  </button>
                ) : (
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    data-testid="plan-mark-paid"
                    onClick={() => run(() => markPaid({ variables: { entryId: row.invoice!.id } }))}
                  >
                    {t('billing.markPaid')}
                  </button>
                )}
              </>
            ) : null}
          </div>
        ))}
      </div>

      <div className="workspace-row">
        {next ? (
          <>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              data-testid="issue-next"
              disabled={next.state !== 'ISSUABLE' || loading}
              onClick={() => run(() => issue({ variables: { plannedInvoiceId: next.id } }))}
            >
              {t('desk.billing.issueNext')} ({formatCount(next.ordinal, locale)})
            </button>
            {next.blockedBy ? (
              <span className="t-caption muted" data-testid="issue-blocked">
                {t(`desk.billing.blocked.${next.blockedBy}`)}
              </span>
            ) : null}
          </>
        ) : (
          <span className="t-caption muted">{t('desk.billing.planDone')}</span>
        )}
      </div>
      {error ? <p className="error">{error}</p> : null}
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
  const me = useOutletContext<User>();

  const [customerId, setCustomerId] = useState<string>('');
  const [addingEntry, setAddingEntry] = useState(false);
  const [addingSub, setAddingSub] = useState(false);

  const allowed = can(me, 'billing.manage');
  const { data: customersData } = useQuery<{ allCustomers: User[] }>(ALL_CUSTOMERS, { skip: !allowed });
  const { data, loading, error, refetch } = useQuery<{ allBillingEntries: BillingEntry[] }>(ALL_BILLING_ENTRIES, {
    variables: { customerId: customerId || null },
    skip: !allowed,
  });
  const { data: reportData } = useQuery<{ billingReport: BillingReport }>(BILLING_REPORT, {
    variables: { customerId: customerId || null },
    skip: !allowed,
  });
  const { data: subsData } = useQuery<{ allSubscriptions: Subscription[] }>(ALL_SUBSCRIPTIONS, {
    variables: { customerId: customerId || null },
    skip: !allowed,
  });

  const { data: plansData } = useQuery<{ contractsWithPaymentPlan: PlanContract[] }>(CONTRACTS_WITH_PAYMENT_PLAN, {
    variables: { customerId: customerId || null },
    skip: !allowed,
  });

  // A new entry is a draft (J13): the ledger refetches so it appears at the top,
  // and nothing reaches the customer until it is issued from the row.
  const [createEntry, { loading: creatingEntry }] = useMutation(CREATE_INVOICE_DRAFT, {
    onCompleted: () => refetch(),
  });
  const [createSub, { loading: creatingSub }] = useMutation(CREATE_SUBSCRIPTION);

  const [entryCustomerId, setEntryCustomerId] = useState('');
  const [source, setSource] = useState<BillingSource>('CONTRACT');
  const [descriptionFa, setDescriptionFa] = useState('');
  const [descriptionEn, setDescriptionEn] = useState('');
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);

  const [subCustomerId, setSubCustomerId] = useState('');
  const [subLabelFa, setSubLabelFa] = useState('');
  const [subLabelEn, setSubLabelEn] = useState('');
  const [subAmount, setSubAmount] = useState('');
  const [subPeriod, setSubPeriod] = useState<SubscriptionPeriod>('MONTHLY');
  const [subActiveFrom, setSubActiveFrom] = useState('');
  const [subError, setSubError] = useState<string | null>(null);

  if (!allowed) return <Navigate to={lp(locale, '/desk')} replace />;

  const customers = customersData?.allCustomers ?? [];
  const entries = data?.allBillingEntries ?? [];
  const report = reportData?.billingReport ?? null;
  const subscriptions = subsData?.allSubscriptions ?? [];
  const plans = plansData?.contractsWithPaymentPlan ?? [];

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
          paymentTermDays: term.trim() === '' ? null : Number(term),
        },
      });
      setDescriptionFa('');
      setDescriptionEn('');
      setAmount('');
      setTerm('');
      setAddingEntry(false);
    } catch (err) {
      setEntryError(refusalText(t, err));
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
        <div>
          <h3 className="t-h3">{t('desk.billing.plansTitle')}</h3>
          <p className="t-caption muted">{t('desk.billing.plansLede')}</p>
        </div>
      </div>
      {plans.length > 0 ? (
        <div className="editor-list" data-testid="plans">
          {plans.map((c) => (
            <PlanCard key={c.id} contract={c} />
          ))}
        </div>
      ) : (
        <p className="t-small muted">{t('desk.billing.plansEmpty')}</p>
      )}

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
        <div>
          <h3 className="t-h3">{t('desk.billing.entriesTitle')}</h3>
          <p className="t-caption muted">{t('desk.billing.draftHelp')}</p>
        </div>
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
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('billing.amountLabel')}</label>
              <input className="input num-latin" required inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('desk.billing.termLabel')}</label>
              <input className="input num-latin" inputMode="numeric" value={term} onChange={(e) => setTerm(e.target.value)} />
              <span className="t-caption muted">{t('desk.billing.termHint')}</span>
            </div>
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
        <div className="editor-list" data-testid="ledger">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      <p className="t-caption muted">{t('desk.billing.numberingNote')}</p>
    </div>
  );
}
