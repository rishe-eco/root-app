import { useTranslation } from 'react-i18next';

/**
 * A row of pills that picks one thing (DX1, desk UX review 5 and 6): a few
 * visible choices instead of a select or a free number. Each pill is a toggle
 * button (`aria-pressed`), so the chosen one is announced and not only coloured.
 *
 * `clearable` makes a press on the chosen pill clear it (`onChange(null)`) —
 * "who provides this" is optional, and a choice must be undoable without a
 * separate "none" pill. Plain values only; the caller maps them to what it
 * stores.
 */
export default function PillChoice<V extends string>({
  options,
  value,
  onChange,
  label,
  clearable = false,
  disabled = false,
  testId,
}: {
  options: ReadonlyArray<{ value: V; label: string }>;
  value: V | null;
  onChange: (next: V | null) => void;
  label: string;
  clearable?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="pillchoice" role="group" aria-label={label} data-testid={testId} data-value={value ?? ''}>
      {options.map((o) => {
        const chosen = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            className={`pillchoice-pill${chosen ? ' pillchoice-chosen' : ''}`}
            aria-pressed={chosen}
            data-value={o.value}
            disabled={disabled}
            title={chosen && clearable ? t('pillChoice.clear') : undefined}
            onClick={() => onChange(chosen && clearable ? null : o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
