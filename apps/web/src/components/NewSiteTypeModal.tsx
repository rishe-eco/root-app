import { useEffect, useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { CREATE_TEMPLATE_TYPE, TEMPLATE_TYPES } from '@/lib/queries';
import { refusalMessage } from '@/desk/templates/refusal';

/** A slug from an English label: lowercase Latin letters, digits and hyphens (the API's own rule). */
export function slugOf(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * "New site type" beside the site-type picker in Requirements (founder walk 2026-11-18), the same shape as
 * "New customer" beside the customer picker: the type is made — exactly what Templates → Site types does,
 * through `createTemplateType` — without leaving the form, and handed back so the picker selects it. Site
 * types are catalogue data shown in both languages, so both labels are asked for (decision log 20); the slug
 * follows the English label until it is edited by hand.
 *
 * A sibling dialog, never nested in the brief's `<form>`.
 */
export default function NewSiteTypeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** The type that was made, whole: the caller can select it before its list has caught up (DX6). */
  onCreated: (type: { id: string; labelFa: string; labelEn: string }) => void;
}) {
  const { t } = useTranslation();
  const [labelFa, setLabelFa] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [create, { loading }] = useMutation(CREATE_TEMPLATE_TYPE, {
    refetchQueries: [{ query: TEMPLATE_TYPES }],
    awaitRefetchQueries: true,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await create({ variables: { slug, labelFa: labelFa.trim(), labelEn: labelEn.trim() } });
      onCreated(res.data.createTemplateType as { id: string; labelFa: string; labelEn: string });
      onClose();
    } catch (err) {
      setError(refusalMessage(t, err));
    }
  }

  return (
    <div className="overlay">
      <div className="overlay-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="nst-title" data-testid="new-site-type-modal">
        <h2 className="t-h3" id="nst-title">
          {t('brief.form.newSiteTypeTitle')}
        </h2>
        <form className="auth-form" onSubmit={onSubmit}>
          <div className="field">
            <label className="label" htmlFor="nst-fa">
              {t('desk.templates.labelFa')}
            </label>
            <input id="nst-fa" className="input" dir="rtl" lang="fa" required value={labelFa} onChange={(e) => setLabelFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="nst-en">
              {t('desk.templates.labelEn')}
            </label>
            <input
              id="nst-en"
              className="input"
              dir="ltr"
              lang="en"
              required
              value={labelEn}
              onChange={(e) => {
                setLabelEn(e.target.value);
                if (!slugTouched) setSlug(slugOf(e.target.value));
              }}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="nst-slug">
              {t('desk.templates.slug')}
            </label>
            <input
              id="nst-slug"
              className="input num-latin"
              dir="ltr"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
            />
            <span className="t-caption desk-muted">{t('desk.templates.slugHint')}</span>
          </div>
          {error ? (
            <p className="error" role="alert" data-testid="new-site-type-error">
              {error}
            </p>
          ) : null}
          <div className="modal-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={loading} data-testid="new-site-type-create">
              {t('brief.form.newSiteTypeCreate')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>
              {t('brief.handover.cancel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
