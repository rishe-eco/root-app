import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
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
  type Amendment,
  type Article,
} from '@/lib/queries';
import { fullDateTime, instantDate, pick } from '@/lib/format';
import { isPaymentScheduleArticle } from '@/lib/agreement';
import { errorCode } from '@/components/FeedbackPanel';
import Lock from '@/components/Lock';
import TitleFeeCard from '@/components/TitleFeeCard';
import TitleField from '@/components/TitleField';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';
import { hasOneTitle } from '@/lib/titleScript';
import ContractRefCard from '@/components/ContractRefCard';
import PlannedDates from '@/components/PlannedDates';
import ReadinessBox from './ReadinessBox';
import InlineAdd from '@/components/InlineAdd';
import type { WorkspaceContext } from './ContractWorkspace';

function errorMessage(err: unknown, t?: (key: string, opts?: Record<string, unknown>) => string): string {
  // The refusals J7 added get a sentence in the reader's language; everything else keeps the server's own message, as it always did.
  const code = errorCode(err);
  if (t && code && ['STEP_LOCKED', 'SCHEDULE_IS_GENERATED', 'TITLE_REQUIRED'].includes(code)) return t(`workspace.error.${code}`);
  return (err as { message?: string })?.message ?? String(err);
}

function ArticleCard({
  contractId,
  article,
  locked,
  newRoad,
  folded = false,
  onToggle,
}: {
  contractId: string;
  article: Article;
  /** DX1 (review 14): shown as its title alone. The form stays mounted, hidden, so a half-typed edit survives a fold. */
  folded?: boolean;
  onToggle?: () => void;
  /** The agreement is approved (J7): every write here would be `STEP_LOCKED`. */
  locked: boolean;
  /** An `AGREEMENT_FIRST` contract — the only road with a generated schedule. */
  newRoad: boolean;
}) {
  const { t } = useTranslation();
  const number = article.number;
  const [titleFa, setTitleFa] = useState(article.titleFa);
  const [titleEn, setTitleEn] = useState(article.titleEn);
  const [bodyFa, setBodyFa] = useState(article.bodyFa ?? '');
  const [bodyEn, setBodyEn] = useState(article.bodyEn ?? '');
  // PD-14 (J4): this article's prose is about money. The API had the argument
  // since J4 and the desk no way to set it — J7 owed the toggle.
  const [sensitive, setSensitive] = useState(article.sensitive ?? false);
  const [error, setError] = useState<string | null>(null);
  const [setArticle] = useMutation(SET_ARTICLE);
  const [deleteArticle, { loading: deleting }] = useMutation(DELETE_ARTICLE);
  // The payment schedule is generated from the plan on the new road (J7's second
  // trap): a body typed here would be a second schedule, so there is no field.
  const scheduleGenerated = newRoad && isPaymentScheduleArticle(number, titleEn);

  const vars = (v: { titleFa: string; titleEn: string; bodyFa: string; bodyEn: string; sensitive: boolean }) => ({
    contractId,
    number,
    titleFa: v.titleFa,
    titleEn: v.titleEn,
    bodyFa: scheduleGenerated ? null : v.bodyFa || null,
    bodyEn: scheduleGenerated ? null : v.bodyEn || null,
    // An existing article sends exactly what the box says.
    sensitive: v.sensitive,
  });

  // An article saves when a field is left (DX4, review 27); adding one is `AddArticleForm`'s (DX6).
  const autosave = useAutosave({
    value: { titleFa, titleEn, bodyFa, bodyEn, sensitive },
    baseline: {
      titleFa: article.titleFa,
      titleEn: article.titleEn,
      bodyFa: article.bodyFa ?? '',
      bodyEn: article.bodyEn ?? '',
      sensitive: article.sensitive ?? false,
    },
    valid: (v) => hasOneTitle(v.titleFa, v.titleEn),
    save: (v) => setArticle({ variables: vars(v) }),
    disabled: locked,
    errorText: (err) => errorMessage(err, t),
  });

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteArticle'))) return;
    setError(null);
    try {
      await deleteArticle({ variables: { contractId, number } });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  const locale = useLocale();
  const title = (locale === 'fa' ? titleFa || titleEn : titleEn || titleFa) || '—';
  const bodyId = `article-body-${number}`;

  return (
    <div className="card editor-card" data-testid="article-card" data-number={number} data-folded={folded ? 'true' : 'false'}>
      <div className="editor-card-head">
        {onToggle ? (
          <button
            type="button"
            className="article-toggle"
            aria-expanded={!folded}
            aria-controls={bodyId}
            aria-label={t('workspace.foldArticle', { n: number })}
            onClick={onToggle}
            data-testid="article-toggle"
          >
            <span className="t-eyebrow num-latin">{number}</span>
            <span className="article-toggle-title" data-testid="article-title">{title}</span>
            <span className="article-toggle-mark" aria-hidden="true">{folded ? (locale === 'fa' ? '◂' : '▸') : '▾'}</span>
          </button>
        ) : (
          <span className="t-eyebrow num-latin">{number}</span>
        )}
        <button className="btn btn-ghost btn-sm" type="button" onClick={onDelete} disabled={deleting || locked}>
          {t('workspace.delete')}
        </button>
      </div>
      <div id={bodyId} hidden={folded}>
      <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
        <TitleField
          idBase={`article-${number}`}
          testId="article-title-field"
          fa={titleFa}
          en={titleEn}
          disabled={locked}
          onChange={(v) => {
            setTitleFa(v.fa);
            setTitleEn(v.en);
          }}
        />
        {scheduleGenerated ? (
          <p className="t-small desk-muted" data-testid="schedule-generated-note">
            {t('workspace.scheduleGenerated')}
          </p>
        ) : (
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
        )}
        <label className="req-check">
          <input
            type="checkbox"
            data-testid="article-sensitive"
            checked={sensitive}
            disabled={locked}
            onChange={(e) => {
              setSensitive(e.target.checked);
              autosave.commit({ titleFa, titleEn, bodyFa, bodyEn, sensitive: e.target.checked });
            }}
          />
          <span>
            {t('workspace.sensitive')}
            <span className="t-caption desk-muted"> {t('workspace.sensitiveHelp')}</span>
          </span>
        </label>
        <AutosaveNote autosave={autosave} testId="article-autosave" />
        {error ? <p className="error">{error}</p> : null}
      </form>
      </div>
    </div>
  );
}

/**
 * "Add article" (DX6: the desk's one way to add, `InlineAdd`): a button, then a small form with a title, the two texts
 * and the money flag, with Add and Cancel. The article takes the next number; one whose number and English title are the
 * payment schedule's gets no body on the new road (the schedule is generated from the plan, J7's second trap).
 */
function AddArticleForm({ contractId, nextNumber, locked, newRoad }: { contractId: string; nextNumber: number; locked: boolean; newRoad: boolean }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState({ fa: '', en: '' });
  const [bodyFa, setBodyFa] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [setArticle, { loading }] = useMutation(SET_ARTICLE);
  const scheduleGenerated = newRoad && isPaymentScheduleArticle(nextNumber, title.en);
  const reset = () => {
    setTitle({ fa: '', en: '' });
    setBodyFa('');
    setBodyEn('');
    setSensitive(false);
  };
  if (locked) return null;
  return (
    <InlineAdd
      label={t('workspace.addArticle')}
      testId="article-add"
      ready={hasOneTitle(title.fa, title.en)}
      busy={loading}
      onCancel={reset}
      errorText={(err) => errorMessage(err, t)}
      onSubmit={async () => {
        await setArticle({
          variables: {
            contractId,
            number: nextNumber,
            titleFa: title.fa,
            titleEn: title.en,
            bodyFa: scheduleGenerated ? null : bodyFa || null,
            bodyEn: scheduleGenerated ? null : bodyEn || null,
            // Unticked defers to the template's rule (Fees and Payment Schedule are sensitive by number and title).
            sensitive: sensitive ? true : null,
          },
        });
        reset();
      }}
    >
      <TitleField idBase="article-add" testId="article-add-title" fa={title.fa} en={title.en} onChange={setTitle} />
      {scheduleGenerated ? (
        <p className="t-small desk-muted">{t('workspace.scheduleGenerated')}</p>
      ) : (
        <div className="editor-grid-2">
          <div className="field">
            <label className="label" htmlFor="article-add-body-fa">
              {t('workspace.bodyFa')}
            </label>
            <textarea id="article-add-body-fa" className="textarea" dir="rtl" value={bodyFa} onChange={(e) => setBodyFa(e.target.value)} />
          </div>
          <div className="field">
            <label className="label" htmlFor="article-add-body-en">
              {t('workspace.bodyEn')}
            </label>
            <textarea id="article-add-body-en" className="textarea" dir="ltr" value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />
          </div>
        </div>
      )}
      <label className="req-check">
        <input type="checkbox" data-testid="article-add-sensitive" checked={sensitive} onChange={(e) => setSensitive(e.target.checked)} />
        <span>
          {t('workspace.sensitive')}
          <span className="t-caption desk-muted"> {t('workspace.sensitiveHelp')}</span>
        </span>
      </label>
    </InlineAdd>
  );
}

function AmendmentCard({ amendment, articles }: { amendment: Amendment; articles: Article[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [titleFa, setTitleFa] = useState(amendment.titleFa);
  const [titleEn, setTitleEn] = useState(amendment.titleEn);
  const [bodyFa, setBodyFa] = useState(amendment.bodyFa ?? '');
  const [bodyEn, setBodyEn] = useState(amendment.bodyEn ?? '');
  const [sensitive, setSensitive] = useState(amendment.sensitive);
  const [relatesToArticle, setRelatesToArticle] = useState(amendment.relatesToArticle ?? '');
  const [error, setError] = useState<string | null>(null);
  const [update] = useMutation(UPDATE_AMENDMENT);
  const [remove, { loading: deleting }] = useMutation(DELETE_AMENDMENT);
  const [publish, { loading: publishing }] = useMutation(PUBLISH_AMENDMENT);

  const published = amendment.publishedAt !== null;

  // DX4 (review 27): an unpublished amendment saves when a field is left; `updateAmendment` takes
  // every field together, so each save sends the card as it stands.
  const autosave = useAutosave({
    value: { titleFa, titleEn, bodyFa, bodyEn, sensitive, relatesToArticle: String(relatesToArticle) },
    baseline: {
      titleFa: amendment.titleFa,
      titleEn: amendment.titleEn,
      bodyFa: amendment.bodyFa ?? '',
      bodyEn: amendment.bodyEn ?? '',
      sensitive: amendment.sensitive,
      relatesToArticle: String(amendment.relatesToArticle ?? ''),
    },
    valid: (v) => hasOneTitle(v.titleFa, v.titleEn) && v.bodyFa.trim() !== '' && v.bodyEn.trim() !== '',
    save: (v) =>
      update({
        variables: {
          amendmentId: amendment.id,
          titleFa: v.titleFa,
          titleEn: v.titleEn,
          bodyFa: v.bodyFa,
          bodyEn: v.bodyEn,
          relatesToArticle: v.relatesToArticle === '' ? null : Number(v.relatesToArticle),
          sensitive: v.sensitive,
        },
      }),
    disabled: published,
    errorText: (err) => errorMessage(err, t),
  });

  async function onDelete() {
    if (!confirm(t('workspace.confirmDeleteAmendment'))) return;
    try {
      await remove({ variables: { amendmentId: amendment.id } });
    } catch (err) {
      setError(errorMessage(err, t));
    }
  }

  async function onPublish() {
    if (!confirm(t('workspace.confirmPublishAmendment'))) return;
    try {
      await publish({ variables: { amendmentId: amendment.id } });
    } catch (err) {
      setError(errorMessage(err, t));
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
        <p className="t-body">{pick(amendment, 'title', locale)}</p>
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
      <form className="auth-form" onSubmit={(e) => e.preventDefault()} onBlur={autosave.onBlur}>
        <TitleField
          idBase={`amendment-${amendment.ordinal}`}
          testId="amendment-title-field"
          fa={titleFa}
          en={titleEn}
          onChange={(v) => {
            setTitleFa(v.fa);
            setTitleEn(v.en);
          }}
        />
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
          <select
            className="select"
            value={relatesToArticle}
            onChange={(e) => {
              setRelatesToArticle(e.target.value);
              autosave.commit({ titleFa, titleEn, bodyFa, bodyEn, sensitive, relatesToArticle: e.target.value });
            }}
          >
            <option value="">{t('workspace.relatesToArticleNone')}</option>
            {articles.map((a) => (
              <option key={a.number} value={a.number}>
                {a.number}. {pick(a, 'title', locale)}
              </option>
            ))}
          </select>
        </div>
        <label className="req-check">
          <input
            type="checkbox"
            data-testid="amendment-sensitive"
            checked={sensitive}
            onChange={(e) => {
              setSensitive(e.target.checked);
              autosave.commit({ titleFa, titleEn, bodyFa, bodyEn, sensitive: e.target.checked, relatesToArticle: String(relatesToArticle) });
            }}
          />
          <span>
            {t('workspace.amendmentSensitive')}
            <span className="t-caption desk-muted"> {t('workspace.amendmentSensitiveHelp')}</span>
          </span>
        </label>
        {error ? <p className="error">{error}</p> : null}
        <AutosaveNote autosave={autosave} testId="amendment-autosave" />
      </form>
    </div>
  );
}

/**
 * Journeys build plan S1: whoever can read this contract but not author it
 * (design, development, on their own active contracts) sees the published
 * title, fee and articles — never the draft (the API's own `draft` field is
 * null for them already) and never a form that would be refused. The fee is
 * `contract.amount`, which comes back null both when there genuinely is none
 * and when the viewer lacks `money.read` (PD-14) — `can(me, 'money.read')`
 * tells the two apart on this side, so "no fee set" and "not shown to you"
 * never look identical to someone who is allowed to tell the difference.
 */
function ReadOnlyContractView({ contract, canReadMoney }: { contract: WorkspaceContext['contract']; canReadMoney: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const articles = [...contract.articles].sort((a, b) => a.number - b.number);
  const moneyText = contract.amount !== null ? contract.amount : canReadMoney ? '—' : t('workspace.moneyHidden');

  return (
    <>
      <p className="t-small desk-muted">{t('workspace.readOnlyNotice')}</p>
      <section className="card editor-card">
        <p className="t-h3">{pick(contract, 'title', locale)}</p>
        <p className="t-small">
          {t('workspace.amount')}: <span className="num-latin">{moneyText}</span>
        </p>
      </section>
      <div className="editor-list">
        {articles.map((a) => (
          <div key={a.id} className="card editor-card">
            <span className="t-eyebrow num-latin">{a.number}</span>
            <p className="t-small">{pick(a, 'title', locale)}</p>
            {pick(a, 'body', locale) ? <p className="t-small desk-muted">{pick(a, 'body', locale)}</p> : null}
          </div>
        ))}
      </div>
    </>
  );
}

export default function ContractTab() {
  const { t } = useTranslation();
  const { contract, me } = useOutletContext<WorkspaceContext>();
  const locale = useLocale();
  const [newTitle, setNewTitle] = useState({ fa: '', en: '' });
  const [amendBodyFa, setAmendBodyFa] = useState('');
  const [amendBodyEn, setAmendBodyEn] = useState('');
  const [amendSensitive, setAmendSensitive] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  // Which of the two publish rows the message belongs under (DX1 added the top one).
  const [errorAt, setErrorAt] = useState<'top' | 'foot'>('foot');
  const [handoverError, setHandoverError] = useState<string | null>(null);
  // Which articles are open (DX1, review 14). Local and light: it is a view, not data. Founder walk 2026-11-18:
  // they start folded to their titles — after "Add the standard contract" too — and open one at a time.
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());

  const [applyTemplate, { loading: applyingTemplate }] = useMutation(APPLY_CONTRACT_TEMPLATE);
  const [publishRevision, { loading: publishing }] = useMutation(PUBLISH_CONTRACT_REVISION);
  const [publishContract, { loading: handingOver }] = useMutation(PUBLISH_CONTRACT);
  const [issueAmendment, { loading: issuing }] = useMutation(ISSUE_AMENDMENT);

  const draft = contract.draft ?? undefined;
  const articles = [...(draft?.articles ?? [])].sort((a, b) => a.number - b.number);
  const nextNumber = (articles.at(-1)?.number ?? 0) + 1;
  const amendments = contract.revision?.amendments ?? [];
  const baseSigned = !!contract.revision?.signature;
  // The agreement's approval locks the draft (J7). The API refuses every write
  // (`STEP_LOCKED`); a form that can only fail is worse than none, so the
  // controls are off and the date says why. The legacy road is never locked.
  const draftStep = contract.wizard?.find((s) => s.step === 'DRAFT');
  const locked = draftStep?.locked ?? false;
  const newRoad = contract.sequence === 'AGREEMENT_FIRST';

  if (!can(me, 'contracts.author')) {
    return <ReadOnlyContractView contract={contract} canReadMoney={can(me, 'money.read')} />;
  }

  async function onApplyTemplate() {
    setErrorAt('top');
    setPublishError(null);
    try {
      await applyTemplate({ variables: { contractId: contract.id } });
    } catch (err) {
      setPublishError(errorMessage(err, t));
    }
  }

  async function onPublishRevision(at: 'top' | 'foot' = 'foot') {
    setErrorAt(at);
    setPublishError(null);
    try {
      await publishRevision({ variables: { contractId: contract.id } });
    } catch (err) {
      setPublishError(errorMessage(err, t));
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
      setHandoverError(errorMessage(err, t));
    }
  }

  const resetAmendment = () => {
    setNewTitle({ fa: '', en: '' });
    setAmendBodyFa('');
    setAmendBodyEn('');
    setAmendSensitive(false);
  };

  async function onIssueAmendment() {
    await issueAmendment({
      variables: {
        contractId: contract.id,
        titleFa: newTitle.fa,
        titleEn: newTitle.en,
        bodyFa: amendBodyFa,
        bodyEn: amendBodyEn,
        // Unticked defers to the API, which follows the article it relates to.
        sensitive: amendSensitive ? true : null,
      },
    });
    resetAmendment();
  }

  return (
    <>
      {locked && draftStep?.lockedAt ? (
        <p className="locknote" data-testid="contract-locked-note">
          <Lock />
          <span>{t('wizard.lockedSince', { when: instantDate(draftStep.lockedAt, locale) })}</span>
        </p>
      ) : null}

      {/* DX1: whether the draft can be published, before anything else (review 16). */}
      {newRoad ? <ReadinessBox contract={contract} /> : null}

      {/* DX1 (review 15): the contract's own settings — title, total price, planned dates — are here and only here. */}
      {/* DX3b (review 1): the generated reference, editable until a signature. */}
      {can(me, 'contracts.author') ? <ContractRefCard contractId={contract.id} value={contract.ref} signed={baseSigned} /> : null}
      <TitleFeeCard contractId={contract.id} draft={draft} locked={locked} />
      {newRoad ? <PlannedDates contract={contract} canEdit={!locked} /> : null}

      <div className="workspace-row">
        <h3 className="t-h3">{t('workspace.articlesTitle')}</h3>
        <div className="editor-card-actions">
          {articles.length > 1 ? (
            <>
              <button className="btn btn-ghost btn-sm" type="button" data-testid="fold-all" onClick={() => setOpened(new Set())}>
                {t('workspace.foldAll')}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" data-testid="open-all" onClick={() => setOpened(new Set(articles.map((a) => a.number)))}>
                {t('workspace.openAll')}
              </button>
            </>
          ) : null}
          {articles.length === 0 ? (
            <button className="btn btn-secondary btn-sm" type="button" onClick={onApplyTemplate} disabled={applyingTemplate || locked}>
              {t('workspace.applyTemplate')}
            </button>
          ) : null}
          {/* DX1 (review 17): publish where the articles are edited, as well as at the foot. */}
          <button
            className="btn btn-primary btn-sm"
            type="button"
            onClick={() => void onPublishRevision('top')}
            disabled={publishing || !draft?.dirty || locked}
            data-testid="publish-top"
          >
            {t('workspace.publishTop')}
          </button>
        </div>
      </div>
      {publishError && errorAt === 'top' ? <p className="error" role="alert" data-testid="publish-error-top">{publishError}</p> : null}

      <div className="editor-list">
        {articles.map((a) => (
          <ArticleCard
            key={a.number}
            contractId={contract.id}
            article={a}
            locked={locked}
            newRoad={newRoad}
            folded={!opened.has(a.number)}
            onToggle={() =>
              setOpened((prev) => {
                const next = new Set(prev);
                if (next.has(a.number)) next.delete(a.number);
                else next.add(a.number);
                return next;
              })
            }
          />
        ))}
      </div>

      <AddArticleForm contractId={contract.id} nextNumber={nextNumber} locked={locked} newRoad={newRoad} />

      <div className="workspace-row">
        <div className="dirty-note">
          <span className={`dirty-dot${draft?.dirty ? '' : ' dirty-dot-clean'}`} />
          {draft?.dirty ? t('workspace.dirty') : t('workspace.clean')}
        </div>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={() => void onPublishRevision('foot')}
          disabled={publishing || !draft?.dirty || locked}
        >
          {t('workspace.publishRevision')}
        </button>
      </div>
      {publishError && errorAt === 'foot' ? <p className="error">{publishError}</p> : null}

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
          </div>
          {/* DX6: the desk's one way to add (`InlineAdd`) — the bodies are required, so they are controlled fields like the rest. */}
          <InlineAdd
            label={t('workspace.issueAmendment')}
            testId="amendment-add"
            ready={hasOneTitle(newTitle.fa, newTitle.en) && amendBodyFa.trim() !== '' && amendBodyEn.trim() !== ''}
            busy={issuing}
            onCancel={resetAmendment}
            errorText={(err) => errorMessage(err, t)}
            onSubmit={onIssueAmendment}
            buttonClassName="btn btn-ghost btn-sm"
          >
            <TitleField idBase="new-amendment" testId="new-amendment-title" fa={newTitle.fa} en={newTitle.en} onChange={setNewTitle} />
            <div className="editor-grid-2">
              <div className="field">
                <label className="label" htmlFor="new-amendment-body-fa">
                  {t('workspace.bodyFa')}
                </label>
                <textarea id="new-amendment-body-fa" className="textarea" dir="rtl" required value={amendBodyFa} onChange={(e) => setAmendBodyFa(e.target.value)} />
              </div>
              <div className="field">
                <label className="label" htmlFor="new-amendment-body-en">
                  {t('workspace.bodyEn')}
                </label>
                <textarea id="new-amendment-body-en" className="textarea" dir="ltr" required value={amendBodyEn} onChange={(e) => setAmendBodyEn(e.target.value)} />
              </div>
            </div>
            <label className="req-check">
              <input type="checkbox" checked={amendSensitive} onChange={(e) => setAmendSensitive(e.target.checked)} />
              <span>
                {t('workspace.amendmentSensitive')}
                <span className="t-caption desk-muted"> {t('workspace.amendmentSensitiveHelp')}</span>
              </span>
            </label>
          </InlineAdd>
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
