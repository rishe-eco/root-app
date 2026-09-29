import { useState } from 'react';
import { useMutation, useQuery } from '@apollo/client';
import { Navigate, useOutletContext } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLocale, lp } from '@/lib/locale';
import { can } from '@/lib/access';
import { pick, relativeTime } from '@/lib/format';
import { errorCode } from '@/components/FeedbackPanel';
import {
  APPROVE_ANSWER,
  DECLINE_ANSWER,
  PENDING_ANSWERS,
  type PendingAnswer,
  type User,
} from '@/lib/queries';

/**
 * The answer approval queue (journeys build plan S2; journeys §7.10) — every
 * answer a designer or developer wrote outside their own step, waiting for
 * sales. Gated on `feedback.approveAnswers`, the capability the API's
 * `pendingAnswers` checks.
 *
 * The queue lands on the founder (plan §9, risk 5), so each card carries what a
 * decision needs and nothing else: where it is (contract, step), the thread it
 * answers, who wrote it, and what it would do to the item. Three ways out:
 * approve as written, edit the words and approve (the author's are kept), or
 * send it back with a reason its author will read. The customer sees nothing
 * until an approval, and the step cannot be approved while any answer waits.
 */

function Card({ entry, onDone }: { entry: PendingAnswer; onDone: () => void }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [mode, setMode] = useState<'idle' | 'edit' | 'decline'>('idle');
  const [text, setText] = useState(entry.comment.body);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approve, { loading: approving }] = useMutation(APPROVE_ANSWER);
  const [decline, { loading: declining }] = useMutation(DECLINE_ANSWER);

  const fail = (err: unknown) => {
    const code = errorCode(err);
    setError(code && t(`desk.approvals.error.${code}`, { defaultValue: '' }) ? t(`desk.approvals.error.${code}`) : (err as Error).message);
  };

  async function onApprove(body: string | null) {
    setError(null);
    try {
      await approve({ variables: { commentId: entry.comment.id, body } });
      onDone();
    } catch (err) {
      fail(err);
    }
  }

  async function onDecline() {
    setError(null);
    if (!reason.trim()) {
      setError(t('desk.approvals.error.REASON_REQUIRED'));
      return;
    }
    try {
      await decline({ variables: { commentId: entry.comment.id, reason: reason.trim() } });
      onDone();
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div className="card editor-card" data-testid="approval-card">
      <div className="workspace-row">
        <span className="badge">
          {t('desk.approvals.where', {
            ref: entry.contractRef,
            step: t(`wizard.step.${entry.step}`),
          })}
        </span>
        <span className="t-small">{pick({ titleFa: entry.contractTitleFa, titleEn: entry.contractTitleEn }, 'title', locale)}</span>
        <span className="t-caption muted">{relativeTime(entry.comment.createdAt, locale)}</span>
      </div>

      <div className="feedback-thread">
        <p className="t-eyebrow">{t('desk.approvals.customerSaid')}</p>
        {entry.item.comments
          .filter((c) => c.id !== entry.comment.id && c.approval === 'NOT_REQUIRED')
          .map((c) => (
            <p className="feedback-comment" key={c.id}>
              <span className="t-eyebrow">{c.author.name}</span> — {c.body}
            </p>
          ))}
      </div>

      <div className="feedback-thread">
        <p className="t-caption">{t('desk.approvals.author', { name: entry.comment.author.name })}</p>
        <p className="feedback-comment" data-testid="approval-body">
          {entry.comment.body}
        </p>
        {entry.comment.resolution ? (
          <p className="t-caption">
            {t('desk.approvals.resolves', { resolution: t(`feedback.resolution.${entry.comment.resolution}`) })}
          </p>
        ) : null}
      </div>

      {mode === 'edit' ? (
        <div className="feedback-comment-form">
          <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label={t('feedback.answer.placeholder')} />
          <div className="workspace-row">
            <button className="btn btn-primary btn-sm" type="button" disabled={approving || !text.trim()} onClick={() => onApprove(text.trim())}>
              {t('desk.approvals.saveApprove')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMode('idle')}>
              {t('desk.approvals.cancel')}
            </button>
          </div>
        </div>
      ) : mode === 'decline' ? (
        <div className="feedback-comment-form">
          <label className="label" htmlFor={`reason-${entry.comment.id}`}>
            {t('desk.approvals.reasonLabel')}
          </label>
          <textarea id={`reason-${entry.comment.id}`} className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="workspace-row">
            <button className="btn btn-primary btn-sm" type="button" disabled={declining} onClick={onDecline}>
              {t('desk.approvals.confirmDecline')}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMode('idle')}>
              {t('desk.approvals.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="workspace-row">
          <button className="btn btn-primary btn-sm" type="button" disabled={approving} onClick={() => onApprove(null)}>
            {t('desk.approvals.approve')}
          </button>
          <button className="btn btn-secondary btn-sm" type="button" onClick={() => setMode('edit')}>
            {t('desk.approvals.editAndApprove')}
          </button>
          <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMode('decline')}>
            {t('desk.approvals.decline')}
          </button>
        </div>
      )}
      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}

export default function Approvals() {
  const { t } = useTranslation();
  const locale = useLocale();
  const me = useOutletContext<User>();
  const allowed = can(me, 'feedback.approveAnswers');
  const { data, loading, refetch } = useQuery<{ pendingAnswers: PendingAnswer[] }>(PENDING_ANSWERS, {
    skip: !allowed,
    fetchPolicy: 'cache-and-network',
  });

  if (!allowed) return <Navigate to={lp(locale, '/desk')} replace />;
  const entries = data?.pendingAnswers ?? [];

  return (
    <div className="desk-section">
      <div className="content-head">
        <div>
          <h2 className="t-h2">{t('desk.approvals.title')}</h2>
          <p className="t-lead">{t('desk.approvals.lede')}</p>
        </div>
      </div>
      {entries.length === 0 && !loading ? <p className="t-small muted">{t('desk.approvals.empty')}</p> : null}
      <div className="editor-list">
        {entries.map((entry) => (
          <Card key={entry.id} entry={entry} onDone={() => void refetch()} />
        ))}
      </div>
    </div>
  );
}
