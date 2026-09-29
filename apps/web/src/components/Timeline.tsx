import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { TimelineItem } from '@/lib/queries';
import { clockTime, relativeTime } from '@/lib/format';
import { timelineText, type Audience } from '@/lib/wizard';

/**
 * The history rail of a new-road contract (journeys build plan J3, PD-17):
 * `Contract.timeline`, derived from the rows that carry who and when, in the
 * same rail-card the legacy `changeLog` uses. Legacy contracts keep reading
 * `changeLog`, and the two never appear together.
 *
 * The API names a *side* (`by`), never a person — the customer reads «ریشه»
 * for any staff member, as the legacy rail always has.
 */
export default function Timeline({ items, audience }: { items: TimelineItem[]; audience: Audience }) {
  const { t } = useTranslation();
  const locale = useLocale();

  const who = (by: TimelineItem['by']) =>
    audience === 'customer'
      ? by === 'CUSTOMER'
        ? t('detail.you')
        : t('detail.root')
      : by === 'CUSTOMER'
        ? t('timeline.byCustomer')
        : t('timeline.byRoot');

  return (
    <div className="rail-card" data-testid="timeline">
      <p className="rail-cap">{t('detail.historyCap')}</p>
      {items.length === 0 ? (
        <p className="t-small desk-muted">{t('timeline.empty')}</p>
      ) : (
        <div className="log">
          {items.map((item) => (
            <div className="logitem" key={item.id} data-kind={item.kind}>
              <span className="lwho">{who(item.by)}</span>
              <span className="lwhat">{timelineText(t, locale, item)}</span>
              <span className="lwhen">
                {relativeTime(item.at, locale)} · {clockTime(item.at, locale)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
