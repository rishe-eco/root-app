import { useCallback, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can, canAuthorBuild } from '@/lib/access';
import { formatCount, fullDateTime, pick } from '@/lib/format';
import { isExhausted, roundCounter } from '@/lib/design';
import {
  CONFIRM_PAGE_MAP,
  CONTRACT_FEEDBACK,
  DECLARE_BUILD,
  PUBLISH_BUILD,
  VERIFY_DEMO_READINESS,
  type BuildChangeInput,
  type Contract,
  type Demo,
  type FeedbackItem,
  type Phase,
  type User,
  type WizardStep,
} from '@/lib/queries';
import { errorCode } from '@/components/FeedbackPanel';
import { AllowanceBox } from '@/components/DesignAuthor';
import { DEFAULT_DISPOSITION, DispositionRow, type Disposition } from '@/components/DispositionRow';

/**
 * Step 6 from the developer's side (journeys build plan J10; journeys §7.5) — the
 * submission of a phase's demo, as one form per version, with the readiness check
 * as a visible first step:
 *
 * 1. **Readiness** — the staging site has to be *heard from* before the demo can be
 *    published. The viewport (`DemoViewport`) does the hearing: when the reporter
 *    snippet's first report arrives from the demo's own origin, it hands that origin
 *    to `useDemoReadiness`, which records it — **a browser's claim, recorded with
 *    who** (`verifyDemoReadiness`). Nothing here, and nothing on the server, can
 *    know more than that.
 * 2. **The frame, including how to test** — authored in `DemoFeedbackPanel` (its
 *    lines are the same ones the customer comments on); this file only names the
 *    step.
 * 3. **This version** — the build ref, the **page map confirmed for this build**,
 *    a disposition for every open note, what shipped and what changed unasked. Then
 *    publish: refused until the map is confirmed, and against the phase's allowance.
 *
 * The review window (journeys §7.5 item 9) is two dates on the demo's own form
 * (`PhasesTab`), kept where the staging address is.
 *
 * Whether a control shows is `can()` and the assignment; whether it works is the API's.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

/** A sentence for a refusal: this form's own wording first, then the desk's builds
 *  screen's, then the server's message. House rule 6 — the API sends codes. */
function errorText(t: T, err: unknown): string {
  const code = errorCode(err);
  if (code) {
    for (const key of [`demoStep.submit.error.${code}`, `desk.builds.error.${code}`]) {
      const text = t(key, { defaultValue: '' });
      if (text) return text;
    }
  }
  return (err as Error).message;
}

/**
 * Records a staging site's readiness when the viewport hears from it — the one
 * place the browser's claim is made. `canRecord` mirrors the server's rule (the
 * phase's developer, or sales), so a customer's or a designer's viewport makes no
 * call that could only be refused.
 */
export function useDemoReadiness(demo: Demo, contractId: string, canRecord: boolean, locked: boolean) {
  const [verify, { loading }] = useMutation(VERIFY_DEMO_READINESS);
  const [error, setError] = useState<string | null>(null);
  const { t } = useTranslation();
  const demoId = demo.id;
  const ready = demo.readyAt != null;
  const record = useCallback(
    (origin: string) => {
      if (!canRecord || locked || ready) return;
      setError(null);
      verify({ variables: { demoId, origin, contractId } }).catch((err) => {
        const code = errorCode(err);
        setError(code ? t(`demoStep.readiness.error.${code}`, { defaultValue: (err as Error).message }) : (err as Error).message);
      });
    },
    [canRecord, locked, ready, verify, demoId, contractId, t],
  );
  return { record: canRecord ? record : undefined, recording: loading, error };
}

/** Whether this viewer may record readiness (the server's rule, mirrored). */
export const mayRecordReadiness = (me: User, contract: Pick<Contract, 'developer'>): boolean =>
  canAuthorBuild(me, contract) || can(me, 'contracts.author');

/** Step 1, as the desk shows it: where readiness stands and what to do about it. */
export function ReadinessStep({
  demo,
  canRecord,
  recording,
  error,
}: {
  demo: Demo;
  canRecord: boolean;
  recording: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div className="demo-readiness" data-testid="demo-readiness" data-ready={demo.readyAt ? 'true' : 'false'}>
      <p className="t-eyebrow">{t('demoStep.readiness.title')}</p>
      {demo.readyAt ? (
        <p className="t-small" data-testid="demo-ready">
          {t('demoStep.readiness.ready', {
            when: fullDateTime(demo.readyAt, locale),
            who: demo.readyVerifiedBy?.name ?? '',
          })}
        </p>
      ) : (
        <p className="t-small" data-testid="demo-not-ready">
          {recording ? t('demoStep.readiness.recording') : demo.publishedAt ? t('demoStep.readiness.cleared') : t('demoStep.readiness.pending')}
        </p>
      )}
      {!demo.readyAt ? <p className="t-caption desk-muted">{t('demoStep.readiness.help', { attribute: 'data-enabled="true"', path: 'snippets/demo-reporter' })}</p> : null}
      {!canRecord && !demo.readyAt ? <p className="t-caption desk-muted">{t('demoStep.readiness.notYours')}</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** One of the phase's builds: its number, whether the map is confirmed, and what can be done next. */
function BuildRow({
  build,
  busy,
  exhausted,
  onConfirm,
  onPublish,
}: {
  build: NonNullable<Phase['builds']>[number];
  busy: boolean;
  exhausted: boolean;
  onConfirm: () => void;
  onPublish: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div className="card editor-card" data-testid="demo-build" data-build={build.number} data-published={build.publishedAt ? 'true' : 'false'}>
      <div className="workspace-row">
        <span className="t-h3 num-latin">#{build.number}</span>
        {build.ref ? <span className="t-small num-latin">{build.ref}</span> : null}
        {build.publishedAt ? (
          <span className="badge">{t('demoStep.submit.published', { when: fullDateTime(build.publishedAt, locale) })}</span>
        ) : (
          <>
            <span className="badge">{t('demoStep.submit.draft')}</span>
            {build.pageMapConfirmedAt ? (
              <span className="t-caption" data-testid="map-confirmed">
                {t('demoStep.submit.mapConfirmed', { when: fullDateTime(build.pageMapConfirmedAt, locale) })}
              </span>
            ) : (
              <>
                <span className="t-caption req-notice" data-testid="map-unconfirmed">
                  {t('demoStep.submit.mapUnconfirmed')}
                </span>
                <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={onConfirm} data-testid="confirm-map">
                  {t('demoStep.submit.confirmAction')}
                </button>
              </>
            )}
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={busy || !build.pageMapConfirmedAt || exhausted}
              onClick={onPublish}
              data-testid="publish-build"
            >
              {t('demoStep.submit.publish')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function DemoSubmission({
  contract,
  phase,
  demo,
  step,
  me,
  onChanged,
}: {
  contract: Contract;
  phase: Phase;
  demo: Demo | null;
  step: WizardStep;
  me: User;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const locked = step.locked;
  const counter = roundCounter(step);
  const exhausted = isExhausted(counter);

  const { data } = useQuery<{ contract: { id: string; feedbackItems: FeedbackItem[] } }>(CONTRACT_FEEDBACK, {
    variables: { id: contract.id, step: 'DEMO', phaseId: phase.id, asCustomer: null },
    fetchPolicy: 'cache-and-network',
  });
  const open = (data?.contract.feedbackItems ?? []).filter((i) => i.status === 'OPEN');
  const shipping = phase.scopeItems.filter((s) => s.status === 'IN_BUILD');
  const builds = [...(phase.builds ?? [])].sort((a, b) => b.number - a.number);

  const [declare, { loading: declaring }] = useMutation(DECLARE_BUILD);
  const [confirm, { loading: confirming }] = useMutation(CONFIRM_PAGE_MAP);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_BUILD);
  const busy = declaring || confirming || publishing;

  const [ref, setRef] = useState('');
  const [confirmMap, setConfirmMap] = useState(false);
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});
  const [shipped, setShipped] = useState<Set<string>>(new Set());
  const [unprompted, setUnprompted] = useState<Array<{ note: string; noteLang: 'fa' | 'en' }>>([]);
  const [error, setError] = useState<string | null>(null);

  const disposition = (id: string) => dispositions[id] ?? DEFAULT_DISPOSITION;

  async function onDeclare(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const changes: BuildChangeInput[] = [];
    for (const item of open) {
      const d = disposition(item.id);
      if (d.outcome !== 'CARRIED_FORWARD' && !d.note.trim()) {
        setError(t(d.outcome === 'DECLINED' ? 'desk.builds.error.DECLINE_REASON_REQUIRED' : 'desk.builds.error.NOTE_REQUIRED'));
        return;
      }
      changes.push({
        feedbackItemId: item.id,
        outcome: d.outcome,
        note: d.outcome === 'CARRIED_FORWARD' ? null : d.note.trim(),
        noteLang: d.outcome === 'CARRIED_FORWARD' ? null : d.noteLang,
      });
    }
    for (const id of shipped) changes.push({ scopeItemId: id });
    for (const u of unprompted) {
      if (!u.note.trim()) {
        setError(t('desk.builds.error.NOTE_REQUIRED'));
        return;
      }
      changes.push({ note: u.note.trim(), noteLang: u.noteLang });
    }
    try {
      const res = await declare({ variables: { phaseId: phase.id, ref: ref.trim() || null, changes } });
      const buildId = (res.data as { declareBuild: { id: string } }).declareBuild.id;
      // The confirmation is its own act on the declared build (`confirmPageMap`), made
      // here only when the developer ticked it: an unticked form leaves a draft that
      // cannot be published.
      if (confirmMap) await confirm({ variables: { buildId } });
      setRef('');
      setConfirmMap(false);
      setDispositions({});
      setShipped(new Set());
      setUnprompted([]);
      onChanged();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  async function act(run: () => Promise<unknown>) {
    setError(null);
    try {
      await run();
      onChanged();
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  if (locked) {
    return (
      <p className="t-small locknote" data-testid="submission-locked">
        {t('demoStep.submit.locked')}
      </p>
    );
  }

  return (
    <div className="demo-submission" data-testid="demo-submission">
      <div className="workspace-row">
        <h4 className="t-h3">{t('demoStep.submit.title')}</h4>
        <span className="badge" data-testid="demo-counter">
          {counter.total === null
            ? t('demoStep.iterationOpen', { n: formatCount(counter.used, locale) })
            : t('demoStep.iteration', { n: formatCount(counter.used, locale), total: formatCount(counter.total, locale) })}
        </span>
      </div>
      <p className="t-caption desk-muted">{t('demoStep.submit.help')}</p>

      {can(me, 'contracts.author') || mayRecordReadiness(me, contract) ? (
        <AllowanceBox contract={contract} step={step} me={me} kind="DEMO" phaseId={phase.id} />
      ) : null}
      {exhausted ? (
        <p className="t-caption req-notice" data-testid="demo-exhausted">
          {t('demoStep.submit.exhausted')}
        </p>
      ) : null}

      {!demo ? (
        <p className="t-small desk-muted">{t('demoStep.submit.noDemo')}</p>
      ) : (
        <form className="card editor-card auth-form" onSubmit={onDeclare} data-testid="iteration-form">
          <p className="t-eyebrow">{t('demoStep.submit.versionStep')}</p>
          <div className="field">
            <label className="label">{t('desk.builds.refLabel')}</label>
            <input className="input num-latin" dir="ltr" placeholder="v1.4.0" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>

          <div className="demo-pagemap" data-testid="page-map">
            <p className="t-eyebrow">{t('demoStep.submit.mapTitle')}</p>
            <p className="t-caption desk-muted">{t('demoStep.submit.mapHelp')}</p>
            {demo.pages.length === 0 ? (
              <p className="t-small desk-muted">{t('demoStep.submit.mapEmpty')}</p>
            ) : (
              demo.pages.map((p) => (
                <div className="demo-page-row" key={p.id}>
                  <span className="t-small">{pick(p, 'label', locale)}</span>
                  <span className="t-small num-latin" dir="ltr">
                    {p.canonicalPath}
                  </span>
                </div>
              ))
            )}
            <label className="workspace-row">
              <input type="checkbox" checked={confirmMap} onChange={(e) => setConfirmMap(e.target.checked)} data-testid="confirm-map-box" />
              <span className="t-small">{t('demoStep.submit.mapConfirm')}</span>
            </label>
          </div>

          <p className="t-eyebrow">{t('desk.builds.openQueueTitle')}</p>
          {open.length === 0 ? (
            <p className="t-small desk-muted">{t('desk.builds.queueEmpty')}</p>
          ) : (
            <div className="editor-list">
              {open.map((item) => (
                <DispositionRow
                  key={item.id}
                  item={item}
                  locale={locale}
                  t={t}
                  value={disposition(item.id)}
                  onChange={(d) => setDispositions((prev) => ({ ...prev, [item.id]: d }))}
                />
              ))}
            </div>
          )}

          <p className="t-eyebrow">{t('desk.builds.scopeReadyTitle')}</p>
          {shipping.length === 0 ? (
            <p className="t-small desk-muted">{t('desk.builds.scopeEmpty')}</p>
          ) : (
            <div className="workspace-row" style={{ flexWrap: 'wrap' }}>
              {shipping.map((s) => (
                <label key={s.id} className="badge">
                  <input
                    type="checkbox"
                    checked={shipped.has(s.id)}
                    onChange={() =>
                      setShipped((prev) => {
                        const next = new Set(prev);
                        if (next.has(s.id)) next.delete(s.id);
                        else next.add(s.id);
                        return next;
                      })
                    }
                  />
                  {pick(s, 'label', locale)}
                </label>
              ))}
            </div>
          )}

          <div className="workspace-row">
            <p className="t-eyebrow">{t('desk.builds.unpromptedTitle')}</p>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setUnprompted((prev) => [...prev, { note: '', noteLang: 'en' }])}>
              {t('desk.builds.addUnprompted')}
            </button>
          </div>
          {unprompted.map((u, i) => (
            <div className="editor-grid-2" key={i}>
              <div className="field">
                <label className="label">{t('desk.builds.noteLabel')}</label>
                <textarea
                  className="input"
                  rows={2}
                  value={u.note}
                  onChange={(e) => setUnprompted((prev) => prev.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))}
                />
              </div>
              <div className="field">
                <label className="label">{t('desk.builds.noteLangLabel')}</label>
                <select
                  className="input"
                  value={u.noteLang}
                  onChange={(e) => setUnprompted((prev) => prev.map((x, j) => (j === i ? { ...x, noteLang: e.target.value as 'fa' | 'en' } : x)))}
                >
                  <option value="en">{t('desk.builds.lang.en')}</option>
                  <option value="fa">{t('desk.builds.lang.fa')}</option>
                </select>
              </div>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => setUnprompted((prev) => prev.filter((_, j) => j !== i))}>
                {t('workspace.delete')}
              </button>
            </div>
          ))}

          {error ? (
            <p className="error" role="alert" data-testid="submission-error">
              {error}
            </p>
          ) : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy} data-testid="declare-build">
              {t('demoStep.submit.declare')}
            </button>
          </div>
        </form>
      )}

      {builds.map((b) => (
        <BuildRow
          key={b.id}
          build={b}
          busy={busy}
          exhausted={exhausted}
          onConfirm={() => void act(() => confirm({ variables: { buildId: b.id } }))}
          onPublish={() => void act(() => publish({ variables: { buildId: b.id } }))}
        />
      ))}
    </div>
  );
}
