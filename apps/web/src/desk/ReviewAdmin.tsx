import { useState, type FormEvent } from 'react';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useMutation, useQuery } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import {
  REVIEW_ROUNDS,
  REVIEWERS,
  INVITE_REVIEWER,
  REVOKE_REVIEWER,
  type ReviewRound,
  type User,
} from '@/lib/queries';
import { fullDateTime } from '@/lib/format';

/**
 * The corpus admin (C2 §5). Mostly read-only: the manifest is curated in
 * root-sot and a round is frozen the moment it's published, so there is
 * nothing here to edit — only reviewer invite and revoke are real actions,
 * both `review.admin`, deliberately apart from `customers.manage` (a
 * specialist invited to read a corpus is not thereby an account admin).
 */
export default function ReviewAdmin() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const canAdminister = can(me, 'review.admin');

  const { data: roundsData, loading: roundsLoading } = useQuery<{ reviewRounds: ReviewRound[] }>(REVIEW_ROUNDS, {
    skip: !canAdminister,
  });
  const { data: reviewersData } = useQuery<{ reviewers: Array<Pick<User, 'id' | 'name' | 'email'>> }>(REVIEWERS, {
    skip: !canAdminister,
  });
  const [invite] = useMutation(INVITE_REVIEWER, { refetchQueries: [{ query: REVIEWERS }] });
  const [revoke] = useMutation(REVOKE_REVIEWER, { refetchQueries: [{ query: REVIEWERS }] });

  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canAdminister) return <Navigate to={lp(locale, '/desk')} replace />;

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setInviteUrl(null);
    try {
      const res = await invite({ variables: { email, name } });
      setInviteUrl(res.data.inviteReviewer.inviteUrl);
      setEmail('');
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function onRevoke(id: string, reviewerName: string) {
    if (!confirm(t('desk.reviewAdmin.revokeConfirm', { name: reviewerName }))) return;
    setError(null);
    try {
      await revoke({ variables: { userId: id } });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const rounds = roundsData?.reviewRounds ?? [];
  const reviewers = reviewersData?.reviewers ?? [];

  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.reviewAdmin.title')}</h2>

      <section className="card">
        <h3 className="t-h3">{t('desk.reviewAdmin.reviewersTitle')}</h3>
        <form className="auth-form" onSubmit={onInvite}>
          <div className="field">
            <label className="label" htmlFor="r-email">
              {t('desk.reviewAdmin.inviteEmail')}
            </label>
            <input
              id="r-email"
              className="input"
              type="email"
              dir="ltr"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="r-name">
              {t('desk.reviewAdmin.inviteName')}
            </label>
            <input id="r-name" className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <button className="btn btn-primary btn-sm" type="submit">
              {t('desk.reviewAdmin.inviteCta')}
            </button>
          </div>
        </form>

        {error ? <p className="error">{error}</p> : null}
        {inviteUrl ? (
          <div className="auth-notice">
            <p className="t-small">{t('desk.reviewAdmin.inviteOnce')}</p>
            <code className="desk-code" dir="ltr">
              {inviteUrl}
            </code>
          </div>
        ) : null}

        <div className="table-wrap">
          <table className="ctable">
            <thead>
              <tr>
                <th>{t('desk.reviewAdmin.colName')}</th>
                <th>{t('desk.reviewAdmin.colEmail')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {reviewers.map((r) => (
                <tr key={r.id}>
                  {/* Names render in the ambient direction, deliberately —
                      persian-pass.md §1.6.1's decision. */}
                  <td>{r.name}</td>
                  <td dir="ltr">{r.email}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" type="button" onClick={() => onRevoke(r.id, r.name)}>
                      {t('desk.reviewAdmin.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 className="t-h3">{t('desk.reviewAdmin.manifestTitle')}</h3>
        {roundsLoading ? (
          <p className="t-small">{t('portal.loading')}</p>
        ) : rounds.length === 0 ? (
          <p className="t-small">{t('desk.reviewAdmin.empty')}</p>
        ) : (
          <div className="review-rounds">
            {rounds.map((r) => (
              <div className="card review-round" key={r.id}>
                <div className="review-round-head">
                  <h3 className="t-h3">{r.label ?? t('desk.review.untitledRound')}</h3>
                  <span className="review-sha">{r.sha.slice(0, 12)}</span>
                  <span className="t-caption">{fullDateTime(r.publishedAt, locale)}</span>
                  <span className="t-caption">{t('desk.review.publishedBy', { name: r.publishedBy.name })}</span>
                </div>
                <div className="review-doc-list">
                  {r.documents.map((d) => (
                    <div key={d.id} className="review-doc-row">
                      <span>{d.title}</span>
                      <span className="t-caption review-sha">{d.path}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
