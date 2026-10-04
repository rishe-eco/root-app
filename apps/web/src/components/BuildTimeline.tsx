import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { calendarDate, formatCount, instantDate, pick } from '@/lib/format';
import type { BuildTimelineEntry } from '@/lib/queries';

/**
 * The build timeline (journeys build plan J10; journeys Q22): between the design's
 * (or mockup's) approval and the first demo the customer's wizard has no step to
 * look at, and that gap is where eighteen silent days happened (F6). This is what
 * fills it — the contract's phases in order, each with the versions Root has
 * *published* and the dates that go with them.
 *
 * **Derived, never typed**: every line is read off a row that exists
 * (`Contract.buildTimeline`, `lib/buildTimeline.ts`). A version number is an
 * identifier and stays in Latin figures (house rule 14); a count, a date and a phase
 * number follow the locale.
 */

export default function BuildTimeline({ entries }: { entries: BuildTimelineEntry[] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  return (
    <section className="card build-timeline" data-testid="build-timeline">
      <h3 className="t-h3">{t('demoStep.timeline.title')}</h3>
      <p className="t-small desk-muted">{t('demoStep.timeline.lede')}</p>
      <ol className="build-timeline-list">
        {entries.map((p) => (
          <li key={p.phaseId} className="build-timeline-phase" data-phase={p.number}>
            <p className="t-small">
              <strong>
                <span className="num-latin">{formatCount(p.number, locale)}</span> · {pick(p, 'title', locale)}
              </strong>
              {p.acceptedAt ? <span className="badge">{t('demoStep.timeline.accepted', { date: instantDate(p.acceptedAt, locale) })}</span> : null}
            </p>
            {p.plannedEndAt ? <p className="t-caption desk-muted">{t('demoStep.timeline.plannedEnd', { date: calendarDate(p.plannedEndAt, locale) })}</p> : null}
            {p.demoPublishedAt ? <p className="t-caption">{t('demoStep.timeline.demoOpened', { date: instantDate(p.demoPublishedAt, locale) })}</p> : null}
            {p.builds.length === 0 && !p.demoPublishedAt ? <p className="t-caption desk-muted">{t('demoStep.timeline.nothing')}</p> : null}
            {p.builds.map((b) => (
              <p className="t-caption" key={b.id} data-build={b.number}>
                {t('demoStep.timeline.build', { n: b.number, date: instantDate(b.publishedAt, locale) })}
              </p>
            ))}
          </li>
        ))}
      </ol>
    </section>
  );
}
