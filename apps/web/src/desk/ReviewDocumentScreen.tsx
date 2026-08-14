import { useState, type FormEvent } from 'react';
import { Link, Navigate, useOutletContext, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  REVIEW_DOCUMENT,
  REVIEW_ROUNDS,
  OPEN_REVIEW_THREAD,
  ADD_REVIEW_COMMENT,
  RESOLVE_REVIEW_THREAD,
  type ReviewDocument,
  type ReviewRound,
  type ReviewThread,
  type User,
} from '@/lib/queries';
import { fullDateTime } from '@/lib/format';
import { blockLocale, renderBlockHtml } from '@/lib/markdown';
import { anchorFromSelection, verifyAnchor, highlightRange, type SelectionAnchor } from '@/lib/anchor';

/**
 * A document, rendered from its frozen blocks (C1.md §4) — one block at a
 * time, each carrying its own lang/dir the same way the Library reader's
 * columns do (R2.md §1). C2 adds threads: a selection inside one block opens
 * one, anchored to (blockId, start, end) into that block's *rendered* text
 * (C2.md §1). Offsets are re-verified against the live render on every read
 * (`verifyAnchor`) — a match highlights in place; a mismatch is shown
 * detached in its thread card, quote intact, never re-found (§1.1).
 */

type OkAnchor = Extract<SelectionAnchor, { ok: true }>;

/** Renders a block's HTML with every one of its verified threads
 *  highlighted, and reports which ones did *not* verify (detached). A pure
 *  function of (text, threads) — nothing here persists across renders, so
 *  there is no risk of re-wrapping an already-highlighted node on a second
 *  pass (unlike mutating the live rendered DOM in an effect would be). */
function renderBlockWithThreads(
  text: string,
  threads: ReviewThread[],
): { html: string; detachedIds: Set<string> } {
  const html = renderBlockHtml(text);
  if (threads.length === 0) return { html, detachedIds: new Set() };

  const container = document.createElement('div');
  container.innerHTML = html;
  const detachedIds = new Set<string>();
  for (const th of threads) {
    if (verifyAnchor(container, th.startOffset, th.endOffset, th.quote)) {
      highlightRange(container, th.startOffset, th.endOffset);
    } else {
      detachedIds.add(th.id);
    }
  }
  return { html: container.innerHTML, detachedIds };
}

function ThreadCard({
  thread,
  detached,
  me,
  roundId,
  documentId,
}: {
  thread: ReviewThread;
  detached: boolean;
  me: User;
  roundId: string;
  documentId: string;
}) {
  const { t } = useTranslation();
  const [replyBody, setReplyBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refetchQueries = [{ query: REVIEW_DOCUMENT, variables: { roundId, documentId } }];
  const [addComment, { loading: replying }] = useMutation(ADD_REVIEW_COMMENT, { refetchQueries });
  const [resolveThread, { loading: resolving }] = useMutation(RESOLVE_REVIEW_THREAD, { refetchQueries });

  async function onReply(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await addComment({ variables: { threadId: thread.id, body: replyBody } });
      setReplyBody('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onResolve() {
    setError(null);
    try {
      await resolveThread({ variables: { threadId: thread.id } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div
      id={`thread-${thread.id}`}
      className={`card review-thread-card${thread.resolvedAt ? ' review-thread-resolved' : ''}`}
    >
      <div className="review-thread-meta t-caption">
        {/* Names render in the ambient direction, deliberately —
            persian-pass.md §1.6.1's decision. */}
        <span>{thread.author.id === me.id ? t('desk.review.you') : thread.author.name}</span>
        {thread.resolvedAt ? <span className="badge badge-neutral">{t('desk.review.resolved')}</span> : null}
      </div>
      {detached ? <p className="review-thread-detached t-small">{t('desk.review.detached')}</p> : null}
      <blockquote className="review-thread-quote">“{thread.quote}”</blockquote>
      <div className="review-thread-comments">
        {thread.comments.map((c) => (
          <div key={c.id} className="review-thread-comment">
            <span className="t-caption review-thread-comment-author">
              {c.author.id === me.id ? t('desk.review.you') : c.author.name}
            </span>
            <p className="t-small">{c.body}</p>
          </div>
        ))}
      </div>
      {!thread.resolvedAt ? (
        <form className="review-thread-reply" onSubmit={onReply}>
          <textarea
            className="textarea"
            required
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder={t('desk.review.replyPlaceholder')}
          />
          <div className="review-thread-compose-actions">
            <button className="btn btn-secondary btn-sm" type="submit" disabled={replying}>
              {t('desk.review.reply')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={onResolve} disabled={resolving}>
              {t('desk.review.resolve')}
            </button>
          </div>
        </form>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export default function ReviewDocumentScreen() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { roundId, documentId } = useParams();
  const canParticipate = can(me, 'review.participate');

  const { data, loading } = useQuery<{ reviewDocument: ReviewDocument | null }>(REVIEW_DOCUMENT, {
    variables: { roundId, documentId },
    skip: !canParticipate || !roundId || !documentId,
  });
  // Thin — only for the staleness banner (C2.md §4), the same list Review.tsx shows.
  const { data: roundsData } = useQuery<{ reviewRounds: ReviewRound[] }>(REVIEW_ROUNDS, {
    skip: !canParticipate,
  });

  const [pendingSelection, setPendingSelection] = useState<OkAnchor | null>(null);
  const [refusedCrossBlock, setRefusedCrossBlock] = useState(false);
  const [composeBody, setComposeBody] = useState('');
  const [composeError, setComposeError] = useState<string | null>(null);
  const [openThread, { loading: opening }] = useMutation(OPEN_REVIEW_THREAD, {
    refetchQueries: [{ query: REVIEW_DOCUMENT, variables: { roundId, documentId } }],
  });

  if (!canParticipate) return <Navigate to={lp(locale, '/desk')} replace />;
  if (loading) return <p className="t-small">{t('portal.loading')}</p>;

  const doc = data?.reviewDocument;
  // T2-style refusal: a bad round/document id combination is "no such
  // thing", indistinguishable from any other, not an error page of its own.
  if (!doc) return <Navigate to={lp(locale, '/desk/review')} replace />;

  const rounds = roundsData?.reviewRounds ?? [];
  const latestRound = rounds[0];
  const isStale = Boolean(latestRound && latestRound.id !== doc.round.id);
  const currentEquivalent = latestRound?.documents.find((d) => d.path === doc.path);

  function onSelectInBody() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setPendingSelection(null);
      setRefusedCrossBlock(false);
      return;
    }
    const anchor = anchorFromSelection(selection);
    if (anchor.ok) {
      setPendingSelection(anchor);
      setRefusedCrossBlock(false);
    } else {
      setPendingSelection(null);
      setRefusedCrossBlock(anchor.reason === 'CROSS_BLOCK');
    }
  }

  function clearSelection() {
    setPendingSelection(null);
    setComposeBody('');
    window.getSelection()?.removeAllRanges();
  }

  async function onOpenThread(e: FormEvent) {
    e.preventDefault();
    if (!pendingSelection || !documentId) return;
    setComposeError(null);
    try {
      await openThread({
        variables: {
          documentId,
          blockId: pendingSelection.blockId,
          startOffset: pendingSelection.startOffset,
          endOffset: pendingSelection.endOffset,
          quote: pendingSelection.quote,
          body: composeBody,
        },
      });
      clearSelection();
    } catch (err) {
      setComposeError((err as Error).message);
    }
  }

  return (
    <div className="desk-section">
      <div className="review-doc-head">
        <Link className="t-caption link" to={lp(locale, '/desk/review')}>
          {t('desk.review.backToRounds')}
        </Link>
        <h2 className="t-h2">{doc.title}</h2>
        <p className="t-caption review-doc-provenance">
          {t('desk.review.docProvenance', {
            path: doc.path,
            sha: doc.round.sha.slice(0, 12),
            date: fullDateTime(doc.round.publishedAt, locale),
          })}
        </p>
        {isStale ? (
          <p className="review-round-stale-banner t-small">
            {t('desk.review.staleRound')}{' '}
            <Link
              className="link"
              to={lp(
                locale,
                currentEquivalent
                  ? `/desk/review/${latestRound!.id}/${currentEquivalent.id}`
                  : '/desk/review',
              )}
            >
              {t('desk.review.goToCurrent')}
            </Link>
          </p>
        ) : null}
      </div>

      {refusedCrossBlock ? (
        <p className="review-thread-refused t-small">{t('desk.review.crossBlockRefused')}</p>
      ) : pendingSelection ? (
        <form className="card review-thread-compose" onSubmit={onOpenThread}>
          <p className="t-caption">{t('desk.review.selectedQuote')}</p>
          <blockquote className="review-thread-quote">“{pendingSelection.quote}”</blockquote>
          <textarea
            className="textarea"
            required
            autoFocus
            value={composeBody}
            onChange={(e) => setComposeBody(e.target.value)}
            placeholder={t('desk.review.composePlaceholder')}
          />
          <div className="review-thread-compose-actions">
            <button className="btn btn-primary btn-sm" type="submit" disabled={opening}>
              {t('desk.review.openThread')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={clearSelection}>
              {t('desk.review.cancel')}
            </button>
          </div>
          {composeError ? <p className="error">{composeError}</p> : null}
        </form>
      ) : null}

      {/* `onKeyUp` alongside `onMouseUp` so a selection made with
          shift+arrows under caret browsing opens a thread too — the same
          class of gap as the contract list's mouse-only rows
          (`02-contract-flow.spec.ts:124`), and R3.md §7's standing
          instruction is not to add a second one. Both handlers are scoped
          to the body: the compose textarea sits outside it, so focusing it
          cannot clear the pending selection. */}
      <div className="review-doc-body" onMouseUp={onSelectInBody} onKeyUp={onSelectInBody}>
        {doc.blocks.map((b) => {
          const { lang, dir } = blockLocale(b.text);
          const blockThreads = doc.threads.filter((th) => th.blockId === b.id);
          const { html, detachedIds } = renderBlockWithThreads(b.text, blockThreads);
          return (
            <div key={b.id} className="review-block-wrap">
              <div
                className="review-block"
                data-block-id={b.id}
                lang={lang}
                dir={dir}
                dangerouslySetInnerHTML={{ __html: html }}
              />
              {blockThreads.length > 0 ? (
                <div className="review-thread-list">
                  {blockThreads.map((th) => (
                    <ThreadCard
                      key={th.id}
                      thread={th}
                      detached={detachedIds.has(th.id)}
                      me={me}
                      roundId={roundId!}
                      documentId={documentId!}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
