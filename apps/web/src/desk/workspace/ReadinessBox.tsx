import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import { formatCount, instantDate } from '@/lib/format';
import { stepLink } from '@/lib/wizard';
import { CONTRACT_READINESS, type Contract, type PublishBlocker } from '@/lib/queries';

/**
 * The readiness box at the top of the desk's Contract tab (DX1, desk UX review
 * 16): **what blocks publishing**, one line each, each a link to the step where
 * it is fixed; when the draft was last published; and whether there are
 * unpublished changes — yes or no.
 *
 * The blockers are not worked out here. They are `Contract.publishBlockers`,
 * which asks the same function the publish button's mutation asks (house rule 3),
 * so this list and a press of the button cannot disagree. The query runs when
 * the tab opens and again whenever the draft or its published revision moves.
 * Version, date and *dirty* are the contract's own (`draftStateOn` computes
 * dirty for the draft field).
 */
export default function ReadinessBox({ contract }: { contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { data, refetch } = useQuery<{ contract: { publishBlockers: PublishBlocker[] } }>(CONTRACT_READINESS, {
    variables: { id: contract.id },
    fetchPolicy: 'network-only',
  });
  const stamp = `${contract.draft?.contentHash ?? ''}|${contract.revision?.id ?? ''}|${contract.sequence}`;
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp]);

  const blockers = data?.contract.publishBlockers ?? null;
  const revision = contract.revision;

  const line = (b: PublishBlocker): string => {
    const n = formatCount(b.count, locale);
    switch (b.code) {
      case 'SCOPE_UNCONFIRMED':
        return b.count > 0 ? t('readiness.blocker.SCOPE_PROPOSALS', { count: b.count, n }) : t('readiness.blocker.SCOPE_EMPTY');
      case 'BRIEF_INCOMPLETE':
        return t('readiness.blocker.BRIEF_INCOMPLETE', { count: b.count, n });
      case 'PLAN_INCOMPLETE':
        return t('readiness.blocker.PLAN_INCOMPLETE', { count: b.count, n });
      default:
        return t(`readiness.blocker.${b.code}`, { defaultValue: b.code });
    }
  };

  return (
    <section className="card editor-card readiness" data-testid="readiness-box" aria-label={t('readiness.title')}>
      <h3 className="t-h4">{t('readiness.title')}</h3>
      {blockers === null ? (
        <p className="t-small desk-muted">{t('portal.loading')}</p>
      ) : blockers.length === 0 ? (
        <p className="t-small" data-testid="readiness-clear">{t('readiness.clear')}</p>
      ) : (
        <ul className="readiness-list" data-testid="readiness-blockers">
          {blockers.map((b) => (
            <li key={b.code} data-code={b.code}>
              {b.step ? (
                <Link to={lp(locale, stepLink(contract.id, { step: b.step, phaseId: null }))}>{line(b)}</Link>
              ) : (
                line(b)
              )}
            </li>
          ))}
        </ul>
      )}
      <dl className="draft-summary-facts readiness-facts">
        <div data-fact="last-published">
          <dt>{t('readiness.lastPublished')}</dt>
          <dd>
            {revision?.publishedAt
              ? t('readiness.version', { version: revision.version, date: instantDate(revision.publishedAt, locale) })
              : t('readiness.never')}
          </dd>
        </div>
        <div data-fact="unpublished-changes" data-dirty={contract.draft?.dirty ? 'yes' : 'no'}>
          <dt>{t('readiness.unpublished')}</dt>
          <dd>{contract.draft?.dirty ? t('readiness.yes') : t('readiness.no')}</dd>
        </div>
      </dl>
    </section>
  );
}
