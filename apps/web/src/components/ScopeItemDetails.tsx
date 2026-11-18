import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import InlineAdd from '@/components/InlineAdd';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import { useLocale } from '@/lib/locale';
import { formatCount, pick } from '@/lib/format';
import {
  DECIDE_SCOPE_ITEM,
  DELETE_SCOPE_ITEM,
  PROPOSE_SCOPE_TRADE,
  REORDER_SCOPE_ITEM,
  SET_SCOPE_ITEM_FLAGS,
  SET_SCOPE_ITEM_PHASES,
  SET_SCOPE_ITEM_STATUS,
  UNDECIDE_SCOPE_ITEM,
  UPDATE_SCOPE_ITEM,
  type Contract,
  type ScopeItem,
  type ScopeStatus,
} from '@/lib/queries';

/**
 * What the desk's old **Scope tab** (and, after DX2a, `ScopeRegistry`'s block under the list) let staff do to an item, now
 * on the item it acts on (DX6, the founder's walk): the row reads at a glance, and a **Details** drawer under that row
 * alone holds the controls.
 *
 * - `ItemChips` is the glance: the status, the phases ("Phases 1, 2") and, for staff, a chip for each flag that is set,
 *   for a decided item and for the customer's own tick. The customer sees the status and phase chips, read-only, and
 *   never the drawer.
 * - `DetailsToggle` is a button with `aria-expanded`; **one drawer is open at a time** (the panel holds which) and
 *   Escape, pressed anywhere in the panel, closes it and returns focus to its toggle (the panel's key handler).
 * - `ItemDrawer` groups the controls: status and decision, phases, flags, trade, and name / order / delete. Every
 *   control saves as it is changed (a select, a pill, a blur) through the mutation the old tab used, so the chips
 *   follow through the cache. Same mutations, same capability (`contracts.author`, the caller gates the toggle).
 *
 * V2.md §5: `ScopeItem` is not versioned, not snapshotted, not hashed — an edit here is visible to the customer the
 * instant it is saved, which the drawer's first line says.
 */

const STATUSES: ScopeStatus[] = ['PROPOSED', 'AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED', 'DECLINED', 'TRADED'];
const TRADEABLE: ScopeStatus[] = ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'];

const message = (err: unknown): string => (err as { message?: string })?.message ?? String(err);

/** The phases an item is in, as the numbers a chip shows. */
export function phaseNumbersOf(item: ScopeItem, contract: Contract): number[] {
  const ids = item.phaseIds ?? (item.phaseId ? [item.phaseId] : []);
  return (contract.phases ?? [])
    .filter((p) => ids.includes(p.id))
    .map((p) => p.number)
    .sort((a, b) => a - b);
}

export function ItemChips({ item, contract, staff }: { item: ScopeItem; contract: Contract; staff: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const phases = phaseNumbersOf(item, contract);
  const list = phases.map((n) => formatCount(n, locale)).join(locale === 'fa' ? '، ' : ', ');
  return (
    <span className="scope-chips" data-testid="scope-chips">
      <span className="badge" data-testid="scope-chip-status" data-status={item.status}>
        {t(`workspace.scopeStatus${item.status}`)}
      </span>
      {list ? (
        <span className="badge badge-neutral" data-testid="scope-chip-phases">
          {t('scope.registry.phasesBadge', { list })}
        </span>
      ) : null}
      {staff
        ? (['temporary', 'outOfScope', 'adminWork'] as const).map((flag) =>
            item[flag] ? (
              <span className="badge badge-locked" key={flag} data-testid={`scope-chip-${flag}`}>
                {t(FLAG_KEY[flag])}
              </span>
            ) : null,
          )
        : null}
      {staff && item.decidedAt ? (
        <span className="badge badge-neutral" data-testid="scope-chip-decided" title={item.decidedNote ?? undefined}>
          {t('workspace.scopeDecided')}
        </span>
      ) : null}
    </span>
  );
}

const FLAG_KEY = {
  temporary: 'workspace.scopeFlagTemporary',
  outOfScope: 'workspace.scopeFlagOutOfScope',
  adminWork: 'workspace.scopeFlagAdminWork',
} as const;

export const drawerId = (item: ScopeItem) => `scope-drawer-${item.id}`;
export const toggleId = (item: ScopeItem) => `scope-details-${item.id}`;

export function DetailsToggle({ item, open, onToggle }: { item: ScopeItem; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      id={toggleId(item)}
      className="btn btn-ghost btn-sm scope-details-toggle"
      aria-expanded={open}
      aria-controls={drawerId(item)}
      onClick={onToggle}
      data-testid="scope-details"
    >
      {t('scope.details.toggle')}
    </button>
  );
}

/** Deletes an item after a confirm — the old tab's Delete. The API refuses one that anything refers to (`ITEM_IN_USE`). */
export function useDeleteItem(contract: Contract, onError: (text: string) => void) {
  const { t } = useTranslation();
  const [remove, { loading }] = useMutation(DELETE_SCOPE_ITEM, { variables: { contractId: contract.id } });
  return {
    deleting: loading,
    run: async (item: ScopeItem, label: string) => {
      if (!window.confirm(t('scope.details.confirmDelete', { label }))) return;
      try {
        await remove({ variables: { scopeItemId: item.id } });
      } catch (err) {
        onError(message(err));
      }
    },
  };
}

export function ItemDrawer({
  item,
  contract,
  neighbours,
}: {
  item: ScopeItem;
  contract: Contract;
  /** The items listed with this one, in the order shown: what "move up" and "move down" step past. */
  neighbours: ScopeItem[];
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const bound = { variables: { contractId: contract.id } };
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [reason, setReason] = useState(item.declinedReason ?? '');
  const [decideNote, setDecideNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);
  const inPhases = item.phaseIds ?? (item.phaseId ? [item.phaseId] : []);

  const [update] = useMutation(UPDATE_SCOPE_ITEM, bound);
  const [setStatus] = useMutation(SET_SCOPE_ITEM_STATUS, bound);
  const [setFlags] = useMutation(SET_SCOPE_ITEM_FLAGS, bound);
  const [decide] = useMutation(DECIDE_SCOPE_ITEM, bound);
  const [undecide] = useMutation(UNDECIDE_SCOPE_ITEM, bound);
  const [reorder] = useMutation(REORDER_SCOPE_ITEM, bound);
  const [setPhases] = useMutation(SET_SCOPE_ITEM_PHASES, bound);
  const [propose] = useMutation(PROPOSE_SCOPE_TRADE, bound);
  const del = useDeleteItem(contract, setError);

  const [inKey, setInKey] = useState('');
  const [inFa, setInFa] = useState('');
  const [inEn, setInEn] = useState('');

  async function guarded(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    }
  }

  // DX4: the name saves when the field is left.
  const autosave = useAutosave({
    value: { labelFa, labelEn },
    baseline: { labelFa: item.labelFa, labelEn: item.labelEn },
    valid: (v) => hasOneTitle(v.labelFa, v.labelEn),
    save: (v) => update({ variables: { scopeItemId: item.id, labelFa: v.labelFa, labelEn: v.labelEn } }),
    errorText: message,
  });

  const index = neighbours.findIndex((n) => n.id === item.id);
  const projectOrder = [...contract.scopeItems].sort((a, b) => a.position - b.position);

  /** One step in the list shown. The API swaps with the project's neighbour, which can be an item of another group or
   *  contract, so this repeats the swap until the item has passed the one it stepped over in the list. */
  async function move(direction: 'UP' | 'DOWN') {
    const other = neighbours[index + (direction === 'UP' ? -1 : 1)];
    if (!other) return;
    const steps = Math.abs(projectOrder.findIndex((s) => s.id === other.id) - projectOrder.findIndex((s) => s.id === item.id));
    await guarded(async () => {
      for (let i = 0; i < steps; i += 1) await reorder({ variables: { scopeItemId: item.id, direction } });
    });
  }

  const flagPill = (flag: 'temporary' | 'outOfScope' | 'adminWork') => (
    <button
      key={flag}
      type="button"
      className={`pillchoice-pill${item[flag] ? ' pillchoice-chosen' : ''}`}
      aria-pressed={item[flag]}
      data-testid={`scope-flag-${flag}`}
      onClick={() =>
        guarded(() =>
          setFlags({
            variables: {
              scopeItemId: item.id,
              temporary: flag === 'temporary' ? !item.temporary : item.temporary,
              outOfScope: flag === 'outOfScope' ? !item.outOfScope : item.outOfScope,
              adminWork: flag === 'adminWork' ? !item.adminWork : item.adminWork,
            },
          }),
        )
      }
    >
      {t(FLAG_KEY[flag])}
    </button>
  );

  return (
    <div
      id={drawerId(item)}
      className="scope-drawer"
      role="group"
      aria-label={t('scope.details.label', { label: pick(item, 'label', locale) })}
      data-testid="scope-drawer"
    >
      <p className="t-caption scope-drawer-live">
        <span className="t-eyebrow num-latin">{item.key}</span> {t('workspace.scopeLiveWarning')}
        {item.checked ? <span className="badge"> {t('workspace.scopeChecked')}</span> : null}
      </p>

      <fieldset className="scope-drawer-group">
        <legend className="label">{t('scope.details.statusGroup')}</legend>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor={`status-${item.id}`}>
              {t('workspace.scopeStatus')}
            </label>
            <select
              id={`status-${item.id}`}
              className="input"
              data-testid="registry-status"
              value={item.status}
              onChange={(e) =>
                guarded(() =>
                  setStatus({
                    variables: { scopeItemId: item.id, status: e.target.value as ScopeStatus, reason: e.target.value === 'DECLINED' ? reason : null },
                  }),
                )
              }
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`workspace.scopeStatus${s}`)}
                </option>
              ))}
            </select>
          </div>
          {item.status === 'DECLINED' ? (
            <div className="field">
              <label className="label" htmlFor={`reason-${item.id}`}>
                {t('workspace.scopeDeclinedReason')}
              </label>
              <input
                id={`reason-${item.id}`}
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => guarded(() => setStatus({ variables: { scopeItemId: item.id, status: 'DECLINED', reason } }))}
              />
            </div>
          ) : null}
        </div>
        {item.decidedAt ? (
          <div className="workspace-row">
            <span className="badge">{t('workspace.scopeDecided')}</span>
            <span className="t-small">{item.decidedNote}</span>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => guarded(() => undecide({ variables: { scopeItemId: item.id } }))}>
              {t('workspace.scopeUndecide')}
            </button>
          </div>
        ) : (
          <div className="field">
            <label className="label" htmlFor={`decide-${item.id}`}>
              {t('workspace.scopeDecidedNote')}
            </label>
            <div className="workspace-row">
              <input
                id={`decide-${item.id}`}
                className="input"
                value={decideNote}
                onChange={(e) => setDecideNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (decideNote.trim()) void guarded(async () => { await decide({ variables: { scopeItemId: item.id, note: decideNote } }); setDecideNote(''); });
                  }
                }}
              />
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                disabled={!decideNote.trim()}
                onClick={() => guarded(async () => { await decide({ variables: { scopeItemId: item.id, note: decideNote } }); setDecideNote(''); })}
              >
                {t('workspace.scopeDecide')}
              </button>
            </div>
          </div>
        )}
      </fieldset>

      <fieldset className="scope-drawer-group" data-testid="registry-phase" title={t('scope.registry.phaseHelp')}>
        <legend className="label">{t('scope.registry.phase')}</legend>
        {phases.length === 0 ? <span className="t-small desk-muted">{t('brief.plan.noPhase')}</span> : null}
        <div className="pillchoice">
          {phases.map((p) => {
            const on = inPhases.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`pillchoice-pill${on ? ' pillchoice-chosen' : ''}`}
                aria-pressed={on}
                data-testid={`registry-phase-${p.number}`}
                title={pick(p, 'title', locale)}
                onClick={() =>
                  guarded(() =>
                    setPhases({ variables: { scopeItemId: item.id, phaseIds: on ? inPhases.filter((id) => id !== p.id) : [...inPhases, p.id] } }),
                  )
                }
              >
                {t('scope.details.phasePill', { n: formatCount(p.number, locale), title: pick(p, 'title', locale) })}
              </button>
            );
          })}
        </div>
        <p className="t-caption">{t('scope.registry.phaseHelp')}</p>
      </fieldset>

      <fieldset className="scope-drawer-group">
        <legend className="label">{t('workspace.scopeFlags')}</legend>
        <div className="pillchoice">{(['temporary', 'outOfScope', 'adminWork'] as const).map(flagPill)}</div>
      </fieldset>

      {TRADEABLE.includes(item.status) ? (
        <fieldset className="scope-drawer-group">
          <legend className="label">{t('workspace.scopeTradeTitle')}</legend>
          <p className="t-caption">{t('scope.details.tradeHelp')}</p>
          <InlineAdd
            label={t('workspace.scopeTradePropose')}
            submitLabel={t('scope.details.tradeSubmit')}
            testId="registry-trade"
            ready={hasOneTitle(inFa, inEn) && inKey.trim() !== ''}
            onSubmit={async () => {
              await propose({ variables: { projectId: contract.project.id, outItemId: item.id, inKey: inKey.trim(), inLabelFa: inFa, inLabelEn: inEn } });
              setInKey('');
              setInFa('');
              setInEn('');
            }}
            onCancel={() => {
              setInKey('');
              setInFa('');
              setInEn('');
            }}
            errorText={message}
          >
            <div className="field">
              <label className="label" htmlFor={`trade-key-${item.id}`}>
                {t('workspace.scopeTradeInKey')}
              </label>
              <input id={`trade-key-${item.id}`} className="input num-latin" dir="ltr" required value={inKey} onChange={(e) => setInKey(e.target.value)} />
            </div>
            <TitleField idBase={`trade-${item.id}`} label={t('scope.details.tradeIn')} fa={inFa} en={inEn} onChange={(v) => { setInFa(v.fa); setInEn(v.en); }} />
          </InlineAdd>
        </fieldset>
      ) : null}

      <fieldset className="scope-drawer-group">
        <legend className="label">{t('scope.details.nameGroup')}</legend>
        <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
          <TitleField idBase={`registry-${item.key}`} testId="registry-item-title" fa={labelFa} en={labelEn} onChange={(v) => { setLabelFa(v.fa); setLabelEn(v.en); }} />
          <AutosaveNote autosave={autosave} testId="registry-item-autosave" />
        </form>
        <div className="workspace-row">
          <button className="btn btn-ghost btn-sm" type="button" disabled={index <= 0} onClick={() => move('UP')} aria-label={t('workspace.scopeMoveUp')} data-testid="scope-move-up">
            ↑
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={index < 0 || index >= neighbours.length - 1} onClick={() => move('DOWN')} aria-label={t('workspace.scopeMoveDown')} data-testid="scope-move-down">
            ↓
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={del.deleting} onClick={() => del.run(item, pick(item, 'label', locale))} data-testid="scope-drawer-delete">
            {t('workspace.delete')}
          </button>
        </div>
      </fieldset>

      {error ? (
        <p className="error" role="alert" data-testid="scope-drawer-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

