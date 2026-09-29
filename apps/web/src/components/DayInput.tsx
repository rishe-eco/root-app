import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { calendarDate } from '@/lib/format';
import { currentJalaliYear, dayToJalali, jalaliMonthLength, jalaliToDay } from '@/lib/jalali';

/**
 * A calendar day, chosen in the Jalali calendar (journeys build plan J4,
 * PD-16): three selects — day, month, year — over `jalaali-js`, in the kit's
 * own tokens, and no date-picker library. The value it speaks is a
 * `YYYY-MM-DD` string, and **never a `Date`** (PD-19): a `Date` built from a
 * Jalali day in local time is the day before west of Greenwich, which is how 1
 * Aban becomes 30 Mehr at 20:30. `lib/jalali.ts` converts integers to a string
 * and back and consults no zone.
 *
 * Controlled by `value` (a day, or `''` for none) and `onChange` (a day when all
 * three selects name a real Jalali day, `''` otherwise). Between those two the
 * component keeps the *partial* choice — a year picked before a month is not a
 * value yet, but it must not vanish from the select the moment it is picked.
 * A month change clamps a day that the new month does not have (30 Esfand →
 * 29 in a common year).
 *
 * Both the selects and the readout are the same day: the readout under them is
 * `calendarDate`, the one formatter for a stored day (in Persian it is the
 * Jalali date again, in English the Gregorian one — the reader's check that
 * the selects say what they meant).
 */

type Parts = { jy: string; jm: string; jd: string };
const EMPTY: Parts = { jy: '', jm: '', jd: '' };

const partsOf = (value: string): Parts => {
  const p = value ? dayToJalali(value) : null;
  return p ? { jy: String(p.jy), jm: String(p.jm), jd: String(p.jd) } : EMPTY;
};

export default function DayInput({
  value,
  onChange,
  label,
  required = false,
  disabled = false,
  testId,
}: {
  value: string;
  onChange: (day: string) => void;
  label: string;
  required?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [parts, setParts] = useState<Parts>(() => partsOf(value));

  // A value that changed from outside (the form reset, a save came back) wins
  // over a stale partial choice — but only when it is a different day from the
  // one the selects already name, so typing is never overwritten by its echo.
  useEffect(() => {
    const complete = jalaliToDay({ jy: Number(parts.jy), jm: Number(parts.jm), jd: Number(parts.jd) });
    if ((value || '') !== (complete ?? '')) setParts(partsOf(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const digits = new Intl.NumberFormat(locale === 'fa' ? 'fa-IR' : 'en-US', { useGrouping: false });
  const thisYear = currentJalaliYear();
  const chosenYear = parts.jy ? Number(parts.jy) : thisYear;
  const years: number[] = [];
  for (let y = Math.min(thisYear - 1, chosenYear); y <= Math.max(thisYear + 6, chosenYear); y += 1) years.push(y);
  const monthLength = parts.jm ? jalaliMonthLength(chosenYear, Number(parts.jm)) : 31;

  function change(next: Parts) {
    // Clamp a day the (new) month does not have.
    if (next.jd && next.jm) {
      const max = jalaliMonthLength(next.jy ? Number(next.jy) : thisYear, Number(next.jm));
      if (Number(next.jd) > max) next = { ...next, jd: String(max) };
    }
    setParts(next);
    const day =
      next.jy && next.jm && next.jd ? jalaliToDay({ jy: Number(next.jy), jm: Number(next.jm), jd: Number(next.jd) }) : null;
    onChange(day ?? '');
  }

  const day = jalaliToDay({ jy: Number(parts.jy), jm: Number(parts.jm), jd: Number(parts.jd) });
  const names: Array<[keyof Parts, string]> = [
    ['jd', t('jalali.day')],
    ['jm', t('jalali.month')],
    ['jy', t('jalali.year')],
  ];

  return (
    <div className="dayinput" data-testid={testId} data-value={day ?? ''} role="group" aria-label={label}>
      <div className="dayinput-selects">
        {names.map(([part, name]) => (
          <select
            key={part}
            className="input dayinput-select"
            data-part={part}
            aria-label={`${label} — ${name}`}
            disabled={disabled}
            required={required}
            value={parts[part]}
            onChange={(e) => change({ ...parts, [part]: e.target.value })}
          >
            <option value="">{name}</option>
            {part === 'jd' &&
              Array.from({ length: monthLength }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {digits.format(d)}
                </option>
              ))}
            {part === 'jm' &&
              Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>
                  {t(`jalali.months.${m}`)}
                </option>
              ))}
            {part === 'jy' &&
              years.map((y) => (
                <option key={y} value={y}>
                  {digits.format(y)}
                </option>
              ))}
          </select>
        ))}
        {value && !disabled ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => change(EMPTY)}>
            {t('jalali.clear')}
          </button>
        ) : null}
      </div>
      {day ? <span className="t-caption dayinput-readout">{calendarDate(`${day}T00:00:00.000Z`, locale)}</span> : null}
    </div>
  );
}
