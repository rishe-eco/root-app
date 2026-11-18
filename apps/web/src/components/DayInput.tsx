import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { calendarDate } from '@/lib/format';
import { addDays, calendarOf, formatDayText, monthGrid, parseDayText, partsIn, shiftMonth } from '@/lib/day';

/**
 * A calendar day, in one field (journeys build plan J4, PD-16, PD-19; one field
 * since DX1, desk UX review 24). It used to be three selects; it is now **one
 * text box and a calendar popover**: Jalali in the Persian panel, Gregorian in
 * the English one. Typing works in both calendars in either panel — the year
 * tells them apart (`lib/day.ts`) — and the popover is a month grid you can
 * reach, walk and choose from with the keyboard alone.
 *
 * **The contract is unchanged, so no caller moves.** `value` is a `YYYY-MM-DD`
 * string or `''`, and `onChange` gets a `YYYY-MM-DD` string or `''` — **never a
 * `Date`** (PD-19): a `Date` built from a Jalali day in local time is the day
 * before west of Greenwich, which is how 1 Aban becomes 30 Mehr at 20:30.
 * `lib/day.ts` and `lib/jalali.ts` work in integers and strings and consult no
 * zone.
 *
 * Text that is not a real day (a half-typed date, 30 Esfand of a common year)
 * reports `''` rather than a stale day, and marks the field invalid
 * (`aria-invalid`, and a custom validity so a surrounding form will not submit
 * it). The text is kept as typed until the field is left, when a real day is
 * rewritten in the panel's own form.
 *
 * Under the field, `calendarDate` — the one formatter for a stored day — says
 * the day in words, the reader's check that the text means what they meant.
 */

type Props = {
  value: string;
  onChange: (day: string) => void;
  label: string;
  required?: boolean;
  disabled?: boolean;
  testId?: string;
};

export default function DayInput({ value, onChange, label, required = false, disabled = false, testId }: Props) {
  const { t } = useTranslation();
  const locale = useLocale();
  const cal = calendarOf(locale);
  const rtl = locale === 'fa';
  const id = useId();
  const [text, setText] = useState(() => (value ? formatDayText(value, locale) : ''));
  const [open, setOpen] = useState(false);
  // Whether the grid holds focus: only when the keyboard went into it (ArrowDown from the field). A click on the
  // field opens the calendar and leaves the caret where it is, so typing still works (founder walk 2026-11-18).
  const [inGrid, setInGrid] = useState(false);
  const [cursor, setCursor] = useState<string>(() => value || todayUtc());
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  const typed = parseDayText(text);
  const invalid = text.trim() !== '' && typed === null;

  // A value that changed from outside (the form reset, a save came back) wins
  // over what is in the box — but only when it is a different day from the one
  // the text already names, so typing is never overwritten by its echo.
  useEffect(() => {
    if ((typed ?? '') !== (value || '')) setText(value ? formatDayText(value, locale) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    input.current?.setCustomValidity(invalid ? t('dayInput.invalid') : '');
  }, [invalid, t]);

  // Closing: a press outside, or Escape (below).
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  // The roving focus: the day under the cursor is the one that holds it.
  useEffect(() => {
    if (open && inGrid) grid.current?.querySelector<HTMLButtonElement>(`button[data-day="${cursor}"]`)?.focus();
  }, [open, inGrid, cursor]);

  function onType(next: string) {
    setText(next);
    const day = parseDayText(next);
    onChange(day ?? '');
    if (day) setCursor(day);
  }

  function choose(day: string) {
    setText(formatDayText(day, locale));
    onChange(day);
    setOpen(false);
    setInGrid(false);
    input.current?.focus();
  }

  function openCalendar(focusGrid: boolean) {
    if (disabled) return;
    if (!open) setCursor(typed ?? (value || todayUtc()));
    setOpen(true);
    setInGrid(focusGrid);
  }

  function onFieldKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      openCalendar(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
    }
  }

  function onGridKey(e: KeyboardEvent) {
    // In a right-to-left grid the first column is on the right, so the arrow
    // that points "forward" in reading order is the left one.
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const move: Record<string, () => string> = {
      [forward]: () => addDays(cursor, 1),
      [back]: () => addDays(cursor, -1),
      ArrowDown: () => addDays(cursor, 7),
      ArrowUp: () => addDays(cursor, -7),
      PageDown: () => shiftMonth(cursor, 1, cal),
      PageUp: () => shiftMonth(cursor, -1, cal),
    };
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setInGrid(false);
      input.current?.focus();
    } else if (move[e.key]) {
      e.preventDefault();
      setCursor(move[e.key]());
    }
  }

  const tag = rtl ? 'fa-IR' : 'en-US';
  const digits = new Intl.NumberFormat(tag, { useGrouping: false });
  const view = partsIn(cursor, cal);
  const monthTitle =
    cal === 'jalali'
      ? `${t(`jalali.months.${view.month}`)} ${digits.format(view.year)}`
      : new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${cursor}T00:00:00Z`));
  const weekStart = rtl ? 6 : 0;
  const weekdays = Array.from({ length: 7 }, (_, i) => {
    const sample = addDays('2023-01-01', (weekStart + i) % 7); // 2023-01-01 is a Sunday
    return {
      narrow: new Intl.DateTimeFormat(tag, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${sample}T00:00:00Z`)),
      long: new Intl.DateTimeFormat(tag, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${sample}T00:00:00Z`)),
    };
  });
  const today = todayUtc();

  return (
    <div
      className="dayinput"
      ref={root}
      data-testid={testId}
      data-value={typed ?? ''}
      role="group"
      aria-label={label}
      onBlur={(e) => {
        // Tabbing out of the field and its calendar closes the calendar.
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setInGrid(false);
        }
      }}
    >
      <div className="dayinput-field">
        <input
          ref={input}
          id={id}
          className="input dayinput-text num-latin"
          data-part="text"
          type="text"
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          aria-label={label}
          aria-invalid={invalid || undefined}
          placeholder={t('dayInput.placeholder')}
          disabled={disabled}
          required={required}
          aria-haspopup="dialog"
          aria-expanded={open}
          value={text}
          onClick={() => openCalendar(false)}
          onKeyDown={onFieldKey}
          onChange={(e) => onType(e.target.value)}
          onBlur={() => {
            if (typed) setText(formatDayText(typed, locale));
          }}
        />
        {value && !disabled ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setText('');
              onChange('');
            }}
          >
            {t('jalali.clear')}
          </button>
        ) : null}
      </div>
      {invalid ? (
        <span className="t-caption dayinput-error" role="alert" data-testid="dayinput-invalid">
          {t('dayInput.invalid')}
        </span>
      ) : typed ? (
        <span className="t-caption dayinput-readout">{calendarDate(`${typed}T00:00:00.000Z`, locale)}</span>
      ) : null}

      {open ? (
        <div className="dayinput-pop" role="dialog" aria-label={`${label} — ${t('dayInput.calendar')}`} data-part="calendar">
          <div className="dayinput-nav">
            <button type="button" className="btn btn-ghost btn-sm" aria-label={t('dayInput.prevMonth')} onClick={() => setCursor(shiftMonth(cursor, -1, cal))}>
              {rtl ? '›' : '‹'}
            </button>
            <span className="dayinput-month" aria-live="polite">{monthTitle}</span>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={t('dayInput.nextMonth')} onClick={() => setCursor(shiftMonth(cursor, 1, cal))}>
              {rtl ? '‹' : '›'}
            </button>
          </div>
          <div className="dayinput-grid" ref={grid} role="grid" aria-label={monthTitle} onKeyDown={onGridKey}>
            <div className="dayinput-week dayinput-weekdays" role="row">
              {weekdays.map((w, i) => (
                <span key={i} className="dayinput-wd" role="columnheader" aria-label={w.long}>
                  {w.narrow}
                </span>
              ))}
            </div>
            {monthGrid(cursor, cal, locale).map((week, wi) => (
              <div key={wi} className="dayinput-week" role="row">
                {week.map((d, di) =>
                  d ? (
                    <button
                      key={d}
                      type="button"
                      role="gridcell"
                      className={`dayinput-day${d === typed ? ' dayinput-day-chosen' : ''}${d === today ? ' dayinput-day-today' : ''}`}
                      data-day={d}
                      tabIndex={d === cursor ? 0 : -1}
                      aria-pressed={d === typed}
                      aria-current={d === today ? 'date' : undefined}
                      onClick={() => choose(d)}
                    >
                      {digits.format(partsIn(d, cal).day)}
                    </button>
                  ) : (
                    <span key={`b${di}`} className="dayinput-blank" role="gridcell" aria-hidden="true" />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Today's `YYYY-MM-DD` on the machine's clock in UTC — only where the popover opens when nothing is chosen. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}
