import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { formatCount, relativeTime } from '@/lib/format';
import type { WorkspaceContext } from './ContractWorkspace';

/**
 * A plain change log rather than rendered sentences (V2.md §2: "V1b already
 * returns [the lineages]; a plain change log is enough"). Reusing
 * ContractDetail's per-action sentence map here would be a second copy of
 * it — exactly the drift `changeAction.test.ts` exists to catch, and it
 * only reads that map from one place. Extracting a shared sentence-builder
 * is V4's job (T5 in V4.md); until then this reads generically off the
 * enum, which needs no per-action table to stay correct.
 */
function actionLabel(action: string): string {
  return action
    .toLowerCase()
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

export default function ActivityTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract } = useOutletContext<WorkspaceContext>();

  const contractRevisions = contract.contractRevisions ?? [];
  const designRevisions = contract.designRevisions ?? [];

  return (
    <>
      <div>
        <h3 className="t-h3">{t('workspace.lineagesTitle')}</h3>
        <p className="t-small desk-muted">{t('workspace.lineagesHelp')}</p>
      </div>
      <div className="lineage-columns">
        <div className="lineage-col">
          <p className="t-eyebrow">{t('workspace.contractLineage')}</p>
          {contractRevisions.length === 0 ? (
            <p className="t-small desk-muted">{t('workspace.lineageEmpty')}</p>
          ) : (
            contractRevisions.map((r) => (
              <div key={r.id} className="lineage-row">
                <span className="num-latin">v{r.version}</span>
                <span className="t-small desk-muted">
                  {r.signedAt
                    ? t('workspace.lineageSigned')
                    : r.approvedAt
                      ? t('workspace.lineageApproved')
                      : r.supersededAt
                        ? t('workspace.lineageSuperseded')
                        : r.publishedAt
                          ? t('workspace.lineagePublished')
                          : t('workspace.lineageUnsealed')}
                </span>
                <span className="t-caption">
                  {r.amendmentCount > 0 ? `+${formatCount(r.amendmentCount, locale)}` : ''}
                </span>
              </div>
            ))
          )}
        </div>
        <div className="lineage-col">
          <p className="t-eyebrow">{t('workspace.designLineage')}</p>
          {designRevisions.length === 0 ? (
            <p className="t-small desk-muted">{t('workspace.lineageEmpty')}</p>
          ) : (
            designRevisions.map((r) => (
              <div key={r.id} className="lineage-row">
                <span className="num-latin">v{r.version}</span>
                <span className="t-small desk-muted">
                  {r.supersededAt
                    ? t('workspace.lineageSuperseded')
                    : r.publishedAt
                      ? t('workspace.lineagePublished')
                      : t('workspace.lineageUnsealed')}
                </span>
                <span className="t-caption">
                  {formatCount(r.conceptCount, locale)}×{formatCount(r.pageCount, locale)}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div>
        <h3 className="t-h3">{t('workspace.changeLogTitle')}</h3>
        <div className="editor-list">
          {contract.changeLog.map((e) => (
            <div key={e.id} className="lineage-row">
              <span className="t-small">
                {e.actor.name} — {actionLabel(e.action)}
                {e.arg ? `: ${e.arg}` : ''}
              </span>
              <span className="t-caption desk-muted">{relativeTime(e.createdAt, locale)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
