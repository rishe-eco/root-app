import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { WaitingOn, WizardStep } from '@/lib/queries';
import { formatCount } from '@/lib/format';
import { pillMissing, pillState, sameStep, stepLabel } from '@/lib/wizard';

/**
 * The wizard's step list (journeys build plan J3) — **the one module the
 * portal's wizard and the desk's workspace both import**, so the road reads the
 * same on both sides of the product. It renders what the API derived
 * (`Contract.wizard`, lib/steps.ts); it never decides which step is current.
 *
 * Display-only unless `onSelect` is given: the desk's header strip and the
 * legacy (`DESIGN_FIRST`) portal page show the road without making it
 * navigable, while the new-road wizard passes `onSelect` and gets a button per
 * step.
 *
 * **On the desk** (DX1, desk UX review 21, 22, 31) the pills say more. The one
 * you are on is unmistakable — a heavy outline, a bold label and
 * `aria-current="step"`, not a colour alone — and each pill says where its step
 * stands: done, waiting on the customer, your turn, upcoming, and a lock where
 * the signature froze it. Pass `nextMoveOn` (the API's `statusSummary`) to get
 * those words, and `briefMissing` for the Requirements pill's "· 2 missing";
 * without them the list reads exactly as before, which is how the customer's
 * wizard still draws it.
 *
 * How a later stage extends it: it does not — a new step is a new value of
 * `StepKind` and a label under `wizard.step.*`; the panel that fills it is
 * registered in `StepPanels.tsx`.
 */
export default function StepList({
  steps,
  selected,
  onSelect,
  nextMoveOn,
  briefMissing,
}: {
  steps: WizardStep[];
  selected?: WizardStep | null;
  onSelect?: (step: WizardStep) => void;
  /** Whose move the current step is (staff reading). Turns on the pills' state words. */
  nextMoveOn?: WaitingOn | null;
  /** `briefCompleteness.length`, for the Requirements pill. */
  briefMissing?: number;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <ol className="stepper" aria-label={t('wizard.title')}>
      {steps.map((s, i) => {
        const chosen = sameStep(s, selected);
        const rich = nextMoveOn !== undefined;
        const missing = rich ? pillMissing(s, briefMissing) : null;
        const state = rich ? t(`wizard.pill.${pillState(s, nextMoveOn)}`) : t(`wizard.state.${s.status}`);
        const inner = (
          <>
            <span className="stepper-dot num-latin" aria-hidden="true">
              {s.status === 'DONE' ? '✓' : i + 1}
            </span>
            <span className="stepper-text">
              <span className="stepper-label">
                {stepLabel(t, locale, s)}
                {missing !== null ? (
                  <span className="stepper-missing" data-testid="pill-missing">
                    {' · '}
                    {t('wizard.pill.missing', { count: missing, n: formatCount(missing, locale) })}
                  </span>
                ) : null}
              </span>
              <span className="stepper-state" data-testid="pill-state">
                {state}
                {s.locked ? ` · ${t('wizard.locked')}` : ''}
              </span>
            </span>
          </>
        );
        return (
          <li
            key={`${s.step}:${s.phaseId ?? ''}`}
            className={`stepper-item stepper-${s.status.toLowerCase()}${chosen ? ' stepper-selected' : ''}`}
            data-step={s.step}
            data-status={s.status}
            data-pill={rich ? pillState(s, nextMoveOn) : undefined}
            data-selected={chosen ? 'true' : undefined}
          >
            {onSelect ? (
              <button
                type="button"
                className="stepper-hit"
                aria-current={chosen ? 'step' : undefined}
                onClick={() => onSelect(s)}
              >
                {inner}
              </button>
            ) : (
              <span className="stepper-hit">{inner}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
