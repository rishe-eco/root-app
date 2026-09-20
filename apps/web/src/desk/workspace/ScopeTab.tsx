import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ADD_SCOPE_ITEM,
  DELETE_SCOPE_ITEM,
  UPDATE_SCOPE_ITEM,
  SET_SCOPE_ITEM_STATUS,
  SET_SCOPE_ITEM_FLAGS,
  DECIDE_SCOPE_ITEM,
  UNDECIDE_SCOPE_ITEM,
  REORDER_SCOPE_ITEM,
  PROPOSE_SCOPE_TRADE,
  CONFIRM_SCOPE_TRADE_ROOT,
  type ScopeItem,
  type ScopeStatus,
  type ScopeTrade,
} from '@/lib/queries';
import type { WorkspaceContext } from './ContractWorkspace';

const STATUSES: ScopeStatus[] = ['PROPOSED', 'AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED', 'DECLINED', 'TRADED'];

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

function ScopeItemCard({ item, atTop, atBottom }: { item: ScopeItem; atTop: boolean; atBottom: boolean }) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [reason, setReason] = useState(item.declinedReason ?? '');
  const [decideNote, setDecideNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [update, { loading: saving }] = useMutation(UPDATE_SCOPE_ITEM);
  const [remove, { loading: deleting }] = useMutation(DELETE_SCOPE_ITEM);
  const [setStatus] = useMutation(SET_SCOPE_ITEM_STATUS);
  const [setFlags] = useMutation(SET_SCOPE_ITEM_FLAGS);
  const [decide] = useMutation(DECIDE_SCOPE_ITEM);
  const [undecide] = useMutation(UNDECIDE_SCOPE_ITEM);
  const [reorder] = useMutation(REORDER_SCOPE_ITEM);

  async function guarded(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    await guarded(() => update({ variables: { scopeItemId: item.id, labelFa, labelEn } }));
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteScopeItem'))) return;
    await guarded(() => remove({ variables: { scopeItemId: item.id } }));
  }

  async function onStatusChange(status: ScopeStatus) {
    await guarded(() =>
      setStatus({ variables: { scopeItemId: item.id, status, reason: status === 'DECLINED' ? reason : null } }),
    );
  }

  async function onFlagToggle(flag: 'temporary' | 'outOfScope' | 'adminWork') {
    await guarded(() =>
      setFlags({
        variables: {
          scopeItemId: item.id,
          temporary: flag === 'temporary' ? !item.temporary : item.temporary,
          outOfScope: flag === 'outOfScope' ? !item.outOfScope : item.outOfScope,
          adminWork: flag === 'adminWork' ? !item.adminWork : item.adminWork,
        },
      }),
    );
  }

  async function onDecide(e: FormEvent) {
    e.preventDefault();
    if (!decideNote.trim()) return;
    await guarded(() => decide({ variables: { scopeItemId: item.id, note: decideNote } }));
    setDecideNote('');
  }

  async function onUndecide() {
    await guarded(() => undecide({ variables: { scopeItemId: item.id } }));
  }

  async function onReorder(direction: 'UP' | 'DOWN') {
    await guarded(() => reorder({ variables: { scopeItemId: item.id, direction } }));
  }

  return (
    <div className="card editor-card">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{item.key}</span>
        <div className="workspace-row" style={{ gap: '0.5rem' }}>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => onReorder('UP')}
            disabled={atTop}
            aria-label={t('workspace.scopeMoveUp')}
          >
            ↑
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => onReorder('DOWN')}
            disabled={atBottom}
            aria-label={t('workspace.scopeMoveDown')}
          >
            ↓
          </button>
          {/* Read-only: checkedAt is the customer's own tick. setScopeItem goes
              through loadForActor, which an admin passes, so this control could
              technically exist — there is just no reason to put it on this
              screen (V2.md §5.2). */}
          <span className={`badge ${item.checked ? '' : 'badge-neutral'}`}>
            {item.checked ? t('workspace.scopeChecked') : t('workspace.scopeUnchecked')}
          </span>
        </div>
      </div>

      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label">{t('workspace.titleFa')}</label>
            <input className="input" dir="rtl" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('workspace.titleEn')}</label>
            <input className="input" dir="ltr" required value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
          </div>
        </div>
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={saving}>
            {t('workspace.save')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting}>
            {t('workspace.delete')}
          </button>
        </div>
      </form>

      <div className="editor-grid-2">
        <div className="field">
          <label className="label">{t('workspace.scopeStatus')}</label>
          <select
            className="input"
            value={item.status}
            onChange={(e) => onStatusChange(e.target.value as ScopeStatus)}
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
              onBlur={() => onStatusChange('DECLINED')}
            />
          </div>
        ) : null}
      </div>

      <div className="workspace-row">
        <span className="t-small">{t('workspace.scopeFlags')}</span>
        <label className="t-small">
          <input type="checkbox" checked={item.temporary} onChange={() => onFlagToggle('temporary')} />{' '}
          {t('workspace.scopeFlagTemporary')}
        </label>
        <label className="t-small">
          <input type="checkbox" checked={item.outOfScope} onChange={() => onFlagToggle('outOfScope')} />{' '}
          {t('workspace.scopeFlagOutOfScope')}
        </label>
        <label className="t-small">
          <input type="checkbox" checked={item.adminWork} onChange={() => onFlagToggle('adminWork')} />{' '}
          {t('workspace.scopeFlagAdminWork')}
        </label>
      </div>

      {item.decidedAt ? (
        <div className="workspace-row">
          <span className="badge">{t('workspace.scopeDecided')}</span>
          <span className="t-small">{item.decidedNote}</span>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onUndecide}>
            {t('workspace.scopeUndecide')}
          </button>
        </div>
      ) : (
        <form className="workspace-row" onSubmit={onDecide}>
          <input
            className="input"
            placeholder={t('workspace.scopeDecidedNote')}
            value={decideNote}
            onChange={(e) => setDecideNote(e.target.value)}
          />
          <button className="btn btn-ghost btn-sm" type="submit">
            {t('workspace.scopeDecide')}
          </button>
        </form>
      )}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

function ScopeTradeCard({ trade }: { trade: ScopeTrade }) {
  const { t } = useTranslation();
  const [confirmRoot, { loading }] = useMutation(CONFIRM_SCOPE_TRADE_ROOT);
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
    <div className="card editor-card">
      <div className="editor-grid-2">
        <div>
          <span className="t-eyebrow">{t('workspace.scopeTradeOut')}</span>
          <p className="t-small">{trade.outItem.labelFa}</p>
        </div>
        <div>
          <span className="t-eyebrow">{t('workspace.scopeTradeIn')}</span>
          <p className="t-small">{trade.inItem.labelFa}</p>
        </div>
      </div>
      <div className="workspace-row">
        {trade.executedAt ? (
          <span className="badge">{t('workspace.scopeTradeExecuted')}</span>
        ) : (
          <>
            {trade.rootConfirmedAt ? (
              <span className="badge">{t('workspace.scopeTradeRootConfirmed')}</span>
            ) : (
              <button className="btn btn-secondary btn-sm" type="button" onClick={onConfirm} disabled={loading}>
                {t('workspace.scopeTradeConfirmRoot')}
              </button>
            )}
            <span className="t-small badge-neutral badge">{t('workspace.scopeTradeCustomerPending')}</span>
          </>
        )}
      </div>
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export default function ScopeTab() {
  const { t } = useTranslation();
  const { contract } = useOutletContext<WorkspaceContext>();
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addItem, { loading }] = useMutation(ADD_SCOPE_ITEM);

  const [proposing, setProposing] = useState(false);
  const [outItemId, setOutItemId] = useState('');
  const [inKey, setInKey] = useState('');
  const [inLabelFa, setInLabelFa] = useState('');
  const [inLabelEn, setInLabelEn] = useState('');
  const [tradeError, setTradeError] = useState<string | null>(null);
  const [proposeTrade, { loading: proposeLoading }] = useMutation(PROPOSE_SCOPE_TRADE);

  const items = [...contract.scopeItems].sort((a, b) => a.position - b.position);
  const tradeableItems = items.filter((i) => ['AGREED', 'IN_BUILD', 'IN_DEMO', 'ACCEPTED'].includes(i.status));
  const trades = contract.project?.scopeTrades ?? [];

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addItem({ variables: { contractId: contract.id, key, labelFa, labelEn } });
      setAdding(false);
      setKey('');
      setLabelFa('');
      setLabelEn('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onPropose(e: FormEvent) {
    e.preventDefault();
    if (!contract.project) return;
    setTradeError(null);
    try {
      await proposeTrade({
        variables: { projectId: contract.project.id, outItemId, inKey, inLabelFa, inLabelEn },
      });
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
    <>
      {/* V2.md §5: ScopeItem is not versioned, not snapshotted, not hashed —
          an edit here is visible to the customer the instant it is saved. */}
      <div className="live-banner">{t('workspace.scopeLiveWarning')}</div>

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.scopeTitle')}</h3>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAdding((v) => !v)}>
          {t('workspace.addScopeItem')}
        </button>
      </div>

      {adding ? (
        <form className="card editor-card auth-form" onSubmit={onAdd}>
          <div className="field">
            <label className="label">{t('workspace.scopeKey')}</label>
            <input className="input num-latin" dir="ltr" required value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
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

      <div className="editor-list">
        {items.map((s, i) => (
          <ScopeItemCard key={s.id} item={s} atTop={i === 0} atBottom={i === items.length - 1} />
        ))}
      </div>

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.scopeTradeTitle')}</h3>
        {contract.project ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setProposing((v) => !v)}>
            {t('workspace.scopeTradePropose')}
          </button>
        ) : null}
      </div>

      {proposing ? (
        <form className="card editor-card auth-form" onSubmit={onPropose}>
          <div className="field">
            <label className="label">{t('workspace.scopeTradeOutItem')}</label>
            <select className="input" required value={outItemId} onChange={(e) => setOutItemId(e.target.value)}>
              <option value="" disabled>
                —
              </option>
              {tradeableItems.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.labelFa} ({i.key})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label">{t('workspace.scopeTradeInKey')}</label>
            <input className="input num-latin" dir="ltr" required value={inKey} onChange={(e) => setInKey(e.target.value)} />
          </div>
          <div className="editor-grid-2">
            <div className="field">
              <label className="label">{t('workspace.titleFa')}</label>
              <input className="input" dir="rtl" required value={inLabelFa} onChange={(e) => setInLabelFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label">{t('workspace.titleEn')}</label>
              <input className="input" dir="ltr" required value={inLabelEn} onChange={(e) => setInLabelEn(e.target.value)} />
            </div>
          </div>
          {tradeError ? <p className="error">{tradeError}</p> : null}
          <div>
            <button className="btn btn-primary btn-sm" type="submit" disabled={proposeLoading}>
              {t('workspace.save')}
            </button>
          </div>
        </form>
      ) : null}

      <div className="editor-list">
        {trades.map((trade) => (
          <ScopeTradeCard key={trade.id} trade={trade} />
        ))}
      </div>
    </>
  );
}
