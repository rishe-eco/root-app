import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { formatCount } from '@/lib/format';

/** How many numbers the track shows as chips before "More". */
const QUICK = 5;

/**
 * A small count, picked with one press (founder walk 2026-11-18, replacing DX1's − / + stepper for desk UX
 * review 25): a track of numbered chips from `min` to `min + 5`, the chosen one filled, and a "More" chip that
 * opens a − / + for the rare larger count. Revision rounds and iterations are almost always 0–5, so the common
 * answer is one press and every option is visible at once.
 *
 * It is controlled and speaks the same string the plain number field did (`value` is digits or `''`,
 * `onChange` gets digits or `''`), so a form that held `useState('')` needs no change. The numbers are drawn in
 * the panel's digits (README rule 14). Each chip is a toggle button (`aria-pressed`), so the chosen count is
 * announced and not only coloured.
 */
export default function CountStepper({
  value,
  onChange,
  label,
  min = 0,
  max = 99,
  disabled = false,
  testId,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  min?: number;
  max?: number;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const n = value === '' || Number.isNaN(Number(value)) ? null : Number(value);
  const top = Math.min(max, min + QUICK);
  const quick = Array.from({ length: top - min + 1 }, (_, i) => min + i);
  const beyond = n !== null && n > top;
  const [more, setMore] = useState(beyond);
  const showMore = more || beyond;
  const set = (next: number) => onChange(String(Math.min(max, Math.max(min, next))));

  return (
    <div className="counttrack" role="group" aria-label={label} data-testid={testId} data-value={value}>
      <div className="counttrack-chips">
        {quick.map((k) => {
          const chosen = n === k;
          return (
            <button
              key={k}
              type="button"
              className={`counttrack-chip${chosen ? ' counttrack-chosen' : ''}`}
              aria-pressed={chosen}
              data-value={k}
              disabled={disabled}
              onClick={() => {
                setMore(false);
                set(k);
              }}
            >
              {formatCount(k, locale)}
            </button>
          );
        })}
      </div>
        {max > top ? (
          <button
            type="button"
            className={`pillchoice-pill counttrack-more${showMore ? ' pillchoice-chosen' : ''}`}
            aria-pressed={showMore}
            aria-expanded={showMore}
            data-value="more"
            disabled={disabled}
            onClick={() => {
              setMore(true);
              if (!beyond) set(top + 1);
            }}
          >
            {t('countStepper.beyond')}
          </button>
        ) : null}
      {showMore ? (
        <div className="counttrack-beyond">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={t('countStepper.less', { label })}
            disabled={disabled || n === null || n <= top + 1}
            onClick={() => set((n ?? top) - 1)}
          >
            −
          </button>
          <output className="counttrack-value" aria-live="polite">
            {n === null ? '—' : formatCount(n, locale)}
          </output>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-label={t('countStepper.more', { label })}
            disabled={disabled || (n !== null && n >= max)}
            onClick={() => set(n === null ? top + 1 : n + 1)}
          >
            +
          </button>
        </div>
      ) : null}
    </div>
  );
}
