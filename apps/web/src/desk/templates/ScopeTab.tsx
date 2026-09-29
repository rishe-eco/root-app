import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick } from '@/lib/format';
import {
  SET_TEMPLATE_SCOPE,
  TEMPLATE_TYPES,
  type TemplateScopeItem,
  type TemplateScopeKind,
  type TemplateType,
} from '@/lib/queries';
import { refusalMessage } from './refusal';
import type { TemplatesContext } from './Templates';

/**
 * The Scope tab — the pages, features and deliverables a contract of one type
 * starts with. Written by `templates.scope` (sales, Q-S11); read by anyone who
 * opened the room.
 *
 * **Save replaces the whole list**, so the screen is a draft of the whole list
 * rather than a row-by-row editor: nothing reaches the API until *Save list*,
 * an unsaved draft says so, and what the API refuses (a repeated key, a blank
 * label) leaves the list it had. That is `setTemplateScope`'s own contract,
 * shown honestly instead of dressed up as instant per-row saves.
 */

const KINDS: TemplateScopeKind[] = ['PAGE', 'FEATURE', 'DELIVERABLE'];

/** A row being edited. `uid` is React's identity for it — the saved id for a
 *  row that exists, a counter for one just added — and never leaves the client:
 *  the API takes a list, not ids. */
type Row = { uid: string; key: string; kind: TemplateScopeKind; labelFa: string; labelEn: string };

const toRows = (items: TemplateScopeItem[]): Row[] =>
  items.map(({ id, key, kind, labelFa, labelEn }) => ({ uid: id, key, kind, labelFa, labelEn }));

let added = 0;

export default function ScopeTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { me } = useOutletContext<TemplatesContext>();
  // The API's own check for the one write on this tab.
  const editable = can(me, 'templates.scope');

  const { data, loading, error: loadError } = useQuery<{ templateTypes: TemplateType[] }>(TEMPLATE_TYPES);
  const [save, { loading: saving }] = useMutation(SET_TEMPLATE_SCOPE);

  const types = data?.templateTypes ?? [];
  const [selectedId, setSelectedId] = useState('');
  const type = types.find((x) => x.id === selectedId) ?? types[0];

  // The draft is kept only while it differs from what was loaded: null means
  // "show the saved list", so a save (or switching type) needs no reset logic,
  // and a refetch can never overwrite what someone is typing.
  const [draft, setDraft] = useState<{ typeId: string; rows: Row[] } | null>(null);
  const dirty = draft !== null && draft.typeId === type?.id;
  const rows = dirty ? draft.rows : toRows(type?.items ?? []);
  const [error, setError] = useState<string | null>(null);

  function edit(next: Row[]) {
    setError(null);
    setDraft({ typeId: type!.id, rows: next });
  }

  const change = (uid: string, patch: Partial<Row>) => edit(rows.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));

  function move(index: number, direction: -1 | 1) {
    const next = [...rows];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    edit(next);
  }

  function onPickType(id: string) {
    if (dirty && !confirm(t('desk.templates.discardConfirm'))) return;
    setDraft(null);
    setError(null);
    setSelectedId(id);
  }

  async function onSave() {
    setError(null);
    try {
      await save({
        variables: {
          typeId: type!.id,
          items: rows.map(({ key, kind, labelFa, labelEn }) => ({ key, kind, labelFa, labelEn })),
        },
      });
      setDraft(null);
    } catch (err) {
      setError(refusalMessage(t, err));
    }
  }

  if (loading && !data) return <p className="t-small">{t('portal.loading')}</p>;
  if (loadError) return <p className="error">{t('portal.errorTitle')}</p>;
  if (!type) {
    return (
      <div className="empty">
        <p className="t-small">{t('desk.templates.noTypes')}</p>
      </div>
    );
  }

  return (
    <>
      {editable ? null : <p className="t-small desk-muted">{t('desk.templates.readOnlyScope')}</p>}
      <p className="t-small desk-muted">{t('desk.templates.scopeHelp')}</p>

      <div className="field">
        <label className="label" htmlFor="ts-type">
          {t('desk.templates.pickType')}
        </label>
        <select id="ts-type" className="input" value={type.id} onChange={(e) => onPickType(e.target.value)}>
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {pick(x, 'label', locale)}
              {x.active ? '' : ` — ${t('desk.templates.inactive')}`}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <p className="t-small">{t('desk.templates.noItems')}</p>
        </div>
      ) : editable ? (
        <div className="editor-list">
          {rows.map((row, i) => (
            <div className="card editor-card template-row" key={row.uid} data-key={row.key}>
              <div className="field">
                <label className="label" htmlFor={`ts-key-${row.uid}`}>
                  {t('desk.templates.key')}
                </label>
                <input
                  id={`ts-key-${row.uid}`}
                  className="input num-latin"
                  dir="ltr"
                  value={row.key}
                  onChange={(e) => change(row.uid, { key: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor={`ts-kind-${row.uid}`}>
                  {t('desk.templates.kindLabel')}
                </label>
                <select
                  id={`ts-kind-${row.uid}`}
                  className="input"
                  value={row.kind}
                  onChange={(e) => change(row.uid, { kind: e.target.value as TemplateScopeKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`desk.templates.kind.${k}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label className="label" htmlFor={`ts-fa-${row.uid}`}>
                  {t('desk.templates.labelFa')}
                </label>
                <input
                  id={`ts-fa-${row.uid}`}
                  className="input"
                  dir="rtl"
                  value={row.labelFa}
                  onChange={(e) => change(row.uid, { labelFa: e.target.value })}
                />
              </div>
              <div className="field">
                <label className="label" htmlFor={`ts-en-${row.uid}`}>
                  {t('desk.templates.labelEn')}
                </label>
                <input
                  id={`ts-en-${row.uid}`}
                  className="input"
                  dir="ltr"
                  value={row.labelEn}
                  onChange={(e) => change(row.uid, { labelEn: e.target.value })}
                />
              </div>
              <div className="editor-card-actions">
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={i === 0}
                  aria-label={t('desk.templates.moveUp')}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  disabled={i === rows.length - 1}
                  aria-label={t('desk.templates.moveDown')}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => edit(rows.filter((r) => r.uid !== row.uid))}
                >
                  {t('desk.templates.removeItem')}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="editor-list">
          {rows.map((row) => (
            <div className="card editor-card" key={row.uid} data-key={row.key}>
              <div className="editor-card-head">
                <span className="t-eyebrow num-latin">{row.key}</span>
                <span className="badge">{t(`desk.templates.kind.${row.kind}`)}</span>
              </div>
              <p className="t-small">{pick(row, 'label', locale)}</p>
            </div>
          ))}
        </div>
      )}

      {editable ? (
        <div className="workspace-row">
          <div className="editor-card-actions">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() =>
                edit([...rows, { uid: `new-${(added += 1)}`, key: '', kind: 'FEATURE', labelFa: '', labelEn: '' }])
              }
            >
              {t('desk.templates.addItem')}
            </button>
            <button className="btn btn-primary btn-sm" type="button" disabled={saving || !dirty} onClick={onSave}>
              {t('desk.templates.saveList')}
            </button>
          </div>
          <div className="dirty-note">
            <span className={`dirty-dot${dirty ? '' : ' dirty-dot-clean'}`} />
            {dirty ? t('desk.templates.unsaved') : t('desk.templates.saved')}
          </div>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </>
  );
}
