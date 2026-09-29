import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Locale } from '@/i18n';
import { can } from '@/lib/access';
import { formatAmount, pick } from '@/lib/format';
import {
  CREATE_THEME,
  SET_TEMPLATE_TYPE_THEMES,
  TEMPLATE_TYPES,
  THEMES,
  UPDATE_THEME,
  type RtlSupport,
  type TemplateType,
  type Theme,
} from '@/lib/queries';
import { THEME_PREVIEW_ACCEPT, UploadFailure, uploadThemePreview } from '@/lib/upload';
import { refusalMessage } from './refusal';
import type { TemplatesContext } from './Templates';

/**
 * The Themes tab — the catalogue of ready-made site themes a designer can
 * offer a customer (journeys build plan T2). Written by `templates.types` (a
 * designer); read by anyone who opened the room.
 *
 * **There is no delete, and that is the design**: a design round (J8) will
 * remember the theme it showed, so a theme is only ever *deactivated*.
 *
 * **The demo link is a link.** Third-party demo sites refuse framing more often
 * than not and the portal's CSP does not allow them, so the link opens in a new
 * tab (`rel="noopener noreferrer"`) and nothing on this tab, or anywhere else,
 * puts it in an iframe.
 *
 * The licence cost is Root's own cost, shown to everyone who can read the
 * catalogue: the designer chooses by it, and it is not a customer's money.
 */

const RTL_VALUES: RtlSupport[] = ['FULL', 'PARTIAL', 'NONE', 'UNKNOWN'];

/** The form's fields, as text. Empty means "none" — which is also how the API
 *  is told to clear an optional field. */
type Draft = {
  name: string;
  vendor: string;
  demoUrl: string;
  rtlSupport: RtlSupport;
  licenseCost: string;
  notesFa: string;
  notesEn: string;
};

const BLANK: Draft = { name: '', vendor: '', demoUrl: '', rtlSupport: 'UNKNOWN', licenseCost: '', notesFa: '', notesEn: '' };

const fromTheme = (t: Theme): Draft => ({
  name: t.name,
  vendor: t.vendor ?? '',
  demoUrl: t.demoUrl ?? '',
  rtlSupport: t.rtlSupport,
  licenseCost: t.licenseCost ?? '',
  notesFa: t.notesFa ?? '',
  notesEn: t.notesEn ?? '',
});

/** A Persian keyboard types Persian digits, and the API takes Latin ones only
 *  (whole Toman, house rule 9). Converting here is a courtesy to the person
 *  typing; the API still refuses anything that is not digits. */
const toLatinDigits = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[,٬\s]/g, '');

const variablesOf = (d: Draft) => ({
  name: d.name,
  vendor: d.vendor,
  demoUrl: d.demoUrl,
  rtlSupport: d.rtlSupport,
  licenseCost: toLatinDigits(d.licenseCost),
  notesFa: d.notesFa,
  notesEn: d.notesEn,
});

/** The demo link, as the one safe way to show it: a new tab, no opener. */
function DemoLink({ url }: { url: string }) {
  const { t } = useTranslation();
  return (
    <a className="num-latin" dir="ltr" href={url} target="_blank" rel="noopener noreferrer">
      {t('desk.templates.themes.openDemo')}
    </a>
  );
}

function Preview({ theme }: { theme: Theme }) {
  const { t } = useTranslation();
  return (
    <div className="thumb theme-preview">
      {theme.previewUrl ? (
        <img src={theme.previewUrl} alt={t('desk.templates.themes.preview')} />
      ) : (
        <span className="t-caption desk-muted">{t('desk.templates.themes.noPreview')}</span>
      )}
    </div>
  );
}

function TypeChips({ theme, types, locale }: { theme: Theme; types: TemplateType[]; locale: Locale }) {
  const { t } = useTranslation();
  const named = types.filter((x) => theme.typeIds.includes(x.id));
  return (
    <p className="t-caption desk-muted">
      {t('desk.templates.themes.types')}:{' '}
      {named.length ? named.map((x) => pick(x, 'label', locale)).join('، ') : t('desk.templates.themes.noTypes')}
    </p>
  );
}

/** The fields shared by the create form and an editable card. */
function ThemeFields({ idPrefix, draft, onChange }: { idPrefix: string; draft: Draft; onChange: (patch: Partial<Draft>) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-name`}>
            {t('desk.templates.themes.name')}
          </label>
          <input
            id={`${idPrefix}-name`}
            className="input"
            dir="auto"
            required
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-vendor`}>
            {t('desk.templates.themes.vendor')}
          </label>
          <input
            id={`${idPrefix}-vendor`}
            className="input"
            dir="auto"
            value={draft.vendor}
            onChange={(e) => onChange({ vendor: e.target.value })}
          />
        </div>
      </div>
      <div className="field">
        <label className="label" htmlFor={`${idPrefix}-demo`}>
          {t('desk.templates.themes.demoUrl')}
        </label>
        <input
          id={`${idPrefix}-demo`}
          className="input num-latin"
          dir="ltr"
          type="text"
          inputMode="url"
          placeholder="https://"
          value={draft.demoUrl}
          onChange={(e) => onChange({ demoUrl: e.target.value })}
        />
        <p className="t-caption">{t('desk.templates.themes.demoHint')}</p>
      </div>
      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-rtl`}>
            {t('desk.templates.themes.rtl')}
          </label>
          <select
            id={`${idPrefix}-rtl`}
            className="input"
            value={draft.rtlSupport}
            onChange={(e) => onChange({ rtlSupport: e.target.value as RtlSupport })}
          >
            {RTL_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(`desk.templates.themes.rtlValue.${v}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-cost`}>
            {t('desk.templates.themes.licenseCost')}
          </label>
          <input
            id={`${idPrefix}-cost`}
            className="input"
            dir="ltr"
            inputMode="numeric"
            value={draft.licenseCost}
            onChange={(e) => onChange({ licenseCost: e.target.value })}
          />
          <p className="t-caption">{t('desk.templates.themes.licenseCostHint')}</p>
        </div>
      </div>
      <div className="editor-grid-2">
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-nfa`}>
            {t('desk.templates.themes.notesFa')}
          </label>
          <textarea
            id={`${idPrefix}-nfa`}
            className="input"
            dir="rtl"
            rows={3}
            value={draft.notesFa}
            onChange={(e) => onChange({ notesFa: e.target.value })}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${idPrefix}-nen`}>
            {t('desk.templates.themes.notesEn')}
          </label>
          <textarea
            id={`${idPrefix}-nen`}
            className="input"
            dir="ltr"
            rows={3}
            value={draft.notesEn}
            onChange={(e) => onChange({ notesEn: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}

function ThemeCard({ theme, types, locale, onChanged }: { theme: Theme; types: TemplateType[]; locale: Locale; onChanged: () => Promise<unknown> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(fromTheme(theme));
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [update, { loading }] = useMutation(UPDATE_THEME);

  async function guarded(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof UploadFailure ? t(err.i18nKey) : refusalMessage(t, err));
    }
  }

  const onSave = (e: FormEvent) => {
    e.preventDefault();
    return guarded(() => update({ variables: { id: theme.id, ...variablesOf(draft) } }));
  };

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploading(true);
    await guarded(async () => {
      await uploadThemePreview(theme.id, file);
      await onChanged();
    });
    setUploading(false);
  }

  return (
    <div className={`card editor-card${theme.active ? '' : ' template-inactive'}`} data-theme-name={theme.name}>
      <div className="editor-card-head">
        <span className="t-eyebrow">{theme.name}</span>
        <span className={`badge${theme.active ? '' : ' badge-neutral'}`}>
          {theme.active ? t('desk.templates.active') : t('desk.templates.inactive')}
        </span>
      </div>

      <Preview theme={theme} />
      <div className="editor-card-actions">
        <input
          ref={fileInput}
          type="file"
          accept={THEME_PREVIEW_ACCEPT}
          style={{ display: 'none' }}
          aria-label={t('desk.templates.themes.uploadPreview')}
          data-testid="theme-preview-input"
          onChange={onPick}
        />
        <button className="btn btn-secondary btn-sm" type="button" disabled={uploading} onClick={() => fileInput.current?.click()}>
          {uploading
            ? t('desk.templates.themes.uploading')
            : theme.previewUrl
              ? t('desk.templates.themes.replacePreview')
              : t('desk.templates.themes.uploadPreview')}
        </button>
        {theme.demoUrl ? <DemoLink url={theme.demoUrl} /> : null}
      </div>

      <form className="auth-form" onSubmit={onSave}>
        <ThemeFields idPrefix={`th-${theme.id}`} draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <TypeChips theme={theme} types={types} locale={locale} />
        <div className="editor-card-actions">
          <button className="btn btn-secondary btn-sm" type="submit" disabled={loading}>
            {t('desk.templates.save')}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            disabled={loading}
            onClick={() => guarded(() => update({ variables: { id: theme.id, active: !theme.active } }))}
          >
            {theme.active ? t('desk.templates.deactivate') : t('desk.templates.activate')}
          </button>
        </div>
      </form>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

/** A theme as a reader without `templates.types` sees it: the same facts, no controls. */
function ThemeRow({ theme, types, locale }: { theme: Theme; types: TemplateType[]; locale: Locale }) {
  const { t } = useTranslation();
  const cost = formatAmount(theme.licenseCost, locale);
  const notes = pick(theme, 'notes', locale);
  return (
    <div className={`card editor-card${theme.active ? '' : ' template-inactive'}`} data-theme-name={theme.name}>
      <div className="editor-card-head">
        <span className="t-eyebrow">{theme.name}</span>
        <span className={`badge${theme.active ? '' : ' badge-neutral'}`}>
          {theme.active ? t('desk.templates.active') : t('desk.templates.inactive')}
        </span>
      </div>
      <Preview theme={theme} />
      <p className="t-small">
        {[theme.vendor, `${t('desk.templates.themes.rtl')}: ${t(`desk.templates.themes.rtlValue.${theme.rtlSupport}`)}`]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <p className="t-small">
        {cost === null ? t('desk.templates.themes.noCost') : t('desk.templates.themes.cost', { amount: cost })}
      </p>
      {notes ? <p className="t-small">{notes}</p> : null}
      {theme.demoUrl ? <DemoLink url={theme.demoUrl} /> : null}
      <TypeChips theme={theme} types={types} locale={locale} />
    </div>
  );
}

/**
 * Which themes a type offers. A draft of the whole set, saved whole, exactly as
 * the Scope tab treats a scope list: `setTemplateTypeThemes` replaces the
 * type's set with what is ticked, so the screen shows a set and not a series of
 * instant per-row saves. An inactive theme stays tickable — unticking it here
 * is the only way to remove it from a type.
 */
function AssignPanel({ themes, types, locale }: { themes: Theme[]; types: TemplateType[]; locale: Locale }) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState('');
  const type = types.find((x) => x.id === selectedId) ?? types[0];
  const [draft, setDraft] = useState<{ typeId: string; ids: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, { loading }] = useMutation(SET_TEMPLATE_TYPE_THEMES);

  if (!type) return null;

  const saved = themes.filter((x) => x.typeIds.includes(type.id)).map((x) => x.id);
  const dirty = draft !== null && draft.typeId === type.id;
  const ticked = dirty ? draft.ids : saved;

  function toggle(id: string) {
    setError(null);
    setDraft({ typeId: type!.id, ids: ticked.includes(id) ? ticked.filter((x) => x !== id) : [...ticked, id] });
  }

  function onPickType(id: string) {
    if (dirty && !confirm(t('desk.templates.themes.discardAssignConfirm'))) return;
    setDraft(null);
    setError(null);
    setSelectedId(id);
  }

  async function onSave() {
    setError(null);
    try {
      await save({ variables: { typeId: type!.id, themeIds: ticked } });
      setDraft(null);
    } catch (err) {
      setError(refusalMessage(t, err));
    }
  }

  return (
    <section className="card editor-card" data-testid="theme-assign">
      <h3 className="t-h3">{t('desk.templates.themes.assignTitle')}</h3>
      <p className="t-small desk-muted">{t('desk.templates.themes.assignHelp')}</p>
      <div className="field">
        <label className="label" htmlFor="th-assign-type">
          {t('desk.templates.pickType')}
        </label>
        <select id="th-assign-type" className="input" value={type.id} onChange={(e) => onPickType(e.target.value)}>
          {types.map((x) => (
            <option key={x.id} value={x.id}>
              {pick(x, 'label', locale)}
              {x.active ? '' : ` — ${t('desk.templates.inactive')}`}
            </option>
          ))}
        </select>
      </div>
      {themes.length === 0 ? (
        <p className="t-small desk-muted">{t('desk.templates.themes.none')}</p>
      ) : (
        <div className="theme-checks">
          {themes.map((x) => (
            <label key={x.id} className="theme-check" data-theme-name={x.name}>
              <input type="checkbox" checked={ticked.includes(x.id)} onChange={() => toggle(x.id)} />
              <span>
                {x.name}
                {x.active ? '' : ` — ${t('desk.templates.inactive')}`}
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="editor-card-actions">
        <button className="btn btn-primary btn-sm" type="button" disabled={!dirty || loading} onClick={onSave}>
          {t('desk.templates.themes.assignSave')}
        </button>
        <span className="dirty-note">
          <span className={`dirty-dot${dirty ? '' : ' dirty-dot-clean'}`} />
          {dirty ? t('desk.templates.themes.unsavedAssign') : t('desk.templates.themes.savedAssign')}
        </span>
      </div>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export default function ThemesTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { me } = useOutletContext<TemplatesContext>();
  // The API's own check for every write on this tab.
  const editable = can(me, 'templates.types');

  const { data, loading, error, refetch } = useQuery<{ themes: Theme[] }>(THEMES);
  const { data: typeData } = useQuery<{ templateTypes: TemplateType[] }>(TEMPLATE_TYPES);
  const [create, { loading: creating }] = useMutation(CREATE_THEME, {
    // A new row is not in the cached list yet, and the list is what the screen
    // is built from.
    refetchQueries: [{ query: THEMES }],
  });

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [formError, setFormError] = useState<string | null>(null);

  const themes = data?.themes ?? [];
  const types = typeData?.templateTypes ?? [];

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      await create({ variables: variablesOf(draft) });
      setDraft(BLANK);
    } catch (err) {
      setFormError(refusalMessage(t, err));
    }
  }

  if (loading && !data) return <p className="t-small">{t('portal.loading')}</p>;
  if (error) return <p className="error">{t('portal.errorTitle')}</p>;

  return (
    <>
      {editable ? null : <p className="t-small desk-muted">{t('desk.templates.themes.readOnly')}</p>}
      <p className="t-small desk-muted">{t('desk.templates.themes.help')}</p>

      {editable ? (
        <section className="card editor-card">
          <h3 className="t-h3">{t('desk.templates.themes.newTheme')}</h3>
          <form className="auth-form" onSubmit={onCreate}>
            <ThemeFields idPrefix="th-new" draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
            <div className="editor-card-actions">
              <button className="btn btn-primary btn-sm" type="submit" disabled={creating}>
                {t('desk.templates.themes.add')}
              </button>
            </div>
            {formError ? <p className="error">{formError}</p> : null}
          </form>
        </section>
      ) : null}

      {editable ? <AssignPanel themes={themes} types={types} locale={locale} /> : null}

      {themes.length === 0 ? (
        <div className="empty">
          <p className="t-small">{t('desk.templates.themes.none')}</p>
        </div>
      ) : (
        <div className="editor-list">
          {themes.map((theme) =>
            editable ? (
              <ThemeCard key={theme.id} theme={theme} types={types} locale={locale} onChanged={refetch} />
            ) : (
              <ThemeRow key={theme.id} theme={theme} types={types} locale={locale} />
            ),
          )}
        </div>
      )}
    </>
  );
}
