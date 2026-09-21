import { useState, type FormEvent } from 'react';
import { useQuery, useMutation } from '@apollo/client';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, fullDateTime } from '@/lib/format';
import {
  PHASES_FOR_BUILDS,
  OPEN_FEEDBACK_QUEUE,
  SCOPE_ITEMS_AWAITING_BUILD,
  PROJECT_BUILDS,
  DECLARE_BUILD,
  PUBLISH_BUILD,
  type User,
  type BuildPhase,
  type FeedbackItem,
  type ScopeItemAwaitingBuild,
  type Build,
  type BuildChangeInput,
  type BuildChangeOutcome,
} from '@/lib/queries';

/**
 * Builds and the resolution ledger (build plan L3b; spec §6's gap) — the
 * developer's own section, filling in the stub `DESK_SECTIONS` gained at L1
 * (D6): their phases, the open feedback queue, and the build-authoring form.
 * An empty queue means done.
 *
 * Deliberately reads none of `Contract`. Every query and mutation this
 * screen calls is `builds.author`-gated (`lib/queries.ts`'s own comment) —
 * a `DEVELOPER` holding only that capability must never fetch the contract
 * text, the fee, the customer list or the billing surface, and this screen
 * has no code path that could.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

const KNOWN_ERROR_CODES = new Set([
  'MISSING_DISPOSITION',
  'CONCURRENT_BUILD',
  'ALREADY_PUBLISHED',
  'NOT_RATIFIED',
  'SCOPE_ITEM_NOT_IN_BUILD',
  'DUPLICATE_DISPOSITION',
]);

function errorMessage(err: unknown, t: T): string {
  const code = (err as { graphQLErrors?: Array<{ extensions?: { code?: string } }> })?.graphQLErrors?.[0]?.extensions
    ?.code;
  if (code && KNOWN_ERROR_CODES.has(code)) return t(`desk.builds.error.${code}`);
  return (err as { message?: string })?.message ?? String(err);
}

type Disposition = { outcome: BuildChangeOutcome; note: string; noteLang: 'fa' | 'en' };

const DEFAULT_DISPOSITION: Disposition = { outcome: 'CARRIED_FORWARD', note: '', noteLang: 'en' };

/**
 * One open feedback item, with the disposition the developer is about to
 * submit for it. D3's ratification gate stays visible here: a merely-OPEN
 * item may only be carried forward — the select below simply never offers
 * the other two options for one, rather than accepting a choice the server
 * would refuse as NOT_RATIFIED.
 */
function DispositionRow({
  item,
  locale,
  t,
  value,
  onChange,
}: {
  item: FeedbackItem;
  locale: 'fa' | 'en';
  t: T;
  value: Disposition;
  onChange: (d: Disposition) => void;
}) {
  const canAddressOrDecline = item.status === 'RATIFIED';
  const target = item.demoPage
    ? pick(item.demoPage, 'label', locale)
    : item.frameLine
      ? pick(item.frameLine, 'text', locale)
      : '';

  return (
    <div className="card editor-card">
      <div className="workspace-row">
        <span className={`badge feedback-status-${item.status.toLowerCase()}`}>{t(`feedback.status.${item.status}`)}</span>
        <span className="t-small">{target}</span>
      </div>
      {item.comments.map((c) => (
        <p className="feedback-comment" key={c.id}>
          <span className="t-eyebrow">{c.author.name}</span> — {c.body}
        </p>
      ))}
      <div className="editor-grid-2">
        <div className="field">
          <label className="label">{t('desk.builds.outcomeLabel')}</label>
          <select
            className="input"
            value={value.outcome}
            onChange={(e) => onChange({ ...value, outcome: e.target.value as BuildChangeOutcome })}
          >
            <option value="CARRIED_FORWARD">{t('desk.builds.outcome.CARRIED_FORWARD')}</option>
            {canAddressOrDecline ? (
              <>
                <option value="ADDRESSED">{t('desk.builds.outcome.ADDRESSED')}</option>
                <option value="DECLINED">{t('desk.builds.outcome.DECLINED')}</option>
              </>
            ) : null}
          </select>
        </div>
        {value.outcome !== 'CARRIED_FORWARD' ? (
          <div className="field">
            <label className="label">{t('desk.builds.noteLangLabel')}</label>
            <select
              className="input"
              value={value.noteLang}
              onChange={(e) => onChange({ ...value, noteLang: e.target.value as 'fa' | 'en' })}
            >
              <option value="en">{t('desk.builds.lang.en')}</option>
              <option value="fa">{t('desk.builds.lang.fa')}</option>
            </select>
          </div>
        ) : null}
      </div>
      {value.outcome !== 'CARRIED_FORWARD' ? (
        <div className="field">
          <label className="label">
            {value.outcome === 'DECLINED' ? t('desk.builds.declineReasonLabel') : t('desk.builds.noteLabel')}
          </label>
          <textarea
            className="input"
            rows={2}
            value={value.note}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

type UnpromptedDraft = { note: string; noteLang: 'fa' | 'en' };

function BuildWorkspace({ phase }: { phase: BuildPhase }) {
  const { t } = useTranslation();
  const locale = useLocale();

  const queueQuery = useQuery<{ openFeedbackQueue: FeedbackItem[] }>(OPEN_FEEDBACK_QUEUE, {
    variables: { projectId: phase.projectId },
  });
  const scopeQuery = useQuery<{ scopeItemsAwaitingBuild: ScopeItemAwaitingBuild[] }>(SCOPE_ITEMS_AWAITING_BUILD, {
    variables: { projectId: phase.projectId },
  });
  const buildsQuery = useQuery<{ projectBuilds: Build[] }>(PROJECT_BUILDS, { variables: { projectId: phase.projectId } });

  const [declareBuild, { loading: declaring }] = useMutation(DECLARE_BUILD);
  const [publishBuild, { loading: publishing }] = useMutation(PUBLISH_BUILD);

  const [ref, setRef] = useState('');
  const [dispositions, setDispositions] = useState<Record<string, Disposition>>({});
  const [shipping, setShipping] = useState<Set<string>>(new Set());
  const [unprompted, setUnprompted] = useState<UnpromptedDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  const queue = queueQuery.data?.openFeedbackQueue ?? [];
  const scopeItems = scopeQuery.data?.scopeItemsAwaitingBuild ?? [];
  const builds = [...(buildsQuery.data?.projectBuilds ?? [])].sort((a, b) => b.number - a.number);

  const getDisposition = (id: string) => dispositions[id] ?? DEFAULT_DISPOSITION;
  const setDisposition = (id: string, d: Disposition) => setDispositions((prev) => ({ ...prev, [id]: d }));

  function toggleShip(id: string) {
    setShipping((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addUnprompted() {
    setUnprompted((prev) => [...prev, { note: '', noteLang: 'en' }]);
  }
  function updateUnprompted(i: number, patch: Partial<UnpromptedDraft>) {
    setUnprompted((prev) => prev.map((u, idx) => (idx === i ? { ...u, ...patch } : u)));
  }
  function removeUnprompted(i: number) {
    setUnprompted((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function onDeclare(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const changes: BuildChangeInput[] = [];
    for (const item of queue) {
      const d = getDisposition(item.id);
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
    for (const id of shipping) changes.push({ scopeItemId: id });
    for (const u of unprompted) {
      if (!u.note.trim()) {
        setError(t('desk.builds.error.NOTE_REQUIRED'));
        return;
      }
      changes.push({ note: u.note.trim(), noteLang: u.noteLang });
    }

    try {
      await declareBuild({ variables: { phaseId: phase.id, ref: ref.trim() || null, changes } });
      setRef('');
      setDispositions({});
      setShipping(new Set());
      setUnprompted([]);
      await Promise.all([queueQuery.refetch(), scopeQuery.refetch(), buildsQuery.refetch()]);
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  async function onPublish(buildId: string) {
    setPublishError(null);
    try {
      await publishBuild({ variables: { buildId } });
    } catch (err) {
      setPublishError(errorMessage(err, t));
    }
  }

  return (
    <div className="card">
      <h3 className="t-h3">{pick(phase, 'title', locale)}</h3>

      <form className="card editor-card auth-form" onSubmit={onDeclare}>
        <div className="field">
          <label className="label">{t('desk.builds.refLabel')}</label>
          <input className="input num-latin" dir="ltr" placeholder="v1.4.0" value={ref} onChange={(e) => setRef(e.target.value)} />
        </div>

        <p className="t-eyebrow">{t('desk.builds.openQueueTitle')}</p>
        {queueQuery.loading ? null : queue.length === 0 ? (
          <p className="t-small muted">{t('desk.builds.queueEmpty')}</p>
        ) : (
          <div className="editor-list">
            {queue.map((item) => (
              <DispositionRow
                key={item.id}
                item={item}
                locale={locale}
                t={t}
                value={getDisposition(item.id)}
                onChange={(d) => setDisposition(item.id, d)}
              />
            ))}
          </div>
        )}

        <p className="t-eyebrow">{t('desk.builds.scopeReadyTitle')}</p>
        {scopeQuery.loading ? null : scopeItems.length === 0 ? (
          <p className="t-small muted">{t('desk.builds.scopeEmpty')}</p>
        ) : (
          <div className="workspace-row" style={{ flexWrap: 'wrap' }}>
            {scopeItems.map((s) => (
              <label key={s.id} className="badge">
                <input type="checkbox" checked={shipping.has(s.id)} onChange={() => toggleShip(s.id)} />
                {pick(s, 'label', locale)}
              </label>
            ))}
          </div>
        )}

        <div className="workspace-row">
          <p className="t-eyebrow">{t('desk.builds.unpromptedTitle')}</p>
          <button className="btn btn-ghost btn-sm" type="button" onClick={addUnprompted}>
            {t('desk.builds.addUnprompted')}
          </button>
        </div>
        {unprompted.map((u, i) => (
          <div className="editor-grid-2" key={i}>
            <div className="field">
              <label className="label">{t('desk.builds.noteLabel')}</label>
              <textarea className="input" rows={2} value={u.note} onChange={(e) => updateUnprompted(i, { note: e.target.value })} />
            </div>
            <div className="field">
              <label className="label">{t('desk.builds.noteLangLabel')}</label>
              <select className="input" value={u.noteLang} onChange={(e) => updateUnprompted(i, { noteLang: e.target.value as 'fa' | 'en' })}>
                <option value="en">{t('desk.builds.lang.en')}</option>
                <option value="fa">{t('desk.builds.lang.fa')}</option>
              </select>
            </div>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => removeUnprompted(i)}>
              {t('workspace.delete')}
            </button>
          </div>
        ))}

        {error ? <p className="error">{error}</p> : null}
        <div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={declaring}>
            {t('desk.builds.declare')}
          </button>
        </div>
      </form>

      <div>
        <p className="t-eyebrow">{t('desk.builds.pastBuildsTitle')}</p>
        {buildsQuery.loading ? null : builds.length === 0 ? (
          <p className="t-small muted">{t('desk.builds.noBuilds')}</p>
        ) : (
          builds.map((b) => (
            <div className="card editor-card" key={b.id}>
              <div className="workspace-row">
                <span className="t-h3 num-latin">#{b.number}</span>
                {b.ref ? <span className="t-small num-latin">{b.ref}</span> : null}
                <span className="t-caption">{fullDateTime(b.deployedAt, locale)}</span>
                {b.publishedAt ? (
                  <span className="badge">{t('desk.builds.published')}</span>
                ) : (
                  <button className="btn btn-secondary btn-sm" type="button" onClick={() => onPublish(b.id)} disabled={publishing}>
                    {t('desk.builds.publish')}
                  </button>
                )}
              </div>
              {publishError ? <p className="error">{publishError}</p> : null}
              {b.changes.map((c) => (
                <div className="feedback-thread" key={c.id}>
                  <div className="feedback-thread-head">
                    {c.outcome ? <span className="badge">{t(`desk.builds.outcome.${c.outcome}`)}</span> : null}
                    {c.scopeItem ? <span className="t-small">{pick(c.scopeItem, 'label', locale)}</span> : null}
                    {c.feedbackItem ? (
                      <span className="t-small">
                        {c.feedbackItem.demoPage
                          ? pick(c.feedbackItem.demoPage, 'label', locale)
                          : c.feedbackItem.frameLine
                            ? pick(c.feedbackItem.frameLine, 'text', locale)
                            : ''}
                      </span>
                    ) : null}
                  </div>
                  {c.note ? <p className="t-small">{c.note}</p> : null}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function Builds() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const [selectedPhaseId, setSelectedPhaseId] = useState('');

  const { data } = useQuery<{ phasesForBuilds: BuildPhase[] }>(PHASES_FOR_BUILDS, { skip: !can(me, 'builds.author') });

  if (!can(me, 'builds.author')) {
    return <Navigate to={lp(locale, '/desk')} replace />;
  }

  const phases = data?.phasesForBuilds ?? [];
  const selectedPhase = phases.find((p) => p.id === selectedPhaseId) ?? null;

  return (
    <div className="builds-page">
      <div className="card">
        <h2 className="t-h3">{t('desk.builds.title')}</h2>
        <p className="t-small muted">{t('desk.builds.intro')}</p>

        {phases.length === 0 ? (
          <p className="t-small muted">{t('desk.builds.noPhases')}</p>
        ) : (
          <div className="field">
            <label className="label">{t('desk.builds.pickPhase')}</label>
            <select className="input" value={selectedPhaseId} onChange={(e) => setSelectedPhaseId(e.target.value)}>
              <option value="">{t('desk.builds.pickPhasePlaceholder')}</option>
              {phases.map((p) => (
                <option key={p.id} value={p.id}>
                  {pick({ labelFa: p.projectTitleFa, labelEn: p.projectTitleEn }, 'label', locale)} — {pick(p, 'title', locale)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {selectedPhase ? <BuildWorkspace phase={selectedPhase} /> : null}
    </div>
  );
}
