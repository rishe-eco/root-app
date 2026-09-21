import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  ALL_SERVICE_RUNS,
  CREATE_SERVICE_RUN_BILLING_ENTRY,
  type ServiceRun,
} from '@/lib/queries';
import { formatAmount, formatCount, fullDateTime, pick } from '@/lib/format';

/**
 * The desk's own service-runs surface (build plan L7; spec §9, §11) — every
 * run across every project, and the billing edge (build plan L6) for one
 * that has been applied. `contracts.manage`, matching every other
 * registry-adjacent surface.
 */

function BillForm({ run }: { run: ServiceRun }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [amount, setAmount] = useState('');
  const [bill, { loading }] = useMutation(CREATE_SERVICE_RUN_BILLING_ENTRY);

  if (run.billingEntry) {
    return (
      <p className="t-small">
        {t('desk.services.billedAmount', { amount: formatAmount(run.billingEntry.amount, locale) })}
        {' — '}
        {run.billingEntry.paidAt ? t('billing.paid') : t('billing.outstanding')}
      </p>
    );
  }
  if (run.status !== 'APPLIED') return null;

  async function onBill() {
    if (!amount.trim()) return;
    await bill({
      variables: {
        runId: run.id,
        amount: amount.trim(),
        descriptionFa: run.fileName,
        descriptionEn: run.fileName,
      },
    });
    setAmount('');
  }

  return (
    <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
      <input
        className="input num-latin"
        type="text"
        inputMode="numeric"
        placeholder={t('desk.services.billAmountPlaceholder')}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button type="button" className="btn btn-secondary btn-sm" disabled={loading || !amount.trim()} onClick={onBill}>
        {t('desk.services.billAction')}
      </button>
    </div>
  );
}

function RunRow({ run }: { run: ServiceRun }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  return (
    <div className="card editor-card">
      <button type="button" className="workspace-row" style={{ width: '100%', textAlign: 'start' }} onClick={() => setOpen((v) => !v)}>
        <span className={`badge service-status-${run.status.toLowerCase()}`}>{t(`services.status.${run.status}`)}</span>
        <span className="t-small" style={{ flex: 1 }}>
          {run.fileName}
        </span>
        <span className="t-caption">{pick(run.project, 'title', locale)}</span>
        <span className="t-caption muted">{fullDateTime(run.createdAt, locale)}</span>
      </button>

      {open ? (
        <>
          {run.rows.length > 0 ? (
            <div className="tile-row">
              <div className="tile">
                <span className="tile-count">{formatCount(run.summary.createCount, locale)}</span>
                <span className="tile-label">{t('services.summary.create')}</span>
              </div>
              <div className="tile">
                <span className="tile-count">{formatCount(run.summary.updateCount, locale)}</span>
                <span className="tile-label">{t('services.summary.update')}</span>
              </div>
              <div className="tile">
                <span className="tile-count">{formatCount(run.summary.unchangedCount, locale)}</span>
                <span className="tile-label">{t('services.summary.unchanged')}</span>
              </div>
              <div className="tile">
                <span className="tile-count">{formatCount(run.summary.rejectedCount, locale)}</span>
                <span className="tile-label">{t('services.summary.rejected')}</span>
              </div>
            </div>
          ) : null}
          {run.failureReason ? <p className="error">{run.failureReason}</p> : null}
          <BillForm run={run} />
        </>
      ) : null}
    </div>
  );
}

export default function Services() {
  const { t } = useTranslation();

  const { data, loading, error, refetch } = useQuery<{ allServiceRuns: ServiceRun[] }>(ALL_SERVICE_RUNS);
  const runs = data?.allServiceRuns ?? [];

  return (
    <div className="desk-section">
      <div className="content-head">
        <div>
          <h2 className="t-h2">{t('desk.services.title')}</h2>
          <p className="t-lead">{t('desk.services.lede')}</p>
        </div>
      </div>

      {error ? (
        <div className="empty">
          <p className="t-small">{t('portal.errorTitle')}</p>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
            {t('portal.retry')}
          </button>
        </div>
      ) : loading && runs.length === 0 ? (
        <div className="empty">{t('portal.loading')}</div>
      ) : runs.length === 0 ? (
        <div className="empty">{t('desk.services.empty')}</div>
      ) : (
        <div className="editor-list">
          {runs.map((run) => (
            <RunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}
