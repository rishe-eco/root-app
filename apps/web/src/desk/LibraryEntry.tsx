import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  CREATE_LIBRARY_ENTRY,
  DELETE_LIBRARY_ENTRY,
  DETACH_ENTRY_FULL_TEXT,
  LIBRARY_CONCEPTS,
  LIBRARY_ENTRY,
  PUBLISH_LIBRARY_ENTRY,
  SET_ENTRY_CONCEPTS,
  UNPUBLISH_LIBRARY_ENTRY,
  UPDATE_LIBRARY_ENTRY,
  type EntryType,
  type EntryVisibility,
  type LibraryConcept,
  type LibraryEntry as LibraryEntryData,
  type LibraryEntryInput,
  type RightsBasis,
  type TranslationProvenance,
  type User,
} from '@/lib/queries';
import { RESEARCH_TEXT_ACCEPT, UploadFailure, uploadResearchText } from '@/lib/upload';
import { fullDateTime } from '@/lib/format';

const ENTRY_TYPES: EntryType[] = ['PAPER', 'BOOK', 'ARTICLE', 'ROOT_RESEARCH'];
const PROVENANCE_OPTIONS: TranslationProvenance[] = ['PUBLISHED', 'ROOT', 'NONE_YET'];
const RIGHTS_OPTIONS: RightsBasis[] = ['PUBLIC_DOMAIN', 'OPEN_LICENCE', 'PERMISSION_GRANTED', 'LINK_ONLY'];

type FormState = {
  type: EntryType;
  originalLang: string;
  titleOriginal: string;
  authors: string;
  venue: string;
  year: string;
  doi: string;
  sourceUrl: string;
  abstractOriginal: string;
  translationProvenance: TranslationProvenance | '';
  titleTranslated: string;
  abstractTranslated: string;
  translationCredit: string;
  rightsBasis: RightsBasis | '';
  rightsNote: string;
  visibility: EntryVisibility;
};

const BLANK: FormState = {
  type: 'PAPER',
  originalLang: '',
  titleOriginal: '',
  authors: '',
  venue: '',
  year: '',
  doi: '',
  sourceUrl: '',
  abstractOriginal: '',
  translationProvenance: '',
  titleTranslated: '',
  abstractTranslated: '',
  translationCredit: '',
  rightsBasis: '',
  rightsNote: '',
  visibility: 'PUBLIC',
};

function fromEntry(e: LibraryEntryData): FormState {
  return {
    type: e.type,
    originalLang: e.originalLang,
    titleOriginal: e.titleOriginal,
    authors: e.authors,
    venue: e.venue ?? '',
    year: e.year ? String(e.year) : '',
    doi: e.doi ?? '',
    sourceUrl: e.sourceUrl ?? '',
    abstractOriginal: e.abstractOriginal ?? '',
    translationProvenance: e.translationProvenance,
    titleTranslated: e.titleTranslated ?? '',
    abstractTranslated: e.abstractTranslated ?? '',
    translationCredit: e.translationCredit ?? '',
    rightsBasis: e.rightsBasis,
    rightsNote: e.rightsNote ?? '',
    visibility: e.visibility,
  };
}

function toInput(f: FormState): LibraryEntryInput {
  if (!f.translationProvenance || !f.rightsBasis) {
    throw new Error('translationProvenance and rightsBasis are required');
  }
  return {
    type: f.type,
    originalLang: f.originalLang.trim(),
    titleOriginal: f.titleOriginal.trim(),
    authors: f.authors.trim(),
    venue: f.venue.trim() || null,
    year: f.year.trim() ? Number(f.year) : null,
    doi: f.doi.trim() || null,
    sourceUrl: f.sourceUrl.trim() || null,
    abstractOriginal: f.abstractOriginal.trim() || null,
    translationProvenance: f.translationProvenance,
    titleTranslated: f.titleTranslated.trim() || null,
    abstractTranslated: f.abstractTranslated.trim() || null,
    translationCredit: f.translationCredit.trim() || null,
    rightsBasis: f.rightsBasis,
    rightsNote: f.rightsNote.trim() || null,
    visibility: f.visibility,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof UploadFailure) return err.i18nKey;
  return (err as { message?: string })?.message ?? String(err);
}

export default function LibraryEntryScreen() {
  const { t } = useTranslation();
  const locale = useLocale();
  const navigate = useNavigate();
  const { id } = useParams();
  const me = useOutletContext<User>();
  const isNew = !id;

  const { data, loading, refetch } = useQuery<{ libraryEntry: LibraryEntryData | null }>(LIBRARY_ENTRY, {
    variables: { id },
    skip: !id || !can(me, 'library.write'),
  });
  const { data: conceptsData } = useQuery<{ libraryConcepts: LibraryConcept[] }>(LIBRARY_CONCEPTS, {
    skip: !can(me, 'library.write'),
  });

  const [create, { loading: creating }] = useMutation(CREATE_LIBRARY_ENTRY);
  const [update, { loading: updating }] = useMutation(UPDATE_LIBRARY_ENTRY);
  const [deleteEntry] = useMutation(DELETE_LIBRARY_ENTRY);
  const [setConcepts, { loading: savingConcepts }] = useMutation(SET_ENTRY_CONCEPTS);
  const [detachFile] = useMutation(DETACH_ENTRY_FULL_TEXT);
  const [publish] = useMutation(PUBLISH_LIBRARY_ENTRY);
  const [unpublish] = useMutation(UNPUBLISH_LIBRARY_ENTRY);

  const [form, setForm] = useState<FormState>(BLANK);
  const [conceptIds, setConceptIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const entry = data?.libraryEntry ?? null;

  useEffect(() => {
    if (entry) {
      setForm(fromEntry(entry));
      setConceptIds(entry.concepts.map((c) => c.id));
    }
  }, [entry]);

  if (!can(me, 'library.write')) return <Navigate to={lp(locale, '/desk')} replace />;
  if (!isNew && loading) return <p className="t-small">{t('portal.loading')}</p>;
  if (!isNew && !loading && !entry) return <Navigate to={lp(locale, '/desk/library')} replace />;

  const canPublish = can(me, 'library.publish');
  const ready = Boolean(form.translationProvenance && form.rightsBasis && form.titleOriginal.trim() && form.authors.trim() && form.originalLang.trim());
  const canHostFile = form.rightsBasis !== 'LINK_ONLY' && form.visibility === 'PUBLIC';

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSave() {
    setError(null);
    try {
      const input = toInput(form);
      if (isNew) {
        const res = await create({ variables: { input } });
        const newId = res.data?.createLibraryEntry.id;
        if (newId) navigate(lp(locale, `/desk/library/${newId}`), { replace: true });
      } else {
        await update({ variables: { id, input } });
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onSaveConcepts() {
    if (!id) return;
    await setConcepts({ variables: { id, conceptIds } }).catch((err) => setError(errorMessage(err)));
  }

  async function onDelete() {
    if (!id) return;
    await deleteEntry({ variables: { id } });
    navigate(lp(locale, '/desk/library'), { replace: true });
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !id) return;
    setUploadBusy(true);
    setUploadError(null);
    try {
      await uploadResearchText(id, file);
      await refetch();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div className="desk-section">
      <div className="workspace-row">
        <h2 className="t-h2">{isNew ? t('desk.library.newEntry') : (entry?.titleTranslated ?? entry?.titleOriginal)}</h2>
        {!isNew && entry ? (
          <span className={`st-badge ${entry.publishedAt ? 'st-done' : 'st-draft'}`}>
            <span className="sdot" />
            {t(entry.publishedAt ? 'desk.library.published' : 'desk.library.draft')}
          </span>
        ) : null}
      </div>

      <section className="card">
        <h3 className="t-h3">{t('desk.library.sectionMetadata')}</h3>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="le-type">{t('desk.library.fieldType')}</label>
            <select id="le-type" className="select" value={form.type} onChange={(e) => set('type', e.target.value as EntryType)}>
              {ENTRY_TYPES.map((et) => (
                <option key={et} value={et}>{t(`desk.library.type.${et}`)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="le-lang">{t('desk.library.fieldOriginalLang')}</label>
            <input id="le-lang" className="input" dir="ltr" required placeholder="fa / en / de…" value={form.originalLang} onChange={(e) => set('originalLang', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="le-title">{t('desk.library.fieldTitleOriginal')}</label>
          <input id="le-title" className="input" required value={form.titleOriginal} onChange={(e) => set('titleOriginal', e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="le-authors">{t('desk.library.fieldAuthors')}</label>
          <input id="le-authors" className="input" required value={form.authors} onChange={(e) => set('authors', e.target.value)} />
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="le-venue">{t('desk.library.fieldVenue')}</label>
            <input id="le-venue" className="input" value={form.venue} onChange={(e) => set('venue', e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="le-year">{t('desk.library.fieldYear')}</label>
            <input id="le-year" className="input num-latin" dir="ltr" type="number" value={form.year} onChange={(e) => set('year', e.target.value)} />
          </div>
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="le-doi">{t('desk.library.fieldDoi')}</label>
            <input id="le-doi" className="input num-latin" dir="ltr" value={form.doi} onChange={(e) => set('doi', e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="le-source">{t('desk.library.fieldSourceUrl')}</label>
            <input id="le-source" className="input" dir="ltr" value={form.sourceUrl} onChange={(e) => set('sourceUrl', e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="le-abstract">{t('desk.library.fieldAbstractOriginal')}</label>
          <textarea id="le-abstract" className="textarea" value={form.abstractOriginal} onChange={(e) => set('abstractOriginal', e.target.value)} />
        </div>
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.library.sectionTranslation')}</h3>
        <fieldset className="field">
          <legend className="label">
            {t('desk.library.fieldProvenance')} <span className="req">*</span>
          </legend>
          <div className="option-group">
            {PROVENANCE_OPTIONS.map((opt) => (
              <label key={opt} className="option-item">
                <input
                  type="radio"
                  name="provenance"
                  value={opt}
                  checked={form.translationProvenance === opt}
                  onChange={() => set('translationProvenance', opt)}
                />
                {t(`desk.library.provenance.${opt}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="le-title-tr">{t('desk.library.fieldTitleTranslated')}</label>
          <input id="le-title-tr" className="input" value={form.titleTranslated} onChange={(e) => set('titleTranslated', e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="le-abstract-tr">{t('desk.library.fieldAbstractTranslated')}</label>
          <textarea id="le-abstract-tr" className="textarea" value={form.abstractTranslated} onChange={(e) => set('abstractTranslated', e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="le-credit">{t('desk.library.fieldTranslationCredit')}</label>
          <input id="le-credit" className="input" value={form.translationCredit} onChange={(e) => set('translationCredit', e.target.value)} />
        </div>
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.library.sectionRights')}</h3>
        <fieldset className="field">
          <legend className="label">
            {t('desk.library.fieldRightsBasis')} <span className="req">*</span>
          </legend>
          <div className="option-group">
            {RIGHTS_OPTIONS.map((opt) => (
              <label key={opt} className="option-item">
                <input
                  type="radio"
                  name="rights"
                  value={opt}
                  checked={form.rightsBasis === opt}
                  onChange={() => set('rightsBasis', opt)}
                />
                {t(`desk.library.rights.${opt}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="le-rights-note">{t('desk.library.fieldRightsNote')}</label>
          <input id="le-rights-note" className="input" value={form.rightsNote} onChange={(e) => set('rightsNote', e.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="le-visibility">{t('desk.library.fieldVisibility')}</label>
          <select id="le-visibility" className="select" value={form.visibility} onChange={(e) => set('visibility', e.target.value as EntryVisibility)}>
            <option value="PUBLIC">{t('desk.library.visibilityPublic')}</option>
            <option value="PRIVATE">{t('desk.library.visibilityPrivate')}</option>
          </select>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <div className="workspace-row">
        <button className="btn btn-primary btn-sm" type="button" onClick={onSave} disabled={!ready || creating || updating}>
          {t('desk.library.save')}
        </button>
        {!isNew ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete}>
            {t('desk.library.deleteEntry')}
          </button>
        ) : null}
        {!isNew && entry ? (
          canPublish ? (
            entry.publishedAt ? (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => unpublish({ variables: { id } })}>
                {t('desk.library.unpublish')}
              </button>
            ) : (
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => publish({ variables: { id } })}>
                {t('desk.library.publish')}
              </button>
            )
          ) : (
            // T6: shown, not hidden — a contributor can reach this screen and
            // should see why the one thing they cannot do is unavailable.
            <span className="t-caption">{t('desk.library.publishNeedsCapability')}</span>
          )
        ) : null}
      </div>

      {!isNew && entry ? (
        <section className="card">
          <h3 className="t-h3">{t('desk.library.sectionFullText')}</h3>
          {entry.fullTextUrl ? (
            <div className="workspace-row">
              <a className="link" href={entry.fullTextUrl} target="_blank" rel="noreferrer">
                {t('desk.library.viewFile')}
              </a>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => detachFile({ variables: { id } })}
              >
                {t('desk.library.detachFile')}
              </button>
            </div>
          ) : canHostFile ? (
            <div className="workspace-row">
              <input ref={fileInputRef} type="file" accept={RESEARCH_TEXT_ACCEPT} style={{ display: 'none' }} onChange={onPickFile} />
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadBusy}>
                {t('desk.library.uploadFile')}
              </button>
              {uploadError ? <p className="error">{t(uploadError)}</p> : null}
            </div>
          ) : (
            <p className="t-caption">{t('desk.library.hostingNotAllowed')}</p>
          )}
        </section>
      ) : null}

      {!isNew && entry ? (
        <section className="card">
          <h3 className="t-h3">{t('desk.library.sectionConcepts')}</h3>
          <div className="option-group">
            {(conceptsData?.libraryConcepts ?? []).map((c) => (
              <label key={c.id} className="option-item">
                <input
                  type="checkbox"
                  checked={conceptIds.includes(c.id)}
                  onChange={(e) =>
                    setConceptIds((ids) =>
                      e.target.checked ? [...ids, c.id] : ids.filter((cid) => cid !== c.id),
                    )
                  }
                />
                {locale === 'fa' ? c.titleFa : c.titleEn}
              </label>
            ))}
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onSaveConcepts} disabled={savingConcepts}>
            {t('desk.library.saveConcepts')}
          </button>
        </section>
      ) : null}

      {!isNew && entry ? (
        <p className="t-caption">
          {t('desk.library.createdBy', { name: entry.createdBy.name, date: fullDateTime(entry.createdAt, locale) })}
        </p>
      ) : null}
    </div>
  );
}
