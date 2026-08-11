import { Link, Navigate, useOutletContext, useParams } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { REVIEW_DOCUMENT, type ReviewDocument, type User } from '@/lib/queries';
import { fullDateTime } from '@/lib/format';
import { blockLocale, renderBlockHtml } from '@/lib/markdown';

/** A document, rendered from its frozen blocks (C1.md §4) — one block at a
 *  time, each carrying its own lang/dir the same way the Library reader's
 *  columns do (R2.md §1), since root-sot's canon mixes English and Persian
 *  within one document. */
export default function ReviewDocumentScreen() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const { roundId, documentId } = useParams();

  const { data, loading } = useQuery<{ reviewDocument: ReviewDocument | null }>(REVIEW_DOCUMENT, {
    variables: { roundId, documentId },
    skip: !can(me, 'review.participate') || !roundId || !documentId,
  });

  if (!can(me, 'review.participate')) return <Navigate to={lp(locale, '/desk')} replace />;
  if (loading) return <p className="t-small">{t('portal.loading')}</p>;

  const doc = data?.reviewDocument;
  // T2-style refusal: a bad round/document id combination is "no such
  // thing", indistinguishable from any other, not an error page of its own.
  if (!doc) return <Navigate to={lp(locale, '/desk/review')} replace />;

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
      </div>

      <div className="review-doc-body">
        {doc.blocks.map((b) => {
          const { lang, dir } = blockLocale(b.text);
          return (
            <div
              key={b.id}
              className="review-block"
              data-block-id={b.id}
              lang={lang}
              dir={dir}
              dangerouslySetInnerHTML={{ __html: renderBlockHtml(b.text) }}
            />
          );
        })}
      </div>
    </div>
  );
}
