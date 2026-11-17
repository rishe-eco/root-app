import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, formatCount, relativeTime } from '@/lib/format';
import {
  UPDATE_DEMO,
  DELETE_DEMO,
  DECLARE_DEMO_PAGE,
  UPDATE_DEMO_PAGE,
  DELETE_DEMO_PAGE,
  type Contract,
  type Phase,
  type Demo,
  type DemoPage,
  type User,
} from '@/lib/queries';
import DemoViewport from '@/components/DemoViewport';
import DemoFeedbackPanel from '@/components/DemoFeedbackPanel';
import DemoSubmission, { ReadinessStep, mayRecordReadiness, useDemoReadiness } from '@/components/DemoSubmission';

/**
 * A phase's demo setup, authored (build plan L2, J10) — the live demo link (the
 * staging address, build ref, review window), the readiness check, the frame,
 * each version, and the declared pages a reported path is matched against
 * (`lib/demoPages.ts`).
 *
 * **DX2a (desk UX review 19) moved this out of the desk's Phases tab into each
 * phase's Demo step**, so a new-road contract sets its demos up where they are
 * shown — and after the plan has locked, since the Demo step stays open until
 * its demo is approved. The legacy road's Phases tab draws the very same card,
 * so there is one implementation of it (house rule 3). It was `DemoCard` inside
 * `PhasesTab`; only its inputs changed (the contract and `me` are props, not the
 * workspace outlet's, because a step panel is also drawn where there is no
 * outlet), and `contractId` is bound on every write as the outlet's
 * `useWorkspaceMutation` bound it.
 */

// House rule 6: this codebase's existing, uneven convention is `err.message`
// straight from the server (see ScopeTab.tsx). The one exception carved out
// here is the staging-URL validation this stage explicitly calls for — the
// server returns a code, and this is where it becomes a sentence.
const KNOWN_ERROR_CODES = new Set(['STAGING_NOT_HTTPS', 'INVALID_STAGING_URL', 'STAGING_HOST_NOT_ALLOWED', 'STEP_LOCKED']);

/** Structural rather than i18next's TFunction — same reasoning as lib/changelog.ts's T. */
type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code && KNOWN_ERROR_CODES.has(code)) return t(`workspace.demoError.${code}`, { example: 'nahal.staging.m-root.com' });
  return (err as { message?: string })?.message ?? String(err);
}

type PageDesignOption = { id: string; label: string };

function DemoPageRow({
  page,
  contractId,
  designOptions,
  editable,
}: {
  page: DemoPage;
  contractId: string;
  designOptions: PageDesignOption[];
  editable: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [labelFa, setLabelFa] = useState(page.labelFa);
  const [labelEn, setLabelEn] = useState(page.labelEn);
  const [canonicalPath, setCanonicalPath] = useState(page.canonicalPath);
  const [pageDesignId, setPageDesignId] = useState(page.pageDesign?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_DEMO_PAGE, { variables: { contractId } });
  const [remove] = useMutation(DELETE_DEMO_PAGE, { variables: { contractId } });

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

  // Journeys build plan S1: declaring/editing a demo page is builds.author
  // plus being this contract's developer (canAuthorBuild) — a viewer without
  // either sees the same row as plain text, matching DesignTab's own
  // read-only PageRow.
  if (!editable) {
    return (
      <div className="demo-page-row">
        <span className="t-eyebrow num-latin">{page.key}</span>
        <span className="t-small">{pick(page, 'label', locale)}</span>
        <span className="t-small num-latin">{page.canonicalPath}</span>
      </div>
    );
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

export default function DemoSetup({
  contract,
  me,
  phase,
  demo,
  designOptions,
  editable,
  canConvertToTicket,
  onChanged,
}: {
  contract: Contract;
  me: User;
  /** The phase this demo belongs to: feedback on a demo is approved (and locked) per phase. */
  phase: Phase;
  demo: Demo;
  designOptions: PageDesignOption[];
  /** builds.author plus being this contract's developer (canAuthorBuild). */
  editable: boolean;
  canConvertToTicket: boolean;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const phaseId = phase.id;
  const demoStep = contract.wizard?.find((s) => s.step === 'DEMO' && s.phaseId === phaseId) ?? {
    step: 'DEMO' as const,
    phaseId,
    phaseNumber: phase.number,
    status: 'UPCOMING' as const,
    locked: false,
    lockedAt: null,
    takesInput: true,
    iterationsUsed: null,
    allowance: null,
    finishedAt: null,
  };
  const demoLocked = demoStep.locked;
  // J10: the staging site's readiness — heard by this viewport, recorded with who. The
  // viewer who may record it (the phase's developer, or sales) is the one whose browser
  // makes the claim; anyone else's viewport makes none.
  const canRecord = mayRecordReadiness(me, contract);
  const readiness = useDemoReadiness(demo, contract.id, canRecord, demoLocked);
  const [stagingUrl, setStagingUrl] = useState(demo.stagingUrl ?? '');
  const [buildRef, setBuildRef] = useState(demo.buildRef ?? '');
  const [reviewWindowStart, setReviewWindowStart] = useState(demo.reviewWindowStart?.slice(0, 10) ?? '');
  const [reviewWindowEnd, setReviewWindowEnd] = useState(demo.reviewWindowEnd?.slice(0, 10) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_DEMO, { variables: { contractId: contract.id } });
  const [remove] = useMutation(DELETE_DEMO, { variables: { contractId: contract.id } });

  const [addingPage, setAddingPage] = useState(false);
  const [pageKey, setPageKey] = useState('');
  const [pageLabelFa, setPageLabelFa] = useState('');
  const [pageLabelEn, setPageLabelEn] = useState('');
  const [pagePath, setPagePath] = useState('');
  const [pageError, setPageError] = useState<string | null>(null);
  const [declarePage, { loading: declaring }] = useMutation(DECLARE_DEMO_PAGE, { variables: { contractId: contract.id } });

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
      {editable ? (
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
      ) : (
        // Journeys build plan S1: a viewer who is not this contract's
        // developer (or lacks builds.author entirely) reads the demo's own
        // facts rather than a form every field of which would be refused.
        <div className="editor-grid-2">
          <p className="t-small">
            <span className="t-eyebrow">{t('workspace.demoStagingUrl')}</span>{' '}
            <span className="num-latin">{demo.stagingUrl ?? ''}</span>
          </p>
          {demo.buildRef ? (
            <p className="t-small">
              <span className="t-eyebrow">{t('workspace.demoBuildRef')}</span> <span className="num-latin">{demo.buildRef}</span>
            </p>
          ) : null}
        </div>
      )}

      {/* J10: the submission, in the order a developer does it — 1 the staging site reports in
          (the viewport below is what hears it), 2 the frame, 3 the version. */}
      <ReadinessStep demo={demo} canRecord={canRecord} recording={readiness.recording} error={readiness.error} />
      <div data-testid="demo-viewport">
        <DemoViewport demo={demo} onFirstReport={readiness.record} />
      </div>

      <p className="t-eyebrow">{t('demoStep.submit.frameStep')}</p>
      <DemoFeedbackPanel
        demo={demo}
        contractId={contract.id}
        phaseId={phaseId}
        audience="staff"
        canAuthor={editable}
        canAnswer={can(me, 'feedback.answer')}
        answerDirect={can(me, 'answers.direct.demo')}
        canConvertToTicket={canConvertToTicket}
        locked={demoLocked}
        onChanged={onChanged}
      />

      {editable ? <DemoSubmission contract={contract} phase={phase} demo={demo} step={demoStep} me={me} onChanged={onChanged} /> : null}

      <div className="workspace-row">
        <h4 className="t-h3">{t('workspace.demoPagesTitle')}</h4>
        {editable ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingPage((v) => !v)}>
            {t('workspace.addDemoPage')}
          </button>
        ) : null}
      </div>

      {addingPage && editable ? (
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
          <DemoPageRow key={p.id} page={p} contractId={contract.id} designOptions={designOptions} editable={editable} />
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
