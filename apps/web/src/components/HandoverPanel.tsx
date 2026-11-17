import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick } from '@/lib/format';
import { SectionHead, day, refusalText } from '@/components/EditorKit';
import DayInput from '@/components/DayInput';
import PillChoice from '@/components/PillChoice';
import { choiceOf, handoverPatch, instantOf, type HandoverChoice } from '@/lib/brief';
import { CREATE_DEPENDENCY, DELETE_DEPENDENCY, UPDATE_DEPENDENCY, type Contract, type Dependency } from '@/lib/queries';

/**
 * Requirements' "Who provides what, by when" (DX3a, desk UX review 6–8, decision
 * log row 15): one row per handover item — the item, then who as pills (Root ·
 * Customer · Not needed, every one optional, a second press clears it), then a
 * due date, then remove (one-off rows only).
 *
 * **These are the Dependencies tab's rows, not a copy of them.** Every row here
 * is a `Dependency` with `inBrief` (`Contract.handover`), and Save writes it
 * through the board's own `updateDependency`; a row added here is created
 * through `createDependency`, which makes it `inBrief` while the step is open.
 * So an edit from either place is the other's the moment it is saved, and the
 * two cannot drift.
 *
 * **The pills are one choice, not two fields.** The record has a side and a
 * not-needed flag; the panel shows the flag when it is set and the side
 * otherwise, and each press sets both (Not needed clears the side, Root or
 * Customer clears the flag). A row with neither is undecided, which is a
 * complete state: nobody has to name a provider, and a date is only asked of a
 * row someone provides (`briefCompleteness`).
 *
 * Saved on its own, like the brief above it, and — as the brief is — not drawn
 * at all once the agreement is approved: a locked list (`STEP_LOCKED`) is a
 * control that can only fail. The caller (`RequirementsEditor`) is only drawn
 * for an open step; this panel still says so if it is handed a locked one.
 */

type Choice = HandoverChoice;

type RowState = { choice: Choice | null; due: string };

/** A new row typed here and not yet saved. */
type Draft = { tmp: string; titleFa: string; titleEn: string } & RowState;

const stateOf = (d: Dependency): RowState => ({ choice: choiceOf(d), due: day(d.dueAt) });

export default function HandoverPanel({ contract, locked = false }: { contract: Contract; locked?: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const rows = contract.handover ?? [];
  const [edits, setEdits] = useState<Record<string, RowState>>({});
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [adding, setAdding] = useState(false);
  const [newFa, setNewFa] = useState('');
  const [newEn, setNewEn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [update, { loading: updating }] = useMutation(UPDATE_DEPENDENCY);
  const [create, { loading: creating }] = useMutation(CREATE_DEPENDENCY);
  const [remove] = useMutation(DELETE_DEPENDENCY);

  // What a row shows: the edit in progress if there is one, the record otherwise.
  const current = (d: Dependency): RowState => edits[d.id] ?? stateOf(d);
  const dirtyRows = rows.filter((d) => {
    const e = edits[d.id];
    const s = stateOf(d);
    return e && (e.choice !== s.choice || e.due !== s.due);
  });
  const dirty = dirtyRows.length > 0 || drafts.length > 0;

  const setRow = (id: string, base: RowState, patch: Partial<RowState>) => {
    setSaved(false);
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), ...patch } }));
  };
  const setDraft = (tmp: string, patch: Partial<RowState>) => {
    setSaved(false);
    setDrafts((prev) => prev.map((d) => (d.tmp === tmp ? { ...d, ...patch } : d)));
  };

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      for (const d of dirtyRows) {
        const e2 = edits[d.id];
        await update({
          variables: {
            dependencyId: d.id,
            ...handoverPatch(e2.choice),
            dueAt: instantOf(e2.due),
            contractId: contract.id,
          },
        });
      }
      for (const d of drafts) {
        await create({
          variables: {
            projectId: contract.project.id,
            titleFa: d.titleFa,
            titleEn: d.titleEn,
            ...handoverPatch(d.choice),
            dueAt: instantOf(d.due),
            contractId: contract.id,
          },
        });
      }
      setEdits({});
      setDrafts([]);
      setSaved(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  async function onRemove(d: Dependency) {
    setError(null);
    try {
      await remove({ variables: { dependencyId: d.id, contractId: contract.id } });
      setEdits(({ [d.id]: _gone, ...rest }) => rest);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  function onAddDraft(e: FormEvent) {
    e.preventDefault();
    if (!newFa.trim() || !newEn.trim()) return;
    setSaved(false);
    setDrafts((prev) => [...prev, { tmp: `new-${prev.length}-${Date.now()}`, titleFa: newFa.trim(), titleEn: newEn.trim(), choice: null, due: '' }]);
    setNewFa('');
    setNewEn('');
    setAdding(false);
  }

  const pills = (what: string, id: string, value: Choice | null, onChange: (next: Choice | null) => void) => (
    <PillChoice<Choice>
      label={t('brief.handover.who', { what })}
      clearable
      value={value}
      onChange={onChange}
      disabled={locked}
      options={[
        { value: 'ROOT', label: t('brief.handover.side.ROOT') },
        { value: 'CUSTOMER', label: t('brief.handover.side.CUSTOMER') },
        { value: 'NOT_NEEDED', label: t('brief.handover.side.NOT_NEEDED') },
      ]}
      testId={`handover-side-${id}`}
    />
  );

  return (
    <form className="card editor-card auth-form" onSubmit={onSave} data-testid="handover-form">
      <SectionHead title={t('brief.handover.title')} help={t('brief.handover.help')} />
      {locked ? <p className="t-small">{t('brief.handover.locked')}</p> : null}

      {rows.length === 0 && drafts.length === 0 ? (
        <p className="t-small desk-muted" data-testid="handover-empty">
          {t('brief.handover.empty')}
        </p>
      ) : null}

      <div className="handover-list">
        {rows.map((d) => {
          const s = current(d);
          const id = d.briefKey ?? d.id;
          const what = pick(d, 'title', locale);
          return (
            <div className="handover-row" key={d.id} data-testid="handover-row" data-key={id}>
              <p className="handover-item">{what}</p>
              {pills(what, id, s.choice, (choice) => setRow(d.id, stateOf(d), choice === 'NOT_NEEDED' ? { choice, due: '' } : { choice }))}
              <div className="handover-due">
                <span className="label">{t('brief.handover.due', { what })}</span>
                <DayInput
                  value={s.choice === 'NOT_NEEDED' ? '' : s.due}
                  onChange={(due) => setRow(d.id, stateOf(d), { due })}
                  label={t('brief.handover.due', { what })}
                  disabled={locked || s.choice === 'NOT_NEEDED'}
                  testId={`handover-due-${id}`}
                />
              </div>
              {d.briefKey === null && !locked ? (
                <button
                  className="btn btn-ghost btn-sm handover-remove"
                  type="button"
                  aria-label={t('brief.handover.removeWhat', { what })}
                  onClick={() => onRemove(d)}
                  data-testid={`handover-remove-${id}`}
                >
                  {t('brief.handover.remove')}
                </button>
              ) : null}
            </div>
          );
        })}

        {drafts.map((d) => {
          const what = locale === 'fa' ? d.titleFa : d.titleEn;
          return (
            <div className="handover-row" key={d.tmp} data-testid="handover-row" data-key={d.tmp} data-draft="true">
              <p className="handover-item">{what}</p>
              {pills(what, d.tmp, d.choice, (choice) => setDraft(d.tmp, choice === 'NOT_NEEDED' ? { choice, due: '' } : { choice }))}
              <div className="handover-due">
                <span className="label">{t('brief.handover.due', { what })}</span>
                <DayInput
                  value={d.choice === 'NOT_NEEDED' ? '' : d.due}
                  onChange={(due) => setDraft(d.tmp, { due })}
                  label={t('brief.handover.due', { what })}
                  disabled={d.choice === 'NOT_NEEDED'}
                  testId={`handover-due-${d.tmp}`}
                />
              </div>
              <button
                className="btn btn-ghost btn-sm handover-remove"
                type="button"
                aria-label={t('brief.handover.removeWhat', { what })}
                onClick={() => setDrafts((prev) => prev.filter((x) => x.tmp !== d.tmp))}
              >
                {t('brief.handover.remove')}
              </button>
            </div>
          );
        })}
      </div>

      {locked ? null : adding ? (
        <div className="handover-add" data-testid="handover-add-form">
          <p className="t-eyebrow">{t('brief.handover.addTitle')}</p>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label" htmlFor="handover-new-fa">
                {t('brief.handover.titleFa')}
              </label>
              <input id="handover-new-fa" className="input" dir="rtl" value={newFa} onChange={(e) => setNewFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="handover-new-en">
                {t('brief.handover.titleEn')}
              </label>
              <input id="handover-new-en" className="input" dir="ltr" value={newEn} onChange={(e) => setNewEn(e.target.value)} />
            </div>
          </div>
          <div className="editor-card-actions">
            <button className="btn btn-secondary btn-sm" type="button" disabled={!newFa.trim() || !newEn.trim()} onClick={onAddDraft} data-testid="handover-add-confirm">
              {t('brief.handover.addConfirm')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(false)}>
              {t('brief.handover.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding(true)} data-testid="handover-add">
            {t('brief.handover.add')}
          </button>
        </div>
      )}

      {error ? (
        <p className="error" role="alert" data-testid="handover-error">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="t-small" role="status" data-testid="handover-saved">
          {t('brief.handover.saved')}
        </p>
      ) : null}
      {locked ? null : (
        <div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={updating || creating || !dirty} data-testid="handover-save">
            {t('brief.handover.save')}
          </button>
        </div>
      )}
    </form>
  );
}
