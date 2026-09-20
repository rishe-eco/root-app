import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick, formatCount, relativeTime } from '@/lib/format';
import {
  CREATE_PHASE,
  UPDATE_PHASE,
  DELETE_PHASE,
  ASSIGN_SCOPE_ITEM_TO_PHASE,
  CREATE_DEMO,
  UPDATE_DEMO,
  DELETE_DEMO,
  DECLARE_DEMO_PAGE,
  UPDATE_DEMO_PAGE,
  DELETE_DEMO_PAGE,
  type Phase,
  type Demo,
  type DemoPage,
  type ScopeItem,
} from '@/lib/queries';
import DemoViewport from '@/components/DemoViewport';
import type { WorkspaceContext } from './ContractWorkspace';

/**
 * The desk phase board (build plan L2; spec §4 stage 6, §6) — Root's own
 * surface for shaping phases, attaching a live demo to one, and declaring the
 * page list a reported path is matched against (lib/demoPages.ts). The
 * portal never sees this screen; it sees `Project.progress` (derived,
 * lib/phase.ts) and the same `DemoViewport` this tab uses to preview a demo
 * before telling the customer about it.
 */

// House rule 6: this codebase's existing, uneven convention is `err.message`
// straight from the server (see ScopeTab.tsx). The one exception carved out
// here is the staging-URL validation this stage explicitly calls for — the
// server returns a code, and this is where it becomes a sentence.
const KNOWN_ERROR_CODES = new Set(['STAGING_NOT_HTTPS', 'INVALID_STAGING_URL']);

/** Structural rather than i18next's TFunction — same reasoning as lib/changelog.ts's T. */
type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code && KNOWN_ERROR_CODES.has(code)) return t(`workspace.demoError.${code}`);
  return (err as { message?: string })?.message ?? String(err);
}

type PageDesignOption = { id: string; label: string };

function DemoPageRow({
  page,
  designOptions,
}: {
  page: DemoPage;
  designOptions: PageDesignOption[];
}) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState(page.labelFa);
  const [labelEn, setLabelEn] = useState(page.labelEn);
  const [canonicalPath, setCanonicalPath] = useState(page.canonicalPath);
  const [pageDesignId, setPageDesignId] = useState(page.pageDesign?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_DEMO_PAGE);
  const [remove] = useMutation(DELETE_DEMO_PAGE);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: {
          demoPageId: page.id,
          labelFa,
          labelEn,
          canonicalPath,
          pageDesignId: pageDesignId || null,
        },
      });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteDemoPage'))) return;
    await remove({ variables: { demoPageId: page.id } });
  }

  return (
    <form className="demo-page-row" onSubmit={onSave}>
      <span className="t-eyebrow num-latin">{page.key}</span>
      <input className="input" dir="rtl" value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
      <input className="input" dir="ltr" value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
      <input
        className="input num-latin"
        dir="ltr"
        value={canonicalPath}
        onChange={(e) => setCanonicalPath(e.target.value)}
      />
      <select className="input" value={pageDesignId} onChange={(e) => setPageDesignId(e.target.value)}>
        <option value="">{t('workspace.demoPageNoDesign')}</option>
        {designOptions.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
        {t('workspace.save')}
      </button>
      <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
        {t('workspace.delete')}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </form>
  );
}

function DemoCard({ demo, designOptions }: { demo: Demo; designOptions: PageDesignOption[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [stagingUrl, setStagingUrl] = useState(demo.stagingUrl);
  const [buildRef, setBuildRef] = useState(demo.buildRef ?? '');
  const [reviewWindowStart, setReviewWindowStart] = useState(demo.reviewWindowStart?.slice(0, 10) ?? '');
  const [reviewWindowEnd, setReviewWindowEnd] = useState(demo.reviewWindowEnd?.slice(0, 10) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_DEMO);
  const [remove] = useMutation(DELETE_DEMO);

  const [addingPage, setAddingPage] = useState(false);
  const [pageKey, setPageKey] = useState('');
  const [pageLabelFa, setPageLabelFa] = useState('');
  const [pageLabelEn, setPageLabelEn] = useState('');
  const [pagePath, setPagePath] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [declarePage, { loading: declaring }] = useMutation(DECLARE_DEMO_PAGE);

  async function onSaveDemo(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: {
          demoId: demo.id,
          stagingUrl,
          buildRef: buildRef || null,
          reviewWindowStart: reviewWindowStart ? new Date(reviewWindowStart).toISOString() : null,
          reviewWindowEnd: reviewWindowEnd ? new Date(reviewWindowEnd).toISOString() : null,
        },
      });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  async function onDeleteDemo() {
    if (!confirm(t('workspace.confirmDeleteDemo'))) return;
    await remove({ variables: { demoId: demo.id } });
  }

  async function onDeclarePage(e: FormEvent) {
    e.preventDefault();
    setPageError(null);
    try {
      await declarePage({
        variables: { demoId: demo.id, key: pageKey, labelFa: pageLabelFa, labelEn: pageLabelEn, canonicalPath: pagePath },
      });
      setAddingPage(false);
      setPageKey('');
      setPageLabelFa('');
      setPageLabelEn('');
      setPagePath('');
    } catch (err) {
      setPageError(errorMessage(err, t));
    }
  }

  return (
    <div className="demo-card">
      <form className="editor-grid-2" onSubmit={onSaveDemo}>
        <div className="field">
          <label className="label">{t('workspace.demoStagingUrl')}</label>
          <input
            className="input num-latin"
            dir="ltr"
            required
            value={stagingUrl}
            onChange={(e) => setStagingUrl(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label">{t('workspace.demoBuildRef')}</label>
          <input className="input num-latin" dir="ltr" value={buildRef} onChange={(e) => setBuildRef(e.target.value)} />
        </div>
        <div className="field">
          <label className="label">{t('workspace.demoReviewStart')}</label>
          <input
            className="input num-latin"
            type="date"
            value={reviewWindowStart}
            onChange={(e) => setReviewWindowStart(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label">{t('workspace.demoReviewEnd')}</label>
          <input
            className="input num-latin"
            type="date"
            value={reviewWindowEnd}
            onChange={(e) => setReviewWindowEnd(e.target.value)}
          />
        </div>
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
            {t('workspace.save')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDeleteDemo}>
            {t('workspace.delete')}
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </form>

      <DemoViewport demo={demo} />

      <div className="workspace-row">
        <h4 className="t-h3">{t('workspace.demoPagesTitle')}</h4>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingPage((v) => !v)}>
          {t('workspace.addDemoPage')}
        </button>
      </div>

      {addingPage ? (
        <form className="card editor-card auth-form" onSubmit={onDeclarePage}>
          <div className="field">
            <label className="label">{t('workspace.scopeKey')}</label>
            <input className="input num-latin" dir="ltr" required value={pageKey} onChange={(e) => setPageKey(e.target.value)} />
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={pageLabelFa} onChange={(e) => setPageLabelFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={pageLabelEn} onChange={(e) => setPageLabelEn(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label">{t('workspace.demoPagePath')}</label>
            <input className="input num-latin" dir="ltr" required value={pagePath} onChange={(e) => setPagePath(e.target.value)} />
          </div>
          {pageError ? <p className="error">{pageError}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={declaring}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      <div className="editor-list">
        {demo.pages.map((p) => (
          <DemoPageRow key={p.id} page={p} designOptions={designOptions} />
        ))}
      </div>

      {/* L2.2: "a page we did not expect" — made visible, never dropped. */}
      {demo.unmatchedPaths.length > 0 ? (
        <div className="unmatched-bucket">
          <h4 className="t-h3">{t('workspace.unmatchedTitle')}</h4>
          {demo.unmatchedPaths.map((u) => (
            <div className="unmatched-row" key={u.id}>
              <span className="num-latin t-small">{u.normalizedPath}</span>
              <span className="t-caption">
                {t('workspace.unmatchedCount', { count: u.count, n: formatCount(u.count, locale) })} ·{' '}
                {relativeTime(u.lastSeenAt, locale)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PhaseCard({
  phase,
  unassignedItems,
  designOptions,
}: {
  phase: Phase;
  unassignedItems: ScopeItem[];
  designOptions: PageDesignOption[];
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [titleFa, setTitleFa] = useState(phase.titleFa);
  const [titleEn, setTitleEn] = useState(phase.titleEn);
  const [milestoneLabel, setMilestoneLabel] = useState(phase.milestoneLabel ?? '');
  const [update, { loading }] = useMutation(UPDATE_PHASE);
  const [remove] = useMutation(DELETE_PHASE);
  const [assign] = useMutation(ASSIGN_SCOPE_ITEM_TO_PHASE);

  const [addingDemo, setAddingDemo] = useState(false);
  const [stagingUrl, setStagingUrl] = useState('');
  const [demoError, setDemoError] = useState<string | null>(null);
  const [createDemo, { loading: creatingDemo }] = useMutation(CREATE_DEMO);

  const [pickedItem, setPickedItem] = useState('');

  async function onSave(e: FormEvent) {
    e.preventDefault();
    await update({ variables: { phaseId: phase.id, titleFa, titleEn, milestoneLabel: milestoneLabel || null } });
    setEditing(false);
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeletePhase'))) return;
    await remove({ variables: { phaseId: phase.id } });
  }

  async function onAssign() {
    if (!pickedItem) return;
    await assign({ variables: { scopeItemId: pickedItem, phaseId: phase.id } });
    setPickedItem('');
  }

  async function onUnassign(itemId: string) {
    await assign({ variables: { scopeItemId: itemId, phaseId: null } });
  }

  async function onCreateDemo(e: FormEvent) {
    e.preventDefault();
    setDemoError(null);
    try {
      await createDemo({ variables: { phaseId: phase.id, stagingUrl } });
      setAddingDemo(false);
      setStagingUrl('');
    } catch (err) {
      setDemoError(errorMessage(err, t));
    }
  }

  return (
    <div className="card phase-card">
      <div className="phase-card-head">
        <span className="t-h3">
          <span className="num-latin">{formatCount(phase.number, locale)}</span> ·{' '}
          {pick(phase, 'title', locale)}
        </span>
        <div className="workspace-row" style={{ gap: '0.5rem' }}>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing((v) => !v)}>
            {t('workspace.edit')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
            {t('workspace.delete')}
          </button>
        </div>
      </div>

      {phase.milestoneLabel ? <p className="t-caption">{phase.milestoneLabel}</p> : null}

      {editing ? (
        <form className="card editor-card auth-form" onSubmit={onSave}>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label">{t('workspace.phaseMilestone')}</label>
            <input className="input" value={milestoneLabel} onChange={(e) => setMilestoneLabel(e.target.value)} />
          </div>
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      <div>
        <p className="t-eyebrow">{t('workspace.phaseScopeItems')}</p>
        <div className="workspace-row" style={{ flexWrap: 'wrap' }}>
          {phase.scopeItems.length === 0 ? (
            <span className="t-small muted">{t('workspace.phaseNoItems')}</span>
          ) : (
            phase.scopeItems.map((i) => (
              <span key={i.id} className="badge">
                {pick(i, 'label', locale)}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-label={t('workspace.phaseUnassign')}
                  onClick={() => onUnassign(i.id)}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        {unassignedItems.length > 0 ? (
          <div className="workspace-row">
            <select className="input" value={pickedItem} onChange={(e) => setPickedItem(e.target.value)}>
              <option value="">{t('workspace.phasePickItem')}</option>
              {unassignedItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {pick(i, 'label', locale)}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onAssign} disabled={!pickedItem}>
              {t('workspace.phaseAssign')}
            </button>
          </div>
        ) : null}
      </div>

      <div>
        <div className="workspace-row">
          <p className="t-eyebrow">{t('workspace.demosTitle')}</p>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingDemo((v) => !v)}>
            {t('workspace.addDemo')}
          </button>
        </div>

        {addingDemo ? (
          <form className="card editor-card auth-form" onSubmit={onCreateDemo}>
            <div className="field">
              <label className="label">{t('workspace.demoStagingUrl')}</label>
              <input
                className="input num-latin"
                dir="ltr"
                required
                placeholder="https://…"
                value={stagingUrl}
                onChange={(e) => setStagingUrl(e.target.value)}
              />
            </div>
            {demoError ? <p className="error">{demoError}</p> : null}
            <div>
              <button className="btn btn-primary btn-sm" type="submit" disabled={creatingDemo}>
                {t('workspace.save')}
              </button>
            </div>
          </form>
        ) : null}

        {phase.demos.length === 0 ? (
          <p className="t-small muted">{t('workspace.phaseNoDemo')}</p>
        ) : (
          phase.demos.map((d) => <DemoCard key={d.id} demo={d} designOptions={designOptions} />)
        )}
      </div>
    </div>
  );
}

export default function PhasesTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract } = useOutletContext<WorkspaceContext>();
  const project = contract.project;

  const [adding, setAdding] = useState(false);
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createPhase, { loading }] = useMutation(CREATE_PHASE);

  if (!project) {
    return <p className="t-small muted">{t('workspace.phaseNoProject')}</p>;
  }

  const phases = [...project.phases].sort((a, b) => a.number - b.number);
  const nextNumber = phases.length === 0 ? 1 : Math.max(...phases.map((p) => p.number)) + 1;
  const unassignedItems = contract.scopeItems.filter((i) => i.phaseId === null);

  const designOptions: PageDesignOption[] = contract.concepts.flatMap((c) =>
    c.pages.map((p) => ({ id: p.id, label: `${c.key} · ${pick(p, 'label', locale)}` })),
  );

  const progress = project.progress;

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createPhase({ variables: { contractId: contract.id, number: nextNumber, titleFa, titleEn } });
      setAdding(false);
      setTitleFa('');
      setTitleEn('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="phase-board">
      {/* The same derived read the portal shows — F5's own trap: never a
          hand-typed percentage. Shown here too so Root sees exactly what the
          customer sees, not a second, drifting number. */}
      <div className="phase-progress-line">
        <span className="t-eyebrow">{t('workspace.phaseProgressLabel')}</span>
        <span className="t-small">
          {progress.totalPhases === 0
            ? t('demo.progress.none')
            : t('demo.progress.line', {
                current: progress.currentPhaseNumber,
                total: progress.totalPhases,
                n: formatCount(progress.currentPhaseNumber ?? 0, locale),
                nTotal: formatCount(progress.totalPhases, locale),
              })}
        </span>
      </div>

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.phasesTitle')}</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding((v) => !v)}>
          {t('workspace.addPhase')}
        </button>
      </div>

      {adding ? (
        <form className="card editor-card auth-form" onSubmit={onAdd}>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      {phases.length === 0 ? (
        <p className="t-small muted">{t('workspace.phasesEmpty')}</p>
      ) : (
        phases.map((phase) => (
          <PhaseCard key={phase.id} phase={phase} unassignedItems={unassignedItems} designOptions={designOptions} />
        ))
      )}
    </div>
  );
}
