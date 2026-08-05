import { useTranslation } from 'react-i18next';

/**
 * V4's screen. Deliberately just a heading and a sentence here — building the
 * status tiles and queues now means guessing at state the earlier stages
 * (V1b–V4) haven't produced yet, and V4 would have to unbuild the guess.
 */
export default function Overview() {
  const { t } = useTranslation();
  return (
    <div className="desk-section">
      <h2 className="t-h2">{t('desk.navOverview')}</h2>
      <p className="t-body desk-muted">{t('desk.overviewSoon')}</p>
    </div>
  );
}
