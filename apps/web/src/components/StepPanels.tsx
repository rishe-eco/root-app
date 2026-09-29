import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import type { Contract, StepKind, User, WizardStep } from '@/lib/queries';
import { relativeTime } from '@/lib/format';
import { stepLabel, type Audience } from '@/lib/wizard';
import Lock from '@/components/Lock';

/**
 * One panel per wizard step (journeys build plan J3) — the portal's wizard and
 * the desk's Steps tab both render a step through `StepPanel`, so a step has
 * one body, seen by the customer and authored by staff with the same component
 * (author controls decided by `audience` and `me.capabilities`, the way every
 * desk tab already is).
 *
 * Until a stage fills a step in, its panel says so honestly ("not available
 * yet") rather than showing nothing.
 *
 * ## How a later stage extends this file
 *
 * Register the stage's panel in `PANELS` below — one line each:
 *
 * - J4  `REQUIREMENTS` — the brief (staff author it; the customer reads and confirms it)
 * - J5  `SCOPE`        — pages, features and deliverables; the proposal decisions
 * - J6  `DRAFT`        — the contract draft with its anchored notes
 * - J7  `AGREEMENT`    — approve and sign; the agreement gate
 * - J8  `DESIGN`       — the theme catalogue, rounds, wireframes and palette
 * - J9  `MOCKUP`       — the mockup host, iterations
 * - J10 `DEMO`         — per phase: submission, readiness, approval
 * - J11 `SUMMARY`      — the summary, handover, closing
 *
 * A panel gets the contract (with `wizard`, `statusSummary`, `attention`
 * already loaded by `WizardFields`), its own `WizardStep`, who is reading, and
 * `me`. It must respect `step.locked` (the API refuses an edit to a locked
 * step with `STEP_LOCKED`, but a control that can only fail is worse than one
 * that is not there) and must not read `Contract.status`.
 */

export type StepPanelProps = {
  contract: Contract;
  step: WizardStep;
  audience: Audience;
  me: User;
};

const PANELS: Partial<Record<StepKind, ComponentType<StepPanelProps>>> = {};

function NotYet({ step, audience }: Pick<StepPanelProps, 'step' | 'audience'>) {
  const { t } = useTranslation();
  if (step.status === 'DONE') {
    return <p className="t-small desk-muted">{t('wizard.panel.doneNote')}</p>;
  }
  if (step.step === 'SUMMARY') {
    return <p className="t-small desk-muted">{t('wizard.panel.summaryNote')}</p>;
  }
  return (
    <div className="step-notyet" data-testid="step-not-yet">
      <Lock />
      <div>
        <p className="step-notyet-title">{t('wizard.panel.notYetTitle')}</p>
        <p className="t-small desk-muted">
          {audience === 'customer' ? t('wizard.panel.notYetCustomer') : t('wizard.panel.notYetStaff')}
        </p>
      </div>
    </div>
  );
}

export default function StepPanel(props: StepPanelProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const { step } = props;
  const Panel = PANELS[step.step];

  return (
    <section className="step-panel" data-testid="step-panel" data-step={step.step} data-status={step.status}>
      <header className="step-panel-head">
        <h2 className="t-h3">{stepLabel(t, locale, step)}</h2>
        <span className={`step-chip step-chip-${step.status.toLowerCase()}`}>{t(`wizard.state.${step.status}`)}</span>
      </header>
      {step.locked && step.lockedAt ? (
        <p className="locknote">
          <Lock />
          <span>{t('wizard.lockedSince', { when: relativeTime(step.lockedAt, locale) })}</span>
        </p>
      ) : null}
      {Panel ? <Panel {...props} /> : <NotYet step={step} audience={props.audience} />}
    </section>
  );
}
