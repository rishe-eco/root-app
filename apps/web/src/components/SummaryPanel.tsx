import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import {
  CLOSE_CONTRACT,
  CONTRACT_SUMMARY,
  MARK_HANDED_OVER,
  UNMARK_HANDED_OVER,
  type SummaryContract,
  type SummaryItem,
} from '@/lib/queries';
import { calendarDate, formatCount, pick } from '@/lib/format';
import { can } from '@/lib/access';
import { errorCode } from '@/components/FeedbackPanel';
import SummaryDocument from '@/components/SummaryDocument';
import type { StepPanelProps } from '@/components/StepPanels';

/**
 * Step 7 — the summary, the handover, closing a contract (journeys build plan
 * J11), one panel for both sides.
 *
 * **The customer reads a record** — `SummaryDocument`, the same component the
 * print route draws — and has nothing to do here: the step takes no input, no
 * feedback, no approval (Q-S8). Staff see the same document beneath the two
 * things only they do:
 *
 * - **Hand a deliverable over** (`markHandedOver`): sales, or the contract's
 *   developer. A note is required and says *what* was given and *how* — the form
 *   says, in as many words, never to write a password. Sales alone takes one back
 *   (`unmarkHandedOver`), before the close.
 * - **Close the contract** (`closeContract`, `contracts.author`): enabled by the
 *   API's own answer (`Contract.delivery.closable`), not by this component's
 *   reading of the rows, so the button and the refusal cannot disagree. It asks
 *   twice — a close ends the contract's working life and takes it out of the
 *   designer's and developer's views.
 *
 * The panel fetches its own record (`ContractSummary`), as the customer or — for
 * "view as customer" — as the customer would be asked, so the unwritten-up
 * changes and the money are as invisible here as on the customer's own screen.
 * Every refusal the API can give is a code and is worded in both languages
 * (`summary.error.<code>`).
 */

export default function SummaryPanel({ contract, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const variables = { id: contract.id, asCustomer: asCustomer || undefined };
  const { data, loading } = useQuery<{ contract: SummaryContract | null }>(CONTRACT_SUMMARY, { variables });
  const c = data?.contract ?? null;

  if (loading && !c) return <p className="t-small desk-muted">{t('portal.loading')}</p>;
  if (!c || !c.summary) {
    return (
      <p className="t-small desk-muted" data-testid="summary-unsigned">
        {t(`summary.unsigned.${audience}`)}
      </p>
    );
  }

  const delivered = c.deliveredAt !== null;
  const staff = audience === 'staff' && !asCustomer;

  return (
    <div className="summary" data-testid="summary-panel" data-state={delivered ? 'delivered' : 'open'}>
      <p className="sec-help">{t(delivered ? `summary.lede.delivered.${audience}` : `summary.lede.open.${audience}`)}</p>

      {staff && !delivered ? <Controls contract={c} me={me} variables={variables} /> : null}

      <article className="doc doc-inline force-light" lang={locale} dir={locale === 'fa' ? 'rtl' : 'ltr'}>
        <SummaryDocument summary={c.summary} />
      </article>

      {audience === 'customer' ? (
        <p className="t-small">
          <Link to={lp(locale, `/app/contracts/${c.id}/summary/print`)} data-testid="summary-print-link">
            {t('summary.printLink')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

// ---- the desk's half ---------------------------------------------------------------

function Controls({
  contract,
  me,
  variables,
}: {
  contract: SummaryContract;
  me: StepPanelProps['me'];
  variables: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [close, { loading: closing }] = useMutation(CLOSE_CONTRACT);
  const mayClose = can(me, 'contracts.author');
  const mayHandOver = mayClose || can(me, 'builds.author');
  const { delivery } = contract;
  const items = (contract.summary?.items ?? []).filter(
    (i) => i.kind === 'DELIVERABLE' && i.status !== 'DECLINED' && i.status !== 'TRADED',
  );

  function refusal(err: unknown): string {
    const code = errorCode(err);
    return code && t(`summary.error.${code}`, { defaultValue: '' }) ? t(`summary.error.${code}`) : (err as Error).message;
  }

  async function onClose() {
    setError(null);
    try {
      await close({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(refusal(err));
      setConfirming(false);
    }
  }

  const blockers: string[] = [];
  if (delivery.noPhases) blockers.push(t('summary.close.noPhases'));
  else if (delivery.phasesNotAccepted.length > 0) {
    blockers.push(t('summary.close.phasesNotAccepted', { phases: delivery.phasesNotAccepted.map((n) => formatCount(n, locale)).join(locale === 'fa' ? '، ' : ', ') }));
  }
  if (delivery.deliverablesPending.length > 0) {
    blockers.push(t('summary.close.deliverablesPending', { count: delivery.deliverablesPending.length, n: formatCount(delivery.deliverablesPending.length, locale) }));
  }

  return (
    <div className="summary-controls" data-testid="summary-controls">
      <h3 className="t-h3">{t('summary.handover.formTitle')}</h3>
      {items.length === 0 ? (
        <p className="t-small desk-muted">{t('summary.handover.none')}</p>
      ) : (
        <ul className="summary-handover">
          {items.map((i) => (
            <HandoverRow key={i.id} item={i} mayHandOver={mayHandOver} mayTakeBack={mayClose} variables={variables} onError={(err) => setError(refusal(err))} />
          ))}
        </ul>
      )}

      {mayClose ? (
        <div className="summary-close">
          <h3 className="t-h3">{t('summary.close.title')}</h3>
          {blockers.length > 0 ? (
            <ul className="summary-blockers" data-testid="summary-blockers">
              {blockers.map((b) => (
                <li key={b} className="t-small">
                  {b}
                </li>
              ))}
            </ul>
          ) : (
            <p className="t-small desk-muted">{t('summary.close.ready')}</p>
          )}
          {confirming ? (
            <div className="summary-confirm" role="group">
              <p className="t-small">{t('summary.close.confirm')}</p>
              <button type="button" className="btn btn-primary" data-testid="summary-close-confirm" disabled={closing} onClick={onClose}>
                {t('summary.close.confirmCta')}
              </button>
              <button type="button" className="btn btn-ghost" disabled={closing} onClick={() => setConfirming(false)}>
                {t('summary.close.cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="summary-close"
              disabled={!delivery.closable}
              onClick={() => setConfirming(true)}
            >
              {t('summary.close.cta')}
            </button>
          )}
        </div>
      ) : null}

      {error ? (
        <p className="error" role="alert" data-testid="summary-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HandoverRow({
  item,
  mayHandOver,
  mayTakeBack,
  variables,
  onError,
}: {
  item: SummaryItem;
  mayHandOver: boolean;
  mayTakeBack: boolean;
  variables: Record<string, unknown>;
  onError: (err: unknown) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [note, setNote] = useState('');
  const refetchQueries = [{ query: CONTRACT_SUMMARY, variables }];
  const [hand, { loading: handing }] = useMutation(MARK_HANDED_OVER, { refetchQueries, awaitRefetchQueries: true });
  const [takeBack, { loading: taking }] = useMutation(UNMARK_HANDED_OVER, { refetchQueries, awaitRefetchQueries: true });

  async function onHand(e: FormEvent) {
    e.preventDefault();
    if (note.trim() === '') return;
    try {
      await hand({ variables: { scopeItemId: item.id, note } });
      setNote('');
    } catch (err) {
      onError(err);
    }
  }

  async function onTakeBack() {
    try {
      await takeBack({ variables: { scopeItemId: item.id } });
    } catch (err) {
      onError(err);
    }
  }

  return (
    <li className="summary-handover-row" data-testid={`handover-${item.key}`} data-handed-over={item.handedOverAt ? 'true' : 'false'}>
      <span className="summary-handover-label">{pick(item, 'label', locale)}</span>
      {item.handedOverAt ? (
        <>
          <span className="t-small">
            {t('summary.handover.on', { date: calendarDate(item.handedOverAt, locale) })}
            {item.handedOverBy ? ` · ${t('summary.handover.by', { name: item.handedOverBy })}` : ''}
          </span>
          {mayTakeBack ? (
            <button type="button" className="btn btn-ghost btn-sm" disabled={taking} onClick={onTakeBack} data-testid={`unhand-${item.key}`}>
              {t('summary.handover.takeBack')}
            </button>
          ) : null}
        </>
      ) : mayHandOver ? (
        <form className="summary-form" onSubmit={onHand}>
          <label className="label" htmlFor={`hand-${item.key}`}>
            {t('summary.handover.noteLabel')}
          </label>
          <textarea
            id={`hand-${item.key}`}
            className="input"
            rows={2}
            value={note}
            placeholder={t('summary.handover.notePlaceholder')}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="t-caption">{t('summary.handover.noteHelp')}</p>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={handing || note.trim() === ''} data-testid={`hand-${item.key}`}>
            {t('summary.handover.cta')}
          </button>
        </form>
      ) : (
        <span className="t-small desk-muted">{t('summary.handover.pending')}</span>
      )}
    </li>
  );
}
