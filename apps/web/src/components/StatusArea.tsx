import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Contract } from '@/lib/queries';
import { calendarDate, formatCount, instantDate, relativeTime } from '@/lib/format';
import { attentionText, moveLabel, stepLabel, type Audience } from '@/lib/wizard';

/**
 * The status area (journeys build plan J3), above the wizard on both sides of
 * the product: where the contract stands, whose move it is, what is waiting on
 * whom, and how long since Root last showed progress.
 *
 * **Everything here is the API's derived answer** (`Contract.statusSummary`,
 * `Contract.attention`) and nothing reads `Contract.status` — that enum is
 * hand-overridable and cannot say both sides are waiting; this can (the plan's
 * trap). The sentences are written for the reader (`audience`), and the API
 * has already filtered the attention list to what that reader may see.
 *
 * Extension: a stage that ships an attention kind adds its sentences to the
 * locale files (`attention.<KIND>.<variant>.<audience>`) and nothing here; a
 * stage that adds a status fact adds it to `computeStatusSummary` and a row
 * to the list below.
 */
export default function StatusArea({ contract, audience }: { contract: Contract; audience: Audience }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const summary = contract.statusSummary;
  if (!summary) return null;
  const attention = contract.attention ?? [];

  const progress =
    summary.daysSinceProgress === null
      ? t('statusArea.progressNever')
      : summary.daysSinceProgress === 0
        ? t('statusArea.progressToday')
        : t('statusArea.progressDays', {
            count: summary.daysSinceProgress,
            n: formatCount(summary.daysSinceProgress, locale),
          });

  const planned =
    summary.plannedStartAt && summary.plannedEndAt
      ? t('statusArea.plannedRange', {
          start: calendarDate(summary.plannedStartAt, locale),
          end: calendarDate(summary.plannedEndAt, locale),
        })
      : summary.plannedStartAt || summary.plannedEndAt
        ? calendarDate((summary.plannedStartAt ?? summary.plannedEndAt)!, locale)
        : null;

  return (
    <section className="status-area" data-testid="status-area" aria-label={t('statusArea.title')}>
      <h2 className="t-h3">{t('statusArea.title')}</h2>

      <dl className="status-facts">
        <div className="status-fact" data-fact="current">
          <dt>{t('statusArea.currentStep')}</dt>
          <dd>
            {summary.currentStep
              ? stepLabel(t, locale, { step: summary.currentStep, phaseNumber: summary.currentPhaseNumber })
              : t('wizard.allDone')}
          </dd>
        </div>
        {summary.nextMoveOn ? (
          <div className="status-fact" data-fact="move">
            <dt>{t('statusArea.nextMove')}</dt>
            <dd>{moveLabel(t, audience, summary.nextMoveOn)}</dd>
          </div>
        ) : null}
        <div className="status-fact" data-fact="waiting-customer">
          <dt>{t(`statusArea.waiting.${audience}.CUSTOMER`)}</dt>
          <dd>{formatCount(summary.waitingOnCustomer, locale)}</dd>
        </div>
        <div className="status-fact" data-fact="waiting-root">
          <dt>{t(`statusArea.waiting.${audience}.ROOT`)}</dt>
          <dd>{formatCount(summary.waitingOnRoot, locale)}</dd>
        </div>
        {/* The agreement's two moments (J7) — approval locks steps 1–3, the
            signature is what counts as signed — on the new road only: the legacy
            road's approval and signature are its own sections' business, and its
            status area is unchanged. */}
        {contract.sequence === 'AGREEMENT_FIRST' ? (
          <div className="status-fact" data-fact="agreement" data-state={summary.signedAt ? 'signed' : summary.agreementApprovedAt ? 'approved' : 'open'}>
            <dt>{t('statusArea.agreement')}</dt>
            <dd>
              {summary.signedAt
                ? t('statusArea.agreementSigned', { date: instantDate(summary.signedAt, locale) })
                : summary.agreementApprovedAt
                  ? t('statusArea.agreementApproved', { date: instantDate(summary.agreementApprovedAt, locale) })
                  : t('statusArea.agreementNone')}
            </dd>
          </div>
        ) : null}
        <div className="status-fact" data-fact="started">
          <dt>{summary.started ? t('statusArea.started') : t('statusArea.notStarted')}</dt>
          <dd>
            {summary.startedAt
              ? relativeTime(summary.startedAt, locale)
              : summary.started
                ? '—'
                : t('statusArea.notStartedHelp')}
          </dd>
        </div>
        {planned || audience === 'staff' ? (
          <div className="status-fact" data-fact="planned">
            <dt>{t('statusArea.planned')}</dt>
            <dd>{planned ?? t('statusArea.plannedNone')}</dd>
          </div>
        ) : null}
        {summary.overdueCount > 0 ? (
          <div className="status-fact status-fact-alert" data-fact="overdue">
            <dt>{t('statusArea.overdue')}</dt>
            <dd>{formatCount(summary.overdueCount, locale)}</dd>
          </div>
        ) : null}
        <div className="status-fact" data-fact="progress">
          <dt>{t('statusArea.progress')}</dt>
          <dd>{progress}</dd>
        </div>
      </dl>

      <div className="attention">
        <h3 className="t-eyebrow">{t('statusArea.attentionTitle')}</h3>
        {attention.length === 0 ? (
          <p className="t-small desk-muted" data-testid="attention-empty">
            {t('statusArea.attentionEmpty')}
          </p>
        ) : (
          <ul className="attention-list">
            {attention.map((item, i) => (
              <li
                key={`${item.kind}:${item.variant}:${item.phaseId ?? ''}:${i}`}
                className={`attention-item attention-${item.waitingOn.toLowerCase()}`}
                data-testid="attention-item"
                data-kind={item.kind}
              >
                <span className="attention-text">{attentionText(t, locale, item, audience)}</span>
                <span className="attention-since">
                  {t('statusArea.since', { when: relativeTime(item.since, locale) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
