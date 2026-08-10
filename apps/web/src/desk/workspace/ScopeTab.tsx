import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ADD_SCOPE_ITEM, DELETE_SCOPE_ITEM, UPDATE_SCOPE_ITEM, type ScopeItem } from '@/lib/queries';
import type { WorkspaceContext } from './ContractWorkspace';

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

function ScopeItemCard({ item }: { item: ScopeItem }) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [error, setError] = useState<string | null>(null);
  const [update, { loading: saving }] = useMutation(UPDATE_SCOPE_ITEM);
  const [remove, { loading: deleting }] = useMutation(DELETE_SCOPE_ITEM);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({ variables: { scopeItemId: item.id, labelFa, labelEn } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteScopeItem'))) return;
    try {
      await remove({ variables: { scopeItemId: item.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card editor-card">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{item.key}</span>
        {/* Read-only: checkedAt is the customer's own tick. setScopeItem goes
            through loadForActor, which an admin passes, so this control could
            technically exist — there is just no reason to put it on this
            screen (V2.md §5.2). */}
        <span className={`badge ${item.checked ? '' : 'badge-neutral'}`}>
          {item.checked ? t('workspace.scopeChecked') : t('workspace.scopeUnchecked')}
        </span>
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
        {error ? <p className="error">{error}</p> : null}
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={saving}>
            {t('workspace.save')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting}>
            {t('workspace.delete')}
          </button>
        </div>
      </form>
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
        {contract.scopeItems.map((s) => (
          <ScopeItemCard key={s.id} item={s} />
        ))}
      </div>
    </>
  );
}
