import { Link, Navigate, useOutletContext } from 'react-router-dom';
import { useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { REVIEW_ROUNDS, type ReviewRound, type User } from '@/lib/queries';
import { fullDateTime } from '@/lib/format';

/** Rounds, newest first; within one, its documents in manifest order (C1.md
 *  §4). Publishing is the CLI's job (§3) — nothing here writes a round. */
export default function Review() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();

  const { data, loading } = useQuery<{ reviewRounds: ReviewRound[] }>(REVIEW_ROUNDS, {
    skip: !can(me, 'review.participate'),
  });

  if (!can(me, 'review.participate')) return <Navigate to={lp(locale, '/desk')} replace />;

  const rounds = data?.reviewRounds ?? [];

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.navReview')}</h2>

      {loading ? (
        <p className="t-small">{t('portal.loading')}</p>
      ) : rounds.length === 0 ? (
        <p className="t-small">{t('desk.review.empty')}</p>
      ) : (
        <div className="review-rounds">
          {rounds.map((r) => (
            <section className="card review-round" key={r.id}>
              <div className="review-round-head">
                <h3 className="t-h3">{r.label ?? t('desk.review.untitledRound')}</h3>
                <span className="review-sha">{r.sha.slice(0, 12)}</span>
                <span className="t-caption">{fullDateTime(r.publishedAt, locale)}</span>
                <span className="t-caption">{t('desk.review.publishedBy', { name: r.publishedBy.name })}</span>
              </div>
              <div className="review-doc-list">
                {r.documents.map((d) => (
                  <Link key={d.id} className="review-doc-row" to={lp(locale, `/desk/review/${r.id}/${d.id}`)}>
                    <span>{d.title}</span>
                    <span className="t-caption review-sha">{d.path}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
