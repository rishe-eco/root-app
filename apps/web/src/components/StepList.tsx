import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { WizardStep } from '@/lib/queries';
import { sameStep, stepLabel } from '@/lib/wizard';

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
 * How a later stage extends it: it does not — a new step is a new value of
 * `StepKind` and a label under `wizard.step.*`; the panel that fills it is
 * registered in `StepPanels.tsx`.
 */
export default function StepList({
  steps,
  selected,
  onSelect,
}: {
  steps: WizardStep[];
  selected?: WizardStep | null;
  onSelect?: (step: WizardStep) => void;
}) {
  const { t } = useTranslation();
  const locale = useLocale();

  return (
    <ol className="stepper" aria-label={t('wizard.title')}>
      {steps.map((s, i) => {
        const chosen = sameStep(s, selected);
        const inner = (
          <>
            <span className="stepper-dot num-latin" aria-hidden="true">
              {s.status === 'DONE' ? '✓' : i + 1}
            </span>
            <span className="stepper-text">
              <span className="stepper-label">{stepLabel(t, locale, s)}</span>
              <span className="stepper-state">
                {t(`wizard.state.${s.status}`)}
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
