import { useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { calendarDate } from '@/lib/format';
import { SET_PLANNED_DATES, type Contract } from '@/lib/queries';
import DayInput from '@/components/DayInput';
import { errorCode } from '@/components/FeedbackPanel';
import AutosaveNote from '@/components/AutosaveNote';
import { useAutosave } from '@/lib/useAutosave';

/**
 * The planned start and end, proposed with the draft (journeys build plan J6,
 * Q12) — **moved in DX1** (desk UX review 15) from the draft step to the desk's
 * Contract tab, which now holds the contract's own settings: title, total price
 * and these two dates, all typed by hand. This is the one component for both
 * readings: staff with `contracts.author` edit them (a replace) where
 * `canEdit`; everyone else — the customer on the draft step, a designer on the
 * tab — reads them, and sees nothing at all while neither is set.
 */

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');

function refusalText(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  const code = errorCode(err);
  return code && t(`draft.error.${code}`, { defaultValue: '' }) ? t(`draft.error.${code}`) : (err as Error).message;
}

export default function PlannedDates({ contract, canEdit }: { contract: Contract; canEdit: boolean }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [save] = useMutation(SET_PLANNED_DATES);
  const [start, setStart] = useState(day(contract.plannedStartAt));
  const [end, setEnd] = useState(day(contract.plannedEndAt));

  // DX4 (review 27): the two dates travel together (`setPlannedDates` replaces both), so a blur
  // sends both as they stand. A half-typed date reports '' and marks the form invalid; that is
  // not a save (see the form's onBlur).
  const autosave = useAutosave({
    value: { start, end },
    baseline: { start: day(contract.plannedStartAt), end: day(contract.plannedEndAt) },
    save: (v) => save({ variables: { contractId: contract.id, plannedStartAt: v.start || null, plannedEndAt: v.end || null } }),
    errorText: (err) => refusalText(t, err),
  });

  if (!canEdit) {
    if (!contract.plannedStartAt && !contract.plannedEndAt) return null;
    return (
      <div className="draft-dates" data-testid="draft-dates">
        <span className="req-label">{t('draft.dates.title')}</span>
        <span className="req-value">
          {contract.plannedStartAt && contract.plannedEndAt
            ? t('statusArea.plannedRange', {
                start: calendarDate(contract.plannedStartAt, locale),
                end: calendarDate(contract.plannedEndAt, locale),
              })
            : calendarDate((contract.plannedStartAt ?? contract.plannedEndAt)!, locale)}
        </span>
        <span className="t-caption">{t('draft.dates.proposal')}</span>
      </div>
    );
  }

  return (
    <form
      className="card editor-card"
      onSubmit={(e) => e.preventDefault()}
      onBlur={(e) => {
        if (e.currentTarget.checkValidity()) autosave.onBlur();
      }}
      data-testid="draft-dates-editor"
    >
      <h4 className="t-h4">{t('draft.dates.title')}</h4>
      <p className="sec-help">{t('draft.dates.help')}</p>
      <DayInput value={start} onChange={setStart} label={t('draft.dates.start')} testId="draft-date-start" />
      <DayInput value={end} onChange={setEnd} label={t('draft.dates.end')} testId="draft-date-end" />
      <AutosaveNote autosave={autosave} testId="draft-dates-autosave" />
    </form>
  );
}
