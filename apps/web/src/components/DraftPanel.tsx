import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApolloClient, useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { lp, useLocale } from '@/lib/locale';
import { can } from '@/lib/access';
import { formatCount, pick } from '@/lib/format';
import { hasNoteOnCurrent, notesByArticle } from '@/lib/scopeStep';
import {
  APPLY_CONTRACT_TEMPLATE,
  CONTRACT_DRAFT_NOTES,
  PUBLISH_CONTRACT_REVISION,
  type Article,
  type Contract,
  type DraftNote,
  type FeedbackItem,
} from '@/lib/queries';
import FeedbackPanel, { errorCode, type FeedbackTarget } from '@/components/FeedbackPanel';
import { PaymentSchedule } from '@/components/AgreementDocument';
import { isPaymentScheduleArticle } from '@/lib/agreement';
import type { StepPanelProps } from '@/components/StepPanels';
import PlannedDates from '@/components/PlannedDates';
import DraftSummary from '@/components/DraftSummary';

/**
 * Step 2b — the draft and its notes (journeys build plan J6), one panel for
 * both sides.
 *
 * **The customer reads the published draft article by article** — the
 * snapshot (`Contract.articles`), never Root's working copy — with the planned
 * start and end Root proposes beside it (Q12), and leaves a note on any
 * article. A note is the S2 model (`FeedbackItem`, step `DRAFT`, anchored to
 * `(revision, article number)`), so it has a thread, a fate Root writes, and
 * the same reopen rule as every other step's. **What this panel adds is where
 * each note's article is now**: after a later version is published a note still
 * sits under its article — found by title, so a renumbering does not re-point
 * it — with "changed in v3" when the text moved on, "now article 4" when only
 * its number did, and, when the article cannot be found, a place of its own at
 * the end saying so rather than a guess (`notesByArticle`; the API decided
 * which — `Contract.draftNotes`).
 *
 * **Staff see the same page and answer in place**, and above it, since DX1
 * (desk UX review 13): a read-only summary of Requirements and Pages and
 * features, then the publish button with the API's refusals worded (the scope,
 * then the brief) and "apply the contract template" while the draft has no
 * articles — and the publish button again at the foot, after the articles.
 * **The title, price and planned dates are not here any more**: they are the
 * contract's own settings and live in the desk's Contract tab (items 15, 17).
 * Editing the articles themselves stays in the Contract tab.
 *
 * **Money** (PD-14): a sensitive article's body is null for staff without
 * `money.read`; the title stays and the body is drawn as one line saying why —
 * a null must not be a crash, nor an empty article that looks like a mistake.
 * **A null body is not always money** (DX1, review 33): an article nobody wrote
 * in this language is null too, and used to be drawn as withheld on every
 * article of an English reading. The API now says which (`bodyWithheld`); a body
 * that was never written reads "No English text yet".
 */

type T = (key: string, opts?: Record<string, unknown>) => string;

function refusalText(t: T, err: unknown): string {
  const code = errorCode(err);
  return code && t(`draft.error.${code}`, { defaultValue: '' }) ? t(`draft.error.${code}`) : (err as Error).message;
}

/**
 * An article's body, or the reason there is none to show. **On a format-2 draft
 * the Payment Schedule article carries the plan instead of a body** (J7's second
 * trap): the customer reads the same schedule here that they will sign at step 3,
 * from the same snapshot, rather than an article that looks empty.
 */
function Body({ article, contract }: { article: Article; contract: Contract }) {
  const { t } = useTranslation();
  const locale = useLocale();
  if (contract.revision?.agreement && isPaymentScheduleArticle(article.number, article.titleEn)) {
    return <PaymentSchedule revision={contract.revision} />;
  }
  const body = locale === 'fa' ? article.bodyFa : article.bodyEn;
  if (article.bodyWithheld) {
    return <span className="draft-body draft-body-hidden" data-testid="draft-body-hidden">{t('draft.bodyHidden')}</span>;
  }
  if (body === null) {
    return <span className="draft-body draft-body-empty" data-testid="draft-body-unwritten">{t('draft.bodyNotWritten')}</span>;
  }
  if (body.trim() === '') {
    return <span className="draft-body draft-body-empty">{t('draft.bodyEmpty')}</span>;
  }
  return (
    <span className="draft-body" data-testid="draft-body">
      {body}
    </span>
  );
}

/**
 * Publishing, as one piece of state two places share: the button at the top of
 * the step and the one at the foot (DX1, review 13). `from` remembers which one
 * was pressed so its refusal or "published" line appears beside it and not twice.
 */
function usePublish(contract: Contract) {
  const { t } = useTranslation();
  const [publish, { loading }] = useMutation(PUBLISH_CONTRACT_REVISION);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [from, setFrom] = useState<'top' | 'bottom'>('top');

  async function run(where: 'top' | 'bottom') {
    setFrom(where);
    setError(null);
    setDone(false);
    try {
      await publish({ variables: { contractId: contract.id } });
      setDone(true);
    } catch (err) {
      setError(refusalText(t, err));
    }
  }
  return { run, loading, error, done, from };
}

type Publishing = ReturnType<typeof usePublish>;

/** Staff: the draft's own state and the things that move it — the template, and publishing. */
function DraftControls({ contract, publishing }: { contract: Contract; publishing: Publishing }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [apply, { loading: applying }] = useMutation(APPLY_CONTRACT_TEMPLATE);
  const [applyError, setApplyError] = useState<string | null>(null);
  const empty = (contract.draft?.articles.length ?? 0) === 0;

  async function onApply() {
    setApplyError(null);
    try {
      await apply({ variables: { contractId: contract.id } });
    } catch (err) {
      setApplyError(refusalText(t, err));
    }
  }

  const error = applyError ?? (publishing.from === 'top' ? publishing.error : null);
  return (
    <div className="card editor-card" data-testid="draft-controls">
      <h4 className="t-h4">{t('draft.controls.title')}</h4>
      <p className="sec-help">
        {contract.revision
          ? t('draft.controls.published', { version: contract.revision.version })
          : t('draft.controls.unpublished')}{' '}
        {contract.draft?.dirty ? t('draft.controls.dirty') : t('draft.controls.clean')}
      </p>
      <div className="workspace-row">
        {empty ? (
          <button className="btn btn-secondary btn-sm" type="button" disabled={applying} onClick={onApply} data-testid="draft-apply-template">
            {t('draft.controls.applyTemplate')}
          </button>
        ) : null}
        <button className="btn btn-primary btn-sm" type="button" disabled={publishing.loading} onClick={() => void publishing.run('top')} data-testid="draft-publish">
          {t('draft.controls.publish')}
        </button>
        <Link className="btn btn-ghost btn-sm" to={lp(locale, `/desk/contracts/${contract.id}/contract`)} data-testid="draft-edit-articles">
          {t('draft.controls.edit')}
        </Link>
      </div>
      {error ? <p className="error" role="alert" data-testid="draft-publish-error">{error}</p> : null}
      {publishing.done && publishing.from === 'top' ? <p className="t-small" role="status" data-testid="draft-published">{t('draft.controls.publishedNow')}</p> : null}
    </div>
  );
}

/** The publish button again at the foot of the step, after the articles it publishes. */
function DraftFoot({ publishing }: { publishing: Publishing }) {
  const { t } = useTranslation();
  return (
    <div className="workspace-row draft-foot" data-testid="draft-foot">
      <button className="btn btn-primary btn-sm" type="button" disabled={publishing.loading} onClick={() => void publishing.run('bottom')} data-testid="draft-publish-bottom">
        {t('draft.controls.publish')}
      </button>
      {publishing.error && publishing.from === 'bottom' ? <p className="error" role="alert" data-testid="draft-publish-error-bottom">{publishing.error}</p> : null}
      {publishing.done && publishing.from === 'bottom' ? <p className="t-small" role="status" data-testid="draft-published-bottom">{t('draft.controls.publishedNow')}</p> : null}
    </div>
  );
}

export default function DraftPanel({ contract, step, audience, me, asCustomer = false }: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const staff = audience === 'staff';
  const revision = contract.revision;
  const canAuthor = staff && can(me, 'contracts.author') && !step.locked;
  const publishing = usePublish(contract);

  const client = useApolloClient();
  const { data } = useQuery<{ contract: { id: string; draftNotes: DraftNote[]; feedbackItems: FeedbackItem[] } }>(
    CONTRACT_DRAFT_NOTES,
    { variables: { id: contract.id, asCustomer: asCustomer || null }, fetchPolicy: 'cache-and-network' },
  );
  // A note or an answer moves the step's own state (done while no note waits for
  // Root), and neither mutation returns a Contract — so every active query is
  // asked again, the wizard's and the notes' alike.
  const refresh = () => void client.refetchQueries({ include: 'active' });
  const notes = data?.contract.draftNotes ?? [];
  const articles = [...contract.articles].sort((a, b) => a.number - b.number);
  const { byArticle, orphans } = notesByArticle(articles, notes);

  const noteTarget = (n: DraftNote, label: FeedbackTarget['label'], group?: string): FeedbackTarget => ({
    key: `note:${n.item.id}`,
    group,
    label,
    caption: (
      <span className="draft-note-caption" data-testid="draft-note-caption">
        {t('draft.note.writtenOn', { version: n.revisionVersion })}
        {n.articleChangedSince && revision ? (
          <span className="badge draft-changed" data-testid="draft-changed">
            {t('draft.note.changed', { version: revision.version })}
          </span>
        ) : null}
        {!n.articleGone && n.currentArticleNumber !== null && n.currentArticleNumber !== n.articleNumber ? (
          <span className="badge" data-testid="draft-moved">
            {t('draft.note.moved', { n: n.currentArticleNumber })}
          </span>
        ) : null}
      </span>
    ),
    // A reply lands on the note's own anchor — the revision it was written on —
    // so it joins that thread rather than starting a second one.
    input: { contractRevisionId: n.item.contractRevisionId!, articleNumber: n.item.articleNumber ?? undefined },
    item: n.item,
  });

  const targets: FeedbackTarget[] = [];
  for (const a of articles) {
    const group = `${a.number}. ${pick(a, 'title', locale)}`;
    const mine = byArticle.get(a.number) ?? [];
    const body = <Body article={a} contract={contract} />;
    mine.forEach((n, i) => targets.push(noteTarget(n, i === 0 ? body : <span className="t-caption">{t('draft.note.another')}</span>, i === 0 ? group : undefined)));
    // An article with nothing yet on the version being read offers a blank note anchored there.
    if (revision && !hasNoteOnCurrent(mine)) {
      targets.push({
        key: `article:${a.number}`,
        group: mine.length === 0 ? group : undefined,
        label: mine.length === 0 ? body : <span className="t-caption">{t('draft.note.newOnCurrent', { version: revision.version })}</span>,
        input: { contractRevisionId: revision.id, articleNumber: a.number },
        item: null,
      });
    }
  }
  orphans.forEach((n, i) =>
    targets.push(
      noteTarget(
        n,
        <span className="t-small" data-testid="draft-orphan">
          {n.articleNumber !== null
            ? t('draft.orphan.line', { n: n.articleNumber, version: n.revisionVersion })
            : t('draft.orphan.whole', { version: n.revisionVersion })}
        </span>,
        i === 0 ? t('draft.orphan.title') : undefined,
      ),
    ),
  );

  return (
    <div className="draft-step" data-testid="draft-panel">
      <p className="t-small desk-muted">{staff ? t('draft.lede.staff') : t('draft.lede.customer')}</p>
      {staff && !contract.publishedAt ? (
        <p className="t-small req-notice" data-testid="not-handed-over">
          {t('brief.notHandedOver')}
        </p>
      ) : null}

      {/* DX1 (review 13): what the draft is written from, read-only, then the controls — the title, price and dates are on the Contract tab. */}
      {staff ? <DraftSummary contract={contract} /> : null}
      {canAuthor ? <DraftControls contract={contract} publishing={publishing} /> : null}
      <PlannedDates contract={contract} canEdit={false} />

      {!revision ? (
        <p className="t-small desk-muted" data-testid="draft-empty">
          {staff ? t('draft.empty.staff') : t('draft.empty.customer')}
        </p>
      ) : (
        <>
          <p className="t-caption" data-testid="draft-version">
            {t('draft.version', { version: revision.version, n: formatCount(articles.length, locale), count: articles.length })}
          </p>
          <FeedbackPanel
            contractId={contract.id}
            step="DRAFT"
            targets={targets}
            generalItem={data?.contract.feedbackItems.find((i) => i.general) ?? null}
            canRaise={!staff && !step.locked && !!contract.publishedAt}
            canAnswer={staff && can(me, 'feedback.answer')}
            answerDirect={can(me, 'answers.direct.agreement')}
            locked={step.locked}
            onChanged={refresh}
            onAnswered={refresh}
          />
        </>
      )}
      {canAuthor ? <DraftFoot publishing={publishing} /> : null}
    </div>
  );
}
