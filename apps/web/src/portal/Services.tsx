import { useRef, useState, type ChangeEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  MY_PROJECTS,
  PROJECT_SERVICE_RUNS,
  CREATE_SERVICE_RUN,
  PREVIEW_SERVICE_RUN,
  APPLY_SERVICE_RUN,
  type ServiceRun,
  type User,
} from '@/lib/queries';
import { SERVICE_IMPORT_ACCEPT, UploadFailure, uploadServiceImport } from '@/lib/upload';
import { formatAmount, formatCount, fullDateTime } from '@/lib/format';
import Topbar from './Topbar';

/**
 * The portal's `services` rail item, going live (build plan L7; spec §9) —
 * the product-import panel. Upload -> validate -> preview diff -> explicit
 * apply -> run history. "The preview diff IS the feature" (L7's banked
 * trap): there is no button here that applies a run before it has been
 * previewed — `Apply` is only ever rendered once `status` is `PREVIEWED`.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code) return t(`services.error.${code}`, { defaultValue: (err as Error).message });
  return (err as { message?: string })?.message ?? String(err);
}

function RunCard({ run, onChanged }: { run: ServiceRun; onChanged: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [preview, { loading: previewing }] = useMutation(PREVIEW_SERVICE_RUN);
  const [apply, { loading: applying }] = useMutation(APPLY_SERVICE_RUN);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onPreview() {
    setActionError(null);
    try {
      await preview({ variables: { runId: run.id } });
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, t));
    }
  }

  async function onApply() {
    setActionError(null);
    try {
      await apply({ variables: { runId: run.id } });
      onChanged();
    } catch (err) {
      setActionError(errorMessage(err, t));
    }
  }

  return (
    <div className="card editor-card">
      <button type="button" className="workspace-row" style={{ width: '100%', textAlign: 'start' }} onClick={() => setOpen((v) => !v)}>
        <span className={`badge service-status-${run.status.toLowerCase()}`}>{t(`services.status.${run.status}`)}</span>
        <span className="t-small" style={{ flex: 1 }}>
          {run.fileName}
        </span>
        <span className="t-caption muted">{fullDateTime(run.createdAt, locale)}</span>
      </button>

      {open ? (
        <>
          {run.status === 'FAILED' && run.failureReason ? <p className="error">{run.failureReason}</p> : null}

          {run.rows.length > 0 ? (
            <>
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

              <div className="table-wrap">
                <table className="ctable">
                  <thead>
                    <tr>
                      <th>{t('services.col.sku')}</th>
                      <th>{t('services.col.name')}</th>
                      <th>{t('services.col.price')}</th>
                      <th>{t('services.col.action')}</th>
                      <th>{t('services.col.reason')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.rows.map((row) => (
                      <tr key={row.id}>
                        <td className="num-latin">{row.sku}</td>
                        <td>{row.nameFa || row.nameEn}</td>
                        <td>{row.price ? formatAmount(row.price, locale) : '—'}</td>
                        <td>
                          <span className={`badge service-action-${row.action.toLowerCase()}`}>
                            {t(`services.action.${row.action}`)}
                          </span>
                        </td>
                        <td className="t-caption">{row.rejectReason ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {actionError ? <p className="error">{actionError}</p> : null}

          <div className="workspace-row">
            {run.status === 'UPLOADED' || run.status === 'FAILED' ? (
              <button className="btn btn-secondary btn-sm" type="button" disabled={previewing} onClick={onPreview}>
                {t('services.preview')}
              </button>
            ) : null}
            {run.status === 'PREVIEWED' ? (
              <button className="btn btn-primary btn-sm" type="button" disabled={applying} onClick={onApply}>
                {t('services.apply')}
              </button>
            ) : null}
            {run.status === 'APPLIED' ? (
              <span className="t-caption muted">
                {t('services.appliedLine', {
                  name: run.appliedBy?.name ?? '',
                  date: run.appliedAt ? fullDateTime(run.appliedAt, locale) : '',
                })}
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default function Services() {
  const { t } = useTranslation();
  const me = useOutletContext<User>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const { data: projectsData, loading: projectsLoading } = useQuery<{ myProjects: { id: string; titleFa: string; titleEn: string }[] }>(
    MY_PROJECTS,
  );
  const projects = projectsData?.myProjects ?? [];
  const projectId = projects[0]?.id ?? null;

  const { data, loading, error, refetch } = useQuery<{ projectServiceRuns: ServiceRun[] }>(PROJECT_SERVICE_RUNS, {
    variables: { projectId },
    skip: !projectId,
  });
  const [createRun] = useMutation(CREATE_SERVICE_RUN);

  async function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !projectId) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      const uploaded = await uploadServiceImport(projectId, file);
      await createRun({ variables: { projectId, fileId: uploaded.id } });
      await refetch();
    } catch (err) {
      setUploadError(err instanceof UploadFailure ? t(err.i18nKey) : t('upload.errGeneric'));
    } finally {
      setUploadBusy(false);
    }
  }

  const runs = data?.projectServiceRuns ?? [];

  return (
    <>
      <Topbar user={me} start={<h1 className="t-h3 topbar-title">{t('portal.navServices')}</h1>} />
      <div className="content">
        <div className="content-head">
          <div>
            <h1 className="t-h2">{t('services.pageTitle')}</h1>
            <p className="t-lead">{t('services.pageLede')}</p>
          </div>
          {projectId ? (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept={SERVICE_IMPORT_ACCEPT}
                style={{ display: 'none' }}
                onChange={onPickFile}
              />
              <button className="btn btn-primary btn-sm" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadBusy}>
                {t('services.upload')}
              </button>
            </>
          ) : null}
        </div>
        {uploadError ? <p className="error">{uploadError}</p> : null}

        {projectsLoading ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : !projectId ? (
          <div className="empty">{t('services.noProject')}</div>
        ) : error ? (
          <div className="empty">
            <p className="t-small">{t('portal.errorTitle')}</p>
            <button className="btn btn-secondary btn-sm" type="button" onClick={() => refetch()}>
              {t('portal.retry')}
            </button>
          </div>
        ) : loading && runs.length === 0 ? (
          <div className="empty">{t('portal.loading')}</div>
        ) : runs.length === 0 ? (
          <div className="empty">{t('services.empty')}</div>
        ) : (
          <div className="editor-list">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} onChanged={() => refetch()} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
