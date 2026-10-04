import { pick } from '@/lib/format';
import type { BuildChangeOutcome, FeedbackItem } from '@/lib/queries';

/**
 * One open feedback item with the disposition the developer is about to submit for
 * it — shared by the developer's queue screen (`desk/Builds.tsx`) and the demo
 * submission form (`DemoSubmission.tsx`, journeys build plan J10), so a disposition
 * reads and is worded the same wherever a version is declared (house rule 3).
 */

/** Structural rather than i18next's TFunction — same reasoning as lib/changelog.ts's T. */
type T = (key: string, opts?: Record<string, unknown>) => string;

export type Disposition = { outcome: BuildChangeOutcome; note: string; noteLang: 'fa' | 'en' };

export const DEFAULT_DISPOSITION: Disposition = { outcome: 'CARRIED_FORWARD', note: '', noteLang: 'en' };

/**
 * One open feedback item, with the disposition the developer is about to
 * submit for it. Since S2 a submission is its own ratification (PD-2), so every
 * open item takes any disposition — and the disposition is the developer's
 * answer, which the customer reads.
 */
export function DispositionRow({
  item,
  locale,
  t,
  value,
  onChange,
}: {
  item: FeedbackItem;
  locale: 'fa' | 'en';
  t: T;
  value: Disposition;
  onChange: (d: Disposition) => void;
}) {
  const target = item.demoPage
    ? pick(item.demoPage, 'label', locale)
    : item.frameLine
      ? pick(item.frameLine, 'text', locale)
      : '';

  return (
    <div className="card editor-card">
      <div className="workspace-row">
        <span className={`badge feedback-status-${item.status.toLowerCase()}`}>{t(`feedback.status.${item.status}`)}</span>
        <span className="t-small">{target}</span>
      </div>
      {item.comments.map((c) => (
        <p className="feedback-comment" key={c.id}>
          <span className="t-eyebrow">{c.author.name}</span> — {c.body}
        </p>
      ))}
      <div className="editor-grid-2">
        <div className="field">
          <label className="label">{t('desk.builds.outcomeLabel')}</label>
          <select
            className="input"
            value={value.outcome}
            onChange={(e) => onChange({ ...value, outcome: e.target.value as BuildChangeOutcome })}
          >
            <option value="CARRIED_FORWARD">{t('desk.builds.outcome.CARRIED_FORWARD')}</option>
            <option value="ADDRESSED">{t('desk.builds.outcome.ADDRESSED')}</option>
            <option value="DECLINED">{t('desk.builds.outcome.DECLINED')}</option>

          </select>
        </div>
        {value.outcome !== 'CARRIED_FORWARD' ? (
          <div className="field">
            <label className="label">{t('desk.builds.noteLangLabel')}</label>
            <select
              className="input"
              value={value.noteLang}
              onChange={(e) => onChange({ ...value, noteLang: e.target.value as 'fa' | 'en' })}
            >
              <option value="en">{t('desk.builds.lang.en')}</option>
              <option value="fa">{t('desk.builds.lang.fa')}</option>
            </select>
          </div>
        ) : null}
      </div>
      {value.outcome !== 'CARRIED_FORWARD' ? (
        <div className="field">
          <label className="label">
            {value.outcome === 'DECLINED' ? t('desk.builds.declineReasonLabel') : t('desk.builds.noteLabel')}
          </label>
          <textarea
            className="input"
            rows={2}
            value={value.note}
            onChange={(e) => onChange({ ...value, note: e.target.value })}
          />
        </div>
      ) : null}
    </div>
  );
}

