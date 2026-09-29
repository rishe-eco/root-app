import { useState, type FormEvent } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, fullDateTime, calendarDate } from '@/lib/format';
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

function DependencyRow({ dep, canManage, me }: { dep: Dependency; canManage: boolean; me: User }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [titleFa, setTitleFa] = useState(dep.titleFa);
  const [titleEn, setTitleEn] = useState(dep.titleEn);
  const [dueAt, setDueAt] = useState(dep.dueAt.slice(0, 10));
  const [update, { loading }] = useWorkspaceMutation(UPDATE_DEPENDENCY);
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

  async function onSave(e: FormEvent) {
    e.preventDefault();
    await update({ variables: { dependencyId: dep.id, titleFa, titleEn, dueAt: new Date(dueAt).toISOString() } });
    setEditing(false);
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteDependency'))) return;
    await remove({ variables: { dependencyId: dep.id } });
  }

  return (
    <div className={`card editor-card${dep.overdue ? ' dependency-overdue' : ''}`}>
      <div className="workspace-row">
        <span className="badge">{t(`workspace.dependencySide.${dep.side}`)}</span>
        {dep.overdue ? <span className="badge dependency-overdue-badge">{t('workspace.dependencyOverdue')}</span> : null}
        {fromBrief ? <span className="badge" data-testid="dependency-from-brief">{t('workspace.dependencyFromBrief')}</span> : null}
        {dep.technical ? <span className="badge" data-testid="dependency-technical">{t('workspace.dependencyTechnical')}</span> : null}
        <span className="t-small" style={{ flex: 1 }}>
          {pick(dep, 'title', locale)}
        </span>
        {/* A due date is a day (PD-19), whatever the column's type: the board's
            own date input writes midnight UTC, and so does the brief. */}
        <span className="t-caption" data-testid="dependency-due">{calendarDate(dep.dueAt, locale)}</span>
        {canManage ? (
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

      {editing && canManage ? (
        <form className="card editor-card auth-form" onSubmit={onSave}>
          {fromBrief ? (
            <p className="t-caption">{t('workspace.dependencyBriefOwnedHelp')}</p>
          ) : (
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
          )}
          <div className="field">
            <label className="label">{t('workspace.dependencyDueAt')}</label>
            <input className="input num-latin" type="date" required value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
            {t('workspace.save')}
          </button>
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
  const [side, setSide] = useState<DependencySide>('CUSTOMER');
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createDependency, { loading }] = useWorkspaceMutation(CREATE_DEPENDENCY);

  if (!project) {
    return <p className="t-small muted">{t('workspace.phaseNoProject')}</p>;
  }

  const rows = [...project.dependencies].sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!titleFa.trim() || !titleEn.trim() || !dueAt) return;
    try {
      await createDependency({
        variables: { projectId: project!.id, side, titleFa: titleFa.trim(), titleEn: titleEn.trim(), dueAt: new Date(dueAt).toISOString() },
      });
      setAdding(false);
      setTitleFa('');
      setTitleEn('');
      setDueAt('');
    } catch (err) {
      setError((err as Error).message);
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
            <select className="input" value={side} onChange={(e) => setSide(e.target.value as DependencySide)}>
              <option value="CUSTOMER">{t('workspace.dependencySide.CUSTOMER')}</option>
              <option value="ROOT">{t('workspace.dependencySide.ROOT')}</option>
            </select>
          </div>
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
            <label className="label">{t('workspace.dependencyDueAt')}</label>
            <input className="input num-latin" type="date" required value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          {error ? <p className="error">{error}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
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
            <DependencyRow key={dep.id} dep={dep} canManage={canManage} me={me} />
          ))}
        </div>
      )}
    </div>
  );
}
