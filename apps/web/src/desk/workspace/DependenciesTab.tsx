import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, fullDateTime, calendarDate } from '@/lib/format';
import { day, refusalText } from '@/components/EditorKit';
import { instantOf } from '@/lib/brief';
import {
  CREATE_DEPENDENCY,
  UPDATE_DEPENDENCY,
  VERIFY_DEPENDENCY,
  UNVERIFY_DEPENDENCY,
  DELETE_DEPENDENCY,
  type Dependency,
  type DependencySide,
  type User,
} from '@/lib/queries';
import { useWorkspaceMutation, type WorkspaceContext } from './ContractWorkspace';

/**
 * The dependency board (build plan L5; spec §7) — symmetric commitments,
 * customer-side and Root-side, one board under one rule. The banked trap is
 * the entire feature: verifying a row requires saying *what was done*, never
 * only a click — the form below has no way to submit a verification with an
 * empty note (the server holds the same rule structurally either way).
 *
 * **DX3a: this board and Requirements' "Who provides what, by when" panel are
 * the same rows.** A row with `inBrief` is a handover item — it may be
 * undecided (no side) or undated, shows as such, and sorts last; before the
 * agreement is approved a row added here is `inBrief` and appears in
 * Requirements too. Once the agreement is approved those rows' title, side,
 * date and not-needed flag are fixed (the API refuses with `STEP_LOCKED`; the
 * form is not drawn for them) while marking one done still works, and a row
 * added after the lock is the board's alone and needs a side and a date.
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

function VerifyForm({
  dep,
  t,
  locale,
  canVerify,
}: {
  dep: Dependency;
  t: T;
  locale: 'fa' | 'en';
  canVerify: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [verify, { loading }] = useWorkspaceMutation(VERIFY_DEPENDENCY);
  const [unverify] = useWorkspaceMutation(UNVERIFY_DEPENDENCY);

  if (dep.verifiedAt) {
    return (
      <div className="feedback-thread">
        <p className="t-caption">
          {t('workspace.dependencyVerifiedLine', { name: dep.verifiedBy?.name ?? '', date: fullDateTime(dep.verifiedAt, locale) })}
        </p>
        <p className="t-small">{dep.verifiedNote}</p>
        {canVerify ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => unverify({ variables: { dependencyId: dep.id } })}>
            {t('workspace.dependencyUnverify')}
          </button>
        ) : null}
      </div>
    );
  }

  if (!canVerify) return null;

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
        {t('workspace.dependencyVerify')}
      </button>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    await verify({ variables: { dependencyId: dep.id, note: note.trim() } });
    setNote('');
    setOpen(false);
  }

  return (
    <form className="card editor-card auth-form" onSubmit={submit}>
      <div className="field">
        <label className="label">{t('workspace.dependencyVerifyNoteLabel')}</label>
        <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('workspace.dependencyVerifyNotePlaceholder')} />
      </div>
      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !note.trim()}>
          {t('workspace.dependencyVerify')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setOpen(false)}>
          {t('feedback.cancel')}
        </button>
      </div>
    </form>
  );
}

function DependencyRow({ dep, canManage, me, locked }: { dep: Dependency; canManage: boolean; me: User; locked: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [titleFa, setTitleFa] = useState(dep.titleFa);
  const [titleEn, setTitleEn] = useState(dep.titleEn);
  const [dueAt, setDueAt] = useState(day(dep.dueAt));
  const [side, setSide] = useState<DependencySide | ''>(dep.side ?? '');
  const [notNeeded, setNotNeeded] = useState(dep.notNeeded);
  const [error, setError] = useState<string | null>(null);
  const [update] = useWorkspaceMutation(UPDATE_DEPENDENCY);
  const [remove] = useWorkspaceMutation(DELETE_DEPENDENCY);
  // Journeys build plan J4: a technical row (the domain, the hosting) is the
  // developer's to verify, every other row sales'. The API holds the same rule
  // (and, for a technical row, that it is *this* project's developer) — a
  // button that can only be refused is worse than one that is not there.
  const canVerify = can(me, dep.technical ? 'dependencies.verifyTechnical' : 'dependencies.verifyGeneral');
  // The requirements own a row they created (`briefKey`): its title and side
  // come from the brief, and it is not deleted from here (`BRIEF_OWNED`) — only
  // its date is edited, the one thing the brief's form asks separately.
  const fromBrief = dep.briefKey !== null;
  // A handover item the agreement has fixed: nothing on it is edited or deleted here, only marked done.
  const fixed = dep.inBrief && locked;
  // A requirements row may be undecided and undated; a board-only one needs both.
  const optional = dep.inBrief;

  // DX4 (review 27): a commitment saves when a field in its edit form is left. `updateDependency`
  // is a replace of what is named, so a save sends the form as it stands.
  const autosave = useAutosave({
    value: { titleFa, titleEn, side, notNeeded, dueAt },
    baseline: { titleFa: dep.titleFa, titleEn: dep.titleEn, side: dep.side ?? '', notNeeded: dep.notNeeded, dueAt: day(dep.dueAt) },
    valid: (v) => (fromBrief || hasOneTitle(v.titleFa, v.titleEn)) && (optional || (v.side !== '' && v.dueAt !== '')),
    save: (v) =>
      update({
        variables: {
          dependencyId: dep.id,
          // The default list's and the extras' titles are the list's (an extra's is rewritten by the next save of the requirements).
          ...(fromBrief ? {} : { titleFa: v.titleFa, titleEn: v.titleEn }),
          side: v.side || null,
          notNeeded: v.notNeeded,
          dueAt: instantOf(v.dueAt),
        },
      }),
    disabled: !canManage || fixed,
    errorText: (err) => refusalText(t, err),
  });

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteDependency'))) return;
    setError(null);
    try {
      await remove({ variables: { dependencyId: dep.id } });
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className={`card editor-card${dep.overdue ? ' dependency-overdue' : ''}`} data-testid="dependency-row" data-key={dep.briefKey ?? dep.id}>
      <div className="workspace-row">
        {dep.notNeeded ? (
          <span className="badge badge-neutral" data-testid="dependency-not-needed">{t('workspace.dependencyNotNeeded')}</span>
        ) : dep.side ? (
          <span className="badge">{t(`workspace.dependencySide.${dep.side}`)}</span>
        ) : (
          <span className="badge badge-neutral" data-testid="dependency-undecided">{t('workspace.dependencyUndecided')}</span>
        )}
        {dep.inBrief ? <span className="badge" data-testid="dependency-in-brief">{t('workspace.dependencyInRequirements')}</span> : null}
        {dep.overdue ? <span className="badge dependency-overdue-badge">{t('workspace.dependencyOverdue')}</span> : null}
        {fromBrief ? <span className="badge" data-testid="dependency-from-brief">{t('workspace.dependencyFromBrief')}</span> : null}
        {dep.technical ? <span className="badge" data-testid="dependency-technical">{t('workspace.dependencyTechnical')}</span> : null}
        <span className="t-small" style={{ flex: 1 }}>
          {pick(dep, 'title', locale)}
        </span>
        {/* A due date is a day (PD-19), whatever the column's type: the board's
            own date input writes midnight UTC, and so does the brief. */}
        <span className="t-caption" data-testid="dependency-due">
          {dep.dueAt ? calendarDate(dep.dueAt, locale) : t('workspace.dependencyUndated')}
        </span>
        {canManage && !fixed ? (
          <>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setEditing((v) => !v)}>
              {t('workspace.edit')}
            </button>
            {fromBrief ? null : (
              <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
                {t('workspace.delete')}
              </button>
            )}
          </>
        ) : null}
      </div>

      {fixed && canManage ? <p className="t-caption" data-testid="dependency-fixed">{t('workspace.dependencyLockedHelp')}</p> : null}
      {error ? <p className="error" role="alert" data-testid="dependency-error">{error}</p> : null}

      {editing && canManage && !fixed ? (
        <form className="card editor-card auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
          {fromBrief ? (
            <p className="t-caption">{t('workspace.dependencyBriefOwnedHelp')}</p>
          ) : (
            <TitleField idBase={`dependency-${dep.id}`} testId="dependency-title" fa={titleFa} en={titleEn} onChange={(v) => { setTitleFa(v.fa); setTitleEn(v.en); }} />
          )}
          <div className="field">
            <label className="label">{t('workspace.dependencySideLabel')}</label>
            <select
              className="input"
              required={!optional}
              value={side}
              onChange={(e) => {
                setSide(e.target.value as DependencySide | '');
                autosave.commit({ titleFa, titleEn, side: e.target.value, notNeeded, dueAt });
              }}
            >
              {optional ? <option value="">{t('workspace.dependencyUndecided')}</option> : null}
              <option value="CUSTOMER">{t('workspace.dependencySide.CUSTOMER')}</option>
              <option value="ROOT">{t('workspace.dependencySide.ROOT')}</option>
            </select>
          </div>
          {optional ? (
            <label className="theme-check">
              <input
                type="checkbox"
                checked={notNeeded}
                onChange={(e) => {
                  setNotNeeded(e.target.checked);
                  autosave.commit({ titleFa, titleEn, side, notNeeded: e.target.checked, dueAt });
                }}
              />
              {t('workspace.dependencyNotNeededLabel')}
            </label>
          ) : null}
          <div className="field">
            <label className="label">{optional ? t('workspace.dependencyDueOptional') : t('workspace.dependencyDueAt')}</label>
            <input className="input num-latin" type="date" required={!optional} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          <AutosaveNote autosave={autosave} testId="dependency-autosave" />
        </form>
      ) : null}

      <VerifyForm dep={dep} t={t} locale={locale} canVerify={canVerify} />
    </div>
  );
}

export default function DependenciesTab() {
  const { t } = useTranslation();
  const { contract, me } = useOutletContext<WorkspaceContext>();
  const project = contract.project;
  // Journeys build plan S1: what is owed and by when is contracts.author (the
  // agreement). Marking a row met is per row since J4: a technical row is the
  // developer's (`dependencies.verifyTechnical`), any other sales'
  // (`dependencies.verifyGeneral`) — so the board is read-only for a person
  // holding neither, and each row asks for its own.
  const canManage = can(me, 'contracts.author');

  const [adding, setAdding] = useState(false);
  const [side, setSide] = useState<DependencySide | ''>('CUSTOMER');
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createDependency, { loading }] = useWorkspaceMutation(CREATE_DEPENDENCY);
  // Before the agreement is approved a row added here is a requirements row too, and may be left undecided and
  // undated; after, it is the board's alone and needs both (`DEPENDENCY_INCOMPLETE`).
  const locked = contract.wizard?.find((w) => w.step === 'REQUIREMENTS')?.locked ?? false;
  const onRoad = contract.sequence === 'AGREEMENT_FIRST';
  const optional = onRoad && !locked;

  if (!project) {
    return <p className="t-small muted">{t('workspace.phaseNoProject')}</p>;
  }

  // Soonest first, the undated last (the API sorts the same way; sorted again so a refetch cannot reorder it).
  const rows = [...project.dependencies].sort((a, b) => {
    if (a.dueAt === null || b.dueAt === null) return a.dueAt === b.dueAt ? 0 : a.dueAt === null ? 1 : -1;
    return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  });

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!hasOneTitle(titleFa, titleEn) || (!optional && (!dueAt || !side))) return;
    try {
      await createDependency({
        variables: { projectId: project!.id, side: side || null, titleFa: titleFa.trim(), titleEn: titleEn.trim(), dueAt: instantOf(dueAt) },
      });
      setAdding(false);
      setTitleFa('');
      setTitleEn('');
      setDueAt('');
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  return (
    <div className="dependency-board">
      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.dependenciesTitle')}</h3>
        {canManage ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding((v) => !v)}>
            {t('workspace.addDependency')}
          </button>
        ) : null}
      </div>
      <p className="sec-help">{t('workspace.dependenciesHelp')}</p>

      {adding && canManage ? (
        <form className="card editor-card auth-form" onSubmit={onAdd}>
          <div className="field">
            <label className="label">{t('workspace.dependencySideLabel')}</label>
            <select className="input" required={!optional} value={side} onChange={(e) => setSide(e.target.value as DependencySide | '')}>
              {optional ? <option value="">{t('workspace.dependencyUndecided')}</option> : null}
              <option value="CUSTOMER">{t('workspace.dependencySide.CUSTOMER')}</option>
              <option value="ROOT">{t('workspace.dependencySide.ROOT')}</option>
            </select>
          </div>
          <TitleField idBase="tf-2" fa={titleFa} en={titleEn} onChange={(v) => { setTitleFa(v.fa); setTitleEn(v.en); }} />
          <div className="field">
            <label className="label">{optional ? t('workspace.dependencyDueOptional') : t('workspace.dependencyDueAt')}</label>
            <input className="input num-latin" type="date" required={!optional} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading || !hasOneTitle(titleFa, titleEn)}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      {rows.length === 0 ? (
        <p className="t-small muted">{t('workspace.dependenciesEmpty')}</p>
      ) : (
        <div className="editor-list">
          {rows.map((dep) => (
            <DependencyRow key={dep.id} dep={dep} canManage={canManage} me={me} locked={locked} />
          ))}
        </div>
      )}
    </div>
  );
}
