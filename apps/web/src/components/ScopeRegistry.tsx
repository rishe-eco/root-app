import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import { useLocale } from '@/lib/locale';
import { formatCount, pick } from '@/lib/format';
import {
  CONFIRM_SCOPE_TRADE_ROOT,
  DECIDE_SCOPE_ITEM,
  DELETE_SCOPE_ITEM,
  PROPOSE_SCOPE_TRADE,
  REORDER_SCOPE_ITEM,
  SET_SCOPE_ITEM_PHASES,
  SET_SCOPE_ITEM_FLAGS,
  SET_SCOPE_ITEM_STATUS,
  UNDECIDE_SCOPE_ITEM,
  UPDATE_SCOPE_ITEM,
  type Contract,
  type ScopeItem,
  type ScopeStatus,
  type ScopeTrade,
} from '@/lib/queries';

/**
 * The registry's staff controls, on the Pages and features step (DX2a; desk UX
 * review 9). **This is the desk's Scope tab, moved**: the tab is gone from a
 * new-road contract and everything it let staff do is here — an item's names,
 * its status, its three flags, deciding it and undeciding it, its order, its
 * phase (which the Phases tab used to hold) and deleting it; and the trades,
 * proposed and confirmed from Root's side. Unchanged behaviour, same mutations;
 * only the home moved, and `contractId` is bound here rather than by the
 * workspace's outlet (the step panel is also drawn where there is no outlet).
 *
 * Journeys build plan S1: registry writes are `contracts.author`. A reader
 * without it (design, development on their own active contracts) sees the same
 * facts — label, status, flags, phase, the decided note — with nothing that
 * would come back FORBIDDEN (`editable` false).
 *
 * V2.md §5: `ScopeItem` is not versioned, not snapshotted, not hashed — an edit
 * here is visible to the customer the instant it is saved, which the live
 * warning above the list says.
 */

const STATUSES: ScopeStatus[] = ['PROPOSED', 'AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED', 'DECLINED', 'TRADED'];

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

function ScopeItemCard({
  item,
  contract,
  atTop,
  atBottom,
  editable,
}: {
  item: ScopeItem;
  contract: Contract;
  atTop: boolean;
  atBottom: boolean;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [reason, setReason] = useState(item.declinedReason ?? '');
  const [decideNote, setDecideNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const bound = { variables: { contractId: contract.id } };
  const phases = [...(contract.phases ?? [])].sort((a, b) => a.number - b.number);

  const [update] = useMutation(UPDATE_SCOPE_ITEM, bound);
  const [remove, { loading: deleting }] = useMutation(DELETE_SCOPE_ITEM, bound);
  const [setStatus] = useMutation(SET_SCOPE_ITEM_STATUS, bound);
  const [setFlags] = useMutation(SET_SCOPE_ITEM_FLAGS, bound);
  const [decide] = useMutation(DECIDE_SCOPE_ITEM, bound);
  const [undecide] = useMutation(UNDECIDE_SCOPE_ITEM, bound);
  const [reorder] = useMutation(REORDER_SCOPE_ITEM, bound);
  const [setPhases] = useMutation(SET_SCOPE_ITEM_PHASES, bound);

  async function guarded(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // DX4 (review 27): a registry item's label saves when the field is left.
  const autosave = useAutosave({
    value: { labelFa, labelEn },
    baseline: { labelFa: item.labelFa, labelEn: item.labelEn },
    valid: (v) => hasOneTitle(v.labelFa, v.labelEn),
    save: (v) => update({ variables: { scopeItemId: item.id, labelFa: v.labelFa, labelEn: v.labelEn } }),
    disabled: !editable,
    errorText: errorMessage,
  });

  // DX2b: an item may be in several phases (shown in one, fixed in the next); `phaseId` is the last of them.
  const inPhases = item.phaseIds ?? (item.phaseId ? [item.phaseId] : []);
  const phaseList = phases.filter((p) => inPhases.includes(p.id)).map((p) => formatCount(p.number, locale)).join(locale === 'fa' ? '، ' : ', ');

  if (!editable) {
    return (
      <div className="card editor-card" data-testid="registry-item" data-key={item.key}>
        <div className="editor-card-head">
          <span className="t-eyebrow num-latin">{item.key}</span>
          <span className={`badge ${item.checked ? '' : 'badge-neutral'}`}>
            {item.checked ? t('workspace.scopeChecked') : t('workspace.scopeUnchecked')}
          </span>
        </div>
        <p className="t-small">{pick(item, 'label', locale)}</p>
        <div className="workspace-row">
          <span className="badge">{t(`workspace.scopeStatus${item.status}`)}</span>
          {item.temporary ? <span className="badge">{t('workspace.scopeFlagTemporary')}</span> : null}
          {item.outOfScope ? <span className="badge">{t('workspace.scopeFlagOutOfScope')}</span> : null}
          {item.adminWork ? <span className="badge">{t('workspace.scopeFlagAdminWork')}</span> : null}
          {phaseList ? <span className="badge" data-testid="registry-phases-badge">{t('scope.registry.phasesBadge', { list: phaseList })}</span> : null}
        </div>
        {item.decidedAt ? (
          <div className="workspace-row">
            <span className="badge">{t('workspace.scopeDecided')}</span>
            <span className="t-small">{item.decidedNote}</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="card editor-card" data-testid="registry-item" data-key={item.key}>
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{item.key}</span>
        <div className="workspace-row" style={{ gap: '0.5rem' }}>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => guarded(() => reorder({ variables: { scopeItemId: item.id, direction: 'UP' } }))}
            disabled={atTop}
            aria-label={t('workspace.scopeMoveUp')}
          >
            ↑
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => guarded(() => reorder({ variables: { scopeItemId: item.id, direction: 'DOWN' } }))}
            disabled={atBottom}
            aria-label={t('workspace.scopeMoveDown')}
          >
            ↓
          </button>
          {/* Read-only: checkedAt is the customer's own tick. */}
          <span className={`badge ${item.checked ? '' : 'badge-neutral'}`}>
            {item.checked ? t('workspace.scopeChecked') : t('workspace.scopeUnchecked')}
          </span>
        </div>
      </div>

      <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
        <TitleField idBase={`registry-${item.key}`} testId="registry-item-title" fa={labelFa} en={labelEn} onChange={(v) => { setLabelFa(v.fa); setLabelEn(v.en); }} />
        <AutosaveNote autosave={autosave} testId="registry-item-autosave" />
        <div className="editor-card-actions">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={deleting}
            onClick={async () => {
              if (!confirm(t('workspace.confirmDeleteScopeItem'))) return;
              await guarded(() => remove({ variables: { scopeItemId: item.id } }));
            }}
          >
            {t('workspace.delete')}
          </button>
        </div>
      </form>

      <div className="editor-grid-2">
        <div className="field">
          <label className="label">{t('workspace.scopeStatus')}</label>
          <select
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
            <label className="label">{t('workspace.scopeDeclinedReason')}</label>
            <input
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => guarded(() => setStatus({ variables: { scopeItemId: item.id, status: 'DECLINED', reason } }))}
            />
          </div>
        ) : null}
        <fieldset className="field" data-testid="registry-phase" title={t('scope.registry.phaseHelp')}>
          <legend className="label">{t('scope.registry.phase')}</legend>
          {phases.length === 0 ? <span className="t-small desk-muted">{t('brief.plan.noPhase')}</span> : null}
          {phases.map((p) => (
            <label className="t-small" key={p.id}>
              <input
                type="checkbox"
                checked={inPhases.includes(p.id)}
                data-testid={`registry-phase-${p.number}`}
                onChange={(e) =>
                  guarded(() =>
                    setPhases({
                      variables: {
                        scopeItemId: item.id,
                        phaseIds: e.target.checked ? [...inPhases, p.id] : inPhases.filter((id) => id !== p.id),
                      },
                    }),
                  )
                }
              />{' '}
              {t('brief.plan.phaseOption', { n: formatCount(p.number, locale), title: pick(p, 'title', locale) })}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="workspace-row">
        <span className="t-small">{t('workspace.scopeFlags')}</span>
        {(['temporary', 'outOfScope', 'adminWork'] as const).map((flag) => (
          <label className="t-small" key={flag}>
            <input
              type="checkbox"
              checked={item[flag]}
              onChange={() =>
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
            />{' '}
            {t(flag === 'temporary' ? 'workspace.scopeFlagTemporary' : flag === 'outOfScope' ? 'workspace.scopeFlagOutOfScope' : 'workspace.scopeFlagAdminWork')}
          </label>
        ))}
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
        <form
          className="workspace-row"
          onSubmit={async (e: FormEvent) => {
            e.preventDefault();
            if (!decideNote.trim()) return;
            await guarded(() => decide({ variables: { scopeItemId: item.id, note: decideNote } }));
            setDecideNote('');
          }}
        >
          <input className="input" placeholder={t('workspace.scopeDecidedNote')} value={decideNote} onChange={(e) => setDecideNote(e.target.value)} />
          <button className="btn btn-ghost btn-sm" type="submit">
            {t('workspace.scopeDecide')}
          </button>
        </form>
      )}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function ScopeTradeCard({ trade, contract, editable }: { trade: ScopeTrade; contract: Contract; editable: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [confirmRoot, { loading }] = useMutation(CONFIRM_SCOPE_TRADE_ROOT, { variables: { contractId: contract.id } });
  const [error, setError] = useState<string | null>(null);

  async function onConfirm() {
    setError(null);
    try {
      await confirmRoot({ variables: { tradeId: trade.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card editor-card" data-testid="registry-trade">
      <div className="editor-grid-2">
        <div>
          <span className="t-eyebrow">{t('workspace.scopeTradeOut')}</span>
          <p className="t-small">{pick(trade.outItem, 'label', locale)}</p>
        </div>
        <div>
          <span className="t-eyebrow">{t('workspace.scopeTradeIn')}</span>
          <p className="t-small">{pick(trade.inItem, 'label', locale)}</p>
        </div>
      </div>
      <div className="workspace-row">
        {trade.executedAt ? (
          <span className="badge">{t('workspace.scopeTradeExecuted')}</span>
        ) : (
          <>
            {trade.rootConfirmedAt ? (
              <span className="badge">{t('workspace.scopeTradeRootConfirmed')}</span>
            ) : editable ? (
              <button className="btn btn-secondary btn-sm" type="button" onClick={onConfirm} disabled={loading}>
                {t('workspace.scopeTradeConfirmRoot')}
              </button>
            ) : null}
            <span className="t-small badge-neutral badge">{t('workspace.scopeTradeCustomerPending')}</span>
          </>
        )}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export default function ScopeRegistry({ contract, editable }: { contract: Contract; editable: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [proposing, setProposing] = useState(false);
  const [outItemId, setOutItemId] = useState('');
  const [inKey, setInKey] = useState('');
  const [inLabelFa, setInLabelFa] = useState('');
  const [inLabelEn, setInLabelEn] = useState('');
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [proposeTrade, { loading: proposeLoading }] = useMutation(PROPOSE_SCOPE_TRADE, { variables: { contractId: contract.id } });

  const items = [...contract.scopeItems].sort((a, b) => a.position - b.position);
  const tradeableItems = items.filter((i) => ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'].includes(i.status));
  const trades = contract.project.scopeTrades;

  async function onPropose(e: FormEvent) {
    e.preventDefault();
    setTradeError(null);
    try {
      await proposeTrade({ variables: { projectId: contract.project.id, outItemId, inKey, inLabelFa, inLabelEn } });
      setProposing(false);
      setOutItemId('');
      setInKey('');
      setInLabelFa('');
      setInLabelEn('');
    } catch (err) {
      setTradeError(errorMessage(err));
    }
  }

  return (
    <div data-testid="scope-registry">
      <div className="live-banner">{t('workspace.scopeLiveWarning')}</div>
      <div className="editor-list">
        {items.map((s, i) => (
          <ScopeItemCard key={s.id} item={s} contract={contract} atTop={i === 0} atBottom={i === items.length - 1} editable={editable} />
        ))}
      </div>

      <div className="workspace-row">
        <h4 className="t-h4">{t('workspace.scopeTradeTitle')}</h4>
        {editable ? (
          <button className="btn btn-ghost btn-sm" type="button" data-testid="registry-trade-propose" onClick={() => setProposing((v) => !v)}>
            {t('workspace.scopeTradePropose')}
          </button>
        ) : null}
      </div>

      {proposing && editable ? (
        <form className="card editor-card auth-form" onSubmit={onPropose} data-testid="registry-trade-form">
          <div className="field">
            <label className="label">{t('workspace.scopeTradeOutItem')}</label>
            <select className="input" required value={outItemId} onChange={(e) => setOutItemId(e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {tradeableItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {pick(i, 'label', locale)} ({i.key})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">{t('workspace.scopeTradeInKey')}</label>
            <input className="input num-latin" dir="ltr" required value={inKey} onChange={(e) => setInKey(e.target.value)} />
          </div>
          <TitleField idBase="tf-2" fa={inLabelFa} en={inLabelEn} onChange={(v) => { setInLabelFa(v.fa); setInLabelEn(v.en); }} />
          {tradeError ? <p className="error">{tradeError}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={proposeLoading || !hasOneTitle(inLabelFa, inLabelEn)}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      <div className="editor-list">
        {trades.map((trade) => (
          <ScopeTradeCard key={trade.id} trade={trade} contract={contract} editable={editable} />
        ))}
      </div>
    </div>
  );
}
