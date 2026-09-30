import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { canAuthorDesign } from '@/lib/access';
import {
  ADD_CONCEPT,
  ADD_PAGE_DESIGN,
  DELETE_CONCEPT,
  DELETE_PAGE_DESIGN,
  DISCARD_DESIGN_DRAFT,
  PUBLISH_DESIGN_REVISION,
  SET_CONCEPT_IMAGE,
  SET_PAGE_IMAGE,
  UPDATE_CONCEPT,
  UPDATE_PAGE_DESIGN,
  type DesignConcept,
  type PageDesign,
} from '@/lib/queries';
import ImageUploader, { errorMessage } from '@/components/ImageUploader';
import { formatCount, pick } from '@/lib/format';
import type { WorkspaceContext } from './ContractWorkspace';

/** The four page keys every concept has used so far — a convenience picker,
 *  not a constraint the server enforces. Reuses the existing pages.* i18n
 *  namespace rather than inventing a client-side copy of templates.ts. */
const SUGGESTED_PAGE_KEYS = ['home', 'about', 'contracts', 'portal'];

function PageRow({
  contractId,
  page,
  editable,
}: {
  contractId: string;
  page: PageDesign;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [labelFa, setLabelFa] = useState(page.labelFa);
  const [labelEn, setLabelEn] = useState(page.labelEn);
  const [error, setError] = useState<string | null>(null);
  const [update, { loading: saving }] = useMutation(UPDATE_PAGE_DESIGN);
  const [remove, { loading: deleting }] = useMutation(DELETE_PAGE_DESIGN);
  const [setImage] = useMutation(SET_PAGE_IMAGE);

  if (!editable) {
    return (
      <div className="workspace-row">
        <div className="thumb" style={{ inlineSize: 64, blockSize: 40, flex: 'none' }}>
          {page.imageUrl ? <img src={page.imageUrl} alt="" /> : null}
        </div>
        <span className="t-small">{pick(page, 'label', locale)}</span>
        {page.approved ? <span className="badge badge-neutral">{t('workspace.approved')}</span> : null}
      </div>
    );
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({ variables: { pageId: page.id, labelFa, labelEn } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeletePage'))) return;
    try {
      await remove({ variables: { pageId: page.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card editor-card">
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
      <ImageUploader
        contractId={contractId}
        currentUrl={page.imageUrl}
        onAttach={async (fileId) => {
          await setImage({ variables: { pageId: page.id, fileId } });
        }}
      />
    </div>
  );
}

function ConceptCard({
  contractId,
  concept,
  editable,
}: {
  contractId: string;
  concept: DesignConcept;
  editable: boolean;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [labelFa, setLabelFa] = useState(concept.labelFa);
  const [labelEn, setLabelEn] = useState(concept.labelEn);
  const [addingPage, setAddingPage] = useState(false);
  const [newPageKey, setNewPageKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading: saving }] = useMutation(UPDATE_CONCEPT);
  const [remove, { loading: deleting }] = useMutation(DELETE_CONCEPT);
  const [setImage] = useMutation(SET_CONCEPT_IMAGE);
  const [addPage, { loading: addingPageLoading }] = useMutation(ADD_PAGE_DESIGN);

  if (!editable) {
    return (
      <div className="card editor-card">
        <div className="editor-card-head">
          <span className="t-eyebrow num-latin">{concept.key}</span>
          {concept.chosen ? <span className="badge badge-neutral">{t('workspace.chosen')}</span> : null}
        </div>
        <div className="thumb">
          {concept.imageUrl ? <img src={concept.imageUrl} alt="" /> : null}
        </div>
        <p className="t-small">{pick(concept, 'label', locale)}</p>
        <div className="editor-list">
          {concept.pages.map((p) => (
            <PageRow key={p.id} contractId={contractId} page={p} editable={false} />
          ))}
        </div>
      </div>
    );
  }

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({ variables: { conceptId: concept.id, labelFa, labelEn } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteConcept'))) return;
    try {
      await remove({ variables: { conceptId: concept.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onAddPage(e: FormEvent) {
    e.preventDefault();
    if (!newPageKey) return;
    try {
      await addPage({
        variables: {
          conceptId: concept.id,
          key: newPageKey,
          labelFa: newPageKey,
          labelEn: newPageKey,
        },
      });
      setAddingPage(false);
      setNewPageKey('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card editor-card">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{concept.key}</span>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting}>
          {t('workspace.delete')}
        </button>
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
        <button className="btn btn-secondary btn-sm" type="submit" disabled={saving}>
          {t('workspace.save')}
        </button>
      </form>
      <ImageUploader
        contractId={contractId}
        currentUrl={concept.imageUrl}
        onAttach={async (fileId) => {
          await setImage({ variables: { conceptId: concept.id, fileId } });
        }}
      />

      <div className="editor-list">
        {concept.pages.map((p) => (
          <PageRow key={p.id} contractId={contractId} page={p} editable />
        ))}
      </div>

      {addingPage ? (
        <form className="workspace-row" onSubmit={onAddPage}>
          <select className="select" value={newPageKey} onChange={(e) => setNewPageKey(e.target.value)} required>
            <option value="" disabled>
              {t('workspace.pickPageKey')}
            </option>
            {SUGGESTED_PAGE_KEYS.map((k) => (
              <option key={k} value={k}>
                {t(`pages.${k}`)}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary btn-sm" type="submit" disabled={addingPageLoading}>
            {t('workspace.save')}
          </button>
        </form>
      ) : (
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingPage(true)}>
          {t('workspace.addPage')}
        </button>
      )}
    </div>
  );
}

export default function DesignTab() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { contract, me } = useOutletContext<WorkspaceContext>();
  const [addingConcept, setAddingConcept] = useState(false);
  const [newConceptKey, setNewConceptKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addConcept, { loading: addingConceptLoading }] = useMutation(ADD_CONCEPT);
  const [discard, { loading: discarding }] = useMutation(DISCARD_DESIGN_DRAFT);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_DESIGN_REVISION);

  // Journeys build plan S1: design.author, and being this contract's own
  // designer (or holding assignments.override) — the API's canAuthorDesign,
  // mirrored here so the tab never offers a button the resolver will refuse
  // with NOT_ASSIGNED. Unassigned or uncapable, the tab still reads; it just
  // never writes.
  const editable = canAuthorDesign(me, contract);
  const draft = contract.designDraft;

  async function onAddConcept(e: FormEvent) {
    e.preventDefault();
    if (!newConceptKey) return;
    setError(null);
    try {
      await addConcept({
        variables: { contractId: contract.id, key: newConceptKey, labelFa: newConceptKey, labelEn: newConceptKey },
      });
      setAddingConcept(false);
      setNewConceptKey('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDiscard() {
    if (!confirm(t('workspace.confirmDiscardDraft'))) return;
    setError(null);
    try {
      await discard({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onPublish() {
    setError(null);
    try {
      await publish({ variables: { contractId: contract.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  // S1's own trap: an unassigned designer (or a viewer who is not this
  // contract's designer) would get NOT_ASSIGNED from every mutation below —
  // so the tab shows who is assigned instead of buttons that would be
  // refused.
  const designerLine = !editable ? (
    <p className="t-small desk-muted">
      {contract.designer
        ? t('workspace.designerAssignedTo', { name: contract.designer.name })
        : t('workspace.designerUnassigned')}
    </p>
  ) : null;

  const addConceptForm = !editable ? null : addingConcept ? (
    <form className="workspace-row" onSubmit={onAddConcept}>
      <input
        className="input num-latin"
        dir="ltr"
        placeholder="1d"
        value={newConceptKey}
        onChange={(e) => setNewConceptKey(e.target.value)}
        required
      />
      <button className="btn btn-secondary btn-sm" type="submit" disabled={addingConceptLoading}>
        {t('workspace.save')}
      </button>
    </form>
  ) : (
    <button className="btn btn-primary btn-sm" type="button" onClick={() => setAddingConcept(true)}>
      {t('workspace.addConcept')}
    </button>
  );

  if (!draft) {
    return (
      <>
        <p className="t-small desk-muted">{t('workspace.noDraftHelp')}</p>
        {designerLine}
        <div className="editor-list">
          {contract.concepts.map((c) => (
            <ConceptCard key={c.id} contractId={contract.id} concept={c} editable={false} />
          ))}
        </div>
        {error ? <p className="error">{error}</p> : null}
        {addConceptForm}
      </>
    );
  }

  const cf = draft.carryForward;
  const totalChanged = cf.changes.filter((c) => c.kind !== 'UNCHANGED').length;

  return (
    <>
      <div className="workspace-row">
        <p className="t-small desk-muted">{t('workspace.editingDraft', { version: draft.version })}</p>
        {editable ? (
          <div className="editor-card-actions">
            <button className="btn btn-ghost btn-sm" type="button" onClick={onDiscard} disabled={discarding}>
              {t('workspace.discardDraft')}
            </button>
            <button className="btn btn-primary btn-sm" type="button" onClick={onPublish} disabled={publishing}>
              {t('workspace.publishDesign')}
            </button>
          </div>
        ) : null}
      </div>
      {designerLine}
      {error ? <p className="error">{error}</p> : null}

      <div className="carry-preview">
        <p className="t-small">{t('workspace.carryForwardTitle')}</p>
        <div className="carry-preview-row">
          <span>{t('workspace.carriedPages', { n: formatCount(cf.carriedPageCount, locale) })}</span>
          <span>·</span>
          <span>{t('workspace.resetPages', { n: formatCount(cf.resetPageCount, locale) })}</span>
        </div>
        {cf.chosenConceptKey === null && contract.concepts.some((c) => c.chosen) ? (
          <p className="t-caption desk-muted">{t('workspace.choiceReset')}</p>
        ) : null}
        {totalChanged > 0 ? (
          <div className="carry-preview-row" style={{ flexWrap: 'wrap' }}>
            {cf.changes
              .filter((c) => c.kind !== 'UNCHANGED')
              .map((c) => (
                <span key={`${c.conceptKey}:${c.pageKey}`} className={`change-tag change-tag-${c.kind.toLowerCase()}`}>
                  {c.conceptKey}/{c.pageKey}: {t(`workspace.change${c.kind[0]}${c.kind.slice(1).toLowerCase()}`)}
                </span>
              ))}
          </div>
        ) : null}
      </div>

      <div className="editor-list">
        {draft.concepts.map((c) => (
          <ConceptCard key={c.id} contractId={contract.id} concept={c} editable={editable} />
        ))}
      </div>

      {addConceptForm}
    </>
  );
}
