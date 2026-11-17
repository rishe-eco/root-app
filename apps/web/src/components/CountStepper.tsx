import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { formatCount } from '@/lib/format';

/**
 * A small count with − and + around a large number (DX1, desk UX review 25):
 * revision rounds, iterations. It is controlled and speaks the same string the
 * plain number field did (`value` is digits or `''`, `onChange` gets digits or
 * `''`), so a form that held `useState('')` for the field needs no change. An
 * empty value shows a dash and the first press of + makes it 1 (or `min`, if higher); − at `min`
 * does nothing (the count never goes below it). The number is drawn in the
 * panel's digits (README rule 14).
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
  const set = (next: number) => onChange(String(Math.min(max, Math.max(min, next))));

  return (
    <div className="stepper-count" role="group" aria-label={label} data-testid={testId} data-value={value}>
      <button
        type="button"
        className="btn btn-secondary btn-sm stepper-count-btn"
        aria-label={t('countStepper.less', { label })}
        disabled={disabled || n === null || n <= min}
        onClick={() => set((n ?? min) - 1)}
      >
        −
      </button>
      <output className="stepper-count-value" aria-live="polite">
        {n === null ? '—' : formatCount(n, locale)}
      </output>
      <button
        type="button"
        className="btn btn-secondary btn-sm stepper-count-btn"
        aria-label={t('countStepper.more', { label })}
        disabled={disabled || (n !== null && n >= max)}
        onClick={() => set(n === null ? Math.max(min, 1) : n + 1)}
      >
        +
      </button>
    </div>
  );
}
