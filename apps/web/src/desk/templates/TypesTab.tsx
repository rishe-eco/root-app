import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
import {
  CREATE_TEMPLATE_TYPE,
  REORDER_TEMPLATE_TYPES,
  TEMPLATE_TYPES,
  UPDATE_TEMPLATE_TYPE,
  type TemplateType,
} from '@/lib/queries';
import { refusalMessage } from './refusal';
import type { TemplatesContext } from './Templates';

/**
 * The Types tab — the site types a contract can start from. Written by
 * `templates.types` (a designer); read by anyone who opened the room.
 *
 * **There is no delete, and that is the design.** A type that a contract's
 * brief has chosen (J4) must outlive the choice, so the only way to retire one
 * is *deactivate*: it leaves the picker, keeps its scope list, and comes back
 * with a click.
 */

function TypeCard({
  type,
  atTop,
  atBottom,
  onMove,
}: {
  type: TemplateType;
  atTop: boolean;
  atBottom: boolean;
  onMove: (direction: -1 | 1) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState(type.slug);
  const [labelFa, setLabelFa] = useState(type.labelFa);
  const [labelEn, setLabelEn] = useState(type.labelEn);
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_TEMPLATE_TYPE);

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
    return guarded(() => update({ variables: { id: type.id, slug, labelFa, labelEn } }));
  };

  return (
    <div className={`card editor-card${type.active ? '' : ' template-inactive'}`} data-slug={type.slug}>
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{type.slug}</span>
        <div className="editor-card-actions">
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={atTop}
            aria-label={t('desk.templates.moveUp')}
            onClick={() => guarded(() => onMove(-1))}
          >
            ↑
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={atBottom}
            aria-label={t('desk.templates.moveDown')}
            onClick={() => guarded(() => onMove(1))}
          >
            ↓
          </button>
          <span className={`badge${type.active ? '' : ' badge-neutral'}`}>
            {type.active ? t('desk.templates.active') : t('desk.templates.inactive')}
          </span>
        </div>
      </div>

      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor={`tt-fa-${type.id}`}>
              {t('desk.templates.labelFa')}
            </label>
            <input
              id={`tt-fa-${type.id}`}
              className="input"
              dir="rtl"
              required
              value={labelFa}
              onChange={(e) => setLabelFa(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor={`tt-en-${type.id}`}>
              {t('desk.templates.labelEn')}
            </label>
            <input
              id={`tt-en-${type.id}`}
              className="input"
              dir="ltr"
              required
              value={labelEn}
              onChange={(e) => setLabelEn(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor={`tt-slug-${type.id}`}>
            {t('desk.templates.slug')}
          </label>
          <input
            id={`tt-slug-${type.id}`}
            className="input num-latin"
            dir="ltr"
            required
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
            {t('desk.templates.save')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={loading}
            onClick={() => guarded(() => update({ variables: { id: type.id, active: !type.active } }))}
          >
            {type.active ? t('desk.templates.deactivate') : t('desk.templates.activate')}
          </button>
        </div>
      </form>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** A type as a reader without `templates.types` sees it: the same facts, no controls. */
function TypeRow({ type }: { type: TemplateType }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <div className={`card editor-card${type.active ? '' : ' template-inactive'}`} data-slug={type.slug}>
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{type.slug}</span>
        <span className={`badge${type.active ? '' : ' badge-neutral'}`}>
          {type.active ? t('desk.templates.active') : t('desk.templates.inactive')}
        </span>
      </div>
      <p className="t-small">{pick(type, 'label', locale)}</p>
      <p className="t-caption desk-muted">
        {t('desk.templates.itemCount', { count: type.items.length, n: formatCount(type.items.length, locale) })}
      </p>
    </div>
  );
}

export default function TypesTab() {
  const { t } = useTranslation();
  const { me } = useOutletContext<TemplatesContext>();
  // The API's own check for every write on this tab.
  const editable = can(me, 'templates.types');

  const { data, loading, error } = useQuery<{ templateTypes: TemplateType[] }>(TEMPLATE_TYPES);
  const [create, { loading: creating }] = useMutation(CREATE_TEMPLATE_TYPE, {
    // A new row is not in the cached list yet, and the list is what the
    // screen is built from.
    refetchQueries: [{ query: TEMPLATE_TYPES }],
  });
  const [reorder] = useMutation(REORDER_TEMPLATE_TYPES, { refetchQueries: [{ query: TEMPLATE_TYPES }] });

  const [slug, setSlug] = useState('');
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const types = data?.templateTypes ?? [];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await create({ variables: { slug, labelFa, labelEn } });
      setSlug('');
      setLabelFa('');
      setLabelEn('');
    } catch (err) {
      setFormError(refusalMessage(t, err));
    }
  }

  async function onMove(index: number, direction: -1 | 1) {
    const ids = types.map((x) => x.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    await reorder({ variables: { ids } });
  }

  if (loading && !data) return <p className="t-small">{t('portal.loading')}</p>;
  if (error) return <p className="error">{t('portal.errorTitle')}</p>;

  return (
    <>
      {editable ? null : <p className="t-small desk-muted">{t('desk.templates.readOnlyTypes')}</p>}
      <p className="t-small desk-muted">{t('desk.templates.typesHelp')}</p>

      {editable ? (
        <section className="card editor-card">
          <h3 className="t-h3">{t('desk.templates.newType')}</h3>
          <form className="auth-form" onSubmit={onCreate}>
            <div className="editor-grid-2">
              <div className="field">
                <label className="label" htmlFor="tt-fa">
                  {t('desk.templates.labelFa')}
                </label>
                <input id="tt-fa" className="input" dir="rtl" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
              </div>
              <div className="field">
                <label className="label" htmlFor="tt-en">
                  {t('desk.templates.labelEn')}
                </label>
                <input id="tt-en" className="input" dir="ltr" required value={labelEn} onChange={(e) => setLabelEn(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor="tt-slug">
                {t('desk.templates.slug')}
              </label>
              <input
                id="tt-slug"
                className="input num-latin"
                dir="ltr"
                required
                placeholder="one-page-site"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
              />
              <p className="t-caption">{t('desk.templates.slugHint')}</p>
            </div>
            <div className="editor-card-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
                {t('desk.templates.addType')}
              </button>
            </div>
            {formError ? <p className="error">{formError}</p> : null}
          </form>
        </section>
      ) : null}

      {types.length === 0 ? (
        <div className="empty">
          <p className="t-small">{t('desk.templates.noTypes')}</p>
        </div>
      ) : (
        <div className="editor-list">
          {types.map((type, i) =>
            editable ? (
              <TypeCard
                key={type.id}
                type={type}
                atTop={i === 0}
                atBottom={i === types.length - 1}
                onMove={(direction) => onMove(i, direction)}
              />
            ) : (
              <TypeRow key={type.id} type={type} />
            ),
          )}
        </div>
      )}
    </>
  );
}
