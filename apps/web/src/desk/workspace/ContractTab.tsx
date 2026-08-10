import { useState, type FormEvent } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import {
  APPLY_CONTRACT_TEMPLATE,
  DELETE_AMENDMENT,
  DELETE_ARTICLE,
  ISSUE_AMENDMENT,
  PUBLISH_AMENDMENT,
  PUBLISH_CONTRACT,
  PUBLISH_CONTRACT_REVISION,
  SET_ARTICLE,
  UPDATE_AMENDMENT,
  UPDATE_CONTRACT_DRAFT,
  type Amendment,
  type Article,
} from '@/lib/queries';
import { fullDateTime } from '@/lib/format';
import type { WorkspaceContext } from './ContractWorkspace';

function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err);
}

/** Title and fee. `ref` is shown in the workspace header, not here — it is
 *  frozen at creation (T1) and never editable, so there is no form for it. */
function TitleFeeCard({ contractId, draft }: { contractId: string; draft: NonNullable<WorkspaceContext['contract']['draft']> | undefined }) {
  const { t } = useTranslation();
  const [titleFa, setTitleFa] = useState(draft?.titleFa ?? '');
  const [titleEn, setTitleEn] = useState(draft?.titleEn ?? '');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading }] = useMutation(UPDATE_CONTRACT_DRAFT);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: { contractId, titleFa, titleEn, amount: amount || null },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className="card editor-card">
      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="ct-fa">
              {t('workspace.titleFa')}
            </label>
            <input id="ct-fa" className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="ct-en">
              {t('workspace.titleEn')}
            </label>
            <input id="ct-en" className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="ct-amount">
              {t('workspace.amount')}
            </label>
            <input
              id="ct-amount"
              className="input num-latin"
              dir="ltr"
              inputMode="numeric"
              value={amount ?? ''}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div>
          <button className="btn btn-primary btn-sm" type="submit" disabled={loading}>
            {t('workspace.save')}
          </button>
        </div>
      </form>
    </section>
  );
}

function ArticleCard({
  contractId,
  article,
  nextNumber,
  onDone,
}: {
  contractId: string;
  article: Article | null;
  nextNumber: number;
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const [number] = useState(article?.number ?? nextNumber);
  const [titleFa, setTitleFa] = useState(article?.titleFa ?? '');
  const [titleEn, setTitleEn] = useState(article?.titleEn ?? '');
  const [bodyFa, setBodyFa] = useState(article?.bodyFa ?? '');
  const [bodyEn, setBodyEn] = useState(article?.bodyEn ?? '');
  const [error, setError] = useState<string | null>(null);
  const [setArticle, { loading: saving }] = useMutation(SET_ARTICLE);
  const [deleteArticle, { loading: deleting }] = useMutation(DELETE_ARTICLE);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await setArticle({
        variables: { contractId, number, titleFa, titleEn, bodyFa: bodyFa || null, bodyEn: bodyEn || null },
      });
      onDone?.();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteArticle'))) return;
    setError(null);
    try {
      await deleteArticle({ variables: { contractId, number } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card editor-card">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">{number}</span>
        {article ? (
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting}>
            {t('workspace.delete')}
          </button>
        ) : null}
      </div>
      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label">{t('workspace.titleFa')}</label>
            <input className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('workspace.titleEn')}</label>
            <input className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label">{t('workspace.bodyFa')}</label>
            <textarea className="textarea" dir="rtl" value={bodyFa} onChange={(e) => setBodyFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('workspace.bodyEn')}</label>
            <textarea className="textarea" dir="ltr" value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
          </div>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div>
          <button className="btn btn-secondary btn-sm" type="submit" disabled={saving}>
            {t('workspace.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

function AmendmentCard({ amendment, articles }: { amendment: Amendment; articles: Article[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [titleFa, setTitleFa] = useState(amendment.titleFa);
  const [titleEn, setTitleEn] = useState(amendment.titleEn);
  const [bodyFa, setBodyFa] = useState(amendment.bodyFa);
  const [bodyEn, setBodyEn] = useState(amendment.bodyEn);
  const [relatesToArticle, setRelatesToArticle] = useState(amendment.relatesToArticle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update, { loading: saving }] = useMutation(UPDATE_AMENDMENT);
  const [remove, { loading: deleting }] = useMutation(DELETE_AMENDMENT);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_AMENDMENT);

  const published = amendment.publishedAt !== null;

  async function onSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await update({
        variables: {
          amendmentId: amendment.id,
          titleFa,
          titleEn,
          bodyFa,
          bodyEn,
          relatesToArticle: relatesToArticle === '' ? null : Number(relatesToArticle),
        },
      });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteAmendment'))) return;
    try {
      await remove({ variables: { amendmentId: amendment.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function onPublish() {
    if (!confirm(t('workspace.confirmPublishAmendment'))) return;
    try {
      await publish({ variables: { amendmentId: amendment.id } });
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  if (published) {
    return (
      <div className="card editor-card">
        <div className="editor-card-head">
          <span className="t-eyebrow num-latin">A{amendment.ordinal}</span>
          <span className="badge badge-neutral">
            {amendment.signature
              ? t('workspace.amendmentSigned')
              : amendment.approvedAt
                ? t('workspace.amendmentApproved')
                : t('workspace.amendmentWaiting')}
          </span>
        </div>
        <p className="t-body">{titleEn}</p>
        <p className="t-small desk-muted">{fullDateTime(amendment.publishedAt!, locale)}</p>
      </div>
    );
  }

  return (
    <div className="card editor-card">
      <div className="editor-card-head">
        <span className="t-eyebrow num-latin">A{amendment.ordinal}</span>
        <div className="editor-card-actions">
          <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting}>
            {t('workspace.delete')}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onPublish} disabled={publishing}>
            {t('workspace.publish')}
          </button>
        </div>
      </div>
      <form className="auth-form" onSubmit={onSave}>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label">{t('workspace.titleFa')}</label>
            <input className="input" dir="rtl" required value={titleFa} onChange={(e) => setTitleFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('workspace.titleEn')}</label>
            <input className="input" dir="ltr" required value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />
          </div>
        </div>
        <div className="editor-grid-2">
          <div className="field">
            <label className="label">{t('workspace.bodyFa')}</label>
            <textarea className="textarea" dir="rtl" required value={bodyFa} onChange={(e) => setBodyFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label">{t('workspace.bodyEn')}</label>
            <textarea className="textarea" dir="ltr" required value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label">{t('workspace.relatesToArticle')}</label>
          <select className="select" value={relatesToArticle} onChange={(e) => setRelatesToArticle(e.target.value)}>
            <option value="">{t('workspace.relatesToArticleNone')}</option>
            {articles.map((a) => (
              <option key={a.number} value={a.number}>
                {a.number}. {a.titleEn}
              </option>
            ))}
          </select>
        </div>
        {error ? <p className="error">{error}</p> : null}
        <div>
          <button className="btn btn-secondary btn-sm" type="submit" disabled={saving}>
            {t('workspace.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ContractTab() {
  const { t } = useTranslation();
  const { contract } = useOutletContext<WorkspaceContext>();
  const [addingArticle, setAddingArticle] = useState(false);
  const [issuingAmendment, setIssuingAmendment] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [handoverError, setHandoverError] = useState<string | null>(null);

  const [applyTemplate, { loading: applyingTemplate }] = useMutation(APPLY_CONTRACT_TEMPLATE);
  const [publishRevision, { loading: publishing }] = useMutation(PUBLISH_CONTRACT_REVISION);
  const [publishContract, { loading: handingOver }] = useMutation(PUBLISH_CONTRACT);
  const [issueAmendment, { loading: issuing }] = useMutation(ISSUE_AMENDMENT);

  const draft = contract.draft ?? undefined;
  const articles = [...(draft?.articles ?? [])].sort((a, b) => a.number - b.number);
  const nextNumber = (articles.at(-1)?.number ?? 0) + 1;
  const amendments = contract.revision?.amendments ?? [];
  const baseSigned = !!contract.revision?.signature;

  async function onApplyTemplate() {
    setPublishError(null);
    try {
      await applyTemplate({ variables: { contractId: contract.id } });
    } catch (err) {
      setPublishError(errorMessage(err));
    }
  }

  async function onPublishRevision() {
    setPublishError(null);
    try {
      await publishRevision({ variables: { contractId: contract.id } });
    } catch (err) {
      setPublishError(errorMessage(err));
    }
  }

  async function onHandOver() {
    const warn = !contract.revision
      ? t('workspace.confirmHandoverEmpty')
      : t('workspace.confirmHandover');
    if (!confirm(warn)) return;
    setHandoverError(null);
    try {
      await publishContract({ variables: { contractId: contract.id } });
    } catch (err) {
      setHandoverError(errorMessage(err));
    }
  }

  async function onIssueAmendment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await issueAmendment({
        variables: {
          contractId: contract.id,
          titleFa: form.get('titleFa'),
          titleEn: form.get('titleEn'),
          bodyFa: form.get('bodyFa'),
          bodyEn: form.get('bodyEn'),
        },
      });
      setIssuingAmendment(false);
    } catch (err) {
      setPublishError(errorMessage(err));
    }
  }

  return (
    <>
      <TitleFeeCard contractId={contract.id} draft={draft} />

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.articlesTitle')}</h3>
        <div className="editor-card-actions">
          {articles.length === 0 ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={onApplyTemplate} disabled={applyingTemplate}>
              {t('workspace.applyTemplate')}
            </button>
          ) : null}
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setAddingArticle(true)}>
            {t('workspace.addArticle')}
          </button>
        </div>
      </div>

      <div className="editor-list">
        {addingArticle ? (
          <ArticleCard
            contractId={contract.id}
            article={null}
            nextNumber={nextNumber}
            onDone={() => setAddingArticle(false)}
          />
        ) : null}
        {articles.map((a) => (
          <ArticleCard key={a.number} contractId={contract.id} article={a} nextNumber={a.number} />
        ))}
      </div>

      <div className="workspace-row">
        <div className="dirty-note">
          <span className={`dirty-dot${draft?.dirty ? '' : ' dirty-dot-clean'}`} />
          {draft?.dirty ? t('workspace.dirty') : t('workspace.clean')}
        </div>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={onPublishRevision}
          disabled={publishing || !draft?.dirty}
        >
          {t('workspace.publishRevision')}
        </button>
      </div>
      {publishError ? <p className="error">{publishError}</p> : null}

      {!contract.publishedAt ? (
        <div className="workspace-row">
          <p className="t-small desk-muted">{t('workspace.handoverHelp')}</p>
          <button className="btn btn-secondary btn-sm" type="button" onClick={onHandOver} disabled={handingOver}>
            {t('workspace.handover')}
          </button>
        </div>
      ) : null}
      {handoverError ? <p className="error">{handoverError}</p> : null}

      {baseSigned ? (
        <>
          <div className="workspace-row">
            <h3 className="t-h3">{t('workspace.amendmentsTitle')}</h3>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setIssuingAmendment((v) => !v)}>
              {t('workspace.issueAmendment')}
            </button>
          </div>
          {issuingAmendment ? (
            <form className="card editor-card auth-form" onSubmit={onIssueAmendment}>
              <div className="editor-grid-2">
                <div className="field">
                  <label className="label">{t('workspace.titleFa')}</label>
                  <input className="input" name="titleFa" dir="rtl" required />
                </div>
                <div className="field">
                  <label className="label">{t('workspace.titleEn')}</label>
                  <input className="input" name="titleEn" dir="ltr" required />
                </div>
              </div>
              <div className="editor-grid-2">
                <div className="field">
                  <label className="label">{t('workspace.bodyFa')}</label>
                  <textarea className="textarea" name="bodyFa" dir="rtl" required />
                </div>
                <div className="field">
                  <label className="label">{t('workspace.bodyEn')}</label>
                  <textarea className="textarea" name="bodyEn" dir="ltr" required />
                </div>
              </div>
              <div>
                <button className="btn btn-primary btn-sm" type="submit" disabled={issuing}>
                  {t('workspace.save')}
                </button>
              </div>
            </form>
          ) : null}
          <div className="editor-list">
            {amendments.map((a) => (
              <AmendmentCard key={a.id} amendment={a} articles={contract.articles} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
