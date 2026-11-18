import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { can } from '@/lib/access';
import InlineAdd from '@/components/InlineAdd';
import { CREATE_EXTRA_TYPE, EXTRA_TYPES, REORDER_EXTRA_TYPES, UPDATE_EXTRA_TYPE, type ExtraType } from '@/lib/queries';
import { refusalMessage } from './refusal';
import type { TemplatesContext } from './Templates';

/**
 * The Extras tab (DX6, the founder's walk) — the desk's default list of extras: the areas every new
 * contract starts with in Pages and features, switched off until sales agrees one (payment, notifications,
 * legal, and whatever sales adds). `createContract` makes a contract's extras from the active entries.
 * A one-off for one contract is added on the contract itself, not here.
 *
 * Follows the Default dependencies tab: add, rename, reorder, deactivate, and **no delete** — a contract
 * already made keeps the extras it has, so retiring an entry takes it out of new contracts and touches
 * nothing that exists. Gated by `contracts.author`, with the same API capability.
 */

function ExtraCard({
  item,
  atTop,
  atBottom,
  onMove,
}: {
  item: ExtraType;
  atTop: boolean;
  atBottom: boolean;
  onMove: (direction: -1 | 1) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState(item.labelFa);
  const [labelEn, setLabelEn] = useState(item.labelEn);
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_EXTRA_TYPE);

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
    return guarded(() => update({ variables: { id: item.id, labelFa, labelEn } }));
  };

  return (
    <div className={`card editor-card${item.active ? '' : ' template-inactive'}`} data-key={item.key} data-testid="extra-type">
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
            <label className="label" htmlFor={`et-fa-${item.id}`}>
              {t('desk.templates.labelFa')}
            </label>
            <input id={`et-fa-${item.id}`} className="input" dir="rtl" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor={`et-en-${item.id}`}>
              {t('desk.templates.labelEn')}
            </label>
            <input id={`et-en-${item.id}`} className="input" dir="ltr" required value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
          </div>
        </div>
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

export default function ExtrasTab() {
  const { t } = useTranslation();
  const { me } = useOutletContext<TemplatesContext>();
  const editable = can(me, 'contracts.author');

  const { data, loading, error } = useQuery<{ extraTypes: ExtraType[] }>(EXTRA_TYPES, { skip: !editable });
  const [create, { loading: creating }] = useMutation(CREATE_EXTRA_TYPE, { refetchQueries: [{ query: EXTRA_TYPES }] });
  const [reorder] = useMutation(REORDER_EXTRA_TYPES, { refetchQueries: [{ query: EXTRA_TYPES }] });

  const [slug, setSlug] = useState('');
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');

  const items = data?.extraTypes ?? [];
  const reset = () => {
    setSlug('');
    setLabelFa('');
    setLabelEn('');
  };

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
      <p className="t-small desk-muted">{t('desk.templates.extras.help')}</p>

      {/* The desk's one way to add (`InlineAdd`): a button, then a small form with Add and Cancel. */}
      <InlineAdd
        label={t('desk.templates.extras.add')}
        testId="extra-type-add"
        ready={slug.trim() !== '' && labelFa.trim() !== '' && labelEn.trim() !== ''}
        busy={creating}
        onCancel={reset}
        errorText={(err) => refusalMessage(t, err)}
        onSubmit={async () => {
          await create({ variables: { slug: slug.trim(), labelFa: labelFa.trim(), labelEn: labelEn.trim() } });
          reset();
        }}
      >
        <h3 className="t-h3">{t('desk.templates.extras.newItem')}</h3>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="et-fa">
              {t('desk.templates.labelFa')}
            </label>
            <input id="et-fa" className="input" dir="rtl" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="et-en">
              {t('desk.templates.labelEn')}
            </label>
            <input id="et-en" className="input" dir="ltr" required value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="et-key">
            {t('desk.templates.extras.key')}
          </label>
          <input id="et-key" className="input num-latin" dir="ltr" required placeholder="seo" value={slug} onChange={(e) => setSlug(e.target.value)} />
          <p className="t-caption">{t('desk.templates.extras.keyHint')}</p>
        </div>
      </InlineAdd>

      {items.length === 0 ? (
        <div className="empty">
          <p className="t-small">{t('desk.templates.extras.none')}</p>
        </div>
      ) : (
        <div className="editor-list">
          {items.map((item, i) => (
            <ExtraCard key={item.id} item={item} atTop={i === 0} atBottom={i === items.length - 1} onMove={(direction) => onMove(i, direction)} />
          ))}
        </div>
      )}
    </>
  );
}
