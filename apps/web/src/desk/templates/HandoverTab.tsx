import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { can } from '@/lib/access';
import {
  CREATE_HANDOVER_ITEM_TYPE,
  HANDOVER_ITEM_TYPES,
  REORDER_HANDOVER_ITEM_TYPES,
  UPDATE_HANDOVER_ITEM_TYPE,
  type HandoverItemType,
} from '@/lib/queries';
import { refusalMessage } from './refusal';
import type { TemplatesContext } from './Templates';

/**
 * The Handover items tab (DX3a, desk UX review 7) — the desk's default list of
 * what a project needs handed over: the domain, the hosting, the content and
 * whatever sales adds (an SMS line). A new contract's requirements start with a
 * row for each active item (`seedHandoverRows`); a one-off is added on the
 * contract itself, not here.
 *
 * Follows the Types tab: add, rename, reorder, deactivate, and **no delete** — a
 * row already made from an item keeps its own title, so retiring an item takes
 * it out of new contracts and touches nothing that exists. Gated by
 * `contracts.author`, the capability that writes the dependency board (the
 * obligation is part of the agreement), not by the designer's `templates.types`.
 */

function ItemCard({
  item,
  atTop,
  atBottom,
  onMove,
}: {
  item: HandoverItemType;
  atTop: boolean;
  atBottom: boolean;
  onMove: (direction: -1 | 1) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [titleFa, setTitleFa] = useState(item.titleFa);
  const [titleEn, setTitleEn] = useState(item.titleEn);
  const [technical, setTechnical] = useState(item.technical);
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_HANDOVER_ITEM_TYPE);

  async function guarded(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(refusalMessage(t, err));
    }
  }

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    return guarded(() => update({ variables: { id: item.id, titleFa, titleEn, technical } }));
  };

  return (
    <div className={`card editor-card${item.active ? '' : ' template-inactive'}`} data-key={item.key} data-testid="handover-type">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{item.key}</span>
        <div className="editor-card-actions">
          <button className="btn btn-ghost btn-sm" type="button" disabled={atTop} aria-label={t('desk.templates.moveUp')} onClick={() => guarded(() => onMove(-1))}>
            ↑
          </button>
          <button className="btn btn-ghost btn-sm" type="button" disabled={atBottom} aria-label={t('desk.templates.moveDown')} onClick={() => guarded(() => onMove(1))}>
            ↓
          </button>
          <span className={`badge${item.active ? '' : ' badge-neutral'}`}>
            {item.active ? t('desk.templates.active') : t('desk.templates.inactive')}
          </span>
        </div>
      </div>

      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor={`ht-fa-${item.id}`}>
              {t('desk.templates.labelFa')}
            </label>
            <input id={`ht-fa-${item.id}`} className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor={`ht-en-${item.id}`}>
              {t('desk.templates.labelEn')}
            </label>
            <input id={`ht-en-${item.id}`} className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
        </div>
        <label className="theme-check">
          <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
          {t('desk.templates.handover.technical')}
        </label>
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
            {t('desk.templates.save')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={loading}
            onClick={() => guarded(() => update({ variables: { id: item.id, active: !item.active } }))}
          >
            {item.active ? t('desk.templates.deactivate') : t('desk.templates.activate')}
          </button>
        </div>
      </form>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export default function HandoverTab() {
  const { t } = useTranslation();
  const { me } = useOutletContext<TemplatesContext>();
  const editable = can(me, 'contracts.author');

  const { data, loading, error } = useQuery<{ handoverItemTypes: HandoverItemType[] }>(HANDOVER_ITEM_TYPES, { skip: !editable });
  const [create, { loading: creating }] = useMutation(CREATE_HANDOVER_ITEM_TYPE, { refetchQueries: [{ query: HANDOVER_ITEM_TYPES }] });
  const [reorder] = useMutation(REORDER_HANDOVER_ITEM_TYPES, { refetchQueries: [{ query: HANDOVER_ITEM_TYPES }] });

  const [key, setKey] = useState('');
  const [titleFa, setTitleFa] = useState('');
  const [titleEn, setTitleEn] = useState('');
  const [technical, setTechnical] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const items = data?.handoverItemTypes ?? [];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await create({ variables: { key, titleFa, titleEn, technical } });
      setKey('');
      setTitleFa('');
      setTitleEn('');
      setTechnical(false);
    } catch (err) {
      setFormError(refusalMessage(t, err));
    }
  }

  async function onMove(index: number, direction: -1 | 1) {
    const ids = items.map((x) => x.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    await reorder({ variables: { ids } });
  }

  if (!editable) return <p className="t-small desk-muted">{t('desk.templates.errors.FORBIDDEN')}</p>;
  if (loading && !data) return <p className="t-small">{t('portal.loading')}</p>;
  if (error) return <p className="error">{t('portal.errorTitle')}</p>;

  return (
    <>
      <p className="t-small desk-muted">{t('desk.templates.handover.help')}</p>

      <section className="card editor-card">
        <h3 className="t-h3">{t('desk.templates.handover.newItem')}</h3>
        <form className="auth-form" onSubmit={onCreate} data-testid="handover-type-form">
          <div className="editor-grid-2">
            <div className="field">
              <label className="label" htmlFor="ht-fa">
                {t('desk.templates.labelFa')}
              </label>
              <input id="ht-fa" className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
            </div>
            <div className="field">
              <label className="label" htmlFor="ht-en">
                {t('desk.templates.labelEn')}
              </label>
              <input id="ht-en" className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label className="label" htmlFor="ht-key">
              {t('desk.templates.handover.key')}
            </label>
            <input id="ht-key" className="input num-latin" dir="ltr" required placeholder="sms-line" value={key} onChange={(e) => setKey(e.target.value)} />
            <p className="t-caption">{t('desk.templates.handover.keyHint')}</p>
          </div>
          <label className="theme-check">
            <input type="checkbox" checked={technical} onChange={(e) => setTechnical(e.target.checked)} />
            {t('desk.templates.handover.technical')}
          </label>
          <p className="t-caption">{t('desk.templates.handover.technicalHint')}</p>
          <div className="editor-card-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={creating} data-testid="handover-type-add">
              {t('desk.templates.handover.add')}
            </button>
          </div>
          {formError ? <p className="error">{formError}</p> : null}
        </form>
      </section>

      {items.length === 0 ? (
        <div className="empty">
          <p className="t-small">{t('desk.templates.handover.none')}</p>
        </div>
      ) : (
        <div className="editor-list">
          {items.map((item, i) => (
            <ItemCard key={item.id} item={item} atTop={i === 0} atBottom={i === items.length - 1} onMove={(direction) => onMove(i, direction)} />
          ))}
        </div>
      )}
    </>
  );
}
