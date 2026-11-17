import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick } from '@/lib/format';
import { SectionHead, day, refusalText } from '@/components/EditorKit';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
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
 * **DX4 (review 27): saved when a field is left**, like the brief above it, with
 * no Save button; a row added here is created at once, since adding is an act.
 * And — as the brief is — not drawn
 * at all once the agreement is approved: a locked list (`STEP_LOCKED`) is a
 * control that can only fail. The caller (`RequirementsEditor`) is only drawn
 * for an open step; this panel still says so if it is handed a locked one.
 */

type Choice = HandoverChoice;

type RowState = { choice: Choice | null; due: string };

const stateOf = (d: Dependency): RowState => ({ choice: choiceOf(d), due: day(d.dueAt) });

export default function HandoverPanel({ contract, locked = false }: { contract: Contract; locked?: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const rows = contract.handover ?? [];
  const [edits, setEdits] = useState<Record<string, RowState>>({});
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState({ fa: '', en: '' });
  const [error, setError] = useState<string | null>(null);
  const [update] = useMutation(UPDATE_DEPENDENCY);
  const [create, { loading: creating }] = useMutation(CREATE_DEPENDENCY);
  const [remove] = useMutation(DELETE_DEPENDENCY);

  // What a row shows: the edit in progress if there is one, the record otherwise.
  const current = (d: Dependency): RowState => edits[d.id] ?? stateOf(d);
  const valueMap = Object.fromEntries(rows.map((d) => [d.id, current(d)]));
  const baselineMap = Object.fromEntries(rows.map((d) => [d.id, stateOf(d)]));

  // Each row goes through the board's own `updateDependency`; only the rows that differ are sent.
  const autosave = useAutosave({
    value: valueMap,
    baseline: baselineMap,
    save: async (v) => {
      for (const d of rows) {
        const e2 = v[d.id];
        const s0 = stateOf(d);
        if (!e2 || (e2.choice === s0.choice && e2.due === s0.due)) continue;
        await update({
          variables: { dependencyId: d.id, ...handoverPatch(e2.choice), dueAt: instantOf(e2.due), contractId: contract.id },
        });
      }
      // Only the edits this save carried: one made while it was in flight is still the user's and goes next (DX4 review).
      setEdits((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([id, e]) => JSON.stringify(e) !== JSON.stringify(v[id]))),
      );
    },
    disabled: locked,
    errorText: (err) => refusalText(t, err),
  });

  const setRow = (id: string, base: RowState, patch: Partial<RowState>) => {
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] ?? base), ...patch } }));
  };
  // A pill is a choice, not typing: it saves with the row as it will stand.
  const choose = (d: Dependency, choice: Choice | null) => {
    const patch: Partial<RowState> = choice === 'NOT_NEEDED' ? { choice, due: '' } : { choice };
    setRow(d.id, stateOf(d), patch);
    autosave.commit({ ...valueMap, [d.id]: { ...current(d), ...patch } });
  };

  async function onRemove(d: Dependency) {
    setError(null);
    try {
      await remove({ variables: { dependencyId: d.id, contractId: contract.id } });
      setEdits(({ [d.id]: _gone, ...rest }) => rest);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!hasOneTitle(newTitle.fa, newTitle.en)) return;
    setError(null);
    try {
      await create({
        variables: { projectId: contract.project.id, titleFa: newTitle.fa.trim(), titleEn: newTitle.en.trim(), contractId: contract.id },
      });
      setNewTitle({ fa: '', en: '' });
      setAdding(false);
    } catch (err) {
      setError(refusalText(t, err));
    }
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
    <form
      className="card editor-card auth-form"
      onSubmit={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (e.currentTarget.checkValidity()) autosave.onBlur();
      }}
      data-testid="handover-form"
    >
      <SectionHead title={t('brief.handover.title')} help={t('brief.handover.help')} />
      {locked ? <p className="t-small">{t('brief.handover.locked')}</p> : null}

      {rows.length === 0 ? (
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
              {pills(what, id, s.choice, (choice) => choose(d, choice))}
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
      </div>

      {locked ? null : adding ? (
        <div className="handover-add" data-testid="handover-add-form">
          <p className="t-eyebrow">{t('brief.handover.addTitle')}</p>
          <TitleField idBase="handover-new" testId="handover-new-title" fa={newTitle.fa} en={newTitle.en} onChange={setNewTitle} />
          <div className="editor-card-actions">
            <button className="btn btn-secondary btn-sm" type="button" disabled={creating || !hasOneTitle(newTitle.fa, newTitle.en)} onClick={onAdd} data-testid="handover-add-confirm">
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
      {locked ? null : <AutosaveNote autosave={autosave} testId="handover-autosave" />}
    </form>
  );
}
