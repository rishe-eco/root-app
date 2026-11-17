import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import { calendarDate, formatCount, pick } from '@/lib/format';
import { designPath } from '@/lib/brief';
import { stepLink } from '@/lib/wizard';
import type { Contract, ScopeKind } from '@/lib/queries';

/**
 * The draft step's first part for staff (DX1, desk UX review 13): a **read-only
 * summary of the steps the draft is written from** — Requirements, and Pages and
 * features — so the person writing the contract text sees what it must say
 * without leaving the step. Nothing here is editable and nothing is decided
 * here: it reads the same `brief` and scope items the two steps show, and each
 * block links to the step where it is changed. (Phases and payment is not a step
 * yet.)
 */

const KINDS: ScopeKind[] = ['PAGE', 'FEATURE', 'DELIVERABLE'];

export default function DraftSummary({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const brief = contract.brief ?? null;
  const missing = contract.briefCompleteness?.length ?? 0;
  // This contract's own items (a project can hold several contracts' scopes), the ones still in play.
  const items = contract.scopeItems
    .filter((s) => s.contractId === contract.id && KINDS.includes(s.kind) && s.status !== 'DECLINED')
    .sort((a, b) => a.position - b.position);

  return (
    <section className="card editor-card draft-summary" data-testid="draft-summary" aria-label={t('draftSummary.title')}>
      <h4 className="t-h4">{t('draftSummary.title')}</h4>

      <div className="draft-summary-block" data-testid="draft-summary-requirements">
        <div className="workspace-row">
          <span className="t-eyebrow">{t('wizard.step.REQUIREMENTS')}</span>
          <Link className="btn btn-ghost btn-sm" to={lp(locale, stepLink(contract.id, { step: 'REQUIREMENTS', phaseId: null }))}>
            {t('draftSummary.open')}
          </Link>
        </div>
        {brief ? (
          <dl className="draft-summary-facts">
            <div><dt>{t('brief.label.kind')}</dt><dd>{t(`brief.kind.${brief.kind}`)}</dd></div>
            <div><dt>{t('brief.label.templateType')}</dt><dd>{pick(brief.templateType, 'label', locale)}</dd></div>
            <div><dt>{t('brief.label.designTier')}</dt><dd>{t(`brief.path.${designPath(brief.designTier)}`)}</dd></div>
            <div><dt>{t('brief.label.hardDeadline')}</dt><dd>{brief.hardDeadline ? calendarDate(brief.hardDeadline, locale) : t('brief.notSet')}</dd></div>
            <div>
              <dt>{t('brief.label.supportMonths')}</dt>
              <dd>{brief.supportMonths === null ? t('brief.notSet') : t('brief.months', { count: brief.supportMonths, n: formatCount(brief.supportMonths, locale) })}</dd>
            </div>
          </dl>
        ) : (
          <p className="t-small desk-muted">{t('brief.empty.staff')}</p>
        )}
        <p className="t-caption" data-testid="draft-summary-missing">
          {missing > 0 ? t('draftSummary.missing', { count: missing, n: formatCount(missing, locale) }) : t('draftSummary.complete')}
        </p>
      </div>

      <div className="draft-summary-block" data-testid="draft-summary-scope">
        <div className="workspace-row">
          <span className="t-eyebrow">{t('wizard.step.SCOPE')}</span>
          <Link className="btn btn-ghost btn-sm" to={lp(locale, stepLink(contract.id, { step: 'SCOPE', phaseId: null }))}>
            {t('draftSummary.open')}
          </Link>
        </div>
        {items.length === 0 ? (
          <p className="t-small desk-muted">{t('draftSummary.noScope')}</p>
        ) : (
          KINDS.map((kind) => {
            const rows = items.filter((s) => s.kind === kind);
            return rows.length === 0 ? null : (
              <p key={kind} className="t-small draft-summary-kind">
                <strong>{t(`scope.group.${kind}`)} · {formatCount(rows.length, locale)}:</strong>{' '}
                {rows.map((s) => pick(s, 'label', locale)).join(t('draftSummary.sep'))}
              </p>
            );
          })
        )}
      </div>
    </section>
  );
}
